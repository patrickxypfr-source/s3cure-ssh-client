// S3cure SSH Client – automatisches Update ohne Code-Signierung
//
// Ablauf (Knopf „Update“ unten links):
//   1. passende Datei aus dem neuesten GitHub-Release wählen
//        macOS:   S3cure-SSH-Client-Mac-AppleSilicon.zip / -Mac-Intel.zip
//        Windows: S3cure-SSH-Client-Setup.exe (installiert) oder -Windows-Portable.exe (portable)
//   2. mit Fortschritt herunterladen (Update-Fenster, src/update.html)
//   3. prüfen (Größe, macOS: Signatur und Versionsnummer im Paket)
//   4. App beenden, kleines Hilfsskript tauscht die Dateien aus und startet die neue Version
//
// Fertige Bausteine (electron-updater/Squirrel) brauchen auf dem Mac eine Apple-Signatur –
// deshalb hier selbst gebaut.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { net, BrowserWindow } = require('electron');

const NAME = 'S3cure SSH Client';
const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim()))));

// Nur für Tests: S3CURE_*-Variablen an die neu gestartete App weitergeben (open startet ohne Umgebung)
const testEnv = () => Object.entries(process.env)
  .filter(([k, v]) => /^S3CURE_(CONFIG_DIR|UPDATE_URL)$/.test(k) && /^[\w./:-]+$/.test(v))
  .map(([k, v]) => `--env ${k}=${v} `).join('');

