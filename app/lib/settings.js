// Einstellungen: ~/.myssh/settings.json lesen und schreiben (IPC settings:get / settings:set)
// Jede Sitzung/jedes Feature legt eigene Schlüssel ab; der Hauptprozess speichert alles,
// was JSON ist. Standardwerte kennt die Oberfläche (registerSettingsSection in src/settings.js).
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024;
const APPEARANCES = ['system', 'light', 'dark'];

function create(configDir) {
  const file = path.join(configDir, 'settings.json');
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch { cache = {}; }
    return cache;
  }

  function save(values) {
    const text = JSON.stringify(values, null, 2) + '\n';
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Einstellungen sind zu groß.');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    // Erst in eine Hilfsdatei schreiben, dann umbenennen – so geht bei einem Absturz nichts kaputt
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
    cache = values;
  }

  // patch: { schlüssel: wert } – null/undefined löscht den Schlüssel (= Standardwert)
  function set(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Ungültige Einstellungen.');
    const next = { ...load() };
    for (const [key, value] of Object.entries(patch)) {
      if (!/^[\w.-]{1,64}$/.test(key)) throw new Error(`Ungültiger Name: ${key}`);
      if (value === null || value === undefined) delete next[key];
      else next[key] = JSON.parse(JSON.stringify(value));
    }
    save(next);
    return next;
  }

  return { file, load: () => ({ ...load() }), set };
}

// Hell/Dunkel/System für das ganze Fenster (wirkt auch auf prefers-color-scheme im CSS)
function applyAppearance(nativeTheme, values) {
  const mode = APPEARANCES.includes(values.appearance) ? values.appearance : 'system';
  if (nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode;
}

function register({ app, ipcMain, nativeTheme, configDir }) {
  const store = create(configDir);
  app.whenReady().then(() => applyAppearance(nativeTheme, store.load()));
  ipcMain.handle('settings:get', () => store.load());
  ipcMain.handle('settings:set', (_e, patch) => {
    const values = store.set(patch);
    applyAppearance(nativeTheme, values);
    return values;
  });
  return store;
}

module.exports = { register, create };
