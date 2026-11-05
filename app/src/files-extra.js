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
      flash(t('filesExtra.notTextDownloading', { name: it.name }));
      downloadItems(tab, [it]);
    }
  }

  async function edit(tab, it) {
    if (it.size > EDIT_LIMIT) {
      showError(t('filesExtra.tooBigForEditor', { name: it.name, size: formatSize(it.size) }));
      return;
    }
    const r = await Editor.open(tab, joinPath(tab.files.path, it.name));
    if (r === 'binary') showError(t('filesExtra.binaryNoEditor', { name: it.name }));
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
            <button class="btn" data-p="edit">${icon('edit')}${t('common.edit')}</button>
            <button class="btn" data-p="download">${icon('download')}${t('filesExtra.download')}</button>
            <button class="round-btn" data-p="close" title="${t('filesExtra.closePreviewTitle')}">${icon('close')}</button>
          </div>
          <div class="preview-body"></div>
          <div class="preview-foot">${t('filesExtra.previewFoot')}</div>
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
    body.innerHTML = `<div class="preview-msg">${t('filesExtra.loadingPreview')}</div>`;
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
      img.onerror = () => { body.innerHTML = ''; body.appendChild(msg(t('filesExtra.imageFailed'))); };
      img.onload = () => { m.querySelector('.preview-meta').textContent = t('filesExtra.imageMeta', { width: img.naturalWidth, height: img.naturalHeight, size: formatSize(it.size), date: formatDate(it.mtime) }); };
      img.src = `data:${r.mime};base64,${r.data}`;
      body.appendChild(img);
    } else if (r.kind === 'text') {
      const pre = document.createElement('pre');
      pre.className = 'preview-text';
      pre.tabIndex = 0;
      pre.textContent = r.text + (r.truncated ? '\n\n' + t('filesExtra.previewTruncated') : '');
      body.appendChild(pre);
      editBtn.hidden = it.size > EDIT_LIMIT;
    } else if (r.kind === 'toolarge') {
      body.appendChild(msg(t('filesExtra.imageTooLarge', { size: formatSize(r.size) })));
    } else {
      body.appendChild(msg(t('filesExtra.noPreview')));
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
    const who = [[t('filesExtra.owner'), 6], [t('filesExtra.group'), 3], [t('filesExtra.others'), 0]];
    const what = [[t('filesExtra.read'), 4], [t('filesExtra.write'), 2], [t('filesExtra.execute'), 1]];
    let mode = parseMode(items[0].mode);
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <form class="dialog chmod-dialog">
        <h2>${t('filesExtra.chmodTitle')}</h2>
        <p class="choose-msg"></p>
        <table class="chmod-grid">
          <thead><tr><th></th>${what.map(([w]) => `<th>${w}</th>`).join('')}</tr></thead>
          <tbody>${who.map(([w, shift]) => `<tr><th>${w}</th>${what.map(([, bit]) =>
            `<td><label class="check"><input type="checkbox" data-bit="${bit << shift}"><span></span></label></td>`).join('')}</tr>`).join('')}</tbody>
        </table>
        <div class="chmod-octal">
          <label>${t('filesExtra.chmodAsNumber')} <input class="chmod-num" maxlength="3" spellcheck="false" autocomplete="off"></label>
          <code class="chmod-text"></code>
        </div>
        <p class="chmod-hint">${t('filesExtra.chmodHint')}</p>
        <div class="actions">
          <button type="button" class="btn" data-c="cancel">${t('common.cancel')}</button>
          <button type="submit" class="btn primary">${t('common.apply')}</button>
        </div>
      </form>`;
    const names = items.length === 1 ? t('filesExtra.quotedName', { name: items[0].name }) : t('filesExtra.items', { count: items.length });
    modal.querySelector('.choose-msg').textContent = t('filesExtra.chmodWho', { names });
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
        flash(t('filesExtra.chmodDone', { text: modeText(mode), num: num.value }));
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
    const base = items.length === 1 ? items[0].name.replace(/\/$/, '') : (dir.split('/').pop() || t('filesExtra.archiveDefault'));
    let name = await askLocal({ kind: 'text', title: t('filesExtra.packTitle'), message: t('filesExtra.packMessage', { names: items.length === 1 ? t('filesExtra.quotedName', { name: items[0].name }) : t('filesExtra.items', { count: items.length }) }), value: base + '.zip', okLabel: t('filesExtra.packOk') });
    if (!name || !name.trim()) return;
    name = name.trim();
    if (!/\.zip$/i.test(name)) name += '.zip';
    if (name.includes('/')) { showError(t('filesExtra.noSlash')); return; }
    let overwrite = false;
    if (await api.archiveExists(tab.id, joinPath(dir, name))) {
      overwrite = await askLocal({ kind: 'confirm', title: t('filesExtra.existsTitle'), message: t('filesExtra.existsMessage', { name }), okLabel: t('filesExtra.overwrite'), danger: true });
      if (!overwrite) return;
    }
    const job = Transfers.busy(t('filesExtra.packing', { name }), 'zip');
    try {
      const r = await api.archivePack(tab.id, dir, items.map(i => i.name), name, overwrite);
      job.done();
      flash(r.tar ? t('filesExtra.packedTar', { name: r.name }) : t('filesExtra.packed', { name: r.name }));
      if (tab.files.path === dir) reloadAndSelect(tab, dir, [r.name]);
    } catch (err) { job.fail(err); showError(err); }
  }

  async function unpack(tab, it) {
    const dir = tab.files.path;
    const job = Transfers.busy(t('filesExtra.unpacking', { name: it.name }), 'unzip');
    try {
      const r = await api.archiveUnpack(tab.id, joinPath(dir, it.name));
      job.done();
      const folder = r.folder.split('/').pop();
      flash(t('filesExtra.unpacked', { folder }));
      if (tab.files.path === dir) reloadAndSelect(tab, dir, [folder]);
    } catch (err) { job.fail(err); showError(err); }
  }

  // ---------- Terminal hier öffnen ----------

  function terminalHere(tab, dir) {
    if (tab.state !== 'open') return;
    if (activeId !== tab.id) activate(tab.id);
    setView('terminal');
    if (tab.term.buffer.active.type === 'alternate') {
      showError(t('filesExtra.terminalBusy'));
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
      extra.push([t('filesExtra.menuPreview'), () => preview(tab, one), '', 'eye']);
      if (!isImage(one.name)) extra.push([t('common.edit'), () => edit(tab, one), '', 'edit']);
    }
    const ftp = !!window.FtpUi?.isFtpTab(tab); // FTP: keine Befehle auf dem Server (kein ZIP, kein Terminal)
    if (!ftp && one && ARCHIVE_RE.test(one.name) && !one.isDir) extra.push([t('filesExtra.menuUnpack'), () => unpack(tab, one), '', 'unzip']);
    if (!ftp) extra.push([t('filesExtra.menuPack'), () => pack(tab, sel), '', 'zip']);
    extra.push([t('filesExtra.menuChmod'), () => chmodDialog(tab, sel), '', 'key']);
    extra.push(null);
    const termDir = one && one.isDir ? joinPath(dir, one.name) : dir;
    if (!ftp) extra.push([t('filesExtra.menuTerminalHere'), () => terminalHere(tab, termDir), '', 'terminal']);
    if (one) extra.push([t('filesExtra.menuCopyPath'), () => { navigator.clipboard.writeText(joinPath(dir, one.name)); flash(t('filesExtra.pathCopied')); }, '', 'copy']);
    entries.push(null, ...extra);
  }

  return { openFile, edit, preview, chmodDialog, pack, unpack, terminalHere, addMenuEntries, isCancel: Transfers.isCancel };
})();
