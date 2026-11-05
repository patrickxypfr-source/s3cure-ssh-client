// Update-Fenster: zeigt den Fortschritt von app/lib/updater.js
(() => {
  const api = window.s3update;
  const $ = id => document.getElementById(id);
  const bar = document.querySelector('.up-bar');
  const mb = n => I18N.fmtNumber(n / 1e6, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  let versions = null;
  let notesShown = false;
  let closeMode = false; // Knopf unten rechts: „Schließen“ statt „Abbrechen“

  // „Was ist neu in x.y.z“ – einmal anzeigen, sobald der Release-Text bekannt ist
  function showNotes(st) {
    if (notesShown || !st.version || !Array.isArray(st.notes) || !st.notes.length) return;
    if (!window.renderReleaseNotes($('up-notes-body'), st.notes)) return;
    notesShown = true;
    $('up-notes-title').textContent = t('whatsNew.title', { version: st.version });
    $('up-notes').hidden = false;
    requestAnimationFrame(() => api.fit?.(Math.ceil(document.querySelector('.up-card').getBoundingClientRect().height) + 4));
  }

  function setVersions(st) {
    if (st.version && st.current) versions = { from: st.current, to: st.version };
    if (!versions) return;
    const b = text => { const el = document.createElement('b'); el.textContent = text; return el; };
    $('up-versions').replaceChildren(t('update.versionFrom') + ' ', b(versions.from), ' ' + t('update.versionTo') + ' ', b(versions.to));
  }

  function render(st) {
    if (!st) return;
    setVersions(st);
    showNotes(st);
    bar.classList.remove('busy', 'done', 'error');
    $('up-status').classList.remove('err');
    $('up-alt').hidden = true;
    $('up-cancel').textContent = t('common.cancel');
    closeMode = false;
    $('up-cancel').disabled = false;
    switch (st.phase) {
      case 'check':
        $('up-title').textContent = t('update.preparing');
        $('up-status').textContent = t('update.searching');
        $('up-detail').textContent = '';
        bar.classList.add('busy');
        break;
      case 'download': {
        $('up-title').textContent = t('update.downloading');
        const pct = st.total ? Math.min(100, Math.round(st.received / st.total * 100)) : 0;
        $('up-fill').style.width = pct + '%';
        $('up-status').textContent = t('update.downloadPct', { pct });
        $('up-detail').textContent = st.total
          ? `${t('update.mbOf', { received: mb(st.received), total: mb(st.total) })}${st.speed ? ` · ${mb(st.speed)} MB/s` : ''}`
          : `${mb(st.received)} MB`;
        break;
      }
      case 'verify':
        $('up-title').textContent = t('update.verifying');
        $('up-status').textContent = t('update.verifyStatus');
        $('up-detail').textContent = '';
        bar.classList.add('busy');
        break;
      case 'install':
        $('up-title').textContent = t('update.installing');
        $('up-status').textContent = t('update.restarting');
        $('up-detail').textContent = '';
        bar.classList.add('done');
        $('up-cancel').disabled = true;
        break;
      case 'retry':
        $('up-title').textContent = t('update.interrupted');
        $('up-status').textContent = t('update.retry', { attempt: st.attempt });
        $('up-detail').textContent = '';
        bar.classList.add('busy');
        break;
      case 'handoff':
        if (st.platform === 'linux') {
          // Linux: neue Datei liegt in „Downloads“, die App läuft weiter
          $('up-title').textContent = t('update.downloaded');
          $('up-status').textContent = t('update.inDownloads', { file: String(st.file || '').split('/').pop() });
          $('up-detail').textContent = '';
          bar.classList.add('done');
          $('up-cancel').textContent = t('common.close');
          closeMode = true;
          break;
        }
        $('up-title').textContent = t('update.openingInstaller');
        $('up-status').textContent = st.platform === 'darwin'
          ? t('update.dragToApps')
          : t('update.followInstaller');
        $('up-detail').textContent = '';
        bar.classList.add('done');
        $('up-cancel').disabled = true;
        break;
      case 'error':
        $('up-title').textContent = t('update.failed');
        $('up-status').textContent = st.message || t('update.unknownError');
        $('up-status').classList.add('err');
        $('up-detail').textContent = '';
        bar.classList.add('error');
        $('up-alt').hidden = false;
        $('up-cancel').textContent = t('common.close');
        closeMode = true;
        break;
    }
  }

  $('up-cancel').addEventListener('click', () => {
    if (closeMode) api.close(); else api.cancel();
  });
  $('up-alt').addEventListener('click', () => api.open());
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('up-cancel').disabled) $('up-cancel').click(); });

  api.onState(render);
  api.state().then(render);
})();
