// Tresor für Zugangsdaten (lib/vault.js): Einträge, Verknüpfung mit Verbindungen, Löschen mit Verweisen,
// Passwort erzeugen, Backup-Format (lib/backup.js) und Abgleich (lib/cloud-sync.js).
// Statt safeStorage ein Speicher im Arbeitsspeicher, der die Werte nur „verschlüsselt“ ablegt (umgedreht + Präfix).
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { utils } = require('ssh2');
const vaultLib = require('../../lib/vault');
const backup = require('../../lib/backup');
const { hostExtras } = require('../../lib/hosts-extra');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 's3cure-vault-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fakeSecrets(file) {
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const save = s => fs.writeFileSync(file, JSON.stringify(s));
  return {
    available: true,
    has: n => n in load(),
    names: () => Object.keys(load()),
    read(n) { const v = load()[n]; return v == null ? null : [...v.slice(4)].reverse().join(''); },
    write(n, v) { if (!this.available) return false; const s = load(); s[n] = 'enc:' + [...v].reverse().join(''); save(s); return true; },
    remove(n) { const s = load(); delete s[n]; save(s); },
  };
}

let dir, hosts, secrets, vault;
let n = 0;
beforeEach(() => {
  dir = path.join(root, String(++n));
  fs.mkdirSync(dir);
  hosts = {
    web: { user: 'alt', host: 'web.example', port: 22, key: '~/.ssh/eigen' },
    db: { user: 'root', host: 'db.example', port: 22 },
    ftp: { user: 'kunde', host: 'ftp.example', port: 21, protocol: 'ftps' },
  };
  secrets = fakeSecrets(path.join(dir, 'vault-secrets.json'));
  vault = vaultLib.createVault({
    configDir: dir, secrets,
    loadHosts: () => JSON.parse(JSON.stringify(hosts)),
    saveHosts: h => { hosts = JSON.parse(JSON.stringify(h)); },
  });
});

const keyPair = passphrase => utils.generateKeyPairSync('ed25519', passphrase ? { passphrase, cipher: 'aes256-ctr', rounds: 4 } : {});

test('Eintrag anlegen: Metadaten in vault.json, Geheimnisse nur verschlüsselt im Speicher', () => {
  const e = vault.upsert({ name: 'Firmen-Login', user: 'admin', password: 'Geheim-123', note: 'für alle Server' });
  assert.equal(e.name, 'Firmen-Login');
  assert.equal(e.hasPassword, true);
  assert.equal(e.hasKey, false);
  const text = fs.readFileSync(path.join(dir, 'vault.json'), 'utf8');
  assert.match(text, /Firmen-Login/);
  assert.doesNotMatch(text, /Geheim-123/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'vault-secrets.json'), 'utf8'), /Geheim-123/);
  assert.equal(vault.read(e.id, 'password'), 'Geheim-123');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'vault.json')).mode & 0o777, 0o600);
});

test('Namen müssen eindeutig sein (Groß/klein egal), leerer Name geht nicht', () => {
  vault.upsert({ name: 'Firmen-Login' });
  assert.throws(() => vault.upsert({ name: 'firmen-login' }), /schon einen Eintrag/);
  assert.throws(() => vault.upsert({ name: '   ' }), /Namen/);
});

test('Bearbeiten: undefined behält das Passwort, leer entfernt es, neuer Text ersetzt es', () => {
  const e = vault.upsert({ name: 'A', password: 'eins' });
  vault.upsert({ id: e.id, name: 'A', user: 'neu' });
  assert.equal(vault.read(e.id, 'password'), 'eins');
  assert.equal(vault.get(e.id).user, 'neu');
  vault.upsert({ id: e.id, name: 'A', password: 'zwei' });
  assert.equal(vault.read(e.id, 'password'), 'zwei');
  vault.upsert({ id: e.id, name: 'A', password: '' });
  assert.equal(vault.read(e.id, 'password'), null);
  assert.equal(vault.list()[0].hasPassword, false);
  assert.throws(() => vault.upsert({ id: 'gibt-es-nicht', name: 'B' }), /nicht mehr/);
});

test('ohne Verschlüsselung wird nichts gespeichert', () => {
  secrets.available = false;
  assert.throws(() => vault.upsert({ name: 'A', password: 'x' }), /nicht möglich/);
  assert.deepEqual(vault.list(), []);
});

