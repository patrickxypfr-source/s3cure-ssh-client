// Backup & Umzug: alles in eine verschlüsselte Datei (.s3cure-backup) exportieren und wieder importieren.
//
// Inhalt: Verbindungen (hosts.json inkl. Gruppen/Farben/Tunnel/Sprung-Server), Befehlsknöpfe (snippets.json),
// Lesezeichen (bookmarks.json, falls vorhanden), Einstellungen (settings.json), bekannte Host-Schlüssel
// (known_hosts), Tresor-Einträge (vault.json: Name, Benutzer, Notiz, Schlüsselpfad – ohne Geheimnisse) und – nur auf
// Wunsch – gespeicherte Passwörter und Passphrasen sowie die Geheimnisse der Tresor-Einträge (lib/vault.js).
//
// Die Datei ist immer mit einem Passwort verschlüsselt, das der Nutzer wählt:
//   Schlüssel = scrypt(Passwort, Salz)  ->  AES-256-GCM (Kopf als Zusatzdaten mit geprüft)
// Passwörter liegen sonst im Schlüsselbund (safeStorage) und sind an diesen Computer gebunden.
// Beim Export werden sie entschlüsselt (nur im Arbeitsspeicher), beim Import neu über safeStorage gespeichert.
//
// Aufbau der Datei:
//   { format: 's3cure-backup', version: 1, kdf: { name: 'scrypt', N, r, p, salt }, cipher: 'aes-256-gcm',
//     iv, tag, data }   (Binärwerte base64)
// Entschlüsselte Daten: siehe collect().
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { t } = require('./i18n');
const vaultLib = require('./vault');

const FORMAT = 's3cure-backup';
const EXT = 's3cure-backup';
const KDF_DEFAULT = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 };
const MAX_FILE = 50 * 1024 * 1024;
const MIN_PASSWORD = 8;
// Diese Einstellungen gehören zum Gerät und kommen nicht ins Backup
const LOCAL_SETTINGS = /^(sync|session)\./;

// code: z. B. WRONG_PASSWORD – damit andere Stellen nicht am (übersetzten) Text erkennen müssen
class BackupError extends Error {
  constructor(message, code) {
    super(message);
    if (code) this.code = code;
  }
}
const WRONG_PASSWORD = 'WRONG_PASSWORD';

// ---------- Verschlüsselung ----------

function scrypt(password, salt, kdf) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFC'), salt, 32,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 32 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Schlüssel einmal ableiten (dauert absichtlich ~0,5 s) und für den Abgleich wiederverwenden
async function deriveKey(password, kdf = KDF_DEFAULT, salt = crypto.randomBytes(16)) {
  const params = { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: Buffer.from(salt).toString('base64') };
  return { key: await scrypt(password, Buffer.from(salt), params), kdf: params };
}

const aadOf = head => Buffer.from(JSON.stringify({ format: head.format, version: head.version, kdf: head.kdf, cipher: head.cipher }));

function encryptWithKey(payload, { key, kdf }) {
  const iv = crypto.randomBytes(12);
  const head = { format: FORMAT, version: 1, kdf, cipher: 'aes-256-gcm' };
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadOf(head));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return JSON.stringify({
    ...head,
    hinweis: t('backup.fileHint'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  }) + '\n';
}

async function encrypt(payload, password) {
  return encryptWithKey(payload, await deriveKey(password));
}

function parseHead(text) {
  let head;
  try { head = JSON.parse(text); } catch { throw new BackupError(t('backup.notBackup')); }
  if (!head || head.format !== FORMAT) throw new BackupError(t('backup.notBackup'));
  if (head.version !== 1 || head.cipher !== 'aes-256-gcm' || !head.kdf || head.kdf.name !== 'scrypt') {
    throw new BackupError(t('backup.newerVersion'));
  }
  const { N, r, p } = head.kdf;
  // Grenzen, damit eine manipulierte Datei die App nicht lahmlegt
  if (!Number.isInteger(N) || N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) || !Number.isInteger(r) || r < 1 || r > 16
    || !Number.isInteger(p) || p < 1 || p > 4 || 128 * N * r > 256 * 1024 * 1024) {
    throw new BackupError(t('backup.damaged'));
  }
  return head;
}

