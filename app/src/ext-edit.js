// Server-Dateien in einem Programm auf diesem Computer bearbeiten (Standardprogramm, VS Code, …).
// Jedes Speichern wird automatisch hochgeladen. Hauptprozess: app/lib/ext-edit.js.
// Die Liste „Extern geöffnete Dateien“ zeigt src/sync.js in der Statuszeile der Dateiansicht.

Object.assign(ICON_PATHS, {
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  app: 'M5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4z M4 8.5h16',
});

const ExtEdit = (() => {
  const S = window.s3sync;
  const T = {
    editDefault: 'Mit Standardprogramm bearbeiten',
    editWith: 'Bearbeiten mit …',
    editWithApp: name => `Mit ${name} bearbeiten`,
    otherApp: 'Anderes Programm wählen …',
    opened: (name, app) => `„${name}“ ${app ? `in ${app} ` : ''}geöffnet – jedes Speichern wird hochgeladen`,
    uploaded: (name, time) => `„${name}“ hochgeladen · ${time}`,
    closed: name => `„${name}“ beendet`,
  };
  const cleanMsg = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const time = ms => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  let list = [];
  const listeners = new Set();
  const lastUploads = new Map(); // id -> Anzahl Uploads (für den Hinweis „hochgeladen 14:32“)

  function update(next) {
    for (const f of next) {
      const before = lastUploads.get(f.id);
      if (before !== undefined && f.uploads > before) flash(T.uploaded(f.name, time(f.lastUpload)));
      lastUploads.set(f.id, f.uploads);
    }
    for (const id of [...lastUploads.keys()]) if (!next.some(f => f.id === id)) lastUploads.delete(id);
    list = next;
    for (const fn of listeners) fn(list);
  }
  S.onExt(update);
  S.extList().then(update).catch(() => {});

  // Rückfragen vom Hauptprozess (Konflikt: Server-Datei wurde geändert)
  S.onExtAsk(async req => S.extAnswer(req.reqId, await askLocal(req)));

  async function openWith(tab, remote, app) {
    try {
      const f = await S.extOpen(tab.id, remote, { app: app ? app.path : null, label: tab.title });
      flash(T.opened(f.name, app ? app.name : null));
    } catch (err) { showError(cleanMsg(err)); }
  }

  // Auswahl: gefundene Editoren + „Anderes Programm wählen …“
  async function chooseApp(tab, remote, x, y) {
    let editors = [];
    try { editors = await S.editors(); } catch {}
    const entries = editors.map(e => [T.editWithApp(e.name), () => openWith(tab, remote, e), '', 'app']);
    if (entries.length) entries.push(null);
    entries.push([T.otherApp, async () => {
      const app = await S.pickApp();
      if (app) openWith(tab, remote, app);
    }, '', 'folder']);
    openMenu(entries, x, y);
  }

  // Einträge für das Rechtsklick-Menü einer Server-Datei
  function menuEntries(tab, remote) {
    // Die Auswahl erscheint dort, wo eben das Rechtsklick-Menü war
    const menu = document.getElementById('ctx-menu');
    const at = () => [parseFloat(menu.style.left) || 100, parseFloat(menu.style.top) || 100];
    return [
      [T.editDefault, () => openWith(tab, remote, null), '', 'external'],
      [T.editWith, () => chooseApp(tab, remote, ...at()), '', 'app'],
    ];
  }

  async function closeFile(id) {
    const f = list.find(x => x.id === id);
    try { await S.extClose(id); if (f) flash(T.closed(f.name)); } catch (err) { showError(cleanMsg(err)); }
  }

  return {
    menuEntries, openWith, chooseApp, closeFile,
    show: id => S.extShow(id).catch(err => showError(cleanMsg(err))),
    upload: id => S.extUpload(id).catch(err => showError(cleanMsg(err))),
    list: () => list,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
