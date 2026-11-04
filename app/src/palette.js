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
  const SHORTCUT = IS_MAC ? '⌘K' : 'Strg+K';

  // ---------- Einträge ----------
  // { key, section, label, detail, icon, keywords, run, alt?, altHint? }

  const SECTIONS = { recent: 'Zuletzt verwendet', tabs: 'Offene Tabs', cmds: 'Befehle', hosts: 'Verbindungen', actions: 'Aktionen' };
  const providers = [];

  const activeTab = () => tabs.get(activeId) || null;
  const openTab_ = () => { const t = activeTab(); return t && t.state === 'open' ? t : null; };
  const tool = sel => () => Layout.clickTool(document.querySelector(sel));

  function hostItems() {
    return Object.keys(hosts).sort((a, b) => a.localeCompare(b)).map(name => {
      const h = hosts[name];
      const open = [...tabs.values()].some(t => t.spec.name === name && t.state === 'open');
      return {
        key: 'host:' + name, section: 'hosts', icon: 'server', label: name,
        detail: `${h.user}@${h.host}${h.port !== 22 ? ':' + h.port : ''}${h.group ? ' · ' + h.group : ''}${open ? ' · verbunden' : ''}`,
        keywords: `verbinden ssh ${h.host} ${h.user} ${h.group || ''}`,
        run: () => openTab({ name }, name),
        alt: () => openTab({ name }, name, 'files'), altHint: 'Dateien öffnen',
      };
    });
  }

  function tabItems() {
    const state = { open: 'verbunden', connecting: 'verbindet …', reconnecting: 'verbindet neu …', closed: 'nicht verbunden' };
    const views = { terminal: 'Terminal', files: 'Dateien', dash: 'Übersicht' };
    return [...tabs.values()].map(t => ({
      key: 'tab:' + t.id, section: 'tabs', icon: t.view === 'files' ? 'folder' : 'terminal', label: t.title,
      detail: `${state[t.state] || ''}${t.id === activeId ? ' · aktueller Tab' : ''} · ${views[t.view] || ''}`,
      keywords: 'tab wechseln', noRecent: true,
      run: () => activate(t.id),
    }));
  }

  function commandItems() {
    const tab = openTab_();
    if (!tab || typeof Quickbar === 'undefined' || !Quickbar.entries) return [];
    return Quickbar.entries(tab).map(({ item, parent, global, label }) => ({
      key: 'cmd:' + item.id, section: 'cmds', icon: hasIcon(item.icon) ? item.icon : hasIcon(parent?.icon) ? parent.icon : 'bolt',
      label, detail: (global ? 'Alle Server · ' : '') + String(item.cmd).split('\n')[0],
      keywords: `befehl knopf ${item.tip || ''} ${item.cmd}`, danger: !!(item.danger || parent?.danger),
      run: () => Quickbar.run(item, parent),
    }));
  }

  const hasIcon = name => typeof name === 'string' && Object.hasOwn(ICON_PATHS, name);

  function actionItems() {
    const tab = activeTab();
    const open = tab && tab.state === 'open';
    const A = (id, label, icon, run, extra = {}) => ({ key: 'act:' + id, section: 'actions', icon, label, run, ...extra });
    const list = [
      A('new-host', 'Neue Verbindung anlegen', 'plus', () => editHost(), { keywords: 'host server hinzufügen erstellen' }),
      A('quick', 'Schnell verbinden (user@host)', 'bolt', () => { if (Layout.isSidebarCollapsed()) Layout.setSidebarCollapsed(false); setTimeout(() => $('#quick-input').focus(), 220); }, { keywords: 'adresse eingeben' }),
      A('import', 'Verbindungen aus ~/.ssh/config übernehmen', 'download', () => $('#import-hosts').click(), { keywords: 'import ssh config' }),
      A('sidebar', Layout.isSidebarCollapsed() ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen', 'sidebar', () => Layout.setSidebarCollapsed(!Layout.isSidebarCollapsed()), { keywords: 'leiste links verbindungsliste' }),
      A('settings', 'Einstellungen', 'gear', () => Settings.open(), { keywords: 'optionen schrift terminal farben' }),
      A('lock', 'App-Sperre einstellen', 'lock', () => $('#app-lock-btn').click(), { keywords: 'passwort touch id schutz' }),
    ];
    if (tab) {
      list.push(
        A('view-terminal', 'Terminal anzeigen', 'terminal', () => setView('terminal'), { keywords: 'ansicht konsole shell' }),
        A('view-files', 'Dateien anzeigen', 'folder', () => setView('files'), { keywords: 'ansicht sftp dateibrowser' }),
        A('close-tab', 'Tab schließen', 'close', () => closeTab(activeId), { keywords: 'beenden trennen' }),
        A('quickbar', 'Befehlsleiste ein- oder ausblenden', 'bolt', () => $('#btn-quick').click(), { keywords: 'knöpfe schnellbefehle' }),
      );
      if (tab.state === 'closed' || tab.state === 'reconnecting') list.push(A('reconnect', 'Neu verbinden', 'refresh', () => reconnectNow(tab), { keywords: 'verbindung wiederherstellen' }));
    }
    if (open) {
      list.push(
        A('tunnels', 'Tunnel (Port-Weiterleitungen)', 'tunnel', tool('#btn-tunnels'), { keywords: 'port forward socks weiterleitung' }),
        A('split', 'Terminal teilen (weiteres Terminal)', 'split', () => TermExtra.addPane(), { keywords: 'split nebeneinander raster zweites' }),
        A('log', 'Mitschnitt starten oder stoppen', 'record', tool('#term-tools [data-t=log]'), { keywords: 'aufzeichnen protokoll log' }),
        A('broadcast', 'An alle senden ein- oder ausschalten', 'broadcast', () => TermExtra.toggleBroadcast(), { keywords: 'broadcast alle terminals gleichzeitig' }),
        A('term-search', 'Im Terminal suchen', 'search', () => { setView('terminal'); TermExtra.openSearch(); }, { keywords: 'finden text' }),
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
    <div class="pal" role="dialog" aria-label="Befehlspalette">
      <div class="pal-head">
        <span class="pal-ic">${icon('search')}</span>
        <input class="pal-input" placeholder="Verbindung, Tab, Befehl oder Aktion suchen …" spellcheck="false" autocomplete="off" aria-autocomplete="list" aria-controls="pal-list">
        <kbd class="pal-kbd">Esc</kbd>
      </div>
      <div class="pal-list" id="pal-list" role="listbox"></div>
      <div class="pal-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> auswählen</span>
        <span><kbd>Enter</kbd> ausführen</span>
        <span class="pal-alt-hint" hidden><kbd>${IS_MAC ? '⇧' : 'Umschalt'}</kbd><kbd>Enter</kbd> <span></span></span>
        <span class="spacer"></span>
        <span>${SHORTCUT} öffnet und schließt</span>
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
      empty.textContent = 'Nichts gefunden.';
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
    if (it?.alt) altHint.lastElementChild.textContent = it.altHint || 'Alternative';
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
  btn.title = `Befehlspalette – alles suchen und starten (${SHORTCUT})`;
  btn.innerHTML = icon('search');
  btn.addEventListener('click', () => open());
  $('#tabbar').appendChild(btn);

  window.Palette = { open, close, register: fn => providers.push(fn), fuzzy, isOpen: () => !overlay.hidden };
})();
