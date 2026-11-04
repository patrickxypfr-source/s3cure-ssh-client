// Geteilte Dateiansicht wie bei FileZilla/WinSCP: links „Mein Computer“ (lokale Dateien),
// rechts der Server. Ziehen & Ablegen in beide Richtungen, Knöpfe → / ← für die Auswahl.
// Hauptprozess: app/lib/localfs.js (Dateien) und app/lib/pane-transfer.js (Übertragungen).
// Eingehängt in renderer.js über LocalPane.attach/detach und die Drag-&-Drop-Hooks der Server-Liste.

Object.assign(ICON_PATHS, {
  computer: 'M4.5 4.5h15A1.5 1.5 0 0 1 21 6v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15.5V6a1.5 1.5 0 0 1 1.5-1.5z M9 21h6 M12 17v4',
  arrowRight: 'M5 12h14 M13 6l6 6-6 6',
  arrowLeft: 'M19 12H5 M11 6l-6 6 6 6',
  desktop: 'M4.5 4.5h15A1.5 1.5 0 0 1 21 6v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15.5V6a1.5 1.5 0 0 1 1.5-1.5z M9 21h6 M12 17v4',
  drive: 'M4 13.5l2.2-7.2A2 2 0 0 1 8.1 5h7.8a2 2 0 0 1 1.9 1.3L20 13.5 M4 13.5h16v4A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z M16.5 16.2h.01',
  eye: ICON_PATHS.eye || 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  copy: ICON_PATHS.copy || 'M9 9h10.5v10.5H9z M15 9V4.5H4.5V15H9',
});

