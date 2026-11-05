// S3cure SSH Client – Hauptprozess: Fenster, gespeicherte Verbindungen und SSH-Sitzungen
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, safeStorage, Menu, powerMonitor, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { createTunnelManager } = require('./lib/tunnels');
const { setupUpdateCheck } = require('./lib/update-check');
const sftpExtra = require('./lib/sftp-extra');
// Übertragungs-Warteschlange (Pause, Fortsetzen, parallel, Limit): app/lib/transfers.js
const transfers = require('./lib/transfers').create(() => win, {
  getSftp: id => getSftp(id), isConnected: id => sessions.has(id) || files.isFtp(id), sftpError: (err, t) => sftpError(err, t),
});
const snippets = require('./lib/snippets');
const monitor = require('./lib/monitor');
const owners = require('./lib/owners');

// Dieselben Dateien wie das Kommandozeilen-Tool myssh
// S3CURE_CONFIG_DIR nur für Tests, sonst ~/.myssh
const CONFIG_DIR = process.env.S3CURE_CONFIG_DIR || path.join(os.homedir(), '.myssh');
const HOSTS_FILE = path.join(CONFIG_DIR, 'hosts.json');
const PASSWORDS_FILE = path.join(CONFIG_DIR, 'passwords.json');
const SYSTEM_KNOWN_HOSTS = path.join(os.homedir(), '.ssh', 'known_hosts');
// S3CURE_PLATFORM nur für Tests (Windows-/Linux-Verhalten auf dem Mac ausprobieren: win32, linux)
const PLATFORM = process.env.S3CURE_PLATFORM || process.platform;
const IS_MAC = PLATFORM === 'darwin';
const { createConnection } = require('./lib/connection');
const { createSecretStore } = require('./lib/secrets');
const { hostExtras, updateJumpRefs } = require('./lib/hosts-extra');
const { createAppLock } = require('./lib/applock');
const { createKnownHosts } = require('./lib/knownhosts');
const { createProxyManager } = require('./lib/proxy');
const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'].map(k => path.join(os.homedir(), '.ssh', k));

let win;
const sessions = new Map(); // Tab-ID -> { client, stream }

// Eigene Befehlsknöpfe (snippets.json) und Server-Übersicht
const snippetStore = snippets.register(ipcMain, { configDir: CONFIG_DIR, dialog, getWin: () => win });
// Lesezeichen für Ordner (app/lib/bookmarks.js, Oberfläche: src/file-nav.js)
const bookmarks = require('./lib/bookmarks').register({ ipcMain, configDir: CONFIG_DIR });
monitor.register(ipcMain, sessions);

// ---------- gespeicherte Verbindungen ----------

function loadHosts() {
  try { return JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')); } catch { return {}; }
}

function saveHosts(hosts) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(HOSTS_FILE, JSON.stringify(hosts, null, 2));
}

// ---------- gespeicherte Passwörter ----------
// Verschlüsselt mit einem Schlüssel aus dem macOS-Schlüsselbund (Electron safeStorage).
// In der Datei steht nur verschlüsselter Text, nie das Passwort selbst.

function loadPasswordStore() {
  try { return JSON.parse(fs.readFileSync(PASSWORDS_FILE, 'utf8')); } catch { return {}; }
}

function savePasswordStore(store) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PASSWORDS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function readPassword(name) {
  const enc = loadPasswordStore()[name];
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
}

function writePassword(name, password) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const store = loadPasswordStore();
  store[name] = safeStorage.encryptString(password).toString('base64');
  savePasswordStore(store);
  return true;
}

function removePassword(name) {
  const store = loadPasswordStore();
  if (!(name in store)) return;
  delete store[name];
  savePasswordStore(store);
}

function renamePassword(oldName, newName) {
  const store = loadPasswordStore();
  if (!(oldName in store)) return;
  store[newName] = store[oldName];
  delete store[oldName];
  savePasswordStore(store);
}

