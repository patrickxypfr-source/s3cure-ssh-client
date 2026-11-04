// S3cure SSH Client – Hauptprozess: Fenster, gespeicherte Verbindungen und SSH-Sitzungen
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Client, utils } = require('ssh2');
const { createTunnelManager } = require('./lib/tunnels');
const { setupUpdateCheck } = require('./lib/update-check');
const sftpExtra = require('./lib/sftp-extra');
const transfers = require('./lib/transfers').create(() => win);

// Dieselben Dateien wie das Kommandozeilen-Tool myssh
// S3CURE_CONFIG_DIR nur für Tests, sonst ~/.myssh
const CONFIG_DIR = process.env.S3CURE_CONFIG_DIR || path.join(os.homedir(), '.myssh');
const HOSTS_FILE = path.join(CONFIG_DIR, 'hosts.json');
const KNOWN_HOSTS = path.join(CONFIG_DIR, 'known_hosts');
const PASSWORDS_FILE = path.join(CONFIG_DIR, 'passwords.json');
const SYSTEM_KNOWN_HOSTS = path.join(os.homedir(), '.ssh', 'known_hosts');
// S3CURE_PLATFORM nur für Tests (Windows-Verhalten auf dem Mac ausprobieren)
const PLATFORM = process.env.S3CURE_PLATFORM || process.platform;
const IS_MAC = PLATFORM === 'darwin';
const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'].map(k => path.join(os.homedir(), '.ssh', k));

let win;
const sessions = new Map(); // Tab-ID -> { client, stream }

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

// ---------- Host-Key-Prüfung (known_hosts, kompatibel zu OpenSSH/CLI) ----------

function knownName(host, port) {
  return port === 22 ? host : `[${host}]:${port}`;
}

function keyType(rawKey) {
  const len = rawKey.readUInt32BE(0);
  return rawKey.slice(4, 4 + len).toString();
}

function fingerprint(rawKey) {
  return 'SHA256:' + crypto.createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '');
}

function hostMatches(pattern, name) {
  if (pattern.startsWith('|1|')) { // gehashte Einträge
    const [, , salt, hash] = pattern.split('|');
    const h = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64');
    return h === hash;
  }
  return pattern.split(',').includes(name);
}

function knownKeysFor(name) {
  const result = [];
  for (const file of [SYSTEM_KNOWN_HOSTS, KNOWN_HOSTS]) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3 || parts[0].startsWith('#') || parts[0].startsWith('@')) continue;
      if (hostMatches(parts[0], name)) result.push({ type: parts[1], b64: parts[2] });
    }
  }
  return result;
}

async function verifyHostKey(target, rawKey) {
  const name = knownName(target.host, target.port);
  const type = keyType(rawKey);
  const b64 = rawKey.toString('base64');
  const sameType = knownKeysFor(name).filter(k => k.type === type);

  if (sameType.some(k => k.b64 === b64)) return { ok: true };
  if (sameType.length) {
    return {
      ok: false,
      error: `WARNUNG: Der Host-Key von ${name} hat sich geändert!\n` +
        `Das kann ein Angriff (Man-in-the-Middle) sein, oder der Server wurde neu installiert.\n` +
        `Neuer Fingerprint: ${fingerprint(rawKey)}\n` +
        `Wenn du sicher bist, dass das in Ordnung ist, entferne den alten Eintrag aus ~/.myssh/known_hosts.`,
    };
  }

  const trust = await ask({
    kind: 'confirm',
    title: 'Unbekannter Server',
    message: `Du verbindest dich zum ersten Mal mit ${name}.`,
    detail: `${type} Fingerprint:\n${fingerprint(rawKey)}\n\nVertraust du diesem Server?`,
    okLabel: 'Vertrauen & verbinden',
  });
  if (!trust) return { ok: false, error: 'Verbindung abgebrochen: Server nicht vertraut.' };

  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.appendFileSync(KNOWN_HOSTS, `${name} ${type} ${b64}\n`);
  return { ok: true };
}

// ---------- Anmeldung ----------

