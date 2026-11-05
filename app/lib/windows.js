// Mehrere Fenster: Welches Fenster zeigt welchen Tab?
//
// Die Verbindungen (SSH, SFTP, FTP, Tunnel, Übertragungen …) gehören dem Hauptprozess, ein Fenster
// ist nur die Anzeige. Hier steht, welchem Fenster (webContents) ein Tab gerade gehört:
// - Ereignisse eines Tabs (ssh:data, transfer:update, tunnels:status …) gehen nur an sein Fenster
//   (sendTab), allgemeine (Update-Hinweis, Einstellungen, Host-Liste) an alle (sendAll).
// - Listen mit tabId (watch:status, extedit:status) bekommt jedes Fenster gefiltert (sendList).
// - Beim Verschieben eines Tabs werden seine Ereignisse kurz zurückgehalten (hold) und erst an das
//   neue Fenster geschickt, wenn es den Tab angelegt hat (release) – so geht keine Ausgabe verloren.
// - Für Dialoge und Rückfragen: das Fenster, aus dem die Anfrage kam (current). Dazu läuft jeder
//   IPC-Aufruf in einem AsyncLocalStorage-Kontext mit seinem Absender (wrapIpc).
// Ohne Electron testbar: Fenster sind Objekte mit webContents { id, send, isDestroyed }.
const { AsyncLocalStorage } = require('async_hooks');