// Verbindungen für die Oberfläche, mit Hinweis ob ein Passwort gespeichert ist
function hostsForUi() {
  const hosts = loadHosts();
  const store = loadPasswordStore();
  for (const name of Object.keys(hosts)) hosts[name] = { ...hosts[name], hasPassword: name in store };
  return hosts;
}

// 'user@host:port' -> Zielobjekt (wie im CLI)
function parseTarget(text) {
  const at = text.lastIndexOf('@');
  const user = at >= 0 ? text.slice(0, at) : '';
  const [host, port] = text.slice(at + 1).split(':');
  return { user: user || os.userInfo().username, host, port: Number(port) || 22, key: null };
}

function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// ---------- Fragen an die Oberfläche (Passwort, Host-Key, …) ----------

const pendingAsks = new Map();

function ask(request) {
  return new Promise(resolve => {
    const reqId = crypto.randomUUID();
    pendingAsks.set(reqId, resolve);
    win.webContents.send('ask', { reqId, ...request });
  });
}

ipcMain.on('ask-answer', (_e, reqId, value) => {
  const resolve = pendingAsks.get(reqId);
  pendingAsks.delete(reqId);
  if (resolve) resolve(value);
});

// ---------- Host-Key-Prüfung (known_hosts, kompatibel zu OpenSSH/CLI): app/lib/knownhosts.js ----------

const knownHosts = createKnownHosts({ configDir: CONFIG_DIR, ask, systemFile: SYSTEM_KNOWN_HOSTS });
knownHosts.register(ipcMain);
const verifyHostKey = knownHosts.verifyHostKey;

// ---------- SSH-Sitzung ----------

function friendlyError(err, target) {
  const msg = String(err && err.message || err);
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return `Server „${target.host}“ nicht gefunden. Stimmt die Adresse?`;
  if (/ECONNREFUSED/.test(msg)) return `${target.host} lehnt die Verbindung ab. Läuft dort ein SSH-Server auf Port ${target.port}?`;
  if (/ETIMEDOUT|Timed out/.test(msg)) return `${target.host} antwortet nicht (Zeitüberschreitung). Ist das Gerät eingeschaltet und im selben Netz?`;
  if (/EHOSTUNREACH|ENETUNREACH/.test(msg)) return `${target.host} ist nicht erreichbar.`;
  if (/authentication methods failed/i.test(msg)) return 'Anmeldung fehlgeschlagen (falsches Passwort oder Schlüssel nicht akzeptiert).';
  return 'Verbindung fehlgeschlagen: ' + msg;
}

// Verbindungsaufbau, Sprung-Server, Wachhalten: app/lib/connection.js
const passphrases = createSecretStore(path.join(CONFIG_DIR, 'passphrases.json'));
const sendToUi = (channel, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); };
// Proxy (SOCKS5/HTTP-CONNECT) global oder pro Verbindung: app/lib/proxy.js
const proxies = createProxyManager({ configDir: CONFIG_DIR, ask, secrets: createSecretStore(path.join(CONFIG_DIR, 'proxy-passwords.json')) });
proxies.register(ipcMain);
const connection = createConnection({
  loadHosts, parseTarget, expandHome, ask, verifyHostKey, friendlyError, sessions, send: sendToUi, proxies,
  passwords: { read: readPassword, write: writePassword, remove: removePassword },
  passphrases, defaultKeys: DEFAULT_KEYS,
});

ipcMain.handle('ssh:connect', (_e, tabId, spec, cols, rows) => {
  closeSession(tabId, { keepTransfers: true }); // Übertragungen warten aufs Neuverbinden
  if (files.isFtpSpec(spec)) return files.connect(tabId, spec); // FTP/FTPS: nur Dateien (lib/files-adapter.js)
  return connection.openShell(tabId, spec, cols, rows).then(info => {
    tunnels.onConnected(tabId);
    transfers.resumeTab(tabId);
    return info;
  });
});

function closeSession(tabId, { keepTransfers = false } = {}) {
  stopSearch(tabId);
  tunnels.stopAll(tabId);
  if (keepTransfers) transfers.suspendTab(tabId); else transfers.cancelTab(tabId);
  files.close(tabId);
  const s = sessions.get(tabId);
  if (s) { sessions.delete(tabId); s.client.end(); }
}

