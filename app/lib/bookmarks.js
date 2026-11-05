// Lesezeichen für Ordner (src/file-nav.js): ~/.myssh/bookmarks.json
// { "remote": { "<Verbindung>": [{ "name": "Logs", "path": "/var/log" }] }, "local": [{ name, path }] }
// Server-Lesezeichen gehören zu einer Verbindung (Name aus hosts.json bzw. „user@host“),
// die Lesezeichen für „Mein Computer“ gelten für alle Verbindungen.
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');

const MAX_ITEMS = 200;
const MAX_KEYS = 500;

function clean(list) {
  if (!Array.isArray(list)) throw new Error(t('bookmarks.invalidList'));
  return list.slice(0, MAX_ITEMS).map(b => {
    const name = String(b?.name ?? '').trim().slice(0, 200);
    const p = String(b?.path ?? '');
    if (!p || p.length > 4096 || p.includes('\0')) throw new Error(t('bookmarks.invalidPath'));
    return { name: name || p, path: p };
  });
}

function create(configDir) {
  const file = path.join(configDir, 'bookmarks.json');

  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        remote: d && typeof d.remote === 'object' && !Array.isArray(d.remote) ? d.remote : {},
        local: Array.isArray(d?.local) ? d.local : [],
      };
    } catch { return { remote: {}, local: [] }; }
  }

  function save(data) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    // Erst in eine Hilfsdatei, dann umbenennen – bei einem Absturz geht nichts kaputt
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return data;
  }

  // scope: 'remote' (mit key = Verbindung) oder 'local'
  function set(scope, key, list) {
    const data = load();
    const items = clean(list);
    if (scope === 'local') data.local = items;
    else if (scope === 'remote') {
      if (typeof key !== 'string' || !key || key.length > 300) throw new Error(t('bookmarks.invalidConnection'));
      if (items.length) data.remote[key] = items; else delete data.remote[key];
      if (Object.keys(data.remote).length > MAX_KEYS) throw new Error(t('bookmarks.tooMany'));
    } else throw new Error(t('bookmarks.invalidScope'));
    return save(data);
  }

  // Verbindung umbenannt/gelöscht (hosts:save / hosts:delete in main.js)
  function rename(oldKey, newKey) {
    const data = load();
    if (!(oldKey in data.remote)) return;
    if (newKey) data.remote[newKey] = data.remote[oldKey];
    delete data.remote[oldKey];
    save(data);
  }

  return { file, load, set, rename, remove: key => rename(key, null) };
}

function register({ ipcMain, configDir }) {
  const store = create(configDir);
  ipcMain.handle('bookmarks:get', () => store.load());
  ipcMain.handle('bookmarks:set', (_e, scope, key, list) => store.set(scope, key, list));
  return store;
}

module.exports = { register, create };
