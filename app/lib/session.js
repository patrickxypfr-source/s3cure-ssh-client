// Sitzung wiederherstellen (wie bei Termius/MobaXterm): offene Tabs und Fenster merken
// Gespeichert in ~/.myssh/session.json:
// { version: 1, savedAt, window: { x, y, width, height, maximized, fullscreen },
//   tabs: [{ spec: { name } | { text }, title, view, remotePath, local: { open, path, w }, split }], active }
//
// Die Oberfläche (src/session.js) schickt laufend eine Momentaufnahme der Tabs ('session:update'),
// der Hauptprozess merkt sich zusätzlich Fensterposition und -größe. So ist beim Beenden –
// auch beim automatischen Update über app.quit() – immer der letzte Stand gespeichert.
const fs = require('fs');
const path = require('path');

const VIEWS = ['terminal', 'files'];
const MAX_TABS = 40;

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

function create(configDir) {
  const file = path.join(configDir, 'session.json');
  let data = null;

  function load() {
    if (data) return data;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      data = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch { data = {}; }
    data = { ...data, ...cleanSnapshot(data) };
    return data;
  }

  function save() {
    const d = { version: 1, ...load(), savedAt: new Date().toISOString() };
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file); // erst komplett schreiben, dann austauschen
  }

  function trySave() {
    try { save(); } catch (err) { console.error('session.json konnte nicht gespeichert werden', err); }
  }

  return {
    file,
    load,
    setTabs(snapshot) {
      const next = cleanSnapshot(snapshot);
      const d = load();
      if (JSON.stringify({ tabs: d.tabs, active: d.active }) === JSON.stringify(next)) return false;
      Object.assign(d, next);
      trySave();
      return true;
    },
    setWindow(w) {
      const d = load();
      if (JSON.stringify(d.window) === JSON.stringify(w)) return;
      d.window = w;
      trySave();
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

function register({ ipcMain, configDir }) {
  const store = create(configDir);
  let taken = false;

  // Einmal pro Programmstart: die gespeicherten Tabs (danach null, z. B. nach Neuladen des Fensters)
  ipcMain.handle('session:take', () => {
    if (taken) return null;
    taken = true;
    const d = store.load();
    return { tabs: d.tabs, active: d.active, savedAt: d.savedAt || null };
  });
  // Laufende Momentaufnahme aus der Oberfläche
  ipcMain.on('session:update', (_e, snapshot) => store.setTabs(snapshot));

  return {
    store,
    // Für new BrowserWindow({ ... }) in main.js
    windowOptions(screen, min) {
      return visibleBounds(store.load().window, screen, min);
    },
    // Fensterposition und -größe beim Ändern und vor dem Schließen merken
    track(win) {
      let timer = null;
      const remember = () => {
        clearTimeout(timer);
        if (!win || win.isDestroyed()) return;
        const b = win.getNormalBounds();
        store.setWindow({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
      };
      const later = () => { clearTimeout(timer); timer = setTimeout(remember, 600); };
      for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, later);
      win.on('close', remember);
      const w = store.load().window;
      if (w && w.maximized) win.maximize();
      if (w && w.fullscreen) win.setFullScreen(true);
    },
  };
}

module.exports = { register, create, cleanSnapshot, visibleBounds };
