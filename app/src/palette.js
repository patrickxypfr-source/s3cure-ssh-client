// S3cure SSH Client – Befehlspalette (Cmd+K bzw. Strg+K)
// Ein Suchfeld über allem: Verbindungen öffnen, zwischen Tabs wechseln, Befehlsknöpfe des aktiven
// Servers ausführen und Aktionen der App starten. Zuletzt Benutztes steht oben, die Suche ist unscharf
// („nvb“ findet „Neue Verbindung“).
// Andere Dateien können eigene Einträge beisteuern: Palette.register(() => [{ id, label, … }]).
// Wird nach layout.js geladen – renderer.js, quickbar.js, term-extra.js usw. sind schon da.
(() => {
  const RECENT_KEY = 's3cure.palette.recent';
  const MAX_RECENT = 8;
  const MAX_RESULTS = 60;
  const SHORTCUT = IS_MAC ? '⌘K' : t('palette.shortcutCtrl');

  // ---------- Einträge ----------
  // { key, section, label, detail, icon, keywords, run, alt?, altHint? }

  const SECTIONS = { recent: t('palette.secRecent'), tabs: t('palette.secTabs'), cmds: t('palette.secCmds'), hosts: t('palette.secHosts'), actions: t('palette.secActions') };
  const providers = [];

  const activeTab = () => tabs.get(activeId) || null;
  const openTab_ = () => { const t = activeTab(); return t && t.state === 'open' ? t : null; };
  const tool = sel => () => Layout.clickTool(document.querySelector(sel));

  function hostItems() {
    return Object.keys(hosts).sort((a, b) => a.localeCompare(b, I18N.locale)).map(name => {
      const h = hosts[name];
      const open = [...tabs.values()].some(t => t.spec.name === name && t.state === 'open');
      return {
        key: 'host:' + name, section: 'hosts', icon: 'server', label: name,
        detail: `${h.user}@${h.host}${h.port !== 22 ? ':' + h.port : ''}${h.group ? ' · ' + h.group : ''}${open ? t('palette.connectedSuffix') : ''}`,
        keywords: `verbinden connect ssh ${h.host} ${h.user} ${h.group || ''}`,
        run: () => openTab({ name }, name),
        alt: () => openTab({ name }, name, 'files'), altHint: t('palette.openFiles'),
      };
    });
  }

  function tabItems() {
    const state = { open: t('palette.stateOpen'), connecting: t('palette.stateConnecting'), reconnecting: t('palette.stateReconnecting'), closed: t('palette.stateClosed') };
    const views = { terminal: t('palette.viewTerminal'), files: t('palette.viewFiles'), dash: t('palette.viewDash') };
    return [...tabs.values()].map(tb => ({
      key: 'tab:' + tb.id, section: 'tabs', icon: tb.view === 'files' ? 'folder' : 'terminal', label: tb.title,
      detail: `${state[tb.state] || ''}${tb.id === activeId ? t('palette.currentTab') : ''} · ${views[tb.view] || ''}`,
      keywords: 'tab wechseln switch', noRecent: true, // i18n-ignore
      run: () => activate(tb.id),
    }));
  }

  function commandItems() {
    const tab = openTab_();
    if (!tab || typeof Quickbar === 'undefined' || !Quickbar.entries) return [];
    return Quickbar.entries(tab).map(({ item, parent, global, label }) => ({
      key: 'cmd:' + item.id, section: 'cmds', icon: hasIcon(item.icon) ? item.icon : hasIcon(parent?.icon) ? parent.icon : 'bolt',
      label, detail: (global ? t('palette.allServers') : '') + String(item.cmd).split('\n')[0],
      keywords: `befehl knopf command button ${item.tip || ''} ${item.cmd}`, danger: !!(item.danger || parent?.danger),
      run: () => Quickbar.run(item, parent),
    }));
  }

  const hasIcon = name => typeof name === 'string' && Object.hasOwn(ICON_PATHS, name);

  function actionItems() {
    const tab = activeTab();
    const open = tab && tab.state === 'open';
    const A = (id, label, icon, run, extra = {}) => ({ key: 'act:' + id, section: 'actions', icon, label, run, ...extra });
    const list = [
      A('new-host', t('palette.actNewHost'), 'plus', () => editHost(), { keywords: 'host server hinzufügen erstellen add create new' }), // i18n-ignore
      A('quick', t('palette.actQuick'), 'bolt', () => { if (Layout.isSidebarCollapsed()) Layout.setSidebarCollapsed(false); setTimeout(() => $('#quick-input').focus(), 220); }, { keywords: 'adresse eingeben address enter' }),
      A('import', t('palette.actImport'), 'download', () => $('#import-hosts').click(), { keywords: 'import ssh config' }),
      A('sidebar', Layout.isSidebarCollapsed() ? t('palette.actSidebarOpen') : t('palette.actSidebarClose'), 'sidebar', () => Layout.setSidebarCollapsed(!Layout.isSidebarCollapsed()), { keywords: 'leiste links verbindungsliste sidebar left connection list' }),
      A('settings', t('palette.actSettings'), 'gear', () => Settings.open(), { keywords: 'optionen schrift terminal farben options preferences font colors language sprache' }),
      A('lock', t('palette.actLock'), 'lock', () => $('#app-lock-btn').click(), { keywords: 'passwort touch id schutz password protection' }),
    ];
    if (tab) {
      list.push(
        A('view-terminal', t('palette.actViewTerminal'), 'terminal', () => setView('terminal'), { keywords: 'ansicht konsole shell view console' }),
        A('view-files', t('palette.actViewFiles'), 'folder', () => setView('files'), { keywords: 'ansicht sftp dateibrowser view file browser' }),
        A('close-tab', t('palette.actCloseTab'), 'close', () => closeTab(activeId), { keywords: 'beenden trennen quit disconnect' }),
        A('quickbar', t('palette.actQuickbar'), 'bolt', () => $('#btn-quick').click(), { keywords: 'knöpfe schnellbefehle buttons quick commands' }), // i18n-ignore
      );
      if (tab.state === 'closed' || tab.state === 'reconnecting') list.push(A('reconnect', t('palette.actReconnect'), 'refresh', () => reconnectNow(tab), { keywords: 'verbindung wiederherstellen restore connection' }));
    }
    if (open) {
      list.push(
        A('tunnels', t('palette.actTunnels'), 'tunnel', tool('#btn-tunnels'), { keywords: 'port forward socks weiterleitung forwarding' }),
        A('split', t('palette.actSplit'), 'split', () => TermExtra.addPane(), { keywords: 'split nebeneinander raster zweites side by side grid second' }),
        A('log', t('palette.actLog'), 'record', tool('#term-tools [data-t=log]'), { keywords: 'aufzeichnen protokoll log record session' }),
        A('broadcast', t('palette.actBroadcast'), 'broadcast', () => TermExtra.toggleBroadcast(), { keywords: 'broadcast alle terminals gleichzeitig all at once' }), // i18n-ignore
        A('term-search', t('palette.actTermSearch'), 'search', () => { setView('terminal'); TermExtra.openSearch(); }, { keywords: 'finden text find search' }),
      );
    }
    return list;
  }

  function allItems() {
    const list = [...tabItems(), ...commandItems(), ...hostItems(), ...actionItems()];
    for (const p of providers) { try { list.push(...(p() || [])); } catch (err) { console.error('Befehlspalette', err); } }
    for (const it of list) if (!hasIcon(it.icon)) it.icon = 'bolt';
    return list;
  }

  // ---------- Zuletzt verwendet ----------

  function recent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } }
  function remember(key) {
    const list = [key, ...recent().filter(k => k !== key)].slice(0, MAX_RECENT);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
  }

  // ---------- Unscharfe Suche ----------
  // Treffer, wenn alle Zeichen der Suche in der Reihenfolge vorkommen. Pluspunkte für Wortanfänge
  // und zusammenhängende Zeichen, ganzer Teilstring zählt am meisten.

  const fold = s => s.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 's');
  const boundary = (t, i) => i === 0 || /[\s\-_./:@·(„"]/.test(t[i - 1]) || (t[i - 1] === t[i - 1].toLowerCase() && t[i] !== t[i].toLowerCase());

  function fuzzy(query, text) {
    if (!text) return null;
    const q = fold(query).replace(/\s+/g, ' ').trim();
    const t = fold(text);
    if (!q) return { score: 0, idx: [] };
    const sub = t.indexOf(q);
    if (sub >= 0) {
      return { score: 1000 + (boundary(text, sub) ? 300 : 0) - sub * 3 - (t.length - q.length) * 0.3, idx: Array.from({ length: q.length }, (_, k) => sub + k) };
    }
    let pos = 0, prev = -2, score = 0;
    const idx = [];
    for (const c of q) {
      if (c === ' ') continue;
      const next = t.indexOf(c, pos);
      if (next < 0) return null;
      let j = next;
      if (next !== prev + 1) {
        // Lieber einen Wortanfang nehmen als irgendein Vorkommen mitten im Wort
        for (let k = next; k < t.length; k++) if (t[k] === c && boundary(text, k)) { j = k; break; }
      }
      score += (j === prev + 1 ? 12 : 0) + (boundary(text, j) ? 10 : 0) - Math.min(20, (j - pos) * 0.4);
      idx.push(j);
      prev = j;
      pos = j + 1;
    }
    return { score: 100 + score - t.length * 0.2, idx };
  }

  function search(query) {
    const items = allItems();
    const rec = recent();
    if (!query.trim()) {
      const byKey = new Map(items.map(it => [it.key, it]));
      const top = rec.map(k => byKey.get(k)).filter(Boolean).map(it => ({ it, section: 'recent' }));
      const used = new Set(top.map(x => x.it.key));
      const order = ['tabs', 'cmds', 'hosts', 'actions'];
      const rest = items.filter(it => !used.has(it.key)).sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
      return [...top, ...rest.map(it => ({ it, section: it.section }))];
    }
    const out = [];
    for (const it of items) {
      const m = fuzzy(query, it.label);
      const k = m ? null : fuzzy(query, `${it.detail || ''} ${it.keywords || ''}`);
      if (!m && !k) continue;
      const r = rec.indexOf(it.key);
      const score = (m ? m.score : k.score * 0.5) + (r >= 0 ? 60 - r * 5 : 0);
      out.push({ it, section: it.section, score, idx: m ? m.idx : [] });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
  }

  // ---------- Oberfläche ----------

  const overlay = document.createElement('div');
  overlay.id = 'palette';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="pal" role="dialog" aria-label="${t('palette.ariaLabel')}">
      <div class="pal-head">
        <span class="pal-ic">${icon('search')}</span>
        <input class="pal-input" placeholder="${t('palette.placeholder')}" spellcheck="false" autocomplete="off" aria-autocomplete="list" aria-controls="pal-list">
        <kbd class="pal-kbd">Esc</kbd>
      </div>
      <div class="pal-list" id="pal-list" role="listbox"></div>
      <div class="pal-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> ${t('palette.footSelect')}</span>
        <span><kbd>Enter</kbd> ${t('palette.footRun')}</span>
        <span class="pal-alt-hint" hidden><kbd>${IS_MAC ? '⇧' : t('palette.shift')}</kbd><kbd>Enter</kbd> <span></span></span>
        <span class="spacer"></span>
        <span>${t('palette.footToggle', { shortcut: SHORTCUT })}</span>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('.pal-input');
  const listEl = overlay.querySelector('.pal-list');
  const altHint = overlay.querySelector('.pal-alt-hint');

  let results = [];
  let sel = 0;
  let lastFocus = null;

  function labelHtml(el, text, idx) {
    if (!idx || !idx.length) { el.textContent = text; return; }
    const set = new Set(idx);
    let buf = '';
    let inMark = false;
    const flush = () => { if (!buf) return; if (inMark) { const m = document.createElement('mark'); m.textContent = buf; el.appendChild(m); } else el.append(buf); buf = ''; };
    [...text].forEach((ch, i) => { const hit = set.has(i); if (hit !== inMark) { flush(); inMark = hit; } buf += ch; });
    flush();
  }

  function render() {
    results = search(input.value);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    listEl.innerHTML = '';
    const grouped = !input.value.trim();
    let lastSection = null;
    results.forEach((r, i) => {
      if (grouped && r.section !== lastSection) {
        lastSection = r.section;
        const h = document.createElement('div');
        h.className = 'pal-section';
        h.textContent = SECTIONS[r.section] || r.section;
        listEl.appendChild(h);
      }
      const row = document.createElement('div');
      row.className = 'pal-row' + (r.it.danger ? ' danger' : '');
      row.setAttribute('role', 'option');
      row.dataset.i = i;
      row.innerHTML = `<span class="pal-row-ic">${icon(r.it.icon)}</span><span class="pal-text"><span class="pal-label"></span><span class="pal-detail"></span></span>`;
      labelHtml(row.querySelector('.pal-label'), r.it.label, r.idx);
      row.querySelector('.pal-detail').textContent = r.it.detail || '';
      if (!grouped) {
        const tag = document.createElement('span');
        tag.className = 'pal-tag';
        tag.textContent = SECTIONS[r.it.section] || '';
        row.appendChild(tag);
      }
      row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; markSel(false); } });
      row.addEventListener('click', e => execute(i, e.shiftKey));
      listEl.appendChild(row);
    });
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'pal-empty';
      empty.textContent = t('palette.nothingFound');
      listEl.appendChild(empty);
    }
    markSel(true);
  }

  function markSel(scroll) {
    for (const row of listEl.querySelectorAll('.pal-row')) {
      const on = Number(row.dataset.i) === sel;
      row.classList.toggle('sel', on);
      row.setAttribute('aria-selected', String(on));
      if (on && scroll) row.scrollIntoView({ block: 'nearest' });
    }
    const it = results[sel]?.it;
    altHint.hidden = !it?.alt;
    if (it?.alt) altHint.lastElementChild.textContent = it.altHint || t('palette.alternative');
  }

  function open() {
    if (!overlay.hidden) { input.select(); return; }
    hideContextMenu();
    lastFocus = document.activeElement;
    input.value = '';
    sel = 0;
    overlay.hidden = false;
    render();
    input.focus();
  }

  function close(restore = true) {
    if (overlay.hidden) return;
    overlay.hidden = true;
    if (restore && lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  function execute(i, alt = false) {
    const r = results[i];
    if (!r) return;
    close(false);
    if (!r.it.noRecent) remember(r.it.key);
    const fn = alt && r.it.alt ? r.it.alt : r.it.run;
    // Erst schließen, dann ausführen – Rückfragen (askLocal) bekommen so den Fokus
    setTimeout(() => {
      try { const p = fn(); if (p && p.catch) p.catch(err => showError(err)); } catch (err) { showError(err); }
      if (document.activeElement === document.body) activeTab()?.term.focus();
    }, 0);
  }

  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', e => {
    const n = results.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { sel = (sel + 1) % n; markSel(true); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { sel = (sel - 1 + n) % n; markSel(true); } }
    else if (e.key === 'PageDown') { e.preventDefault(); if (n) { sel = Math.min(n - 1, sel + 8); markSel(true); } }
    else if (e.key === 'PageUp') { e.preventDefault(); if (n) { sel = Math.max(0, sel - 8); markSel(true); } }
    else if (e.key === 'Enter') { e.preventDefault(); execute(sel, e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) { e.preventDefault(); close(); } });

  // Cmd+K (Mac) bzw. Strg+K (Windows) – vor xterm abfangen
  window.addEventListener('keydown', e => {
    if (e.key.toLowerCase() !== 'k' || e.altKey) return;
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && !e.metaKey;
    if (!mod) return;
    if (overlay.hidden && document.querySelector('.modal:not([hidden])')) return;
    e.preventDefault();
    e.stopPropagation();
    if (overlay.hidden) open(); else close();
  }, true);

  // Knopf in der Tab-Leiste (rechts), damit die Palette auch ohne Tastenkürzel zu finden ist
  const btn = document.createElement('button');
  btn.id = 'pal-btn';
  btn.type = 'button';
  btn.className = 'mini-btn';
  btn.title = t('palette.buttonTip', { shortcut: SHORTCUT });
  btn.innerHTML = icon('search');
  btn.addEventListener('click', () => open());
  $('#tabbar').appendChild(btn);

  window.Palette = { open, close, register: fn => providers.push(fn), fuzzy, isOpen: () => !overlay.hidden };
})();
