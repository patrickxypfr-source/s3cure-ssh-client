// Benutzer, Anmeldung (Passwort + 2FA-Code), Sitzungen und Schutz vor Passwort-Raten.
// Rollen: admin (darf steuern und Benutzer verwalten), viewer (nur ansehen).
// Passwörter: scrypt mit Salz. Sitzungen: zufälliges Token im Cookie, gespeichert wird nur sein Hash.
const crypto = require('crypto');
const config = require('./config');
const totp = require('./totp');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;
const IDLE_DAYS = 14;
const MAX_FAILS_IP = 5;      // je IP in 15 Minuten
const MAX_FAILS_USER = 10;   // je Benutzer in 15 Minuten
const WINDOW = 15 * 60 * 1000;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPassword = (password, salt = crypto.randomBytes(16)) =>
  new Promise((resolve, reject) => crypto.scrypt(String(password), salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve({ salt: salt.toString('base64'), hash: key.toString('base64') }))));

function createAuth({ now = () => Date.now() } = {}) {
  let users = config.readJson('users.json', {});
  let sessions = config.readJson('sessions.json', {});
  const fails = new Map(); // "ip:<ip>" / "user:<name>" -> [Zeitpunkte]

  const saveUsers = () => config.writeJson('users.json', users);
  const saveSessions = () => config.writeJson('sessions.json', sessions);

  function failCount(key) {
    const list = (fails.get(key) || []).filter(t => now() - t < WINDOW);
    fails.set(key, list);
    return list.length;
  }
  const addFail = key => fails.set(key, [...(fails.get(key) || []), now()]);

  // ---------- Benutzer ----------
  async function addUser(name, password, role = 'viewer') {
    const n = String(name || '').toLowerCase();
    if (!NAME_RE.test(n)) throw new Error('Benutzername: 2–32 Zeichen, nur a–z, 0–9, Punkt, Strich, Unterstrich.');
    if (users[n]) throw new Error(`Benutzer „${n}“ gibt es schon.`);
    if (String(password || '').length < 10) throw new Error('Passwort: mindestens 10 Zeichen.');
    if (!['admin', 'viewer'].includes(role)) throw new Error('Rolle: admin oder viewer.');
    const pw = await hashPassword(password);
    const secret = totp.newSecret();
    users[n] = { ...pw, role, totp: secret, lastStep: -1, created: now() };
    saveUsers();
    return { name: n, secret, uri: totp.uri(secret, `${n}@${config.load().name}`) };
  }

  function removeUser(name) {
    const n = String(name).toLowerCase();
    if (!users[n]) throw new Error(`Benutzer „${n}“ gibt es nicht.`);
    delete users[n];
    saveUsers();
    for (const [k, s] of Object.entries(sessions)) if (s.user === n) delete sessions[k];
    saveSessions();
  }

  async function setPassword(name, password) {
    const n = String(name).toLowerCase();
    if (!users[n]) throw new Error(`Benutzer „${n}“ gibt es nicht.`);
    if (String(password || '').length < 10) throw new Error('Passwort: mindestens 10 Zeichen.');
    Object.assign(users[n], await hashPassword(password));
    saveUsers();
    logoutAll(n);
  }

  function resetTotp(name) {
    const n = String(name).toLowerCase();
    if (!users[n]) throw new Error(`Benutzer „${n}“ gibt es nicht.`);
    users[n].totp = totp.newSecret();
    users[n].lastStep = -1;
    saveUsers();
    logoutAll(n);
    return { name: n, secret: users[n].totp, uri: totp.uri(users[n].totp, `${n}@${config.load().name}`) };
  }

  const listUsers = () => Object.entries(users).map(([name, u]) => ({ name, role: u.role, created: u.created, lastLogin: u.lastLogin || null }));

  // ---------- Anmelden ----------
  // Prüft immer alles (auch bei unbekanntem Namen), damit man an der Dauer nichts ablesen kann
  async function login({ user, password, code, ip = '?', ua = '' }) {
    const n = String(user || '').toLowerCase();
    if (failCount('ip:' + ip) >= MAX_FAILS_IP || failCount('user:' + n) >= MAX_FAILS_USER) {
      return { ok: false, locked: true };
    }
    const u = users[n];
    const salt = u ? Buffer.from(u.salt, 'base64') : crypto.randomBytes(16);
    const { hash } = await hashPassword(password, salt);
    const pwOk = !!u && crypto.timingSafeEqual(Buffer.from(hash, 'base64'), Buffer.from(u.hash, 'base64'));
    const usedStep = u ? totp.verify(u.totp, code, { time: now(), lastStep: u.lastStep }) : null;
    if (!pwOk || usedStep == null) {
      addFail('ip:' + ip); addFail('user:' + n);
      return { ok: false };
    }
    fails.delete('user:' + n);
    u.lastStep = usedStep;
    u.lastLogin = now();
    saveUsers();
    const token = crypto.randomBytes(32).toString('base64url');
    sessions[sha(token)] = { user: n, created: now(), seen: now(), ip, ua: String(ua).slice(0, 200) };
    pruneSessions();
    saveSessions();
    return { ok: true, token, user: n, role: u.role };
  }

  // Zweiter Code für heikle Aktionen (z. B. Server neu starten)
  function confirmCode(name, code) {
    const u = users[name];
    if (!u) return false;
    const s = totp.verify(u.totp, code, { time: now(), lastStep: u.lastStep });
    if (s == null) { addFail('user:' + name); return false; }
    u.lastStep = s;
    saveUsers();
    return true;
  }

  function pruneSessions() {
    const t = now();
    for (const [k, s] of Object.entries(sessions)) {
      if (!users[s.user] || t - s.created > SESSION_DAYS * 864e5 || t - s.seen > IDLE_DAYS * 864e5) delete sessions[k];
    }
  }

  // Sitzung zum Token (oder null). Aktualisiert „zuletzt gesehen“ höchstens einmal pro Minute auf der Platte.
  function session(token) {
    if (!token) return null;
    const key = sha(token);
    const s = sessions[key];
    if (!s) return null;
    const t = now();
    if (!users[s.user] || t - s.created > SESSION_DAYS * 864e5 || t - s.seen > IDLE_DAYS * 864e5) { delete sessions[key]; saveSessions(); return null; }
    if (t - s.seen > 60000) { s.seen = t; saveSessions(); }
    return { user: s.user, role: users[s.user].role, key };
  }

  function logout(token) { delete sessions[sha(String(token || ''))]; saveSessions(); }
  function logoutAll(name) { for (const [k, s] of Object.entries(sessions)) if (s.user === name) delete sessions[k]; saveSessions(); }

  const reload = () => { users = config.readJson('users.json', {}); sessions = config.readJson('sessions.json', {}); };

  return { addUser, removeUser, setPassword, resetTotp, listUsers, login, confirmCode, session, logout, logoutAll, reload, hasUsers: () => Object.keys(users).length > 0 };
}

module.exports = { createAuth, hashPassword, NAME_RE };
