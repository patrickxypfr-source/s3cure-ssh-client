// Eigene Befehlsknöpfe pro Verbindung – gespeichert in ~/.myssh/snippets.json
//
// Aufbau der Datei:
// { version: 1, migrated: true, iconsMigrated: true, profiles: { "<Verbindung>": { groups: [ { id, items: [...] } ] } },
//   global: { groups: [...] } }   <- Knöpfe „Für alle Server“ (bei jeder Verbindung sichtbar)
// Eintrag:  { id, type: 'button', label, icon, cmd, tip, confirm, danger, live, inputs: { name: { prompt, kind, value } } }
// Menü:     { id, type: 'menu', label, icon, tip, confirm, danger, items: [Einträge] }
// icon: Name aus app/src/icons.js oder '' (kein Icon)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { t } = require('./i18n');

const FORMAT = 's3cure-befehle';
const KINDS = ['ref', 'number', 'text'];
const PLACEHOLDER = /(?<!\$)\{([\p{L}_][\p{L}\p{N}_-]*)\}/gu;

// Icon-Name: nur die Form wird hier geprüft. Die Icons selbst liegen in der Oberfläche
// (icons.js und weitere Dateien); dort werden unbekannte Namen ignoriert.
const cleanIcon = v => (typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(v) ? v : '');

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
    id: id(b.id), type: 'button', label: label || cmd.trim().slice(0, 30), icon: cleanIcon(b.icon), cmd,
    tip: str(b.tip, 300), confirm: cleanConfirm(b.confirm), danger: !!b.danger, live: !!b.live, inputs,
  };
}

function cleanItem(it) {
  if (it && it.type === 'menu') {
    return {
      id: id(it.id), type: 'menu', label: str(it.label, 80).trim() || t('snippets.defaultMenu'), icon: cleanIcon(it.icon),
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
  try { data = JSON.parse(text); } catch { throw new Error(t('snippets.invalidJson')); }
  let groups = Array.isArray(data) ? data : data && (data.groups || (data.profile && data.profile.groups));
  if (!Array.isArray(groups)) throw new Error(t('snippets.noButtons'));
  // Liste von Knöpfen statt Gruppen -> eine Gruppe daraus machen
  if (groups.length && groups.every(g => g && (g.type === 'button' || g.type === 'menu' || 'cmd' in g))) groups = [{ items: groups }];
  const clean = freshIds(cleanGroups(groups));
  if (!clean.length) throw new Error(t('snippets.noValidButtons'));
  return clean;
}

// Einmalige Nachrüstung: Knöpfe aus der Vorlage „s3cure“ (vor den Icons angelegt) bekommen ihr Icon.
// Erkannt am Befehl; Knöpfe, die schon ein Icon haben, bleiben unverändert.
const TEMPLATE_ICONS = {
  's3 status': 'pulse', 's3 check': 'checkCircle', 's3 update': 'sync', 's3 update-all': 'layers',
  's3 log': 'gitBranch', 's3 build': 'hammer', 's3 backup': 'archive', 's3 env': 'key',
};
// Menüs (alle Einträge mit demselben s3-Befehl) und einzelne Knöpfe wie „s3 restart bot“
const TEMPLATE_MENU_ICONS = {
  's3 restart': 'restart', 's3 start': 'play', 's3 stop': 'stop',
  's3 logs': 'logs', 's3 live': 'radio', 's3 rollback': 'undo',
};
const cmdKey = cmd => String(cmd || '').trim().split(/\s+/).slice(0, 2).join(' ');

function addTemplateIcons(groups) {
  let changed = 0;
  for (const g of groups) {
    for (const it of g.items) {
      if (it.icon) continue;
      let name = '';
      if (it.type === 'menu') {
        const keys = new Set(it.items.map(sub => cmdKey(sub.cmd)));
        if (keys.size === 1) name = TEMPLATE_MENU_ICONS[[...keys][0]] || '';
      } else if (!/\n/.test(it.cmd.trim())) {
        name = TEMPLATE_ICONS[it.cmd.trim().replace(/\s+/g, ' ')] || TEMPLATE_MENU_ICONS[cmdKey(it.cmd)] || '';
      }
      if (name) { it.icon = name; changed++; }
    }
  }
  return changed;
}

function createStore(configDir) {
  const file = path.join(configDir, 'snippets.json');
  let backedUp = false;

  function load() {
    let data = null;
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* gibt es noch nicht */ }
    if (text != null) {
      try { data = JSON.parse(text); } catch {
        // Beschädigt: Kopie behalten statt beim nächsten Speichern zu überschreiben
        if (!backedUp) { try { fs.copyFileSync(file, `${file}.defekt-${Date.now()}`); backedUp = true; } catch {} }
        data = { migrated: true, iconsMigrated: true, profiles: {} };
      }
    }
    const out = { version: 1, migrated: !!(data && data.migrated), iconsMigrated: true, profiles: {}, global: { groups: [] } };
    const profiles = data && data.profiles && typeof data.profiles === 'object' ? data.profiles : {};
    for (const [key, prof] of Object.entries(profiles)) out.profiles[key] = { groups: cleanGroups(prof && prof.groups) };
    if (data && data.global && typeof data.global === 'object') out.global = { groups: cleanGroups(data.global.groups) };
    // Datei von vor den Icons: einmal nachrüsten und gleich speichern (danach nie wieder)
    if (data && !data.iconsMigrated) {
      for (const prof of Object.values(out.profiles)) addTemplateIcons(prof.groups);
      try { save(out); } catch (err) { console.error('snippets.json: Icons nicht gespeichert', err); }
    }
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
    // Knöpfe „Für alle Server“
    saveGlobal(profile) {
      const data = load();
      data.global = { groups: cleanGroups(profile && profile.groups) };
      save(data);
      return data.global;
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
  ipcMain.handle('snippets:saveGlobal', (_e, profile) => store.saveGlobal(profile));
  ipcMain.handle('snippets:migrate', (_e, profiles) => store.migrate(profiles));

  ipcMain.handle('snippets:export', async (_e, name, groups) => {
    const safe = String(name || 'befehle').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'befehle';
    const r = await dialog.showSaveDialog(getWin(), {
      title: t('snippets.exportTitle'),
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
      title: t('snippets.importTitle'), properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const stat = fs.statSync(r.filePaths[0]);
    if (stat.size > 2 * 1024 * 1024) throw new Error(t('snippets.tooLarge'));
    return parseImport(fs.readFileSync(r.filePaths[0], 'utf8'));
  });

  return store;
}

module.exports = { register, createStore, cleanGroups, parseImport, addTemplateIcons, PLACEHOLDER };
