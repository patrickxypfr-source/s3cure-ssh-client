// Übersicht → „.env“: .env-Dateien auf dem Server finden, als Liste bearbeiten (Werte verdeckt),
// mit einer anderen Datei vergleichen (z. B. .env.example), speichern mit Backup, Backups zurückholen.
// Hauptprozess: lib/env-files.js, Lesen/Schreiben ohne Formatverlust: src/env-core.js
(() => {
  const E = window.EnvCore;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const errMsg = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const MASK = '••••••••';

  function build(st, el) {
    st.env = { files: null, loading: false, error: '', file: null, text: '', lines: null, mtime: 0, reveal: new Set(), showAll: false, compare: null, filter: '', note: '' };
    el.classList.add('env-view');
    el.innerHTML = `
      <div class="env-side card">
        <div class="env-side-head">
          <div class="field env-search"><span class="field-icon">${icon('search')}</span><input placeholder="${t('env.search')}" spellcheck="false"></div>
          <button class="round-btn" data-e="reload" title="${t('env.reload')}">${icon('refresh')}</button>
        </div>
        <div class="env-files"></div>
      </div>
      <div class="env-main card">
        <div class="env-empty">${icon('file')}<p>${t('env.pick')}</p></div>
        <div class="env-editor" hidden>
          <div class="env-bar">
            <div class="env-path"></div>
            <span class="spacer"></span>
            <button class="btn ghost small" data-e="reveal">${icon('unlock')}<span>${t('env.showValues')}</span></button>
            <button class="btn ghost small" data-e="compare">${icon('layers')}<span>${t('env.compare')}</span></button>
            <button class="btn ghost small" data-e="backups">${icon('clock')}<span>${t('env.backups')}</span></button>
            <button class="btn primary small" data-e="save" disabled>${icon('check')}<span>${t('env.save')}</span></button>
          </div>
          <div class="env-compare" hidden></div>
          <div class="env-note" hidden></div>
          <div class="env-table"></div>
          <form class="env-add">
            <input name="key" placeholder="${t('env.newKey')}" spellcheck="false" autocomplete="off">
            <input name="value" placeholder="${t('env.newValue')}" spellcheck="false" autocomplete="off">
            <button class="btn small" type="submit">${icon('plus')}<span>${t('env.add')}</span></button>
          </form>
        </div>
      </div>`;
    const q = s => el.querySelector(s);
    q('.env-search input').addEventListener('input', e => { st.env.filter = e.target.value.trim().toLowerCase(); renderFiles(st, el); });
    q('[data-e=reload]').addEventListener('click', () => findFiles(st, el));
    q('[data-e=reveal]').addEventListener('click', () => { st.env.showAll = !st.env.showAll; st.env.reveal.clear(); renderTable(st, el); });
    q('[data-e=save]').addEventListener('click', () => save(st, el));
    q('[data-e=compare]').addEventListener('click', e => compareMenu(st, el, e.currentTarget));
    q('[data-e=backups]').addEventListener('click', e => backupsMenu(st, el, e.currentTarget));
    q('.env-add').addEventListener('submit', e => {
      e.preventDefault();
      const f = e.currentTarget;
      const key = f.key.value.trim();
      if (!E.KEY_RE.test(key)) { showError(t('env.badKey')); f.key.focus(); return; }
      if (E.toMap(st.env.lines).has(key)) { showError(t('env.keyExists', { key })); return; }
      E.set(st.env.lines, key, f.value.value);
      f.reset();
      renderTable(st, el);
      f.key.focus();
    });
  }

  function show(st, el, force) {
    if (force || (!st.env.files && !st.env.loading)) return findFiles(st, el);
    renderFiles(st, el);
  }

  const dirty = st => { if (!st.env.lines) return false; const d = E.diff(st.env.text, st.env.lines); return !!(d.added.length || d.removed.length || d.changed.length); };

  async function findFiles(st, el) {
    const s = st.env;
    s.loading = true; s.error = '';
    renderFiles(st, el);
    try { s.files = await s3env.find(st.tab.id); } catch (err) { s.error = errMsg(err); }
    s.loading = false;
    renderFiles(st, el);
  }

  function renderFiles(st, el) {
    const s = st.env;
    const box = el.querySelector('.env-files');
    box.innerHTML = '';
    if (s.loading) { box.innerHTML = `<div class="env-hint"><span class="spinner"></span>${t('env.searching')}</div>`; return; }
    if (s.error) { box.innerHTML = `<div class="env-hint err">${esc(s.error)}</div>`; return; }
    const list = (s.files || []).filter(f => !s.filter || f.path.toLowerCase().includes(s.filter));
    if (!list.length) { box.innerHTML = `<div class="env-hint">${t(s.files?.length ? 'env.noMatch' : 'env.none')}</div>`; return; }
    let lastDir = null;
    for (const f of list) {
      if (f.dir !== lastDir) {
        lastDir = f.dir;
        const d = document.createElement('div');
        d.className = 'env-dir';
        d.textContent = f.label || f.dir;
        box.appendChild(d);
      }
      const b = document.createElement('button');
      b.className = 'env-file' + (s.file === f.path ? ' on' : '');
      b.innerHTML = `${icon('file')}<span></span>`;
      b.querySelector('span').textContent = f.name;
      b.title = f.path;
      b.addEventListener('click', () => openFile(st, el, f.path));
      box.appendChild(b);
    }
  }

  async function openFile(st, el, path) {
    const s = st.env;
    if (s.file === path) return;
    if (dirty(st) && !(await askLocal({ kind: 'confirm', title: t('env.discardTitle'), message: t('env.discardMsg', { file: s.file }), okLabel: t('env.discard'), danger: true }))) return;
    try {
      const r = await s3env.read(st.tab.id, path);
      Object.assign(s, { file: path, text: r.text, mtime: r.mtime, lines: E.parse(r.text), compare: null, note: '' });
      s.reveal.clear(); s.showAll = false;
    } catch (err) { showError(t('env.readFailed', { error: errMsg(err) })); return; }
    renderFiles(st, el);
    renderTable(st, el);
  }

  function renderTable(st, el) {
    const s = st.env;
    const q = sel => el.querySelector(sel);
    q('.env-empty').hidden = !!s.lines;
    q('.env-editor').hidden = !s.lines;
    if (!s.lines) return;
    const meta = (s.files || []).find(f => f.path === s.file);
    q('.env-path').textContent = meta && meta.label ? `${meta.label}/${meta.name}` : s.file;
    q('.env-path').title = s.file;
    q('[data-e=reveal] span').textContent = s.showAll ? t('env.hideValues') : t('env.showValues');
    q('[data-e=save]').disabled = !dirty(st);
    const note = q('.env-note');
    note.hidden = !s.note;
    note.textContent = s.note;

    const table = q('.env-table');
    table.innerHTML = '';
    const pairs = s.lines.filter(l => l.type === 'pair');
    if (!pairs.length) table.innerHTML = `<div class="env-hint">${t('env.empty')}</div>`;
    const missing = new Set((s.compare?.result.onlyHere) || []);
    for (const p of pairs) {
      const hidden = !s.showAll && !s.reveal.has(p) && E.isSecretKey(p.key) && p.value !== '';
      const row = document.createElement('div');
      row.className = 'env-row' + (p.dirty ? ' changed' : '') + (missing.has(p.key) ? ' only' : '');
      row.innerHTML = `
        <div class="env-key"></div>
        <div class="env-val">${hidden ? `<span class="env-mask">${MASK}</span>` : '<input spellcheck="false" autocomplete="off">'}</div>
        <div class="env-acts">
          <button class="mini-btn" data-a="eye" title="${t(hidden ? 'env.show' : 'env.hide')}">${icon(hidden ? 'unlock' : 'lock')}</button>
          <button class="mini-btn" data-a="copy" title="${t('env.copy')}">${icon('file')}</button>
          <button class="mini-btn danger" data-a="del" title="${t('env.delete')}">${icon('trash')}</button>
        </div>`;
      row.querySelector('.env-key').textContent = p.key;
      const input = row.querySelector('input');
      if (input) {
        input.value = p.value;
        input.addEventListener('input', () => { E.set(s.lines, p.key, input.value); row.classList.add('changed'); q('[data-e=save]').disabled = !dirty(st); });
      } else {
        row.querySelector('.env-mask').addEventListener('click', () => { s.reveal.add(p); renderTable(st, el); });
      }
      row.querySelector('[data-a=eye]').addEventListener('click', () => { if (hidden) s.reveal.add(p); else { s.reveal.delete(p); if (s.showAll) { s.showAll = false; for (const x of pairs) if (x !== p) s.reveal.add(x); } } renderTable(st, el); });
      row.querySelector('[data-a=copy]').addEventListener('click', () => navigator.clipboard.writeText(p.value).catch(() => {}));
      row.querySelector('[data-a=del]').addEventListener('click', async () => {
        if (!(await askLocal({ kind: 'confirm', title: t('env.deleteTitle'), message: t('env.deleteMsg', { key: p.key }), okLabel: t('env.delete'), danger: true }))) return;
        E.remove(s.lines, p.key);
        renderTable(st, el);
      });
      table.appendChild(row);
    }
    renderCompare(st, el);
  }

  // ---------- Vergleichen ----------
  function compareMenu(st, el, btn) {
    const s = st.env;
    const others = (s.files || []).filter(f => f.path !== s.file);
    // gleiche Ordner zuerst (typisch: .env.example daneben)
    others.sort((a, b) => (b.dir === dirOf(s.file)) - (a.dir === dirOf(s.file)) || /example|sample|template|dist/i.test(b.name) - /example|sample|template|dist/i.test(a.name));
    const r = btn.getBoundingClientRect();
    const entries = others.slice(0, 15).map(f => [f.dir === dirOf(s.file) ? f.name : f.path, () => runCompare(st, el, f.path), '', 'file']);
    if (s.compare) entries.unshift([t('env.compareOff'), () => { s.compare = null; renderTable(st, el); }, '', 'close'], null);
    if (!entries.length) entries.push([t('env.compareNone'), () => {}, '', 'info']);
    openMenu(entries, r.left, r.bottom + 4);
  }
  const dirOf = p => String(p || '').slice(0, String(p || '').lastIndexOf('/')) || '/';

  async function runCompare(st, el, path) {
    try {
      const r = await s3env.read(st.tab.id, path);
      st.env.compare = { path, text: r.text, result: E.compare(st.env.lines, r.text) };
    } catch (err) { showError(t('env.readFailed', { error: errMsg(err) })); return; }
    renderTable(st, el);
  }

  function renderCompare(st, el) {
    const box = el.querySelector('.env-compare');
    const c = st.env.compare;
    box.hidden = !c;
    if (!c) return;
    c.result = E.compare(st.env.lines, c.text);
    const { missingHere, onlyHere } = c.result;
    const name = c.path.slice(c.path.lastIndexOf('/') + 1);
    box.innerHTML = `<div class="env-cmp-title">${icon('layers')}<span>${esc(t('env.compareWith', { file: name }))}</span></div>`;
    if (!missingHere.length && !onlyHere.length) { box.insertAdjacentHTML('beforeend', `<div class="env-cmp-ok">${icon('checkCircle')}${t('env.compareSame')}</div>`); return; }
    if (missingHere.length) {
      const wrap = document.createElement('div');
      wrap.className = 'env-cmp-missing';
      wrap.innerHTML = `<div class="env-cmp-label">${esc(t('env.missingHere', { n: missingHere.length }))}</div>`;
      for (const m of missingHere) {
        const b = document.createElement('button');
        b.className = 'env-chip';
        b.innerHTML = `${icon('plus')}<span></span>`;
        b.querySelector('span').textContent = m.key;
        b.title = t('env.takeOver');
        b.addEventListener('click', () => { E.set(st.env.lines, m.key, m.value); renderTable(st, el); });
        wrap.appendChild(b);
      }
      box.appendChild(wrap);
    }
    if (onlyHere.length) box.insertAdjacentHTML('beforeend', `<div class="env-cmp-only">${esc(t('env.onlyHere', { n: onlyHere.length, list: onlyHere.join(', ') }))}</div>`);
  }

  // ---------- Speichern, Backups ----------
  async function save(st, el) {
    const s = st.env;
    const d = E.diff(s.text, s.lines);
    const lines = [
      d.added.length ? t('env.diffAdded', { list: d.added.join(', ') }) : '',
      d.changed.length ? t('env.diffChanged', { list: d.changed.join(', ') }) : '',
      d.removed.length ? t('env.diffRemoved', { list: d.removed.join(', ') }) : '',
    ].filter(Boolean);
    const ok = await askLocal({ kind: 'confirm', title: t('env.saveTitle'), message: t('env.saveMsg', { file: s.file }), detail: lines.join('\n') || t('env.diffFormat'), okLabel: t('env.save') });
    if (!ok) return;
    const text = E.serialize(s.lines);
    try {
      const r = await s3env.write(st.tab.id, s.file, text, s.mtime);
      Object.assign(s, { text, mtime: r.mtime, lines: E.parse(text), note: t('env.saved') });
    } catch (err) { showError(t('env.saveFailed', { error: errMsg(err) })); return; }
    renderTable(st, el);
  }

  async function backupsMenu(st, el, btn) {
    const s = st.env;
    const r = btn.getBoundingClientRect();
    let list = [];
    try { list = await s3env.backups(st.tab.id, s.file); } catch (err) { showError(errMsg(err)); return; }
    const entries = list.slice(0, 15).map(b => [t('env.backupFrom', { time: new Date(b.at).toLocaleString(I18N.locale) }), () => restore(st, el, b), '', 'undo']);
    if (!entries.length) entries.push([t('env.noBackups'), () => {}, '', 'info']);
    openMenu(entries, r.left, r.bottom + 4);
  }

  async function restore(st, el, b) {
    const s = st.env;
    const ok = await askLocal({ kind: 'confirm', title: t('env.restoreTitle'), message: t('env.restoreMsg', { file: s.file, time: new Date(b.at).toLocaleString(I18N.locale) }), okLabel: t('env.restore'), danger: true });
    if (!ok) return;
    try {
      await s3env.restore(st.tab.id, s.file, b.name);
      const f = s.file;
      s.file = null; s.lines = null;
      await openFile(st, el, f);
      st.env.note = t('env.restored');
      renderTable(st, el);
    } catch (err) { showError(errMsg(err)); }
  }

  window.Dashboard?.addSection({ id: 'env', label: '.env', icon: 'sliders', build, show });

  window.Palette?.register(() => (tabs.get(activeId) && !window.FtpUi?.isFtpTab(tabs.get(activeId)) && !window.LocalTerm?.isLocalTab(tabs.get(activeId))
    ? [{ key: 'act:env', section: 'actions', icon: 'sliders', label: t('env.palette'), run: () => Dashboard.openSection('env'),
      keywords: 'env umgebungsvariablen konfiguration secrets environment variables config dotenv' }] // i18n-ignore
    : []));
})();
