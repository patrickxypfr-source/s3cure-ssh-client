// Eigene Befehlsknöpfe pro Verbindung – gespeichert in ~/.myssh/snippets.json
//
// Aufbau der Datei:
// { version: 1, migrated: true, profiles: { "<Verbindung>": { groups: [ { id, items: [...] } ] } } }
// Eintrag:  { id, type: 'button', label, cmd, tip, confirm, danger, live, inputs: { name: { prompt, kind, value } } }
// Menü:     { id, type: 'menu', label, tip, confirm, danger, items: [Einträge] }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAT = 's3cure-befehle';
const KINDS = ['ref', 'number', 'text'];
const PLACEHOLDER = /(?<!\$)\{([\p{L}_][\p{L}\p{N}_-]*)\}/gu;

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const id = v => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : crypto.randomUUID());

// confirm: false | true | "eigene Frage"
function cleanConfirm(v) {
  if (typeof v === 'string') return v.trim() ? str(v.trim(), 500) : false;
  return v === true;
}

function cleanButton(b) {
  if (!b || typeof b !== 'object') return null;
  const cmd = str(b.cmd, 4000);
  const label = str(b.label, 80).trim();
  if (!label && !cmd.trim()) return null;
  const inputs = {};
  const used = new Set([...cmd.matchAll(PLACEHOLDER)].map(m => m[1]));
  for (const name of used) {
    const src = (b.inputs && typeof b.inputs === 'object' && b.inputs[name]) || {};
    inputs[name] = {
      prompt: str(src.prompt, 300),
      kind: KINDS.includes(src.kind) ? src.kind : 'ref',
      value: str(src.value, 300),
    };
  }
  return {
    id: id(b.id), type: 'button', label: label || cmd.trim().slice(0, 30), cmd,
    tip: str(b.tip, 300), confirm: cleanConfirm(b.confirm), danger: !!b.danger, live: !!b.live, inputs,
  };
}

function cleanItem(it) {
  if (it && it.type === 'menu') {
    return {
      id: id(it.id), type: 'menu', label: str(it.label, 80).trim() || 'Menü',
      tip: str(it.tip, 300), confirm: cleanConfirm(it.confirm), danger: !!it.danger,
      items: (Array.isArray(it.items) ? it.items : []).slice(0, 100).map(cleanButton).filter(Boolean),
    };
  }
  return cleanButton(it);
}

// Leere Gruppen fallen weg
function cleanGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.slice(0, 100).map(g => ({
    id: id(g && g.id),
    items: (Array.isArray(g && g.items) ? g.items : []).slice(0, 200).map(cleanItem).filter(Boolean),
  })).filter(g => g.items.length);
}

// Neue IDs vergeben (beim Import oder Kopieren)
function freshIds(groups) {
  const re = it => ({ ...it, id: crypto.randomUUID(), ...(it.items ? { items: it.items.map(re) } : {}) });
  return groups.map(g => ({ id: crypto.randomUUID(), items: g.items.map(re) }));
}

// Import: akzeptiert eigenes Exportformat, { groups } oder direkt eine Liste von Gruppen
function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Die Datei ist kein gültiges JSON.'); }
  let groups = Array.isArray(data) ? data : data && (data.groups || (data.profile && data.profile.groups));
  if (!Array.isArray(groups)) throw new Error('In der Datei wurden keine Befehlsknöpfe gefunden.');
  // Liste von Knöpfen statt Gruppen -> eine Gruppe daraus machen
  if (groups.length && groups.every(g => g && (g.type === 'button' || g.type === 'menu' || 'cmd' in g))) groups = [{ items: groups }];
  const clean = freshIds(cleanGroups(groups));
  if (!clean.length) throw new Error('In der Datei wurden keine gültigen Befehlsknöpfe gefunden.');
  return clean;
}

function createStore(configDir) {
  const file = path.join(configDir, 'snippets.json');

  function load() {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = null; }
    const out = { version: 1, migrated: !!(data && data.migrated), profiles: {} };
    const profiles = data && data.profiles && typeof data.profiles === 'object' ? data.profiles : {};
    for (const [key, prof] of Object.entries(profiles)) out.profiles[key] = { groups: cleanGroups(prof && prof.groups) };
    return out;
  }

  function save(data) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file); // erst komplett schreiben, dann austauschen
  }

  return {
    file,
    load,
    saveProfile(key, profile) {
      const data = load();
      const groups = cleanGroups(profile && profile.groups);
      data.profiles[str(key, 300)] = { groups };
      save(data);
      return data.profiles[key];
    },
    // Einmalige Übernahme der alten s3-Leiste: nur Verbindungen ohne eigene Knöpfe
    migrate(profiles) {
      const data = load();
      if (data.migrated) return data;
      for (const [key, prof] of Object.entries(profiles || {})) {
        if (!data.profiles[key]) data.profiles[key] = { groups: freshIds(cleanGroups(prof && prof.groups)) };
      }
      data.migrated = true;
      save(data);
      return data;
    },
    rename(oldKey, newKey) {
      if (!oldKey || oldKey === newKey) return;
      const data = load();
      if (!data.profiles[oldKey]) return;
      data.profiles[newKey] = data.profiles[oldKey];
      delete data.profiles[oldKey];
      save(data);
    },
  };
}

// IPC einhängen. getWin: () => BrowserWindow (für Dialoge)
function register(ipcMain, { configDir, dialog, getWin }) {
  const store = createStore(configDir);
  ipcMain.handle('snippets:load', () => store.load());
  ipcMain.handle('snippets:save', (_e, key, profile) => store.saveProfile(key, profile));
  ipcMain.handle('snippets:migrate', (_e, profiles) => store.migrate(profiles));

  ipcMain.handle('snippets:export', async (_e, name, groups) => {
    const safe = String(name || 'befehle').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'befehle';
    const r = await dialog.showSaveDialog(getWin(), {
      title: 'Befehlsknöpfe exportieren',
      defaultPath: path.join(require('os').homedir(), 'Downloads', `befehle-${safe}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const data = { format: FORMAT, version: 1, name: String(name || ''), groups: cleanGroups(groups) };
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
    return r.filePath;
  });

  ipcMain.handle('snippets:import', async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: 'Befehlsknöpfe importieren', properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const stat = fs.statSync(r.filePaths[0]);
    if (stat.size > 2 * 1024 * 1024) throw new Error('Die Datei ist zu groß für eine Befehlsliste.');
    return parseImport(fs.readFileSync(r.filePaths[0], 'utf8'));
  });

  return store;
}

module.exports = { register, createStore, cleanGroups, parseImport, PLACEHOLDER };