function makeAuthHandler(target, hostName, auth) {
  const user = target.user;
  const queue = [];
  // SSH-Agent: macOS/Linux über SSH_AUTH_SOCK, Windows über den OpenSSH-Agent-Dienst
  const WIN_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';
  let agent = process.env.SSH_AUTH_SOCK || null;
  if (!agent && process.platform === 'win32' && fs.existsSync(WIN_AGENT_PIPE)) agent = WIN_AGENT_PIPE;
  if (agent) queue.push({ type: 'agent', username: user, agent });
  const keyFiles = target.key ? [expandHome(target.key)] : DEFAULT_KEYS.filter(f => fs.existsSync(f));
  for (const file of keyFiles) queue.push({ type: 'publickey', username: user, file });

  let passwordTries = 0;

  async function loadKey(file) {
    let data;
    try { data = fs.readFileSync(file); } catch { return null; }
    let key = utils.parseKey(data);
    if (key instanceof Error && /passphrase/i.test(key.message)) {
      const pass = await ask({
        kind: 'secret', title: 'Schlüssel entsperren',
        message: `Passphrase für ${path.basename(file)}:`,
      });
      if (pass == null) return null;
      key = utils.parseKey(data, pass);
    }
    if (key instanceof Error) return null;
    return Array.isArray(key) ? key[0] : key;
  }

  let savedTried = false;
  let savedRejected = false;

  // Erst das gespeicherte Passwort, sonst nachfragen (mit Option „merken“)
  async function askPassword() {
    if (hostName && !savedTried) {
      savedTried = true;
      const saved = readPassword(hostName);
      if (saved != null) { auth.usedSaved = true; auth.pending = null; return saved; }
    }
    if (auth.usedSaved) {
      // Gespeichertes Passwort wurde abgelehnt -> verwerfen
      auth.usedSaved = false;
      savedRejected = true;
      removePassword(hostName);
    }
    const again = passwordTries > 0;
    passwordTries++;
    const answer = await ask({
      kind: 'secret',
      title: savedRejected && !again ? 'Passwort geändert?' : again ? 'Falsches Passwort' : 'Anmeldung',
      message: savedRejected && !again
        ? `Das gespeicherte Passwort wurde abgelehnt. Bitte neu eingeben für ${user}@${target.host}:`
        : `${again ? 'Nochmal versuchen. ' : ''}Passwort für ${user}@${target.host}:`,
      remember: !!hostName,
    });
    if (answer == null) return null;
    const value = typeof answer === 'object' ? answer.value : answer;
    auth.pending = hostName && typeof answer === 'object' && answer.remember ? value : null;
    return value;
  }

  return (methodsLeft, _partial, next) => {
    (async () => {
      const allowed = methodsLeft || ['publickey', 'password', 'keyboard-interactive'];
      while (queue.length) {
        const m = queue.shift();
        if (!allowed.includes('publickey')) continue;
        if (m.type === 'agent') return next(m);
        const key = await loadKey(m.file);
        if (key) return next({ type: 'publickey', username: user, key });
      }
      if (passwordTries < 3 || (hostName && !savedTried)) {
        if (allowed.includes('password')) {
          const pw = await askPassword();
          if (pw == null) return next(false);
          return next({ type: 'password', username: user, password: pw });
        }
        if (allowed.includes('keyboard-interactive')) {
          return next({
            type: 'keyboard-interactive', username: user,
            prompt: async (_name, _instr, _lang, prompts, finish) => {
              const answers = [];
              for (const p of prompts) {
                const a = /passw/i.test(p.prompt) ? await askPassword()
                  : await ask({ kind: p.echo ? 'text' : 'secret', title: 'Anmeldung', message: p.prompt });
                if (a == null) return finish([]);
                answers.push(a);
              }
              finish(answers);
            },
          });
        }
      }
      next(false);
    })().catch(() => next(false));
  };
}

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

ipcMain.handle('ssh:connect', (_e, tabId, spec, cols, rows) => {
  const target = spec.name ? loadHosts()[spec.name] : parseTarget(spec.text);
  const auth = { pending: null, usedSaved: false };
  if (!target) throw new Error(`Keine Verbindung namens „${spec.name}“ gespeichert.`);

  closeSession(tabId);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let hostError = null;
    let settled = false;
    const fail = err => { if (!settled) { settled = true; client.end(); reject(new Error(hostError || friendlyError(err, target))); } };

    client.on('ready', () => {
      // Anmeldung hat geklappt -> neu eingegebenes Passwort merken, falls gewünscht
      if (spec.name && auth.pending != null) writePassword(spec.name, auth.pending);
      client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) return fail(err);
        sessions.set(tabId, { client, stream, hostName: spec.name || null });
        tunnels.onConnected(tabId);
        stream.on('data', d => win && !win.isDestroyed() && win.webContents.send('ssh:data', tabId, d));
        stream.stderr.on('data', d => win && !win.isDestroyed() && win.webContents.send('ssh:data', tabId, d));
        stream.on('close', () => {
          if (sessions.get(tabId)?.client === client) sessions.delete(tabId);
          client.end();
          if (win && !win.isDestroyed()) win.webContents.send('ssh:closed', tabId);
        });
        settled = true;
        resolve({ user: target.user, host: target.host, port: target.port });
      });
    });
    client.on('error', fail);
    client.on('close', () => fail(new Error('Verbindung geschlossen')));

    client.connect({
      host: target.host,
      port: target.port,
      username: target.user,
      readyTimeout: 20000,
      keepaliveInterval: 30000,
      hostVerifier: (rawKey, verify) => {
        verifyHostKey(target, rawKey).then(r => {
          if (!r.ok) hostError = r.error;
          verify(r.ok);
        });
      },
      authHandler: makeAuthHandler(target, spec.name || null, auth),
    });
  });
});

