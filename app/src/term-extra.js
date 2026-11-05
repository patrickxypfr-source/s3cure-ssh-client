// S3cure SSH Client – Terminal-Extras
// Einstellungen fürs Terminal, Schriftgröße per Tastatur, Suche, anklickbare Links,
// geteilte Ansicht (bis zu 4 Terminals: nebeneinander, untereinander oder 2×2), Mitschnitt und „An alle senden“.
// Eingehängt in renderer.js über TermExtra.attach/detach/update.
(() => {
  const X = window.mysshTerm;
  const MOD = IS_MAC ? 'Cmd' : 'Strg';

  Object.assign(ICON_PATHS, {
    split: 'M5 4.5h14A2.5 2.5 0 0 1 21.5 7v10a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 17V7A2.5 2.5 0 0 1 5 4.5z M12 4.5v15',
    record: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
    broadcast: 'M12 12h.01 M8.5 8.5a5 5 0 0 0 0 7 M15.5 8.5a5 5 0 0 1 0 7 M5.6 5.6a9 9 0 0 0 0 12.8 M18.4 5.6a9 9 0 0 1 0 12.8',
    chevUp: 'M7 14l5-5 5 5',
    layoutCols: 'M5 4.5h14A2.5 2.5 0 0 1 21.5 7v10a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 17V7A2.5 2.5 0 0 1 5 4.5z M9 4.5v15 M15 4.5v15',
    layoutRows: 'M5 4.5h14A2.5 2.5 0 0 1 21.5 7v10a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 17V7A2.5 2.5 0 0 1 5 4.5z M2.5 12h19',
    layoutGrid: 'M5 4.5h14A2.5 2.5 0 0 1 21.5 7v10a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 17V7A2.5 2.5 0 0 1 5 4.5z M12 4.5v15 M2.5 12h19',
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
  const splitById = new Map(); // Split-ID -> zusätzliches Terminal
  const MAX_PANES = 4;         // Haupt-Terminal + 3 weitere
  let broadcast = false;

  function* allTerms() {
    for (const x of xs.values()) {
      yield { term: x.tab.term, fit: x.tab.fit };
      for (const s of x.splits) yield { term: s.term, fit: s.fit };
    }
  }

  function fitTab(x) {
    try { x.tab.fit.fit(); } catch {}
    for (const s of x.splits) try { s.fit.fit(); } catch {}
  }

  function applyAll() {
    const o = termOptions();
    for (const { term } of allTerms()) Object.assign(term.options, o);
    for (const x of xs.values()) fitTab(x);
  }
  Settings.onChange((_v, changed) => { if (changed.some(k => k.startsWith('term.'))) applyAll(); });
  darkQuery.addEventListener('change', () => {
    for (const x of xs.values()) { for (const s of x.splits) s.term.options.theme = termTheme(); if (x.searchQuery) runSearch(x, 0); }
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

    // Welches Terminal im Tab zuletzt benutzt wurde (für Suche, Schließen, Fokus-Rahmen)
    term.textarea?.addEventListener('focus', () => {
      x.focus = kind;
      x.panes.main.classList.toggle('xt-focus', kind === 'main');
      for (const s of x.splits) s.el.classList.toggle('xt-focus', s.id === kind);
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

    // splits: weitere Terminals; layout: vom Nutzer gewählte Anordnung (null = automatisch); sizes: Trenner-Positionen
    const x = { tab, panes: { main: pane }, splits: [], layout: null, sizes: { cols: [], rows: [], grid: { x: 0.5, y: 0.5 } }, dividers: [],
      focus: 'main', log: null, searchTarget: 'main', searchQuery: '' };
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
    for (const s of [...x.splits]) { X.splitClose(s.id); removeSplit(x, s); }
    x.ro.disconnect();
    xs.delete(tab.id);
    updateBroadcastBadge();
  }

  // ---------- Werkzeugleiste ----------

  const tools = document.createElement('div');
  tools.id = 'term-tools';
  tools.innerHTML = `
    <button class="btn ghost" data-t="split" data-icon="split" title="Weiteres Terminal daneben öffnen – bis zu ${MAX_PANES} (${IS_MAC ? 'Cmd+D' : 'Strg+Umschalt+D'})"><span class="lbl">Teilen</span></button>
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
    const n = x.splits.length;
    tbtn('split').classList.toggle('on', n > 0);
    tbtn('split').disabled = !open && !n;
    tbtn('split').title = n
      ? `${n + 1} Terminals – klicken für Anordnung, weiteres Terminal oder Schließen`
      : `Weiteres Terminal daneben öffnen – bis zu ${MAX_PANES} (${IS_MAC ? 'Cmd+D' : 'Strg+Umschalt+D'})`;
    tbtn('log').classList.toggle('rec', !!x.log);
    tbtn('log').disabled = !open && !x.log;
    tbtn('log').lastChild.textContent = x.log ? 'Mitschnitt stoppen' : 'Mitschnitt';
    tbtn('log').title = x.log ? `Mitschnitt läuft:\n${x.log}\nKlicken zum Beenden` : 'Alles, was im Terminal passiert, als Textdatei mitschreiben';
  }

  const activeX = () => xs.get(activeId);
  tbtn('split').addEventListener('click', e => { const x = activeX(); if (x) splitClick(x, e.currentTarget); });
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

  const splitOf = (x, id) => x.splits.find(s => s.id === id) || null;
  function searchAddonFor(x) {
    return splitOf(x, x.searchTarget)?.search || x.search;
  }
  const termFor = (x, id) => splitOf(x, id)?.term || x.tab.term;

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
    const target = splitOf(x, x.focus) ? x.focus : 'main';
    if (target !== x.searchTarget) { searchAddonFor(x).clearDecorations(); x.searchTarget = target; }
    x.searchBar.hidden = false;
    const term = termFor(x, target);
    if (term.hasSelection() && !term.getSelection().includes('\n')) { x.searchInput.value = x.searchQuery = term.getSelection(); }
    x.searchInput.focus();
    x.searchInput.select();
    if (x.searchQuery) runSearch(x, 0);
  }

  function closeSearch(x) {
    if (!x.searchBar) return;
    x.searchBar.hidden = true;
    searchAddonFor(x).clearDecorations();
    termFor(x, x.searchTarget).focus();
  }

  // ---------- Geteilte Ansicht (Raster) ----------
  // Haupt-Terminal + bis zu 3 weitere Shells auf derselben Verbindung. Anordnung:
  //   cols  nebeneinander (Standard bei 2 Terminals, wie bisher)
  //   rows  untereinander
  //   grid  2×2 (Standard ab 3 Terminals; bei 3 geht das dritte über die ganze Breite)
  // Die Felder liegen absolut im Tab; Trenner verschieben die Anteile, Doppelklick = gleich groß.

  const GAP = 14;

  function baseTermOptions() {
    return { lineHeight: 1.15, macOptionIsMeta: true, theme: termTheme(), ...termOptions() };
  }

  function modeOf(x) {
    const n = x.splits.length + 1;
    const want = x.layout || (n >= 3 ? 'grid' : 'cols');
    return want === 'grid' && n < 3 ? 'cols' : want;
  }

  // Anteile für nebeneinander/untereinander: bei neuer Anzahl gleichmäßig verteilen
  function fractions(x, mode, n) {
    let f = x.sizes[mode];
    if (f.length !== n) f = x.sizes[mode] = Array(n).fill(1 / n);
    return f;
  }

  // Rand innen um den halben Abstand einrücken, außen bündig
  function place(el, l, t, w, h) {
    const e = 1e-6;
    Object.assign(el.style, {
      left: `calc(${l * 100}% + ${l > e ? GAP / 2 : 0}px)`,
      top: `calc(${t * 100}% + ${t > e ? GAP / 2 : 0}px)`,
      right: `calc(${(1 - l - w) * 100}% + ${l + w < 1 - e ? GAP / 2 : 0}px)`,
      bottom: `calc(${(1 - t - h) * 100}% + ${t + h < 1 - e ? GAP / 2 : 0}px)`,
    });
  }

  // pos(): { at, from, to } als Anteile – wird bei jedem Neusetzen frisch berechnet
  function addDivider(x, vertical, pos, onMove, onReset) {
    const d = document.createElement('div');
    d.className = 'xt-divider ' + (vertical ? 'xt-v' : 'xt-h');
    d.title = 'Ziehen zum Verschieben, Doppelklick = gleich groß';
    d.reposition = () => {
      const { at, from, to } = pos();
      Object.assign(d.style, vertical
        ? { left: `calc(${at * 100}% - ${GAP / 2}px)`, top: `${from * 100}%`, bottom: `${(1 - to) * 100}%` }
        : { top: `calc(${at * 100}% - ${GAP / 2}px)`, left: `${from * 100}%`, right: `${(1 - to) * 100}%` });
    };
    d.reposition();
    const relayout = () => { layoutPanes(x); requestAnimationFrame(() => fitTab(x)); };
    d.addEventListener('pointerdown', e => {
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      d.classList.add('drag');
      const move = ev => {
        const r = x.tab.el.getBoundingClientRect();
        onMove(vertical ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height);
        relayout();
      };
      const up = () => {
        d.classList.remove('drag');
        d.removeEventListener('pointermove', move);
        d.removeEventListener('pointerup', up);
        d.removeEventListener('pointercancel', up);
      };
      d.addEventListener('pointermove', move);
      d.addEventListener('pointerup', up);
      d.addEventListener('pointercancel', up);
    });
    d.addEventListener('dblclick', () => { onReset(); relayout(); });
    x.tab.el.appendChild(d);
    x.dividers.push(d);
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function layoutPanes(x) {
    const el = x.tab.el;
    const panes = [x.panes.main, ...x.splits.map(s => s.el)];
    const n = panes.length;
    const mode = n > 1 ? modeOf(x) : null;
    el.classList.toggle('xt-split', n > 1);
    // Gleiche Anordnung wie vorher (z. B. beim Ziehen): Trenner nur verschieben, nicht neu anlegen
    const shape = `${mode}:${n}`;
    const rebuild = x.shape !== shape;
    x.shape = shape;
    if (rebuild) { for (const d of x.dividers) d.remove(); x.dividers = []; }
    if (n === 1) {
      delete el.dataset.layout;
      for (const k of ['left', 'top', 'right', 'bottom']) panes[0].style[k] = '';
      return;
    }
    el.dataset.layout = mode;

    if (mode === 'grid') {
      const g = x.sizes.grid;
      place(panes[0], 0, 0, g.x, g.y);
      place(panes[1], g.x, 0, 1 - g.x, g.y);
      if (n === 3) place(panes[2], 0, g.y, 1, 1 - g.y);
      else { place(panes[2], 0, g.y, g.x, 1 - g.y); place(panes[3], g.x, g.y, 1 - g.x, 1 - g.y); }
      if (rebuild) {
        addDivider(x, true, () => ({ at: g.x, from: 0, to: n === 3 ? g.y : 1 }), p => { g.x = clamp(p, 0.15, 0.85); }, () => { g.x = 0.5; });
        addDivider(x, false, () => ({ at: g.y, from: 0, to: 1 }), p => { g.y = clamp(p, 0.15, 0.85); }, () => { g.y = 0.5; });
      }
    } else {
      const vertical = mode === 'cols';
      const f = fractions(x, mode, n);
      let acc = 0;
      panes.forEach((p, i) => {
        if (vertical) place(p, acc, 0, f[i], 1); else place(p, 0, acc, 1, f[i]);
        acc += f[i];
      });
      if (rebuild) {
        const startOf = i => x.sizes[mode].slice(0, i).reduce((a, b) => a + b, 0);
        for (let i = 0; i < n - 1; i++) {
          addDivider(x, vertical, () => ({ at: startOf(i + 1), from: 0, to: 1 }), pos => {
            const fr = x.sizes[mode];
            const start = startOf(i), end = start + fr[i] + fr[i + 1];
            const at = clamp(pos, start + 0.1, end - 0.1);
            fr[i] = at - start;
            fr[i + 1] = end - at;
          }, () => { x.sizes[mode] = Array(n).fill(1 / n); });
        }
      }
    }
    for (const d of x.dividers) d.reposition();
  }

  async function addPane(x) {
    const tab = x.tab;
    if (tab.state !== 'open') return;
    if (x.splits.length + 1 >= MAX_PANES) { showToast(`Höchstens ${MAX_PANES} Terminals pro Tab`); return; }
    const id = crypto.randomUUID();
    const el = document.createElement('div');
    el.className = 'xt-pane xt-second';
    const close = document.createElement('button');
    close.className = 'mini-btn xt-pane-close';
    close.type = 'button';
    close.title = 'Dieses Terminal schließen';
    close.innerHTML = icon('close');
    tab.el.appendChild(el);

    const term = new Terminal(baseTermOptions());
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    el.appendChild(close);
    const split = { id, term, fit, el, ready: false };
    x.splits.push(split);
    splitById.set(id, split);
    split.search = setupTerm(x, term, el, id, id);
    if (!IS_MAC) addWindowsClipboard(term, el);
    term.onData(d => { if (split.ready) X.splitWrite(id, d); });
    term.onResize(({ cols, rows }) => { if (split.ready) X.splitResize(id, cols, rows); });
    close.addEventListener('mousedown', e => e.stopPropagation());
    close.addEventListener('click', () => closePane(x, split));
    layoutPanes(x);
    fitTab(x);
    update(tab);
    term.write(`\x1b[90mÖffne weiteres Terminal …\x1b[0m\r\n`);
    try {
      await X.splitOpen(tab.id, id, term.cols, term.rows);
      if (!x.splits.includes(split)) { X.splitClose(id); return; } // inzwischen wieder geschlossen
      split.ready = true;
      term.reset();
      fitTab(x);
      X.splitResize(id, term.cols, term.rows);
      term.focus();
    } catch (err) {
      removeSplit(x, split);
      showError(err);
    }
    updateBroadcastBadge();
  }

  function removeSplit(x, s) {
    if (!s || !x.splits.includes(s)) return;
    if (x.searchTarget === s.id) { if (x.searchBar) x.searchBar.hidden = true; x.searchTarget = 'main'; }
    x.splits = x.splits.filter(o => o !== s);
    splitById.delete(s.id);
    s.term.dispose();
    s.el.remove();
    layoutPanes(x);
    const focusNext = x.focus === s.id;
    if (focusNext || !x.splits.length) { x.focus = 'main'; x.panes.main.classList.toggle('xt-focus', x.splits.length > 0); }
    if (!x.splits.length) x.panes.main.classList.remove('xt-focus');
    requestAnimationFrame(() => fitTab(x));
    if (activeId === x.tab.id) { update(x.tab); if (x.tab.view === 'terminal' && focusNext) x.tab.term.focus(); }
    updateBroadcastBadge();
  }

  async function closePane(x, s) {
    const ok = await askLocal({ kind: 'confirm', title: 'Terminal schließen?', message: 'Was in diesem Terminal gerade läuft, wird beendet.', okLabel: 'Schließen', danger: true });
    if (!ok || !x.splits.includes(s)) return;
    X.splitClose(s.id);
    removeSplit(x, s);
  }

  async function closeAllPanes(x) {
    const n = x.splits.length;
    if (!n) return;
    const ok = await askLocal({ kind: 'confirm', title: n === 1 ? 'Zweites Terminal schließen?' : `${n} zusätzliche Terminals schließen?`, message: 'Was dort gerade läuft, wird beendet. Das Haupt-Terminal bleibt offen.', okLabel: 'Schließen', danger: true });
    if (!ok) return;
    for (const s of [...x.splits]) { X.splitClose(s.id); removeSplit(x, s); }
  }

  function setLayout(x, mode) {
    x.layout = mode;
    layoutPanes(x);
    requestAnimationFrame(() => fitTab(x));
    termFor(x, x.focus).focus();
  }

  // Klick auf „Teilen“: ohne weitere Terminals wie bisher eines daneben öffnen, sonst Menü
  function splitClick(x, btn) {
    if (!x.splits.length) return addPane(x);
    const n = x.splits.length + 1;
    const mode = modeOf(x);
    const cur = m => (mode === m ? 'xt-cur' : '');
    const entries = [];
    if (n < MAX_PANES) entries.push(['Weiteres Terminal öffnen', () => addPane(x), '', 'plus'], null);
    entries.push(['Nebeneinander', () => setLayout(x, 'cols'), cur('cols'), 'layoutCols']);
    entries.push(['Untereinander', () => setLayout(x, 'rows'), cur('rows'), 'layoutRows']);
    if (n >= 3) entries.push(['Raster 2×2', () => setLayout(x, 'grid'), cur('grid'), 'layoutGrid']);
    entries.push(null);
    const focused = splitOf(x, x.focus);
    if (focused) entries.push(['Aktives Terminal schließen …', () => closePane(x, focused), '', 'close']);
    entries.push([n === 2 ? 'Zweites Terminal schließen …' : 'Alle zusätzlichen schließen …', () => closeAllPanes(x), 'danger', 'close']);
    const r = btn.getBoundingClientRect();
    openMenu(entries, r.left, r.bottom + 6);
  }

  X.onSplitData((id, d) => splitById.get(id)?.term.write(d));
  X.onSplitClosed(id => {
    for (const x of xs.values()) { const s = splitOf(x, id); if (s) removeSplit(x, s); }
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
      for (const s of x.splits) if (s.ready) list.push([s.id, d => X.splitWrite(s.id, d)]);
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
    if (mod && !e.altKey && key === 'd') { hit(); addPane(x); return; }
    const searching = x.searchBar && !x.searchBar.hidden && x.searchQuery;
    if (searching && ((IS_MAC && e.metaKey && key === 'g') || e.key === 'F3')) { hit(); runSearch(x, e.shiftKey ? -1 : 1); }
  }, true);

  window.TermExtra = {
    attach, detach, update, setBroadcast,
    toggleBroadcast: () => setBroadcast(!broadcast),
    openSearch: () => activeX() && openSearch(activeX()),
    addPane: () => activeX() && addPane(activeX()),
    paneCount: tab => (xs.get(tab?.id)?.splits.length || 0) + 1,
    // Für session.js: geteiltes Terminal merken und wieder öffnen (Raster: mindestens ein Zusatzfeld)
    isSplit: tab => (xs.get(tab?.id)?.splits.length || 0) > 0,
    openSplit: tab => { const x = xs.get(tab.id); return x && !x.splits.length ? addPane(x) : undefined; },
  };
})();
