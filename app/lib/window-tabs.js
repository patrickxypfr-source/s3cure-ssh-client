// Tabs zwischen Fenstern verschieben – die Verbindung bleibt dabei bestehen.
//
// Ablauf (Oberfläche: src/windows.js):
// 1. Quellfenster: 'win:move-begin' -> ab jetzt hält der Hauptprozess die Ereignisse des Tabs zurück
//    (ssh:data usw., app/lib/windows.js hold). Die Antwort kommt nach allen schon geschickten Daten.
// 2. Quellfenster: Terminal-Inhalt serialisieren, 'win:move' mit Zustand und Ziel
//    (anderes Fenster oder neues Fenster, optional an einer Bildschirmposition).
// 3. Zielfenster bekommt 'win:adopt' (ein neues Fenster erst, wenn es 'win:ready' meldet),
//    legt den Tab mit derselben ID an und meldet 'win:adopted' -> zurückgehaltene Ereignisse fließen.
// Kommt keine Bestätigung (Fenster hängt), werden die Ereignisse nach kurzer Zeit trotzdem freigegeben.
const { cleanPayload, windowAt } = require('./windows');

const ADOPT_TIMEOUT = 15_000;

function register({ ipcMain, screen, windows, createWindow, newWindow, windowInfo = () => null }) {
  const expected = new Map(); // webContents-ID eines neuen Fensters -> [Tab-Zustände]
  const timers = new Map();   // Tab-ID -> Sicherheits-Timer

  function releaseLater(tabId) {
    clearTimeout(timers.get(tabId));
    timers.set(tabId, setTimeout(() => { timers.delete(tabId); windows.release(tabId); }, ADOPT_TIMEOUT));
  }
  function release(tabId) {
    clearTimeout(timers.get(tabId));
    timers.delete(tabId);
    windows.release(tabId);
  }

  function deliver(wc, payload) {
    windows.setOwner(payload.id, wc); // ab jetzt gehört der Tab dem Zielfenster
    wc.send('win:adopt', payload);
    releaseLater(payload.id);
  }

  // Neues Fenster: Tab übergeben, sobald seine Oberfläche bereit ist
  function expect(wcId, payload) {
    if (!expected.has(wcId)) expected.set(wcId, []);
    expected.get(wcId).push(payload);
  }
  function forget(wcId) {
    // Neues Fenster ging zu, bevor es den Tab übernommen hat: Ereignisse wieder an die Quelle
    for (const p of expected.get(wcId) || []) release(p.id);
    expected.delete(wcId);
  }

  ipcMain.handle('win:new', () => { newWindow(); return true; });

  // Andere Fenster für „In Fenster … verschieben“
  ipcMain.handle('win:list', e => windows.list().map(w => {
    const info = windowInfo(w.wc) || {};
    const tabs = Array.isArray(info.tabs) ? info.tabs : [];
    return { id: w.id, no: w.no, self: w.id === e.sender.id, tabs: tabs.length, title: tabs[info.active || 0]?.title || null };
  }));

  ipcMain.handle('win:move-begin', (e, tabId) => {
    if (!windows.owns(e.sender, tabId) || windows.holding(tabId)) return false;
    windows.hold(tabId);
    releaseLater(tabId); // falls die Quelle danach nichts mehr schickt
    return true;
  });

  ipcMain.handle('win:move-abort', (e, tabId) => {
    if (windows.owns(e.sender, tabId)) release(tabId);
    return true;
  });

  // target: { wcId } oder { newWindow: true, at: { x, y } | null }
  ipcMain.handle('win:move', (e, raw, target = {}) => {
    const payload = cleanPayload(raw);
    if (!payload || !windows.owns(e.sender, payload.id) || !windows.holding(payload.id)) return false;
    const dest = target && Number.isInteger(target.wcId) && target.wcId !== e.sender.id && windows.has(target.wcId) ? windows.entry(target.wcId) : null;
    if (dest) {
      deliver(dest.wc, payload);
      if (dest.win.isMinimized()) dest.win.restore();
      dest.win.focus();
      return { wcId: dest.id };
    }
    const src = windows.windowOf(e.sender.id);
    const at = target && target.at && Number.isFinite(target.at.x) && Number.isFinite(target.at.y) ? target.at : null;
    const w = createWindow({ near: src, at, adopt: payload });
    return { wcId: w.webContents.id };
  });

  // Oberfläche eines (neuen) Fensters ist geladen
  ipcMain.handle('win:ready', e => {
    const list = expected.get(e.sender.id) || [];
    expected.delete(e.sender.id);
    for (const p of list) deliver(e.sender, p);
    return list.length;
  });

  ipcMain.handle('win:adopted', (e, tabId) => {
    if (windows.owns(e.sender, tabId)) release(tabId);
    return true;
  });

  // Tab wurde aus der Tab-Leiste gezogen und losgelassen: Wohin? (null = im eigenen Fenster)
  ipcMain.handle('win:drop-target', e => {
    const point = screen.getCursorScreenPoint();
    const src = windows.entry(e.sender.id);
    if (!src) return null;
    if (windowAt([src], point)) return null;
    const other = windowAt(windows.list(), point, src.id);
    return other ? { wcId: other.id } : { newWindow: true, at: point };
  });

  return { expect, forget };
}

module.exports = { register };
