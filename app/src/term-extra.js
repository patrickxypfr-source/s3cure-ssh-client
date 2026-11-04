// S3cure SSH Client – Terminal-Extras
// Einstellungen fürs Terminal, Schriftgröße per Tastatur, Suche, anklickbare Links,
// geteilte Ansicht, Mitschnitt und „An alle senden“.
// Eingehängt in renderer.js über TermExtra.attach/detach/update.
(() => {
  const X = window.mysshTerm;
  const MOD = IS_MAC ? 'Cmd' : 'Strg';

  Object.assign(ICON_PATHS, {
    split: 'M5 4.5h14A2.5 2.5 0 0 1 21.5 7v10a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 17V7A2.5 2.5 0 0 1 5 4.5z M12 4.5v15',
    record: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
    broadcast: 'M12 12h.01 M8.5 8.5a5 5 0 0 0 0 7 M15.5 8.5a5 5 0 0 1 0 7 M5.6 5.6a9 9 0 0 0 0 12.8 M18.4 5.6a9 9 0 0 1 0 12.8',
    chevUp: 'M7 14l5-5 5 5',
  });

  // ---------- Einstellungen ----------

  const DEFAULT_FONT = '"SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, monospace';
  const FONTS = ['SF Mono', 'Menlo', 'Monaco', 'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Lucida Console',
    'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Hack', 'IBM Plex Mono', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Courier New'];
  const DEFAULT_SIZE = 13;
  const MIN_SIZE = 8, MAX_SIZE = 32;

  let fontCtx = null;
  function fontInstalled(name) {
    fontCtx = fontCtx || document.createElement('canvas').getContext('2d');
    const sample = 'mmmmmmmmmwwwwwlli10OO@@';
    return ['monospace', 'serif', 'sans-serif'].some(base => {
      fontCtx.font = `40px ${base}`;
      const w = fontCtx.measureText(sample).width;
      fontCtx.font = `40px "${name}", ${base}`;
      return fontCtx.measureText(sample).width !== w;
    });
  }

  registerSettingsSection({
    id: 'terminal', title: 'Terminal', icon: 'terminal', order: 10,
    defaults: {
      'term.fontSize': DEFAULT_SIZE, 'term.fontFamily': '', 'term.cursorStyle': 'block', 'term.cursorBlink': true,
      'term.scrollback': 10000, 'term.copyOnSelect': false, 'term.rightClickPaste': true,
    },
    fields: [
      { key: 'term.fontSize', type: 'range', label: 'Schriftgröße', min: MIN_SIZE, max: MAX_SIZE, unit: 'pt',
        hint: `Auch mit ${MOD} + Plus / Minus, ${MOD}+0 = Standard` },
      { key: 'term.fontFamily', type: 'select', label: 'Schriftart', hint: 'Nur installierte Schriften werden angeboten.',
        options: current => [['', 'Standard'], ...FONTS
          .map(f => [f, fontInstalled(f)])
          .filter(([f, ok]) => ok || f === current)
          .map(([f, ok]) => [f, ok ? f : f + ' (nicht installiert)'])] },
      { key: 'term.cursorStyle', type: 'segment', label: 'Cursor', options: [['block', 'Block'], ['bar', 'Strich'], ['underline', 'Unterstrich']] },
      { key: 'term.cursorBlink', type: 'toggle', label: 'Cursor blinkt' },
      { key: 'term.scrollback', type: 'select', label: 'Verlauf (Zeilen zum Zurückscrollen)',
        options: [[1000, '1.000'], [5000, '5.000'], [10000, '10.000'], [50000, '50.000'], [100000, '100.000']] },
      { key: 'term.copyOnSelect', type: 'toggle', label: 'Kopieren beim Markieren', hint: 'Markierter Text landet sofort in der Zwischenablage.' },
      { key: 'term.rightClickPaste', type: 'toggle', label: 'Rechtsklick fügt ein', hint: 'Ist Text markiert, kopiert der Rechtsklick ihn stattdessen.' },
    ],
  });

  const S = key => Settings.get(key);
  function termOptions() {
    const font = S('term.fontFamily');
    return {
      fontSize: S('term.fontSize'),
      fontFamily: font ? `"${font}", ${DEFAULT_FONT}` : DEFAULT_FONT,
      cursorStyle: S('term.cursorStyle'),
      cursorInactiveStyle: 'outline',
      cursorBlink: S('term.cursorBlink'),
      scrollback: S('term.scrollback'),
      rightClickSelectsWord: !S('term.rightClickPaste') && IS_MAC,
    };
  }

  // ---------- Zustand ----------

  const xs = new Map();        // Tab-ID -> Extras des Tabs
  const splitById = new Map(); // Split-ID -> Split
  let broadcast = false;

  function* allTerms() {
    for (const x of xs.values()) {
      yield { term: x.tab.term, fit: x.tab.fit };
      if (x.split) yield { term: x.split.term, fit: x.split.fit };
    }
  }

  function fitTab(x) {
    try { x.tab.fit.fit(); } catch {}
    if (x.split) try { x.split.fit.fit(); } catch {}
  }

  function applyAll() {
    const o = termOptions();
    for (const { term } of allTerms()) Object.assign(term.options, o);
    for (const x of xs.values()) fitTab(x);
  }
  Settings.onChange((_v, changed) => { if (changed.some(k => k.startsWith('term.'))) applyAll(); });
  darkQuery.addEventListener('change', () => {
    for (const x of xs.values()) { if (x.split) x.split.term.options.theme = termTheme(); if (x.searchQuery) runSearch(x, 0); }
  });

  // ---------- Gemeinsame Einrichtung pro Terminal ----------

  // Antworten des Terminals selbst (Cursorposition, Maus, Fokus …) nicht an andere weiterreichen
  const NOT_TYPED = [/^\x1b\[[?>]?[\d;]*[cnRtIO]$/, /^\x1b\][\s\S]*(\x07|\x1b\\)$/, /^\x1bP[\s\S]*\x1b\\$/, /^\x1b\[M[\s\S]{3}$/, /^\x1b\[<[\d;]+[Mm]$/];
  const typed = d => !NOT_TYPED.some(r => r.test(d));

  function setupTerm(x, term, pane, selfId, kind) {
    term.options.allowProposedApi = true; // nötig für die Treffer-Hervorhebung der Suche
    Object.assign(term.options, termOptions());
    const search = new SearchAddon.SearchAddon();
    term.loadAddon(search);
    search.onDidChangeResults(r => { if (x.searchTarget === kind) showCount(x, r); });
    term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => { e.preventDefault(); X.openLink(uri); }));

    // Kopieren beim Markieren
    let selTimer;
    term.onSelectionChange(() => {
      clearTimeout(selTimer);
      if (!S('term.copyOnSelect')) return;
      selTimer = setTimeout(() => { if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(() => {}); }, 120);
    });

    // Rechtsklick: Markierung kopieren, sonst einfügen (ersetzt das bisherige Windows-Verhalten)
    pane.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!S('term.rightClickPaste')) return;
      if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); }
      else navigator.clipboard.readText().then(t => { if (t) term.paste(t); }).catch(() => {});
    }, true);

    // An alle senden
    term.onData(d => { if (broadcast && typed(d)) sendToOthers(d, selfId); });

    // Welches Terminal im Tab zuletzt benutzt wurde (für Suche)
    term.textarea?.addEventListener('focus', () => {
      x.focus = kind;
      x.panes.main.classList.toggle('xt-focus', kind === 'main');
      if (x.split) x.split.el.classList.toggle('xt-focus', kind === 'split');
    });
    return search;
  }

  // ---------- Einhängen in renderer.js ----------

  function attach(tab) {
    // Terminal in einen eigenen Rahmen setzen, damit daneben ein zweites Platz hat
    const pane = document.createElement('div');
    pane.className = 'xt-pane xt-main';
    tab.el.classList.add('xt');
    tab.el.appendChild(pane);
    pane.appendChild(tab.term.element);

    const x = { tab, panes: { main: pane }, split: null, focus: 'main', log: null, searchTarget: 'main', searchQuery: '' };
    xs.set(tab.id, x);
    x.search = setupTerm(x, tab.term, pane, tab.id, 'main');
    x.ro = new ResizeObserver(() => requestAnimationFrame(() => fitTab(x)));
    x.ro.observe(tab.el);
    updateBroadcastBadge();
  }

  function detach(tab) {
    const x = xs.get(tab.id);
    if (!x) return;
    if (x.log) X.logStop(tab.id);
    if (x.split) { X.splitClose(x.split.id); removeSplit(x); }
    x.ro.disconnect();
    xs.delete(tab.id);
    updateBroadcastBadge();
  }

  // ---------- Werkzeugleiste ----------

  const tools = document.createElement('div');
  tools.id = 'term-tools';
  tools.innerHTML = `
    <button class="btn ghost" data-t="split" data-icon="split" title="Zweites Terminal daneben öffnen (${IS_MAC ? 'Cmd+D' : 'Strg+Umschalt+D'})"><span class="lbl">Teilen</span></button>
    <button class="btn ghost" data-t="log" data-icon="record" title="Alles, was im Terminal passiert, als Textdatei mitschreiben"><span class="lbl">Mitschnitt</span></button>
    <button class="btn ghost" data-t="all" data-icon="broadcast" title="Tastatureingaben gleichzeitig an alle verbundenen Terminals schicken"><span class="lbl">An alle</span></button>`;
  applyIcons(tools);
  document.getElementById('view-switch').before(tools);
  const tbtn = name => tools.querySelector(`[data-t=${name}]`);

  function update(tab) {
    tools.hidden = !tab || tab.view !== 'terminal';
    updateBroadcastBadge();
    const x = tab && xs.get(tab.id);
    if (!x) return;
    const open = tab.state === 'open';
    tbtn('split').classList.toggle('on', !!x.split);
    tbtn('split').disabled = !open && !x.split;
    tbtn('log').classList.toggle('rec', !!x.log);
    tbtn('log').disabled = !open && !x.log;
    tbtn('log').lastChild.textContent = x.log ? 'Mitschnitt stoppen' : 'Mitschnitt';
    tbtn('log').title = x.log ? `Mitschnitt läuft:\n${x.log}\nKlicken zum Beenden` : 'Alles, was im Terminal passiert, als Textdatei mitschreiben';
  }

  const activeX = () => xs.get(activeId);
  tbtn('split').addEventListener('click', () => { const x = activeX(); if (x) toggleSplit(x); });
  tbtn('log').addEventListener('click', () => { const x = activeX(); if (x) toggleLog(x); });
  tbtn('all').addEventListener('click', () => setBroadcast(!broadcast));

  // ---------- Kleine Hinweise im Terminal ----------

  const toast = document.createElement('div');
  toast.className = 'xt-toast';
  toast.hidden = true;
  document.getElementById('terminals').appendChild(toast);
  let toastTimer;
  function showToast(text, action, ms = 2200) {
    toast.innerHTML = '';
    toast.append(Object.assign(document.createElement('span'), { textContent: text }));
    if (action) {
      const b = document.createElement('button');
      b.textContent = action[0];
      b.addEventListener('click', () => { toast.hidden = true; action[1](); });
      toast.appendChild(b);
    }
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, ms);
  }

  // ---------- Schriftgröße ----------

  X.onZoom(step => {
    if (Settings.isOpen()) return;
    const cur = S('term.fontSize');
    const size = step === 0 ? DEFAULT_SIZE : Math.max(MIN_SIZE, Math.min(MAX_SIZE, cur + step));
    if (size !== cur) Settings.set({ 'term.fontSize': size });
    if (xs.size) showToast(`Schriftgröße ${size} pt`, null, 1200);
  });

  // ---------- Suche ----------

  function searchColors() {
    const dark = darkQuery.matches;
    return {
      matchBackground: dark ? '#5a4614' : '#fde68a',
      matchOverviewRuler: '#d97706',
      activeMatchBackground: dark ? '#b45309' : '#fb923c',
      activeMatchBorder: dark ? '#f0353f' : '#e11d2a',
      activeMatchColorOverviewRuler: '#e11d2a',
    };
  }

  function searchAddonFor(x) {
    return x.searchTarget === 'split' && x.split ? x.split.search : x.search;
  }

  function buildSearchBar(x) {
    const bar = document.createElement('div');
    bar.className = 'xt-search';
    bar.innerHTML = `
      <span class="xt-search-ic">${icon('search')}</span>
      <input placeholder="Im Terminal suchen" spellcheck="false" autocomplete="off">
      <span class="xt-count"></span>
      <button class="mini-btn" data-s="prev" title="Vorheriger Treffer (Umschalt+Enter)">${icon('chevUp')}</button>
      <button class="mini-btn" data-s="next" title="Nächster Treffer (Enter)">${icon('down')}</button>
      <button class="mini-btn" data-s="close" title="Suche schließen (Esc)">${icon('close')}</button>`;
    x.tab.el.appendChild(bar);
    const input = bar.querySelector('input');
    input.addEventListener('input', () => { x.searchQuery = input.value; runSearch(x, 0); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); runSearch(x, e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(x); }
    });
    bar.querySelector('[data-s=prev]').addEventListener('click', () => runSearch(x, -1));
    bar.querySelector('[data-s=next]').addEventListener('click', () => runSearch(x, 1));
    bar.querySelector('[data-s=close]').addEventListener('click', () => closeSearch(x));
    x.searchBar = bar;
    x.searchInput = input;
    return bar;
  }

  // dir: 1 = weiter, -1 = zurück, 0 = beim Tippen (ab aktueller Stelle)
  function runSearch(x, dir) {
    const addon = searchAddonFor(x);
    const q = x.searchQuery;
    if (!q) { addon.clearDecorations(); showCount(x, null); return; }
    const opts = { decorations: searchColors(), incremental: dir === 0 };
    const found = dir < 0 ? addon.findPrevious(q, opts) : addon.findNext(q, opts);
    x.searchBar.classList.toggle('none', !found);
    if (!found) showCount(x, { resultIndex: -1, resultCount: 0 });
  }

  function showCount(x, r) {
    if (!x.searchBar) return;
    const el = x.searchBar.querySelector('.xt-count');
    if (!r || !x.searchQuery) el.textContent = '';
    else if (!r.resultCount) el.textContent = 'Keine Treffer';
    else el.textContent = r.resultIndex >= 0 ? `${r.resultIndex + 1} von ${r.resultCount}` : `${r.resultCount} Treffer`;
  }

  function openSearch(x) {
    if (!x.searchBar) buildSearchBar(x);
    const target = x.split && x.focus === 'split' ? 'split' : 'main';
    if (target !== x.searchTarget) { searchAddonFor(x).clearDecorations(); x.searchTarget = target; }
    x.searchBar.hidden = false;
    const term = target === 'split' ? x.split.term : x.tab.term;
    if (term.hasSelection() && !term.getSelection().includes('\n')) { x.searchInput.value = x.searchQuery = term.getSelection(); }
    x.searchInput.focus();
    x.searchInput.select();
    if (x.searchQuery) runSearch(x, 0);
  }

  function closeSearch(x) {
    if (!x.searchBar) return;
    x.searchBar.hidden = true;
    searchAddonFor(x).clearDecorations();
    (x.searchTarget === 'split' && x.split ? x.split.term : x.tab.term).focus();
  }

  // ---------- Geteilte Ansicht ----------

  function baseTermOptions() {
    return { lineHeight: 1.15, macOptionIsMeta: true, theme: termTheme(), ...termOptions() };
  }

  async function openSplit(x) {
    const tab = x.tab;
    if (x.split || tab.state !== 'open') return;
    const id = crypto.randomUUID();
    const divider = document.createElement('div');
    divider.className = 'xt-divider';
    divider.title = 'Ziehen zum Verschieben, Doppelklick = Mitte';
    const el = document.createElement('div');
    el.className = 'xt-pane xt-second';
    tab.el.classList.add('xt-split');
    tab.el.append(divider, el);

    const term = new Terminal(baseTermOptions());
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const split = { id, term, fit, el, divider, ready: false };
    x.split = split;
    splitById.set(id, split);
    split.search = setupTerm(x, term, el, id, 'split');
    if (!IS_MAC) addWindowsClipboard(term, el);
    term.onData(d => { if (split.ready) X.splitWrite(id, d); });
    term.onResize(({ cols, rows }) => { if (split.ready) X.splitResize(id, cols, rows); });
    dragDivider(x, divider);
    fitTab(x);
    update(tab);
    term.write(`\x1b[90mÖffne zweites Terminal …\x1b[0m\r\n`);
    try {
      await X.splitOpen(tab.id, id, term.cols, term.rows);
      if (x.split !== split) { X.splitClose(id); return; } // inzwischen wieder geschlossen
      split.ready = true;
      term.reset();
      term.focus();
    } catch (err) {
      removeSplit(x);
      showError(err);
    }
    updateBroadcastBadge();
  }

  function removeSplit(x) {
    const s = x.split;
    if (!s) return;
    if (x.searchTarget === 'split') { if (x.searchBar) x.searchBar.hidden = true; x.searchTarget = 'main'; }
    x.split = null;
    splitById.delete(s.id);
    s.term.dispose();
    s.divider.remove();
    s.el.remove();
    x.tab.el.classList.remove('xt-split');
    x.panes.main.classList.remove('xt-focus');
    x.focus = 'main';
    fitTab(x);
    if (activeId === x.tab.id) { update(x.tab); if (x.tab.view === 'terminal') x.tab.term.focus(); }
    updateBroadcastBadge();
  }

  async function toggleSplit(x) {
    if (!x.split) return openSplit(x);
    const ok = await askLocal({ kind: 'confirm', title: 'Zweites Terminal schließen?', message: 'Was dort gerade läuft, wird beendet.', okLabel: 'Schließen', danger: true });
    if (!ok || !x.split) return;
    X.splitClose(x.split.id);
    removeSplit(x);
  }

  function dragDivider(x, divider) {
    const el = x.tab.el;
    const setPct = pct => { el.style.setProperty('--xt-split', Math.max(15, Math.min(85, pct)) + '%'); requestAnimationFrame(() => fitTab(x)); };
    divider.addEventListener('pointerdown', e => {
      e.preventDefault();
      divider.setPointerCapture(e.pointerId);
      divider.classList.add('drag');
      const move = ev => { const r = el.getBoundingClientRect(); setPct((ev.clientX - r.left) / r.width * 100); };
      const up = () => {
        divider.classList.remove('drag');
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', up);
        divider.removeEventListener('pointercancel', up);
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up);
      divider.addEventListener('pointercancel', up);
    });
    divider.addEventListener('dblclick', () => setPct(50));
  }

  X.onSplitData((id, d) => splitById.get(id)?.term.write(d));
  X.onSplitClosed(id => {
    for (const x of xs.values()) if (x.split?.id === id) removeSplit(x);
  });

  // ---------- Mitschnitt ----------

  async function toggleLog(x) {
    const tab = x.tab;
    if (x.log) { await X.logStop(tab.id); tab.term.focus(); return; } // Rest erledigt onLogStopped
    if (tab.state !== 'open') return;
    try {
      const file = await X.logStart(tab.id, tab.title);
      if (!file) return; // abgebrochen
      x.log = file;
      tab.tabEl.classList.add('xt-rec');
      if (activeId === tab.id) update(tab);
      showToast('Mitschnitt läuft – ' + file.split(/[\\/]/).pop());
      tab.term.focus();
    } catch (err) { showError(err); }
  }

  X.onLogStopped((id, file) => {
    const x = xs.get(id);
    if (x) {
      x.log = null;
      x.tab.tabEl.classList.remove('xt-rec');
      if (activeId === id) update(x.tab);
    }
    showToast('Mitschnitt gespeichert: ' + file.split(/[\\/]/).pop(), [IS_MAC ? 'Im Finder zeigen' : 'Im Ordner zeigen', () => api.showFile(file)], 6000);
  });
  X.onLogError((_id, msg) => showError('Mitschnitt konnte nicht geschrieben werden: ' + msg));

  // ---------- An alle senden ----------

  const badge = document.createElement('div');
  badge.className = 'xt-broadcast-badge';
  badge.hidden = true;
  badge.innerHTML = `${icon('broadcast')}<span></span><button>Ausschalten</button>`;
  badge.querySelector('button').addEventListener('click', () => setBroadcast(false));
  document.getElementById('terminals').appendChild(badge);

  function targets() {
    const list = [];
    for (const x of xs.values()) {
      if (x.tab.state === 'open') list.push([x.tab.id, d => api.write(x.tab.id, d)]);
      if (x.split?.ready) list.push([x.split.id, d => X.splitWrite(x.split.id, d)]);
    }
    return list;
  }

  function sendToOthers(data, selfId) {
    for (const [id, write] of targets()) if (id !== selfId) write(data);
  }

  function updateBroadcastBadge() {
    document.body.classList.toggle('xt-broadcast', broadcast);
    tbtn('all').classList.toggle('alert', broadcast);
    badge.hidden = !broadcast;
    if (broadcast) badge.querySelector('span').textContent = `An alle senden ist an – Tastatureingaben gehen an ${targets().length} Terminals`;
  }

  function setBroadcast(on) {
    broadcast = on;
    updateBroadcastBadge();
    tabs.get(activeId)?.term.focus();
  }

  // ---------- Tastenkürzel ----------
  // Vor xterm und renderer.js abfangen (Capture-Phase)

  window.addEventListener('keydown', e => {
    if (document.querySelector('.modal:not([hidden])')) return;
    const tab = tabs.get(activeId);
    const x = tab && xs.get(tab.id);
    if (!x || tab.view !== 'terminal') return;
    const key = e.key.toLowerCase();
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey;
    const hit = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && !e.altKey && key === 'f') { hit(); openSearch(x); return; }
    if (mod && !e.altKey && key === 'd') { hit(); toggleSplit(x); return; }
    const searching = x.searchBar && !x.searchBar.hidden && x.searchQuery;
    if (searching && ((IS_MAC && e.metaKey && key === 'g') || e.key === 'F3')) { hit(); runSearch(x, e.shiftKey ? -1 : 1); }
  }, true);

  window.TermExtra = { attach, detach, update, setBroadcast, openSearch: () => activeX() && openSearch(activeX()) };
})();