ipcMain.on('ssh:write', (_e, tabId, data) => sessions.get(tabId)?.stream.write(data));
ipcMain.on('ssh:resize', (_e, tabId, cols, rows) => sessions.get(tabId)?.stream.setWindow(rows, cols, 0, 0));
ipcMain.on('ssh:close', (_e, tabId) => { closeSession(tabId); connection.forget(tabId); files.forget(tabId); });

// ---------- Dateien (SFTP) ----------

const posix = path.posix;
// Callback-Funktion in Promise verwandeln
const p = fn => new Promise((res, rej) => fn((e, r) => e ? rej(e) : res(r)));

function sshSftp(tabId) {
  const s = sessions.get(tabId);
  if (!s) return Promise.reject(new Error('Keine aktive Verbindung in diesem Tab.'));
  if (!s.sftp) {
    s.sftp = new Promise((resolve, reject) => s.client.sftp((err, sftp) => {
      if (err) { s.sftp = null; return reject(new Error('SFTP ist auf diesem Server nicht verfügbar: ' + err.message)); }
      sftp.on('close', () => { s.sftp = null; });
      resolve(sftp);
    }));
  }
  return s.sftp;
}

// Dateizugriff je Tab: SFTP oder FTP/FTPS mit denselben Funktionen (app/lib/files-adapter.js, app/lib/ftp.js)
const files = require('./lib/files-adapter').createFilesAdapter({
  configDir: CONFIG_DIR, loadHosts, ask, sshSftp,
  passwords: { read: readPassword, write: writePassword, remove: removePassword },
});
const getSftp = tabId => files.get(tabId);

function sftpError(err, target) {
  const where = target ? ` (${target})` : '';
  if (err && err.code === 2) return new Error('Datei oder Ordner gibt es nicht' + where + '.');
  if (err && err.code === 3) return new Error('Keine Berechtigung' + where + '.');
  if (err && err.code === 4) return new Error('Vorgang fehlgeschlagen' + where + '. Ist der Ordner vielleicht nicht leer, oder gibt es den Namen schon?');
  return err instanceof Error ? err : new Error(String(err));
}

function modeString(mode, isDir, isLink) {
  const chars = 'rwxrwxrwx';
  let s = isLink ? 'l' : isDir ? 'd' : '-';
  for (let i = 0; i < 9; i++) s += (mode & (1 << (8 - i))) ? chars[i] : '-';
  return s;
}

ipcMain.handle('sftp:list', async (_e, tabId, dir) => {
  const sftp = await getSftp(tabId);
  let abs;
  try {
    if (!dir || dir === '~') abs = await p(cb => sftp.realpath('.', cb));
    else if (dir.startsWith('~/')) abs = posix.join(await p(cb => sftp.realpath('.', cb)), dir.slice(2));
    else abs = await p(cb => sftp.realpath(dir, cb));
    abs = posix.normalize(abs).replace(/^\/+/, '/');
    const list = await p(cb => sftp.readdir(abs, cb));
    const entries = await Promise.all(list.map(async item => {
      const a = item.attrs;
      const isLink = a.isSymbolicLink();
      let isDir = a.isDirectory();
      if (isLink) { try { isDir = (await p(cb => sftp.stat(posix.join(abs, item.filename), cb))).isDirectory(); } catch {} }
      return { name: item.filename, isDir, isLink, size: a.size, mtime: a.mtime * 1000, mode: modeString(a.mode, isDir, isLink), uid: a.uid, gid: a.gid, longname: item.longname };
    }));
    entries.sort((x, y) => (y.isDir - x.isDir) || x.name.localeCompare(y.name, 'de', { sensitivity: 'base' }));
    await owners.annotate(sessions.get(tabId), entries); // Besitzer/Gruppe als Namen (app/lib/owners.js)
    return { path: abs, entries };
  } catch (err) { throw sftpError(err, abs || dir); }
});

