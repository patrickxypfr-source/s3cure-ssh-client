// Übertragungs-Warteschlange wie bei FileZilla
//
// Jeder Aufruf von sftp:upload / sftp:download / xfer:upload / xfer:download ist ein Auftrag (job).
// Beim Vorbereiten (Ordner durchgehen, Rückfragen) meldet der Auftrag seine Dateien mit job.copy()
// an. Die Warteschlange überträgt dann höchstens `concurrency` Dateien gleichzeitig – über alle
// Aufträge hinweg, in der Reihenfolge der Liste.
//
// Aufträge lassen sich pausieren, fortsetzen, verschieben, abbrechen und bei Fehlern erneut
// versuchen. Angehaltene oder abgerissene Dateien gehen dort weiter, wo sie aufgehört haben:
// die Teil-Datei bleibt liegen und wird ab ihrer Größe weitergeschrieben (Versatz). Am Ende wird
// die Größe geprüft. Reißt die Verbindung ab, wartet der Auftrag und läuft nach dem
// Neuverbinden von selbst weiter. Optional gibt es ein Geschwindigkeitslimit (Up/Down getrennt).
//
// Die Oberfläche (src/transfers.js) bekommt 'transfer:update'-Nachrichten.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { t } = require('./i18n');

// Text beim Abbrechen (t('transfers.cancelled')). Erkannt wird er in beiden Sprachen, weil sich die
// Sprache ändern kann und lib/ftp.js denselben Text benutzt; die Regex muss zu de/en passen.
const cancelText = () => t('transfers.cancelled');
const CANCEL_RE = /Übertragung abgebrochen|Transfer cancelled/; // i18n-ignore
const posix = path.posix;
const p = fn => new Promise((res, rej) => fn((e, r) => e ? rej(e) : res(r)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isCancel = err => CANCEL_RE.test(String(err?.message || err));
// Aufräumen auf einer toten Verbindung bekommt nie eine Antwort – nicht ewig warten
const atMost = (promise, ms = 4000) => Promise.race([Promise.resolve(promise).catch(() => {}), sleep(ms)]);

const CHUNK = 32 * 1024;    // Blockgröße pro Lese-/Schreibanfrage
const PARALLEL = 16;        // gleichzeitige Anfragen pro Datei (wie fastGet/fastPut, nur mit Versatz)
const STOP = Symbol('stop'); // Datei wurde angehalten (Pause, Abbrechen, Verbindung weg)

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

// Geschwindigkeitslimit: einfacher „Fahrplan“ – jeder Block bekommt einen Zeitpunkt,
// ab dem er laufen darf. rate in Bytes pro Sekunde, 0 = ohne Limit.
function createLimiter() {
  let rate = 0;
  let next = 0;
  return {
    get rate() { return rate; },
    set(r) { rate = Math.max(0, Number(r) || 0); next = 0; },
    async take(n) {
      if (!rate) return;
      const now = Date.now();
      if (next < now) next = now;
      const wait = next - now;
      next += n * 1000 / rate;
      if (wait > 0) await sleep(wait);
    },
  };
}

// ---------- Eine Datei übertragen (mit Versatz, Limit und Anhalten) ----------

// Zugriff auf Quelle/Ziel – lokal (fs) oder auf dem Server (sftp) – mit denselben Funktionen
function localFile() {
  return {
    size: async file => { try { return (await fsp.stat(file)).size; } catch (err) { if (err.code === 'ENOENT') return null; throw err; } },
    open: async (file, flags) => fsp.open(file, flags),
    read: async (h, buf, off, len, pos) => (await h.read(buf, off, len, pos)).bytesRead,
    write: async (h, buf, off, len, pos) => {
      while (len > 0) {
        const { bytesWritten } = await h.write(buf, off, len, pos);
        off += bytesWritten; pos += bytesWritten; len -= bytesWritten;
      }
    },
    truncate: (h, n) => h.truncate(n),
    close: h => h.close(),
    unlink: file => fsp.unlink(file),
  };
}

function remoteFile(sftp) {
  return {
    size: async file => { try { return (await p(cb => sftp.stat(file, cb))).size; } catch (err) { if (err.code === 2) return null; throw err; } },
    open: (file, flags) => p(cb => sftp.open(file, flags, cb)),
    read: (h, buf, off, len, pos) => new Promise((res, rej) => sftp.read(h, buf, off, len, pos, (e, n) => e ? rej(e) : res(n))),
    write: (h, buf, off, len, pos) => p(cb => sftp.write(h, buf, off, len, pos, cb)),
    truncate: (h, n) => p(cb => sftp.fsetstat(h, { size: n }, cb)),
    close: h => p(cb => sftp.close(h, cb)),
    unlink: file => p(cb => sftp.unlink(file, cb)),
  };
}

// file: { dir: 'put'|'get', from, to, done, started, srcSize, resume }
// shouldStop(): true -> keine neuen Blöcke mehr, angefangene fertig machen, STOP werfen
// onBytes(n): Fortschritt
// FTP (lib/ftp.js) kann nicht blockweise an beliebigen Stellen lesen/schreiben: Datei am Stück
// übertragen. Fortschritt und Abbrechen/Pausieren gehen, Fortsetzen ab der Abbruchstelle nicht.
async function copyFileFtp(sftp, file, shouldStop, onBytes) {
  onBytes(-file.done); // ein früherer Versuch fängt von vorn an
  file.done = 0;
  file.started = true;
  let last = 0;
  const opts = {
    step: total => { const d = total - last; last = total; file.done += d; onBytes(d); },
    cancelled: () => shouldStop(),
  };
  try {
    await p(cb => (file.dir === 'put' ? sftp.fastPut(file.from, file.to, opts, cb) : sftp.fastGet(file.from, file.to, opts, cb)));
  } catch (err) {
    if (shouldStop()) throw STOP;
    throw err;
  }
  if (shouldStop()) throw STOP;
}

async function copyFile(sftp, file, limiter, shouldStop, onBytes) {
  if (sftp && sftp.isFtp) return copyFileFtp(sftp, file, shouldStop, onBytes);
  const get = file.dir === 'get';
  const src = get ? remoteFile(sftp) : localFile();
  const dst = get ? localFile() : remoteFile(sftp);

  const size = await src.size(file.from);
  if (size == null) throw Object.assign(new Error(t('transfers.sourceGone')), { code: 2 });
  // Hat sich die Quelle seit dem ersten Versuch geändert, von vorn anfangen
  if (file.started && file.srcSize !== size) { file.started = false; file.done = 0; }
  file.srcSize = size;

  // Versatz: so viel, wie am Ziel schon richtig liegt
  let offset = 0;
  if (file.started || file.resume) {
    const have = await dst.size(file.to);
    if (have != null && have <= size) offset = file.started ? Math.min(have, file.done) : have;
  }
  file.resume = false;
  onBytes(offset - file.done);
  file.done = offset;

  const sh = await src.open(file.from, 'r');
  let dh;
  try {
    dh = await dst.open(file.to, offset > 0 ? 'r+' : 'w');
  } catch (err) { await atMost(src.close(sh)); throw err; }
  file.started = true;

  let contig = offset; // bis hierhin ist das Ziel lückenlos geschrieben
  let failure = null;
  let stopped = false;
  try {
    if (offset > 0) await dst.truncate(dh, offset); // evtl. alter Rest hinter dem Versatz weg
    const chunk = limiter.rate ? Math.max(4096, Math.min(CHUNK, Math.floor(limiter.rate / 8))) : CHUNK;
    const parallel = limiter.rate ? 4 : PARALLEL;
    const blocks = []; // offene Blöcke in Reihenfolge
    let next = offset;

    const one = async block => {
      await limiter.take(block.len);
      if (failure || shouldStop()) return;
      const buf = Buffer.allocUnsafe(block.len);
      let got = 0;
      while (got < block.len) {
        const n = await src.read(sh, buf, got, block.len - got, block.start + got);
        if (!n) throw new Error(t('transfers.sourceShrunk'));
        got += n;
      }
      await dst.write(dh, buf, 0, block.len, block.start);
      block.ok = true;
      onBytes(block.len);
      file.done += block.len;
    };

    await new Promise(resolve => {
      let active = 0;
      const pump = () => {
        while (active < parallel && next < size && !failure && !shouldStop()) {
          const block = { start: next, len: Math.min(chunk, size - next), ok: false };
          next += block.len;
          blocks.push(block);
          active++;
          one(block).catch(err => { failure = failure || err; }).finally(() => {
            active--;
            while (blocks.length && blocks[0].ok) blocks.shift(); // fertige Blöcke vorn weg
            pump();
          });
        }
        if (!active) resolve();
      };
      pump();
    });
    // Lückenlos geschrieben ist alles bis zum ersten offenen Block
    contig = blocks.length ? blocks[0].start : next;
    stopped = !failure && contig < size;
  } catch (err) { failure = failure || err; }

  try {
    if (failure || stopped) {
      // Teil-Datei auf den lückenlosen Teil kürzen, damit Fortsetzen sicher passt
      await atMost(dst.truncate(dh, contig));
      const lost = file.done - contig;
      if (lost) { onBytes(-lost); file.done = contig; }
    }
  } finally {
    await atMost(dst.close(dh));
    await atMost(src.close(sh));
  }
  if (failure) throw failure;
  if (stopped) throw STOP;

  const final = await dst.size(file.to);
  if (final !== size) throw new Error(t('transfers.sizeMismatch', { got: final ?? 0, size }));
}

// ---------- Warteschlange ----------

// sendTab(tabId, channel, info): Meldung an das Fenster des Tabs (app/lib/windows.js);
// ownedBy(sender, tabId): gehört der Tab dem anfragenden Fenster? (Liste, „alle anhalten“ … pro Fenster)
function create(sendTab, { getSftp, isConnected = () => true, sftpError = e => e, ownedBy = () => true } = {}) {
  const jobs = new Map();
  const order = []; // Job-IDs in Reihenfolge der Liste
  const cfg = { concurrency: 3 };
  const limits = { put: createLimiter(), get: createLimiter() };
  let active = 0;
  const seen = new WeakSet(); // SFTP-Kanäle, deren Ende wir beobachten
  const dead = new WeakSet(); // … und die schon geschlossen sind (Verbindung weg)
  // Auch eigene Texte „Keine aktive Verbindung in diesem Tab.“ (main.js, lib/ftp.js) – deutsch und englisch
  const LOST = /No response from server|ECONNRESET|EPIPE|Not connected|Keine aktive Verbindung|No active connection|channel|closed/i; // i18n-ignore

  const fileCount = job => job.list.length;
  const cleanMsg = err => String(sftpError(err)?.message || err?.message || err);

  function stateOf(job) {
    if (job.cancelled) return job.running ? 'cancelling' : 'cancelled';
    if (job.prepared && !job.running && !job.pending.length) return job.failed.length || job.prepError ? 'error' : 'done';
    if (job.paused) return job.running ? 'pausing' : 'paused';
    if (job.waiting) return 'waiting';
    if (job.running) return 'running';
    if (!job.prepared && !job.pending.length) return 'preparing';
    return 'queued';
  }
  const FINAL = new Set(['done', 'error', 'cancelled']);

  function info(job) {
    const total = job.prepared ? job.sum : Math.max(job.estimate, job.sum);
    const runningNames = job.list.filter(f => f.status === 'running').map(f => f.name);
    const firstError = job.failed[0];
    return {
      id: job.id, tabId: job.tabId, kind: job.kind, title: job.title, state: job.state,
      file: runningNames.join(', '), done: job.doneBytes, total, files: job.files, fileCount: fileCount(job),
      failed: job.failed.length, error: job.prepError || (firstError ? (job.list.length > 1 ? `${firstError.name}: ${firstError.error}` : firstError.error) : null),
      speed: job.state === 'running' ? Math.round(job.speed) : 0, pos: order.indexOf(job.id),
      preparing: !job.prepared, retries: job.retries, remoteDir: job.meta.remoteDir || null, localDir: job.meta.localDir || null,
    };
  }

  function send(job) {
    job.lastSent = Date.now();
    sendTab(job.tabId, 'transfer:update', info(job));
  }

  // Zustand neu bestimmen, bei Bedarf melden und Aufträge abschließen
  function update(job, force = false) {
    const before = job.state;
    job.state = stateOf(job);
    if (job.state !== before) force = true;
    if (FINAL.has(job.state) && !FINAL.has(before)) settle(job);
    if (force || Date.now() - job.lastSent > 100) send(job);
  }

  function settle(job) {
    job.speed = 0;
    if (!job.settle) return;
    const { resolve, reject } = job.settle;
    job.settle = null;
    if (job.state === 'done') resolve({ files: job.files });
    else if (job.state === 'cancelled') reject(new Error(cancelText()));
    else {
      let msg = job.prepError;
      if (!msg) {
        const f = job.failed[0];
        msg = job.list.length === 1 ? f.error
          : t('transfers.someFailed', { failed: job.failed.length, total: job.list.length, name: f.name, error: f.error });
      }
      reject(new Error(msg));
    }
  }

  // Geschwindigkeit (gleitender Mittelwert)
  function measure(job) {
    const now = Date.now();
    const dt = now - job.sampleAt;
    if (dt < 500) return;
    const inst = (job.doneBytes - job.sampleBytes) * 1000 / dt;
    job.speed = job.speed ? job.speed * 0.6 + inst * 0.4 : inst;
    job.sampleAt = now;
    job.sampleBytes = job.doneBytes;
  }

  function runnable(job) {
    return !job.paused && !job.cancelled && !job.waiting && job.pending.length > 0;
  }

  function pump() {
    while (active < cfg.concurrency) {
      const job = order.map(id => jobs.get(id)).find(j => j && runnable(j));
      if (!job) break;
      run(job, job.pending.shift());
    }
  }

  async function run(job, file) {
    active++;
    job.running++;
    file.status = 'running';
    if (job.running === 1) { job.sampleAt = Date.now(); job.sampleBytes = job.doneBytes; }
    update(job, true);
    let sftp = null;
    const stop = () => job.cancelled || job.paused || job.waiting || (sftp && dead.has(sftp));
    try {
      sftp = await getSftp(job.tabId);
      if (!seen.has(sftp)) { seen.add(sftp); if (typeof sftp.once === 'function') sftp.once('close', () => dead.add(sftp)); } // FTP-Adapter hat keine Ereignisse
      await copyFile(sftp, file, limits[file.dir], stop, n => {
        job.doneBytes += n;
        measure(job);
        update(job);
      });
      file.status = 'done';
      file.lost = 0;
      job.files++;
      // Rückruf nach erfolgreicher Übertragung (z. B. Änderungszeit setzen, lib/sync.js)
      if (file.onDone) { try { await file.onDone(sftp); } catch { /* nur Zusatz */ } }
    } catch (err) {
      const lost = (sftp && dead.has(sftp)) || !isConnected(job.tabId) || LOST.test(String(err?.message || ''));
      if (job.cancelled) file.status = 'cancelled';
      else if (err === STOP && (job.paused || job.waiting) && !lost) { file.status = 'pending'; job.pending.unshift(file); }
      else if (job.waiting || (lost && (file.lost = (file.lost || 0) + 1) <= 5)) {
        // Verbindung weg: Datei zurück in die Schlange. Ist schon neu verbunden, geht es gleich
        // weiter, sonst wartet der Auftrag aufs Neuverbinden (resumeTab).
        if (!isConnected(job.tabId)) job.waiting = true;
        file.status = 'pending';
        job.pending.unshift(file);
      } else {
        file.status = 'error';
        file.error = err === STOP ? t('transfers.disconnected') : cleanMsg(err);
        job.failed.push(file);
      }
    } finally {
      active--;
      job.running--;
      if (file.status === 'cancelled') await removePartial(job, file);
      update(job, true);
      pump();
    }
  }

  async function removePartial(job, file) {
    if (!file.started) return;
    try {
      if (file.dir === 'get') await fsp.unlink(file.to);
      else if (isConnected(job.tabId)) { const sftp = await getSftp(job.tabId); await atMost(p(cb => sftp.unlink(file.to, cb))); }
    } catch {}
    file.started = false;
  }

  function start(tabId, kind, title, meta = {}) {
    const job = {
      id: crypto.randomUUID(), tabId, kind, title, meta, state: null,
      list: [], pending: [], failed: [], running: 0, files: 0,
      sum: 0, estimate: 0, doneBytes: 0, speed: 0, sampleAt: 0, sampleBytes: 0,
      prepared: false, prepError: null, paused: false, waiting: false, cancelled: false, retries: 0, lastSent: 0,
    };
    job.result = new Promise((resolve, reject) => { job.settle = { resolve, reject }; });
    job.result.catch(() => {}); // Fehler werden über finish() bzw. die Liste gemeldet
    jobs.set(job.id, job);
    order.push(job.id);

    job.setTotal = n => { job.estimate = Math.max(0, n); update(job, true); };
    job.check = () => { if (job.cancelled) throw new Error(cancelText()); };

    // Datei anmelden. dir: 'put' (hochladen) oder 'get' (herunterladen).
    // opts.size: Größe, falls schon bekannt; opts.resume: vorhandene Teil-Datei am Ziel fortsetzen
    // opts.onDone(sftp): wird aufgerufen, sobald diese Datei fertig übertragen ist
    // Achtung: copy() meldet die Datei nur an – fertig ist alles erst, wenn job.finish() erfüllt ist.
    job.copy = async (dir, sftp, from, to, name, opts = {}) => {
      job.check();
      let size = opts.size;
      if (size == null) {
        try { size = dir === 'put' ? (await fsp.stat(from)).size : (await p(cb => sftp.stat(from, cb))).size; } catch { size = 0; }
      }
      const file = { dir, from, to, name, size, done: 0, status: 'pending', started: false, srcSize: size, resume: !!opts.resume, error: null, onDone: opts.onDone || null };
      job.list.push(file);
      job.pending.push(file);
      job.sum += size;
      update(job, true);
      pump();
    };

    // Vorbereiten ist fertig. Mit Fehler: Auftrag endet mit diesem Fehler (bereits angemeldete
    // Dateien laufen zu Ende). Liefert ein Promise, das beim Abschluss erfüllt bzw. abgelehnt wird.
    job.finish = err => {
      if (job.prepared) return job.result;
      job.prepared = true;
      if (err && !job.cancelled && !isCancel(err)) job.prepError = cleanMsg(err);
      else if (err) job.cancelled = true;
      update(job, true);
      pump();
      return job.result;
    };
    update(job, true);
    return job;
  }

  // ---------- Steuerung aus der Oberfläche ----------

  function cancel(id) {
    const job = jobs.get(id);
    if (!job || FINAL.has(job.state)) return;
    job.cancelled = true;
    const rest = job.pending.splice(0);
    for (const f of rest) f.status = 'cancelled';
    update(job, true);
    Promise.all(rest.map(f => removePartial(job, f))).catch(() => {});
  }

  function pause(id) {
    const job = jobs.get(id);
    if (!job || FINAL.has(job.state) || job.cancelled) return;
    job.paused = true;
    update(job, true);
  }

  function resume(id) {
    const job = jobs.get(id);
    if (!job || job.cancelled) return;
    job.paused = false;
    if (job.waiting && isConnected(job.tabId)) job.waiting = false;
    update(job, true);
    pump();
  }

  function retry(id) {
    const job = jobs.get(id);
    if (!job || job.state !== 'error' || !job.failed.length) return;
    const again = job.failed.splice(0);
    for (const f of again) { f.status = 'pending'; f.error = null; }
    job.pending.push(...again);
    job.retries++;
    job.paused = false;
    update(job, true);
    pump();
  }

  // delta: -1 hoch, +1 runter, 'top', 'bottom'
  function move(id, delta) {
    const i = order.indexOf(id);
    if (i < 0) return;
    order.splice(i, 1);
    const j = delta === 'top' ? 0 : delta === 'bottom' ? order.length : Math.max(0, Math.min(order.length, i + Number(delta)));
    order.splice(j, 0, id);
    for (const job of jobs.values()) send(job);
  }

  function remove(id) {
    const job = jobs.get(id);
    if (!job) return;
    if (!FINAL.has(job.state)) { cancel(id); return; }
    jobs.delete(id);
    order.splice(order.indexOf(id), 1);
  }

  // only(job): nur Aufträge eines Fensters (mehrere Fenster, app/lib/windows.js)
  const all = () => true;
  function clearFinished(only = all) {
    for (const job of [...jobs.values()]) if ((job.state === 'done' || job.state === 'cancelled') && only(job)) remove(job.id);
  }

  const unfinished = (only = all) => [...jobs.values()].filter(j => !FINAL.has(j.state) && only(j));
  const pauseAll = only => unfinished(only).forEach(j => pause(j.id));
  const resumeAll = only => unfinished(only).forEach(j => resume(j.id));

  function configure(opts = {}) {
    if (opts.concurrency != null) cfg.concurrency = Math.max(1, Math.min(10, Math.round(Number(opts.concurrency) || 3)));
    if (opts.upKBs != null) limits.put.set(Math.max(0, Number(opts.upKBs) || 0) * 1024);
    if (opts.downKBs != null) limits.get.set(Math.max(0, Number(opts.downKBs) || 0) * 1024);
    pump();
    return { concurrency: cfg.concurrency, upKBs: limits.put.rate / 1024, downKBs: limits.get.rate / 1024 };
  }

  // Beim Schließen eines Tabs alle seine Übertragungen stoppen
  function cancelTab(tabId) {
    for (const job of jobs.values()) if (job.tabId === tabId) cancel(job.id);
  }

  // Neu verbinden: Übertragungen anhalten, bis die Verbindung wieder steht
  function suspendTab(tabId) {
    for (const job of jobs.values()) if (job.tabId === tabId && !FINAL.has(job.state)) { job.waiting = true; update(job, true); }
  }

  function resumeTab(tabId) {
    for (const job of jobs.values()) if (job.tabId === tabId && job.waiting) { job.waiting = false; update(job, true); }
    pump();
  }

  function register(ipcMain) {
    ipcMain.on('transfer:cancel', (_e, id) => cancel(id));
    ipcMain.on('transfer:pause', (_e, id) => pause(id));
    ipcMain.on('transfer:resume', (_e, id) => resume(id));
    ipcMain.on('transfer:retry', (_e, id) => retry(id));
    ipcMain.on('transfer:move', (_e, id, delta) => move(id, delta));
    ipcMain.on('transfer:remove', (_e, id) => remove(id));
    const mine = e => job => ownedBy(e && e.sender, job.tabId);
    ipcMain.on('transfer:clear', e => clearFinished(mine(e)));
    ipcMain.on('transfer:pause-all', e => pauseAll(mine(e)));
    ipcMain.on('transfer:resume-all', e => resumeAll(mine(e)));
    ipcMain.handle('transfer:config', (_e, opts) => configure(opts));
    ipcMain.handle('transfer:list', e => order.map(id => jobs.get(id)).filter(mine(e)).map(info));
  }

  return {
    start, cancel, pause, resume, retry, move, remove, clearFinished, pauseAll, resumeAll, configure,
    cancelTab, suspendTab, resumeTab, register, localSize, remoteSize, isCancel,
    get CANCEL_TEXT() { return cancelText(); },
  };
}

module.exports = { create, copyFile, createLimiter, isCancel, STOP, get CANCEL_TEXT() { return cancelText(); } };
