// Ansicht „Datenbank“: PostgreSQL des Servers durch die SSH-Verbindung (Hauptprozess: lib/db.js).
// Tabellen ansehen, blättern, sortieren, suchen; Zelle ändern (Doppelklick) und Zeile löschen
// (Rechtsklick) nur mit Rückfrage und nur bei Tabellen mit Primärschlüssel; SQL ausführen; CSV-Export.
// Eingehängt in renderer.js: DbView.update(tab) (updateToolbar) und DbView.detach(tab) (disposeTab).
window.DbView = (() => {
  const states = new Map(); // Tab-ID -> Zustand
  const PAGE = 100;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const errMsg = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const keyOf = tab => tab.spec.name || tab.spec.text || tab.title;
  const sshTab = tab => !!tab && !window.FtpUi?.isFtpTab(tab) && !window.LocalTerm?.isLocalTab(tab);

  // ---------- Umschalter oben ----------
  const viewBtn = document.createElement('button');
  viewBtn.dataset.view = 'db';
  viewBtn.innerHTML = `${icon('database')}${t('db.view')}`;
  viewBtn.title = t('db.viewTitle');
  const desk = document.querySelector('#view-switch [data-view=desktop]');
  if (desk) desk.before(viewBtn); else document.getElementById('view-switch').appendChild(viewBtn);
  viewBtn.addEventListener('click', () => setView('db'));

  // ---------- Aufbau ----------
  function build(tab) {
    const root = document.createElement('div');
    root.className = 'dbv';
    root.hidden = true;
    root.innerHTML = `
      <div class="dbv-head">
        <span class="dbv-status"><span class="dbv-dot"></span><span class="dbv-status-text"></span></span>
        <div class="seg dbv-modes" hidden>
          <button data-m="tables">${icon('list')}${t('db.tables')}</button>
          <button data-m="sql">${icon('code')}SQL</button>
        </div>
        <span class="spacer"></span>
        <button class="btn ghost small" data-a="export" hidden>${icon('download')}<span>CSV</span></button>
        <button class="btn ghost small" data-a="disconnect" hidden>${icon('power')}<span>${t('db.disconnect')}</span></button>
      </div>
      <div class="dbv-body">
        <form class="dbv-form">
          <div class="dbv-form-card">
            <h3>${icon('database')}<span>${t('db.connectTitle')}</span></h3>
            <p class="dbv-hint">${t('db.connectHint')}</p>
            <div class="dbv-detect" hidden></div>
            <div class="dbv-grid2">
              <label>${t('db.host')}<input name="host" value="127.0.0.1" spellcheck="false"></label>
              <label>${t('db.port')}<input name="port" value="5432" inputmode="numeric"></label>
            </div>
            <label>${t('db.database')}<input name="database" spellcheck="false" autocomplete="off"></label>
            <div class="dbv-grid2">
              <label>${t('db.user')}<input name="user" spellcheck="false" autocomplete="off"></label>
              <label>${t('db.password')}<input name="password" type="password" autocomplete="off"></label>
            </div>
            <label class="toggle-row"><input type="checkbox" name="remember" checked> <span>${t('db.remember')}</span></label>
            <div class="dbv-form-err" hidden></div>
            <div class="dbv-form-btns">
              <button type="button" class="btn" data-a="detect">${icon('search')}<span>${t('db.detect')}</span></button>
              <span class="spacer"></span>
              <button type="submit" class="btn primary">${icon('database')}<span>${t('db.connect')}</span></button>
            </div>
          </div>
        </form>
        <div class="dbv-tables" hidden>
          <div class="dbv-side">
            <div class="field"><span class="field-icon">${icon('search')}</span><input class="dbv-tfilter" placeholder="${t('db.findTable')}" spellcheck="false"></div>
            <div class="dbv-tlist"></div>
          </div>
          <div class="dbv-main">
            <div class="dbv-tbar">
              <div class="dbv-tname"></div>
              <span class="spacer"></span>
              <div class="field dbv-rfilter"><span class="field-icon">${icon('search')}</span><input placeholder="${t('db.findRows')}" spellcheck="false"></div>
              <div class="dbv-pager">
                <button class="mini-btn" data-p="prev">${icon('up')}</button>
                <span class="dbv-range"></span>
                <button class="mini-btn" data-p="next">${icon('down')}</button>
              </div>
              <button class="mini-btn" data-a="reload" title="${t('db.reload')}">${icon('refresh')}</button>
            </div>
            <div class="dbv-gridwrap"></div>
            <div class="dbv-foot"></div>
          </div>
        </div>
        <div class="dbv-sql" hidden>
          <div class="dbv-editor">
            <textarea spellcheck="false" placeholder="SELECT * FROM …"></textarea>
            <div class="dbv-sqlbar">
              <span class="dbv-sqlinfo"></span>
              <span class="spacer"></span>
              <button class="btn primary small" data-a="run">${icon('play')}<span>${t('db.run')}</span><kbd>${IS_MAC ? '⌘↵' : 'Ctrl+↵'}</kbd></button>
            </div>
          </div>
          <div class="dbv-gridwrap"></div>
        </div>
      </div>`;
    document.getElementById('terminals').appendChild(root);
    const st = { tab, root, conn: null, mode: 'tables', tables: [], tfilter: '', cur: null, data: null, sqlResult: null, busy: false, lastInfo: undefined };
    const q = s => root.querySelector(s);
    q('.dbv-form').addEventListener('submit', e => { e.preventDefault(); connect(st); });
    q('[data-a=detect]').addEventListener('click', () => detect(st));
    q('[data-a=disconnect]').addEventListener('click', () => disconnect(st));
    q('[data-a=export]').addEventListener('click', () => exportCsv(st));
    for (const b of root.querySelectorAll('.dbv-modes [data-m]')) b.addEventListener('click', () => { st.mode = b.dataset.m; render(st); if (st.mode === 'sql') q('.dbv-sql textarea').focus(); });
    q('.dbv-tfilter').addEventListener('input', e => { st.tfilter = e.target.value.trim().toLowerCase(); renderTableList(st); });
    let ft;
    q('.dbv-rfilter input').addEventListener('input', e => { clearTimeout(ft); ft = setTimeout(() => { if (st.cur) { st.cur.filter = e.target.value; st.cur.offset = 0; loadTable(st); } }, 300); });
    q('[data-p=prev]').addEventListener('click', () => { if (st.cur && st.cur.offset > 0) { st.cur.offset = Math.max(0, st.cur.offset - PAGE); loadTable(st); } });
    q('[data-p=next]').addEventListener('click', () => { if (st.cur && st.data && st.cur.offset + PAGE < st.data.total) { st.cur.offset += PAGE; loadTable(st); } });
    q('[data-a=reload]').addEventListener('click', () => { loadTables(st); if (st.cur) loadTable(st); });
    q('[data-a=run]').addEventListener('click', () => runSql(st));
    q('.dbv-sql textarea').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (IS_MAC ? e.metaKey : e.ctrlKey)) { e.preventDefault(); runSql(st); }
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
    });
    prefill(st);
    return st;
  }

  async function prefill(st) {
    try {
      const r = await s3db.config(keyOf(st.tab));
      const f = st.root.querySelector('.dbv-form');
      if (r.cfg) for (const k of ['host', 'port', 'database', 'user']) if (r.cfg[k] != null) f[k].value = r.cfg[k];
      f.password.placeholder = r.hasPassword ? t('db.passwordSaved') : '';
      st.saved = r;
    } catch {}
  }

  // ---------- Verbinden ----------
  async function connect(st, { auto = false } = {}) {
    const f = st.root.querySelector('.dbv-form');
    const err = st.root.querySelector('.dbv-form-err');
    err.hidden = true;
    st.busy = true; render(st);
    try {
      st.conn = await s3db.connect(st.tab.id, keyOf(st.tab), {
        host: f.host.value, port: f.port.value, database: f.database.value, user: f.user.value,
        password: f.password.value, remember: f.remember.checked,
      });
      f.password.value = '';
      st.wantConnected = true;
      await loadTables(st);
    } catch (e) {
      st.conn = null;
      if (!auto) { err.textContent = errMsg(e); err.hidden = false; }
    } finally { st.busy = false; render(st); }
  }

  async function disconnect(st) {
    st.wantConnected = false;
    await s3db.close(st.tab.id).catch(() => {});
    Object.assign(st, { conn: null, tables: [], cur: null, data: null, sqlResult: null });
    prefill(st);
    render(st);
  }

  async function detect(st) {
    const box = st.root.querySelector('.dbv-detect');
    box.hidden = false;
    box.innerHTML = `<span class="spinner"></span>${t('db.detecting')}`;
    let list = [];
    try { list = await s3db.detect(st.tab.id); } catch (e) { box.textContent = errMsg(e); return; }
    if (!list.length) { box.textContent = t('db.detectNone'); return; }
    box.innerHTML = `<div class="dbv-detect-title">${t('db.detectFound', { n: list.length })}</div>`;
    for (const c of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dbv-cand';
      b.innerHTML = `<b></b><span></span>`;
      b.querySelector('b').textContent = `${c.user}@${c.host}:${c.port}/${c.database}`;
      b.querySelector('span').textContent = c.source + (c.dockerHost ? ' · ' + t('db.dockerHost', { host: c.dockerHost }) : '');
      b.addEventListener('click', () => {
        const f = st.root.querySelector('.dbv-form');
        for (const k of ['host', 'port', 'database', 'user', 'password']) f[k].value = c[k] ?? '';
        box.hidden = true;
        f.querySelector('[type=submit]').focus();
      });
      box.appendChild(b);
    }
  }

  // ---------- Tabellen ----------
  async function loadTables(st) {
    try { st.tables = await s3db.tables(st.tab.id); } catch (e) { showError(errMsg(e)); st.tables = []; }
    renderTableList(st);
  }

  function renderTableList(st) {
    const box = st.root.querySelector('.dbv-tlist');
    box.innerHTML = '';
    const list = st.tables.filter(x => !st.tfilter || `${x.schema}.${x.name}`.toLowerCase().includes(st.tfilter));
    if (!list.length) { box.innerHTML = `<div class="dbv-empty">${t(st.tables.length ? 'db.noMatch' : 'db.noTables')}</div>`; return; }
    let schema = null;
    const multi = new Set(st.tables.map(x => x.schema)).size > 1;
    for (const x of list) {
      if (multi && x.schema !== schema) {
        schema = x.schema;
        box.insertAdjacentHTML('beforeend', `<div class="dbv-schema">${esc(schema)}</div>`);
      }
      const b = document.createElement('button');
      b.className = 'dbv-titem' + (st.cur && st.cur.schema === x.schema && st.cur.table === x.name ? ' on' : '');
      b.innerHTML = `${icon(x.kind === 'v' || x.kind === 'm' ? 'layers' : 'list')}<span class="n"></span><span class="c"></span>`;
      b.querySelector('.n').textContent = x.name;
      b.querySelector('.c').textContent = x.rows >= 1000 ? `~${I18N.fmtNumber(x.rows)}` : x.rows ? I18N.fmtNumber(x.rows) : '';
      b.title = `${x.schema}.${x.name} · ${formatSize(x.size)}`;
      b.addEventListener('click', () => { st.cur = { schema: x.schema, table: x.name, offset: 0, orderBy: null, desc: false, filter: '' }; st.root.querySelector('.dbv-rfilter input').value = ''; renderTableList(st); loadTable(st); });
      box.appendChild(b);
    }
  }

  async function loadTable(st) {
    const cur = st.cur;
    if (!cur) return;
    const wrap = st.root.querySelector('.dbv-tables .dbv-gridwrap');
    wrap.classList.add('loading');
    try {
      const data = await s3db.table(st.tab.id, { ...cur, limit: PAGE });
      if (st.cur !== cur) return;
      st.data = data;
    } catch (e) { showError(errMsg(e)); st.data = null; }
    wrap.classList.remove('loading');
    renderTable(st);
  }

  function renderTable(st) {
    const q = s => st.root.querySelector(s);
    const d = st.data, cur = st.cur;
    q('.dbv-tname').innerHTML = cur ? `${icon('list')}<span>${esc(cur.schema === 'public' ? cur.table : cur.schema + '.' + cur.table)}</span>` : '';
    q('.dbv-range').textContent = d ? (d.total ? t('db.range', { from: I18N.fmtNumber(d.offset + 1), to: I18N.fmtNumber(Math.min(d.offset + d.rows.length, d.total)), total: d.capped ? I18N.fmtNumber(d.total - 1) + '+' : I18N.fmtNumber(d.total) }) : t('db.noRows')) : '';
    q('[data-p=prev]').disabled = !d || d.offset <= 0;
    q('[data-p=next]').disabled = !d || d.offset + d.rows.length >= d.total;
    q('.dbv-foot').textContent = d ? (d.pk.length ? t('db.editHint') : t('db.noPkHint')) : t('db.pickTable');
    const wrap = q('.dbv-tables .dbv-gridwrap');
    if (!d) { wrap.innerHTML = ''; return; }
    grid(wrap, d.columns, d.rows, {
      sort: { col: cur.orderBy, desc: cur.desc, on: col => { cur.desc = cur.orderBy === col ? !cur.desc : false; cur.orderBy = col; cur.offset = 0; loadTable(st); } },
      editable: d.pk.length > 0,
      onEdit: (row, ci, td) => editCell(st, row, ci, td),
      onMenu: (row, ci, e) => cellMenu(st, row, ci, e),
    });
  }

  // ---------- Tabelle zeichnen ----------
  function grid(wrap, columns, rows, opts = {}) {
    const table = document.createElement('table');
    table.className = 'dbv-table';
    const head = document.createElement('tr');
    head.innerHTML = '<th class="rn"></th>' + columns.map((c, i) => {
      const s = opts.sort && opts.sort.col === c.name ? (opts.sort.desc ? ' ↓' : ' ↑') : '';
      return `<th data-i="${i}" title="${esc(c.type)}"><span>${esc(c.name)}</span><small>${esc(c.type)}${s}</small></th>`;
    }).join('');
    const thead = document.createElement('thead');
    thead.appendChild(head);
    table.appendChild(thead);
    if (opts.sort) for (const th of head.querySelectorAll('th[data-i]')) th.addEventListener('click', () => opts.sort.on(columns[th.dataset.i].name));
    const body = document.createElement('tbody');
    rows.forEach((row, ri) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="rn">${(opts.offset || 0) + ri + 1}</td>`;
      row.cells.forEach((v, ci) => {
        const td = document.createElement('td');
        if (v === null) { td.className = 'null'; td.textContent = 'NULL'; }
        else { td.textContent = v.length > 300 ? v.slice(0, 300) + '…' : v; if (v.length > 40) td.title = v.slice(0, 2000); }
        if (opts.editable) td.addEventListener('dblclick', () => opts.onEdit(row, ci, td));
        if (opts.onMenu) td.addEventListener('contextmenu', e => { e.preventDefault(); opts.onMenu(row, ci, e); });
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    wrap.innerHTML = '';
    if (!rows.length) wrap.insertAdjacentHTML('beforeend', `<div class="dbv-empty">${t('db.noRows')}</div>`);
    wrap.prepend(table);
  }

  // ---------- Ändern / Löschen ----------
  function editCell(st, row, ci, td) {
    if (td.querySelector('input')) return;
    const old = row.cells[ci];
    const input = document.createElement('input');
    input.className = 'dbv-cellinput';
    input.value = old ?? '';
    td.textContent = '';
    td.appendChild(input);
    input.focus(); input.select();
    let done = false;
    const finish = async save => {
      if (done) return;
      done = true;
      if (save && input.value !== (old ?? '')) await saveCell(st, row, ci, input.value);
      renderTable(st);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(false));
  }

  const short = v => (v === null ? 'NULL' : v.length > 120 ? v.slice(0, 120) + '…' : v);

  async function saveCell(st, row, ci, value) {
    const d = st.data, col = d.columns[ci].name;
    const ok = await askLocal({
      kind: 'confirm', title: t('db.updateTitle'),
      message: t('db.updateMsg', { column: col, table: st.cur.table, key: d.pk.map((k, i) => `${k} = ${row.pk[i]}`).join(', ') }),
      detail: `${short(row.cells[ci])}\n→ ${short(value)}`, okLabel: t('db.updateOk'),
    });
    if (!ok) return;
    try {
      await s3db.update(st.tab.id, { schema: st.cur.schema, table: st.cur.table, pk: d.pk, pkValues: row.pk, column: col, value });
      await loadTable(st);
    } catch (e) { showError(t('db.updateFailed', { error: errMsg(e) })); }
  }

  function cellMenu(st, row, ci, e) {
    const d = st.data;
    const entries = [[t('db.copyValue'), () => navigator.clipboard.writeText(row.cells[ci] ?? '').catch(() => {}), '', 'file']];
    if (d && d.pk.length) {
      entries.push([t('db.editCell'), () => { const td = e.target.closest('td'); if (td) editCell(st, row, ci, td); }, '', 'edit']);
      if (row.cells[ci] !== null) entries.push([t('db.setNull'), () => saveCell(st, row, ci, null), '', 'close']);
      entries.push(null, [t('db.deleteRow'), () => deleteRow(st, row), 'danger', 'trash']);
    }
    openMenu(entries, e.clientX, e.clientY);
  }

  async function deleteRow(st, row) {
    const d = st.data;
    const ok = await askLocal({
      kind: 'confirm', title: t('db.deleteTitle'),
      message: t('db.deleteMsg', { table: st.cur.table, key: d.pk.map((k, i) => `${k} = ${row.pk[i]}`).join(', ') }),
      okLabel: t('db.deleteOk'), danger: true, focusCancel: true,
    });
    if (!ok) return;
    try {
      await s3db.remove(st.tab.id, { schema: st.cur.schema, table: st.cur.table, pk: d.pk, pkValues: row.pk });
      await loadTable(st);
    } catch (e) { showError(t('db.deleteFailed', { error: errMsg(e) })); }
  }

  // ---------- SQL ----------
  async function runSql(st) {
    const ta = st.root.querySelector('.dbv-sql textarea');
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    const sql = (sel.trim() ? sel : ta.value).trim();
    if (!sql || st.running) return;
    if (!(await s3db.isReadOnly(sql))) {
      const ok = await askLocal({ kind: 'confirm', title: t('db.writeTitle'), message: t('db.writeMsg'), detail: sql.length > 600 ? sql.slice(0, 600) + '…' : sql, okLabel: t('db.run'), danger: true });
      if (!ok) return;
    }
    st.running = true; render(st);
    const info = st.root.querySelector('.dbv-sqlinfo');
    try {
      st.sqlResult = await s3db.query(st.tab.id, sql);
      const r = st.sqlResult;
      info.textContent = r.columns.length
        ? t('db.resultRows', { n: I18N.fmtNumber(r.rows.length), ms: r.ms }) + (r.truncated ? ' · ' + t('db.truncated') : '')
        : t('db.resultCommand', { command: r.command || 'OK', n: r.rowCount ?? 0, ms: r.ms });
      info.className = 'dbv-sqlinfo ok';
      if (!(await s3db.isReadOnly(sql))) loadTables(st);
    } catch (e) {
      st.sqlResult = null;
      info.textContent = errMsg(e);
      info.className = 'dbv-sqlinfo err';
    } finally { st.running = false; render(st); }
  }

  async function exportCsv(st) {
    const src = st.mode === 'sql' ? st.sqlResult : st.data;
    if (!src || !src.columns.length) { showError(t('db.nothingToExport')); return; }
    const name = st.mode === 'sql' ? 'query' : st.cur.table;
    try { await s3db.exportCsv({ name, columns: src.columns, rows: src.rows }); } catch (e) { showError(errMsg(e)); }
  }

  // ---------- Anzeige ----------
  function render(st) {
    const q = s => st.root.querySelector(s);
    const tab = st.tab;
    const connected = !!st.conn;
    const ssh = tab.state === 'open';
    q('.dbv-status').className = 'dbv-status' + (connected ? ' on' : '');
    q('.dbv-status-text').textContent = !ssh ? t('db.sshDown')
      : connected ? `${st.conn.user}@${st.conn.host}:${st.conn.port}/${st.conn.database} · ${st.conn.version}`
        : st.busy ? t('db.connecting') : t('db.notConnected');
    q('.dbv-modes').hidden = !connected;
    for (const b of st.root.querySelectorAll('.dbv-modes [data-m]')) b.classList.toggle('on', b.dataset.m === st.mode);
    q('[data-a=disconnect]').hidden = !connected;
    q('[data-a=export]').hidden = !connected;
    q('.dbv-form').hidden = connected;
    q('.dbv-form [type=submit]').disabled = st.busy || !ssh;
    q('.dbv-tables').hidden = !connected || st.mode !== 'tables';
    q('.dbv-sql').hidden = !connected || st.mode !== 'sql';
    q('[data-a=run]').disabled = !!st.running;
    if (connected && st.mode === 'sql' && st.sqlResult) {
      const r = st.sqlResult;
      grid(q('.dbv-sql .dbv-gridwrap'), r.columns, r.rows, { onMenu: (row, ci, e) => openMenu([[t('db.copyValue'), () => navigator.clipboard.writeText(row.cells[ci] ?? '').catch(() => {}), '', 'file']], e.clientX, e.clientY) });
    }
    if (connected && st.mode === 'tables') renderTable(st);
  }

  function update(tab) {
    const ok = sshTab(tab);
    viewBtn.classList.toggle('ftp-off', !!tab && !ok);
    viewBtn.hidden = !!tab && window.LocalTerm?.isLocalTab(tab);
    for (const st of states.values()) st.root.hidden = !(tab && st.tab === tab && tab.view === 'db');
    if (!tab || tab.view !== 'db') return;
    if (!ok) { setView(window.FtpUi?.isFtpTab(tab) ? 'files' : 'terminal'); showError(t('db.sshOnly')); return; }
    let st = states.get(tab.id);
    if (!st) { st = build(tab); states.set(tab.id, st); }
    st.root.hidden = false;
    // SSH neu verbunden: Datenbank-Verbindung war mit weg -> wieder verbinden, wenn sie vorher bestand
    if (tab.state === 'open' && st.lastInfo !== tab.info) {
      const again = st.lastInfo !== undefined && st.wantConnected;
      st.lastInfo = tab.info;
      if (again) { st.conn = null; connect(st, { auto: true }); return; }
    }
    if (tab.state !== 'open') st.conn = null;
    render(st);
  }

  function detach(tab) {
    const st = states.get(tab.id);
    if (!st) return;
    st.root.remove();
    states.delete(tab.id);
  }

  window.Palette?.register(() => (sshTab(tabs.get(activeId))
    ? [{ key: 'act:db', section: 'actions', icon: 'database', label: t('db.palette'), run: () => setView('db'),
      keywords: 'datenbank postgres postgresql sql tabelle database table query' }] // i18n-ignore
    : []));

  return { update, detach };
})();
