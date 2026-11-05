// Ordner synchronisieren (wie WinSCP „Synchronize“) und „Server-Ordner aktuell halten“,
// dazu die Statuszeile „Beobachtet 2 Ordner · 1 Datei extern geöffnet“ und die Menüeinträge
// für „Mit … bearbeiten“ (src/ext-edit.js) und „Vergleichen“ (src/compare.js).
// Hauptprozess: app/lib/sync.js. Eingehängt in renderer.js (attach/detach/addMenuEntries)
// und local-pane.js (addLocalMenuEntries, LocalPane.state/refresh).

Object.assign(ICON_PATHS, {
  sync: 'M4 12a8 8 0 0 1 13.66-5.66L20 8.5 M20 4v4.5h-4.5 M20 12a8 8 0 0 1-13.66 5.66L4 15.5 M4 20v-4.5h4.5',
  watch: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  stop: 'M7 7h10v10H7z',
  arrowBoth: 'M4 9h16 M16 5l4 4-4 4 M20 15H4 M8 11l-4 4 4 4',
});

window.SyncTools = (() => {
  const S = window.s3sync;
  const DEFAULT_EXCLUDES = 'node_modules, .git, .DS_Store, Thumbs.db';
  const ROW_LIMIT = 3000; // mehr Zeilen werden nicht einzeln gezeigt (aber trotzdem synchronisiert)

  // Alle Texte an einer Stelle (Wörterbuch: src/locales, Schlüssel sync.*)
  const fmt = n => I18N.fmtNumber(n);
  const T = {
    btn: t('sync.run'),
    btnTitle: t('sync.btnTitle'),
    menuSync: t('sync.menuSync'),
    menuWatch: t('sync.menuWatch'),
    menuStopWatch: t('sync.menuStopWatch'),
    needPane: t('sync.needPane'),
    title: t('sync.title'),
    here: t('sync.here'),
    server: t('sync.server'),
    modes: { up: t('sync.modeUp'), down: t('sync.modeDown'), both: t('sync.modeBoth') },
    modeTitles: { up: t('sync.modeUpTitle'), down: t('sync.modeDownTitle'), both: t('sync.modeBothTitle') },
    checksum: t('sync.checksum'),
    del: t('sync.del'),
    delTitle: { up: t('sync.delTitleUp'), down: t('sync.delTitleDown'), both: t('sync.delTitleBoth') },
    delWarn: { up: t('sync.delWarnUp'), down: t('sync.delWarnDown') },
    excl: t('sync.excl'),
    exclTitle: t('sync.exclTitle'),
    compareAgain: t('sync.compareAgain'),
    scanning: (l, r) => t('sync.scanning', { local: fmt(l), remote: fmt(r) }),
    hashing: (a, b) => t('sync.hashing', { done: fmt(a), total: fmt(b) }),
    stop: t('sync.stop'),
    nothing: t('sync.nothing'),
    nothingFilter: t('sync.nothingFilter'),
    sameCount: n => t('sync.sameCount', { count: n }),
    more: n => t('sync.more', { count: n }),
    filters: {
      all: t('sync.filterAll'), onlyLocal: t('sync.filterOnlyLocal'), onlyRemote: t('sync.filterOnlyRemote'),
      localNewer: t('sync.filterLocalNewer'), remoteNewer: t('sync.filterRemoteNewer'), differ: t('sync.filterDiffer'), typeClash: t('sync.filterTypeClash'),
    },
    status: {
      onlyLocal: t('sync.statusOnlyLocal'), onlyRemote: t('sync.statusOnlyRemote'), localNewer: t('sync.filterLocalNewer'),
      remoteNewer: t('sync.filterRemoteNewer'), differ: t('sync.filterDiffer'), typeClash: t('sync.statusTypeClash'),
    },
    actions: {
      upload: t('sync.actUpload'), download: t('sync.actDownload'), deleteRemote: t('sync.actDeleteRemote'),
      deleteLocal: t('sync.actDeleteLocal'), none: t('sync.actNone'),
    },
    files: n => t('sync.files', { count: n }),
    summary: (u, d, x, size) => [u && t('sync.sumUpload', { count: u }), d && t('sync.sumDownload', { count: d }), x && t('sync.sumDelete', { count: x })]
      .filter(Boolean).join(' · ') + (size ? ` · ${formatSize(size)}` : ''),
    noneSelected: t('sync.noneSelected'),
    cancel: t('common.cancel'),
    run: t('sync.run'),
    toggleAll: t('sync.toggleAll'),
    colPath: t('sync.colPath'), colLocal: t('sync.here'), colRemote: t('sync.server'), colAction: t('sync.colAction'),
    delConfirmTitle: t('sync.delConfirmTitle'),
    delConfirm: (r, l) => [
      r && t('sync.delConfirmRemote', { count: r }),
      l && t('sync.delConfirmLocal', { count: l }),
    ].filter(Boolean).join('\n'),
    delOk: t('sync.delOk'),
    prefixServer: t('sync.prefixServer'),
    prefixHere: t('sync.prefixHere'),
    andMore: n => t('sync.andMore', { count: n }),
    done: r => {
      const parts = [r.uploaded && t('sync.uploaded', { count: r.uploaded }), r.downloaded && t('sync.downloaded', { count: r.downloaded }), r.deleted && t('sync.deleted', { count: r.deleted })].filter(Boolean);
      return parts.length ? t('sync.doneWith', { list: parts.join(' · ') }) : t('sync.done');
    },
    errTitle: t('sync.errTitle'),
    errMsg: n => t('sync.errMsg', { count: n }),
    watchTitle: t('sync.watchConfirmTitle'),
    watchMsg: (l, r) => t('sync.watchMsg', { local: l, remote: r }),
    watchDetail: (l, r, ex) => t('sync.watchDetail', { local: l, remote: r, excludes: ex || '–' }),
    watchOk: t('sync.watchOk'),
    watchStarted: name => t('sync.watchStarted', { name }),
    watchStopped: name => t('sync.watchStopped', { name }),
    liveWatch: (n, last) => (last ? t('sync.liveWatchLast', { count: n, time: last }) : t('sync.liveWatchNone', { count: n })),
    liveExt: (n, last) => (last ? t('sync.liveExtUploaded', { count: n, time: last }) : t('sync.liveExt', { count: n })),
    details: t('sync.details'),
    popWatch: t('sync.popWatch'),
    popExt: t('sync.popExt'),
    stopBtn: t('sync.stop'),
    endBtn: t('sync.endBtn'),
    showBtn: t('common.open'),
    uploadNow: t('sync.uploadNow'),
    uploads: n => t('sync.uploaded', { count: n }),
    lastAt: time => t('sync.lastAt', { time }),
    pollMode: t('sync.pollMode'),
    extStates: { watching: t('sync.extWatching'), uploading: t('sync.extUploading'), error: t('sync.extError'), conflict: t('sync.extConflict') },
    compareLocal: name => (name ? t('sync.compareLocalNamed', { name }) : t('sync.compareLocalPick')),
    compareRemote: name => t('sync.compareRemote', { name }),
    compareTwo: t('sync.compareTwo'),
    tooBig: name => t('sync.tooBig', { name }),
  };

  const cleanMsg = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const time = ms => new Date(ms).toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' });
  const baseName = s => String(s).split(/[\\/]/).filter(Boolean).pop() || s;
  const excludesText = () => lsGet('sync:excludes', DEFAULT_EXCLUDES);
  const excludesList = text => String(text).split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);

  const views = new Map(); // Tab-ID -> { tab, btn, live }
  let watches = [];

  // ---------- Einhängen in die Dateiansicht ----------

  function attach(tab) {
    const f = tab.files;
    const btn = document.createElement('button');
    btn.className = 'btn sync-btn';
    btn.title = T.btnTitle;
    btn.innerHTML = `${icon('sync')}${T.btn}`;
    btn.addEventListener('click', e => {
      const r = e.currentTarget.getBoundingClientRect();
      openSyncMenu(tab, r.left, r.bottom + 4);
    });
    f.el.querySelector('.files-actions').appendChild(btn);

    const live = document.createElement('div');
    live.className = 'sync-live';
    live.hidden = true;
    f.el.insertBefore(live, f.el.querySelector('.files-status'));
    views.set(tab.id, { tab, btn, live });
    renderLive();
  }

  function detach(tab) {
    const v = views.get(tab.id);
    if (!v) return;
    v.btn.remove();
    v.live.remove();
    views.delete(tab.id);
  }

  // Ordnerpaar: links „Mein Computer“, rechts der Server-Ordner
  function pair(tab) {
    const lp = window.LocalPane?.state(tab);
    if (!lp || !lp.open || !lp.path || !tab.files.path || tab.state !== 'open') return null;
    return { localRoot: lp.path, remoteRoot: tab.files.path };
  }

  function openSyncMenu(tab, x, y) {
    const pr = pair(tab);
    if (!pr) { showError(T.needPane); return; }
    const w = watches.find(x => x.tabId === tab.id && x.localRoot === pr.localRoot && x.remoteRoot === pr.remoteRoot);
    const entries = [
      [T.menuSync, () => openDialog(tab), '', 'sync'],
      w ? [T.menuStopWatch, () => stopWatch(w), 'danger', 'stop'] : [T.menuWatch, () => startWatch(tab), '', 'watch'],
    ];
    openMenu(entries, x, y);
  }

  // ---------- Dialog „Ordner synchronisieren“ ----------

  let dlg = null; // offener Dialog

  function openDialog(tab) {
    const pr = pair(tab);
    if (!pr) { showError(T.needPane); return; }
    closeDialog();
    const modal = document.createElement('div');
    modal.className = 'modal sync-modal';
    modal.innerHTML = `
      <form class="dialog sync-dialog" tabindex="-1">
        <div class="sync-head">
          <h2>${icon('sync')}<span>${T.title}</span></h2>
          <div class="spacer"></div>
          <button type="button" class="round-btn" data-s="close" title="${T.cancel} (Esc)">${icon('close')}</button>
        </div>
        <div class="sync-paths">
          <div class="sync-path"><span class="k">${icon('computer')}${T.here}</span><span class="v" data-s="local"></span></div>
          <span class="sync-dir" data-s="arrow"></span>
          <div class="sync-path"><span class="k">${icon('server')}${T.server}</span><span class="v" data-s="remote"></span></div>
        </div>
        <div class="sync-opts">
          <div class="seg sync-mode">
            ${['up', 'down', 'both'].map(m => `<button type="button" data-mode="${m}" title="${T.modeTitles[m]}">${T.modes[m]}</button>`).join('')}
          </div>
          <label class="toggle" data-s="checksum-wrap"><input type="checkbox" data-s="checksum"><span class="track"><span class="knob"></span></span>${T.checksum}</label>
          <label class="toggle sync-del" data-s="del-wrap"><input type="checkbox" data-s="del"><span class="track"><span class="knob"></span></span>${T.del}</label>
        </div>
        <div class="sync-warn" data-s="warn" hidden></div>
        <div class="sync-excl">
          <span class="k">${T.excl}</span>
          <input data-s="excl" spellcheck="false" title="${T.exclTitle}">
          <button type="button" class="btn" data-s="again">${icon('refresh')}${T.compareAgain}</button>
        </div>
        <div class="sync-filter" data-s="filters"></div>
        <div class="sync-list">
          <table>
            <thead><tr>
              <th class="ck"><input type="checkbox" data-s="all" title="${T.toggleAll}"></th>
              <th class="st"></th><th>${T.colPath}</th><th class="side">${T.colLocal}</th><th class="side">${T.colRemote}</th><th class="act">${T.colAction}</th>
            </tr></thead>
            <tbody></tbody>
          </table>
          <div class="sync-msg" data-s="msg"><span class="spinner"></span><span data-s="msg-text"></span><button type="button" class="btn" data-s="stop">${T.stop}</button></div>
        </div>
        <div class="sync-foot">
          <span class="sync-sum" data-s="sum"></span>
          <div class="spacer"></div>
          <button type="button" class="btn" data-s="cancel">${T.cancel}</button>
          <button type="submit" class="btn primary" data-s="run">${icon('sync')}${T.run}</button>
        </div>
      </form>`;
    document.body.appendChild(modal);
    const q = s => modal.querySelector(`[data-s="${s}"]`);
    const d = {
      tab, modal, q, ...pr, result: null, rows: [], filter: 'all', compareId: null, running: false,
      mode: lsGet('sync:mode', 'up'), checksum: lsGet('sync:checksum', false), del: false,
      body: modal.querySelector('tbody'),
    };
    dlg = d;
    // LRM: Pfad bleibt bei rechtsbündigem Kürzen richtig herum
    q('local').textContent = '\u200E' + pr.localRoot + '\u200E';
    q('local').title = pr.localRoot;
    q('remote').textContent = '\u200E' + pr.remoteRoot + '\u200E';
    q('remote').title = pr.remoteRoot;
    q('excl').value = excludesText();
    q('checksum').checked = d.checksum;

    for (const b of modal.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(d, b.dataset.mode));
    q('checksum').addEventListener('change', e => { d.checksum = e.target.checked; lsSet('sync:checksum', d.checksum); runCompare(d); });
    q('del').addEventListener('change', e => { d.del = e.target.checked; applySuggestions(d); });
    q('excl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runCompare(d); } });
    q('again').addEventListener('click', () => runCompare(d));
    q('stop').addEventListener('click', () => { if (d.compareId) S.cancel(d.compareId); });
    q('close').addEventListener('click', closeDialog);
    q('cancel').addEventListener('click', closeDialog);
    q('all').addEventListener('change', e => {
      for (const r of visibleRows(d)) if (r.action) r.checked = e.target.checked;
      renderRows(d);
    });
    modal.querySelector('form').addEventListener('submit', e => { e.preventDefault(); execute(d); });
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDialog(); } });
    modal.addEventListener('mousedown', e => { if (e.target === modal) closeDialog(); });

    setMode(d, d.mode, true);
    modal.querySelector('form').focus();
    runCompare(d);
  }

  function closeDialog() {
    if (!dlg) return;
    if (dlg.compareId) S.cancel(dlg.compareId);
    dlg.modal.remove();
    const tab = dlg.tab;
    dlg = null;
    tab.files?.list?.focus();
  }

  function setMode(d, mode, quiet = false) {
    d.mode = ['up', 'down', 'both'].includes(mode) ? mode : 'up';
    lsSet('sync:mode', d.mode);
    for (const b of d.modal.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === d.mode);
    d.q('arrow').innerHTML = icon(d.mode === 'up' ? 'arrowRight' : d.mode === 'down' ? 'arrowLeft' : 'arrowBoth');
    const delInput = d.q('del');
    delInput.disabled = d.mode === 'both';
    if (d.mode === 'both') { delInput.checked = false; d.del = false; }
    d.q('del-wrap').classList.toggle('disabled', d.mode === 'both');
    d.q('del-wrap').title = T.delTitle[d.mode];
    if (!quiet) applySuggestions(d);
    else renderWarn(d);
  }

  function renderWarn(d) {
    const w = d.q('warn');
    w.textContent = d.del ? T.delWarn[d.mode] || '' : '';
    w.hidden = !w.textContent;
  }

  async function runCompare(d) {
    if (d.compareId) S.cancel(d.compareId);
    const text = d.q('excl').value.trim();
    lsSet('sync:excludes', text);
    const id = 'cmp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    d.compareId = id;
    d.result = null;
    d.rows = [];
    renderRows(d);
    setMsg(d, T.scanning(0, 0), true);
    try {
      const r = await S.compare(d.tab.id, {
        localRoot: d.localRoot, remoteRoot: d.remoteRoot, excludes: excludesList(text), checksum: d.checksum, compareId: id,
      });
      if (dlg !== d || d.compareId !== id) return;
      d.compareId = null;
      d.result = r;
      d.rows = r.items.map(item => ({ item, action: null, checked: false, warn: null }));
      applySuggestions(d);
    } catch (err) {
      if (dlg !== d || d.compareId !== id) return;
      d.compareId = null;
      setMsg(d, cleanMsg(err), false, true);
      renderSummary(d);
    }
  }

  S.onProgress(info => {
    if (!dlg || info.compareId !== dlg.compareId) return;
    setMsg(dlg, info.phase === 'hash' ? T.hashing(info.hashed, info.toHash) : T.scanning(info.local, info.remote), true);
  });

  function setMsg(d, text, busy = false, error = false) {
    const m = d.q('msg');
    m.hidden = !text;
    m.classList.toggle('busy', busy);
    m.classList.toggle('error', error);
    d.q('msg-text').textContent = text || '';
  }

  // Vorschläge aus dem Hauptprozess für die gewählte Richtung übernehmen
  function applySuggestions(d) {
    const key = d.mode === 'both' ? 'both' : d.mode + (d.del ? 'Del' : '');
    for (const r of d.rows) {
      const s = r.item.suggest[key];
      r.action = s.action;
      r.checked = !!s.checked && !!s.action;
      r.warn = s.warn || null;
    }
    renderWarn(d);
    renderFilters(d);
    renderRows(d);
  }

  function visibleRows(d) {
    return d.filter === 'all' ? d.rows : d.rows.filter(r => r.item.status === d.filter);
  }

  function renderFilters(d) {
    const box = d.q('filters');
    box.innerHTML = '';
    if (!d.result) return;
    const counts = {};
    for (const r of d.rows) counts[r.item.status] = (counts[r.item.status] || 0) + 1;
    const keys = ['all', 'onlyLocal', 'onlyRemote', 'localNewer', 'remoteNewer', 'differ', 'typeClash'];
    for (const k of keys) {
      const n = k === 'all' ? d.rows.length : counts[k] || 0;
      if (k !== 'all' && !n && !['onlyLocal', 'onlyRemote', 'localNewer', 'remoteNewer'].includes(k)) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sync-chip' + (d.filter === k ? ' on' : '') + (k !== 'all' ? ' st-' + k : '');
      b.disabled = k !== 'all' && !n;
      b.innerHTML = '<span class="dot"></span>';
      b.append(T.filters[k], Object.assign(document.createElement('b'), { textContent: fmt(n) }));
      b.addEventListener('click', () => { d.filter = k; renderFilters(d); renderRows(d); });
      box.appendChild(b);
    }
    if (d.result.same) box.appendChild(Object.assign(document.createElement('span'), { className: 'sync-same', textContent: T.sameCount(d.result.same) }));
  }

  const sideText = (e, isDir, item) => {
    if (!e) return '–';
    if (isDir) return T.files(item.files || 0) + (item.size ? ' · ' + formatSize(item.size) : '');
    return `${formatSize(e.size)} · ${formatDate(e.mtime)}`;
  };

  function renderRows(d) {
    const body = d.body;
    body.innerHTML = '';
    const rows = visibleRows(d);
    for (const r of rows.slice(0, ROW_LIMIT)) {
      const it = r.item;
      const tr = document.createElement('tr');
      tr.className = 'st-' + it.status + (r.checked ? ' on' : '') + (r.action ? '' : ' none');
      tr.innerHTML = `
        <td class="ck"><input type="checkbox"></td>
        <td class="st"><span class="sync-badge"></span></td>
        <td class="name"><div class="nm"><span class="ico"></span><span class="n"></span><span class="w"></span></div></td>
        <td class="side l"></td><td class="side r"></td>
        <td class="act"></td>`;
      const ck = tr.querySelector('.ck input');
      ck.checked = r.checked;
      ck.disabled = !r.action;
      ck.addEventListener('change', () => { r.checked = ck.checked; tr.classList.toggle('on', r.checked); renderSummary(d); });
      tr.querySelector('.sync-badge').textContent = T.filters[it.status] || it.status;
      tr.querySelector('.sync-badge').title = T.status[it.status] || '';
      tr.querySelector('.ico').innerHTML = icon(it.isDir ? 'folder' : 'file');
      tr.querySelector('.ico').classList.add(it.isDir ? 'dir' : 'doc');
      tr.querySelector('.n').textContent = it.rel + (it.isDir ? '/' : '');
      tr.querySelector('.name').title = it.rel;
      if (r.warn) { const w = tr.querySelector('.w'); w.textContent = r.warn; w.title = r.warn; }
      tr.querySelector('.side.l').textContent = sideText(it.local, it.isDir && it.status === 'onlyLocal', it);
      tr.querySelector('.side.r').textContent = sideText(it.remote, it.isDir && it.status === 'onlyRemote', it);
      tr.querySelector('.act').appendChild(actionPicker(d, r, tr));
      // Klick auf die Zeile = Häkchen umschalten
      tr.addEventListener('click', e => {
        if (e.target.closest('input, select') || !r.action) return;
        ck.checked = !ck.checked;
        ck.dispatchEvent(new Event('change'));
      });
      body.appendChild(tr);
    }
    if (rows.length > ROW_LIMIT) {
      const tr = document.createElement('tr');
      tr.className = 'sync-more';
      tr.innerHTML = '<td colspan="6"></td>';
      tr.firstChild.textContent = T.more(rows.length - ROW_LIMIT);
      body.appendChild(tr);
    }
    const all = d.q('all');
    const actionable = rows.filter(r => r.action);
    all.checked = actionable.length > 0 && actionable.every(r => r.checked);
    all.indeterminate = !all.checked && actionable.some(r => r.checked);
    all.disabled = !actionable.length;
    if (d.result) {
      if (!d.rows.length) setMsg(d, T.nothing);
      else if (!rows.length) setMsg(d, T.nothingFilter);
      else setMsg(d, '');
    }
    renderSummary(d);
  }

  // Auswahlfeld für die Aktion (nur sinnvolle Möglichkeiten; Löschen nur mit Schalter)
  function actionPicker(d, r, tr) {
    const options = r.item.actions.filter(a => !a.startsWith('delete') || (d.del && d.mode !== 'both'));
    if (r.action && !options.includes(r.action)) options.push(r.action);
    if (!options.length) return Object.assign(document.createElement('span'), { className: 'sync-noact', textContent: T.actions.none });
    const sel = document.createElement('select');
    sel.className = 'sync-act';
    for (const a of [...options, 'none']) sel.appendChild(new Option(T.actions[a], a));
    sel.value = r.action || 'none';
    const paint = () => { sel.dataset.a = r.action || 'none'; };
    paint();
    sel.addEventListener('change', () => {
      r.action = sel.value === 'none' ? null : sel.value;
      r.checked = !!r.action;
      r.warn = null;
      tr.classList.toggle('none', !r.action);
      tr.classList.toggle('on', r.checked);
      tr.querySelector('.w').textContent = '';
      const ck = tr.querySelector('.ck input');
      ck.disabled = !r.action;
      ck.checked = r.checked;
      paint();
      renderSummary(d);
    });
    return sel;
  }

  function chosenOps(d) {
    return d.rows.filter(r => r.checked && r.action).map(r => ({ rel: r.item.rel, action: r.action, size: r.item.size || 0, isDir: r.item.isDir }));
  }

  function renderSummary(d) {
    const ops = chosenOps(d);
    const n = a => ops.filter(o => o.action === a).length;
    const size = ops.filter(o => o.action === 'upload' || o.action === 'download').reduce((s, o) => s + o.size, 0);
    const del = n('deleteRemote') + n('deleteLocal');
    d.q('sum').textContent = ops.length ? T.summary(n('upload'), n('download'), del, size) : d.result ? T.noneSelected : '';
    d.q('sum').classList.toggle('danger', del > 0);
    d.q('run').disabled = !ops.length || !!d.compareId || d.running;
  }

  async function execute(d) {
    const ops = chosenOps(d);
    if (!ops.length || d.running) return;
    const delR = ops.filter(o => o.action === 'deleteRemote');
    const delL = ops.filter(o => o.action === 'deleteLocal');
    if (delR.length || delL.length) {
      const list = [...delR, ...delL];
      const names = list.slice(0, 8).map(o => (o.action === 'deleteRemote' ? T.prefixServer : T.prefixHere) + o.rel + (o.isDir ? '/' : '')).join('\n')
        + (list.length > 8 ? '\n' + T.andMore(list.length - 8) : '');
      // Dialog liegt über dem Synchronisieren-Fenster (askLocal, renderer.js)
      const ok = await askLocal({ kind: 'confirm', title: T.delConfirmTitle, message: T.delConfirm(delR.length, delL.length), detail: names, okLabel: T.delOk, danger: true });
      if (!ok || dlg !== d) return;
    }
    d.running = true;
    const { tab, localRoot, remoteRoot } = d;
    const excludes = excludesList(d.q('excl').value);
    closeDialog();
    try {
      const r = await S.run(tab.id, { localRoot, remoteRoot, ops: ops.map(({ rel, action, size }) => ({ rel, action, size })), excludes });
      flash(T.done(r));
      if (r.errors.length) {
        askLocal({
          kind: 'info', title: T.errTitle, message: T.errMsg(r.errors.length),
          detail: r.errors.slice(0, 10).map(e => `${e.rel}: ${e.error}`).join('\n') + (r.errors.length > 10 ? '\n' + T.andMore(r.errors.length - 10) : ''),
        });
      }
    } catch (err) { showError(err); }
    // Beide Listen neu laden
    if (tab.state === 'open' && tab.files.path) loadDir(tab, tab.files.path);
    window.LocalPane?.refresh(tab);
  }

  // ---------- Server-Ordner aktuell halten ----------

  async function startWatch(tab) {
    const pr = pair(tab);
    if (!pr) { showError(T.needPane); return; }
    const ex = excludesText();
    const ok = await askLocal({
      kind: 'confirm', title: T.watchTitle, message: T.watchMsg(baseName(pr.localRoot), pr.remoteRoot),
      detail: T.watchDetail(pr.localRoot, pr.remoteRoot, ex), okLabel: T.watchOk,
    });
    if (!ok) return;
    try {
      await S.watchStart(tab.id, { ...pr, excludes: excludesList(ex), label: tab.title });
      flash(T.watchStarted(baseName(pr.localRoot)));
    } catch (err) { showError(err); }
  }

  async function stopWatch(w) {
    try { await S.watchStop(w.id); flash(T.watchStopped(baseName(w.localRoot))); } catch (err) { showError(err); }
  }

  S.onWatch(list => { watches = list; renderLive(); });
  S.watchList().then(list => { watches = list; renderLive(); }).catch(() => {});
  ExtEdit.onChange(() => renderLive());

  // ---------- Statuszeile in der Dateiansicht ----------

  function lastTime(list, key) {
    const t = Math.max(0, ...list.map(x => x[key] || 0));
    return t ? time(t) : null;
  }

  function renderLive() {
    const ext = ExtEdit.list();
    for (const v of views.values()) {
      const box = v.live;
      box.innerHTML = '';
      box.hidden = !watches.length && !ext.length;
      if (watches.length) {
        const err = watches.find(w => w.error);
        const seg = document.createElement('div');
        seg.className = 'sync-live-seg' + (err ? ' warn' : '') + (watches.some(w => w.busy) ? ' busy' : '');
        seg.innerHTML = `<span class="pulse"></span>${icon('watch')}<span class="txt"></span>`;
        seg.querySelector('.txt').textContent = T.liveWatch(watches.length, lastTime(watches, 'lastTransfer')) + (err ? ' · ' + err.error : '');
        seg.title = watches.map(w => `${w.localRoot} → ${w.remoteRoot}`).join('\n');
        if (watches.length === 1) seg.appendChild(liveBtn(T.stopBtn, () => stopWatch(watches[0]), 'stop'));
        seg.appendChild(liveBtn(T.details, e => openPop(e.currentTarget)));
        box.appendChild(seg);
      }
      if (ext.length) {
        const err = ext.find(f => f.state === 'error' || f.state === 'conflict');
        const seg = document.createElement('div');
        seg.className = 'sync-live-seg' + (err ? ' warn' : '') + (ext.some(f => f.state === 'uploading') ? ' busy' : '');
        seg.innerHTML = `${icon('external')}<span class="txt"></span>`;
        seg.querySelector('.txt').textContent = T.liveExt(ext.length, lastTime(ext, 'lastUpload'));
        seg.title = ext.map(f => f.remote).join('\n');
        seg.appendChild(liveBtn(T.details, e => openPop(e.currentTarget)));
        box.appendChild(seg);
      }
    }
    if (pop) renderPop();
  }

  function liveBtn(text, fn, ico) {
    const b = document.createElement('button');
    b.className = 'sync-live-btn';
    b.innerHTML = ico ? icon(ico) : '';
    b.append(text);
    b.addEventListener('click', fn);
    return b;
  }

  // Aufklappliste mit allen beobachteten Ordnern und extern geöffneten Dateien
  let pop = null;
  function openPop(anchor) {
    closePop();
    pop = document.createElement('div');
    pop.className = 'sync-pop';
    document.body.appendChild(pop);
    pop.anchor = anchor;
    renderPop();
    setTimeout(() => document.addEventListener('mousedown', outside, true));
  }
  function outside(e) { if (pop && !pop.contains(e.target)) closePop(); }
  function closePop() {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener('mousedown', outside, true);
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pop) closePop(); });

  function renderPop() {
    const ext = ExtEdit.list();
    if (!watches.length && !ext.length) { closePop(); return; }
    pop.innerHTML = '';
    const section = (title, items, build) => {
      if (!items.length) return;
      const h = document.createElement('div');
      h.className = 'sync-pop-h';
      h.textContent = title;
      pop.appendChild(h);
      for (const it of items) pop.appendChild(build(it));
    };
    const item = (ico, title, sub, sub2, buttons, warn) => {
      const el = document.createElement('div');
      el.className = 'sync-pop-item' + (warn ? ' warn' : '');
      el.innerHTML = `<span class="ico">${icon(ico)}</span><div class="t"><div class="a"></div><div class="b"></div><div class="c"></div></div><div class="btns"></div>`;
      el.querySelector('.a').textContent = title;
      el.querySelector('.b').textContent = sub;
      el.querySelector('.b').title = sub;
      el.querySelector('.c').textContent = sub2;
      for (const [text, fn, cls] of buttons) {
        const b = document.createElement('button');
        b.className = 'btn ' + (cls || '');
        b.textContent = text;
        b.addEventListener('click', fn);
        el.querySelector('.btns').appendChild(b);
      }
      return el;
    };
    section(T.popWatch, watches, w => item('watch', baseName(w.localRoot), `${w.localRoot} → ${w.remoteRoot}`,
      [w.label, T.uploads(w.uploads), w.lastTransfer && T.lastAt(time(w.lastTransfer)), w.mode === 'poll' && T.pollMode, w.error].filter(Boolean).join(' · '),
      [[T.stopBtn, () => stopWatch(w)]], !!w.error));
    section(T.popExt, ext, f => item('external', f.name, f.remote,
      [f.label, f.app, T.extStates[f.state] || '', f.lastUpload && T.lastAt(time(f.lastUpload)), f.error].filter(Boolean).join(' · '),
      [[T.showBtn, () => ExtEdit.show(f.id)], [T.uploadNow, () => ExtEdit.upload(f.id)], [T.endBtn, () => ExtEdit.closeFile(f.id)]],
      f.state === 'error' || f.state === 'conflict'));
    // über dem Knopf anzeigen
    const r = pop.anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pr.width - 8)) + 'px';
    pop.style.top = Math.max(8, r.top - pr.height - 6) + 'px';
  }

  // ---------- Rechtsklick-Menüs ----------

  const remotePath = (tab, it) => joinPath(tab.files.path, it.name);

  // Server-Liste (renderer.js, showContextMenu)
  function addMenuEntries(tab, sel, entries) {
    if (tab.state !== 'open') return;
    const files = sel.filter(x => !x.isDir);
    const extra = [];
    if (sel.length === 1 && files.length === 1) {
      const it = files[0];
      const remote = remotePath(tab, it);
      extra.push(...ExtEdit.menuEntries(tab, remote));
      // Gegenstück auf diesem Computer: Auswahl links oder gleicher Name im linken Ordner
      const lp = window.LocalPane?.state(tab);
      let cand = null;
      if (lp && lp.open) {
        const picked = lp.selected.filter(x => !x.isDir);
        cand = picked.length === 1 ? picked[0] : lp.entries.find(x => !x.isDir && x.name === it.name) || null;
      }
      extra.push([T.compareLocal(cand && cand.name), async () => {
        if (it.size > Compare.LIMIT) { showError(T.tooBig(it.name)); return; }
        const local = cand ? cand.path : await S.pickLocal(lp && lp.path);
        if (local) Compare.localVsRemote(tab, local, remote);
      }, '', 'compare']);
    }
    if (sel.length === 2 && files.length === 2) {
      extra.push([T.compareTwo, () => {
        const big = files.find(x => x.size > Compare.LIMIT);
        if (big) { showError(T.tooBig(big.name)); return; }
        Compare.remoteVsRemote(tab, remotePath(tab, files[0]), remotePath(tab, files[1]));
      }, '', 'compare']);
    }
    if (extra.length) entries.push(null, ...extra);
  }

  // Liste „Mein Computer“ (local-pane.js, showMenu)
  function addLocalMenuEntries(tab, sel, entries) {
    const files = sel.filter(x => !x.isDir);
    const extra = [];
    if (sel.length === 1 && files.length === 1 && tab.state === 'open' && tab.files.loaded) {
      const it = files[0];
      const f = tab.files;
      const picked = f.entries.filter(x => f.selected.has(x.name) && !x.isDir);
      const cand = picked.length === 1 ? picked[0] : f.entries.find(x => !x.isDir && x.name === it.name);
      if (cand) {
        extra.push([T.compareRemote(cand.name), () => {
          if (cand.size > Compare.LIMIT || it.size > Compare.LIMIT) { showError(T.tooBig(cand.size > Compare.LIMIT ? cand.name : it.name)); return; }
          Compare.localVsRemote(tab, it.path, remotePath(tab, cand));
        }, '', 'compare']);
      }
    }
    if (sel.length === 2 && files.length === 2) extra.push([T.compareTwo, () => Compare.localVsLocal(files[0].path, files[1].path), '', 'compare']);
    if (extra.length) entries.push(...extra, null);
  }

  return { attach, detach, addMenuEntries, addLocalMenuEntries, openDialog, startWatch, T };
})();