window.LocalPane = (() => {
  const L = window.localFs;
  const DRAG_TYPE = 'application/x-s3cure';
  const FINDER = IS_MAC ? 'Finder' : 'Explorer';
  const DEFAULT_W = 42;

  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const cleanMsg = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  let sort = lsGet('localpane:sort', { key: 'name', dir: 1 });
  let showHidden = lsGet('localpane:hidden', false);
  let places = { home: '~', places: [], drives: [], sep: IS_MAC ? '/' : '\\' };
  const placesReady = L.places().then(r => { places = r; }).catch(() => {});

  const panes = new Map(); // Tab-ID -> Zustand des lokalen Fensters
  let drag = null;         // laufendes Ziehen aus der App: { from: 'local'|'remote', tabId, paths | items }

  // Zustand pro Verbindung merken (offen, Breite, Ordner)
  const prefKey = tab => 'localpane:' + (tab.spec.name || tab.spec.text || tab.title);

  // ---------- Aufbau ----------

  function attach(tab) {
    const f = tab.files;
    const el = document.createElement('div');
    el.className = 'lp';
    el.hidden = true;
    el.innerHTML = `
      <div class="files-bar">
        <button class="round-btn" data-l="up" title="Übergeordneter Ordner">${icon('up')}</button>
        <button class="round-btn" data-l="home" title="Benutzerordner">${icon('home')}</button>
        <div class="field grow"><span class="field-icon">${icon('computer')}</span><input class="files-path lp-path" spellcheck="false" title="Pfad eingeben und Enter drücken"></div>
        <button class="round-btn" data-l="refresh" title="Aktualisieren">${icon('refresh')}</button>
        <button class="round-btn" data-l="close" title="Mein Computer schließen">${icon('close')}</button>
      </div>
      <div class="files-actions lp-actions">
        <div class="lp-places"></div>
        <button class="round-btn" data-l="mkdir" title="Neuer Ordner">${icon('folderPlus')}</button>
      </div>
      <div class="files-list lp-list" tabindex="0">
        <table>
          <thead><tr><th data-sort="name">Name</th><th class="size" data-sort="size">Größe</th><th class="date" data-sort="mtime">Geändert</th></tr></thead>
          <tbody></tbody>
        </table>
        <div class="files-empty"></div>
        <div class="drop-hint">Loslassen zum Herunterladen</div>
      </div>
      <div class="files-status"></div>`;
    const divider = document.createElement('div');
    divider.className = 'lp-divider';
    divider.hidden = true;
    divider.title = 'Ziehen zum Verschieben, Doppelklick = Mitte';
    divider.innerHTML = `
      <button class="round-btn" data-l="put" title="Auswahl hochladen – in den Server-Ordner rechts">${icon('arrowRight')}</button>
      <button class="round-btn" data-l="get" title="Auswahl vom Server herunterladen – in den Ordner links">${icon('arrowLeft')}</button>`;
    $('#terminals').append(el, divider);

    // Knopf in der Dateiansicht (rechts in der Aktionsleiste)
    const toggle = document.createElement('button');
    toggle.className = 'btn lp-toggle';
    toggle.title = 'Daneben die Dateien auf diesem Computer zeigen – Dateien einfach hin- und herziehen';
    toggle.innerHTML = `${icon('computer')}Mein Computer`;
    f.el.querySelector('.files-actions').appendChild(toggle);

    const pref = lsGet(prefKey(tab), {});
    const p = {
      tab, el, divider, toggle, open: false, w: Number(pref.w) || DEFAULT_W,
      path: null, parent: null, entries: [], selected: new Set(), anchor: null, loaded: false, error: null,
      list: el.querySelector('.lp-list'), body: el.querySelector('tbody'), pathInput: el.querySelector('.lp-path'),
      startPath: pref.path || null,
    };
    panes.set(tab.id, p);

    const on = (a, fn, root = el) => root.querySelector(`[data-l=${a}]`).addEventListener('click', fn);
    toggle.addEventListener('click', () => setOpen(p, !p.open));
    on('close', () => setOpen(p, false));
    on('up', () => p.parent && go(p, p.parent));
    on('home', () => go(p, places.home));
    on('refresh', () => go(p, p.path || places.home, { keep: true }));
    on('mkdir', () => makeDir(p));
    on('put', () => uploadSelected(p), divider);
    on('get', () => downloadSelected(p), divider);
    p.pathInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); go(p, p.pathInput.value.trim() || places.home); p.list.focus(); }
      if (e.key === 'Escape') { p.pathInput.value = p.path || ''; p.list.focus(); }
    });
    for (const th of el.querySelectorAll('th[data-sort]')) {
      th.addEventListener('click', () => {
        sort = sort.key === th.dataset.sort ? { key: sort.key, dir: -sort.dir } : { key: th.dataset.sort, dir: th.dataset.sort === 'name' ? 1 : -1 };
        lsSet('localpane:sort', sort);
        for (const x of panes.values()) if (x.loaded) render(x);
      });
    }
    setupLocalList(p);
    setupServerList(p);
    dragDivider(p);

    // Sichtbar genau dann, wenn die Server-Dateiansicht dieses Tabs sichtbar ist
    p.mo = new MutationObserver(() => syncVisible(p));
    p.mo.observe(f.el, { attributes: true, attributeFilter: ['hidden'] });
    // Server-Zeilen ziehbar machen, Knöpfe nach Auswahl aktualisieren
    p.moRows = new MutationObserver(() => { for (const tr of f.body.children) tr.draggable = true; updateButtons(p); });
    p.moRows.observe(f.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    applyWidth(p);
    if (pref.open) setOpen(p, true, { quiet: true });
  }

  function detach(tab) {
    const p = panes.get(tab.id);
    if (!p) return;
    p.mo.disconnect();
    p.moRows.disconnect();
    p.el.remove();
    p.divider.remove();
    panes.delete(tab.id);
  }

  function savePref(p) {
    lsSet(prefKey(p.tab), { open: p.open, w: Math.round(p.w * 10) / 10, path: p.path || p.startPath });
  }

  function syncVisible(p) {
    const show = p.open && !p.tab.files.el.hidden;
    p.el.hidden = !show;
    p.divider.hidden = !show;
  }

  async function setOpen(p, open, { quiet = false } = {}) {
    p.open = open;
    p.tab.files.el.classList.toggle('lp-on', open);
    p.toggle.classList.toggle('on', open);
    syncVisible(p);
    if (!quiet) savePref(p);
    if (open && !p.loaded) {
      await placesReady;
      renderPlaces(p);
      const ok = p.startPath && await go(p, p.startPath, { silent: true });
      if (!ok) await go(p, places.home);
    }
    if (open && !quiet) p.list.focus();
    if (!open && !quiet) p.tab.files.list.focus();
  }

  function applyWidth(p) {
    for (const node of [p.el, p.divider, p.tab.files.el]) node.style.setProperty('--lp-w', p.w + '%');
  }

  function dragDivider(p) {
    const d = p.divider;
    const set = pct => { p.w = Math.max(20, Math.min(75, pct)); applyWidth(p); };
    d.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      d.classList.add('drag');
      const box = $('#terminals').getBoundingClientRect();
      const move = ev => set((ev.clientX - box.left - 22) / box.width * 100);
      const up = () => {
        d.classList.remove('drag');
        d.removeEventListener('pointermove', move);
        d.removeEventListener('pointerup', up);
        d.removeEventListener('pointercancel', up);
        savePref(p);
      };
      d.addEventListener('pointermove', move);
      d.addEventListener('pointerup', up);
      d.addEventListener('pointercancel', up);
    });
    d.addEventListener('dblclick', e => { if (!e.target.closest('button')) { set(50); savePref(p); } });
  }

  // ---------- Orte (Schreibtisch, Downloads, Dokumente, Laufwerke) ----------

  function renderPlaces(p) {
    const box = p.el.querySelector('.lp-places');
    box.innerHTML = '';
    const items = [...places.places.map(x => ({ ...x, icon: x.icon })), ...places.drives.map(d => ({ ...d, icon: 'drive', title: 'Laufwerk ' + d.label }))];
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'lp-chip';
      b.dataset.path = it.path;
      b.title = it.title || it.path;
      b.innerHTML = icon(it.icon || 'folder');
      b.append(Object.assign(document.createElement('span'), { className: 'lbl', textContent: it.label }));
      b.addEventListener('click', () => { go(p, it.path); p.list.focus(); });
      box.appendChild(b);
    }
  }

  // ---------- Ordner laden und anzeigen ----------

  // Liefert true, wenn der Ordner geladen werden konnte
  async function go(p, dir, { keep = false, silent = false, select = null } = {}) {
    try {
      const r = await L.list(dir);
      const before = keep && r.path === p.path ? new Set(p.selected) : null;
      p.path = r.path;
      p.parent = r.parent;
      p.entries = r.entries;
      p.selected = before ? new Set([...before].filter(n => r.entries.some(e => e.name === n))) : new Set();
      if (select) p.selected = new Set(select.filter(n => r.entries.some(e => e.name === n)));
      if (!before) p.anchor = select ? select[0] : null;
      p.loaded = true;
      p.error = null;
      savePref(p);
      render(p);
      return true;
    } catch (err) {
      if (silent) return false;
      if (!p.loaded) { p.error = cleanMsg(err); render(p); } else showError(err);
      return false;
    }
  }

  function visible(p) {
    const list = showHidden ? p.entries.slice() : p.entries.filter(e => !e.hidden);
    const { key, dir } = sort;
    const byName = (a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base', numeric: true });
    return list.sort((a, b) => (b.isDir - a.isDir) || (key === 'name' ? dir * byName(a, b) : (dir * (a[key] - b[key]) || byName(a, b))));
  }

  const selectedItems = p => p.entries.filter(e => p.selected.has(e.name));

  function render(p) {
    if (document.activeElement !== p.pathInput) p.pathInput.value = p.path || '';
    const items = visible(p);
    p.body.innerHTML = '';
    for (const it of items) {
      const tr = document.createElement('tr');
      tr.dataset.name = it.name;
      tr.draggable = true;
      if (it.hidden) tr.className = 'lp-hidden';
      tr.innerHTML = '<td class="name"><span class="ico"></span><span class="n"></span></td><td class="size"></td><td class="date"></td>';
      tr.querySelector('.ico').innerHTML = icon(it.isDir ? 'folder' : it.isLink ? 'link' : 'file');
      tr.querySelector('.ico').classList.add(it.isDir ? 'dir' : 'doc');
      tr.querySelector('.n').textContent = it.name;
      tr.querySelector('.size').textContent = it.isDir ? '–' : formatSize(it.size);
      tr.querySelector('.date').textContent = it.mtime ? formatDate(it.mtime) : '';
      tr.title = it.path;
      p.body.appendChild(tr);
    }
    for (const th of p.el.querySelectorAll('th[data-sort]')) {
      th.classList.toggle('sorted', th.dataset.sort === sort.key);
      th.classList.toggle('desc', th.dataset.sort === sort.key && sort.dir < 0);
    }
    for (const c of p.el.querySelectorAll('.lp-chip')) c.classList.toggle('on', c.dataset.path === p.path);
    const empty = p.el.querySelector('.files-empty');
    empty.textContent = p.error ? p.error : !p.loaded ? 'Lade Dateien …' : items.length ? '' : 'Dieser Ordner ist leer. Zieh Dateien vom Server hierher, um sie herunterzuladen.';
    empty.hidden = !empty.textContent;
    refreshSel(p);
  }

  function refreshSel(p) {
    for (const tr of p.body.children) tr.classList.toggle('sel', p.selected.has(tr.dataset.name));
    const n = p.selected.size;
    const items = visible(p);
    const hiddenCount = p.entries.length - items.length;
    p.el.querySelector('.files-status').textContent = p.loaded
      ? `${items.length} Elemente${n ? ` · ${n} ausgewählt` : ''}${hiddenCount ? ` · ${hiddenCount} versteckt` : ''}${items.length > 1 ? Lasso.hint(n) : ''}`
      : '';
    p.el.querySelector('[data-l=up]').disabled = !p.parent;
    updateButtons(p);
  }

  function updateButtons(p) {
    const connected = p.tab.state === 'open' && p.tab.files.loaded;
    p.divider.querySelector('[data-l=put]').disabled = !connected || !p.selected.size || !p.path;
    p.divider.querySelector('[data-l=get]').disabled = !connected || !p.tab.files.selected.size || !p.path;
  }

  function pickRow(p, name, e) {
    if (modKey(e)) {
      if (p.selected.has(name)) p.selected.delete(name); else p.selected.add(name);
      p.anchor = name;
    } else if (e.shiftKey && p.anchor) {
      const names = visible(p).map(x => x.name);
      const [a, b] = [names.indexOf(p.anchor), names.indexOf(name)].sort((x, y) => x - y);
      p.selected = new Set(names.slice(a, b + 1));
    } else {
      p.selected = new Set([name]);
      p.anchor = name;
    }
    refreshSel(p);
  }

  function openItem(p, it) {
    if (it.isDir) go(p, it.path);
    else L.open(it.path).catch(showError);
  }

  // ---------- Lokale Liste: Maus, Tastatur, Menü, Ziehen ----------

  function setupLocalList(p) {
    const { list, body } = p;
    const rowItem = tr => tr && p.entries.find(e => e.name === tr.dataset.name);
    let pendingSingle = null;

    body.addEventListener('mousedown', e => {
      pendingSingle = null;
      const tr = e.target.closest('tr');
      if (!tr || e.button !== 0) return;
      // Mehrfachauswahl nicht verlieren, wenn sie gezogen werden soll
      if (!modKey(e) && !e.shiftKey && p.selected.has(tr.dataset.name) && p.selected.size > 1) { pendingSingle = tr.dataset.name; return; }
      pickRow(p, tr.dataset.name, e);
    });
    body.addEventListener('click', e => {
      if (pendingSingle && !modKey(e) && !e.shiftKey) pickRow(p, pendingSingle, e);
      pendingSingle = null;
    });
    body.addEventListener('dblclick', e => { const it = rowItem(e.target.closest('tr')); if (it) openItem(p, it); });
    list.addEventListener('mousedown', e => {
      if (modKey(e) || e.shiftKey) return; // Auswahl bleibt, Rahmen ergänzt sie (lasso.js)
      if (!e.target.closest('tbody tr')) { p.selected.clear(); refreshSel(p); }
    });
    // Rahmen-Auswahl mit der Maus
    Lasso.attach({ list, body, getSelected: () => p.selected, setSelected: sel => { p.selected = sel; refreshSel(p); } });
    list.addEventListener('contextmenu', e => {
      e.preventDefault();
      const tr = e.target.closest('tbody tr');
      if (tr && !p.selected.has(tr.dataset.name)) { p.selected = new Set([tr.dataset.name]); p.anchor = tr.dataset.name; refreshSel(p); }
      if (!tr) { p.selected.clear(); refreshSel(p); }
      showMenu(p, e.clientX, e.clientY);
    });

    list.addEventListener('keydown', e => {
      const items = visible(p);
      const sel = selectedItems(p);
      if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); return; } // nicht die Server-Vorschau öffnen
      if (e.key === 'Enter') { e.preventDefault(); if (sel.length === 1) openItem(p, sel[0]); }
      else if ((e.key === 'Backspace' && e.metaKey) || e.key === 'Delete') { e.preventDefault(); trashSelected(p); }
      else if ((e.key === 'ArrowUp' && (IS_MAC ? e.metaKey : e.altKey)) || (e.key === 'Backspace' && !IS_MAC)) { e.preventDefault(); if (p.parent) go(p, p.parent); }
      else if (e.key === 'ArrowDown' && IS_MAC && e.metaKey) { e.preventDefault(); if (sel.length === 1) openItem(p, sel[0]); }
      else if (e.key === 'F2') { e.preventDefault(); renameSelected(p); }
      else if (e.key.toLowerCase() === 'a' && modKey(e)) { e.preventDefault(); items.forEach(x => p.selected.add(x.name)); refreshSel(p); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        const idx = items.findIndex(x => x.name === p.anchor);
        const next = idx < 0 ? 0 : Math.max(0, Math.min(items.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
        p.selected = new Set([items[next].name]);
        p.anchor = items[next].name;
        refreshSel(p);
        body.querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' });
      }
    });

    // Ziehen aus der lokalen Liste (zum Server)
    body.addEventListener('dragstart', e => {
      const tr = e.target.closest('tr');
      pendingSingle = null;
      if (!tr) return;
      if (!p.selected.has(tr.dataset.name)) { p.selected = new Set([tr.dataset.name]); p.anchor = tr.dataset.name; refreshSel(p); }
      const sel = selectedItems(p);
      drag = { from: 'local', tabId: p.tab.id, paths: sel.map(x => x.path) };
      startDrag(e, sel);
    });
    body.addEventListener('dragend', endDrag);

    // Ablegen in der lokalen Liste (vom Server)
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const kind = dragKind(e);
      const ok = kind === 'remote' && drag.tabId === p.tab.id && !!p.path;
      e.dataTransfer.dropEffect = ok ? 'copy' : 'none';
      const row = ok ? folderRowAt(body, e, p.entries) : null;
      markRow(body, row);
      list.classList.toggle('dragging', ok && !row);
    });
    list.addEventListener('dragleave', e => { if (!list.contains(e.relatedTarget)) { list.classList.remove('dragging'); markRow(body, null); } });
    list.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      const row = folderRowAt(body, e, p.entries);
      list.classList.remove('dragging');
      markRow(body, null);
      if (dragKind(e) !== 'remote' || !p.path) return;
      const target = row ? p.entries.find(x => x.name === row.dataset.name).path : p.path;
      const items = drag.items;
      endDrag();
      download(p, items, target);
    });
  }

  function showMenu(p, x, y) {
    const sel = selectedItems(p);
    const one = sel.length === 1 ? sel[0] : null;
    const connected = p.tab.state === 'open' && p.tab.files.loaded;
    const entries = [];
    if (sel.length) {
      if (one) entries.push([one.isDir ? 'Öffnen' : 'Öffnen (Standardprogramm)', () => openItem(p, one), '', one.isDir ? 'folder' : 'file']);
      if (connected) entries.push([`Hochladen nach ${serverDirName(p)}`, () => uploadSelected(p), '', 'upload']);
      entries.push([`Im ${FINDER} zeigen`, () => L.show(sel[0].path).catch(showError), '', 'folder']);
      if (one) entries.push(['Umbenennen', () => renameSelected(p), '', 'rename']);
      if (one) entries.push(['Pfad kopieren', () => { navigator.clipboard.writeText(one.path); flash('Pfad kopiert'); }, '', 'copy']);
      entries.push(null);
    }
    window.SyncTools?.addLocalMenuEntries(p.tab, sel, entries); // vergleichen (sync.js)
    entries.push(['Neuer Ordner', () => makeDir(p), '', 'folderPlus']);
    if (!sel.length && p.path) {
      entries.push([`Im ${FINDER} öffnen`, () => L.open(p.path).catch(showError), '', 'folder']);
      entries.push(['Aktualisieren', () => go(p, p.path, { keep: true }), '', 'refresh']);
    }
    entries.push([showHidden ? 'Versteckte Dateien ausblenden' : 'Versteckte Dateien zeigen', toggleHidden, '', 'eye']);
    if (sel.length) {
      entries.push(null);
      entries.push(['In den Papierkorb', () => trashSelected(p), 'danger', 'trash']);
    }
    openMenu(entries, x, y);
  }

  function serverDirName(p) {
    const dir = p.tab.files.path || '';
    return `„${dir.split('/').pop() || '/'}“`;
  }

  function toggleHidden() {
    showHidden = !showHidden;
    lsSet('localpane:hidden', showHidden);
    for (const x of panes.values()) if (x.loaded) render(x);
  }

  async function makeDir(p) {
    if (!p.path) return;
    const name = await askLocal({ kind: 'text', title: 'Neuer Ordner', message: 'Name des Ordners auf diesem Computer:', placeholder: 'Neuer Ordner', okLabel: 'Anlegen' });
    if (!name || !name.trim()) return;
    try { await L.mkdir(p.path, name.trim()); } catch (err) { showError(err); return; }
    go(p, p.path, { select: [name.trim()] });
  }

  async function renameSelected(p) {
    const [it] = selectedItems(p);
    if (!it) return;
    const name = await askLocal({ kind: 'text', title: 'Umbenennen', message: `Neuer Name für „${it.name}“:`, value: it.name, okLabel: 'Umbenennen' });
    if (!name || !name.trim() || name.trim() === it.name) return;
    try { await L.rename(it.path, name.trim()); } catch (err) { showError(err); return; }
    go(p, p.path, { select: [name.trim()] });
  }

  async function trashSelected(p) {
    const items = selectedItems(p);
    if (!items.length) return;
    const names = items.slice(0, 8).map(i => i.name + (i.isDir ? '/' : '')).join('\n') + (items.length > 8 ? `\n… und ${items.length - 8} weitere` : '');
    const ok = await askLocal({
      kind: 'confirm', title: 'In den Papierkorb legen?',
      message: `${items.length === 1 ? 'Dieses Element' : `Diese ${items.length} Elemente`} auf diesem Computer in den Papierkorb legen? Von dort lässt es sich wiederherstellen.`,
      detail: names, okLabel: 'In den Papierkorb', danger: true,
    });
    if (!ok) return;
    try {
      const n = await L.trash(items.map(i => i.path));
      flash(`${n} Element${n === 1 ? '' : 'e'} in den Papierkorb gelegt`);
    } catch (err) { showError(err); }
    go(p, p.path);
  }

  // ---------- Server-Liste: Ziehen und Ablegen ----------

  function setupServerList(p) {
    const tab = p.tab;
    const f = tab.files;
    let pendingSingle = null;
    // Mehrfachauswahl beim Ziehen behalten (renderer.js würde sonst beim Mausdruck auf eine Zeile reduzieren)
    f.body.addEventListener('mousedown', e => {
      pendingSingle = null;
      const tr = e.target.closest('tr');
      if (!tr || e.button !== 0 || modKey(e) || e.shiftKey) return;
      if (f.selected.has(tr.dataset.name) && f.selected.size > 1) { e.stopPropagation(); pendingSingle = tr.dataset.name; }
    }, true);
    f.body.addEventListener('click', e => {
      if (pendingSingle && !modKey(e) && !e.shiftKey) selectRow(tab, pendingSingle, e);
      pendingSingle = null;
    });
    f.body.addEventListener('dragstart', e => {
      pendingSingle = null;
      const tr = e.target.closest('tr');
      if (!tr || tab.state !== 'open') { e.preventDefault(); return; }
      if (!f.selected.has(tr.dataset.name)) { f.selected = new Set([tr.dataset.name]); f.anchor = tr.dataset.name; updateSelection(tab); }
      const sel = selectedEntries(f);
      drag = { from: 'remote', tabId: tab.id, items: sel.map(it => ({ path: joinPath(f.path, it.name), isDir: it.isDir })) };
      startDrag(e, sel);
    });
    f.body.addEventListener('dragend', endDrag);
    f.list.addEventListener('dragleave', e => { if (!f.list.contains(e.relatedTarget)) markRow(f.body, null); });
  }

  // Aufgerufen vom dragover-Handler der Server-Liste (renderer.js). true = erledigt.
  function serverDragOver(tab, e) {
    const f = tab.files;
    const kind = dragKind(e);
    const ok = tab.state === 'open' && f.loaded && (kind === 'local' || kind === 'os');
    e.dataTransfer.dropEffect = ok ? 'copy' : 'none';
    const row = ok ? folderRowAt(f.body, e, f.entries) : null;
    markRow(f.body, row);
    f.list.classList.toggle('dragging', ok && !row);
    return true;
  }

  // Aufgerufen vom drop-Handler der Server-Liste (renderer.js). true = erledigt.
  function serverDrop(tab, e) {
    const f = tab.files;
    const kind = dragKind(e);
    const row = folderRowAt(f.body, e, f.entries);
    markRow(f.body, null);
    f.list.classList.remove('dragging');
    if (tab.state !== 'open' || !f.loaded) return true;
    const dir = row ? joinPath(f.path, row.dataset.name) : f.path;
    let paths = [];
    if (kind === 'local') paths = drag.paths;
    else if (kind === 'os') paths = [...e.dataTransfer.files].map(file => api.pathForFile(file)).filter(Boolean);
    endDrag();
    if (paths.length) upload(tab, paths, dir);
    return true;
  }

  // ---------- Ziehen: gemeinsame Helfer ----------

  function dragKind(e) {
    const types = [...(e.dataTransfer?.types || [])];
    if (types.includes(DRAG_TYPE) && drag) return drag.from;
    if (types.includes('Files')) return 'os';
    return null;
  }

  let ghost = null;
  function startDrag(e, items) {
    // Nur eigener Typ – kein Text, sonst legt der Finder eine Textschnipsel-Datei an
    e.dataTransfer.setData(DRAG_TYPE, drag.from);
    e.dataTransfer.effectAllowed = 'copy';
    if (!ghost) { ghost = document.createElement('div'); ghost.className = 'lp-ghost'; document.body.appendChild(ghost); }
    ghost.innerHTML = icon(items.length === 1 && !items[0].isDir ? 'file' : 'folder');
    ghost.append(items.length === 1 ? items[0].name : `${items.length} Elemente`);
    e.dataTransfer.setDragImage(ghost, 14, 14);
  }

  function endDrag() {
    drag = null;
    for (const el of document.querySelectorAll('.lp-drop')) el.classList.remove('lp-drop');
    for (const el of document.querySelectorAll('.files-list.dragging')) el.classList.remove('dragging');
  }

  // Ordner-Zeile unter dem Mauszeiger (über die Position – der Hinweis liegt über der Liste)
  function folderRowAt(body, e, entries) {
    for (const tr of body.children) {
      const r = tr.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY < r.bottom) {
        const it = entries.find(x => x.name === tr.dataset.name);
        return it && it.isDir ? tr : null;
      }
    }
    return null;
  }

  function markRow(body, row) {
    for (const tr of body.querySelectorAll('tr.lp-drop')) if (tr !== row) tr.classList.remove('lp-drop');
    if (row) row.classList.add('lp-drop');
  }

  // ---------- Übertragen ----------

  function summary(r, verb, first) {
    if (!r) return '';
    const skipped = r.skipped ? ` · ${r.skipped} übersprungen` : '';
    if (r.files === 1 && first && !skipped) return `${verb}: ${first}`;
    return `${r.files} Datei${r.files === 1 ? '' : 'en'} ${verb.toLowerCase()}${skipped}`;
  }

  const baseName = x => x.split(/[\\/]/).filter(Boolean).pop();

  async function upload(tab, paths, dir) {
    const f = tab.files;
    try {
      const r = await L.upload(tab.id, dir, paths);
      flash(summary(r, 'Hochgeladen', paths.length === 1 ? baseName(paths[0]) : null));
    } catch (err) { showError(err); }
    if (tab.state !== 'open' || !f.path) return;
    // Liste still neu laden: die Auswahl des Nutzers bleibt stehen. Ist nichts
    // ausgewählt, wird das Hochgeladene markiert (wenn es im angezeigten Ordner liegt).
    const shown = f.path;
    try {
      const r = await api.sftpList(tab.id, shown);
      if (r.path !== f.path) return;
      const present = n => r.entries.some(e => e.name === n);
      f.entries = r.entries;
      let keep = [...f.selected].filter(present);
      if (!keep.length && dir === shown) keep = paths.map(baseName).filter(present);
      renderFiles(tab);
      f.selected = new Set(keep);
      if (keep.length && !keep.includes(f.anchor)) f.anchor = keep[0];
      updateSelection(tab);
    } catch {}
  }

  async function download(p, items, dir) {
    const name = items.length === 1 ? items[0].path.split('/').pop() : null;
    try {
      const r = await L.download(p.tab.id, dir, items);
      flash(summary(r, 'Heruntergeladen', name));
    } catch (err) { showError(err); }
    if (!p.path) return;
    const shown = p.path;
    await go(p, shown, { keep: true, silent: true });
    if (!p.selected.size && dir === p.path) {
      const names = items.map(it => it.path.split('/').pop()).filter(n => p.entries.some(e => e.name === n));
      p.selected = new Set(names);
      p.anchor = names[0] || null;
      refreshSel(p);
    }
  }

  function uploadSelected(p) {
    const f = p.tab.files;
    const sel = selectedItems(p);
    if (!sel.length || p.tab.state !== 'open' || !f.path) return;
    upload(p.tab, sel.map(x => x.path), f.path);
  }

  function downloadSelected(p) {
    const f = p.tab.files;
    const sel = selectedEntries(f);
    if (!sel.length || p.tab.state !== 'open' || !p.path) return;
    download(p, sel.map(it => ({ path: joinPath(f.path, it.name), isDir: it.isDir })), p.path);
  }

  // ---------- Rückfrage: Datei gibt es schon ----------

  const conflictQueue = [];
  let conflictOpen = false;
  L.onConflict(info => { conflictQueue.push(info); if (!conflictOpen) nextConflict(); });

  function nextConflict() {
    const info = conflictQueue.shift();
    if (!info) { conflictOpen = false; return; }
    conflictOpen = true;
    const where = info.kind === 'upload' ? 'auf dem Server' : 'auf diesem Computer';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <form class="dialog lp-conflict">
        <h2>Datei gibt es schon</h2>
        <p class="choose-msg"></p>
        <div class="lp-cmp">
          <div class="lp-cmp-col"><span class="lp-cmp-k">Vorhanden</span><b class="lp-ex-size"></b><span class="lp-ex-date"></span></div>
          <span class="lp-cmp-arrow">${icon('arrowLeft')}</span>
          <div class="lp-cmp-col"><span class="lp-cmp-k">Neu</span><b class="lp-new-size"></b><span class="lp-new-date"></span></div>
        </div>
        <label class="toggle lp-all"><input type="checkbox"><span class="track"><span class="knob"></span></span>Für alle weiteren Dateien dieser Übertragung</label>
        <div class="actions">
          <button type="button" class="btn" data-c="cancel">Übertragung abbrechen</button>
          <span class="spacer"></span>
          <button type="button" class="btn" data-c="skip">Überspringen</button>
          <button type="submit" class="btn danger" data-c="overwrite">Überschreiben</button>
        </div>
      </form>`;
    modal.querySelector('.choose-msg').textContent = `„${info.name}“ gibt es im Zielordner ${where} schon. Was soll passieren?`;
    modal.querySelector('.choose-msg').title = info.target;
    const newer = info.source.mtime > info.existing.mtime + 1000 ? ' (neuer)' : info.source.mtime < info.existing.mtime - 1000 ? ' (älter)' : '';
    modal.querySelector('.lp-ex-size').textContent = formatSize(info.existing.size);
    modal.querySelector('.lp-ex-date').textContent = formatDate(info.existing.mtime);
    modal.querySelector('.lp-new-size').textContent = formatSize(info.source.size);
    modal.querySelector('.lp-new-date').textContent = formatDate(info.source.mtime) + newer;
    modal.querySelector('.lp-all').hidden = !info.multi;
    const all = modal.querySelector('.lp-all input');
    const done = action => {
      modal.remove();
      L.answerConflict(info.reqId, { action, all: action !== 'cancel' && all.checked });
      nextConflict();
    };
    modal.querySelector('[data-c=cancel]').addEventListener('click', () => done('cancel'));
    modal.querySelector('[data-c=skip]').addEventListener('click', () => done('skip'));
    modal.querySelector('form').addEventListener('submit', e => { e.preventDefault(); done('overwrite'); });
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('cancel'); } });
    document.body.appendChild(modal);
    modal.querySelector('[data-c=skip]').focus();
  }

  // Für Synchronisieren/Vergleichen (sync.js): angezeigter Ordner, Auswahl, neu laden
  function state(tab) {
    const p = panes.get(tab.id);
    if (!p) return null;
    return { open: p.open, path: p.path, sep: places.sep, selected: selectedItems(p), entries: p.entries };
  }
  function refresh(tab) {
    const p = panes.get(tab.id);
    if (p && p.path) return go(p, p.path, { keep: true, silent: true });
  }

  return { attach, detach, serverDragOver, serverDrop, isOpen: tab => !!panes.get(tab.id)?.open, state, refresh };
})();
