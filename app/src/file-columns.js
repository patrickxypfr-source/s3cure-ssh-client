// Spalten der Server-Dateiliste: Name, Größe, Geändert, Rechte, Besitzer, Gruppe.
// - Klick auf einen Spaltenkopf sortiert (nochmal klicken = umgekehrt), Ordner bleiben oben.
// - Rechtsklick auf den Kopf: Spalten ein-/ausblenden, Breiten zurücksetzen.
// - Breiten an der linken Kante eines Spaltenkopfs ziehen; „Name“ nimmt den Rest.
// Alles gilt für alle Verbindungen und wird gemerkt (localStorage).
// Eingehängt in renderer.js über FileColumns.attach(tab) und visibleEntries() → FileColumns.sorted(f).
// Besitzer/Gruppe kommen als Namen vom Hauptprozess (app/lib/owners.js).

Object.assign(ICON_PATHS, { blank: '', columns: 'M4 5h16v14H4z M9.5 5v14 M14.5 5v14' });

window.FileColumns = (() => {
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  // key = Feld im Eintrag, cls = CSS-Klasse der Zellen (wie in renderFiles)
  const COLUMNS = [
    { key: 'name', cls: 'name', label: t('fileColumns.name') },
    { key: 'size', cls: 'size', label: t('fileColumns.size'), w: 90, desc: true },
    { key: 'mtime', cls: 'date', label: t('fileColumns.modified'), w: 140, desc: true },
    { key: 'mode', cls: 'mode', label: t('fileColumns.mode'), w: 105 },
    { key: 'owner', cls: 'owner', label: t('fileColumns.owner'), w: 100 },
    { key: 'group', cls: 'group', label: t('fileColumns.group'), w: 100 },
  ];
  const byKey = Object.fromEntries(COLUMNS.map(c => [c.key, c]));
  const MIN_W = 48;
  const MAX_W = 480;

  let sort = lsGet('files:sort', { key: 'name', dir: 1 });
  if (!byKey[sort.key]) sort = { key: 'name', dir: 1 };
  let hidden = new Set(lsGet('files:hidden-cols', []));
  let widths = lsGet('files:col-widths', {});
  const attached = new Set(); // Tabs

  const widthOf = c => Math.max(MIN_W, Math.min(MAX_W, Number(widths[c.key]) || c.w));

  // ---------- Sortieren ----------

  const collator = new Intl.Collator(I18N.locale, { sensitivity: 'base', numeric: true });
  function compare(a, b) {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const k = sort.key;
    let r = 0;
    if (k === 'size' || k === 'mtime') r = (a[k] || 0) - (b[k] || 0);
    else if (k !== 'name') r = collator.compare(String(a[k] ?? ''), String(b[k] ?? ''));
    return sort.dir * r || (k === 'name' ? sort.dir : 1) * collator.compare(a.name, b.name);
  }

  // Sortierte Einträge – gemerkt, solange sich Liste und Sortierung nicht ändern
  function sorted(f) {
    const sig = sort.key + ':' + sort.dir;
    if (f._sortSrc !== f.entries || f._sortSig !== sig) {
      f._sortSrc = f.entries;
      f._sortSig = sig;
      f._sorted = f.entries.slice().sort(compare);
    }
    return f._sorted;
  }

  function setSort(key) {
    const c = byKey[key];
    sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: c.desc ? -1 : 1 };
    lsSet('files:sort', sort);
    for (const tab of attached) { applyHead(tab); if (tab.files.loaded) renderFiles(tab); }
  }

  // ---------- Kopf: Sortierpfeil, Breiten, sichtbare Spalten ----------

  function applyHead(tab) {
    const f = tab.files;
    for (const c of COLUMNS) {
      f.el.classList.toggle('hide-' + c.cls, hidden.has(c.key));
      const th = f.head.querySelector(`th[data-col=${c.key}]`);
      if (!th) continue;
      th.classList.toggle('sorted', sort.key === c.key);
      th.classList.toggle('desc', sort.key === c.key && sort.dir < 0);
      if (c.w) th.style.width = widthOf(c) + 'px';
    }
  }

  function applyAll() { for (const tab of attached) applyHead(tab); }

  function headMenu(e) {
    e.preventDefault();
    const entries = COLUMNS.filter(c => c.key !== 'name').map(c => [
      c.label, () => toggle(c.key), '', hidden.has(c.key) ? 'blank' : 'check',
    ]);
    entries.push(null);
    entries.push([t('fileColumns.resetWidths'), () => { widths = {}; lsSet('files:col-widths', widths); applyAll(); }, '', 'columns']);
    openMenu(entries, e.clientX, e.clientY);
  }

  function toggle(key) {
    if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
    lsSet('files:hidden-cols', [...hidden]);
    applyAll();
  }

  // Ziehen an der linken Kante: die Spalte rechts davon wird breiter/schmaler,
  // „Name“ gleicht aus – so folgt die Kante genau der Maus.
  function startResize(e, c) {
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = widthOf(c);
    document.body.classList.add('col-resizing');
    const move = ev => {
      widths[c.key] = Math.max(MIN_W, Math.min(MAX_W, Math.round(startW - (ev.clientX - startX))));
      applyAll();
    };
    const up = () => {
      document.body.classList.remove('col-resizing');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      lsSet('files:col-widths', widths);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  function attach(tab) {
    const f = tab.files;
    const table = f.list.querySelector('table');
    table.classList.add('fc');
    f.head = table.querySelector('thead');
    for (const th of f.head.querySelectorAll('th[data-col]')) {
      const c = byKey[th.dataset.col];
      th.title = t('fileColumns.headTitle');
      th.addEventListener('click', ev => { if (!ev.target.closest('.col-grip')) setSort(c.key); });
      if (c.w) {
        const grip = document.createElement('span');
        grip.className = 'col-grip';
        grip.title = t('fileColumns.gripTitle');
        grip.addEventListener('pointerdown', ev => startResize(ev, c));
        grip.addEventListener('mousedown', ev => ev.stopPropagation());
        grip.addEventListener('click', ev => ev.stopPropagation());
        grip.addEventListener('dblclick', ev => { ev.stopPropagation(); delete widths[c.key]; lsSet('files:col-widths', widths); applyAll(); });
        th.appendChild(grip);
      }
    }
    f.head.addEventListener('contextmenu', headMenu);
    attached.add(tab);
    applyHead(tab);
  }

  function detach(tab) { attached.delete(tab); }

  return { attach, detach, sorted, COLUMNS };
})();
