// Eingebauter Datei-Editor im Dateibrowser
// Öffnet Textdateien (bis 2 MB) per SFTP, speichert mit Cmd/Strg+S atomar zurück.
// Pro Tab ein Editor-Feld, das über der Dateiliste liegt.

const Editor = (() => {
  const SAVE_KEY = IS_MAC ? 'Cmd+S' : 'Strg+S';
  const FIND_KEY = IS_MAC ? 'Cmd+F' : 'Strg+F';
  const CLOSE_KEY = IS_MAC ? 'Cmd+W' : 'Strg+W';

  // ---------- Dialog mit mehreren Knöpfen (Speichern / Nicht speichern / Abbrechen) ----------

  function choose({ title, message, buttons }) {
    return new Promise(resolve => {
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.innerHTML = '<div class="dialog" tabindex="-1"><h2></h2><p class="choose-msg"></p><div class="actions"></div></div>';
      modal.querySelector('h2').textContent = title;
      modal.querySelector('.choose-msg').textContent = message;
      const actions = modal.querySelector('.actions');
      const done = value => { modal.remove(); resolve(value); };
      let first = null;
      for (const b of buttons) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'btn' + (b.cls ? ' ' + b.cls : '');
        el.textContent = b.label;
        el.addEventListener('click', () => done(b.value));
        actions.appendChild(el);
        if (b.default) first = el;
      }
      modal.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      });
      document.body.appendChild(modal);
      (first || actions.lastChild).focus();
    });
  }

  // ---------- Aufbau ----------

  function build(tab) {
    const el = document.createElement('div');
    el.className = 'editor-panel';
    el.hidden = true;
    el.innerHTML = `
      <div class="editor-bar">
        <span class="editor-ico">${icon('file')}</span>
        <div class="editor-title"><span class="editor-name"></span><span class="editor-dirty" title="Ungespeicherte Änderungen"></span><div class="editor-path"></div></div>
        <div class="spacer"></div>
        <button class="round-btn" data-e="find" title="Suchen (${FIND_KEY})">${icon('search')}</button>
        <button class="btn primary" data-e="save" title="Speichern (${SAVE_KEY})">${icon('save')}Speichern</button>
        <button class="btn" data-e="close" title="Schließen (${CLOSE_KEY})">${icon('close')}Schließen</button>
      </div>
      <div class="editor-find" hidden>
        <div class="field grow"><span class="field-icon">${icon('search')}</span><input class="editor-find-input" placeholder="Suchen im Text …" spellcheck="false"></div>
        <span class="editor-find-count"></span>
        <button class="round-btn" data-e="prev" title="Vorheriger Treffer (Umschalt+Enter)">${icon('up')}</button>
        <button class="round-btn" data-e="next" title="Nächster Treffer (Enter)">${icon('down')}</button>
        <button class="round-btn" data-e="find-close" title="Suche schließen (Esc)">${icon('close')}</button>
      </div>
      <div class="editor-body">
        <div class="editor-gutter" aria-hidden="true"></div>
        <textarea class="editor-text" wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
      </div>
      <div class="editor-status"><span class="editor-pos"></span><span class="spacer"></span><span class="editor-info"></span></div>`;
    tab.files.el.appendChild(el);

    const ed = {
      el, file: null, original: '', opts: null, lines: 0, saving: false,
      ta: el.querySelector('.editor-text'), gutter: el.querySelector('.editor-gutter'),
      findBar: el.querySelector('.editor-find'), findInput: el.querySelector('.editor-find-input'),
    };
    const on = (a, fn) => el.querySelector(`[data-e=${a}]`).addEventListener('click', fn);
    on('save', () => save(tab));
    on('close', () => close(tab));
    on('find', () => openFind(ed));
    on('next', () => findNext(ed, 1));
    on('prev', () => findNext(ed, -1));
    on('find-close', () => closeFind(ed));

    ed.ta.addEventListener('input', () => { updateGutter(ed); updateDirty(tab); });
    ed.ta.addEventListener('scroll', () => { ed.gutter.scrollTop = ed.ta.scrollTop; });
    for (const ev of ['keyup', 'click', 'select']) ed.ta.addEventListener(ev, () => updatePos(ed));
    ed.ta.addEventListener('keydown', e => onKey(tab, e));
    ed.findInput.addEventListener('input', () => { ed.findFrom = null; findNext(ed, 1, true); });
    ed.findInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); findNext(ed, e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(ed); }
      if (modKey(e) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(tab); }
    });
    tab.editor = ed;
    return ed;
  }

  function onKey(tab, e) {
    const ed = tab.editor;
    const k = e.key.toLowerCase();
    if (modKey(e) && !e.altKey) {
      if (k === 's') { e.preventDefault(); e.stopPropagation(); save(tab); return; }
      if (k === 'f') { e.preventDefault(); e.stopPropagation(); openFind(ed); return; }
      if (k === 'w' && (IS_MAC || !e.shiftKey)) { e.preventDefault(); e.stopPropagation(); close(tab); return; }
      if (k === 'g') { e.preventDefault(); e.stopPropagation(); findNext(ed, e.shiftKey ? -1 : 1); return; }
    }
    if (e.key === 'Tab' && !modKey(e) && !e.altKey) {
      e.preventDefault();
      const ta = ed.ta;
      const indent = ed.opts.indent;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const value = ta.value;
      if (start === end && !e.shiftKey) { document.execCommand('insertText', false, indent); return; }
      // Mehrere Zeilen markiert: ein- bzw. ausrücken
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const block = value.slice(lineStart, end);
      const changed = e.shiftKey
        ? block.replace(/^(\t| {1,4})/gm, '')
        : block.replace(/^/gm, indent);
      ta.setSelectionRange(lineStart, end);
      document.execCommand('insertText', false, changed);
      ta.setSelectionRange(lineStart, lineStart + changed.length);
    }
    if (e.key === 'Escape' && !ed.findBar.hidden) { e.preventDefault(); e.stopPropagation(); closeFind(ed); }
  }

  // ---------- Zeilennummern, Position, Status ----------

  function updateGutter(ed, force = false) {
    let lines = 1;
    const v = ed.ta.value;
    for (let i = v.indexOf('\n'); i !== -1; i = v.indexOf('\n', i + 1)) lines++;
    if (lines === ed.lines && !force) return;
    ed.lines = lines;
    let s = '';
    for (let i = 1; i <= lines; i++) s += i + '\n';
    ed.gutter.textContent = s;
    ed.gutter.style.width = `calc(${String(lines).length}ch + 26px)`;
    ed.gutter.scrollTop = ed.ta.scrollTop;
  }

  function updatePos(ed) {
    const pos = ed.ta.selectionStart;
    const before = ed.ta.value.slice(0, pos);
    const line = (before.match(/\n/g) || []).length + 1;
    const col = pos - before.lastIndexOf('\n');
    const sel = ed.ta.selectionEnd - ed.ta.selectionStart;
    ed.el.querySelector('.editor-pos').textContent = `Zeile ${line}, Spalte ${col}${sel ? ` · ${sel} Zeichen markiert` : ''}`;
  }

  function updateInfo(ed) {
    const o = ed.opts;
    const parts = [o.encoding === 'latin1' ? 'Latin-1' : 'UTF-8' + (o.bom ? ' mit BOM' : ''), o.eol === 'crlf' ? 'Windows-Zeilenenden (CRLF)' : 'LF'];
    parts.push(`${ed.lines} Zeile${ed.lines === 1 ? '' : 'n'}`);
    ed.el.querySelector('.editor-info').textContent = parts.join(' · ');
  }

  function isDirty(tab) {
    const ed = tab.editor;
    return !!(ed && ed.file && !ed.el.hidden && ed.ta.value !== ed.original);
  }

  function updateDirty(tab) {
    const ed = tab.editor;
    const dirty = isDirty(tab);
    ed.el.classList.toggle('dirty', dirty);
    tab.tabEl.classList.toggle('unsaved', dirty);
  }

  // ---------- Suchen im Text ----------

  function openFind(ed) {
    ed.findBar.hidden = false;
    const sel = ed.ta.value.slice(ed.ta.selectionStart, ed.ta.selectionEnd);
    if (sel && !sel.includes('\n')) ed.findInput.value = sel;
    ed.findInput.focus();
    ed.findInput.select();
    countMatches(ed);
  }

  function closeFind(ed) {
    ed.findBar.hidden = true;
    ed.ta.focus();
  }

  function countMatches(ed) {
    const q = ed.findInput.value.toLowerCase();
    const out = ed.el.querySelector('.editor-find-count');
    if (!q) { out.textContent = ''; return; }
    const v = ed.ta.value.toLowerCase();
    let n = 0;
    for (let i = v.indexOf(q); i !== -1 && n < 10000; i = v.indexOf(q, i + q.length)) n++;
    out.textContent = n ? `${n} Treffer` : 'Nicht gefunden';
    out.classList.toggle('none', !n);
  }

  function findNext(ed, dir, fromStart = false) {
    const q = ed.findInput.value.toLowerCase();
    countMatches(ed);
    if (!q) return;
    const v = ed.ta.value.toLowerCase();
    const ta = ed.ta;
    let i;
    if (dir > 0) {
      i = v.indexOf(q, fromStart ? ta.selectionStart : ta.selectionEnd);
      if (i === -1) i = v.indexOf(q);
    } else {
      i = ta.selectionStart > 0 ? v.lastIndexOf(q, ta.selectionStart - 1) : -1;
      if (i === -1) i = v.lastIndexOf(q);
    }
    if (i === -1) return;
    ta.setSelectionRange(i, i + q.length);
    // Treffer in den sichtbaren Bereich holen
    const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    const line = (ta.value.slice(0, i).match(/\n/g) || []).length;
    const y = line * lineH;
    if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - lineH * 2) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
    updatePos(ed);
    if (document.activeElement !== ed.findInput) ta.focus();
  }

  // ---------- Öffnen / Speichern / Schließen ----------

  // Gibt 'binary' zurück, wenn die Datei keine Textdatei ist
  async function open(tab, file) {
    const ed = tab.editor || build(tab);
    if (ed.file === file && !ed.el.hidden) { ed.ta.focus(); return 'ok'; }
    if (isDirty(tab) && !(await confirmDiscard(tab))) return 'cancel';

    let r;
    try { r = await api.sftpReadText(tab.id, file); }
    catch (err) { showError(err); return 'error'; }
    if (r.binary) return 'binary';

    const name = file.split('/').pop();
    ed.file = file;
    ed.original = r.text;
    // Einrücken mit Tab, wenn die Datei schon Tabs am Zeilenanfang hat, sonst 2 Leerzeichen
    const tabLines = (r.text.match(/^\t/gm) || []).length;
    const spaces4 = (r.text.match(/^ {4}\S/gm) || []).length;
    const spaces2 = (r.text.match(/^ {2}\S/gm) || []).length;
    const indent = tabLines > spaces2 + spaces4 ? '\t' : spaces4 > spaces2 * 2 ? '    ' : '  ';
    ed.opts = { real: r.real, encoding: r.encoding, bom: r.bom, eol: r.eol, mtime: r.mtime, indent };
    ed.ta.value = r.text;
    ed.el.querySelector('.editor-name').textContent = name;
    ed.el.querySelector('.editor-path').textContent = file;
    ed.el.title = '';
    ed.findBar.hidden = true;
    ed.el.hidden = false;
    updateGutter(ed, true);
    updateInfo(ed);
    updateDirty(tab);
    ed.ta.setSelectionRange(0, 0);
    ed.ta.scrollTop = 0;
    ed.ta.scrollLeft = 0;
    updatePos(ed);
    ed.ta.focus();
    if (r.encoding === 'latin1') flash(`${name}: kein UTF-8 – als Latin-1 geöffnet und wird auch so gespeichert.`);
    return 'ok';
  }

  async function save(tab, force = false) {
    const ed = tab.editor;
    if (!ed || !ed.file || ed.saving) return false;
    const name = ed.file.split('/').pop();
    if (tab.state !== 'open') { showError('Nicht verbunden. Bitte erst neu verbinden – deine Änderungen bleiben im Editor erhalten.'); return false; }
    ed.saving = true;
    ed.el.classList.add('saving');
    const text = ed.ta.value;
    try {
      const r = await api.sftpWriteText(tab.id, ed.file, text, { ...ed.opts, force });
      if (r.conflict) {
        ed.saving = false;
        ed.el.classList.remove('saving');
        const ok = await askLocal({
          kind: 'confirm', title: 'Datei wurde geändert',
          message: `„${name}“ wurde auf dem Server geändert, seit du sie geöffnet hast. Trotzdem mit deiner Version überschreiben?`,
          okLabel: 'Überschreiben', danger: true,
        });
        ed.ta.focus();
        return ok ? save(tab, true) : false;
      }
      ed.original = text;
      ed.opts.mtime = r.mtime;
      updateDirty(tab);
      flash(`Gespeichert: ${name}`);
      // Größe/Datum in der Liste aktualisieren, falls der Ordner gerade offen ist
      const dir = ed.file.replace(/\/[^/]*$/, '') || '/';
      if (tab.files.path === dir) refreshListQuietly(tab);
      return true;
    } catch (err) {
      showError(err);
      return false;
    } finally {
      ed.saving = false;
      ed.el.classList.remove('saving');
    }
  }

  async function refreshListQuietly(tab) {
    const f = tab.files;
    try {
      const r = await api.sftpList(tab.id, f.path);
      if (r.path !== f.path) return;
      f.entries = r.entries;
      const keep = new Set([...f.selected].filter(n => r.entries.some(e => e.name === n)));
      renderFiles(tab);
      f.selected = keep;
      updateSelection(tab);
    } catch {}
  }

  // true = darf weg (gespeichert oder verworfen)
  async function confirmDiscard(tab) {
    if (!isDirty(tab)) return true;
    const name = tab.editor.file.split('/').pop();
    const choice = await choose({
      title: 'Änderungen speichern?',
      message: `„${name}“ hat ungespeicherte Änderungen.`,
      buttons: [
        { label: 'Abbrechen', value: null },
        { label: 'Nicht speichern', value: 'discard', cls: 'danger-outline' },
        { label: 'Speichern', value: 'save', cls: 'primary', default: true },
      ],
    });
    if (choice === 'save') return save(tab);
    if (choice === 'discard') return true;
    tab.editor.ta.focus();
    return false;
  }

  async function close(tab) {
    const ed = tab.editor;
    if (!ed || ed.el.hidden) return true;
    if (!(await confirmDiscard(tab))) return false;
    ed.el.hidden = true;
    ed.file = null;
    ed.original = '';
    ed.ta.value = '';
    updateDirty(tab);
    tab.files.list.focus();
    return true;
  }

  // Fenster schließen / App beenden mit ungespeicherten Änderungen
  let allowUnload = false;
  window.addEventListener('beforeunload', e => {
    if (allowUnload) return;
    const dirty = [...tabs.values()].filter(isDirty);
    if (!dirty.length) return;
    e.preventDefault();
    e.returnValue = false;
    setTimeout(async () => {
      for (const t of dirty) {
        if (activeId !== t.id) activate(t.id);
        if (t.view !== 'files') setView('files');
        if (!(await confirmDiscard(t))) return;
      }
      allowUnload = true;
      window.close();
    }, 0);
  });

  return { open, save, close, isDirty, confirmDiscard, choose };
})();
