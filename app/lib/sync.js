// Automatischer Abgleich über einen Cloud-Ordner (iCloud Drive, OneDrive, Dropbox …)
//
// Im gewählten Ordner liegt „S3cure-Abgleich.s3cure-backup“ – eine ganz normale, verschlüsselte
// Backup-Datei (lib/backup.js), die zusätzlich pro Eintrag die Änderungszeit kennt (payload.sync.items).
// Abgeglichen werden Verbindungen, Befehlsknöpfe, Lesezeichen, bekannte Host-Schlüssel und – nur mit
// Häkchen – gespeicherte Passwörter/Passphrasen. Einstellungen bleiben pro Computer.
//
// Zusammenführen pro Eintrag (z. B. eine Verbindung):
//   - Jede lokale Änderung bekommt einen Zeitstempel (lokaler Zustand: ~/.myssh/sync-state.json).
//   - Gelöschte Einträge werden als „gelöscht“ mit Zeitstempel vermerkt, damit sie nicht wiederkommen.
//   - Die jüngere Änderung gewinnt. Wurde derselbe Eintrag auf beiden Computern seit dem letzten Abgleich
//     geändert, zählt er als Konflikt (die neuere Version wird übernommen und im Status genannt).
//   - Beim allerersten Abgleich gewinnt bei Unterschieden die Cloud-Datei, nur hier vorhandene Einträge kommen dazu.
//   - Konfliktkopien des Cloud-Dienstes („S3cure-Abgleich 2.s3cure-backup“) werden mit eingemischt.
// Das Passwort der Abgleich-Datei liegt verschlüsselt im Schlüsselbund (safeStorage).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const backup = require('./backup');
const { createSecretStore } = require('./secrets');

const FILE_NAME = 'S3cure-Abgleich.s3cure-backup';
const COPY_RE = /^S3cure-Abgleich[ _-]?(\(\d+\)|\d+|.*[Kk]onflikt.*|.*conflict.*)\.s3cure-backup$/;
const CHECK_EVERY = 60 * 1000;            // Änderungen prüfen (nur Dateizeiten, sehr günstig)
const TOMBSTONE_DAYS = 180;               // so lange werden Löschungen gemerkt
const SECRET_KEY = /^p[wp]:/;

// Einträge aus den Backup-Daten: Schlüssel -> Wert
function itemsFromPayload(p) {
  const b = backup.cleanPayload(p);
  const items = {};
  for (const [n, h] of Object.entries(b.hosts)) items['host:' + n] = h;
  for (const [k, v] of Object.entries(b.profiles)) items['snip:' + k] = v;
  for (const l of b.knownHosts) items['kh:' + l] = true;
  if (b.bookmarks !== undefined) items.bm = b.bookmarks;
  if (b.secrets) {
    for (const [n, v] of Object.entries(b.secrets.passwords)) items['pw:' + n] = v;
    for (const [k, v] of Object.entries(b.secrets.passphrases)) items['pp:' + k] = v;
  }
  return items;
}

// Umkehrung: Einträge -> Backup-Daten (importierbar wie ein normales Backup)
function payloadFromItems(items, meta, withSecrets) {
  const p = {
    kind: 's3cure-backup-daten', version: 1, created: new Date().toISOString(), platform: process.platform,
    hosts: {}, snippets: { profiles: {} }, knownHosts: [], settings: {}, secrets: withSecrets ? { passwords: {}, passphrases: {} } : null,
  };
  for (const [k, v] of Object.entries(items)) {
    if (k.startsWith('host:')) p.hosts[k.slice(5)] = v;
    else if (k.startsWith('snip:')) p.snippets.profiles[k.slice(5)] = v;
    else if (k.startsWith('kh:')) p.knownHosts.push(k.slice(3));
    else if (k === 'bm') p.bookmarks = v;
    else if (withSecrets && k.startsWith('pw:')) p.secrets.passwords[k.slice(3)] = v;
    else if (withSecrets && k.startsWith('pp:')) p.secrets.passphrases[k.slice(3)] = v;
  }
  p.sync = meta;
  return p;
}

// Lesbarer Name eines Eintrags für Statusmeldungen
function label(k) {
  if (k.startsWith('host:')) return `Verbindung „${k.slice(5)}“`;
  if (k.startsWith('snip:')) return `Befehlsknöpfe von „${k.slice(5)}“`;
  if (k.startsWith('pw:')) return `Passwort von „${k.slice(3)}“`;
  if (k.startsWith('pp:')) return 'Schlüssel-Passphrase';
  if (k === 'bm') return 'Lesezeichen';
  return 'Host-Schlüssel';
}

// Vorschlag für den Ordner-Dialog
function suggestFolder(platform) {
  const home = os.homedir();
  const cands = platform === 'darwin'
    ? [path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), path.join(home, 'Library', 'CloudStorage')]
    : [process.env.OneDrive, process.env.OneDriveConsumer, path.join(home, 'OneDrive'), path.join(home, 'Dropbox')];
  return cands.find(p => p && fs.existsSync(p)) || path.join(home, 'Documents');
}

