// Übertragungsliste: laufende Uploads/Downloads mit Fortschritt und Abbrechen
// Jeder Aufruf von sftp:upload / sftp:download ist ein Auftrag (job), auch wenn
// er viele Dateien enthält. Die Oberfläche bekommt 'transfer:update'-Nachrichten.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CANCEL_TEXT = 'Übertragung abgebrochen.';
const posix = path.posix;
const p = fn => new Promise((res, rej) => fn((e, r) => e ? rej(e) : res(r)));

// Leitet alle Aufrufe an das echte SFTP-Objekt weiter. Nach dem Abbrechen
// schlagen read/write sofort fehl -> fastPut/fastGet räumen auf und melden einen Fehler.
function cancellable(sftp, job) {
  return new Proxy(sftp, {
    get(target, prop, receiver) {
      if ((prop === 'read' || prop === 'write') && job.cancelled) {
        return (...args) => {
          const cb = args[args.length - 1];
          if (typeof cb === 'function') process.nextTick(cb, new Error(CANCEL_TEXT));
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function localSize(paths) {
  let total = 0;
  const walk = file => {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (st.isDirectory()) {
      let children = [];
      try { children = fs.readdirSync(file); } catch {}
      for (const c of children) if (c !== '.DS_Store') walk(path.join(file, c));
    } else total += st.size;
  };
  paths.forEach(walk);
  return total;
}

async function remoteSize(sftp, paths) {
  let total = 0;
  const walk = async remote => {
    let st;
    try { st = await p(cb => sftp.stat(remote, cb)); } catch { return; }
    if (st.isDirectory()) {
      let list = [];
      try { list = await p(cb => sftp.readdir(remote, cb)); } catch {}
      for (const it of list) await walk(posix.join(remote, it.filename));
    } else total += st.size;
  };
  for (const r of paths) await walk(r);
  return total;
}

function create(getWin) {
  const jobs = new Map();

  const send = job => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('transfer:update', {
      id: job.id, tabId: job.tabId, kind: job.kind, title: job.title, file: job.file,
      done: job.done, total: job.total, files: job.files, state: job.state, error: job.error,
    });
  };

  function start(tabId, kind, title) {
    const job = {
      id: crypto.randomUUID(), tabId, kind, title, file: '', done: 0, total: 0, files: 0,
      state: 'running', error: null, cancelled: false, lastSent: 0,
    };
    jobs.set(job.id, job);
    send(job);

    // höchstens ~10 Meldungen pro Sekunde an die Oberfläche
    const tick = (force = false) => {
      const now = Date.now();
      if (force || now - job.lastSent > 100) { job.lastSent = now; send(job); }
    };

    job.setTotal = n => { job.total = n; tick(true); };
    job.check = () => { if (job.cancelled) throw new Error(CANCEL_TEXT); };

    // Eine Datei übertragen. dir: 'put' (hochladen) oder 'get' (herunterladen)
    job.copy = async (dir, sftp, from, to, name) => {
      job.check();
      job.file = name;
      const base = job.done;
      const step = total => { job.done = base + total; tick(); };
      try {
        const s = cancellable(sftp, job);
        if (dir === 'put') await p(cb => s.fastPut(from, to, { step }, cb));
        else await p(cb => s.fastGet(from, to, { step }, cb));
        job.files++;
        tick(true);
      } catch (err) {
        if (job.cancelled) {
          // halb übertragene Datei wieder entfernen
          if (dir === 'put') await p(cb => sftp.unlink(to, cb)).catch(() => {});
          else { try { fs.unlinkSync(to); } catch {} }
          throw new Error(CANCEL_TEXT);
        }
        throw err;
      }
    };

    job.finish = err => {
      job.state = job.cancelled ? 'cancelled' : err ? 'error' : 'done';
      job.error = err && !job.cancelled ? String(err.message || err) : null;
      send(job);
      jobs.delete(job.id);
    };
    return job;
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (job) { job.cancelled = true; job.state = 'cancelling'; send(job); }
  }

  // Beim Schließen eines Tabs alle seine Übertragungen stoppen
  function cancelTab(tabId) {
    for (const job of jobs.values()) if (job.tabId === tabId) cancel(job.id);
  }

  return { start, cancel, cancelTab, localSize, remoteSize, CANCEL_TEXT };
}

module.exports = { create };