ipcMain.handle('sftp:mkdir', async (_e, tabId, remote) => {
  const sftp = await getSftp(tabId);
  try { await p(cb => sftp.mkdir(remote, cb)); } catch (err) { throw sftpError(err, posix.basename(remote)); }
});

ipcMain.handle('sftp:rename', async (_e, tabId, from, to) => {
  const sftp = await getSftp(tabId);
  try { await p(cb => sftp.rename(from, to, cb)); } catch (err) { throw sftpError(err, posix.basename(to)); }
});

async function removeRecursive(sftp, remote) {
  const st = await p(cb => sftp.lstat(remote, cb));
  if (st.isDirectory()) {
    for (const item of await p(cb => sftp.readdir(remote, cb))) await removeRecursive(sftp, posix.join(remote, item.filename));
    await p(cb => sftp.rmdir(remote, cb));
  } else {
    await p(cb => sftp.unlink(remote, cb));
  }
}

ipcMain.handle('sftp:delete', async (_e, tabId, remotes) => {
  const sftp = await getSftp(tabId);
  for (const r of remotes) {
    try { await removeRecursive(sftp, r); } catch (err) { throw sftpError(err, posix.basename(r)); }
  }
});

// Lokale Dateien/Ordner auswählen (Hochladen)
// Windows kann nicht Dateien und Ordner im selben Dialog wählen -> kind: 'files' | 'folders'
ipcMain.handle('pick-upload', async (_e, kind) => {
  const properties = IS_MAC ? ['openFile', 'openDirectory', 'multiSelections', 'createDirectory']
    : kind === 'folders' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'];
  const r = await dialog.showOpenDialog(win, { title: 'Hochladen', buttonLabel: 'Hochladen', properties });
  return r.canceled ? null : r.filePaths;
});

async function uploadPath(job, sftp, local, remoteDir) {
  const name = path.basename(local);
  const remote = posix.join(remoteDir, name);
  if (fs.statSync(local).isDirectory()) {
    try { await p(cb => sftp.mkdir(remote, cb)); } catch { /* Ordner gibt es schon */ }
    for (const child of fs.readdirSync(local)) {
      if (child === '.DS_Store') continue;
      await uploadPath(job, sftp, path.join(local, child), remote);
    }
  } else {
    await job.copy('put', sftp, local, remote, name);
  }
}

ipcMain.handle('sftp:upload', async (_e, tabId, remoteDir, localPaths) => {
  const sftp = await getSftp(tabId);
  const job = transfers.start(tabId, 'upload', localPaths.length === 1 ? path.basename(localPaths[0]) : `${localPaths.length} Elemente`, { remoteDir });
  job.setTotal(transfers.localSize(localPaths));
  for (const local of localPaths) {
    try { await uploadPath(job, sftp, local, remoteDir); } catch (err) { job.finish(err); throw sftpError(err, path.basename(local)); }
  }
  await job.finish(); // wartet, bis die Warteschlange alles übertragen hat
  return localPaths.length;
});

async function downloadPath(job, sftp, remote, local) {
  const st = await p(cb => sftp.stat(remote, cb));
  if (st.isDirectory()) {
    fs.mkdirSync(local, { recursive: true });
    for (const item of await p(cb => sftp.readdir(remote, cb))) {
      job.check();
      await downloadPath(job, sftp, posix.join(remote, item.filename), path.join(local, item.filename));
    }
  } else {
    await job.copy('get', sftp, remote, local, posix.basename(remote), { size: st.size });
  }
}

