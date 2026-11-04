// Zusätzliche Funktionen im Dateibrowser:
// Öffnen im Editor, Vorschau (Leertaste), Rechte ändern, ZIP packen/entpacken,
// „Terminal hier öffnen“ und die passenden Einträge im Rechtsklick-Menü.

Object.assign(ICON_PATHS, {
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  zip: 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z M14 3v5h5 M11 6h1 M11 9h1 M11 12h1 M10.5 15h2v2.5h-2z',
  unzip: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z M12 10.5v6 M9.5 14l2.5 2.5 2.5-2.5',
  key: 'M14.5 4a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z M10.6 13.4L3.5 20.5 M5.5 18.5l2 2 M8 16l2 2 M16 8.5h.01',
  save: 'M5.5 4h10L20 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4z M8 4v4.5h7V4 M8 20v-6h8v6',
  copy: 'M9 9h10.5v10.5H9z M15 9V4.5H4.5V15H9',
});

const FilesExtra = (() => {
  const EDIT_LIMIT = 2 * 1024 * 1024;
  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
  // Endungen, die sicher keine Textdateien sind -> direkt herunterladen
  const BINARY_EXT = ['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'zst', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
    'exe', 'dll', 'so', 'dylib', 'o', 'a', 'bin', 'img', 'iso', 'dmg', 'deb', 'rpm', 'apk', 'jar', 'class', 'pyc', 'wasm',
    'mp3', 'mp4', 'm4a', 'mov', 'avi', 'mkv', 'webm', 'wav', 'flac', 'ogg', 'ttf', 'otf', 'woff', 'woff2', 'sqlite', 'db', 'psd', 'heic', 'tif', 'tiff'];
  const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz)$/i;

  const ext = name => (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  const isImage = name => IMAGE_EXT.includes(ext(name));
  const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cleanMsg = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // ---------- Öffnen (Doppelklick auf eine Datei) ----------

  async function openFile(tab, it) {
    const file = joinPath(tab.files.path, it.name);
    if (isImage(it.name)) return preview(tab, it);
    if (BINARY_EXT.includes(ext(it.name)) || it.size > EDIT_LIMIT) return downloadItems(tab, [it]);
    const r = await Editor.open(tab, file);
    if (r === 'binary') {
      flash(`„${it.name}“ ist keine Textdatei – wird heruntergeladen.`);
      downloadItems(tab, [it]);
    }
  }

  async function edit(tab, it) {
    if (it.size > EDIT_LIMIT) {
      showError(`„${it.name}“ ist zu groß für den Editor (${formatSize(it.size)}, höchstens 2 MB). Bitte herunterladen.`);
      return;
    }
    const r = await Editor.open(tab, joinPath(tab.files.path, it.name));
    if (r === 'binary') showError(`„${it.name}“ ist keine Textdatei (Binärdatei) und kann nicht im Editor geöffnet werden.`);
  }

  // ---------- Vorschau ----------

  let pv = null; // offene Vorschau: { tab, name, modal }

  function closePreview() {
    if (!pv) return;
    pv.modal.remove();
    const tab = pv.tab;
    pv = null;
    tab.files.list.focus();
  }

  async function preview(tab, it) {
    if (it.isDir) return;
    if (!pv) {
      const modal = document.createElement('div');
      modal.className = 'modal preview-modal';
      modal.innerHTML = `
        <div class="dialog preview-dialog" tabindex="-1">
          <div class="preview-head">
            <span class="preview-ico"></span>
            <div class="preview-title"><div class="preview-name"></div><div class="preview-meta"></div></div>
            <div class="spacer"></div>
            <button class="btn" data-p="edit">${icon('edit')}Bearbeiten</button>
            <button class="btn" data-p="download">${icon('download')}Herunterladen</button>
            <button class="round-btn" data-p="close" title="Schließen (Leertaste / Esc)">${icon('close')}</button>
          </div>
          <div class="preview-body"></div>
          <div class="preview-foot">Leertaste oder Esc schließt · ↑ ↓ blättert durch die Dateien</div>
        </div>`;
      modal.addEventListener('mousedown', e => { if (e.target === modal) closePreview(); });
      modal.querySelector('[data-p=close]').addEventListener('click', closePreview);
      modal.addEventListener('keydown', e => {
        if (e.key === 'Escape' || (e.key === ' ' && !e.target.closest('.preview-text'))) { e.preventDefault(); e.stopPropagation(); closePreview(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); step(e.key === 'ArrowDown' ? 1 : -1); }
      });
      document.body.appendChild(modal);
      pv = { tab, modal };
    }
    pv.tab = tab;
    pv.name = it.name;
    const m = pv.modal;
    const file = joinPath(tab.files.path, it.name);
    m.querySelector('.preview-ico').innerHTML = icon(isImage(it.name) ? 'eye' : 'file');
    m.querySelector('.preview-name').textContent = it.name;
    m.querySelector('.preview-meta').textContent = `${formatSize(it.size)} · ${formatDate(it.mtime)}`;
    const body = m.querySelector('.preview-body');
    body.innerHTML = '<div class="preview-msg">Lade Vorschau …</div>';
    const editBtn = m.querySelector('[data-p=edit]');
    editBtn.hidden = true;
    editBtn.onclick = () => { closePreview(); edit(tab, it); };
    m.querySelector('[data-p=download]').onclick = () => { closePreview(); downloadItems(tab, [it]); };
    m.querySelector('.preview-dialog').focus();

    let r;
    try { r = await api.sftpPreview(tab.id, file); }
    catch (err) {
      if (pv?.name === it.name) { body.innerHTML = ''; body.appendChild(msg(cleanMsg(err))); }
      return;
    }
    if (pv?.name !== it.name) return; // inzwischen weitergeblättert
    body.innerHTML = '';
    if (r.kind === 'image') {
      const img = document.createElement('img');
      img.className = 'preview-img' + (r.mime === 'image/svg+xml' ? ' svg' : '');
      img.alt = it.name;
      img.onerror = () => { body.innerHTML = ''; body.appendChild(msg('Das Bild kann nicht angezeigt werden.')); };
      img.onload = () => { m.querySelector('.preview-meta').textContent = `${img.naturalWidth} × ${img.naturalHeight} Pixel · ${formatSize(it.size)} · ${formatDate(it.mtime)}`; };
      img.src = `data:${r.mime};base64,${r.data}`;
      body.appendChild(img);
    } else if (r.kind === 'text') {
      const pre = document.createElement('pre');
      pre.className = 'preview-text';
      pre.tabIndex = 0;
      pre.textContent = r.text + (r.truncated ? '\n\n… (Vorschau gekürzt – zum Lesen der ganzen Datei „Bearbeiten“ wählen)' : '');
      body.appendChild(pre);
      editBtn.hidden = it.size > EDIT_LIMIT;
    } else if (r.kind === 'toolarge') {
      body.appendChild(msg(`Das Bild ist zu groß für die Vorschau (${formatSize(r.size)}). Bitte herunterladen.`));
    } else {
      body.appendChild(msg('Keine Vorschau – das ist keine Text- oder Bilddatei.'));
    }
  }

  function msg(text) {
    return Object.assign(document.createElement('div'), { className: 'preview-msg', textContent: text });
  }

  // In der Vorschau zur nächsten/vorigen Datei blättern
  function step(dir) {
    const tab = pv.tab;
    const f = tab.files;
    const files = f.entries.filter(e => !e.isDir);
    const idx = files.findIndex(e => e.name === pv.name);
    const next = files[idx + dir];
    if (!next) return;
    f.selected = new Set([next.name]);
    f.anchor = next.name;
    updateSelection(tab);
    f.body.querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' });
    preview(tab, next);
  }

  // Leertaste in der Dateiliste öffnet die Vorschau
  document.addEventListener('keydown', e => {
    if (e.key !== ' ' || pv || !e.target.classList?.contains('files-list')) return;
    const tab = tabs.get(activeId);
    if (!tab || tab.state !== 'open') return;
    const sel = selectedEntries(tab.files).filter(x => !x.isDir);
    if (sel.length !== 1) return;
    e.preventDefault();
    preview(tab, sel[0]);
  });

  // ---------- Rechte ändern ----------

  // 'drwxr-xr-x' -> 0o755
  function parseMode(str) {
    let m = 0;
    for (let i = 0; i < 9; i++) if (str[i + 1] && str[i + 1] !== '-') m |= 1 << (8 - i);
    return m;
  }

  function modeText(m) {
    const c = 'rwxrwxrwx';
    let s = '';
    for (let i = 0; i < 9; i++) s += (m & (1 << (8 - i))) ? c[i] : '-';
    return s;
  }

  function chmodDialog(tab, items) {
    const who = [['Besitzer', 6], ['Gruppe', 3], ['Andere', 0]];
    const what = [['Lesen', 4], ['Schreiben', 2], ['Ausführen', 1]];
    let mode = parseMode(items[0].mode);
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <form class="dialog chmod-dialog">
        <h2>Rechte ändern</h2>
        <p class="choose-msg"></p>
        <table class="chmod-grid">
          <thead><tr><th></th>${what.map(([w]) => `<th>${w}</th>`).join('')}</tr></thead>
          <tbody>${who.map(([w, shift]) => `<tr><th>${w}</th>${what.map(([, bit]) =>
            `<td><label class="check"><input type="checkbox" data-bit="${bit << shift}"><span></span></label></td>`).join('')}</tr>`).join('')}</tbody>
        </table>
        <div class="chmod-octal">
          <label>Als Zahl <input class="chmod-num" maxlength="3" spellcheck="false" autocomplete="off"></label>
          <code class="chmod-text"></code>
        </div>
        <p class="chmod-hint">Ordner brauchen „Ausführen“, damit man sie öffnen kann. Üblich: Dateien 644, Ordner und Programme 755.</p>
        <div class="actions">
          <button type="button" class="btn" data-c="cancel">Abbrechen</button>
          <button type="submit" class="btn primary">Übernehmen</button>
        </div>
      </form>`;
    const names = items.length === 1 ? `„${items[0].name}“` : `${items.length} Elemente`;
    modal.querySelector('.choose-msg').textContent = `Wer darf ${names} lesen, ändern oder ausführen?`;
    const num = modal.querySelector('.chmod-num');
    const boxes = [...modal.querySelectorAll('input[type=checkbox]')];
    const sync = (fromNum = false) => {
      for (const b of boxes) b.checked = !!(mode & Number(b.dataset.bit));
      if (!fromNum) num.value = mode.toString(8).padStart(3, '0');
      modal.querySelector('.chmod-text').textContent = modeText(mode);
      num.classList.toggle('bad', !/^[0-7]{3}$/.test(num.value));
    };
    for (const b of boxes) b.addEventListener('change', () => { mode ^= Number(b.dataset.bit); sync(); });
    num.addEventListener('input', () => {
      if (/^[0-7]{3}$/.test(num.value)) mode = parseInt(num.value, 8);
      sync(true);
    });
    const done = () => { modal.remove(); tab.files.list.focus(); };
    modal.querySelector('[data-c=cancel]').addEventListener('click', done);
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); } });
    modal.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      if (!/^[0-7]{3}$/.test(num.value)) { num.focus(); return; }
      done();
      const dir = tab.files.path;
      try {
        await api.sftpChmod(tab.id, items.map(i => joinPath(dir, i.name)), mode);
        flash(`Rechte geändert: ${modeText(mode)} (${num.value})`);
      } catch (err) { showError(err); }
      reloadAndSelect(tab, dir, items.map(i => i.name));
    });
    document.body.appendChild(modal);
    sync();
    modal.querySelector('button[type=submit]').focus();
  }

  async function reloadAndSelect(tab, dir, names) {
    await loadDir(tab, dir);
    const f = tab.files;
    if (f.path !== dir) return;
    const present = names.filter(n => f.entries.some(e => e.name === n));
    if (!present.length) return;
    f.selected = new Set(present);
    f.anchor = present[0];
    updateSelection(tab);
    f.body.querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' });
  }

  // ---------- ZIP ----------

  async function pack(tab, items) {
    const dir = tab.files.path;
    const base = items.length === 1 ? items[0].name.replace(/\/$/, '') : (dir.split('/').pop() || 'archiv');
    let name = await askLocal({ kind: 'text', title: 'Als ZIP packen', message: `Name der ZIP-Datei für ${items.length === 1 ? `„${items[0].name}“` : `${items.length} Elemente`}:`, value: base + '.zip', okLabel: 'Packen' });
    if (!name || !name.trim()) return;
    name = name.trim();
    if (!/\.zip$/i.test(name)) name += '.zip';
    if (name.includes('/')) { showError('Der Name darf keinen Schrägstrich (/) enthalten.'); return; }
    let overwrite = false;
    if (await api.archiveExists(tab.id, joinPath(dir, name))) {
      overwrite = await askLocal({ kind: 'confirm', title: 'Schon vorhanden', message: `„${name}“ gibt es in diesem Ordner schon. Überschreiben?`, okLabel: 'Überschreiben', danger: true });
      if (!overwrite) return;
    }
    const job = Transfers.busy(`Packe ${name}`, 'zip');
    try {
      const r = await api.archivePack(tab.id, dir, items.map(i => i.name), name, overwrite);
      job.done();
      flash(r.tar ? `„zip“ fehlt auf dem Server – stattdessen gepackt als ${r.name}` : `Gepackt: ${r.name}`);
      if (tab.files.path === dir) reloadAndSelect(tab, dir, [r.name]);
    } catch (err) { job.fail(err); showError(err); }
  }

  async function unpack(tab, it) {
    const dir = tab.files.path;
    const job = Transfers.busy(`Entpacke ${it.name}`, 'unzip');
    try {
      const r = await api.archiveUnpack(tab.id, joinPath(dir, it.name));
      job.done();
      const folder = r.folder.split('/').pop();
      flash(`Entpackt nach „${folder}“`);
      if (tab.files.path === dir) reloadAndSelect(tab, dir, [folder]);
    } catch (err) { job.fail(err); showError(err); }
  }

  // ---------- Terminal hier öffnen ----------

  function terminalHere(tab, dir) {
    if (tab.state !== 'open') return;
    if (activeId !== tab.id) activate(tab.id);
    setView('terminal');
    if (tab.term.buffer.active.type === 'alternate') {
      showError('Im Terminal ist gerade ein Programm wie nano geöffnet. Bitte erst beenden (nano: Strg+X), dann nochmal versuchen.');
      return;
    }
    // Strg+U leert eine halb getippte Zeile
    api.write(tab.id, '\x15cd ' + shQuote(dir) + '\r');
    tab.term.focus();
  }

  // ---------- Rechtsklick-Menü ----------

  // Wird von showContextMenu (renderer.js) aufgerufen, vor „Löschen“
  function addMenuEntries(tab, sel, entries) {
    const dir = tab.files.path;
    const one = sel.length === 1 ? sel[0] : null;
    const extra = [];
    if (one && !one.isDir) {
      extra.push(['Vorschau', () => preview(tab, one), '', 'eye']);
      if (!isImage(one.name)) extra.push(['Bearbeiten', () => edit(tab, one), '', 'edit']);
    }
    const ftp = !!window.FtpUi?.isFtpTab(tab); // FTP: keine Befehle auf dem Server (kein ZIP, kein Terminal)
    if (!ftp && one && ARCHIVE_RE.test(one.name) && !one.isDir) extra.push(['Entpacken', () => unpack(tab, one), '', 'unzip']);
    if (!ftp) extra.push(['Als ZIP packen …', () => pack(tab, sel), '', 'zip']);
    extra.push(['Rechte ändern …', () => chmodDialog(tab, sel), '', 'key']);
    extra.push(null);
    const termDir = one && one.isDir ? joinPath(dir, one.name) : dir;
    if (!ftp) extra.push(['Terminal hier öffnen', () => terminalHere(tab, termDir), '', 'terminal']);
    if (one) extra.push(['Pfad kopieren', () => { navigator.clipboard.writeText(joinPath(dir, one.name)); flash('Pfad kopiert'); }, '', 'copy']);
    entries.push(null, ...extra);
  }

  return { openFile, edit, preview, chmodDialog, pack, unpack, terminalHere, addMenuEntries, isCancel: Transfers.isCancel };
})();
