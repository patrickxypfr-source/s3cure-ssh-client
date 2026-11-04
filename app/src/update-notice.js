// S3cure SSH Client – dezenter Hinweis auf eine neue Version (unten in der Seitenleiste)
// Die Prüfung (höchstens 1x täglich) macht app/lib/update-check.js.
(() => {
  const api = window.s3update;
  if (!api) return;

  async function show() {
    const info = await api.check().catch(() => null);
    if (!info) return;
    const box = document.createElement('div');
    box.id = 'update-notice';
    box.innerHTML = `
      <div class="un-title"></div>
      <div class="un-links">
        <button type="button" class="un-get">Herunterladen</button>
        <button type="button" class="un-later">Später</button>
        <button type="button" class="un-off" title="Nicht mehr nach neuen Versionen suchen">Nicht mehr prüfen</button>
      </div>`;
    box.querySelector('.un-title').textContent = `Version ${info.version} ist da (du hast ${info.current})`;
    box.querySelector('.un-get').addEventListener('click', () => api.open());
    box.querySelector('.un-later').addEventListener('click', () => { api.dismiss(info.version); box.remove(); });
    box.querySelector('.un-off').addEventListener('click', () => { api.disable(); box.remove(); });
    document.querySelector('#sidebar')?.appendChild(box);
  }

  // Etwas später, damit der Start nicht gebremst wird
  window.addEventListener('load', () => setTimeout(show, 3000));
})();