// items: [{ path, isDir }]
ipcMain.handle('sftp:download', async (_e, tabId, items) => {
  const sftp = await getSftp(tabId);
  let targets;
  if (items.length === 1 && !items[0].isDir) {
    const r = await dialog.showSaveDialog(win, {
      title: 'Speichern unter', defaultPath: path.join(app.getPath('downloads'), posix.basename(items[0].path)),
    });
    if (r.canceled) return null;
    targets = [r.filePath];
  } else {
    const r = await dialog.showOpenDialog(win, {
      title: 'Zielordner wählen', buttonLabel: 'Hier speichern', defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled) return null;
    targets = items.map(it => path.join(r.filePaths[0], posix.basename(it.path)));
  }
  const job = transfers.start(tabId, 'download', items.length === 1 ? posix.basename(items[0].path) : `${items.length} Elemente`, { localDir: path.dirname(targets[0]) });
  job.setTotal(await transfers.remoteSize(sftp, items.map(it => it.path)));
  for (let i = 0; i < items.length; i++) {
    try { await downloadPath(job, sftp, items[i].path, targets[i]); } catch (err) { job.finish(err); throw sftpError(err, posix.basename(items[i].path)); }
  }
  await job.finish(); // wartet, bis die Warteschlange alles übertragen hat
  return targets;
});

ipcMain.on('show-file', (_e, file) => shell.showItemInFolder(file));
transfers.register(ipcMain); // Abbrechen, Pause, Reihenfolge, Erneut versuchen, Einstellungen

// Editor, Vorschau, Rechte, ZIP (app/lib/sftp-extra.js)
sftpExtra.register({
  ipcMain, getSftp, sftpError,
  getClient: tabId => {
    if (files.isFtp(tabId)) throw new Error('Das geht nur mit SSH-Verbindungen, nicht mit FTP.');
    const s = sessions.get(tabId);
    if (!s) throw new Error('Keine aktive Verbindung in diesem Tab.');
    return s.client;
  },
});

// Geteilte Dateiansicht: lokales Dateifenster und Übertragungen dorthin (app/lib/localfs.js, app/lib/pane-transfer.js)
require('./lib/localfs').register({ app, ipcMain, shell, platform: PLATFORM });
require('./lib/pane-transfer').register({ ipcMain, getSftp, sftpError, transfers, getWin: () => win, platform: PLATFORM });

// Synchronisieren, Server-Ordner aktuell halten, extern bearbeiten, Dateien vergleichen
// (app/lib/sync.js, app/lib/ext-edit.js, app/lib/compare.js)
const getClient = tabId => {
  const s = sessions.get(tabId);
  if (!s) throw new Error('Keine aktive Verbindung in diesem Tab.');
  return s.client;
};
require('./lib/sync').register({ ipcMain, shell, getSftp, getClient, sftpError, transfers, getWin: () => win });
require('./lib/ext-edit').register({ app, ipcMain, shell, dialog, getSftp, sftpError, transfers, getWin: () => win, configDir: CONFIG_DIR, platform: PLATFORM });
require('./lib/compare').register({ ipcMain, dialog, getWin: () => win });

// ---------- Suche auf dem Server ----------
// Bevorzugt `find` direkt auf dem Server (schnell). Erlaubt der Server keine Befehle,
// wird per SFTP Ordner für Ordner durchsucht.

const searches = new Map(); // Tab-ID -> Suchzustand
const SEARCH_LIMIT = 2000;
const SEARCH_SKIP = ['/proc', '/sys', '/dev', '/run'];

const shQuote = str => `'${String(str).replace(/'/g, `'\\''`)}'`;
const searchPattern = q => (/[*?[]/.test(q) ? q : `*${q}*`);

function globToRegex(glob) {
  const re = glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i');
}

function stopSearch(tabId) {
  const st = searches.get(tabId);
  if (st) { st.cancelled = true; if (st.stop) st.stop(); }
}

function searchWithFind(client, root, query, state, add) {
  return new Promise(resolve => {
    const skip = SEARCH_SKIP.map(x => `-path ${x}`).join(' -o ');
    const cmd = `find ${shQuote(root)} \\( ${skip} \\) -prune -o -iname ${shQuote(searchPattern(query))} ` +
      `-exec sh -c 'for p do if [ -d "$p" ]; then echo "d $p"; else echo "f $p"; fi; done' sh {} + 2>/dev/null`;
    client.exec(cmd, (err, stream) => {
      if (err) return resolve(false);
      let rest = '';
      let got = false;
      let exitCode = null;
      state.stop = () => { try { stream.close(); } catch {} };
      if (state.cancelled) state.stop();
      stream.on('data', d => {
        got = true;
        rest += d.toString('utf8');
        const lines = rest.split('\n');
        rest = lines.pop();
        for (const l of lines) if (l.length > 2) add(l[0], l.slice(2));
      });
      stream.stderr.on('data', () => {});
      stream.on('exit', code => { exitCode = code; });
      stream.on('close', () => {
        if (rest.length > 2) add(rest[0], rest.slice(2));
        // 126/127: find fehlt oder ist nicht ausführbar -> SFTP-Suche
        resolve(got || state.cancelled || (exitCode != null && exitCode !== 126 && exitCode !== 127));
      });
    });
  });
}

async function searchWithSftp(tabId, root, query, state, add) {
  const sftp = await getSftp(tabId);
  const re = globToRegex(searchPattern(query));
  const queue = [root];
  let active = 0;
  state.stop = null;
  const worker = async () => {
    while (!state.cancelled && !state.limited) {
      const dir = queue.shift();
      if (dir === undefined) {
        if (active === 0) return;
        await new Promise(r => setTimeout(r, 15));
        continue;
      }
      active++;
      try {
        const list = await p(cb => sftp.readdir(dir, cb));
        for (const it of list) {
          const full = posix.join(dir, it.filename);
          const isDir = it.attrs.isDirectory(); // Links werden nicht verfolgt (keine Endlosschleifen)
          if (re.test(it.filename)) add(isDir ? 'd' : 'f', full);
          if (isDir && !SEARCH_SKIP.includes(full)) queue.push(full);
        }
      } catch { /* keine Berechtigung o. Ä. -> überspringen */ }
      finally { active--; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

ipcMain.handle('search:start', (_e, tabId, root, query, searchId) => {
  const s = sessions.get(tabId);
  const isFtp = files.isFtp(tabId); // FTP: keine Befehle auf dem Server -> nur Ordner für Ordner
  if (!s && !isFtp) throw new Error('Keine aktive Verbindung in diesem Tab.');
  stopSearch(tabId);
  const state = { cancelled: false, limited: false, count: 0, stop: null, error: null };
  searches.set(tabId, state);
  const send = (channel, ...args) => {
    if (searches.get(tabId) === state && win && !win.isDestroyed()) win.webContents.send(channel, tabId, ...args);
  };

  let buffer = [];
  let timer = null;
  const flush = () => { clearTimeout(timer); timer = null; if (buffer.length) { send('search:results', searchId, buffer); buffer = []; } };
  const add = (type, full) => {
    if (state.cancelled || state.count >= SEARCH_LIMIT) return;
    state.count++;
    buffer.push({ path: full, isDir: type === 'd' });
    if (!timer) timer = setTimeout(flush, 120);
    if (state.count >= SEARCH_LIMIT) { state.limited = true; if (state.stop) state.stop(); }
  };

  (async () => {
    let done = false;
    if (!isFtp) { try { done = await searchWithFind(s.client, root, query, state, add); } catch {} }
    state.method = done ? 'find' : 'sftp';
    if (!done && !state.cancelled) {
      try { await searchWithSftp(tabId, root, query, state, add); } catch (err) { state.error = sftpError(err).message; }
    }
    flush();
    send('search:done', searchId, { count: state.count, limited: state.limited, cancelled: state.cancelled, error: state.error, method: state.method });
    if (searches.get(tabId) === state) searches.delete(tabId);
  })();
  return true;
});

ipcMain.on('search:cancel', (_e, tabId) => stopSearch(tabId));

// ---------- Verbindungen verwalten ----------

ipcMain.handle('hosts:list', () => hostsForUi());
ipcMain.handle('hosts:save', (_e, name, host, oldName) => {
  const hosts = loadHosts();
  const prev = hosts[oldName || name] || {}; // weitere Felder (z. B. Tunnel) behalten
  if (oldName && oldName !== name) { delete hosts[oldName]; renamePassword(oldName, name); snippetStore.rename(oldName, name); updateJumpRefs(hosts, oldName, name); bookmarks.rename(oldName, name); }
  hosts[name] = { ...prev, user: host.user || os.userInfo().username, host: host.host, port: Number(host.port) || 22, key: host.key || null, ...hostExtras(host) };
  saveHosts(hosts);
  if (host.forgetPassword) removePassword(name);
  if (host.proxyPassword && hosts[name].proxy && typeof hosts[name].proxy === 'object') proxies.setPassword(hosts[name].proxy, host.proxyPassword);
  if (host.password) {
    if (!writePassword(name, host.password)) throw new Error('Passwort konnte nicht verschlüsselt gespeichert werden (Schlüsselbund nicht verfügbar).');
  }
  return hostsForUi();
});
ipcMain.handle('hosts:delete', (_e, name) => {
  const hosts = loadHosts();
  delete hosts[name];
  updateJumpRefs(hosts, name, null);
  saveHosts(hosts);
  removePassword(name);
  bookmarks.remove(name);
  return hostsForUi();
});
// Import aus ~/.ssh/config und SSH-Schlüssel: app/lib/sshconfig.js, app/lib/keys.js
require('./lib/sshconfig').register(ipcMain, { loadHosts, saveHosts });
const keys = require('./lib/keys').register(ipcMain, { connection, loadHosts, saveHosts, passphrases });
// Schlüssel verwalten (Liste, kopieren, zeigen, erzeugen, übertragen): app/lib/keyring.js
require('./lib/keyring').register(ipcMain, {
  clipboard, shell, keys, extraFiles: () => Object.values(loadHosts()).map(h => expandHome(h.key)).filter(Boolean),
});
ipcMain.handle('pick-key', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Privaten Schlüssel wählen', defaultPath: path.join(os.homedir(), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? null : r.filePaths[0].replace(os.homedir(), '~');
});

// ---------- Tunnel & Update-Hinweis (eigene Dateien in lib/) ----------

const tunnels = createTunnelManager({
  ipcMain, shell, getWin: () => win, getSession: id => sessions.get(id), loadHosts, saveHosts,
});
const updateCheck = setupUpdateCheck({ ipcMain, shell, app, configDir: CONFIG_DIR });
// Automatisches Update (Knopf „Update“ unten links, Update-Fenster mit Fortschritt)
require('./lib/updater').setupUpdater({
  ipcMain, app, platform: PLATFORM, getMainWin: () => win, latestRelease: updateCheck.latestRelease,
  preload: path.join(__dirname, 'preload.js'),
});

// ---------- App-Sperre (app/lib/applock.js) ----------

const appLock = createAppLock({ configDir: CONFIG_DIR, isMac: IS_MAC });
appLock.register(ipcMain, {
  onUnlocked: () => {
    if (win && !win.isDestroyed() && win.webContents.getURL().endsWith('lock.html')) win.loadFile(path.join(__dirname, 'src', 'index.html'));
  },
});

// ---------- Fenster ----------

function titleBarColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#0f0f11' : '#f7f7f8', symbolColor: dark ? '#ededef' : '#18181b', height: 40 };
}

// Offene Tabs und Fenster beim nächsten Start wiederherstellen (app/lib/session.js)
const session = require('./lib/session').register({ ipcMain, configDir: CONFIG_DIR });

function createWindow() {
  win = new BrowserWindow({
    // Mindestgröße: Werkzeugleiste und Dateibrowser passen auch mit aufgeklappter Seitenleiste (siehe src/layout.js)
    width: 1100, height: 700, minWidth: 720, minHeight: 460,
    ...session.windowOptions(screen, { width: 720, height: 460 }), // zuletzt benutzte Größe/Position
    title: 'S3cure SSH Client',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0f11' : '#f7f7f8',
    // macOS: Ampelknöpfe im Fenster; Windows und Linux: eigene Titelleiste mit Fensterknöpfen oben rechts
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: titleBarColors() }),
    // Linux: Programmsymbol für Fensterliste/Dock (macOS und Windows nehmen es aus dem Paket)
    ...(PLATFORM === 'linux' ? { icon: path.join(__dirname, 'src', 'logo.png') } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // App-Sperre an: erst src/lock.html, nach dem Entsperren die Oberfläche
  win.loadFile(path.join(__dirname, 'src', appLock.isLocked() ? 'lock.html' : 'index.html'));
  // Links aus dem Terminal im normalen Browser öffnen, nicht in der App
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  session.track(win);
  win.on('closed', () => { for (const id of [...sessions.keys()]) closeSession(id); win = null; });
}

// Einstellungen und Terminal-Extras (eigene Dateien in lib/)
const settingsStore = require('./lib/settings').register({ app, ipcMain, nativeTheme, configDir: CONFIG_DIR });

// Backup & Umzug (app/lib/backup.js)
const backupApi = require('./lib/backup').register({
  ipcMain, dialog, app, getWin: () => win, configDir: CONFIG_DIR, loadHosts, saveHosts, settingsStore, snippetStore, passphrases,
  passwords: { names: () => Object.keys(loadPasswordStore()), read: readPassword, write: writePassword, remove: removePassword },
});
// Abgleich über einen Cloud-Ordner (app/lib/cloud-sync.js)
const cloudSync = require('./lib/cloud-sync').register({ ipcMain, dialog, getWin: () => win, send: sendToUi, configDir: CONFIG_DIR, data: backupApi.data, platform: PLATFORM });
app.whenReady().then(() => cloudSync.start());
require('./lib/term-extra').register({ app, ipcMain, dialog, shell, sessions, getWin: () => win, platform: PLATFORM });

app.setName('S3cure SSH Client');
// macOS: Beim Start außerhalb von „Programme“ (z. B. aus Downloads oder der DMG) anbieten,
// die App dorthin zu verschieben – wie bei richtigen Mac-Programmen. Nur einmal fragen.
async function offerMoveToApplications() {
  if (process.platform !== 'darwin' || !app.isPackaged || app.isInApplicationsFolder() || process.env.S3CURE_CONFIG_DIR) return false;
  const flag = path.join(CONFIG_DIR, 'install.json');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(flag, 'utf8')); } catch {}
  if (st.dontAskMove) return false;
  const r = await dialog.showMessageBox({
    type: 'question',
    message: 'S3cure SSH Client installieren?',
    detail: 'Die App liegt noch nicht im Ordner „Programme“. Soll sie dorthin verschoben werden? '
      + 'Dann findest du sie im Launchpad und in Spotlight, und Updates funktionieren automatisch.',
    buttons: ['In „Programme“ installieren', 'Nicht jetzt'],
    defaultId: 0, cancelId: 1,
    checkboxLabel: 'Nicht mehr fragen',
  });
  if (r.response !== 0) {
    if (r.checkboxChecked) { try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(flag, JSON.stringify({ ...st, dontAskMove: true })); } catch {} }
    return false;
  }
  try {
    // Verschiebt die App, beendet sie und startet sie aus „Programme“ neu
    return app.moveToApplicationsFolder({
      conflictHandler: type => type === 'exists' || type === 'existsAndRunning'
        ? dialog.showMessageBoxSync({ type: 'question', message: 'In „Programme“ gibt es schon eine S3cure-App.', detail: 'Durch diese Version ersetzen?', buttons: ['Ersetzen', 'Abbrechen'], defaultId: 0, cancelId: 1 }) === 0
        : true,
    });
  } catch (err) {
    dialog.showErrorBox('Installieren nicht möglich', String(err.message || err));
    return false;
  }
}

app.whenReady().then(async () => {
  // Windows/Linux: keine Menüleiste (Kopieren/Einfügen in Feldern geht trotzdem)
  if (!IS_MAC) Menu.setApplicationMenu(null);
  if (await offerMoveToApplications()) return; // App wird gerade verschoben und neu gestartet
  createWindow();
  // Nach dem Aufwachen: tote Verbindungen sofort erkennen und neu verbinden
  powerMonitor.on('resume', () => { connection.probeAll(); sendToUi('power:resume'); });
  nativeTheme.on('updated', () => { if (!IS_MAC && win && !win.isDestroyed()) win.setTitleBarOverlay(titleBarColors()); });
});
app.on('window-all-closed', () => app.quit());
