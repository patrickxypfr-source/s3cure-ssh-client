// Sitzung wiederherstellen (wie bei Termius/MobaXterm): offene Fenster mit ihren Tabs merken
// Gespeichert in ~/.myssh/session.json:
// { version: 2, savedAt,
//   windows: [{ key, window: { x, y, width, height, maximized, fullscreen }, tabs: [...], active }],
//   window, tabs, active }   ← erstes Fenster noch einmal oben: ältere Versionen lesen nur das
// Ein Tab: { spec: { name } | { text }, title, view, remotePath, local: { open, path, w }, split }
//
// Jede Oberfläche (src/session.js) schickt laufend eine Momentaufnahme ihrer Tabs ('session:update'),
// der Hauptprozess merkt sich zusätzlich Position und Größe jedes Fensters. So ist beim Beenden –
// auch beim automatischen Update über app.quit() – immer der letzte Stand gespeichert.
// Ein Fenster schließen (während andere offen bleiben) vergisst es; beim Beenden der App und beim
// Schließen des letzten Fensters bleibt alles für den nächsten Start stehen.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIEWS = ['terminal', 'files'];
const MAX_TABS = 40;
const MAX_WINDOWS = 20;

const str = (v, max = 1000) => (typeof v === 'string' ? v.slice(0, max) : null);

// Nur bekannte Felder übernehmen – die Datei kommt aus der Oberfläche
function cleanTab(t) {
  if (!t || typeof t !== 'object' || !t.spec || typeof t.spec !== 'object') return null;
  const spec = str(t.spec.name, 300) ? { name: str(t.spec.name, 300) } : str(t.spec.text, 300) ? { text: str(t.spec.text, 300) } : null;
  if (!spec) return null;
  const local = t.local && typeof t.local === 'object'
    ? { open: !!t.local.open, path: str(t.local.path), ...(Number.isFinite(t.local.w) ? { w: t.local.w } : {}) }
    : null;
  return {
    spec,
    title: str(t.title, 300) || spec.name || spec.text,
    view: VIEWS.includes(t.view) ? t.view : 'terminal',
    remotePath: str(t.remotePath),
    local,
    split: !!t.split,
  };
}

function cleanSnapshot(snap) {
  const tabs = (Array.isArray(snap && snap.tabs) ? snap.tabs : []).slice(0, MAX_TABS).map(cleanTab).filter(Boolean);
  const active = Number.isInteger(snap && snap.active) && snap.active >= 0 && snap.active < tabs.length ? snap.active : 0;
  return { tabs, active };
}

function cleanBounds(w) {
  if (!w || typeof w !== 'object') return null;
  const out = {};
  for (const k of ['x', 'y', 'width', 'height']) if (Number.isFinite(w[k])) out[k] = Math.round(w[k]);
  if (w.maximized) out.maximized = true;
  if (w.fullscreen) out.fullscreen = true;
  return Object.keys(out).length ? out : null;
}

const newKey = () => crypto.randomBytes(6).toString('hex');

function cleanWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const key = typeof w.key === 'string' && /^[\w-]{1,40}$/.test(w.key) ? w.key : newKey();
  return { key, window: cleanBounds(w.window), ...cleanSnapshot(w) };
}

// Datei lesen; Format von Version 1 (ein Fenster) wird zu einem Eintrag in „windows“
function cleanData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { windows: [] };
  let windows = Array.isArray(d.windows) ? d.windows : [{ window: d.window, tabs: d.tabs, active: d.active }];
  windows = windows.slice(0, MAX_WINDOWS).map(cleanWindow).filter(Boolean);
  const seen = new Set();
  for (const w of windows) { if (seen.has(w.key)) w.key = newKey(); seen.add(w.key); }
  return { savedAt: str(d.savedAt, 40), windows };
}