function closeSession(tabId) {
  stopSearch(tabId);
  tunnels.stopAll(tabId);
  transfers.cancelTab(tabId);
  const s = sessions.get(tabId);
  if (s) { sessions.delete(tabId); s.client.end(); }
}

ipcMain.on('ssh:write', (_e, tabId, data) => sessions.get(tabId)?.stream.write(data));
ipcMain.on('ssh:resize', (_e, tabId, cols, rows) => sessions.get(tabId)?.stream.setWindow(rows, cols, 0, 0));
ipcMain.on('ssh:close', (_e, tabId) => closeSession(tabId));

// ---------- Dateien (SFTP) ----------

const posix = path.posix;
// Callback-Funktion in Promise verwandeln
const p = fn => new Promise((res, rej) => fn((e, r) => e ? rej(e) : res(r)));

function getSftp(tabId) {
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
      return { name: item.filename, isDir, isLink, size: a.size, mtime: a.mtime * 1000, mode: modeString(a.mode, isDir, isLink) };
    }));
    entries.sort((x, y) => (y.isDir - x.isDir) || x.name.localeCompare(y.name, 'de', { sensitivity: 'base' }));
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
  const job = transfers.start(tabId, 'upload', localPaths.length === 1 ? path.basename(localPaths[0]) : `${localPaths.length} Elemente`);
  job.setTotal(transfers.localSize(localPaths));
  for (const local of localPaths) {
    try { await uploadPath(job, sftp, local, remoteDir); } catch (err) { job.finish(err); throw sftpError(err, path.basename(local)); }
  }
  job.finish();
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
    await job.copy('get', sftp, remote, local, posix.basename(remote));
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
  const job = transfers.start(tabId, 'download', items.length === 1 ? posix.basename(items[0].path) : `${items.length} Elemente`);
  job.setTotal(await transfers.remoteSize(sftp, items.map(it => it.path)));
  for (let i = 0; i < items.length; i++) {
    try { await downloadPath(job, sftp, items[i].path, targets[i]); } catch (err) { job.finish(err); throw sftpError(err, posix.basename(items[i].path)); }
  }
  job.finish();
  return targets;
});

ipcMain.on('show-file', (_e, file) => shell.showItemInFolder(file));
ipcMain.on('transfer:cancel', (_e, jobId) => transfers.cancel(jobId));

// Editor, Vorschau, Rechte, ZIP (app/lib/sftp-extra.js)
sftpExtra.register({
  ipcMain, getSftp, sftpError,
  getClient: tabId => {
    const s = sessions.get(tabId);
    if (!s) throw new Error('Keine aktive Verbindung in diesem Tab.');
    return s.client;
  },
});

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
  if (!s) throw new Error('Keine aktive Verbindung in diesem Tab.');
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
    try { done = await searchWithFind(s.client, root, query, state, add); } catch {}
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
  if (oldName && oldName !== name) { delete hosts[oldName]; renamePassword(oldName, name); }
  hosts[name] = { ...prev, user: host.user || os.userInfo().username, host: host.host, port: Number(host.port) || 22, key: host.key || null };
  saveHosts(hosts);
  if (host.forgetPassword) removePassword(name);
  if (host.password) {
    if (!writePassword(name, host.password)) throw new Error('Passwort konnte nicht verschlüsselt gespeichert werden (Schlüsselbund nicht verfügbar).');
  }
  return hostsForUi();
});
ipcMain.handle('hosts:delete', (_e, name) => {
  const hosts = loadHosts();
  delete hosts[name];
  saveHosts(hosts);
  removePassword(name);
  return hostsForUi();
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
setupUpdateCheck({ ipcMain, shell, app, configDir: CONFIG_DIR });

// ---------- Fenster ----------

function titleBarColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#0f0f11' : '#f7f7f8', symbolColor: dark ? '#ededef' : '#18181b', height: 40 };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 700, minWidth: 700, minHeight: 400,
    title: 'S3cure SSH Client',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0f11' : '#f7f7f8',
    // macOS: Ampelknöpfe im Fenster; Windows: eigene Titelleiste mit Windows-Knöpfen oben rechts
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: titleBarColors() }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  // Links aus dem Terminal im normalen Browser öffnen, nicht in der App
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { for (const id of [...sessions.keys()]) closeSession(id); win = null; });
}

// Einstellungen und Terminal-Extras (eigene Dateien in lib/)
require('./lib/settings').register({ app, ipcMain, nativeTheme, configDir: CONFIG_DIR });
require('./lib/term-extra').register({ app, ipcMain, dialog, shell, sessions, getWin: () => win, platform: PLATFORM });

app.setName('S3cure SSH Client');
app.whenReady().then(() => {
  // Windows: keine Menüleiste (Kopieren/Einfügen in Feldern geht trotzdem)
  if (!IS_MAC) Menu.setApplicationMenu(null);
  createWindow();
  nativeTheme.on('updated', () => { if (!IS_MAC && win && !win.isDestroyed()) win.setTitleBarOverlay(titleBarColors()); });
});
app.on('window-all-closed', () => app.quit());