// keyCache: { key, kdf } vom letzten Mal (gleiches Salz -> kein neues scrypt nötig)
async function decrypt(text, password, keyCache = null) {
  const head = parseHead(text);
  const k = keyCache && JSON.stringify(keyCache.kdf) === JSON.stringify(head.kdf)
    ? keyCache
    : await deriveKey(password, head.kdf, Buffer.from(head.kdf.salt, 'base64'));
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', k.key, Buffer.from(head.iv, 'base64'));
    decipher.setAAD(aadOf(head));
    decipher.setAuthTag(Buffer.from(head.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(head.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new BackupError(t('backup.wrongPassword'), WRONG_PASSWORD);
  }
  let payload;
  try { payload = JSON.parse(plain); } catch { throw new BackupError(t('backup.damaged')); }
  if (!payload || typeof payload !== 'object') throw new BackupError(t('backup.damaged'));
  return { payload, key: k };
}

// ---------- Daten lesen und schreiben ----------

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Pfade im Benutzerordner als ~/… speichern, damit sie auf einem anderen Computer passen
const homeRel = p => {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length).split(path.sep).join('/') : p;
};
const homeAbs = p => (p.startsWith('~/') || p === '~' ? path.join(os.homedir(), ...p.slice(1).split('/').filter(Boolean)) : p);

function writeAtomic(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

// ctx: { configDir, loadHosts, saveHosts, passwords: { names, read, write, remove }, passphrases, settingsStore, snippetStore,
//        vault (optional, lib/vault.js createVault) }
function createData(ctx) {
  const file = name => path.join(ctx.configDir, name);
  const readJson = name => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return undefined; } };

  return {
    hosts: () => ctx.loadHosts(),
    saveHosts: hosts => ctx.saveHosts(hosts),

    snippets: () => (ctx.snippetStore ? ctx.snippetStore.load().profiles : (readJson('snippets.json') || {}).profiles || {}),
    saveSnippets(profiles) {
      const cur = readJson('snippets.json');
      const data = { ...(isObj(cur) ? cur : {}), version: 1, migrated: true, iconsMigrated: true, profiles };
      writeAtomic(file('snippets.json'), JSON.stringify(data, null, 2), 0o644);
    },

    knownHosts() {
      try { return fs.readFileSync(file('known_hosts'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')); } catch { return []; }
    },
    saveKnownHosts: lines => writeAtomic(file('known_hosts'), lines.length ? lines.join('\n') + '\n' : '', 0o644),

    bookmarks: () => readJson('bookmarks.json'),
    saveBookmarks: v => writeAtomic(file('bookmarks.json'), JSON.stringify(v, null, 2), 0o644),

    settings() {
      const all = ctx.settingsStore ? ctx.settingsStore.load() : readJson('settings.json') || {};
      return Object.fromEntries(Object.entries(all).filter(([k]) => !LOCAL_SETTINGS.test(k)));
    },

    // Geheimnisse entschlüsselt (nur im Arbeitsspeicher). missing: gespeichert, aber hier nicht lesbar
    passwords() {
      const out = {};
      let missing = 0;
      for (const name of ctx.passwords.names()) {
        const v = ctx.passwords.read(name);
        if (v == null) missing++; else out[name] = v;
      }
      return { values: out, missing };
    },
    passphrases() {
      const out = {};
      let missing = 0;
      for (const p of ctx.passphrases.names()) {
        const v = ctx.passphrases.read(p);
        if (v == null) missing++; else out[homeRel(p)] = v;
      }
      return { values: out, missing };
    },
    hasPassword: name => ctx.passwords.names().includes(name),
    readPassword: name => ctx.passwords.read(name),
    writePassword: (name, v) => ctx.passwords.write(name, v),
    removePassword: name => ctx.passwords.remove(name),
    // Tresor: Einträge (id -> Metadaten) und ihre Geheimnisse ({ password, key, passphrase })
    vault: () => (ctx.vault ? ctx.vault.entries() : {}),
    saveVault: entries => { if (ctx.vault) ctx.vault.replaceEntries(entries); },
    vaultSecrets: () => (ctx.vault ? ctx.vault.exportSecrets() : { values: {}, missing: 0 }),
    hasVaultSecret: id => !!ctx.vault && ctx.vault.hasAnySecret(id),
    writeVaultSecrets: (id, v) => !!ctx.vault && ctx.vault.writeSecrets(id, v),
    removeVaultSecrets: id => { if (ctx.vault) ctx.vault.removeSecrets(id); },
    hasPassphrase: p => ctx.passphrases.has(homeAbs(p)),
    readPassphrase: p => ctx.passphrases.read(homeAbs(p)),
    writePassphrase: (p, v) => ctx.passphrases.write(homeAbs(p), v),
    removePassphrase: p => ctx.passphrases.remove(homeAbs(p)),

    // Sicherheitskopie der aktuellen Dateien vor einem Import
    safetyCopy() {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dir = path.join(ctx.configDir, 'sicherungen', 'vor-import-' + stamp);
      let n = 0;
      for (const name of ['hosts.json', 'snippets.json', 'known_hosts', 'settings.json', 'bookmarks.json', 'passwords.json', 'passphrases.json', 'vault.json', 'vault-secrets.json']) {
        try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.copyFileSync(file(name), path.join(dir, name)); n++; } catch { /* gibt es nicht */ }
      }
      return n ? dir : null;
    },
  };
}

// Alles einsammeln. secrets: Passwörter und Passphrasen mitnehmen
function collect(data, { secrets = false } = {}) {
  const payload = {
    kind: 's3cure-backup-daten', version: 1, created: new Date().toISOString(), platform: process.platform,
    hosts: data.hosts(),
    snippets: { profiles: data.snippets() },
    knownHosts: data.knownHosts(),
    settings: data.settings(),
    vault: data.vault(),
    secrets: null,
  };
  const bm = data.bookmarks();
  if (bm !== undefined) payload.bookmarks = bm;
  let missing = 0;
  if (secrets) {
    const pw = data.passwords();
    const pp = data.passphrases();
    const vs = data.vaultSecrets();
    payload.secrets = { passwords: pw.values, passphrases: pp.values, vault: vs.values };
    missing = pw.missing + pp.missing + vs.missing;
  }
  return { payload, missing };
}

// ---------- Import: Vorschau und Übernehmen ----------

function cleanPayload(p) {
  if (p.kind !== 's3cure-backup-daten') throw new BackupError(t('backup.damaged'));
  const hosts = {};
  for (const [name, h] of Object.entries(isObj(p.hosts) ? p.hosts : {})) {
    if (isObj(h) && typeof h.host === 'string' && name.length <= 300) hosts[name] = h;
  }
  const profiles = {};
  for (const [k, v] of Object.entries(isObj(p.snippets) && isObj(p.snippets.profiles) ? p.snippets.profiles : {})) {
    if (isObj(v) && Array.isArray(v.groups)) profiles[k] = { groups: v.groups };
  }
  const strMap = m => Object.fromEntries(Object.entries(isObj(m) ? m : {}).filter(([, v]) => typeof v === 'string'));
  const vault = vaultLib.cleanEntries(p.vault);
  const vaultSecrets = {};
  if (isObj(p.secrets) && isObj(p.secrets.vault)) {
    for (const [id, v] of Object.entries(p.secrets.vault)) {
      const c = vaultLib.cleanSecrets(v);
      if (id in vault && Object.keys(c).length) vaultSecrets[id] = c;
    }
  }
  const secrets = isObj(p.secrets) ? { passwords: strMap(p.secrets.passwords), passphrases: strMap(p.secrets.passphrases), vault: vaultSecrets } : null;
  return {
    created: typeof p.created === 'string' ? p.created : null,
    platform: typeof p.platform === 'string' ? p.platform : null,
    hosts,
    profiles,
    knownHosts: (Array.isArray(p.knownHosts) ? p.knownHosts : []).filter(l => typeof l === 'string' && /^\S+\s+\S+\s+\S+/.test(l)).map(l => l.trim()),
    settings: Object.fromEntries(Object.entries(isObj(p.settings) ? p.settings : {}).filter(([k]) => /^[\w.-]{1,64}$/.test(k) && !LOCAL_SETTINGS.test(k))),
    bookmarks: 'bookmarks' in p ? p.bookmarks : undefined,
    vault,
    secrets,
  };
}

// Vergleich Name für Name: was kommt neu dazu, was ändert sich, was fällt (nur bei „Ersetzen“) weg
function diffMap(local, incoming) {
  const added = [], changed = [], removed = [];
  let unchanged = 0;
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in local)) added.push(k);
    else if (!same(local[k], v)) changed.push(k);
    else unchanged++;
  }
  for (const k of Object.keys(local)) if (!(k in incoming)) removed.push(k);
  return { added, changed, removed, unchanged };
}

