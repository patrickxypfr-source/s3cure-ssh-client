// Update-Fenster: zeigt den Fortschritt von app/lib/updater.js
(() => {
  const api = window.s3update;
  const $ = id => document.getElementById(id);
  const bar = document.querySelector('.up-bar');
  const mb = n => (n / 1e6).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  let versions = null;

  function setVersions(st) {
    if (st.version && st.current) versions = { from: st.current, to: st.version };
    if (versions) $('up-versions').innerHTML = `Von <b>${versions.from}</b> auf <b>${versions.to}</b>`;
  }

  function render(st) {
    if (!st) return;
    setVersions(st);
    bar.classList.remove('busy', 'done', 'error');
    $('up-status').classList.remove('err');
    $('up-alt').hidden = true;
    $('up-cancel').textContent = 'Abbrechen';
    $('up-cancel').disabled = false;
    switch (st.phase) {
      case 'check':
        $('up-title').textContent = 'Update wird vorbereitet …';
        $('up-status').textContent = 'Suche neueste Version …';
        $('up-detail').textContent = '';
        bar.classList.add('busy');
        break;
      case 'download': {
        $('up-title').textContent = 'Update wird heruntergeladen';
        const pct = st.total ? Math.min(100, Math.round(st.received / st.total * 100)) : 0;
        $('up-fill').style.width = pct + '%';
        $('up-status').textContent = `Herunterladen … ${pct} %`;
        $('up-detail').textContent = st.total
          ? `${mb(st.received)} von ${mb(st.total)} MB${st.speed ? ` · ${mb(st.speed)} MB/s` : ''}`
          : `${mb(st.received)} MB`;
        break;
      }
      case 'verify':
        $('up-title').textContent = 'Update wird geprüft';
        $('up-status').textContent = 'Prüfe das heruntergeladene Paket …';
        $('up-detail').textContent = '';
        bar.classList.add('busy');
        break;
      case 'install':
        $('up-title').textContent = 'Update wird installiert';
        $('up-status').textContent = 'S3cure startet gleich neu …';
        $('up-detail').textContent = '';
        bar.classList.add('done');
        $('up-cancel').disabled = true;
        break;
      case 'retry':
        $('up-title').textContent = 'Verbindung unterbrochen';
        $('up-status').textContent = `Neuer Versuch (${st.attempt} von 3) …`;
        $('up-detail').textContent = '';
        bar.classList.add('busy');
        break;
      case 'handoff':
        $('up-title').textContent = 'Installer wird geöffnet';
        $('up-status').textContent = st.platform === 'darwin'
          ? 'Im Fenster die App auf „Programme“ ziehen und „Ersetzen“ wählen.'
          : 'Bitte dem Installationsfenster folgen.';
        $('up-detail').textContent = '';
        bar.classList.add('done');
        $('up-cancel').disabled = true;
        break;
      case 'error':
        $('up-title').textContent = 'Update nicht möglich';
        $('up-status').textContent = st.message || 'Unbekannter Fehler';
        $('up-status').classList.add('err');
        $('up-detail').textContent = '';
        bar.classList.add('error');
        $('up-alt').hidden = false;
        $('up-cancel').textContent = 'Schließen';
        break;
    }
  }

  $('up-cancel').addEventListener('click', () => {
    if ($('up-cancel').textContent === 'Schließen') api.close(); else api.cancel();
  });
  $('up-alt').addEventListener('click', () => api.open());
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('up-cancel').disabled) $('up-cancel').click(); });

  api.onState(render);
  api.state().then(render);
})();
