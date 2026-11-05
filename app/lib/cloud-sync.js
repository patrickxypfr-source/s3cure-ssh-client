// lib/cloud-sync.js – Automatischer Abgleich über einen Cloud-Ordner (iCloud Drive, OneDrive, Dropbox …)
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
const { t } = require('./i18n');

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
  if (k.startsWith('host:')) return t('cloudSync.labelHost', { name: k.slice(5) });
  if (k.startsWith('snip:')) return t('cloudSync.labelSnippets', { name: k.slice(5) });
  if (k.startsWith('pw:')) return t('cloudSync.labelPassword', { name: k.slice(3) });
  if (k.startsWith('pp:')) return t('cloudSync.labelPassphrase');
  if (k === 'bm') return t('cloudSync.labelBookmarks');
  return t('cloudSync.labelHostKey');
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
    if (!password) throw new backup.BackupError(t('cloudSync.noPassword'));
    if (!fs.existsSync(cfg.folder)) throw new backup.BackupError(t('cloudSync.folderOffline', { folder: cfg.folder }));
    const file = remoteFile();
    // iCloud: Datei liegt nur als Platzhalter vor und wird noch geladen -> nichts überschreiben
    if (!fs.existsSync(file) && fs.existsSync(path.join(cfg.folder, `.${FILE_NAME}.icloud`))) {
      status.waiting = t('cloudSync.icloudWaiting');
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
          status.lastError = err instanceof backup.BackupError ? err.message : t('cloudSync.failed', { message: err && err.message || err });
          if (err && err.code === backup.WRONG_PASSWORD) status.lastError = t('cloudSync.wrongStored');
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
      if (!folder || !fs.existsSync(folder)) throw new backup.BackupError(t('cloudSync.pickFolder'));
      password = String(password || '');
      const file = path.join(folder, FILE_NAME);
      keyCache = null;
      if (fs.existsSync(file)) {
        // Vorhandene Datei (vom anderen Computer): Passwort muss passen
        const r = await readRemote(file, password).catch(err => {
          throw new backup.BackupError(err && err.code === backup.WRONG_PASSWORD ? t('cloudSync.wrongPassword') : err.message);
        });
        keyCache = r.key;
      } else if (password.length < backup.MIN_PASSWORD) {
        throw new backup.BackupError(t('backup.pwTooShort', { min: backup.MIN_PASSWORD }));
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
      title: t('cloudSync.pickTitle'), buttonLabel: t('cloudSync.pickButton'),
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