// Tresor-Vergleich mit Namen statt Kennungen (für die Anzeige)
function vaultDiff(local, incoming) {
  const d = diffMap(local, incoming);
  const nameOf = id => (incoming[id] || local[id]).name;
  return { added: d.added.map(nameOf), changed: d.changed.map(nameOf), removed: d.removed.map(nameOf), unchanged: d.unchanged };
}

function preview(data, b) {
  const kh = new Set(data.knownHosts());
  const localSettings = data.settings();
  const pw = b.secrets ? Object.keys(b.secrets.passwords) : [];
  const pp = b.secrets ? Object.keys(b.secrets.passphrases) : [];
  const vs = b.secrets ? Object.keys(b.secrets.vault) : [];
  return {
    created: b.created,
    platform: b.platform,
    hosts: diffMap(data.hosts(), b.hosts),
    snippets: diffMap(data.snippets(), b.profiles),
    knownHosts: { added: b.knownHosts.filter(l => !kh.has(l)).length, total: b.knownHosts.length },
    settings: { changed: Object.keys(b.settings).filter(k => !same(localSettings[k], b.settings[k])).length },
    bookmarks: b.bookmarks === undefined ? null : { changed: !same(data.bookmarks(), b.bookmarks) },
    vault: vaultDiff(data.vault(), b.vault),
    secrets: b.secrets ? {
      passwords: pw.length,
      passphrases: pp.length,
      vault: vs.length,
      // gleichnamige, die schon gespeichert sind (werden nur mit „überschreiben“ ersetzt)
      existing: pw.filter(n => data.hasPassword(n)).length + pp.filter(p => data.hasPassphrase(p)).length
        + vs.filter(id => data.hasVaultSecret(id)).length,
    } : null,
  };
}

