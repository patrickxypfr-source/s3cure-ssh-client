// S3cure SSH Client – Hinweis auf neue Version (kein automatisches Update)
//
// Fragt höchstens einmal pro Stunde die neueste GitHub-Release-Version ab.
// Ohne Antwort (offline, Limit) bleibt der letzte bekannte Stand.
// Einstellungen in ~/.myssh/update-check.json:
//   { "lastCheck": <ms>, "latest": {…}, "seenVersion": "1.2.0", "token": "<optional>" }
// seenVersion: zuletzt gestartete Version – ist die laufende neuer, zeigt die App einmal „Was ist neu?“
// Token alternativ über die Umgebungsvariable S3CURE_UPDATE_TOKEN (nur Lesezugriff nötig).
const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const { parseNotes, notesForLang } = require('./release-notes');
const i18n = require('./i18n');
// Release-Text in der Sprache der Oberfläche: deutscher oder englischer Teil (lib/release-notes.js)
const notesBlocks = md => parseNotes(notesForLang(md, i18n.lang()));

const REPO = process.env.S3CURE_UPDATE_REPO || 's3cureofficial/s3cure-ssh-client';
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
    // Download-Dateien für das automatische Update (nur aus diesem Repo; im Test auch lokal)
    const okAsset = u => assetAllowed(u, REPO, data.html_url) || (process.env.S3CURE_UPDATE_URL && /^http:\/\/127\.0\.0\.1:\d+\//.test(u));
    const assets = (Array.isArray(data.assets) ? data.assets : [])
      .map(a => ({ name: String(a.name || ''), url: String(a.browser_download_url || ''), size: Number(a.size) || 0 }))
      .filter(a => a.name && okAsset(a.url));
    // Release-Text (Markdown) für „Was ist neu?“ – wird erst bei der Anzeige in reine Text-Bausteine zerlegt
    const notes = String(data.body || '').slice(0, 20000);
    return { version, url, name: String(data.name || ''), notes, assets };
  }

  // Ergebnis für die Oberfläche – immer mit der eigenen Version:
  // { current, latest (oder null, wenn unbekannt), outdated }
  // GitHub wird höchstens einmal pro Stunde gefragt (ohne Anmeldung erlaubt GitHub 60 Abfragen/Stunde).
  async function check(force = false) {
    const st = load();
    const current = app.getVersion();
    if (force || !st.lastCheck || Date.now() - st.lastCheck > HOUR || st.lastCheck > Date.now()) {
      let latest = null;
      try { latest = await fetchLatest(process.env.S3CURE_UPDATE_TOKEN || st.token || null); } catch { latest = null; }
      // Keine Antwort (offline, Limit): letzten bekannten Stand behalten.
      // Frisch laden: während der Abfrage kann sich die Datei geändert haben (seenVersion)
      const fresh = load();
      Object.assign(fresh, { lastCheck: Date.now(), latest: latest || fresh.latest || st.latest || null });
      Object.assign(st, fresh);
      try { save(fresh); } catch {}
    }
    const latest = st.latest && parseVersion(st.latest.version) ? st.latest.version : null;
    return { current, latest, outdated: !!latest && isNewer(latest, current) };
  }

  ipcMain.handle('update:check', (_e, force) => check(!!force).catch(() => ({ current: app.getVersion(), latest: null, outdated: false })));
  // Früher: Hinweis wegklicken/abschalten. Die Versionsanzeige ist jetzt immer da – Aufrufe ignorieren.
  ipcMain.handle('update:dismiss', () => {});
  ipcMain.handle('update:disable', () => {});
  // Für lib/updater.js: frische Release-Infos inkl. Download-Dateien
  async function latestRelease() {
    await check(true);
    return load().latest || null;
  }

  // ---------- „Was ist neu?“ ----------

  // Nach dem ersten Start einer neuen Version: { version, notes: [Bausteine], url } – sonst null.
  // Bei einer frischen Installation (noch nie gestartet) wird nichts gezeigt.
  // Ohne Release-Text (offline) wird beim nächsten Start nochmal versucht.
  async function whatsNew() {
    const st = load();
    const current = app.getVersion();
    if (!st.seenVersion) {
      // Ältere Versionen kannten seenVersion noch nicht: lastCheck zeigt, dass die App schon lief
      if (!st.lastCheck) { markSeen(); return null; }
    } else if (!isNewer(current, st.seenVersion)) {
      if (st.seenVersion !== current) markSeen(); // ältere Version installiert – nichts zeigen
      return null;
    }
    let rel = st.latest && st.latest.version === current ? st.latest : null;
    if (!rel || !rel.notes) {
      await check(true).catch(() => {});
      const latest = load().latest;
      rel = latest && latest.version === current ? latest : null;
    }
    const notes = rel ? notesBlocks(rel.notes) : [];
    if (!notes.length) return null;
    return { version: current, notes, url: rel.url };
  }

  function markSeen() {
    const st = load();
    st.seenVersion = app.getVersion();
    try { save(st); } catch {}
  }

  // Für das Update-Fenster: Bausteine zum Release-Text einer Version (falls bekannt)
  function notesFor(version) {
    const latest = load().latest;
    return latest && latest.version === version ? notesBlocks(latest.notes) : [];
  }

  ipcMain.handle('update:whatsnew', () => whatsNew().catch(() => null));
  ipcMain.handle('update:whatsnew-seen', () => markSeen());

  ipcMain.handle('update:open', () => {
    const url = load().latest?.url;
    if (url && /^https:\/\/github\.com\//.test(url)) return shell.openExternal(url);
  });

  return { latestRelease, notesFor };
}

// Download-Adresse erlaubt? Nur aus diesem Repo. Wurde das GitHub-Konto umbenannt, leitet GitHub die
// Abfrage weiter und meldet das Release unter dem neuen Konto (html_url) – dann gilt auch dieses,
// solange der Repo-Name gleich bleibt.
function assetAllowed(url, repo, htmlUrl) {
  const repos = [repo];
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\//.exec(String(htmlUrl || ''));
  if (m && m[2].toLowerCase() === repo.split('/')[1].toLowerCase()) repos.push(`${m[1]}/${m[2]}`);
  const u = String(url || '');
  return repos.some(r => u.toLowerCase().startsWith(`https://github.com/${r}/releases/download/`.toLowerCase()));
}

module.exports = { setupUpdateCheck, isNewer, parseVersion, assetAllowed };
