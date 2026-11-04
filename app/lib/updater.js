// S3cure SSH Client – automatisches Update ohne Code-Signierung
//
// Ablauf (Knopf „Update“ unten links):
//   1. passende Datei aus dem neuesten GitHub-Release wählen
//        macOS:   S3cure-SSH-Client-Mac-AppleSilicon.dmg / -Mac-Intel.dmg (ersatzweise .zip)
//        Windows: S3cure-SSH-Client-Setup.exe (installiert) oder -Windows-Portable.exe (portable)
//        Linux:   S3cure-SSH-Client-Linux-x64.AppImage (ersetzt die laufende AppImage-Datei)
//   2. mit Fortschritt herunterladen (Update-Fenster, src/update.html)
//   3. prüfen (Größe, macOS: Signatur und Versionsnummer im Paket, Linux: AppImage-Kennung)
//   4. App beenden, kleines Hilfsskript tauscht die Dateien aus und startet die neue Version
//   Fehlt eine Datei oder geht der Austausch nicht (z. B. keine Schreibrechte), wird stattdessen
//   der Installer heruntergeladen und geöffnet – der Nutzer bekommt nie nur eine Fehlermeldung.
//
// Fertige Bausteine (electron-updater/Squirrel) brauchen auf dem Mac eine Apple-Signatur –
// deshalb hier selbst gebaut.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { net, BrowserWindow } = require('electron');
const { parseNotes } = require('./release-notes');

const NAME = 'S3cure SSH Client';
const APPIMAGE = 'S3cure-SSH-Client-Linux-x64.AppImage';

