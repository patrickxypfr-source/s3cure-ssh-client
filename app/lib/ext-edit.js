// Server-Datei in einem Programm auf diesem Computer bearbeiten (z. B. VS Code, TextEdit, Notepad++)
// Ablauf: Datei in einen temporären Ordner laden -> öffnen -> Änderungen beobachten ->
// bei jedem Speichern automatisch hochladen. Hat sich die Server-Datei inzwischen geändert,
// wird vorher gefragt. Beim Beenden (oder App-Ende) werden die temporären Dateien gelöscht.
// Oberfläche: src/ext-edit.js
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const posix = path.posix;
const p = fn => new Promise((res, rej) => fn((e, r) => e ? rej(e) : res(r)));

const POLL = 700;        // ms: so oft wird die temporäre Datei geprüft
const SETTLE = 400;      // ms Ruhe nach dem Speichern, bevor hochgeladen wird
const MAX_SIZE = 200 * 1024 * 1024;
const MAX_OPEN = 50;
const STALE_MS = 3 * 24 * 3600 * 1000; // alte Reste von früheren Sitzungen

const T = {
  tooBig: 'Die Datei ist zu groß zum Bearbeiten (über 200 MB).',
  isDir: 'Das ist ein Ordner, keine Datei.',
  tooMany: `Es sind schon ${MAX_OPEN} Dateien extern geöffnet. Bitte zuerst welche beenden.`,
  noApp: 'Das Programm wurde nicht gefunden.',
  openFail: msg => 'Konnte nicht geöffnet werden: ' + msg,
  conflictTitle: 'Server-Datei wurde geändert',
  conflictMsg: name => `„${name}“ wurde auf dem Server geändert, seit du sie geöffnet hast (von jemand anderem oder einem Programm). Deine Änderung hochladen und die Server-Version überschreiben?`,
  conflictDetail: (srv, mine) => `Server:  ${srv}\nDeine:   ${mine}`,
  conflictOk: 'Trotzdem hochladen',
  offline: 'Keine Verbindung – wird hochgeladen, sobald der Server wieder da ist.',
  skipped: 'Nicht hochgeladen (Server-Version behalten).',
  chooseApp: 'Programm zum Bearbeiten wählen',
  chooseBtn: 'Auswählen',
};

