// Backup & Umzug und automatischer Abgleich über einen Cloud-Ordner – Bereich in den Einstellungen.
// Hauptprozess: app/lib/backup.js (Export/Import, Verschlüsselung) und app/lib/cloud-sync.js (Abgleich).
// Nutzt aus renderer.js: refreshHosts, askLocal, showError; aus quickbar.js: Quickbar.load; settings.js: Settings.
(() => {
  const B = window.s3backup;
  if (!B) return;
  const MIN_PW = 8;
  const cleanMsg = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PLATFORMS = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' };
  const n = (key, count) => t(key, { count });

  // ---------- kleiner eigener Dialog ----------

  function dialog(html, cls = '') {
    const modal = document.createElement('div');
    modal.className = 'modal bk-modal';
    modal.innerHTML = `<form class="dialog ${cls}">${html}</form>`;
    document.body.appendChild(modal);
    const form = modal.querySelector('form');
    const close = () => modal.remove();
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
    form.querySelectorAll('[data-cancel-bk]').forEach(b => b.addEventListener('click', close));
    const err = form.querySelector('.bk-error');
    const setError = msg => { if (err) { err.textContent = msg || ''; err.hidden = !msg; } };
    const busy = on => form.querySelectorAll('button, input').forEach(el => { el.disabled = on; });
    return { modal, form, close, setError, busy, $: s => form.querySelector(s) };
  }

  const toggleHtml = (name, text, checked = false) =>
    `<label class="toggle"><input type="checkbox" name="${name}"${checked ? ' checked' : ''}><span class="track"><span class="knob"></span></span>${text}</label>`;

  function info(title, message, detail) {
    return askLocal({ kind: 'info', title, message, detail });
  }

  // Nach Änderungen an Verbindungen/Knöpfen die Oberfläche neu laden
  function reloadUi(what = {}) {
    if (what.hosts !== false) refreshHosts().catch(() => {});
    if (what.snippets !== false) window.Quickbar?.load(true);
  }

  // ---------- Export ----------

  function openExport() {
    const d = dialog(`
      <h2>${t('backup.exportTitle')}</h2>
      <p class="bk-text">${t('backup.exportText')}</p>
      ${toggleHtml('secrets', t('backup.exportSecrets'))}
      <label>${t('backup.pwLabel')} <span class="muted">${t('backup.pwMin', { min: MIN_PW })}</span><input name="pw" type="password" autocomplete="new-password"></label>
      <label>${t('backup.pwRepeat')}<input name="pw2" type="password" autocomplete="new-password"></label>
      <p class="bk-error" hidden></p>
      <div class="actions">
        <button type="button" class="btn" data-cancel-bk>${t('common.cancel')}</button>
        <button type="submit" class="btn primary">${t('backup.exportBtn')}</button>
      </div>`, 'bk-dialog');
    d.$('[name=pw]').focus();
    d.form.addEventListener('submit', async e => {
      e.preventDefault();
      const pw = d.$('[name=pw]').value;
      if (pw.length < MIN_PW) return d.setError(t('backup.pwTooShort', { min: MIN_PW }));
      if (pw !== d.$('[name=pw2]').value) return d.setError(t('backup.pwMismatch'));
      d.setError('');
      d.busy(true);
      try {
        const r = await B.exportAll({ password: pw, secrets: d.$('[name=secrets]').checked });
        if (!r) { d.busy(false); return; } // Speichern abgebrochen
        d.close();
        const lines = [n('backup.nHosts', r.hosts)];
        if (d.$('[name=secrets]').checked) lines.push(n('backup.nSecrets', r.passwords));
        if (r.missing) lines.push(n('backup.missing', r.missing));
        info(t('backup.savedTitle'), t('backup.savedMsg', { list: lines.join(', ') }), r.file);
      } catch (err) { d.busy(false); d.setError(cleanMsg(err)); }
    });
  }

  // ---------- Import ----------

  async function openImport() {
    let picked;
    try { picked = await B.pick(); } catch (err) { showError(cleanMsg(err)); return; }
    if (!picked) return;
    const d = dialog(`
      <h2>${t('backup.openTitle')}</h2>
      <p class="bk-text">${t('backup.openText')}</p>
      <label>${t('backup.password')}<input name="pw" type="password" autocomplete="current-password"></label>
      <p class="bk-error" hidden></p>
      <div class="actions">
        <button type="button" class="btn" data-cancel-bk>${t('common.cancel')}</button>
        <button type="submit" class="btn primary">${t('common.open')}</button>
      </div>`, 'bk-dialog');
    d.$('.bk-file').textContent = picked.name;
    d.$('[name=pw]').focus();
    d.form.addEventListener('submit', async e => {
      e.preventDefault();
      d.setError('');
      d.busy(true);
      try {
        const r = await B.preview(picked.file, d.$('[name=pw]').value);
        d.close();
        showPreview(picked, r);
      } catch (err) {
        d.busy(false);
        d.setError(cleanMsg(err));
        d.$('[name=pw]').select();
      }
    });
  }

  const names = list => (list.length ? `<div class="bk-names">${list.slice(0, 8).map(x => t('backup.quoted', { name: esc(x) })).join(', ')}${list.length > 8 ? ' ' + t('backup.andMore', { count: list.length - 8 }) : ''}</div>` : '');

  function diffRow(title, ic, diff) {
    const parts = [];
    if (diff.added.length) parts.push(`<b class="bk-new">${t('backup.nNew', { count: diff.added.length })}</b>`);
    if (diff.changed.length) parts.push(`<b class="bk-chg">${t('backup.nChanged', { count: diff.changed.length })}</b>`);
    if (diff.unchanged) parts.push(t('backup.nSame', { count: diff.unchanged }));
    if (!parts.length) parts.push(t('backup.none'));
    return `<div class="bk-row">${icon(ic)}<div><div class="bk-row-t">${title}: ${parts.join(' · ')}</div>
      ${diff.added.length ? `<div class="bk-sub">${t('backup.newLabel')} ${names(diff.added)}</div>` : ''}
      ${diff.changed.length ? `<div class="bk-sub">${t('backup.changedLabel')} ${names(diff.changed)}</div>` : ''}</div></div>`;
  }

  function showPreview(picked, { token, preview: p }) {
    const when = p.created ? new Date(p.created).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' }) : t('backup.unknown');
    const from = PLATFORMS[p.platform]
      ? t('backup.previewFromPlatform', { when: esc(when), platform: PLATFORMS[p.platform] })
      : t('backup.previewFrom', { when: esc(when) });
    const removedAll = [...p.hosts.removed, ...p.snippets.removed.filter(n => !p.hosts.removed.includes(n))];
    const d = dialog(`
      <h2>${t('backup.previewTitle')}</h2>
      <p class="bk-text">${from}</p>
      <div class="bk-rows">
        ${diffRow(t('backup.hosts'), 'server', p.hosts)}
        ${diffRow(t('backup.snippets'), 'bolt', p.snippets)}
        <div class="bk-row">${icon('shieldCheck')}<div><div class="bk-row-t">${t('backup.knownHosts')}: ${p.knownHosts.added ? `<b class="bk-new">${t('backup.nNew', { count: p.knownHosts.added })}</b>` : t('backup.nothingNew')}</div></div></div>
        <div class="bk-row">${icon('sliders')}<div><div class="bk-row-t">${t('backup.settings')}: ${p.settings.changed ? `<b class="bk-chg">${t('backup.nChanged', { count: p.settings.changed })}</b>` : t('backup.same')}</div></div></div>
        ${p.bookmarks ? `<div class="bk-row">${icon('star')}<div><div class="bk-row-t">${t('backup.bookmarks')}: ${p.bookmarks.changed ? `<b class="bk-chg">${t('backup.differs')}</b>` : t('backup.same')}</div></div></div>` : ''}
        ${p.secrets ? `<div class="bk-row">${icon('lock')}<div><div class="bk-row-t">${t('backup.secretsInBackup', { passwords: n('backup.nPasswords', p.secrets.passwords), passphrases: n('backup.nPassphrases', p.secrets.passphrases) })}</div>
          ${toggleHtml('secrets', t('backup.takeSecrets'), true)}</div></div>` : ''}
      </div>
      <div class="seg bk-mode">
        <button type="button" data-mode="merge" class="on">${t('backup.merge')}</button>
        <button type="button" data-mode="replace">${t('backup.replaceAll')}</button>
      </div>
      <div class="bk-mode-merge">
        <p class="bk-text">${t('backup.mergeText')}</p>
        ${toggleHtml('overwrite', t('backup.overwrite'), true)}
      </div>
      <div class="bk-mode-replace" hidden>
        <p class="bk-text bk-warn">${t('backup.replaceText')}
          ${removedAll.length ? `${t('backup.replaceDeletes')} ${names(removedAll)}` : t('backup.replaceNothing')}</p>
      </div>
      <p class="bk-text bk-small">${t('backup.safetyNote')}</p>
      <p class="bk-error" hidden></p>
      <div class="actions">
        <button type="button" class="btn" data-cancel-bk>${t('common.cancel')}</button>
        <button type="submit" class="btn primary">${t('backup.importBtn')}</button>
      </div>`, 'bk-dialog bk-preview');
    let mode = 'merge';
    for (const b of d.form.querySelectorAll('.bk-mode button')) {
      b.addEventListener('click', () => {
        mode = b.dataset.mode;
        for (const x of d.form.querySelectorAll('.bk-mode button')) x.classList.toggle('on', x === b);
        d.$('.bk-mode-merge').hidden = mode !== 'merge';
        d.$('.bk-mode-replace').hidden = mode !== 'replace';
        d.$('[type=submit]').className = 'btn ' + (mode === 'replace' ? 'danger' : 'primary');
      });
    }
    d.$('[type=submit]').focus();
    d.form.addEventListener('submit', async e => {
      e.preventDefault();
      if (mode === 'replace' && removedAll.length) {
        const ok = await askLocal({
          kind: 'confirm', title: t('backup.replaceQ'), danger: true, okLabel: t('backup.replace'),
          message: t('backup.replaceMsg', { count: removedAll.length }), detail: removedAll.join('\n'),
        });
        if (!ok) return;
      }
      d.busy(true);
      try {
        const r = await B.apply(token, {
          mode, overwrite: d.$('[name=overwrite]').checked, secrets: d.$('[name=secrets]') ? d.$('[name=secrets]').checked : false,
        });
        if (r.settings && Object.keys(r.settings).length) await Settings.set(r.settings);
        d.close();
        reloadUi();
        const msg = [];
        const h = r.hosts.added.length + (mode === 'merge' && !d.$('[name=overwrite]').checked ? 0 : r.hosts.changed.length);
        msg.push(n('backup.hostsTaken', h));
        if (r.knownHosts) msg.push(n('backup.nKnownHosts', r.knownHosts));
        if (r.secrets.saved) msg.push(n('backup.nPasswords', r.secrets.saved));
        info(t('backup.importDone'), msg.join(', ') + '.', [...r.warnings, r.safetyCopy ? t('backup.safetyCopy', { path: r.safetyCopy }) : ''].filter(Boolean).join('\n\n'));
      } catch (err) { d.busy(false); d.setError(cleanMsg(err)); }
    });
  }

  // ---------- Abgleich über Cloud-Ordner ----------

  let syncState = null;
  let syncBox = null; // Anzeige im Einstellungsdialog (wenn offen)

  function openSyncSetup(onDone) {
    const d = dialog(`
      <h2>${t('backup.syncSetupTitle')}</h2>
      <p class="bk-text">${t('backup.syncSetupText')}</p>
      <label>${t('backup.folder')}<div class="row"><input name="folder" class="grow" readonly placeholder="${t('backup.noFolder')}"><button type="button" class="btn" data-pick>${t('common.choose')}</button></div></label>
      <p class="bk-text bk-small bk-folder-hint" hidden></p>
      <label>${t('backup.syncPw')}<input name="pw" type="password" autocomplete="new-password"></label>
      <label class="bk-pw2">${t('backup.pwRepeat')}<input name="pw2" type="password" autocomplete="new-password"></label>
      ${toggleHtml('secrets', t('backup.syncSecrets'))}
      <p class="bk-error" hidden></p>
      <div class="actions">
        <button type="button" class="btn" data-cancel-bk>${t('common.cancel')}</button>
        <button type="submit" class="btn primary">${t('backup.enable')}</button>
      </div>`, 'bk-dialog');
    let folder = null;
    let exists = false;
    d.$('[data-pick]').addEventListener('click', async () => {
      try {
        const r = await B.syncPickFolder();
        if (!r) return;
        folder = r.folder;
        exists = r.exists;
        d.$('[name=folder]').value = folder;
        d.$('[name=folder]').title = folder;
        const hint = d.$('.bk-folder-hint');
        hint.hidden = false;
        hint.textContent = exists
          ? t('backup.folderExists')
          : t('backup.folderNew', { min: MIN_PW });
        d.$('.bk-pw2').hidden = exists;
        d.$('[name=pw]').focus();
      } catch (err) { d.setError(cleanMsg(err)); }
    });
    d.form.addEventListener('submit', async e => {
      e.preventDefault();
      const pw = d.$('[name=pw]').value;
      if (!folder) return d.setError(t('backup.pickFolderFirst'));
      if (!exists && pw.length < MIN_PW) return d.setError(t('backup.pwTooShort', { min: MIN_PW }));
      if (!exists && pw !== d.$('[name=pw2]').value) return d.setError(t('backup.pwMismatch'));
      d.setError('');
      d.busy(true);
      try {
        syncState = await B.syncEnable({ folder, password: pw, secrets: d.$('[name=secrets]').checked });
        d.close();
        onDone?.();
        if (syncState.lastError) showError(syncState.lastError);
      } catch (err) { d.busy(false); d.setError(cleanMsg(err)); }
    });
    d.$('[data-pick]').focus();
  }

  function timeText(iso) {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? t('backup.today', { time: d.toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' }) })
      : d.toLocaleString(I18N.locale, { dateStyle: 'short', timeStyle: 'short' });
  }

  function renderSync() {
    if (!syncBox || !syncBox.isConnected) { syncBox = null; return; }
    const st = syncState || {};
    const toggle = syncBox.querySelector('[name=sync-on]');
    toggle.checked = !!st.enabled;
    const details = syncBox.querySelector('.bk-sync-details');
    details.hidden = !st.enabled;
    if (!st.enabled) return;
    syncBox.querySelector('.bk-sync-folder').textContent = st.folder || '';
    syncBox.querySelector('.bk-sync-folder').title = st.folder || '';
    syncBox.querySelector('[name=sync-secrets]').checked = !!st.secrets;
    const line = syncBox.querySelector('.bk-sync-status');
    line.className = 'bk-sync-status';
    if (st.running) line.textContent = t('backup.syncing');
    else if (st.lastError) { line.textContent = st.lastError; line.classList.add('err'); }
    else if (st.waiting) line.textContent = st.waiting;
    else if (st.lastSync) {
      line.textContent = st.applied
        ? t('backup.lastSyncApplied', { time: timeText(st.lastSync), count: st.applied })
        : t('backup.lastSync', { time: timeText(st.lastSync) });
      line.classList.add('ok');
    } else line.textContent = t('backup.notYet');
    const conf = syncBox.querySelector('.bk-sync-conflicts');
    conf.hidden = !st.conflicts?.length || !!st.lastError;
    if (!conf.hidden) conf.textContent = t('backup.conflicts', { list: st.conflicts.join(', ') });
  }

  function renderSection(box) {
    box.className = 'bk-section';
    box.innerHTML = `
      <div class="bk-block">
        <h4>${t('backup.sectionTitle')}</h4>
        <p class="settings-desc">${t('backup.sectionDesc')}</p>
        <div class="bk-btns">
          <button type="button" class="btn" data-b="export">${icon('upload')}${t('backup.exportAll')}</button>
          <button type="button" class="btn" data-b="import">${icon('download')}${t('backup.importDots')}</button>
        </div>
      </div>
      <div class="bk-block bk-sync">
        <div class="settings-row">
          <div class="settings-label">${t('backup.syncLabel')}
            <small>${t('backup.syncHint')}</small></div>
          ${toggleHtml('sync-on', '')}
        </div>
        <div class="bk-sync-details" hidden>
          <div class="bk-sync-where">${icon('cloud')}<span class="bk-sync-folder"></span></div>
          <div class="bk-sync-status"></div>
          <div class="bk-sync-conflicts" hidden></div>
          <div class="settings-row">
            <div class="settings-label">${t('backup.syncSecrets')}<small>${t('backup.syncSecretsHint')}</small></div>
            ${toggleHtml('sync-secrets', '')}
          </div>
          <div class="bk-btns">
            <button type="button" class="btn" data-b="sync-now">${icon('sync')}${t('backup.syncNow')}</button>
            <button type="button" class="btn ghost" data-b="sync-change">${t('backup.syncChange')}</button>
          </div>
        </div>
      </div>`;
    syncBox = box.querySelector('.bk-sync');
    box.querySelector('[data-b=export]').addEventListener('click', openExport);
    box.querySelector('[data-b=import]').addEventListener('click', openImport);
    const onToggle = box.querySelector('[name=sync-on]');
    onToggle.addEventListener('change', async () => {
      if (onToggle.checked) { onToggle.checked = false; openSyncSetup(renderSync); return; }
      onToggle.checked = true;
      const ok = await askLocal({ kind: 'confirm', title: t('backup.disableQ'), message: t('backup.disableMsg'), okLabel: t('backup.disable') });
      if (!ok) return;
      try { syncState = await B.syncDisable(); } catch (err) { showError(cleanMsg(err)); }
      renderSync();
    });
    box.querySelector('[name=sync-secrets]').addEventListener('change', async e => {
      try { syncState = await B.syncSecrets(e.target.checked); } catch (err) { showError(cleanMsg(err)); }
      renderSync();
    });
    box.querySelector('[data-b=sync-now]').addEventListener('click', async () => {
      try { syncState = await B.syncNow(); } catch (err) { showError(cleanMsg(err)); }
      renderSync();
    });
    box.querySelector('[data-b=sync-change]').addEventListener('click', () => openSyncSetup(renderSync));
    B.syncStatus().then(st => { syncState = st; renderSync(); }).catch(() => {});
    renderSync();
  }

  B.onSyncStatus(st => { syncState = st; renderSync(); });
  // Der Abgleich hat Verbindungen oder Knöpfe geändert -> neu laden
  B.onChanged(what => reloadUi(what || {}));

  registerSettingsSection({
    id: 'backup', title: t('backup.title'), icon: 'cloud', order: 80,
    render: renderSection,
  });

  window.BackupUi = { openExport, openImport, openSyncSetup };
})();