function setupUpdater({ ipcMain, app, getMainWin, latestRelease, preload, platform = process.platform }) {
  let job = null;    // laufendes Update
  let upWin = null;  // Update-Fenster
  let lastState = null; // letzter Zustand – auch nach Fehlern, falls das Fenster erst danach fertig lädt

  // ---------- Wie ist diese App installiert? ----------

  function installKind() {
    if (!app.isPackaged) return { kind: 'dev' };
    const exe = app.getPath('exe');
    if (platform === 'darwin') {
      const bundle = path.resolve(exe, '..', '..', '..');
      if (!bundle.endsWith('.app')) return { kind: 'unknown' };
      return { kind: 'mac', bundle, asset: process.arch === 'arm64' ? 'S3cure-SSH-Client-Mac-AppleSilicon.zip' : 'S3cure-SSH-Client-Mac-Intel.zip' };
    }
    if (platform === 'win32') {
      if (process.env.PORTABLE_EXECUTABLE_FILE) return { kind: 'win-portable', target: process.env.PORTABLE_EXECUTABLE_FILE, asset: 'S3cure-SSH-Client-Windows-Portable.exe' };
      if (fs.existsSync(path.join(path.dirname(exe), `Uninstall ${NAME}.exe`))) return { kind: 'win-setup', asset: 'S3cure-SSH-Client-Setup.exe' };
      return { kind: 'win-folder' }; // aus der ZIP entpackt – kann sich nicht selbst ersetzen
    }
    return { kind: 'unknown' };
  }

  // ---------- Update-Fenster ----------

  function send(state) {
    // Versionen in jeder Meldung mitschicken – das Fenster kann jederzeit dazukommen
    if (job) { state = { current: app.getVersion(), ...(job.version ? { version: job.version } : {}), ...state }; job.state = state; }
    lastState = state;
    if (upWin && !upWin.isDestroyed()) upWin.webContents.send('updater:state', state);
  }

  function openWindow() {
    if (upWin && !upWin.isDestroyed()) { upWin.focus(); return; }
    const parent = getMainWin();
    upWin = new BrowserWindow({
      width: 460, height: 268, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      parent: parent || undefined, modal: !!parent, show: false,
      title: `${NAME} – Update`,
      backgroundColor: parent ? parent.getBackgroundColor() : '#0f0f11',
      ...(platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: true }),
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    upWin.setMenu?.(null);
    upWin.loadFile(path.join(__dirname, '..', 'src', 'update.html'));
    upWin.once('ready-to-show', () => upWin.show());
    upWin.on('closed', () => { upWin = null; if (job && !job.installing) cancel(); });
  }

  // ---------- Herunterladen ----------

  async function download(url, file, total, signal) {
    const res = await net.fetch(url, { signal, headers: { 'User-Agent': 'S3cure-SSH-Client' } });
    if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (HTTP ${res.status}).`);
    const size = Number(res.headers.get('content-length')) || total || 0;
    const out = fs.createWriteStream(file);
    const reader = res.body.getReader();
    let received = 0, lastSend = 0, lastBytes = 0, lastTime = Date.now(), speed = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r));
        received += value.length;
        const now = Date.now();
        if (now - lastSend > 150) {
          const dt = (now - lastTime) / 1000;
          if (dt >= 0.5) { speed = (received - lastBytes) / dt; lastBytes = received; lastTime = now; }
          send({ phase: 'download', received, total: size, speed });
          lastSend = now;
        }
      }
    } finally {
      await new Promise(r => out.end(r));
    }
    if (size && received !== size) throw new Error('Download unvollständig – bitte nochmal versuchen.');
    send({ phase: 'download', received, total: size || received, speed });
  }

  // ---------- Installieren ----------

  // macOS: neues .app-Paket prüfen, nach dem Beenden austauschen und neu starten
  async function installMac(kind, zip, dir, version) {
    send({ phase: 'verify' });
    const x = path.join(dir, 'x');
    fs.mkdirSync(x);
    await run('ditto', ['-x', '-k', zip, x]);
    const app2 = path.join(x, `${NAME}.app`);
    if (!fs.existsSync(app2)) throw new Error('Das Update-Paket ist unvollständig.');
    await run('codesign', ['--verify', '--deep', '--strict', app2]).catch(() => { throw new Error('Das Update-Paket ist beschädigt (Signatur ungültig).'); });
    const v = await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', path.join(app2, 'Contents', 'Info.plist')]);
    if (v !== version) throw new Error(`Das Update-Paket hat die falsche Version (${v} statt ${version}).`);
    try { fs.accessSync(path.dirname(kind.bundle), fs.constants.W_OK); } catch {
      throw new Error(`Keine Schreibrechte für „${path.dirname(kind.bundle)}“. Bitte die App in den Programme-Ordner legen.`);
    }
    const script = path.join(dir, 'install.sh');
    fs.writeFileSync(script, `#!/bin/sh
# Wartet, bis die alte App beendet ist, tauscht sie aus und startet die neue
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
OLD="$1"; NEW="$2"; TMP="$3"
rm -rf "$OLD.update-old"
if mv "$OLD" "$OLD.update-old" && ditto "$NEW" "$OLD"; then
  rm -rf "$OLD.update-old"
else
  rm -rf "$OLD"; mv "$OLD.update-old" "$OLD"
fi
xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
open ${testEnv()}"$OLD"
rm -rf "$TMP"
`, { mode: 0o755 });
    return () => spawn('/bin/sh', [script, kind.bundle, app2, dir], { detached: true, stdio: 'ignore' }).unref();
  }

  // Windows mit Installer: neuen Installer still laufen lassen, er startet die App danach selbst
  function installWinSetup(file) {
    return () => spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  }

  // Windows portable: nach dem Beenden die .exe ersetzen (wenn sie wieder frei ist) und neu starten
  function installWinPortable(kind, file, dir) {
    const script = path.join(dir, 'install.cmd');
    fs.writeFileSync(script, [
      '@echo off',
      'set /a n=0',
      ':retry',
      `move /Y "${file}" "${kind.target}" >nul 2>&1 && goto start`,
      'set /a n+=1',
      'if %n% GEQ 60 goto end',
      'timeout /t 1 /nobreak >nul',
      'goto retry',
      ':start',
      `start "" "${kind.target}"`,
      ':end',
      `rmdir /S /Q "${dir}" >nul 2>&1`,
    ].join('\r\n'));
    return () => spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }

  // ---------- Ablauf ----------

  async function start() {
    if (job) { openWindow(); return; }
    const kind = installKind();
    const ctrl = new AbortController();
    job = { ctrl, installing: false, state: { phase: 'check' } };
    lastState = null;
    openWindow();
    let dir = null;
    try {
      send({ phase: 'check' });
      if (kind.kind === 'dev') throw new Error('Im Entwicklungsmodus (npm start) gibt es keine automatischen Updates.');
      if (!kind.asset) throw new Error('Diese Installation kann sich nicht selbst aktualisieren. Bitte die neue Version von GitHub laden (Knopf unten).');
      const rel = await latestRelease();
      if (!rel) throw new Error('GitHub ist gerade nicht erreichbar. Bitte später nochmal versuchen.');
      const asset = (rel.assets || []).find(a => a.name === kind.asset);
      if (!asset) throw new Error(`Im neuesten Release fehlt die Datei „${kind.asset}“.`);
      job.version = rel.version;
      send({ phase: 'download', received: 0, total: asset.size, speed: 0 });
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3cure-update-'));
      const file = path.join(dir, asset.name);
      await download(asset.url, file, asset.size, ctrl.signal);
      if (ctrl.signal.aborted) throw new Error('abgebrochen');

      let launch;
      if (kind.kind === 'mac') launch = await installMac(kind, file, dir, rel.version);
      else if (kind.kind === 'win-setup') launch = installWinSetup(file);
      else launch = installWinPortable(kind, file, dir);

      job.installing = true;
      send({ phase: 'install', version: rel.version });
      await new Promise(r => setTimeout(r, 900)); // „Wird installiert …“ kurz zeigen
      launch();
      // App beenden; falls etwas hängt, hart beenden, damit der Austausch starten kann
      setTimeout(() => app.exit(0), 4000);
      app.quit();
    } catch (err) {
      const aborted = ctrl.signal.aborted || /abort/i.test(String(err && err.name));
      if (dir && !job?.installing) fs.rm(dir, { recursive: true, force: true }, () => {});
      if (!aborted) send({ phase: 'error', message: String(err.message || err) });
      job = null;
    }
  }

  function cancel() {
    if (!job || job.installing) return;
    job.ctrl.abort();
    job = null;
    if (upWin && !upWin.isDestroyed()) upWin.close();
  }

  ipcMain.handle('updater:start', () => { start(); });
  ipcMain.handle('updater:cancel', () => cancel());
  ipcMain.handle('updater:state', () => (job ? job.state : lastState));
  ipcMain.handle('updater:kind', () => installKind().kind);
  ipcMain.handle('updater:close', () => { if (upWin && !upWin.isDestroyed()) upWin.close(); });

  return { installKind, start };
}

module.exports = { setupUpdater };