// Bekannte Editoren, falls installiert
function knownEditors(platform) {
  const home = os.homedir();
  const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  if (platform === 'darwin') {
    return [
      ['Visual Studio Code', '/Applications/Visual Studio Code.app'],
      ['Cursor', '/Applications/Cursor.app'],
      ['Sublime Text', '/Applications/Sublime Text.app'],
      ['BBEdit', '/Applications/BBEdit.app'],
      ['CotEditor', '/Applications/CotEditor.app'],
      ['TextEdit', '/System/Applications/TextEdit.app'],
    ];
  }
  if (platform === 'win32') {
    return [
      ['Visual Studio Code', path.join(la, 'Programs', 'Microsoft VS Code', 'Code.exe')],
      ['Visual Studio Code', path.join(pf, 'Microsoft VS Code', 'Code.exe')],
      ['Cursor', path.join(la, 'Programs', 'cursor', 'Cursor.exe')],
      ['Notepad++', path.join(pf, 'Notepad++', 'notepad++.exe')],
      ['Notepad++', path.join(pf86, 'Notepad++', 'notepad++.exe')],
      ['Sublime Text', path.join(pf, 'Sublime Text', 'sublime_text.exe')],
      ['Editor (Notepad)', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe')],
    ];
  }
  return [
    ['Visual Studio Code', '/usr/bin/code'],
    ['gedit', '/usr/bin/gedit'],
    ['Kate', '/usr/bin/kate'],
  ];
}

const appName = file => path.basename(file).replace(/\.(app|exe)$/i, '');

function register({ app, ipcMain, shell, dialog, getSftp, sftpError, transfers, getWin, configDir, platform }) {
  const IS_MAC = platform === 'darwin';
  const IS_WIN = platform === 'win32';
  const BASE = path.join(app.getPath('temp'), 's3cure-edit');
  const EDITORS_FILE = path.join(configDir, 'editors.json');
  const files = new Map(); // id -> Eintrag
  const pendingAsks = new Map();

  const send = (channel, ...args) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(channel, ...args); };
  const clean = err => (err instanceof Error && typeof err.code !== 'number' ? err : sftpError(err));

  // Reste früherer Sitzungen (Absturz) aufräumen
  (async () => {
    try {
      for (const d of await fsp.readdir(BASE)) {
        const full = path.join(BASE, d);
        const st = await fsp.stat(full).catch(() => null);
        if (st && Date.now() - st.mtimeMs > STALE_MS) await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
      }
    } catch {}
  })();

  // ---------- gemerkte Programme ----------

  function loadEditors() {
    try { const v = JSON.parse(fs.readFileSync(EDITORS_FILE, 'utf8')); return Array.isArray(v.recent) ? v : { recent: [] }; } catch { return { recent: [] }; }
  }
  function saveEditors(v) {
    try { fs.mkdirSync(configDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(EDITORS_FILE, JSON.stringify(v, null, 2)); } catch {}
  }
  function rememberEditor(file) {
    const v = loadEditors();
    v.recent = [{ name: appName(file), path: file }, ...v.recent.filter(e => e.path !== file)].slice(0, 6);
    saveEditors(v);
  }

  ipcMain.handle('extedit:editors', async () => {
    const seen = new Set();
    const list = [];
    for (const e of loadEditors().recent) {
      if (!e || typeof e.path !== 'string' || seen.has(e.path)) continue;
      if (await fsp.stat(e.path).catch(() => null)) { seen.add(e.path); list.push({ name: String(e.name || appName(e.path)), path: e.path, recent: true }); }
    }
    for (const [name, file] of knownEditors(platform)) {
      if (seen.has(file) || list.some(e => e.name === name)) continue;
      if (await fsp.stat(file).catch(() => null)) { seen.add(file); list.push({ name, path: file }); }
    }
    return list;
  });

  ipcMain.handle('extedit:pick-app', async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: T.chooseApp, buttonLabel: T.chooseBtn,
      defaultPath: IS_MAC ? '/Applications' : IS_WIN ? (process.env.ProgramFiles || 'C:\\Program Files') : '/usr/bin',
      properties: ['openFile'],
      filters: IS_MAC ? [{ name: 'Programme', extensions: ['app'] }] : IS_WIN ? [{ name: 'Programme', extensions: ['exe'] }] : [],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    rememberEditor(r.filePaths[0]);
    return { name: appName(r.filePaths[0]), path: r.filePaths[0] };
  });

  // ---------- Öffnen ----------

  async function launch(file, appPath) {
    if (!appPath) {
      const msg = await shell.openPath(file);
      if (msg) throw new Error(T.openFail(msg));
      return;
    }
    if (!(await fsp.stat(appPath).catch(() => null))) throw new Error(T.noApp);
    await new Promise((resolve, reject) => {
      const child = IS_MAC && process.platform === 'darwin'
        ? spawn('open', ['-a', appPath, file], { detached: true, stdio: 'ignore' })
        : spawn(appPath, [file], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', err => reject(new Error(T.openFail(err.message))));
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }

  const publicFile = f => ({
    id: f.id, tabId: f.tabId, remote: f.remote, name: f.name, label: f.label, app: f.appName,
    opened: f.opened, lastUpload: f.lastUpload, uploads: f.uploads, state: f.state, error: f.error,
  });
  const publish = () => send('extedit:status', [...files.values()].map(publicFile));

  // opts: { app: Pfad | null, label: Anzeigename der Verbindung }
  ipcMain.handle('extedit:open', async (_e, tabId, remote, opts = {}) => {
    if (typeof remote !== 'string' || !remote.startsWith('/') || remote.includes('\0')) throw new Error('Ungültiger Pfad auf dem Server.');
    const appPath = typeof opts.app === 'string' && opts.app ? opts.app : null;
    // schon offen? Dann nur wieder anzeigen
    for (const f of files.values()) {
      if (f.tabId === tabId && f.remote === remote) {
        await launch(f.local, appPath || f.appPath);
        return publicFile(f);
      }
    }
    if (files.size >= MAX_OPEN) throw new Error(T.tooMany);
    const sftp = await getSftp(tabId);
    let st;
    try { st = await p(cb => sftp.stat(remote, cb)); } catch (err) { throw sftpError(err, posix.basename(remote)); }
    if (st.isDirectory()) throw new Error(T.isDir);
    if (st.size > MAX_SIZE) throw new Error(T.tooBig);

    const id = crypto.randomUUID();
    const dir = path.join(BASE, id);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    let name = posix.basename(remote);
    if (IS_WIN || process.platform === 'win32') name = name.replace(/[<>:"|?*\\]/g, '_');
    const local = path.join(dir, name);
    const job = transfers.start(tabId, 'download', name);
    try {
      job.setTotal(st.size);
      await job.copy('get', sftp, remote, local, name, { size: st.size });
      await job.finish(); // erst öffnen, wenn die Datei wirklich da ist
    } catch (err) {
      job.finish(err);
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw sftpError(err, name);
    }
    const lst = await fsp.stat(local);
    const f = {
      id, tabId, remote, name, local, dir, label: String(opts.label || '').slice(0, 200),
      appPath, appName: appPath ? appName(appPath) : null,
      base: { size: st.size, mtime: st.mtime }, // Server-Stand beim letzten Laden/Hochladen
      seen: { size: lst.size, mtime: lst.mtimeMs }, // Stand der temporären Datei
      changedAt: 0, opened: Date.now(), lastUpload: null, uploads: 0, state: 'watching', error: null,
      busy: false, timer: null,
    };
    files.set(id, f);
    if (appPath) rememberEditor(appPath);
    f.timer = setInterval(() => check(f), POLL);
    try { await launch(local, appPath); } catch (err) { await close(id, { skipUpload: true }); throw err; }
    publish();
    return publicFile(f);
  });

  // ---------- Beobachten & Hochladen ----------

  // Polling ist robuster als fs.watch: viele Editoren speichern über eine neue Datei + Umbenennen
  async function check(f) {
    if (f.busy || f.closed) return;
    const st = await fsp.stat(f.local).catch(() => null);
    if (!st) return; // gerade beim Speichern ersetzt
    if (st.size !== f.seen.size || st.mtimeMs !== f.seen.mtime) {
      f.seen = { size: st.size, mtime: st.mtimeMs };
      f.changedAt = Date.now();
      f.dirty = true;
      return; // erst hochladen, wenn das Speichern fertig ist
    }
    if (f.dirty && Date.now() - f.changedAt >= SETTLE) await upload(f);
  }

  function ask(req) {
    return new Promise(resolve => {
      const reqId = crypto.randomUUID();
      pendingAsks.set(reqId, resolve);
      send('extedit:ask', { reqId, ...req });
    });
  }
  ipcMain.on('extedit:answer', (_e, reqId, value) => {
    const r = pendingAsks.get(reqId);
    pendingAsks.delete(reqId);
    if (r) r(value);
  });

  async function upload(f, { force = false } = {}) {
    if (f.busy || f.closed) return;
    f.busy = true;
    f.state = 'uploading';
    publish();
    try {
      let sftp;
      try { sftp = await getSftp(f.tabId); } catch {
        f.state = 'error'; f.error = T.offline; return; // bleibt dirty -> nächster Versuch
      }
      // Konflikt: Server-Datei seit dem letzten Laden geändert?
      const now = await p(cb => sftp.stat(f.remote, cb)).catch(() => null);
      if (now && !force && (now.mtime !== f.base.mtime || now.size !== f.base.size)) {
        const fmt = (s, m) => `${new Date(m * 1000).toLocaleString('de-DE')} · ${s.toLocaleString('de-DE')} Bytes`;
        const ok = await ask({
          kind: 'confirm', title: T.conflictTitle, message: T.conflictMsg(f.name),
          detail: T.conflictDetail(fmt(now.size, now.mtime), fmt(f.seen.size, Math.floor(f.seen.mtime / 1000))),
          okLabel: T.conflictOk, danger: true,
        });
        if (f.closed) return;
        if (!ok) {
          f.dirty = false; f.state = 'conflict'; f.error = T.skipped;
          f.base = { size: now.size, mtime: now.mtime }; // nicht erneut fragen, bis wieder gespeichert wird
          return;
        }
      }
      const job = transfers.start(f.tabId, 'upload', f.name);
      const before = { ...f.seen };
      try {
        job.setTotal(f.seen.size);
        await job.copy('put', sftp, f.local, f.remote, f.name, { size: f.seen.size });
        await job.finish(); // auf das echte Ende des Hochladens warten
      } catch (err) { job.finish(err); throw err; }
      const after = await p(cb => sftp.stat(f.remote, cb)).catch(() => null);
      if (after) f.base = { size: after.size, mtime: after.mtime };
      // Während des Hochladens nochmals gespeichert? Dann gleich nochmal.
      f.dirty = f.seen.size !== before.size || f.seen.mtime !== before.mtime;
      f.uploads++;
      f.lastUpload = Date.now();
      f.state = 'watching';
      f.error = null;
    } catch (err) {
      f.state = 'error';
      f.error = clean(err).message;
      f.dirty = false; // nicht endlos wiederholen; beim nächsten Speichern erneut
    } finally {
      f.busy = false;
      publish();
    }
  }

  // ---------- Beenden ----------

  async function close(id, { skipUpload = false } = {}) {
    const f = files.get(id);
    if (!f) return false;
    if (!skipUpload) {
      // zuletzt gespeicherte Änderung noch hochladen
      const st = await fsp.stat(f.local).catch(() => null);
      if (st && (st.size !== f.seen.size || st.mtimeMs !== f.seen.mtime)) { f.seen = { size: st.size, mtime: st.mtimeMs }; f.dirty = true; }
      for (let i = 0; i < 50 && f.busy; i++) await new Promise(r => setTimeout(r, 100));
      if (f.dirty) await upload(f);
    }
    f.closed = true;
    clearInterval(f.timer);
    files.delete(id);
    await fsp.rm(f.dir, { recursive: true, force: true }).catch(() => {});
    publish();
    return true;
  }

  ipcMain.handle('extedit:list', () => [...files.values()].map(publicFile));
  ipcMain.handle('extedit:close', (_e, id) => close(id));
  ipcMain.handle('extedit:upload', async (_e, id) => { const f = files.get(id); if (f) { f.dirty = true; await upload(f, { force: true }); } });
  ipcMain.handle('extedit:show', async (_e, id) => { const f = files.get(id); if (f) await launch(f.local, f.appPath); });

  // Tab geschlossen: offene Dateien dieses Tabs hochladen (falls möglich) und aufräumen
  ipcMain.on('ssh:close', (_e, tabId) => { for (const f of [...files.values()]) if (f.tabId === tabId) close(f.id, { skipUpload: true }); });

  // App-Ende: temporäre Dateien sofort löschen (synchron, die App beendet sich gleich)
  function cleanupAll() {
    for (const f of files.values()) { f.closed = true; clearInterval(f.timer); try { fs.rmSync(f.dir, { recursive: true, force: true }); } catch {} }
    files.clear();
  }
  app.on('will-quit', cleanupAll);

  return { cleanupAll, count: () => files.size };
}

module.exports = { register, knownEditors };
