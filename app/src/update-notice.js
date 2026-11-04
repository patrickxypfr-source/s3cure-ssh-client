// S3cure SSH Client – Versionsanzeige unten in der Seitenleiste.
// Immer sichtbar: die eigene Version. Gibt es auf GitHub eine neuere, steht dort deutlich
// „Veraltet“ mit beiden Versionsnummern und einem Knopf zum Herunterladen.
// Die Abfrage macht app/lib/update-check.js (beim Start immer, sonst höchstens stündlich).
// Der Knopf „Update“ startet das automatische Update (app/lib/updater.js).
(() => {
  const api = window.s3update;
  if (!api) return;
  const RECHECK = 60 * 60 * 1000; // stündlich nachsehen, solange die App läuft

  const box = document.createElement('div');
  box.id = 'app-version';
  document.querySelector('#sidebar')?.appendChild(box);

  function render(info) {
    if (!info || !info.current) return;
    if (info.outdated) {
      // id „update-notice“: die eingeklappte Seitenleiste zeigt dann einen roten Punkt (layout.css)
      box.id = 'update-notice';
      box.className = 'outdated';
      box.innerHTML = `
        <div class="un-title">Veraltet – neue Version verfügbar</div>
        <div class="un-versions">
          <span>Deine Version <b class="un-cur"></b></span>
          <span>Neueste <b class="un-new"></b></span>
        </div>
        <button type="button" class="un-get">Update</button>`;
      box.querySelector('.un-cur').textContent = info.current;
      box.querySelector('.un-new').textContent = info.latest;
      // Lädt und installiert die neue Version selbst (app/lib/updater.js, Update-Fenster)
      box.querySelector('.un-get').addEventListener('click', () => api.install());
      box.querySelector('.un-get').title = `Version ${info.latest} herunterladen und installieren – S3cure startet danach neu`;
      box.title = '';
    } else {
      box.id = 'app-version';
      box.className = '';
      box.textContent = `Version ${info.current}`;
      box.title = info.latest ? 'Aktuell – das ist die neueste Version' : 'Neueste Version konnte nicht geprüft werden (offline?)';
      if (info.latest) box.insertAdjacentHTML('beforeend', ' <span class="av-ok">· aktuell</span>');
    }
  }

  const refresh = force => api.check(force).then(render).catch(() => {});
  // Beim Start immer frisch bei GitHub nachfragen, danach regelmäßig und wenn das Fenster nach vorne kommt
  window.addEventListener('load', () => setTimeout(() => refresh(true), 1200));
  setInterval(() => refresh(false), RECHECK);
  window.addEventListener('focus', () => refresh(false));
})();