// Ist die Datei ein AppImage (Typ 2)? ELF-Kopf und „AI\x02“ an Stelle 8
function isAppImage(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(11);
    fs.readSync(fd, head, 0, 11, 0);
    return head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && head.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]));
  } catch { return false; } finally { if (fd != null) fs.closeSync(fd); }
}

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

  // Mögliche Dateien im Release, in dieser Reihenfolge (fehlt eine, wird die nächste genommen).
  // fallback = Installer, den man herunterladen und öffnen kann, wenn der Austausch selbst nicht geht.
  function installKind() {
    if (!app.isPackaged) return { kind: 'dev' };
    const exe = app.getPath('exe');
    if (platform === 'darwin') {
      const bundle = path.resolve(exe, '..', '..', '..');
      const label = process.arch === 'arm64' ? 'AppleSilicon' : 'Intel';
      const files = [`S3cure-SSH-Client-Mac-${label}.dmg`, `S3cure-SSH-Client-Mac-${label}.zip`];
      if (!bundle.endsWith('.app')) return { kind: 'handoff', files: [files[0]] };
      return { kind: 'mac', bundle, files, fallback: files[0] };
    }
    if (platform === 'win32') {
      const setup = 'S3cure-SSH-Client-Setup.exe';
      if (process.env.PORTABLE_EXECUTABLE_FILE) {
        return { kind: 'win-portable', target: process.env.PORTABLE_EXECUTABLE_FILE, files: ['S3cure-SSH-Client-Windows-Portable.exe'], fallback: setup };
      }
      if (fs.existsSync(path.join(path.dirname(exe), `Uninstall ${NAME}.exe`))) return { kind: 'win-setup', files: [setup], fallback: setup };
      return { kind: 'handoff', files: [setup] }; // aus einer ZIP entpackt: Installer öffnen
    }
    if (platform === 'linux') {
      // Das AppImage setzt APPIMAGE auf den Pfad der laufenden Datei
      const target = process.env.APPIMAGE;
      if (target && path.isAbsolute(target)) return { kind: 'linux-appimage', target, files: [APPIMAGE], fallback: APPIMAGE };
      return { kind: 'handoff', files: [APPIMAGE] }; // anders gestartet: neue Datei in Downloads legen
    }
    return { kind: 'unknown' };
  }

  // Erste Datei aus der Liste, die es im Release gibt
  const pickAsset = (rel, names) => {
    for (const n of names || []) { const a = (rel.assets || []).find(x => x.name === n); if (a) return a; }
    return null;
  };

  // ---------- Update-Fenster ----------

  function send(state) {
    // Versionen in jeder Meldung mitschicken – das Fenster kann jederzeit dazukommen
    if (job) {
      state = { current: app.getVersion(), ...(job.version ? { version: job.version } : {}), ...(job.notes ? { notes: job.notes } : {}), ...state };
      job.state = state;
    }
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
  async function installMac(kind, file, dir, version) {
    send({ phase: 'verify' });
    const x = path.join(dir, 'x');
    fs.mkdirSync(x);
    if (file.endsWith('.zip')) {
      await run('ditto', ['-x', '-k', file, x]);
    } else {
      // DMG unsichtbar einhängen, App herauskopieren, wieder aushängen
      const mnt = path.join(dir, 'mnt');
      fs.mkdirSync(mnt);
      await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, file]);
      try {
        if (!fs.existsSync(path.join(mnt, `${NAME}.app`))) throw new Error('Das Update-Paket ist unvollständig.');
        await run('ditto', [path.join(mnt, `${NAME}.app`), path.join(x, `${NAME}.app`)]);
      } finally {
        await run('hdiutil', ['detach', mnt, '-force']).catch(() => {});
      }
    }
    const app2 = path.join(x, `${NAME}.app`);
    if (!fs.existsSync(app2)) throw new Error('Das Update-Paket ist unvollständig.');
    await run('codesign', ['--verify', '--deep', '--strict', app2]).catch(() => { throw new Error('Das Update-Paket ist beschädigt (Signatur ungültig).'); });
    const v = await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', path.join(app2, 'Contents', 'Info.plist')]);
    if (v !== version) throw new Error(`Das Update-Paket hat die falsche Version (${v} statt ${version}).`);
    try { fs.accessSync(path.dirname(kind.bundle), fs.constants.W_OK); } catch {
      const e = new Error('Keine Schreibrechte im Programme-Ordner'); e.handoff = true; throw e;
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

  // Linux: neue AppImage-Datei liegt schon neben der alten (gleicher Ordner, gleiche Platte).
  // Nach dem Beenden wird sie an die Stelle der alten geschoben und gestartet.
  function installAppImage(kind, file, dir) {
    send({ phase: 'verify' });
    if (!isAppImage(file)) throw new Error('Das Update-Paket ist beschädigt (kein AppImage).');
    fs.chmodSync(file, 0o755);
    const script = path.join(dir, 'install.sh');
    fs.writeFileSync(script, `#!/bin/sh
# Wartet, bis die alte App beendet ist, ersetzt das AppImage und startet die neue Version
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
NEW="$1"; OLD="$2"; TMP="$3"
if mv -f "$NEW" "$OLD"; then :; else rm -f "$NEW"; fi
unset APPDIR APPIMAGE ARGV0 OWD
nohup "$OLD" >/dev/null 2>&1 &
rm -rf "$TMP"
`, { mode: 0o755 });
    return () => spawn('/bin/sh', [script, file, kind.target, dir], { detached: true, stdio: 'ignore' }).unref();
  }

  // ---------- Ablauf ----------

  // Download mit bis zu 3 Versuchen (z. B. kurz kein Netz)
  async function downloadRetry(asset, file, signal) {
    for (let attempt = 1; ; attempt++) {
      try { return await download(asset.url, file, asset.size, signal); } catch (err) {
        if (signal.aborted || attempt >= 3) throw err;
        send({ phase: 'retry', attempt: attempt + 1 });
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  // Notlösung: Installer herunterladen und öffnen (Mac: Installationsfenster der DMG, Windows: Setup)
  async function handoff(rel, names, dir, signal) {
    const asset = pickAsset(rel, names);
    if (!asset) throw new Error('Im neuesten Release wurde kein passender Installer gefunden.');
    const target = path.join(platform === 'win32' ? dir : app.getPath('downloads'), asset.name);
    const already = path.join(dir, asset.name); // schon für das Update geladen? Dann nicht nochmal
    if (fs.existsSync(already) && fs.statSync(already).size === asset.size) {
      if (already !== target) fs.copyFileSync(already, target);
    } else {
      send({ phase: 'download', received: 0, total: asset.size, speed: 0 });
      await downloadRetry(asset, target, signal);
    }
    if (platform === 'linux') {
      // Kein Installer: neue Datei ausführbar in „Downloads“ legen und den Ordner zeigen; die App läuft weiter
      fs.chmodSync(target, 0o755);
      send({ phase: 'handoff', platform, file: target });
      spawn('xdg-open', [path.dirname(target)], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      job = null;
      return;
    }
    job.installing = true;
    send({ phase: 'handoff', platform });
    await new Promise(r => setTimeout(r, 1500));
    if (platform === 'darwin') {
      spawn('/usr/bin/open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
    }
    // App beenden, damit der Installer sie ersetzen kann
    setTimeout(() => { app.quit(); setTimeout(() => app.exit(0), 4000); }, 2500);
  }

  async function start() {
    if (job) { openWindow(); return; }
    const kind = installKind();
    const ctrl = new AbortController();
    job = { ctrl, installing: false, state: { phase: 'check' } };
    lastState = null;
    openWindow();
    let dir = null, rel = null, staged = null;
    try {
      send({ phase: 'check' });
      if (kind.kind === 'dev') throw new Error('Im Entwicklungsmodus (npm start) gibt es keine automatischen Updates.');
      if (kind.kind === 'unknown') throw new Error('Dieses System wird für automatische Updates nicht unterstützt.');
      // Release-Infos holen (bei Netzproblemen kurz nochmal versuchen)
      for (let i = 0; i < 3 && !rel; i++) { rel = await latestRelease(); if (!rel) await new Promise(r => setTimeout(r, 1500)); }
      if (!rel) throw new Error('GitHub ist gerade nicht erreichbar. Bitte später nochmal versuchen.');
      job.version = rel.version;
      const notes = parseNotes(rel.notes);
      if (notes.length) job.notes = notes;
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3cure-update-'));

      if (kind.kind === 'handoff') { await handoff(rel, kind.files, dir, ctrl.signal); return; }

      const asset = pickAsset(rel, kind.files);
      if (!asset) { await handoff(rel, [kind.fallback], dir, ctrl.signal); return; }
      let file = path.join(dir, asset.name);
      if (kind.kind === 'linux-appimage') {
        // Direkt neben die laufende Datei laden – kein Schreibrecht dort: in „Downloads“ legen
        try { fs.accessSync(path.dirname(kind.target), fs.constants.W_OK); } catch { await handoff(rel, [kind.fallback], dir, ctrl.signal); return; }
        file = path.join(path.dirname(kind.target), `.${path.basename(kind.target)}.update`);
        staged = file;
      }
      send({ phase: 'download', received: 0, total: asset.size, speed: 0 });
      await downloadRetry(asset, file, ctrl.signal);
      if (ctrl.signal.aborted) throw new Error('abgebrochen');

      let launch;
      try {
        if (kind.kind === 'mac') launch = await installMac(kind, file, dir, rel.version);
        else if (kind.kind === 'win-setup') launch = installWinSetup(file);
        else if (kind.kind === 'linux-appimage') launch = installAppImage(kind, file, dir);
        else launch = installWinPortable(kind, file, dir);
      } catch (err) {
        // Selbst austauschen geht nicht (z. B. keine Schreibrechte) – dann den Installer öffnen
        if (err.handoff && kind.fallback) { await handoff(rel, [kind.fallback], dir, ctrl.signal); return; }
        throw err;
      }

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
      if (staged && !job?.installing) fs.rm(staged, { force: true }, () => {});
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
  // Update-Fenster an den Inhalt anpassen (z. B. wenn „Was ist neu?“ dazukommt)
  ipcMain.handle('updater:fit', (_e, height) => {
    const h = Math.round(Number(height));
    if (!upWin || upWin.isDestroyed() || !Number.isFinite(h)) return;
    const [w] = upWin.getContentSize();
    // Feste Fenster lassen sich unter Linux sonst nicht vergrößern
    upWin.setResizable(true);
    upWin.setContentSize(w, Math.max(268, Math.min(560, h)));
    upWin.setResizable(false);
  });

  return { installKind, start };
}

module.exports = { setupUpdater, isAppImage };