// opts: { mode: 'merge' | 'replace', overwrite: true (gleichnamige aus dem Backup nehmen), secrets: true }
function apply(data, b, opts = {}) {
  const replace = opts.mode === 'replace';
  const overwrite = replace || opts.overwrite !== false;
  const take = (local, incoming) => {
    const out = replace ? {} : { ...local };
    for (const [k, v] of Object.entries(incoming)) if (!(k in out) || overwrite) out[k] = v;
    return out;
  };
  const result = { safetyCopy: data.safetyCopy(), warnings: [] };

  // Verbindungen
  const before = data.hosts();
  const hosts = take(before, b.hosts);
  data.saveHosts(hosts);
  result.hosts = diffMap(before, b.hosts);
  if (replace) for (const name of Object.keys(before)) if (!(name in hosts)) data.removePassword(name);

  // Befehlsknöpfe
  const prof = data.snippets();
  data.saveSnippets(take(prof, b.profiles));
  result.snippets = diffMap(prof, b.profiles);

  // Host-Schlüssel: immer zusammenführen (ein fehlender Eintrag würde nur neu nachfragen)
  const kh = data.knownHosts();
  const khSet = new Set(kh);
  const newLines = b.knownHosts.filter(l => !khSet.has(l) && khSet.add(l));
  if (newLines.length) data.saveKnownHosts([...kh, ...newLines]);
  result.knownHosts = newLines.length;

  // Lesezeichen
  if (b.bookmarks !== undefined) {
    const cur = data.bookmarks();
    let next = b.bookmarks;
    if (!replace && cur !== undefined) {
      if (isObj(cur) && isObj(b.bookmarks)) next = overwrite ? { ...cur, ...b.bookmarks } : { ...b.bookmarks, ...cur };
      else if (Array.isArray(cur) && Array.isArray(b.bookmarks)) {
        const seen = new Set(cur.map(x => JSON.stringify(x)));
        next = [...cur, ...b.bookmarks.filter(x => !seen.has(JSON.stringify(x)))];
      } else if (!overwrite) next = cur;
    }
    if (!same(cur, next)) data.saveBookmarks(next);
  }

  // Tresor-Einträge (bei „Ersetzen“ verlieren weggefallene Einträge auch ihre Geheimnisse)
  const vBefore = data.vault();
  const vault = take(vBefore, b.vault);
  if (!same(vBefore, vault)) data.saveVault(vault);
  result.vault = vaultDiff(vBefore, b.vault);

  // Einstellungen: übernimmt die Oberfläche (Settings.set), damit sie sofort wirken
  const ls = data.settings();
  result.settings = Object.fromEntries(Object.entries(b.settings).filter(([k, v]) => (overwrite || !(k in ls)) && !same(ls[k], v)));

  // Passwörter und Passphrasen neu im Schlüsselbund dieses Computers speichern
  result.secrets = { saved: 0, failed: 0 };
  if (opts.secrets !== false && b.secrets) {
    const put = (has, write, k, v) => {
      if (has(k) && !overwrite) return;
      if (write(k, v)) result.secrets.saved++; else result.secrets.failed++;
    };
    for (const [name, v] of Object.entries(b.secrets.passwords)) if (name in hosts) put(data.hasPassword, data.writePassword, name, v);
    for (const [p, v] of Object.entries(b.secrets.passphrases)) put(data.hasPassphrase, data.writePassphrase, p, v);
    for (const [id, v] of Object.entries(b.secrets.vault || {})) if (id in vault) put(data.hasVaultSecret, data.writeVaultSecrets, id, v);
    if (result.secrets.failed) result.warnings.push(t('backup.secretsFailed', { count: result.secrets.failed }));
  }
  return result;
}

