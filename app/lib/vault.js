// Tresor für Zugangsdaten (wie „Credentials/Identities“ in Royal TSX oder Termius).
//
// Ein Eintrag hat Name, Benutzername, Passwort und/oder SSH-Schlüssel (Pfad zu einer Datei oder ein im
// Tresor gespeicherter privater Schlüssel) mit Passphrase, dazu eine Notiz. Verbindungen in hosts.json
// verweisen mit `credential: '<id>'` darauf – ändert man den Eintrag, gilt das sofort für alle.
//
// Speicherorte:
//   ~/.myssh/vault.json          Metadaten (Name, Benutzer, Notiz, Schlüsselpfad, Typ/Fingerabdruck), keine Geheimnisse
//   ~/.myssh/vault-secrets.json  Passwort, privater Schlüssel, Passphrase – verschlüsselt (safeStorage, lib/secrets.js)
//                                Namen: '<id>:password', '<id>:key', '<id>:passphrase'
// Geheimnisse gehen nur bewusst an die Oberfläche („Anzeigen“, kurz) oder in die Zwischenablage
// („Kopieren“, wird nach 30 s geleert). Optional erst nach Entsperren (App-Sperre, lib/applock.js).
//
// Diese Datei lädt kein Electron – der verschlüsselte Speicher wird hereingereicht (Unit-Tests: test/unit/vault.test.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { utils } = require('ssh2');
const { t } = require('./i18n');