function create({ configDir, data, send = () => {}, platform = process.platform }) {
  const cfgFile = path.join(configDir, 'sync.json');
  const stateFile = path.join(configDir, 'sync-state.json');
  const secrets = createSecretStore(path.join(configDir, 'sync-secret.json'));
  const readJson = f => { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; } };

  let cfg = { enabled: false, folder: null, secrets: false, ...(readJson(cfgFile) || {}) };
  let memPassword = null;   // falls kein Schlüsselbund verfügbar ist: nur bis zum Beenden
  let keyCache = null;      // { key, kdf } – scrypt nur einmal pro Salz
  let running = null;
  let again = false;
  let lastSig = null;
  let status = { lastSync: null, lastError: null, conflicts: [], applied: 0, waiting: null };
  let timer = null;
  let watcher = null;
  let watchTimer = null;

  const saveCfg = () => backup.writeAtomic(cfgFile, JSON.stringify(cfg, null, 2));
  const loadState = () => readJson(stateFile) || {};
  const saveState = st => backup.writeAtomic(stateFile, JSON.stringify(st));
  const remoteFile = () => path.join(cfg.folder, FILE_NAME);

  function getPassword() {
    return memPassword || secrets.read('password');
  }

  function hmacKey(st) {
    let k = secrets.read('hmac');
    if (!k) { k = crypto.randomBytes(32).toString('base64'); if (!secrets.write('hmac', k)) k = st.salt; }
    return k;
  }

  // Signatur aus Dateizeiten: hat sich lokal oder in der Cloud etwas geändert?
  function signature() {
    const files = ['hosts.json', 'snippets.json', 'known_hosts', 'bookmarks.json', 'passwords.json', 'passphrases.json'].map(n => path.join(configDir, n));
    if (cfg.folder) files.push(remoteFile());
    return files.map(f => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } }).join('|');
  }

  function publicStatus() {
    return {
      enabled: !!cfg.enabled, folder: cfg.folder, fileName: FILE_NAME, secrets: !!cfg.secrets,
      passwordStored: !!secrets.read('password'), running: !!running, ...status,
    };
  }
  const emit = () => send('sync:status', publicStatus());

  function localItems(withSecrets) {
    const items = {};
    for (const [n, h] of Object.entries(data.hosts())) items['host:' + n] = h;
    for (const [k, v] of Object.entries(data.snippets())) items['snip:' + k] = v;
    for (const l of data.knownHosts()) items['kh:' + l] = true;
    const bm = data.bookmarks();
    if (bm !== undefined) items.bm = bm;
    if (withSecrets) {
      for (const [n, v] of Object.entries(data.passwords().values)) items['pw:' + n] = v;
      for (const [k, v] of Object.entries(data.passphrases().values)) items['pp:' + k] = v;
    }
    return items;
  }

  // Lokale Änderungen schreiben (gesammelt pro Datei)
  function applyLocal(changes) {
    if (!changes.length) return;
    let hosts = null, prof = null, kh = null;
    for (const { k, v, del } of changes) {
      if (k.startsWith('host:')) { hosts = hosts || data.hosts(); if (del) delete hosts[k.slice(5)]; else hosts[k.slice(5)] = v; }
      else if (k.startsWith('snip:')) { prof = prof || data.snippets(); if (del) delete prof[k.slice(5)]; else prof[k.slice(5)] = v; }
      else if (k.startsWith('kh:')) { kh = kh || new Set(data.knownHosts()); if (del) kh.delete(k.slice(3)); else kh.add(k.slice(3)); }
      else if (k === 'bm') { if (!del) data.saveBookmarks(v); }
      else if (k.startsWith('pw:')) { if (del) data.removePassword(k.slice(3)); else data.writePassword(k.slice(3), v); }
      else if (k.startsWith('pp:')) { if (del) data.removePassphrase(k.slice(3)); else data.writePassphrase(k.slice(3), v); }
    }
    if (hosts) data.saveHosts(hosts);
    if (prof) data.saveSnippets(prof);
    if (kh) data.saveKnownHosts([...kh]);
  }

  async function readRemote(file, password) {
    const { payload, key } = await backup.decrypt(fs.readFileSync(file, 'utf8'), password, keyCache);
    const values = itemsFromPayload(payload);
    const meta = payload.sync && typeof payload.sync.items === 'object' ? payload.sync.items : {};
    const out = {};
    for (const [k, v] of Object.entries(values)) out[k] = { v, t: Number(meta[k]?.t) || 0, d: false };
    for (const [k, m] of Object.entries(meta)) if (m && m.d && !(k in out)) out[k] = { t: Number(m.t) || 0, d: true };
    return { items: out, key };
  }

  async function runOnce() {
    if (!cfg.enabled || !cfg.folder) return;
    const password = getPassword();
    if (!password) throw new backup.BackupError('Das Passwort für den Abgleich fehlt (Schlüsselbund). Bitte den Abgleich neu einrichten.');
    if (!fs.existsSync(cfg.folder)) throw new backup.BackupError(`Der Ordner „${cfg.folder}“ ist gerade nicht erreichbar.`);
    const file = remoteFile();
    // iCloud: Datei liegt nur als Platzhalter vor und wird noch geladen -> nichts überschreiben
    if (!fs.existsSync(file) && fs.existsSync(path.join(cfg.folder, `.${FILE_NAME}.icloud`))) {
      status.waiting = 'Die Abgleich-Datei wird noch aus iCloud geladen …';
      return;
    }
    status.waiting = null;

    const now = Date.now();
    const st = loadState();
    if (!st.salt) st.salt = crypto.randomBytes(16).toString('base64');
    const first = !st.lastSync;
    const known = st.items || {};
    const hk = hmacKey(st);
    const hash = (k, v) => crypto.createHmac('sha256', SECRET_KEY.test(k) ? hk : st.salt).update(JSON.stringify(v)).digest('base64').slice(0, 22);
    const relevant = k => cfg.secrets || !SECRET_KEY.test(k);

    // 1. Lokale Änderungen seit dem letzten Mal mit Zeitstempel versehen
    const local = localItems(cfg.secrets);
    const L = {};
    for (const [k, v] of Object.entries(local)) {
      const h = hash(k, v);
      const s = known[k];
      L[k] = s && !s.d && s.h === h ? { v, h, t: s.t, d: false } : { v, h, t: first && !s ? 0 : now, d: false };
    }
    for (const [k, s] of Object.entries(known)) {
      if (!(k in L) && relevant(k)) L[k] = s.d ? { t: s.t, d: true } : { t: now, d: true };
    }

    // 2. Cloud-Datei (und Konfliktkopien des Cloud-Dienstes) lesen
    let R = {};
    let remoteExists = false;
    if (fs.existsSync(file)) {
      const r = await readRemote(file, password); // falsches Passwort -> Fehler
      keyCache = r.key;
      R = r.items;
      remoteExists = true;
    }
    const copies = [];
    for (const name of fs.readdirSync(cfg.folder)) {
      if (!COPY_RE.test(name)) continue;
      try {
        const r = await readRemote(path.join(cfg.folder, name), password);
        for (const [k, m] of Object.entries(r.items)) if (!R[k] || m.t > R[k].t) R[k] = m;
        copies.push(name);
      } catch { /* anderes Passwort oder beschädigt: liegen lassen */ }
    }

    // 3. Pro Eintrag die jüngere Version nehmen
    const lastSync = st.lastSync || 0;
    const merged = {};
    const conflicts = [];
    for (const k of new Set([...Object.keys(L), ...Object.keys(R)])) {
      const l = L[k], r = R[k];
      if (!relevant(k)) { if (r) merged[k] = r; continue; } // fremde Passwörter in der Datei nicht verlieren
      if (!r) merged[k] = l;
      else if (!l) merged[k] = r;
      else if (l.d && r.d) merged[k] = l.t >= r.t ? l : r;
      else if (!l.d && !r.d && hash(k, l.v) === hash(k, r.v)) merged[k] = { ...l, t: Math.max(l.t, r.t) };
      else {
        merged[k] = l.t > r.t ? l : r; // Gleichstand (z. B. erster Abgleich): Cloud gewinnt
        if (l.t > lastSync && r.t > lastSync && !first) conflicts.push(k);
      }
    }

    // 4. Hier anwenden, was sich geändert hat
    const changes = [];
    for (const [k, m] of Object.entries(merged)) {
      if (!relevant(k)) continue;
      const has = k in local;
      if (m.d && has) changes.push({ k, del: true });
      else if (!m.d && (!has || hash(k, local[k]) !== hash(k, m.v))) changes.push({ k, v: m.v });
    }
    applyLocal(changes);

    // 5. Cloud-Datei schreiben, wenn sie nicht schon genau so aussieht
    const cutoff = now - TOMBSTONE_DAYS * 864e5;
    const meta = {};
    const values = {};
    for (const [k, m] of Object.entries(merged)) {
      if (m.d) { if (m.t >= cutoff) meta[k] = { t: m.t, d: true }; continue; }
      values[k] = m.v;
      meta[k] = { t: m.t };
    }
    const differs = !remoteExists || copies.length || Object.keys(merged).some(k => !R[k] || R[k].t !== merged[k].t || R[k].d !== merged[k].d)
      || Object.keys(R).some(k => !merged[k]);
    if (differs) {
      const withSecrets = Object.keys(values).some(k => SECRET_KEY.test(k)) || cfg.secrets;
      if (!keyCache) keyCache = await backup.deriveKey(password);
      const text = backup.encryptWithKey(payloadFromItems(values, { items: meta, written: new Date(now).toISOString() }, withSecrets), keyCache);
      const tmp = path.join(cfg.folder, `.${FILE_NAME}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, file);
      for (const name of copies) { try { fs.unlinkSync(path.join(cfg.folder, name)); } catch {} } // eingemischt
    }

    // 6. Zustand merken
    st.items = {};
    for (const [k, m] of Object.entries(merged)) {
      if (!relevant(k)) continue;
      if (m.d) { if (m.t >= cutoff) st.items[k] = { t: m.t, d: true }; }
      else st.items[k] = { h: hash(k, m.v), t: m.t };
    }
    st.lastSync = now;
    saveState(st);
    status.lastSync = new Date(now).toISOString();
    status.applied = changes.length;
    status.conflicts = conflicts.map(label);
    if (changes.length) {
      send('backup:changed', {
        hosts: changes.some(c => c.k.startsWith('host:') || c.k.startsWith('pw:')),
        snippets: changes.some(c => c.k.startsWith('snip:')),
        source: 'sync',
      });
    }
  }

  // Nie zwei Abgleiche gleichzeitig; Anfragen währenddessen werden danach nachgeholt
  async function sync() {
    if (running) { again = true; return running; }
    running = (async () => {
      emit();
      do {
        again = false;
        try {
          await runOnce();
          status.lastError = null;
        } catch (err) {
          status.lastError = err instanceof backup.BackupError ? err.message : 'Abgleich fehlgeschlagen: ' + (err && err.message || err);
          if (/Falsches Passwort/.test(status.lastError)) status.lastError = 'Das gespeicherte Passwort passt nicht (mehr) zur Abgleich-Datei. Bitte den Abgleich neu einrichten.';
        }
        lastSig = signature();
      } while (again);
    })();
    try { await running; } finally { running = null; emit(); }
    return publicStatus();
  }

  function check() {
    if (!cfg.enabled || running) return;
    if (signature() !== lastSig) sync();
  }

  function startWatching() {
    stopWatching();
    if (!cfg.enabled) return;
    timer = setInterval(check, CHECK_EVERY);
    // Lokale Änderungen (Verbindung gespeichert …) nach kurzer Pause hochladen
    try {
      watcher = fs.watch(configDir, () => { clearTimeout(watchTimer); watchTimer = setTimeout(check, 3000); });
      watcher.on('error', () => {});
    } catch { /* ohne Beobachten reicht die Minuten-Prüfung */ }
  }
  function stopWatching() {
    clearInterval(timer); timer = null;
    clearTimeout(watchTimer);
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  }

  return {
    status: publicStatus,
    sync,
    suggestFolder: () => (cfg.folder && fs.existsSync(cfg.folder) ? cfg.folder : suggestFolder(platform)),
    folderInfo: folder => ({ folder, exists: fs.existsSync(path.join(folder, FILE_NAME)) }),

    async enable({ folder, password, secrets: withSecrets }) {
      if (!folder || !fs.existsSync(folder)) throw new backup.BackupError('Bitte einen vorhandenen Ordner wählen.');
      password = String(password || '');
      const file = path.join(folder, FILE_NAME);
      keyCache = null;
      if (fs.existsSync(file)) {
        // Vorhandene Datei (vom anderen Computer): Passwort muss passen
        const r = await readRemote(file, password).catch(err => {
          throw new backup.BackupError(/Falsches Passwort/.test(err.message) ? 'Das Passwort passt nicht zur vorhandenen Abgleich-Datei in diesem Ordner.' : err.message);
        });
        keyCache = r.key;
      } else if (password.length < backup.MIN_PASSWORD) {
        throw new backup.BackupError(`Das Passwort muss mindestens ${backup.MIN_PASSWORD} Zeichen haben.`);
      }
      memPassword = secrets.write('password', password) ? null : password;
      if (cfg.folder !== folder) { try { fs.unlinkSync(stateFile); } catch {} } // neuer Ordner = erster Abgleich
      cfg = { ...cfg, enabled: true, folder, secrets: !!withSecrets };
      saveCfg();
      startWatching();
      return sync();
    },

    disable() {
      stopWatching();
      cfg = { ...cfg, enabled: false };
      saveCfg();
      secrets.remove('password');
      memPassword = null;
      keyCache = null;
      try { fs.unlinkSync(stateFile); } catch {} // beim Wieder-Einschalten frisch zusammenführen
      status = { lastSync: null, lastError: null, conflicts: [], applied: 0, waiting: null };
      emit();
      return publicStatus();
    },

    async setSecrets(on) {
      cfg = { ...cfg, secrets: !!on };
      saveCfg();
      return cfg.enabled ? sync() : publicStatus();
    },

    start() {
      if (!cfg.enabled) return;
      startWatching();
      setTimeout(() => sync(), 3000);
    },
  };
}

function register({ ipcMain, dialog, getWin, send, configDir, data, platform }) {
  const s = create({ configDir, data, send, platform });
  const wrap = fn => async (...args) => {
    try { return await fn(...args); } catch (err) { throw new Error(err instanceof backup.BackupError ? err.message : String(err && err.message || err)); }
  };
  ipcMain.handle('sync:status', () => s.status());
  ipcMain.handle('sync:pick-folder', wrap(async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: 'Ordner für den Abgleich wählen', buttonLabel: 'Diesen Ordner nehmen',
      defaultPath: s.suggestFolder(), properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths[0] ? null : s.folderInfo(r.filePaths[0]);
  }));
  ipcMain.handle('sync:enable', wrap((_e, opts) => s.enable(opts || {})));
  ipcMain.handle('sync:disable', wrap(() => s.disable()));
  ipcMain.handle('sync:now', wrap(() => s.sync()));
  ipcMain.handle('sync:secrets', wrap((_e, on) => s.setSecrets(on)));
  return s;
}

module.exports = { register, create, itemsFromPayload, payloadFromItems, FILE_NAME };
// „Ordner synchronisieren“ und „Server-Ordner aktuell halten“ (wie WinSCP)
// Oberfläche: src/sync.js. Vergleichslogik ohne Dateizugriff: lib/sync-core.js.
//
// sync:compare  lokalen und Server-Ordner rekursiv einlesen und vergleichen (optional Prüfsumme)
// sync:run      ausgewählte Einträge übertragen/löschen – über die Übertragungsliste (lib/transfers.js)
// watch:*       lokalen Ordner beobachten und Änderungen automatisch hochladen
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const core = require('./sync-core');
const { checkPath, friendly } = require('./localfs');

const posix = path.posix;
const p = fn => new Promise((res, rej) => fn((e, r) => e ? rej(e) : res(r)));
const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

const MAX_ENTRIES = 100000;         // mehr Einträge pro Seite -> Abbruch mit Hinweis
const WATCH_DEBOUNCE = 800;         // ms Ruhe nach der letzten Änderung, dann hochladen
const WATCH_POLL = 2500;            // ms zwischen zwei Durchläufen, wenn fs.watch nicht geht
const WATCH_RETRY = 5000;           // ms bis zum nächsten Versuch nach einem Fehler
const MAX_WATCHES = 10;

const T = {
  tooMany: n => `Zu viele Dateien (mehr als ${n.toLocaleString('de-DE')}). Bitte einen kleineren Ordner wählen oder mehr ausschließen.`,
  cancelled: 'Vergleich abgebrochen.',
  badRemote: 'Ungültiger Ordner auf dem Server.',
  badLocal: 'Den Ordner auf diesem Computer gibt es nicht (mehr).',
  badRel: 'Ungültiger Eintrag in der Liste.',
  syncTitle: name => `Synchronisieren: ${name}`,
  watchTitle: name => `Aktuell halten: ${name}`,
  watchLimit: `Es können höchstens ${MAX_WATCHES} Ordner gleichzeitig beobachtet werden.`,
  watchSame: 'Dieser Ordner wird schon beobachtet.',
  offline: 'Keine Verbindung – Änderungen werden nachgeholt, sobald der Server wieder da ist.',
  errors: n => `${n} Fehler`,
};

// ---------- Ordner einlesen ----------

// Lokal: Map rel -> { isDir, size, mtime }. Symbolische Links auf Ordner werden nicht verfolgt (keine Schleifen).
async function walkLocal(root, matcher, state) {
  const out = new Map();
  const queue = [''];
  while (queue.length) {
    if (state && state.cancelled) throw new Error(T.cancelled);
    const rel = queue.shift();
    const abs = rel ? path.join(root, ...rel.split('/')) : root;
    let dirents;
    try { dirents = await fsp.readdir(abs, { withFileTypes: true }); } catch (err) { if (!rel) throw friendly(err, abs); continue; }
    for (const d of dirents) {
      if (d.name.includes('/')) continue;
      const childRel = rel ? rel + '/' + d.name : d.name;
      let st;
      try { st = d.isSymbolicLink() ? await fsp.stat(path.join(abs, d.name)) : await fsp.lstat(path.join(abs, d.name)); } catch { continue; }
      const isDir = st.isDirectory();
      if (d.isSymbolicLink() && isDir) continue;
      if (!isDir && !st.isFile()) continue;
      if (matcher(childRel, isDir)) continue;
      out.set(childRel, { isDir, size: isDir ? 0 : st.size, mtime: Math.floor(st.mtimeMs) });
      if (out.size > MAX_ENTRIES) throw new Error(T.tooMany(MAX_ENTRIES));
      if (isDir) queue.push(childRel);
    }
    if (state && state.progress) state.progress(out.size);
  }
  return out;
}

// Server: dasselbe per SFTP, mehrere Ordner gleichzeitig
async function walkRemote(sftp, root, matcher, state) {
  const out = new Map();
  const queue = [''];
  let active = 0;
  let failure = null;
  const worker = async () => {
    while (!failure) {
      if (state && state.cancelled) { failure = new Error(T.cancelled); return; }
      const rel = queue.shift();
      if (rel === undefined) {
        if (active === 0) return;
        await new Promise(r => setTimeout(r, 10));
        continue;
      }
      active++;
      try {
        const abs = rel ? posix.join(root, rel) : root;
        let list;
        try { list = await p(cb => sftp.readdir(abs, cb)); } catch (err) { if (!rel) throw err; continue; }
        for (const it of list) {
          const name = it.filename;
          if (!name || name === '.' || name === '..' || name.includes('/')) continue;
          const childRel = rel ? rel + '/' + name : name;
          let a = it.attrs;
          if (a.isSymbolicLink()) {
            try { a = await p(cb => sftp.stat(posix.join(abs, name), cb)); } catch { continue; }
            if (a.isDirectory()) continue; // Links auf Ordner nicht verfolgen
          }
          const isDir = a.isDirectory();
          if (!isDir && !a.isFile()) continue;
          if (matcher(childRel, isDir)) continue;
          out.set(childRel, { isDir, size: isDir ? 0 : a.size, mtime: a.mtime * 1000 });
          if (out.size > MAX_ENTRIES) throw new Error(T.tooMany(MAX_ENTRIES));
          if (isDir) queue.push(childRel);
        }
        if (state && state.progress) state.progress(out.size);
      } catch (err) { failure = failure || err; }
      finally { active--; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (failure) throw failure;
  return out;
}

// ---------- Prüfsummen ----------

function hashLocal(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

function hashRemoteSftp(sftp, file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    sftp.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

// sha256sum auf dem Server (schnell). Liefert Map rel -> hash oder null, wenn der Befehl fehlt.
function hashRemoteExec(client, root, rels) {
  return new Promise(resolve => {
    const cmd = `cd ${shQuote(root)} && (sha256sum -- ${rels.map(shQuote).join(' ')} || true) 2>/dev/null`;
    client.exec(cmd, (err, stream) => {
      if (err) return resolve(null);
      let out = '';
      let code = null;
      stream.on('data', d => { out += d.toString('utf8'); });
      stream.stderr.on('data', () => {});
      stream.on('exit', c => { code = c; });
      stream.on('close', () => {
        const map = new Map();
        for (const line of out.split('\n')) {
          const m = /^(\\?)([0-9a-f]{64}) [ *](.*)$/.exec(line);
          if (!m) continue;
          let name = m[3];
          if (m[1]) name = name.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c)); // GNU-Escape
          map.set(name, m[2]);
        }
        resolve(map.size || code === 0 ? map : null);
      });
    });
  });
}

// ---------- Hilfen fürs Übertragen ----------

async function remoteMkdirp(sftp, dir, made) {
  if (dir === '/' || made.has(dir)) return;
  const st = await p(cb => sftp.stat(dir, cb)).catch(() => null);
  if (st) { if (!st.isDirectory()) throw new Error(`„${dir}“ ist auf dem Server eine Datei, kein Ordner.`); made.add(dir); return; }
  await remoteMkdirp(sftp, posix.dirname(dir), made);
  await p(cb => sftp.mkdir(dir, cb)).catch(async err => {
    const again = await p(cb => sftp.stat(dir, cb)).catch(() => null); // gleichzeitig angelegt?
    if (!again) throw err;
  });
  made.add(dir);
}

async function removeRemote(sftp, remote) {
  const st = await p(cb => sftp.lstat(remote, cb));
  if (st.isDirectory()) {
    for (const it of await p(cb => sftp.readdir(remote, cb))) await removeRemote(sftp, posix.join(remote, it.filename));
    await p(cb => sftp.rmdir(remote, cb));
  } else await p(cb => sftp.unlink(remote, cb));
}

const toLocal = (root, rel) => path.join(root, ...rel.split('/'));
const toRemote = (root, rel) => posix.join(root, rel);
const checkRemoteRoot = r => {
  if (typeof r !== 'string' || !r.startsWith('/') || r.includes('\0')) throw new Error(T.badRemote);
  return posix.normalize(r);
};

// Eine Datei hochladen und die Änderungszeit mitnehmen (sonst gilt sie beim nächsten Vergleich als „neuer“)
async function putFile(job, sftp, local, remote, made) {
  const st = await fsp.stat(local);
  await remoteMkdirp(sftp, posix.dirname(remote), made);
  await job.copy('put', sftp, local, remote, posix.basename(remote));
  const t = Math.floor(st.mtimeMs / 1000);
  await p(cb => sftp.utimes(remote, t, t, cb)).catch(() => {});
  return st;
}

async function getFile(job, sftp, remote, local) {
  const st = await p(cb => sftp.stat(remote, cb));
  await fsp.mkdir(path.dirname(local), { recursive: true });
  await job.copy('get', sftp, remote, local, posix.basename(remote));
  await fsp.utimes(local, st.atime || st.mtime, st.mtime).catch(() => {});
}

// ---------- Registrieren ----------

function register({ ipcMain, shell, getSftp, getClient, sftpError, transfers, getWin }) {
  const send = (channel, ...args) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(channel, ...args); };
  const compares = new Map(); // compareId -> Zustand (zum Abbrechen)
  const clean = err => (typeof err?.code === 'string' ? friendly(err) : sftpError(err));

  ipcMain.on('sync:cancel', (_e, compareId) => { const st = compares.get(compareId); if (st) st.cancelled = true; });

  // opts: { localRoot, remoteRoot, excludes: [..], checksum: bool, compareId }
  ipcMain.handle('sync:compare', async (_e, tabId, opts = {}) => {
    const localRoot = checkPath(opts.localRoot);
    const remoteRoot = checkRemoteRoot(opts.remoteRoot);
    const lst = await fsp.stat(localRoot).catch(() => null);
    if (!lst || !lst.isDirectory()) throw new Error(T.badLocal);
    const sftp = await getSftp(tabId);
    const matcher = core.makeMatcher(core.parsePatterns(opts.excludes || core.DEFAULT_EXCLUDES));
    const id = String(opts.compareId || crypto.randomUUID());
    const counts = { local: 0, remote: 0 };
    let last = 0;
    const report = (phase, extra = {}) => {
      const now = Date.now();
      if (now - last < 150 && !extra.force) return;
      last = now;
      send('sync:progress', { compareId: id, phase, ...counts, ...extra });
    };
    const state = { cancelled: false };
    compares.set(id, state);
    try {
      const [local, remote] = await Promise.all([
        walkLocal(localRoot, matcher, watchState(state, n => { counts.local = n; report('scan'); })),
        walkRemote(sftp, remoteRoot, matcher, watchState(state, n => { counts.remote = n; report('scan'); })),
      ]);
      let hashes = null;
      let hashInfo = null;
      if (opts.checksum) {
        hashes = new Map();
        const rels = core.hashCandidates(local, remote);
        hashInfo = { files: rels.length, method: 'exec' };
        // Server: sha256sum in Päckchen; geht das nicht, per SFTP lesen (langsamer)
        let client = null;
        try { client = getClient(tabId); } catch {}
        for (let i = 0; i < rels.length; i += 200) {
          if (state.cancelled) throw new Error(T.cancelled);
          const chunk = rels.slice(i, i + 200);
          const map = client && hashInfo.method === 'exec' ? await hashRemoteExec(client, remoteRoot, chunk) : null;
          if (!map) hashInfo.method = 'sftp';
          for (const rel of chunk) {
            if (state.cancelled) throw new Error(T.cancelled);
            let r = map ? map.get(rel) : null;
            if (!r && !map) r = await hashRemoteSftp(sftp, toRemote(remoteRoot, rel)).catch(() => null);
            const l = await hashLocal(toLocal(localRoot, rel)).catch(() => null);
            hashes.set(rel, { local: l, remote: r || null });
          }
          report('hash', { hashed: Math.min(rels.length, i + 200), toHash: rels.length, force: true });
        }
      }
      const { items, same } = core.compareTrees(local, remote, hashes);
      // Vorschläge für jede Richtung gleich mitliefern, damit die Oberfläche nur noch umschalten muss
      for (const it of items) {
        it.suggest = {
          up: core.suggest(it, 'up', false), upDel: core.suggest(it, 'up', true),
          down: core.suggest(it, 'down', false), downDel: core.suggest(it, 'down', true),
          both: core.suggest(it, 'both', false),
        };
        it.actions = core.possibleActions(it);
      }
      return {
        localRoot, remoteRoot, items, same, hashInfo,
        localCount: local.size, remoteCount: remote.size,
      };
    } catch (err) {
      throw clean(err);
    } finally {
      compares.delete(id);
    }
  });

  // ops: [{ rel, action: 'upload'|'download'|'deleteRemote'|'deleteLocal', size }]
  ipcMain.handle('sync:run', async (_e, tabId, opts = {}) => {
    const localRoot = checkPath(opts.localRoot);
    const remoteRoot = checkRemoteRoot(opts.remoteRoot);
    const ops = Array.isArray(opts.ops) ? opts.ops : [];
    const ACTIONS = ['upload', 'download', 'deleteRemote', 'deleteLocal'];
    for (const op of ops) if (!core.safeRel(op.rel) || !ACTIONS.includes(op.action)) throw new Error(T.badRel);
    if (!ops.length) return { uploaded: 0, downloaded: 0, deleted: 0, errors: [] };
    const matcher = core.makeMatcher(core.parsePatterns(opts.excludes || core.DEFAULT_EXCLUDES));
    const sftp = await getSftp(tabId);
    const job = transfers.start(tabId, 'sync', T.syncTitle(path.basename(localRoot) || localRoot));
    const res = { uploaded: 0, downloaded: 0, deleted: 0, errors: [] };
    const made = new Set();

    // Ordner rekursiv mit denselben Ausschlüssen wie beim Vergleich
    const uploadTree = async rel => {
      const abs = toLocal(localRoot, rel);
      const st = await fsp.stat(abs);
      if (!st.isDirectory()) { await putFile(job, sftp, abs, toRemote(remoteRoot, rel), made); res.uploaded++; return; }
      await remoteMkdirp(sftp, toRemote(remoteRoot, rel), made);
      const tree = await walkLocal(abs, (r, d) => matcher(rel + '/' + r, d));
      for (const [r, e] of tree) {
        job.check();
        const full = rel + '/' + r;
        if (e.isDir) await remoteMkdirp(sftp, toRemote(remoteRoot, full), made);
        else { await putFile(job, sftp, toLocal(localRoot, full), toRemote(remoteRoot, full), made); res.uploaded++; }
      }
    };
    const downloadTree = async rel => {
      const remote = toRemote(remoteRoot, rel);
      const st = await p(cb => sftp.stat(remote, cb));
      if (!st.isDirectory()) { await getFile(job, sftp, remote, toLocal(localRoot, rel)); res.downloaded++; return; }
      await fsp.mkdir(toLocal(localRoot, rel), { recursive: true });
      const tree = await walkRemote(sftp, remote, (r, d) => matcher(rel + '/' + r, d));
      for (const [r, e] of tree) {
        job.check();
        const full = rel + '/' + r;
        if (e.isDir) await fsp.mkdir(toLocal(localRoot, full), { recursive: true });
        else { await getFile(job, sftp, toRemote(remoteRoot, full), toLocal(localRoot, full)); res.downloaded++; }
      }
    };

    try {
      // Größen stammen aus dem Vergleich (nur für die Fortschrittsanzeige)
      job.setTotal(ops.filter(o => o.action === 'upload' || o.action === 'download').reduce((n, o) => n + (Number(o.size) > 0 ? Number(o.size) : 0), 0));
      // Erst übertragen, zum Schluss löschen
      const order = [...ops].sort((a, b) => (a.action.startsWith('delete') - b.action.startsWith('delete')) || a.rel.localeCompare(b.rel));
      for (const op of order) {
        job.check();
        try {
          if (op.action === 'upload') await uploadTree(op.rel);
          else if (op.action === 'download') await downloadTree(op.rel);
          else if (op.action === 'deleteRemote') { await removeRemote(sftp, toRemote(remoteRoot, op.rel)); res.deleted++; }
          else if (op.action === 'deleteLocal') { await shell.trashItem(toLocal(localRoot, op.rel)); res.deleted++; }
        } catch (err) {
          if (job.cancelled) throw err;
          res.errors.push({ rel: op.rel, error: clean(err).message });
        }
      }
    } catch (err) {
      job.finish(err);
      throw clean(err);
    }
    job.finish(res.errors.length ? new Error(T.errors(res.errors.length) + ': ' + res.errors[0].rel + ' – ' + res.errors[0].error) : null);
    return res;
  });

  // ---------- Server-Ordner aktuell halten ----------

  const watches = new Map(); // id -> Beobachtung

  const publicWatch = w => ({
    id: w.id, tabId: w.tabId, localRoot: w.localRoot, remoteRoot: w.remoteRoot, label: w.label,
    mode: w.mode, started: w.started, lastTransfer: w.lastTransfer, lastFile: w.lastFile, uploads: w.uploads,
    pending: w.pending.size, busy: w.busy, error: w.error,
  });
  const publish = () => send('watch:status', [...watches.values()].map(publicWatch));

  function scheduleFlush(w, delay = WATCH_DEBOUNCE) {
    clearTimeout(w.timer);
    w.timer = setTimeout(() => flush(w), delay);
  }

  // Änderungen gegen den letzten bekannten Stand prüfen und hochladen
  async function flush(w) {
    if (w.stopped) return;
    if (w.busy) { scheduleFlush(w); return; }
    if (!w.pending.size) return;
    w.busy = true;
    const rels = [...w.pending].sort();
    w.pending.clear();
    const todo = []; // { rel, isDir, st }
    for (const rel of rels) {
      if (rel === '') { // ganzer Ordner: neu einlesen und vergleichen
        let tree;
        try { tree = await walkLocal(w.localRoot, w.matcher); } catch { continue; }
        for (const [r, e] of tree) {
          const old = w.snapshot.get(r);
          if (!old || (!e.isDir && (old.size !== e.size || old.mtime !== e.mtime))) todo.push({ rel: r, isDir: e.isDir, st: e });
        }
        for (const r of [...w.snapshot.keys()]) if (!tree.has(r)) w.snapshot.delete(r);
        continue;
      }
      if (!core.safeRel(rel)) continue;
      let st;
      try { st = await fsp.lstat(toLocal(w.localRoot, rel)); } catch { w.snapshot.delete(rel); continue; } // gelöscht: drüben bleibt es
      if (st.isSymbolicLink()) continue;
      const isDir = st.isDirectory();
      if (!isDir && !st.isFile()) continue;
      if (excludedRel(w.matcher, rel, isDir)) continue;
      const e = { isDir, size: isDir ? 0 : st.size, mtime: Math.floor(st.mtimeMs) };
      const old = w.snapshot.get(rel);
      if (isDir) {
        if (!old) {
          todo.push({ rel, isDir: true, st: e });
          // Inhalt eines neuen Ordners (z. B. hineinkopiert)
          try {
            const sub = await walkLocal(toLocal(w.localRoot, rel), (r, d) => w.matcher(rel + '/' + r, d));
            for (const [r, se] of sub) todo.push({ rel: rel + '/' + r, isDir: se.isDir, st: se });
          } catch {}
        }
        continue;
      }
      if (!old || old.size !== e.size || old.mtime !== e.mtime) todo.push({ rel, isDir: false, st: e });
    }
    // doppelte entfernen
    const seen = new Set();
    const list = todo.filter(t => !seen.has(t.rel) && seen.add(t.rel));
    if (!list.length) { w.busy = false; w.error = null; publish(); return; }

    let sftp;
    try { sftp = await getSftp(w.tabId); } catch {
      list.forEach(t => w.pending.add(t.rel));
      w.error = T.offline; w.busy = false; publish();
      scheduleFlush(w, WATCH_RETRY);
      return;
    }
    const files = list.filter(t => !t.isDir);
    const job = transfers.start(w.tabId, 'upload', files.length === 1 ? posix.basename(files[0].rel) : T.watchTitle(`${files.length} Dateien`));
    publish();
    let failed = null;
    try {
      job.setTotal(files.reduce((n, t) => n + t.st.size, 0));
      for (const t of list) {
        if (w.stopped) break;
        job.check();
        try {
          if (t.isDir) await remoteMkdirp(sftp, toRemote(w.remoteRoot, t.rel), w.made);
          else {
            const st = await putFile(job, sftp, toLocal(w.localRoot, t.rel), toRemote(w.remoteRoot, t.rel), w.made);
            t.st = { isDir: false, size: st.size, mtime: Math.floor(st.mtimeMs) };
            w.uploads++;
            w.lastFile = t.rel;
            w.lastTransfer = Date.now();
          }
          w.snapshot.set(t.rel, t.st);
        } catch (err) {
          if (job.cancelled) throw err;
          if (err && err.code === 'ENOENT') continue; // inzwischen gelöscht
          failed = failed || err;
          w.pending.add(t.rel);
        }
      }
    } catch (err) { failed = err; }
    job.finish(failed && !job.cancelled ? clean(failed) : null);
    w.error = failed && !job.cancelled ? clean(failed).message : null;
    if (failed) w.made.clear(); // vielleicht wurde drüben ein Ordner gelöscht
    w.busy = false;
    publish();
    if (w.pending.size && !w.stopped) scheduleFlush(w, failed ? WATCH_RETRY : WATCH_DEBOUNCE);
  }

  function startWatcher(w) {
    try {
      w.watcher = fs.watch(w.localRoot, { recursive: true, persistent: false }, (_ev, filename) => {
        if (w.stopped) return;
        const rel = filename ? String(filename).split(path.sep).join('/') : '';
        w.pending.add(rel);
        scheduleFlush(w);
      });
      w.watcher.on('error', () => { try { w.watcher.close(); } catch {} w.watcher = null; startPolling(w); });
      w.mode = 'watch';
    } catch {
      startPolling(w);
    }
  }

  // Ersatz, wenn das System keine Änderungsmeldungen liefert: regelmäßig vergleichen
  function startPolling(w) {
    if (w.stopped) return;
    w.mode = 'poll';
    clearInterval(w.poll);
    w.poll = setInterval(() => { if (!w.busy) { w.pending.add(''); flush(w); } }, WATCH_POLL);
    publish();
  }

  function stopWatch(id) {
    const w = watches.get(id);
    if (!w) return false;
    w.stopped = true;
    clearTimeout(w.timer);
    clearInterval(w.poll);
    try { w.watcher && w.watcher.close(); } catch {}
    watches.delete(id);
    publish();
    return true;
  }

  // opts: { localRoot, remoteRoot, excludes, label, poll (nur Test) }
  ipcMain.handle('watch:start', async (_e, tabId, opts = {}) => {
    const localRoot = checkPath(opts.localRoot);
    const remoteRoot = checkRemoteRoot(opts.remoteRoot);
    const st = await fsp.stat(localRoot).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error(T.badLocal);
    if (watches.size >= MAX_WATCHES) throw new Error(T.watchLimit);
    for (const w of watches.values()) if (w.tabId === tabId && w.localRoot === localRoot && w.remoteRoot === remoteRoot) throw new Error(T.watchSame);
    await getSftp(tabId); // Verbindung muss stehen
    const matcher = core.makeMatcher(core.parsePatterns(opts.excludes || core.DEFAULT_EXCLUDES));
    const w = {
      id: crypto.randomUUID(), tabId, localRoot, remoteRoot, label: String(opts.label || '').slice(0, 200),
      matcher, snapshot: await walkLocal(localRoot, matcher).catch(err => { throw clean(err); }),
      pending: new Set(), made: new Set(), timer: null, poll: null, watcher: null, mode: null,
      busy: false, stopped: false, started: Date.now(), lastTransfer: null, lastFile: null, uploads: 0, error: null,
    };
    watches.set(w.id, w);
    if (opts.poll || process.env.S3CURE_WATCH_POLL) startPolling(w); else startWatcher(w);
    publish();
    return publicWatch(w);
  });

  ipcMain.handle('watch:stop', (_e, id) => stopWatch(id));
  ipcMain.handle('watch:list', () => [...watches.values()].map(publicWatch));

  // Tab geschlossen -> Beobachtungen dieses Tabs beenden (Neu verbinden behält sie)
  ipcMain.on('ssh:close', (_e, tabId) => { for (const w of [...watches.values()]) if (w.tabId === tabId) stopWatch(w.id); });

  return { stopAll: () => { for (const id of [...watches.keys()]) stopWatch(id); } };
}

// Abbrechen-Zustand teilen und Fortschritt melden
function watchState(state, progress) {
  return { get cancelled() { return state.cancelled; }, progress };
}

// Liegt rel (oder ein übergeordneter Ordner) in den Ausschlüssen?
function excludedRel(matcher, rel, isDir) {
  for (let i = rel.indexOf('/'); i >= 0; i = rel.indexOf('/', i + 1)) if (matcher(rel.slice(0, i), true)) return true;
  return matcher(rel, isDir);
}

module.exports = { register, walkLocal, walkRemote };