function create(configDir) {
  const file = path.join(configDir, 'session.json');
  let data = null;

  function load() {
    if (data) return data;
    let d = null;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* noch keine Datei */ }
    data = cleanData(d);
    return data;
  }

  function save() {
    const d = load();
    const first = d.windows[0] || { window: null, tabs: [], active: 0 };
    const out = {
      version: 2, savedAt: new Date().toISOString(), windows: d.windows,
      window: first.window, tabs: first.tabs, active: first.active,
    };
    d.savedAt = out.savedAt;
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file); // erst komplett schreiben, dann austauschen
  }

  function trySave() {
    try { save(); } catch (err) { console.error('session.json konnte nicht gespeichert werden', err); }
  }

  const find = key => load().windows.find(w => w.key === key) || null;
  function ensure(key) {
    let w = find(key);
    if (!w) {
      w = { key, window: null, tabs: [], active: 0 };
      load().windows.push(w);
      if (load().windows.length > MAX_WINDOWS) load().windows.shift();
    }
    return w;
  }

  return {
    file,
    load,
    windows: () => load().windows.map(w => ({ ...w })),
    get: key => find(key),
    newKey,
    // Neues Fenster: Eintrag anlegen (noch ohne Tabs)
    add(key) { ensure(key); },
    setTabs(key, snapshot) {
      const next = cleanSnapshot(snapshot);
      const w = ensure(key);
      if (JSON.stringify({ tabs: w.tabs, active: w.active }) === JSON.stringify(next)) return false;
      Object.assign(w, next);
      trySave();
      return true;
    },
    setWindow(key, bounds) {
      const w = ensure(key);
      const b = cleanBounds(bounds);
      if (JSON.stringify(w.window) === JSON.stringify(b)) return;
      w.window = b;
      trySave();
    },
    remove(key) {
      const d = load();
      const i = d.windows.findIndex(w => w.key === key);
      if (i < 0) return;
      d.windows.splice(i, 1);
      trySave();
    },
    // Nur diese Fenster behalten (z. B. „Sitzung wiederherstellen“ aus: nur ein Fenster)
    keep(keys) {
      const d = load();
      const before = d.windows.length;
      d.windows = d.windows.filter(w => keys.includes(w.key));
      if (d.windows.length !== before) trySave();
    },
  };
}

// Gespeicherte Fenstergröße nur nehmen, wenn das Fenster noch auf einem Bildschirm liegt
// (z. B. externer Monitor inzwischen abgesteckt)
function visibleBounds(w, screen, min) {
  if (!w || ![w.width, w.height].every(Number.isFinite)) return {};
  const width = Math.max(min.width, Math.round(w.width));
  const height = Math.max(min.height, Math.round(w.height));
  if (![w.x, w.y].every(Number.isFinite)) return { width, height };
  const x = Math.round(w.x);
  const y = Math.round(w.y);
  let displays = [];
  try { displays = screen.getAllDisplays(); } catch { /* vor app ready */ }
  // Mindestens 120 × 60 Pixel der Titelleiste müssen sichtbar sein, sonst nur die Größe übernehmen
  const onScreen = displays.some(({ workArea: a }) =>
    Math.min(x + width, a.x + a.width) - Math.max(x, a.x) >= 120 && Math.min(y + 60, a.y + a.height) - Math.max(y, a.y) >= 30);
  if (!onScreen) return { width: Math.min(width, 1600), height: Math.min(height, 1000) };
  return { x, y, width, height };
}

// keyOf(webContents) -> Schlüssel des Fensters (main.js merkt sich, welches Fenster welcher Eintrag ist)
function register({ ipcMain, configDir, keyOf }) {
  const store = create(configDir);

  // Gespeicherte Tabs dieses Fensters. Auch nach dem Neuladen (z. B. Sprache umgestellt) –
  // die Oberfläche hat ihre Tabs dann vergessen und öffnet sie wieder.
  ipcMain.handle('session:take', e => {
    const key = keyOf(e.sender);
    const w = key && store.get(key);
    if (!w || !w.tabs.length) return null;
    return { tabs: w.tabs, active: w.active, savedAt: store.load().savedAt || null };
  });
  // Laufende Momentaufnahme aus der Oberfläche
  ipcMain.on('session:update', (e, snapshot) => {
    const key = keyOf(e.sender);
    if (key) store.setTabs(key, snapshot);
  });

  return {
    store,
    // Für new BrowserWindow({ ... }) in main.js: zuletzt benutzte Größe/Position dieses Fensters
    windowOptions(screen, min, key) {
      return visibleBounds(store.get(key)?.window, screen, min);
    },
    // Fensterposition und -größe beim Ändern und vor dem Schließen merken
    track(win, key) {
      store.add(key);
      let timer = null;
      const remember = () => {
        clearTimeout(timer);
        if (!win || win.isDestroyed()) return;
        const b = win.getNormalBounds();
        store.setWindow(key, { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
      };
      const later = () => { clearTimeout(timer); timer = setTimeout(remember, 600); };
      for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, later);
      win.on('close', remember);
      win.on('closed', () => clearTimeout(timer));
      const w = store.get(key)?.window;
      if (w && w.maximized) win.maximize();
      if (w && w.fullscreen) win.setFullScreen(true);
    },
  };
}

module.exports = { register, create, cleanSnapshot, cleanData, visibleBounds };