const KINDS = ['password', 'key', 'passphrase'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LIMITS = { name: 100, user: 200, note: 4000, keyPath: 1024, secret: 64 * 1024 };
const CLIPBOARD_CLEAR_MS = 30 * 1000;
const UNLOCK_GRACE_MS = 60 * 1000; // nach dem Entsperren eine Minute ohne erneute Abfrage
const META_FIELDS = ['id', 'name', 'user', 'note', 'keyPath', 'keyType', 'keyFingerprint', 'publicKey', 'created', 'updated'];

class VaultError extends Error {}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// ---------- Reine Hilfsfunktionen (auch für Backup und Abgleich) ----------

// Einen Eintrag (Metadaten) bereinigen – null, wenn er unbrauchbar ist
function cleanEntry(e, id = e && e.id) {
  if (!isObj(e) || typeof id !== 'string' || !ID_RE.test(id)) return null;
  const name = str(e.name, LIMITS.name).trim();
  if (!name) return null;
  const out = { id, name };
  const user = str(e.user, LIMITS.user).trim();
  if (user) out.user = user;
  const note = str(e.note, LIMITS.note);
  if (note.trim()) out.note = note;
  const keyPath = str(e.keyPath, LIMITS.keyPath).trim();
  if (keyPath) out.keyPath = keyPath;
  for (const k of ['keyType', 'keyFingerprint']) { const v = str(e[k], 200).trim(); if (v) out[k] = v; }
  const pub = str(e.publicKey, 16 * 1024).trim();
  if (pub && /^[\w@.-]+ [A-Za-z0-9+/=]+( .*)?$/.test(pub)) out.publicKey = pub;
  for (const k of ['created', 'updated']) if (typeof e[k] === 'string' && e[k].length <= 40) out[k] = e[k];
  return out;
}

// Alle Einträge (id -> Eintrag) bereinigen, z. B. aus einem Backup
function cleanEntries(map) {
  const out = {};
  for (const [id, e] of Object.entries(isObj(map) ? map : {})) {
    const c = cleanEntry(e, id);
    if (c) out[id] = c;
  }
  return out;
}

// Geheimnisse eines Eintrags: { password?, key?, passphrase? } – nur Texte
function cleanSecrets(s) {
  const out = {};
  if (!isObj(s)) return out;
  for (const k of KINDS) if (typeof s[k] === 'string' && s[k] && s[k].length <= LIMITS.secret) out[k] = s[k];
  return out;
}

// Welche Verbindungen nutzen den Eintrag?
function usedBy(hosts, id) {
  return Object.keys(hosts || {}).filter(n => hosts[n] && hosts[n].credential === id)
    .sort((a, b) => a.localeCompare(b));
}

// Eintrag gelöscht: Verbindungen lösen. Der Benutzername bleibt an der Verbindung, damit sie
// danach wie eine „eigene“ funktioniert (Passwort wird beim Verbinden abgefragt). Gibt die Namen zurück.
function unlinkHosts(hosts, id, entry) {
  const changed = [];
  for (const [n, h] of Object.entries(hosts || {})) {
    if (!h || h.credential !== id) continue;
    if (entry && entry.user) h.user = entry.user;
    delete h.credential;
    changed.push(n);
  }
  return changed.sort((a, b) => a.localeCompare(b));
}

// Ziel mit den Daten des Eintrags: Benutzername und Schlüsselpfad aus dem Tresor.
// Die eigenen Felder der Verbindung (key) zählen dann nicht – „eigene“ oder „Tresor“, nicht beides.
function applyEntry(target, entry) {
  return { ...target, user: entry.user || target.user, key: entry.keyPath || null };
}

// Starkes Passwort: kryptografischer Zufall, aus jeder gewählten Zeichengruppe mindestens ein Zeichen.
// Ohne leicht verwechselbare Zeichen (0/O, 1/l/I).
const CHARSETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!#$%&*+-=?@^_~.,:;',
};
function generatePassword({ length = 24, symbols = true, digits = true } = {}) {
  const len = Math.max(8, Math.min(128, Math.floor(Number(length)) || 24));
  const groups = [CHARSETS.lower, CHARSETS.upper];
  if (digits) groups.push(CHARSETS.digits);
  if (symbols) groups.push(CHARSETS.symbols);
  const all = groups.join('');
  const chars = groups.map(g => g[crypto.randomInt(g.length)]);
  while (chars.length < len) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { // mischen (Fisher-Yates)
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// Privaten Schlüssel prüfen. Gibt { keyType, keyFingerprint, publicKey } oder {} (verschlüsselt, ohne
// Passphrase nicht lesbar) zurück; wirft bei kaputtem Schlüssel oder falscher Passphrase.
function inspectKey(data, passphrase) {
  let key = utils.parseKey(data, passphrase || undefined);
  if (key instanceof Error) {
    if (/passphrase|encrypted|decrypt/i.test(key.message)) {
      if (passphrase) throw new VaultError(t('vault.errKeyPassphrase'));
      return {};
    }
    throw new VaultError(t('vault.errKeyInvalid'));
  }
  if (Array.isArray(key)) key = key[0];
  if (!key || typeof key.getPublicSSH !== 'function' || !key.isPrivateKey || !key.isPrivateKey()) {
    throw new VaultError(t('vault.errKeyNotPrivate'));
  }
  const pub = key.getPublicSSH();
  return {
    keyType: key.type,
    keyFingerprint: 'SHA256:' + crypto.createHash('sha256').update(pub).digest('base64').replace(/=+$/, ''),
    publicKey: `${key.type} ${pub.toString('base64')}${key.comment ? ' ' + key.comment : ''}`,
  };
}

// ---------- Tresor ----------

// deps: { configDir, secrets: { has, names, read, write, remove }, loadHosts, saveHosts, expandHome }
function createVault({ configDir, secrets, loadHosts = () => ({}), saveHosts = () => {}, expandHome = p => p }) {
  const file = path.join(configDir, 'vault.json');
  const sname = (id, kind) => `${id}:${kind}`;

  function load() {
    let s;
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { s = {}; }
    if (!isObj(s)) s = {};
    return { version: 1, requireUnlock: s.requireUnlock === true, entries: cleanEntries(s.entries) };
  }
  function save(state) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, requireUnlock: state.requireUnlock || undefined, entries: state.entries }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const entries = () => load().entries;
  const get = id => (typeof id === 'string' && entries()[id]) || null;
  const has = id => !!get(id);
  const hasSecret = (id, kind) => secrets.has(sname(id, kind));
  const read = (id, kind) => (KINDS.includes(kind) ? secrets.read(sname(id, kind)) : null);
  function write(id, kind, value) {
    if (!secrets.write(sname(id, kind), value)) throw new VaultError(t('vault.errNoEncryption'));
  }
  const removeSecrets = id => { for (const k of KINDS) secrets.remove(sname(id, k)); };

  const flags = e => ({
    hasPassword: hasSecret(e.id, 'password'),
    hasKey: hasSecret(e.id, 'key'),
    hasPassphrase: hasSecret(e.id, 'passphrase'),
  });

  // Für die Oberfläche: Metadaten, was gespeichert ist, und welche Verbindungen ihn nutzen – keine Geheimnisse
  function list(hosts = loadHosts()) {
    return Object.values(entries())
      .map(e => ({ ...e, ...flags(e), usedBy: usedBy(hosts, e.id) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  // Anlegen oder ändern.
  // input: { id?, name, user, note, keyMode: 'none' | 'file' | 'stored', keyPath,
  //          password, passphrase, key: undefined = unverändert, '' oder null = entfernen, Text = neu
  //          keyFile: Pfad – Schlüssel aus dieser Datei in den Tresor übernehmen }
  function upsert(input) {
    if (!isObj(input)) throw new VaultError(t('vault.errInvalid'));
    const state = load();
    const prev = input.id ? state.entries[input.id] : null;
    if (input.id && !prev) throw new VaultError(t('vault.errGone'));
    const id = prev ? prev.id : crypto.randomUUID();
    const name = str(input.name, LIMITS.name).trim();
    if (!name) throw new VaultError(t('vault.errNoName'));
    const lower = name.toLocaleLowerCase();
    if (Object.values(state.entries).some(e => e.id !== id && e.name.toLocaleLowerCase() === lower)) {
      throw new VaultError(t('vault.errNameTaken', { name }));
    }
    const mode = ['none', 'file', 'stored'].includes(input.keyMode) ? input.keyMode
      : prev && prev.keyPath ? 'file' : prev && hasSecret(id, 'key') ? 'stored' : 'none';

    // Neue Geheimnisse (undefined = unverändert, '' = entfernen)
    const next = {};
    for (const k of ['password', 'passphrase']) {
      if (input[k] === undefined) continue;
      if (input[k] !== null && typeof input[k] !== 'string') throw new VaultError(t('vault.errInvalid'));
      if (input[k] && input[k].length > LIMITS.secret) throw new VaultError(t('vault.errTooLong'));
      next[k] = input[k] || '';
    }
    let keyText;
    if (mode === 'stored') {
      if (input.keyFile) {
        try {
          const f = expandHome(String(input.keyFile));
          if (fs.statSync(f).size > LIMITS.secret) throw new VaultError(t('vault.errTooLong'));
          keyText = fs.readFileSync(f, 'utf8');
        } catch (err) { throw err instanceof VaultError ? err : new VaultError(t('vault.errKeyFile', { error: err.message })); }
      } else if (typeof input.key === 'string' && input.key.trim()) {
        keyText = input.key.trim() + '\n';
      }
      if (keyText && keyText.length > LIMITS.secret) throw new VaultError(t('vault.errTooLong'));
      if (keyText === undefined && !hasSecret(id, 'key')) throw new VaultError(t('vault.errNoKey'));
    }
    const keyPath = mode === 'file' ? str(input.keyPath, LIMITS.keyPath).trim() : '';
    if (mode === 'file' && !keyPath) throw new VaultError(t('vault.errNoKeyPath'));

    // Schlüssel prüfen (mit der Passphrase, die danach gilt) – Typ und Fingerabdruck merken
    const passAfter = next.passphrase !== undefined ? next.passphrase : read(id, 'passphrase');
    let keyInfo = {};
    if (mode === 'stored') {
      keyInfo = inspectKey(keyText !== undefined ? keyText : read(id, 'key'), passAfter);
    } else if (mode === 'file') {
      try { keyInfo = inspectKey(fs.readFileSync(expandHome(keyPath)), passAfter); } catch (err) {
        if (err instanceof VaultError && next.passphrase) throw err; // falsche Passphrase: gleich sagen
        keyInfo = {};  // Datei fehlt (noch) oder nicht lesbar – beim Verbinden zeigt sich, ob sie passt
      }
    }

    const now = new Date().toISOString();
    const entry = cleanEntry({
      id, name, user: input.user, note: input.note, keyPath, ...keyInfo,
      created: prev ? prev.created : now, updated: now,
    });
    // Erst die Geheimnisse (schlägt die Verschlüsselung fehl, bleibt alles wie es war), dann die Metadaten
    for (const [k, v] of Object.entries(next)) { if (v) write(id, k, v); else secrets.remove(sname(id, k)); }
    if (mode === 'stored' && keyText !== undefined) write(id, 'key', keyText);
    if (mode !== 'stored') secrets.remove(sname(id, 'key'));
    state.entries[id] = entry;
    save(state);
    return { ...entry, ...flags(entry) };
  }

  // Löschen: Verweise in den Verbindungen lösen. Gibt die gelösten Verbindungen zurück.
  function remove(id) {
    const state = load();
    const entry = state.entries[id];
    if (!entry) return [];
    const hosts = loadHosts();
    const changed = unlinkHosts(hosts, id, entry);
    if (changed.length) saveHosts(hosts);
    delete state.entries[id];
    save(state);
    removeSecrets(id);
    return changed;
  }

  // Für die Anmeldung (lib/connection.js, lib/files-adapter.js): Ziel mit Benutzer/Schlüsselpfad
  // aus dem Tresor und Zugriff auf die Geheimnisse. null = Verbindung nutzt keinen (vorhandenen) Eintrag.
  // opts.keyOnly: Schlüssel der Verbindung selbst prüfen (z. B. nach „Schlüssel übertragen“) – Pfad nicht ersetzen
  function resolve(target, opts = {}) {
    if (!target || !target.credential) return null;
    const entry = get(target.credential);
    if (!entry) return null;
    const id = entry.id;
    const resolved = applyEntry(target, entry);
    if (opts.keyOnly) resolved.key = target.key;
    return {
      target: resolved,
      cred: {
        id, name: entry.name,
        hasKey: !opts.keyOnly && !entry.keyPath && hasSecret(id, 'key'),
        password: () => read(id, 'password'),
        key: () => read(id, 'key'),
        passphrase: () => read(id, 'passphrase'),
        setPassword: v => { try { write(id, 'password', v); return true; } catch { return false; } },
        setPassphrase: v => { try { write(id, 'passphrase', v); return true; } catch { return false; } },
      },
    };
  }

  // Verbindungen für die Oberfläche: Benutzer aus dem Tresor und Name des Eintrags
  function decorateHosts(hosts) {
    const all = entries();
    for (const [n, h] of Object.entries(hosts)) {
      const e = h && h.credential && all[h.credential];
      if (e) hosts[n] = { ...h, user: e.user || h.user, credentialName: e.name };
    }
    return hosts;
  }

  // ---------- Backup und Abgleich (lib/backup.js, lib/cloud-sync.js) ----------

  // Alle Einträge ersetzen. Weggefallene verlieren auch ihre Geheimnisse.
  function replaceEntries(map) {
    const state = load();
    const clean = cleanEntries(map);
    for (const id of Object.keys(state.entries)) if (!(id in clean)) removeSecrets(id);
    state.entries = clean;
    save(state);
  }
  // Geheimnisse entschlüsselt (nur im Arbeitsspeicher). missing: gespeichert, aber hier nicht lesbar
  function exportSecrets() {
    const values = {};
    let missing = 0;
    for (const id of Object.keys(entries())) {
      const s = {};
      for (const k of KINDS) {
        if (!hasSecret(id, k)) continue;
        const v = read(id, k);
        if (v == null) missing++; else s[k] = v;
      }
      if (Object.keys(s).length) values[id] = s;
    }
    return { values, missing };
  }
  // Geheimnisse eines Eintrags setzen (was fehlt, wird entfernt). false = nicht verschlüsselbar
  function writeSecrets(id, s) {
    if (!ID_RE.test(String(id))) return false;
    const clean = cleanSecrets(s);
    try {
      for (const k of KINDS) { if (clean[k]) write(id, k, clean[k]); else secrets.remove(sname(id, k)); }
      return true;
    } catch { return false; }
  }
  const hasAnySecret = id => KINDS.some(k => hasSecret(id, k));

  return {
    file, list, get, has, upsert, remove, resolve, decorateHosts, read, hasSecret,
    entries, replaceEntries, exportSecrets, writeSecrets, removeSecrets, hasAnySecret,
    requireUnlock: () => load().requireUnlock,
    setRequireUnlock(on) { const s = load(); s.requireUnlock = !!on; save(s); return s.requireUnlock; },
  };
}

// ---------- IPC (Oberfläche: src/vault.js, Brücke window.s3vault) ----------

// deps: { ipcMain, clipboard, app, appLock: { status, verify, promptTouchId }, vault }
function register({ ipcMain, clipboard, app, appLock, vault }) {
  let unlockedUntil = 0;
  let failures = 0;
  let clipTimer = null;
  let clipValue = null;

  const lockOn = () => !!(appLock && appLock.status().enabled);
  const needsUnlock = () => vault.requireUnlock() && lockOn() && Date.now() > unlockedUntil;
  const gate = () => ({ needUnlock: true, touchId: !!(appLock && appLock.status().touchId) });
  const wrap = fn => async (...args) => {
    try { return await fn(...args); } catch (err) { throw new Error(err instanceof VaultError ? err.message : String(err && err.message || err)); }
  };

  // readText/writeText sind je nach Electron-Version synchron oder liefern ein Promise – await passt für beides
  async function clearClipboard() {
    clearTimeout(clipTimer);
    clipTimer = null;
    const ours = clipValue;
    clipValue = null;
    if (ours == null) return;
    try { if (await clipboard.readText() === ours) clipboard.clear(); } catch {}
  }
  // Beim Beenden innerhalb der 30 s nichts Geheimes in der Zwischenablage lassen. Hier kann nicht auf ein
  // Promise gewartet werden: Liefert readText keinen Text sofort, wird sicherheitshalber geleert.
  if (app) app.on('will-quit', () => {
    if (clipValue == null) return;
    try {
      const cur = clipboard.readText();
      if (typeof cur !== 'string' || cur === clipValue) clipboard.clear();
    } catch {}
    clipValue = null;
  });

  const secretOf = (id, kind) => {
    if (!vault.has(id)) throw new VaultError(t('vault.errGone'));
    if (kind === 'publicKey') return vault.get(id).publicKey || null;
    if (!KINDS.includes(kind)) throw new VaultError(t('vault.errInvalid'));
    return vault.read(id, kind);
  };

  const state = () => ({
    entries: vault.list(),
    requireUnlock: vault.requireUnlock(),
    lockEnabled: lockOn(),
  });

  ipcMain.handle('vault:list', wrap(() => state()));
  ipcMain.handle('vault:save', wrap((_e, input) => ({ saved: vault.upsert(input), ...state() })));
  ipcMain.handle('vault:delete', wrap((_e, id) => ({ unlinked: vault.remove(id), ...state() })));
  ipcMain.handle('vault:generate', wrap((_e, opts) => generatePassword(opts || {})));

  // Anzeigen: Wert nur auf ausdrücklichen Wunsch (die Oberfläche blendet ihn nach kurzer Zeit wieder aus)
  ipcMain.handle('vault:reveal', wrap((_e, id, kind) => {
    if (kind !== 'publicKey' && needsUnlock()) return gate();
    const value = secretOf(id, kind);
    if (value == null) throw new VaultError(t('vault.errNotReadable'));
    return { value };
  }));

  // Kopieren: Zwischenablage nach 30 s leeren (nur, wenn noch derselbe Text drin steht)
  ipcMain.handle('vault:copy', wrap(async (_e, id, kind) => {
    if (kind !== 'publicKey' && needsUnlock()) return gate();
    const value = secretOf(id, kind);
    if (value == null) throw new VaultError(t('vault.errNotReadable'));
    await clearClipboard();
    await clipboard.writeText(value);
    if (kind === 'publicKey') return { ok: true };
    clipValue = value;
    clipTimer = setTimeout(clearClipboard, CLIPBOARD_CLEAR_MS);
    return { ok: true, clearAfter: CLIPBOARD_CLEAR_MS / 1000 };
  }));

  // Entsperren für Anzeigen/Kopieren: App-Passwort oder Touch ID
  ipcMain.handle('vault:unlock', wrap(async (_e, opts = {}) => {
    if (!lockOn()) return true;
    let ok = false;
    if (opts.touchId) ok = await appLock.promptTouchId(t('vault.touchIdReason'));
    else {
      if (failures > 2) await new Promise(r => setTimeout(r, Math.min(failures, 10) * 1000)); // bremst Raten
      ok = appLock.verify(String(opts.password || ''));
      failures = ok ? 0 : failures + 1;
    }
    if (ok) unlockedUntil = Date.now() + UNLOCK_GRACE_MS;
    return ok;
  }));

  // „Tresor nur nach Entsperren“ – zum Ausschalten muss man entsperrt sein
  ipcMain.handle('vault:require-unlock', wrap((_e, on) => {
    if (on && !lockOn()) throw new VaultError(t('vault.errNeedAppLock'));
    if (!on && needsUnlock()) return gate();
    vault.setRequireUnlock(!!on);
    return state();
  }));
}

module.exports = {
  createVault, register, cleanEntry, cleanEntries, cleanSecrets, usedBy, unlinkHosts, applyEntry,
  generatePassword, inspectKey, VaultError, KINDS, CLIPBOARD_CLEAR_MS,
};
