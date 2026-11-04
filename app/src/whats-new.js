// „Was ist neu in x.y.z“ – erscheint einmal nach dem ersten Start einer neuen Version.
// Daten: app/lib/update-check.js (Release-Text von GitHub), Anzeige: src/release-notes-view.js
(() => {
  const api = window.s3update;
  if (!api?.whatsNew) return;

  function show(info) {
    const modal = document.createElement('div');
    modal.id = 'whats-new';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="dialog wn-dialog" role="dialog" aria-modal="true" aria-labelledby="wn-title">
        <div class="wn-head">
          <img class="wn-logo" src="logo.png" alt="">
          <div><h2 id="wn-title"></h2><div class="wn-sub">Das Update ist installiert.</div></div>
        </div>
        <div class="wn-body release-notes"></div>
        <div class="actions">
          <button type="button" class="btn" data-github>Auf GitHub ansehen</button>
          <button type="button" class="btn primary" data-close>Alles klar</button>
        </div>
      </div>`;
    modal.querySelector('h2').textContent = `Was ist neu in ${info.version}`;
    window.renderReleaseNotes(modal.querySelector('.wn-body'), info.notes);
    const close = () => {
      modal.hidden = true;
      api.whatsNewSeen();
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => modal.remove(), 50);
    };
    const onKey = e => { if (e.key === 'Escape' && !modal.hidden) { e.preventDefault(); e.stopPropagation(); close(); } };
    modal.querySelector('[data-close]').addEventListener('click', close);
    modal.querySelector('[data-github]').addEventListener('click', () => api.open());
    modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(modal);
    modal.querySelector('[data-close]').focus();
  }

  window.addEventListener('load', () => {
    setTimeout(() => api.whatsNew().then(info => { if (info && info.notes?.length) show(info); }).catch(() => {}), 600);
  });
})();