// ---------- IPC ----------

const cleanMsg = err => (err instanceof BackupError ? err.message : t('backup.errorPrefix', { message: err && err.message || err }));

function register({ ipcMain, dialog, app, getWin, ...ctx }) {
  const data = createData(ctx);
  const pending = new Map(); // Kennung -> entschlüsseltes Backup (bis zum Übernehmen)

  ipcMain.handle('backup:export', async (_e, opts = {}) => {
    const password = String(opts.password || '');
    if (password.length < MIN_PASSWORD) throw new BackupError(t('backup.pwTooShort', { min: MIN_PASSWORD }));
    const day = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(getWin(), {
      title: t('backup.saveDialog'),
      defaultPath: path.join(app.getPath('documents'), `S3cure-Backup-${day}.${EXT}`),
      filters: [{ name: 'S3cure-Backup', extensions: [EXT] }],
    });
    if (r.canceled || !r.filePath) return null;
    const { payload, missing } = collect(data, { secrets: !!opts.secrets });
    const target = r.filePath.endsWith('.' + EXT) ? r.filePath : `${r.filePath}.${EXT}`;
    writeAtomic(target, await encrypt(payload, password));
    return {
      file: target,
      hosts: Object.keys(payload.hosts).length,
      vault: Object.keys(payload.vault).length,
      passwords: payload.secrets ? Object.keys(payload.secrets.passwords).length + Object.keys(payload.secrets.passphrases).length
        + Object.values(payload.secrets.vault).reduce((n, s) => n + Object.keys(s).length, 0) : 0,
      missing,
    };
  });

  ipcMain.handle('backup:pick', async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: t('backup.importDialog'), buttonLabel: t('common.open'),
      defaultPath: app.getPath('documents'),
      filters: [{ name: 'S3cure-Backup', extensions: [EXT] }, { name: t('backup.allFiles'), extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    if (fs.statSync(file).size > MAX_FILE) throw new BackupError(t('backup.tooBig'));
    parseHead(fs.readFileSync(file, 'utf8'));
    return { file, name: path.basename(file) };
  });

  ipcMain.handle('backup:preview', async (_e, file, password) => {
    try {
      const { payload } = await decrypt(fs.readFileSync(file, 'utf8'), password);
      const b = cleanPayload(payload);
      const token = crypto.randomUUID();
      pending.clear();
      pending.set(token, b);
      setTimeout(() => pending.delete(token), 15 * 60 * 1000);
      return { token, preview: preview(data, b) };
    } catch (err) { throw new Error(cleanMsg(err)); }
  });

  ipcMain.handle('backup:apply', (_e, token, opts) => {
    const b = pending.get(token);
    if (!b) throw new Error(t('backup.notOpen'));
    pending.delete(token);
    const result = apply(data, b, opts || {});
    if (ctx.onApplied) ctx.onApplied();
    return result;
  });

  return { data };
}

module.exports = {
  register, createData, collect, cleanPayload, preview, apply,
  encrypt, encryptWithKey, decrypt, deriveKey, parseHead, BackupError, WRONG_PASSWORD, EXT, MIN_PASSWORD, writeAtomic, homeRel, homeAbs,
};
