// S3cure SSH Client – Layout
// 1. Werkzeugleiste: wird stufenweise kompakter, wenn der Platz nicht reicht (misst die echte Breite
//    per ResizeObserver – egal ob das Fenster schmaler wird oder die Seitenleiste aufklappt).
// 2. Seitenleiste ein- und ausklappen (Knopf links in der Tab-Leiste, Cmd+B bzw. Strg+Umschalt+B).
// Wird als letztes Skript geladen: #term-tools (term-extra.js) und #sidebar-foot (settings.js) gibt es schon.
(() => {
  Object.assign(ICON_PATHS, {
    sidebar: 'M5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11A2.5 2.5 0 0 1 5.5 4z M9.5 4v16',
    more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  });

  // ================= Werkzeugleiste =================
  //
  // Stufen (jede Stufe behält die vorherigen):
  //   1  Server-Übersicht ohne Balken
  //   2  Server-Übersicht ohne Laufzeit
  //   3  Tunnel, Befehle, Neu verbinden nur als Symbol
  //   4  Server-Übersicht nur als Symbol (Klick zeigt alle Werte)
  //   5  Teilen / Mitschnitt / An alle wandern ins „⋯“-Menü
  //   6  Tunnel und Befehle ebenfalls ins „⋯“-Menü
  //   7  Terminal/Dateien nur als Symbol, Statustext darf ganz zusammenschrumpfen
  // Der Statustext wird ab Stufe 2 und 5 kürzer (…). Status und der Umschalter Terminal/Dateien bleiben immer sichtbar.
  const MAX_LEVEL = 7;
  const toolbar = $('#toolbar');
  const viewSwitch = $('#view-switch');

  const more = document.createElement('button');
  more.id = 'tb-more';
  more.type = 'button';
  more.className = 'btn ghost';
  more.title = 'Weitere Werkzeuge';
  more.innerHTML = icon('more');
  more.hidden = true;
  viewSwitch.before(more);

  // Tooltips für die Stufen, in denen nur noch Symbole zu sehen sind
  $('#btn-reconnect').title ||= 'Neu verbinden';
  $('#btn-quick').title ||= 'Befehle';
  for (const b of viewSwitch.querySelectorAll('button')) b.title ||= b.textContent.trim();

  // Was im „⋯“-Menü landen kann (in dieser Reihenfolge), ab welcher Stufe, und wie es heißt
  const OVERFLOW = [
    { sel: '#term-tools [data-t=split]', from: 5 },
    { sel: '#term-tools [data-t=log]', from: 5 },
    { sel: '#term-tools [data-t=all]', from: 5 },
    { sel: '#btn-tunnels', from: 6, sep: true },
    { sel: '#btn-quick', from: 6 },
  ];

  let level = 0;
  function setLevel(n) {
    level = n;
    for (let i = 1; i <= MAX_LEVEL; i++) toolbar.classList.toggle('c' + i, i <= n);
  }

  const visible = el => el && !el.hidden && !el.closest('[hidden]');

  function overflowItems() {
    return OVERFLOW.filter(o => level >= o.from).map(o => ({ ...o, el: $(o.sel) })).filter(o => visible(o.el));
  }

  function fitToolbar() {
    if (toolbar.hidden) return;
    mo.disconnect();
    // Statustext: so viel Platz, wie er braucht (höchstens 240 px), bevor andere Knöpfe schrumpfen
    const text = $('#tab-status-text');
    toolbar.style.setProperty('--status-w', Math.ceil(text.scrollWidth + 16) + 'px');
    more.hidden = true;
    let n = 0;
    for (; n <= MAX_LEVEL; n++) {
      setLevel(n);
      more.hidden = !overflowItems().length;
      if (toolbar.scrollWidth <= toolbar.clientWidth + 1) break;
    }
    if (n > MAX_LEVEL) setLevel(MAX_LEVEL);
    observe();
  }

  let queued = false;
  function queueFit() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fitToolbar(); });
  }

  new ResizeObserver(queueFit).observe(toolbar);
  // Inhalt ändert sich (Statustext, Server-Werte alle 5 s, Tunnel-Zähler, Knöpfe ein/aus)
  const mo = new MutationObserver(queueFit);
  const observe = () => mo.observe(toolbar, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  observe();
  document.fonts?.ready.then(queueFit);

  // ---------- „⋯“-Menü ----------

  function labelOf(el) {
    const lbl = el.querySelector('.lbl');
    let text = (lbl ? lbl.textContent : [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('')).trim();
    if (el.id === 'btn-tunnels') {
      const c = $('#tunnel-count');
      if (c && !c.hidden && c.textContent.trim()) text += ` (${c.textContent.trim()} aktiv)`;
    }
    if (el.classList.contains('on')) text += ' – an';
    return text || el.title;
  }

  // Manche Knöpfe öffnen ihr Fenster an der eigenen Position (z. B. Tunnel) –
  // dafür den versteckten Knopf kurz unsichtbar an die Stelle des „⋯“-Knopfs legen
  function clickAt(el) {
    const r = more.getBoundingClientRect();
    el.classList.add('tb-proxy');
    Object.assign(el.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    try { el.click(); } finally {
      el.classList.remove('tb-proxy');
      for (const k of ['left', 'top', 'width', 'height']) el.style[k] = '';
    }
  }

  // Zweiter Klick auf „⋯“ schließt das Menü wieder (mousedown blendet es schon aus)
  let ownItem = null, closing = false;
  more.addEventListener('mousedown', () => { const m = $('#ctx-menu'); closing = !m.hidden && !!ownItem && m.contains(ownItem); });
  more.addEventListener('click', () => {
    if (closing) { closing = false; return; }
    const items = overflowItems();
    const entries = [];
    items.forEach((o, i) => {
      if (o.sep && i > 0) entries.push(null);
      entries.push([labelOf(o.el), () => clickAt(o.el), o.el.classList.contains('rec') || o.el.classList.contains('alert') ? 'danger' : '', o.el.dataset.icon || 'more']);
    });
    const r = more.getBoundingClientRect();
    openMenu(entries, r.left, r.bottom + 6);
    // Gesperrte Knöpfe auch im Menü sperren, Tooltips übernehmen
    const btns = [...$('#ctx-menu').querySelectorAll('button')];
    ownItem = btns[0] || null;
    items.forEach((o, i) => { if (btns[i]) { btns[i].disabled = o.el.disabled; btns[i].title = o.el.title || ''; } });
  });

  // ================= Seitenleiste =================

  const KEY = 's3cure.sidebarCollapsed';
  const shortcut = IS_MAC ? 'Cmd+B' : 'Strg+Umschalt+B';
  const toggle = document.createElement('button');
  toggle.id = 'sb-toggle';
  toggle.type = 'button';
  toggle.className = 'mini-btn';
  toggle.innerHTML = icon('sidebar');
  $('#tabbar').prepend(toggle);

  const isCollapsed = () => document.body.classList.contains('sb-collapsed');

  function setCollapsed(on, animate = true) {
    if (!animate) document.body.classList.add('sb-no-anim');
    document.body.classList.toggle('sb-collapsed', on);
    toggle.title = `Seitenleiste ${on ? 'ausklappen' : 'einklappen'} (${shortcut})`;
    toggle.setAttribute('aria-pressed', String(on));
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
    if (!animate) requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('sb-no-anim')));
    if (!animate) refit();
  }

  // Terminals nach der Animation genau einpassen (ResizeObserver in renderer.js/term-extra.js
  // läuft zwar mit, aber erst am Ende stimmt die Breite)
  function refit() {
    requestAnimationFrame(() => {
      try { tabs.get(activeId)?.fit.fit(); } catch {}
      window.dispatchEvent(new Event('resize'));
      queueFit();
    });
  }
  $('#sidebar').addEventListener('transitionend', e => { if (e.target.id === 'sidebar' && e.propertyName === 'width') refit(); });

  toggle.addEventListener('click', () => setCollapsed(!isCollapsed()));
  // Eingeklappt: Klick aufs Logo klappt wieder aus
  $('#sidebar .brand').addEventListener('click', () => { if (isCollapsed()) setCollapsed(false); });

  window.addEventListener('keydown', e => {
    if (e.key.toLowerCase() !== 'b' || e.altKey) return;
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey;
    if (!mod || document.querySelector('.modal:not([hidden])')) return;
    e.preventDefault();
    e.stopPropagation();
    setCollapsed(!isCollapsed());
  }, true);

  // Eingeklappt sieht man nur das Symbol – Name und Adresse stehen im Tooltip
  function titleHosts() {
    for (const li of document.querySelectorAll('#host-list li')) {
      const name = li.querySelector('.host-name-text');
      if (name && !li.dataset.sbTitle) {
        const addr = li.querySelector('.host-addr')?.textContent || '';
        li.dataset.sbTitle = '1';
        li.title = `${name.textContent}${addr ? ' – ' + addr : ''}\n${li.title}`;
      } else if (li.classList.contains('host-group') && !li.title) {
        li.title = li.querySelector('.g-name')?.textContent || '';
      }
    }
  }
  new MutationObserver(titleHosts).observe($('#host-list'), { childList: true });
  titleHosts();

  let start = false;
  try { start = localStorage.getItem(KEY) === '1'; } catch {}
  setCollapsed(start, false);

  window.Layout = { fitToolbar: queueFit, setSidebarCollapsed: setCollapsed, isSidebarCollapsed: isCollapsed };
})();