function createWindowRegistry({ getFocused = () => null } = {}) {
  const wins = new Map();    // webContents-ID -> { win, wc, no }
  const owners = new Map();  // Tab-ID -> webContents-ID (bleibt nach dem Schließen des Tabs, z. B. für fertige Übertragungen)
  const transit = new Map(); // Tab-ID -> zurückgehaltene Nachrichten [[channel, args]]
  const moveListeners = [];
  const ctx = new AsyncLocalStorage();
  let lastFocused = null;

  const alive = wc => !!wc && !(wc.isDestroyed && wc.isDestroyed());
  const entry = wcId => wins.get(wcId) || null;

  // Fensternummer für Menüs („Fenster 2“): kleinste freie Nummer
  function nextNo() {
    const used = new Set([...wins.values()].map(e => e.no));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  function add(win) {
    const wc = win.webContents;
    const e = { win, wc, id: wc.id, no: nextNo() };
    wins.set(wc.id, e);
    if (!lastFocused) lastFocused = wc.id;
    win.on?.('focus', () => { lastFocused = wc.id; });
    return e;
  }

  // Fenster ist weg: seine Tabs vergessen und zurückgeben (zum Schließen der Verbindungen)
  function remove(wcId) {
    const tabIds = tabsOf(wcId);
    for (const id of tabIds) { owners.delete(id); transit.delete(id); }
    wins.delete(wcId);
    if (lastFocused === wcId) lastFocused = [...wins.keys()].pop() || null;
    return tabIds;
  }

  // Fenster lädt neu: seine Tabs sind weg (Rückgabe: deren IDs)
  function clearTabs(wcId) {
    const tabIds = tabsOf(wcId);
    for (const id of tabIds) { owners.delete(id); transit.delete(id); }
    return tabIds;
  }

  const has = wcId => wins.has(wcId);
  const list = () => [...wins.values()].filter(e => alive(e.wc) && !(e.win.isDestroyed && e.win.isDestroyed()));
  const windowOf = wcId => entry(wcId)?.win || null;

  function setOwner(tabId, wc) {
    if (!tabId || !wc) return;
    const id = typeof wc === 'number' ? wc : wc.id;
    if (!wins.has(id)) return; // z. B. Update-Fenster
    const before = owners.get(tabId);
    owners.set(tabId, id);
    if (before !== undefined && before !== id) for (const fn of moveListeners) { try { fn(tabId, id, before); } catch (err) { console.error(err); } }
  }
  const ownerId = tabId => (owners.has(tabId) ? owners.get(tabId) : null);
  const ownerWc = tabId => { const e = entry(ownerId(tabId)); return e && alive(e.wc) ? e.wc : null; };
  const tabsOf = wcId => [...owners].filter(([, w]) => w === wcId).map(([t]) => t);
  const owns = (wc, tabId) => !!wc && ownerId(tabId) === wc.id;

  function sendTab(tabId, channel, ...args) {
    const q = transit.get(tabId);
    if (q) { q.push([channel, args]); return; }
    const wc = ownerWc(tabId);
    if (wc) wc.send(channel, ...args);
  }

  function sendAll(channel, ...args) {
    for (const e of list()) e.wc.send(channel, ...args);
  }
  // An alle außer dem Absender (der hat es schon)
  function sendOthers(senderWc, channel, ...args) {
    for (const e of list()) if (!senderWc || e.id !== senderWc.id) e.wc.send(channel, ...args);
  }

  // Liste mit tabId-Feld: jedes Fenster bekommt nur die Einträge seiner Tabs
  function sendList(channel, items, key = 'tabId') {
    for (const e of list()) e.wc.send(channel, items.filter(it => ownerId(it[key]) === e.id && !transit.has(it[key])));
  }

  // ---------- Umzug eines Tabs ----------

  const hold = tabId => { if (!transit.has(tabId)) transit.set(tabId, []); };
  const holding = tabId => transit.has(tabId);
  function release(tabId) {
    const q = transit.get(tabId);
    if (!q) return;
    transit.delete(tabId);
    const wc = ownerWc(tabId);
    if (wc) for (const [channel, args] of q) wc.send(channel, ...args);
    for (const fn of moveListeners) { try { fn(tabId, ownerId(tabId), null); } catch (err) { console.error(err); } }
  }
  const onMove = fn => moveListeners.push(fn);

  // ---------- Absender eines IPC-Aufrufs ----------

  const sender = () => ctx.getStore()?.sender || null;

  // Fenster für Dialoge: Absender des laufenden Aufrufs, sonst das zuletzt aktive Hauptfenster
  function current() {
    const s = sender();
    const fromSender = s && entry(s.id);
    if (fromSender && alive(fromSender.wc)) return fromSender.win;
    const f = getFocused();
    if (f && !f.isDestroyed?.() && wins.has(f.webContents?.id)) return f;
    const last = entry(lastFocused);
    if (last && alive(last.wc)) return last.win;
    return list()[0]?.win || null;
  }

  // Jeder IPC-Aufruf läuft mit seinem Absender im Kontext (für Rückfragen und Dialoge)
  function wrapIpc(ipcMain) {
    if (ipcMain.__s3windows) return ipcMain;
    const { handle, on, once } = ipcMain;
    const wrap = fn => (e, ...args) => ctx.run({ sender: e && e.sender }, () => fn(e, ...args));
    ipcMain.handle = (channel, fn) => handle.call(ipcMain, channel, wrap(fn));
    ipcMain.on = (channel, fn) => on.call(ipcMain, channel, wrap(fn));
    ipcMain.once = (channel, fn) => once.call(ipcMain, channel, wrap(fn));
    ipcMain.__s3windows = true;
    return ipcMain;
  }
  const runAs = (wc, fn) => ctx.run({ sender: wc }, fn);

  return {
    add, remove, has, list, windowOf, entry,
    setOwner, ownerId, ownerWc, tabsOf, owns,
    sendTab, sendAll, sendOthers, sendList, clearTabs,
    hold, holding, release, onMove,
    sender, current, wrapIpc, runAs,
  };
}

// Neues Fenster etwas versetzt neben das aktuelle legen (wie in Browsern)
function cascade(bounds, display, step = 30) {
  if (!bounds) return {};
  const a = display || { x: 0, y: 0, width: Infinity, height: Infinity };
  let x = bounds.x + step;
  let y = bounds.y + step;
  if (x + bounds.width > a.x + a.width || y + bounds.height > a.y + a.height) { x = a.x + step; y = a.y + step; }
  return { x, y, width: bounds.width, height: bounds.height };
}

// Fenster unter einem Bildschirmpunkt (für „Tab aus der Leiste ziehen“)
function windowAt(entries, point, exceptId) {
  return entries.find(e => {
    if (e.id === exceptId || e.win.isMinimized?.()) return false;
    const b = e.win.getBounds();
    return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
  }) || null;
}

// Nur bekannte Felder einer Tab-Übergabe übernehmen (kommt aus der Oberfläche)
const VIEWS = ['terminal', 'files', 'dash'];
const STATES = ['open', 'connecting', 'reconnecting', 'closed'];
const MAX_SCREEN = 8 * 1024 * 1024; // Terminal-Inhalt höchstens 8 MB
function cleanPayload(p) {
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.spec || typeof p.spec !== 'object') return null;
  const s = (v, max = 1000) => (typeof v === 'string' ? v.slice(0, max) : null);
  const spec = {};
  for (const [k, v] of Object.entries(p.spec)) if (['string', 'number', 'boolean'].includes(typeof v) || v === null) spec[k] = v;
  return {
    id: p.id.slice(0, 100),
    spec,
    title: s(p.title, 300) || '',
    view: VIEWS.includes(p.view) ? p.view : 'terminal',
    state: STATES.includes(p.state) ? p.state : 'closed',
    info: p.info && typeof p.info === 'object' ? { user: s(p.info.user, 300), host: s(p.info.host, 300), port: Number(p.info.port) || 22 } : null,
    screen: typeof p.screen === 'string' && p.screen.length <= MAX_SCREEN ? p.screen : '',
    cols: Number.isInteger(p.cols) ? p.cols : null,
    rows: Number.isInteger(p.rows) ? p.rows : null,
    remotePath: s(p.remotePath),
    local: p.local && typeof p.local === 'object' ? { open: !!p.local.open, path: s(p.local.path), ...(Number.isFinite(p.local.w) ? { w: p.local.w } : {}) } : null,
    split: !!p.split,
    quick: s(p.quick, 5000),
  };
}

module.exports = { createWindowRegistry, cascade, windowAt, cleanPayload };
