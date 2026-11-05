// Mehrere Fenster: „Neues Fenster“ und Tabs zwischen Fenstern verschieben.
// Rechtsklick auf einen Tab, Tab aus der Tab-Leiste herausziehen (neues Fenster) oder auf ein
// anderes Fenster ziehen. Die Verbindung bleibt dabei bestehen: Sie gehört dem Hauptprozess
// (app/lib/windows.js, app/lib/window-tabs.js), das Fenster zeigt sie nur an. Der Terminal-Inhalt
// wird mit @xterm/addon-serialize mitgenommen und im neuen Fenster neu gezeichnet.
// Nutzt aus renderer.js: tabs, activeId, openTab, disposeTab, setState, setView, loadDir, openMenu, showError, askLocal.
window.WindowTabs = (() => {
  const W = window.s3windows;
  if (!W) return null;
  const MIME = 'application/x-s3cure-tab';
  const SCROLLBACK = 5000; // so viele Zeilen Verlauf nehmen wir mit

  Object.assign(ICON_PATHS, {
    window: 'M4 4.5h16A1.5 1.5 0 0 1 21.5 6v12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V6A1.5 1.5 0 0 1 4 4.5z M2.5 9h19',
    windowMove: 'M4 4.5h16A1.5 1.5 0 0 1 21.5 6v12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V6A1.5 1.5 0 0 1 4 4.5z M2.5 9h19 M9 14.5h7 M13.5 12l2.5 2.5-2.5 2.5',
  });

  const newWindow = () => W.newWindow().catch(err => console.error(err));

  // ---------- Tab einpacken ----------

  async function payloadOf(tab) {
    await new Promise(r => tab.term.write('', r)); // noch ausstehende Ausgabe erst ins Terminal
    let screen = '';
    try {
      const ser = new SerializeAddon.SerializeAddon();
      tab.term.loadAddon(ser);
      screen = ser.serialize({ scrollback: SCROLLBACK });
      ser.dispose();
    } catch (err) { console.error('Terminal-Inhalt nicht übernommen', err); }
    return {
      id: tab.id, spec: tab.spec, title: tab.title, view: tab.view, state: tab.state, info: tab.info || null,
      screen, cols: tab.term.cols, rows: tab.term.rows,
      remotePath: tab.files.path || null,
      local: window.LocalPane?.state?.(tab) || null,
      split: !!window.TermExtra?.isSplit?.(tab),
    };
  }

  // target: { wcId } (anderes Fenster) oder { newWindow: true, at: { x, y } }
  async function moveTab(id, target) {
    const tab = tabs.get(id);
    if (!tab || tab.moving) return false;
    if (tab.state === 'connecting' || tab.state === 'reconnecting') { showError(t('windows.waitConnecting')); return false; }
    if (Editor.isDirty(tab)) {
      if (activeId !== id) activate(id);
      if (tab.view !== 'files') setView('files');
      if (!(await Editor.confirmDiscard(tab))) return false;
    }
    tab.moving = true;
    if (!(await W.moveBegin(id))) { tab.moving = false; return false; }
    try {
      const r = await W.move(await payloadOf(tab), target);
      if (!r) throw new Error(t('windows.moveFailed'));
    } catch (err) {
      tab.moving = false;
      await W.moveAbort(id).catch(() => {});
      showError(err);
      return false;
    }
    disposeTab(tab); // Verbindung bleibt offen – sie gehört jetzt dem anderen Fenster
    window.SessionRestore?.save?.();
    // Letzten Tab in ein anderes Fenster gezogen: dieses leere Fenster schließen (wie im Browser)
    if (!tabs.size && target && target.wcId != null) setTimeout(() => window.close(), 50);
    return true;
  }

  // ---------- Tab übernehmen ----------

  async function adopt(p) {
    if (tabs.has(p.id)) { W.adopted(p.id); return; }
    const tab = openTab(p.spec, p.title, p.view, { connect: false, id: p.id });
    try {
      if (p.cols && p.rows) tab.term.resize(p.cols, p.rows); // wie im alten Fenster, dann neu einpassen
      if (p.screen) tab.term.write(p.screen);
      tab.info = p.info || null;
      if (p.remotePath) tab.files.path = p.remotePath;
      setState(tab, p.state === 'open' ? 'open' : 'closed');
    } finally {
      W.adopted(p.id); // ab jetzt kommen die zurückgehaltenen Ausgaben
    }
    requestAnimationFrame(() => { if (tab.id === activeId) tab.fit.fit(); });
    if (tab.state === 'open') {
      if (tab.view === 'files') loadDir(tab, tab.files.path || '~');
      if (p.split) { try { await window.TermExtra?.openSplit?.(tab); } catch (err) { console.error(err); } }
    }
    if (typeof Transfers !== 'undefined') Transfers.refresh?.(); // Übertragungen dieses Tabs anzeigen
  }

  W.onAdopt(p => { adopt(p).catch(err => console.error('Tab nicht übernommen', err)); });

  // ---------- Rechtsklick und Ziehen ----------

  async function otherWindows() {
    try { return (await W.list()).filter(w => !w.self); } catch { return []; }
  }

  const windowLabel = w => (w.title ? t('windows.windowNamed', { no: w.no, title: w.title }) : t('windows.windowNo', { no: w.no }));

  async function showMenu(tab, x, y) {
    const others = await otherWindows();
    const entries = [];
    if (tabs.size > 1) entries.push([t('windows.moveToNew'), () => moveTab(tab.id, { newWindow: true }), '', 'windowMove']);
    for (const w of others) entries.push([t('windows.moveTo', { window: windowLabel(w) }), () => moveTab(tab.id, { wcId: w.id }), '', 'window']);
    if (entries.length) entries.push(null);
    entries.push([t('windows.newWindow'), newWindow, '', 'plus']);
    entries.push([t('palette.actCloseTab'), () => closeTab(tab.id), '', 'close']);
    openMenu(entries, x, y);
  }

  function attach(tab) {
    const el = tab.tabEl;
    el.draggable = true;
    el.addEventListener('contextmenu', e => { e.preventDefault(); activate(tab.id); showMenu(tab, e.clientX, e.clientY); });
    el.addEventListener('dragstart', e => {
      if (e.target.closest('.close')) { e.preventDefault(); return; }
      // Nur eigener Typ – kein Text, sonst landet der Tab-Name in Eingabefeldern oder als Textschnipsel im Finder
      e.dataTransfer.setData(MIME, tab.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging-tab');
    });
    el.addEventListener('dragend', async () => {
      el.classList.remove('dragging-tab');
      // Wohin losgelassen? Der Hauptprozess kennt die Mausposition und alle Fenster.
      let target = null;
      try { target = await W.dropTarget(); } catch {}
      if (!target || !tabs.has(tab.id)) return;
      if (target.newWindow && tabs.size < 2) return; // einziger Tab: Fenster bleibt, wie es ist
      moveTab(tab.id, target);
    });
  }

  // ---------- Befehlspalette ----------

  let paletteWindows = [];
  window.Palette?.register(() => {
    otherWindows().then(list => { paletteWindows = list; }); // für das nächste Öffnen
    const A = (id, label, ic, run, keywords) => ({ key: 'act:' + id, section: 'actions', icon: ic, label, run, keywords });
    const list = [A('new-window', t('windows.newWindow'), 'plus', newWindow, 'fenster neu window new')]; // i18n-ignore
    const tab = tabs.get(activeId);
    if (tab && tabs.size > 1) list.push(A('tab-new-window', t('windows.moveToNew'), 'windowMove', () => moveTab(tab.id, { newWindow: true }), 'tab fenster verschieben abtrennen move detach window')); // i18n-ignore
    if (tab) {
      for (const w of paletteWindows) {
        list.push(A('tab-to-' + w.id, t('windows.moveTo', { window: windowLabel(w) }), 'window', () => moveTab(tab.id, { wcId: w.id }), 'tab fenster verschieben move window')); // i18n-ignore
      }
    }
    return list;
  });
  otherWindows().then(list => { paletteWindows = list; });

  // Oberfläche steht: Tabs übernehmen, die für dieses neue Fenster bereitliegen
  window.addEventListener('DOMContentLoaded', () => { W.ready().catch(err => console.error(err)); });

  return { newWindow, moveTab, attach };
})();