test('Verknüpfung: Verbindung nutzt Benutzer, Schlüsselpfad und Passwort des Eintrags – Änderung gilt sofort', () => {
  const e = vault.upsert({ name: 'Firma', user: 'admin', password: 'pw1', keyMode: 'file', keyPath: '~/.ssh/firma' });
  hosts.web.credential = e.id;
  hosts.db.credential = e.id;
  const r = vault.resolve(hosts.web);
  assert.equal(r.target.user, 'admin');
  assert.equal(r.target.key, '~/.ssh/firma'); // eigener Schlüssel der Verbindung zählt nicht
  assert.equal(r.target.host, 'web.example');
  assert.equal(r.cred.password(), 'pw1');
  assert.equal(r.cred.hasKey, false);
  assert.deepEqual(vault.list()[0].usedBy, ['db', 'web']);

  vault.upsert({ id: e.id, name: 'Firma', user: 'admin2', password: 'pw2', keyMode: 'none' });
  const r2 = vault.resolve(hosts.db);
  assert.equal(r2.target.user, 'admin2');
  assert.equal(r2.target.key, null);
  assert.equal(r2.cred.password(), 'pw2');
  // Passwort nach Rückfrage merken -> landet im Eintrag
  assert.equal(r2.cred.setPassword('pw3'), true);
  assert.equal(vault.resolve(hosts.web).cred.password(), 'pw3');
});

test('Verbindung ohne oder mit unbekanntem Eintrag bleibt unverändert; Eintrag ohne Benutzer nimmt den der Verbindung', () => {
  assert.equal(vault.resolve(hosts.web), null);
  assert.equal(vault.resolve({ ...hosts.web, credential: 'weg' }), null);
  const e = vault.upsert({ name: 'Nur Passwort', password: 'x' });
  assert.equal(vault.resolve({ ...hosts.db, credential: e.id }).target.user, 'root');
  // „Schlüssel übertragen und prüfen“ (keyOnly) nutzt den Schlüssel der Verbindung
  assert.equal(vault.resolve({ ...hosts.web, credential: e.id }, { keyOnly: true }).target.key, '~/.ssh/eigen');
});

test('Oberfläche: Verbindungen zeigen Benutzer und Namen des Eintrags', () => {
  const e = vault.upsert({ name: 'Firma', user: 'admin' });
  const h = vault.decorateHosts({ web: { ...hosts.web, credential: e.id }, db: hosts.db });
  assert.equal(h.web.user, 'admin');
  assert.equal(h.web.credentialName, 'Firma');
  assert.equal(h.db.credentialName, undefined);
});

