// S3cure SSH Client – Hinweis auf neue Version (kein automatisches Update)
//
// Fragt höchstens einmal pro Stunde die neueste GitHub-Release-Version ab.
// Ohne Antwort (offline, Limit) bleibt der letzte bekannte Stand.
// Einstellungen in ~/.myssh/update-check.json:
//   { "lastCheck": <ms>, "latest": {…}, "token": "<optional>" }
// Token alternativ über die Umgebungsvariable S3CURE_UPDATE_TOKEN (nur Lesezugriff nötig).
const fs = require('fs');
const path = require('path');
const { net } = require('electron');

const REPO = process.env.S3CURE_UPDATE_REPO || 'patrickxypfr-source/s3cure-ssh-client';
// S3CURE_UPDATE_URL nur für Tests (lokaler Server statt GitHub)
const API_URL = process.env.S3CURE_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const HOUR = 60 * 60 * 1000;

// "v1.2.10" > "1.2.9"; Vorabversionen ("1.3.0-beta") zählen nicht
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function setupUpdateCheck({ ipcMain, shell, app, configDir }) {
  const FILE = path.join(configDir, 'update-check.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
  const save = st => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(FILE, JSON.stringify(st, null, 2), { mode: 0o600 });
  };

  async function fetchLatest(token) {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'S3cure-SSH-Client' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await net.fetch(API_URL, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null; // 404 (privat/kein Release), 401, Limit … -> still nichts tun
    const data = await res.json();
    if (data.draft || data.prerelease) return null;
    const version = String(data.tag_name || '').replace(/^v/, '');
    if (!parseVersion(version)) return null;
    const url = /^https:\/\/github\.com\//.test(data.html_url || '') ? data.html_url : `https://github.com/${REPO}/releases/latest`;
    return { version, url, name: String(data.name || '') };
  }

  // Ergebnis für die Oberfläche – immer mit der eigenen Version:
  // { current, latest (oder null, wenn unbekannt), outdated }
  // GitHub wird höchstens einmal pro Stunde gefragt (ohne Anmeldung erlaubt GitHub 60 Abfragen/Stunde).
  async function check() {
    const st = load();
    const current = app.getVersion();
    if (!st.lastCheck || Date.now() - st.lastCheck > HOUR || st.lastCheck > Date.now()) {
      let latest = null;
      try { latest = await fetchLatest(process.env.S3CURE_UPDATE_TOKEN || st.token || null); } catch { latest = null; }
      // Keine Antwort (offline, Limit): letzten bekannten Stand behalten
      Object.assign(st, { lastCheck: Date.now(), latest: latest || st.latest || null });
      try { save(st); } catch {}
    }
    const latest = st.latest && parseVersion(st.latest.version) ? st.latest.version : null;
    return { current, latest, outdated: !!latest && isNewer(latest, current) };
  }

  ipcMain.handle('update:check', () => check().catch(() => ({ current: app.getVersion(), latest: null, outdated: false })));
  // Früher: Hinweis wegklicken/abschalten. Die Versionsanzeige ist jetzt immer da – Aufrufe ignorieren.
  ipcMain.handle('update:dismiss', () => {});
  ipcMain.handle('update:disable', () => {});
  ipcMain.handle('update:open', () => {
    const url = load().latest?.url;
    if (url && /^https:\/\/github\.com\//.test(url)) return shell.openExternal(url);
  });
}

module.exports = { setupUpdateCheck, isNewer, parseVersion };