test('Schlüssel im Tresor: wird geprüft, Typ und Fingerabdruck gemerkt, privater Teil nur verschlüsselt', () => {
  const kp = keyPair();
  const e = vault.upsert({ name: 'Key', user: 'deploy', keyMode: 'stored', key: kp.private });
  assert.equal(e.hasKey, true);
  assert.equal(e.keyType, 'ssh-ed25519');
  assert.match(e.keyFingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(e.publicKey.split(' ').slice(0, 2).join(' '), kp.public.split(' ').slice(0, 2).join(' '));
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8'), /PRIVATE KEY/);
  const r = vault.resolve({ ...hosts.web, credential: e.id });
  assert.equal(r.cred.hasKey, true);
  assert.equal(r.target.key, null);
  assert.ok(!(utils.parseKey(r.cred.key()) instanceof Error));
  // Wechsel auf „Keiner“ entfernt den gespeicherten Schlüssel
  vault.upsert({ id: e.id, name: 'Key', keyMode: 'none' });
  assert.equal(vault.hasSecret(e.id, 'key'), false);
});

test('Schlüssel mit Passphrase: richtige geht, falsche, öffentlicher oder kaputter Schlüssel nicht', () => {
  const kp = keyPair('pass-wort');
  assert.throws(() => vault.upsert({ name: 'K1', keyMode: 'stored', key: kp.private, passphrase: 'falsch' }), /Passphrase passt nicht/);
  const e = vault.upsert({ name: 'K1', keyMode: 'stored', key: kp.private, passphrase: 'pass-wort' });
  assert.equal(e.keyType, 'ssh-ed25519');
  assert.equal(e.hasPassphrase, true);
  // ohne Passphrase: wird gespeichert, Passphrase fragt die App beim Verbinden
  const e2 = vault.upsert({ name: 'K2', keyMode: 'stored', key: kp.private });
  assert.equal(e2.hasKey, true);
  assert.equal(e2.keyType, undefined);
  assert.throws(() => vault.upsert({ name: 'K3', keyMode: 'stored', key: kp.public }), /öffentlicher Schlüssel|kein gültiger/);
  assert.throws(() => vault.upsert({ name: 'K4', keyMode: 'stored', key: 'hallo' }), /kein gültiger/);
  assert.throws(() => vault.upsert({ name: 'K5', keyMode: 'stored' }), /privaten Schlüssel/);
  assert.throws(() => vault.upsert({ name: 'K6', keyMode: 'file', keyPath: '' }), /Schlüssel-Datei/);
});

test('Schlüssel aus Datei übernehmen: Inhalt landet verschlüsselt im Tresor', () => {
  const kp = keyPair();
  const f = path.join(dir, 'id_test');
  fs.writeFileSync(f, kp.private);
  const e = vault.upsert({ name: 'Aus Datei', keyMode: 'stored', keyFile: f });
  assert.equal(e.keyType, 'ssh-ed25519');
  assert.equal(e.keyPath, undefined);
  assert.equal(vault.read(e.id, 'key').trim(), kp.private.trim());
});

test('Löschen mit Verweisen: Verbindungen werden gelöst, behalten den Benutzer, Geheimnisse sind weg', () => {
  const e = vault.upsert({ name: 'Firma', user: 'admin', password: 'pw' });
  const other = vault.upsert({ name: 'Andere', password: 'x' });
  hosts.web.credential = e.id;
  hosts.ftp.credential = e.id;
  hosts.db.credential = other.id;
  const unlinked = vault.remove(e.id);
  assert.deepEqual(unlinked, ['ftp', 'web']);
  assert.equal(hosts.web.credential, undefined);
  assert.equal(hosts.web.user, 'admin');
  assert.equal(hosts.ftp.user, 'admin');
  assert.equal(hosts.db.credential, other.id); // andere Verknüpfung bleibt
  assert.equal(vault.has(e.id), false);
  assert.equal(secrets.names().some(k => k.startsWith(e.id)), false);
  assert.deepEqual(vault.remove('gibt-es-nicht'), []);
});

test('unlinkHosts/usedBy als reine Funktionen', () => {
  const h = { a: { user: 'x', credential: 'c1' }, b: { user: 'y' }, c: { user: 'z', credential: 'c1' } };
  assert.deepEqual(vaultLib.usedBy(h, 'c1'), ['a', 'c']);
  assert.deepEqual(vaultLib.unlinkHosts(h, 'c1', { user: '' }), ['a', 'c']);
  assert.deepEqual(h, { a: { user: 'x' }, b: { user: 'y' }, c: { user: 'z' } });
});

test('Passwort erzeugen: Länge, Zeichengruppen, ohne Sonderzeichen, Grenzen', () => {
  for (let i = 0; i < 50; i++) {
    const pw = vaultLib.generatePassword({ length: 20 });
    assert.equal(pw.length, 20);
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /[2-9]/);
    assert.match(pw, /[^A-Za-z0-9]/);
    assert.doesNotMatch(pw, /[0O1lI]/);
  }
  assert.match(vaultLib.generatePassword({ length: 30, symbols: false }), /^[A-Za-z2-9]{30}$/);
  assert.equal(vaultLib.generatePassword({ length: 2 }).length, 8);
  assert.equal(vaultLib.generatePassword({ length: 999 }).length, 128);
  assert.equal(vaultLib.generatePassword().length, 24);
  assert.notEqual(vaultLib.generatePassword(), vaultLib.generatePassword());
});

test('Verbindungs-Feld „credential“: nur gültige Kennungen, leer = eigene', () => {
  assert.equal(hostExtras({ credential: 'ab-12_x' }).credential, 'ab-12_x');
  assert.equal(hostExtras({ credential: '' }).credential, undefined);
  assert.ok('credential' in hostExtras({ credential: '' })); // altes Feld wird beim Speichern entfernt
  assert.equal(hostExtras({ credential: '../x' }).credential, undefined);
  assert.equal('credential' in hostExtras({ group: 'x' }), false);
});

// ---------- Backup ----------

function backupData() {
  const passwords = fakeSecrets(path.join(dir, 'passwords.json'));
  const passphrases = fakeSecrets(path.join(dir, 'passphrases.json'));
  return backup.createData({
    configDir: dir, vault, passphrases,
    loadHosts: () => JSON.parse(JSON.stringify(hosts)), saveHosts: h => { hosts = JSON.parse(JSON.stringify(h)); },
    passwords: { names: passwords.names, read: n2 => passwords.read(n2), write: (k, v) => passwords.write(k, v), remove: n2 => passwords.remove(n2) },
  });
}

test('Backup: Tresor-Einträge immer, Geheimnisse nur mit „Passwörter mitnehmen“', async () => {
  const e = vault.upsert({ name: 'Firma', user: 'admin', password: 'pw', passphrase: 'pp', keyMode: 'file', keyPath: '~/.ssh/firma' });
  hosts.web.credential = e.id;
  const data = backupData();

  const without = backup.collect(data, { secrets: false }).payload;
  assert.equal(without.vault[e.id].name, 'Firma');
  assert.equal(without.vault[e.id].keyPath, '~/.ssh/firma');
  assert.equal(without.secrets, null);
  assert.doesNotMatch(JSON.stringify(without), /"pw"|"pp"/);

  const { payload, missing } = backup.collect(data, { secrets: true });
  assert.equal(missing, 0);
  assert.deepEqual(payload.secrets.vault, { [e.id]: { password: 'pw', passphrase: 'pp' } });
  assert.equal(payload.hosts.web.credential, e.id);

  // verschlüsselt und wieder gelesen: Format bleibt erhalten
  const text = await backup.encrypt(payload, 'backup-passwort');
  assert.doesNotMatch(text, /Firma/);
  const back = backup.cleanPayload((await backup.decrypt(text, 'backup-passwort')).payload);
  assert.deepEqual(back.vault, payload.vault);
  assert.deepEqual(back.secrets.vault, payload.secrets.vault);
});

test('Backup lesen: kaputte Tresor-Einträge und Geheimnisse ohne Eintrag fallen weg', () => {
  const b = backup.cleanPayload({
    kind: 's3cure-backup-daten', hosts: {},
    vault: { ok1: { name: 'Gut', user: 'u' }, '../böse': { name: 'x' }, leer: { name: '' }, kaputt: 'text' },
    secrets: { passwords: {}, passphrases: {}, vault: { ok1: { password: 'p', key: 5 }, fremd: { password: 'q' } } },
  });
  assert.deepEqual(Object.keys(b.vault), ['ok1']);
  assert.deepEqual(b.secrets.vault, { ok1: { password: 'p' } });
  // ältere Backups ohne Tresor
  const old = backup.cleanPayload({ kind: 's3cure-backup-daten', hosts: {}, secrets: { passwords: { a: 'b' } } });
  assert.deepEqual(old.vault, {});
  assert.deepEqual(old.secrets.vault, {});
});

test('Backup einspielen: Zusammenführen übernimmt Einträge und Geheimnisse, Ersetzen entfernt fehlende', () => {
  const local = vault.upsert({ name: 'Lokal', password: 'lokal' });
  const data = backupData();
  const b = backup.cleanPayload({
    kind: 's3cure-backup-daten', hosts: { neu: { user: 'x', host: 'neu.example', port: 22, credential: 'id-aus-backup' } },
    vault: { 'id-aus-backup': { name: 'Aus Backup', user: 'backup' } },
    secrets: { passwords: {}, passphrases: {}, vault: { 'id-aus-backup': { password: 'aus-backup' } } },
  });
  const p = backup.preview(data, b);
  assert.deepEqual(p.vault.added, ['Aus Backup']);
  assert.deepEqual(p.vault.removed, ['Lokal']);
  assert.equal(p.secrets.vault, 1);

  const r = backup.apply(data, b, { mode: 'merge', secrets: true });
  assert.deepEqual(r.vault.added, ['Aus Backup']);
  assert.equal(vault.get('id-aus-backup').user, 'backup');
  assert.equal(vault.read('id-aus-backup', 'password'), 'aus-backup');
  assert.equal(vault.resolve(hosts.neu).cred.password(), 'aus-backup');
  assert.equal(vault.read(local.id, 'password'), 'lokal');

  // ohne „Passwörter übernehmen“ kommen nur die Metadaten
  vault.remove('id-aus-backup');
  backup.apply(data, b, { mode: 'merge', secrets: false });
  assert.equal(vault.has('id-aus-backup'), true);
  assert.equal(vault.read('id-aus-backup', 'password'), null);

  backup.apply(data, b, { mode: 'replace', secrets: true });
  assert.equal(vault.has(local.id), false);
  assert.equal(secrets.has(local.id + ':password'), false);
});

// ---------- Abgleich über Cloud-Ordner ----------

test('Abgleich: Tresor-Einträge und (nur mit Häkchen) ihre Geheimnisse als eigene Einträge', () => {
  const sync = require('../../lib/cloud-sync');
  const payload = {
    kind: 's3cure-backup-daten', hosts: {}, vault: { v1: { id: 'v1', name: 'Firma', user: 'admin' } },
    secrets: { passwords: {}, passphrases: {}, vault: { v1: { password: 'pw' } } },
  };
  const items = sync.itemsFromPayload(payload);
  assert.deepEqual(items['vault:v1'], { id: 'v1', name: 'Firma', user: 'admin' });
  assert.deepEqual(items['vs:v1'], { password: 'pw' });
  const withSecrets = sync.payloadFromItems(items, {}, true);
  assert.deepEqual(withSecrets.vault, payload.vault);
  assert.deepEqual(withSecrets.secrets.vault, { v1: { password: 'pw' } });
  const plain = sync.payloadFromItems(items, {}, false);
  assert.deepEqual(plain.vault, payload.vault);
  assert.equal(plain.secrets, null);
});
