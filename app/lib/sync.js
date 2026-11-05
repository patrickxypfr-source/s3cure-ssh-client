// „Ordner synchronisieren“ und „Server-Ordner aktuell halten“ (wie WinSCP)
// Oberfläche: src/sync.js. Vergleichslogik ohne Dateizugriff: lib/sync-core.js.
//
// sync:compare  lokalen und Server-Ordner rekursiv einlesen und vergleichen (optional Prüfsumme)
// sync:run      ausgewählte Einträge übertragen/löschen – über die Übertragungsliste (lib/transfers.js)
// watch:*       lokalen Ordner beobachten und Änderungen automatisch hochladen
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const core = require('./sync-core');
const { checkPath, friendly } = require('./localfs');
const i18n = require('./i18n');
const { t } = i18n;

const posix = path.posix;
const p = fn => new Promise((res, rej) => fn((e, r) => e ? rej(e) : res(r)));
const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

const MAX_ENTRIES = 100000;         // mehr Einträge pro Seite -> Abbruch mit Hinweis
const WATCH_DEBOUNCE = 800;         // ms Ruhe nach der letzten Änderung, dann hochladen
const WATCH_POLL = 2500;            // ms zwischen zwei Durchläufen, wenn fs.watch nicht geht
const WATCH_RETRY = 5000;           // ms bis zum nächsten Versuch nach einem Fehler
const MAX_WATCHES = 10;

// Texte erst beim Gebrauch übersetzen (die Sprache kann sich ändern)
const T = {
  tooMany: n => t('sync.tooMany', { max: i18n.fmtNumber(n) }),
  cancelled: () => t('sync.cancelled'),
  badRemote: () => t('sync.badRemote'),
  badLocal: () => t('sync.badLocal'),
  badRel: () => t('sync.badRel'),
  syncTitle: name => t('sync.jobSync', { name }),
  watchFiles: n => t('sync.jobWatchFiles', { count: n }),
  watchLimit: () => t('sync.watchLimit', { max: MAX_WATCHES }),
  watchSame: () => t('sync.watchSame'),
  offline: () => t('sync.offline'),
  errors: (n, rel, error) => t('sync.errorsFirst', { count: n, rel, error }),
};

// ---------- Ordner einlesen ----------

// Lokal: Map rel -> { isDir, size, mtime }. Symbolische Links auf Ordner werden nicht verfolgt (keine Schleifen).
async function walkLocal(root, matcher, state) {
  const out = new Map();
  const queue = [''];
  while (queue.length) {
    if (state && state.cancelled) throw new Error(T.cancelled());
    const rel = queue.shift();
    const abs = rel ? path.join(root, ...rel.split('/')) : root;
    let dirents;
    try { dirents = await fsp.readdir(abs, { withFileTypes: true }); } catch (err) { if (!rel) throw friendly(err, abs); continue; }
    for (const d of dirents) {
      if (d.name.includes('/')) continue;
      const childRel = rel ? rel + '/' + d.name : d.name;
      let st;
      try { st = d.isSymbolicLink() ? await fsp.stat(path.join(abs, d.name)) : await fsp.lstat(path.join(abs, d.name)); } catch { continue; }
      const isDir = st.isDirectory();
      if (d.isSymbolicLink() && isDir) continue;
      if (!isDir && !st.isFile()) continue;
      if (matcher(childRel, isDir)) continue;
      out.set(childRel, { isDir, size: isDir ? 0 : st.size, mtime: Math.floor(st.mtimeMs) });
      if (out.size > MAX_ENTRIES) throw new Error(T.tooMany(MAX_ENTRIES));
      if (isDir) queue.push(childRel);
    }
    if (state && state.progress) state.progress(out.size);
  }
  return out;
}

// Server: dasselbe per SFTP, mehrere Ordner gleichzeitig
async function walkRemote(sftp, root, matcher, state) {
  const out = new Map();
  const queue = [''];
  let active = 0;
  let failure = null;
  const worker = async () => {
    while (!failure) {
      if (state && state.cancelled) { failure = new Error(T.cancelled()); return; }
      const rel = queue.shift();
      if (rel === undefined) {
        if (active === 0) return;
        await new Promise(r => setTimeout(r, 10));
        continue;
      }
      active++;
      try {
        const abs = rel ? posix.join(root, rel) : root;
        let list;
        try { list = await p(cb => sftp.readdir(abs, cb)); } catch (err) { if (!rel) throw err; continue; }
        for (const it of list) {
          const name = it.filename;
          if (!name || name === '.' || name === '..' || name.includes('/')) continue;
          const childRel = rel ? rel + '/' + name : name;
          let a = it.attrs;
          if (a.isSymbolicLink()) {
            try { a = await p(cb => sftp.stat(posix.join(abs, name), cb)); } catch { continue; }
            if (a.isDirectory()) continue; // Links auf Ordner nicht verfolgen
          }
          const isDir = a.isDirectory();
          if (!isDir && !a.isFile()) continue;
          if (matcher(childRel, isDir)) continue;
          out.set(childRel, { isDir, size: isDir ? 0 : a.size, mtime: a.mtime * 1000 });
          if (out.size > MAX_ENTRIES) throw new Error(T.tooMany(MAX_ENTRIES));
          if (isDir) queue.push(childRel);
        }
        if (state && state.progress) state.progress(out.size);
      } catch (err) { failure = failure || err; }
      finally { active--; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (failure) throw failure;
  return out;
}

// ---------- Prüfsummen ----------

function hashLocal(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

function hashRemoteSftp(sftp, file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    sftp.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

// sha256sum auf dem Server (schnell). Liefert Map rel -> hash oder null, wenn der Befehl fehlt.
function hashRemoteExec(client, root, rels) {
  return new Promise(resolve => {
    const cmd = `cd ${shQuote(root)} && (sha256sum -- ${rels.map(shQuote).join(' ')} || true) 2>/dev/null`;
    client.exec(cmd, (err, stream) => {
      if (err) return resolve(null);
      let out = '';
      let code = null;
      stream.on('data', d => { out += d.toString('utf8'); });
      stream.stderr.on('data', () => {});
      stream.on('exit', c => { code = c; });
      stream.on('close', () => {
        const map = new Map();
        for (const line of out.split('\n')) {
          const m = /^(\\?)([0-9a-f]{64}) [ *](.*)$/.exec(line);
          if (!m) continue;
          let name = m[3];
          if (m[1]) name = name.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c)); // GNU-Escape
          map.set(name, m[2]);
        }
        resolve(map.size || code === 0 ? map : null);
      });
    });
  });
}

// ---------- Hilfen fürs Übertragen ----------

async function remoteMkdirp(sftp, dir, made) {
  if (dir === '/' || made.has(dir)) return;
  const st = await p(cb => sftp.stat(dir, cb)).catch(() => null);
  if (st) { if (!st.isDirectory()) throw new Error(t('sync.remoteIsFile', { path: dir })); made.add(dir); return; }
  await remoteMkdirp(sftp, posix.dirname(dir), made);
  await p(cb => sftp.mkdir(dir, cb)).catch(async err => {
    const again = await p(cb => sftp.stat(dir, cb)).catch(() => null); // gleichzeitig angelegt?
    if (!again) throw err;
  });
  made.add(dir);
}

async function removeRemote(sftp, remote) {
  const st = await p(cb => sftp.lstat(remote, cb));
  if (st.isDirectory()) {
    for (const it of await p(cb => sftp.readdir(remote, cb))) await removeRemote(sftp, posix.join(remote, it.filename));
    await p(cb => sftp.rmdir(remote, cb));
  } else await p(cb => sftp.unlink(remote, cb));
}

const toLocal = (root, rel) => path.join(root, ...rel.split('/'));
const toRemote = (root, rel) => posix.join(root, rel);
const checkRemoteRoot = r => {
  if (typeof r !== 'string' || !r.startsWith('/') || r.includes('\0')) throw new Error(T.badRemote());
  return posix.normalize(r);
};

// Eine Datei hochladen und die Änderungszeit mitnehmen (sonst gilt sie beim nächsten Vergleich als „neuer“)
async function putFile(job, sftp, local, remote, made) {
  const st = await fsp.stat(local);
  await remoteMkdirp(sftp, posix.dirname(remote), made);
  const t = Math.floor(st.mtimeMs / 1000);
  // Die Warteschlange überträgt später; Änderungszeit erst setzen, wenn die Datei drüben ist
  await job.copy('put', sftp, local, remote, posix.basename(remote), {
    size: st.size, onDone: s => p(cb => s.utimes(remote, t, t, cb)).catch(() => {}),
  });
  return st;
}

async function getFile(job, sftp, remote, local) {
  const st = await p(cb => sftp.stat(remote, cb));
  await fsp.mkdir(path.dirname(local), { recursive: true });
  await job.copy('get', sftp, remote, local, posix.basename(remote), {
    size: st.size, onDone: () => fsp.utimes(local, st.atime || st.mtime, st.mtime).catch(() => {}),
  });
}

// ---------- Registrieren ----------

function register({ ipcMain, shell, getSftp, getClient, sftpError, transfers, getWin }) {
  const send = (channel, ...args) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(channel, ...args); };
  const compares = new Map(); // compareId -> Zustand (zum Abbrechen)
  const clean = err => (typeof err?.code === 'string' ? friendly(err) : sftpError(err));

  ipcMain.on('sync:cancel', (_e, compareId) => { const st = compares.get(compareId); if (st) st.cancelled = true; });

  // opts: { localRoot, remoteRoot, excludes: [..], checksum: bool, compareId }
  ipcMain.handle('sync:compare', async (_e, tabId, opts = {}) => {
    const localRoot = checkPath(opts.localRoot);
    const remoteRoot = checkRemoteRoot(opts.remoteRoot);
    const lst = await fsp.stat(localRoot).catch(() => null);
    if (!lst || !lst.isDirectory()) throw new Error(T.badLocal());
    const sftp = await getSftp(tabId);
    const matcher = core.makeMatcher(core.parsePatterns(opts.excludes || core.DEFAULT_EXCLUDES));
    const id = String(opts.compareId || crypto.randomUUID());
    const counts = { local: 0, remote: 0 };
    let last = 0;
    const report = (phase, extra = {}) => {
      const now = Date.now();
      if (now - last < 150 && !extra.force) return;
      last = now;
      send('sync:progress', { compareId: id, phase, ...counts, ...extra });
    };
    const state = { cancelled: false };
    compares.set(id, state);
    try {
      const [local, remote] = await Promise.all([
        walkLocal(localRoot, matcher, watchState(state, n => { counts.local = n; report('scan'); })),
        walkRemote(sftp, remoteRoot, matcher, watchState(state, n => { counts.remote = n; report('scan'); })),
      ]);
      let hashes = null;
      let hashInfo = null;
      if (opts.checksum) {
        hashes = new Map();
        const rels = core.hashCandidates(local, remote);
        hashInfo = { files: rels.length, method: 'exec' };
        // Server: sha256sum in Päckchen; geht das nicht, per SFTP lesen (langsamer)
        let client = null;
        try { client = getClient(tabId); } catch {}
        for (let i = 0; i < rels.length; i += 200) {
          if (state.cancelled) throw new Error(T.cancelled());
          const chunk = rels.slice(i, i + 200);
          const map = client && hashInfo.method === 'exec' ? await hashRemoteExec(client, remoteRoot, chunk) : null;
          if (!map) hashInfo.method = 'sftp';
          for (const rel of chunk) {
            if (state.cancelled) throw new Error(T.cancelled());
            let r = map ? map.get(rel) : null;
            if (!r && !map) r = await hashRemoteSftp(sftp, toRemote(remoteRoot, rel)).catch(() => null);
            const l = await hashLocal(toLocal(localRoot, rel)).catch(() => null);
            hashes.set(rel, { local: l, remote: r || null });
          }
          report('hash', { hashed: Math.min(rels.length, i + 200), toHash: rels.length, force: true });
        }
      }
      const { items, same } = core.compareTrees(local, remote, hashes);
      // Vorschläge für jede Richtung gleich mitliefern, damit die Oberfläche nur noch umschalten muss
      for (const it of items) {
        it.suggest = {
          up: core.suggest(it, 'up', false), upDel: core.suggest(it, 'up', true),
          down: core.suggest(it, 'down', false), downDel: core.suggest(it, 'down', true),
          both: core.suggest(it, 'both', false),
        };
        it.actions = core.possibleActions(it);
      }
      return {
        localRoot, remoteRoot, items, same, hashInfo,
        localCount: local.size, remoteCount: remote.size,
      };
    } catch (err) {
      throw clean(err);
    } finally {
      compares.delete(id);
    }
  });

  // ops: [{ rel, action: 'upload'|'download'|'deleteRemote'|'deleteLocal', size }]
  ipcMain.handle('sync:run', async (_e, tabId, opts = {}) => {
    const localRoot = checkPath(opts.localRoot);
    const remoteRoot = checkRemoteRoot(opts.remoteRoot);
    const ops = Array.isArray(opts.ops) ? opts.ops : [];
    const ACTIONS = ['upload', 'download', 'deleteRemote', 'deleteLocal'];
    for (const op of ops) if (!core.safeRel(op.rel) || !ACTIONS.includes(op.action)) throw new Error(T.badRel());
    if (!ops.length) return { uploaded: 0, downloaded: 0, deleted: 0, errors: [] };
    const matcher = core.makeMatcher(core.parsePatterns(opts.excludes || core.DEFAULT_EXCLUDES));
    const sftp = await getSftp(tabId);
    const job = transfers.start(tabId, 'sync', T.syncTitle(path.basename(localRoot) || localRoot));
    const res = { uploaded: 0, downloaded: 0, deleted: 0, errors: [] };
    const made = new Set();

    // Ordner rekursiv mit denselben Ausschlüssen wie beim Vergleich
    const uploadTree = async rel => {
      const abs = toLocal(localRoot, rel);
      const st = await fsp.stat(abs);
      if (!st.isDirectory()) { await putFile(job, sftp, abs, toRemote(remoteRoot, rel), made); res.uploaded++; return; }
      await remoteMkdirp(sftp, toRemote(remoteRoot, rel), made);
      const tree = await walkLocal(abs, (r, d) => matcher(rel + '/' + r, d));
      for (const [r, e] of tree) {
        job.check();
        const full = rel + '/' + r;
        if (e.isDir) await remoteMkdirp(sftp, toRemote(remoteRoot, full), made);
        else { await putFile(job, sftp, toLocal(localRoot, full), toRemote(remoteRoot, full), made); res.uploaded++; }
      }
    };
    const downloadTree = async rel => {
      const remote = toRemote(remoteRoot, rel);
      const st = await p(cb => sftp.stat(remote, cb));
      if (!st.isDirectory()) { await getFile(job, sftp, remote, toLocal(localRoot, rel)); res.downloaded++; return; }
      await fsp.mkdir(toLocal(localRoot, rel), { recursive: true });
      const tree = await walkRemote(sftp, remote, (r, d) => matcher(rel + '/' + r, d));
      for (const [r, e] of tree) {
        job.check();
        const full = rel + '/' + r;
        if (e.isDir) await fsp.mkdir(toLocal(localRoot, full), { recursive: true });
        else { await getFile(job, sftp, toRemote(remoteRoot, full), toLocal(localRoot, full)); res.downloaded++; }
      }
    };

    try {
      // Größen stammen aus dem Vergleich (nur für die Fortschrittsanzeige)
      job.setTotal(ops.filter(o => o.action === 'upload' || o.action === 'download').reduce((n, o) => n + (Number(o.size) > 0 ? Number(o.size) : 0), 0));
      // Erst übertragen, zum Schluss löschen
      const order = [...ops].sort((a, b) => (a.action.startsWith('delete') - b.action.startsWith('delete')) || a.rel.localeCompare(b.rel));
      for (const op of order) {
        job.check();
        try {
          if (op.action === 'upload') await uploadTree(op.rel);
          else if (op.action === 'download') await downloadTree(op.rel);
          else if (op.action === 'deleteRemote') { await removeRemote(sftp, toRemote(remoteRoot, op.rel)); res.deleted++; }
          else if (op.action === 'deleteLocal') { await shell.trashItem(toLocal(localRoot, op.rel)); res.deleted++; }
        } catch (err) {
          if (job.cancelled) throw err;
          res.errors.push({ rel: op.rel, error: clean(err).message });
        }
      }
    } catch (err) {
      job.finish(err);
      throw clean(err);
    }
    // Auf das Ende aller Übertragungen warten; Fehler einzelner Dateien zählen mit
    try {
      await job.finish(res.errors.length ? new Error(T.errors(res.errors.length, res.errors[0].rel, res.errors[0].error)) : null);
    } catch (err) {
      if (job.cancelled) throw clean(err);
      if (!res.errors.length) res.errors.push({ rel: '', error: clean(err).message });
    }
    return res;
  });

  // ---------- Server-Ordner aktuell halten ----------

  const watches = new Map(); // id -> Beobachtung

  const publicWatch = w => ({
    id: w.id, tabId: w.tabId, localRoot: w.localRoot, remoteRoot: w.remoteRoot, label: w.label,
    mode: w.mode, started: w.started, lastTransfer: w.lastTransfer, lastFile: w.lastFile, uploads: w.uploads,
    pending: w.pending.size, busy: w.busy, error: w.error,
  });
  const publish = () => send('watch:status', [...watches.values()].map(publicWatch));

  function scheduleFlush(w, delay = WATCH_DEBOUNCE) {
    clearTimeout(w.timer);
    w.timer = setTimeout(() => flush(w), delay);
  }

  // Änderungen gegen den letzten bekannten Stand prüfen und hochladen
  async function flush(w) {
    if (w.stopped) return;
    if (w.busy) { scheduleFlush(w); return; }
    if (!w.pending.size) return;
    w.busy = true;
    const rels = [...w.pending].sort();
    w.pending.clear();
    const todo = []; // { rel, isDir, st }
    for (const rel of rels) {
      if (rel === '') { // ganzer Ordner: neu einlesen und vergleichen
        let tree;
        try { tree = await walkLocal(w.localRoot, w.matcher); } catch { continue; }
        for (const [r, e] of tree) {
          const old = w.snapshot.get(r);
          if (!old || (!e.isDir && (old.size !== e.size || old.mtime !== e.mtime))) todo.push({ rel: r, isDir: e.isDir, st: e });
        }
        for (const r of [...w.snapshot.keys()]) if (!tree.has(r)) w.snapshot.delete(r);
        continue;
      }
      if (!core.safeRel(rel)) continue;
      let st;
      try { st = await fsp.lstat(toLocal(w.localRoot, rel)); } catch { w.snapshot.delete(rel); continue; } // gelöscht: drüben bleibt es
      if (st.isSymbolicLink()) continue;
      const isDir = st.isDirectory();
      if (!isDir && !st.isFile()) continue;
      if (excludedRel(w.matcher, rel, isDir)) continue;
      const e = { isDir, size: isDir ? 0 : st.size, mtime: Math.floor(st.mtimeMs) };
      const old = w.snapshot.get(rel);
      if (isDir) {
        if (!old) {
          todo.push({ rel, isDir: true, st: e });
          // Inhalt eines neuen Ordners (z. B. hineinkopiert)
          try {
            const sub = await walkLocal(toLocal(w.localRoot, rel), (r, d) => w.matcher(rel + '/' + r, d));
            for (const [r, se] of sub) todo.push({ rel: rel + '/' + r, isDir: se.isDir, st: se });
          } catch {}
        }
        continue;
      }
      if (!old || old.size !== e.size || old.mtime !== e.mtime) todo.push({ rel, isDir: false, st: e });
    }
    // doppelte entfernen
    const seen = new Set();
    const list = todo.filter(t => !seen.has(t.rel) && seen.add(t.rel));
    if (!list.length) { w.busy = false; w.error = null; publish(); return; }

    let sftp;
    try { sftp = await getSftp(w.tabId); } catch {
      list.forEach(t => w.pending.add(t.rel));
      w.error = T.offline(); w.busy = false; publish();
      scheduleFlush(w, WATCH_RETRY);
      return;
    }
    const files = list.filter(t => !t.isDir);
    const job = transfers.start(w.tabId, 'upload', files.length === 1 ? posix.basename(files[0].rel) : T.watchFiles(files.length));
    publish();
    let failed = null;
    try {
      job.setTotal(files.reduce((n, t) => n + t.st.size, 0));
      for (const t of list) {
        if (w.stopped) break;
        job.check();
        try {
          if (t.isDir) await remoteMkdirp(sftp, toRemote(w.remoteRoot, t.rel), w.made);
          else {
            const st = await putFile(job, sftp, toLocal(w.localRoot, t.rel), toRemote(w.remoteRoot, t.rel), w.made);
            t.st = { isDir: false, size: st.size, mtime: Math.floor(st.mtimeMs) };
            w.uploads++;
            w.lastFile = t.rel;
            w.lastTransfer = Date.now();
          }
          w.snapshot.set(t.rel, t.st);
        } catch (err) {
          if (job.cancelled) throw err;
          if (err && err.code === 'ENOENT') continue; // inzwischen gelöscht
          failed = failed || err;
          w.pending.add(t.rel);
        }
      }
    } catch (err) { failed = err; }
    // Auf das Ende der Übertragungen warten; schlägt etwas fehl, später alles nochmal versuchen
    try { await job.finish(failed && !job.cancelled ? clean(failed) : null); } catch (err) {
      if (!job.cancelled) { failed = failed || err; list.forEach(t => { if (!t.isDir) w.pending.add(t.rel); }); }
    }
    w.error = failed && !job.cancelled ? clean(failed).message : null;
    if (failed) w.made.clear(); // vielleicht wurde drüben ein Ordner gelöscht
    w.busy = false;
    publish();
    if (w.pending.size && !w.stopped) scheduleFlush(w, failed ? WATCH_RETRY : WATCH_DEBOUNCE);
  }

  function startWatcher(w) {
    try {
      w.watcher = fs.watch(w.localRoot, { recursive: true, persistent: false }, (_ev, filename) => {
        if (w.stopped) return;
        const rel = filename ? String(filename).split(path.sep).join('/') : '';
        w.pending.add(rel);
        scheduleFlush(w);
      });
      w.watcher.on('error', () => { try { w.watcher.close(); } catch {} w.watcher = null; startPolling(w); });
      w.mode = 'watch';
    } catch {
      startPolling(w);
    }
  }

  // Ersatz, wenn das System keine Änderungsmeldungen liefert: regelmäßig vergleichen
  function startPolling(w) {
    if (w.stopped) return;
    w.mode = 'poll';
    clearInterval(w.poll);
    w.poll = setInterval(() => { if (!w.busy) { w.pending.add(''); flush(w); } }, WATCH_POLL);
    publish();
  }

  function stopWatch(id) {
    const w = watches.get(id);
    if (!w) return false;
    w.stopped = true;
    clearTimeout(w.timer);
    clearInterval(w.poll);
    try { w.watcher && w.watcher.close(); } catch {}
    watches.delete(id);
    publish();
    return true;
  }

  // opts: { localRoot, remoteRoot, excludes, label, poll (nur Test) }
  ipcMain.handle('watch:start', async (_e, tabId, opts = {}) => {
    const localRoot = checkPath(opts.localRoot);
    const remoteRoot = checkRemoteRoot(opts.remoteRoot);
    const st = await fsp.stat(localRoot).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error(T.badLocal());
    if (watches.size >= MAX_WATCHES) throw new Error(T.watchLimit());
    for (const w of watches.values()) if (w.tabId === tabId && w.localRoot === localRoot && w.remoteRoot === remoteRoot) throw new Error(T.watchSame());
    await getSftp(tabId); // Verbindung muss stehen
    const matcher = core.makeMatcher(core.parsePatterns(opts.excludes || core.DEFAULT_EXCLUDES));
    const w = {
      id: crypto.randomUUID(), tabId, localRoot, remoteRoot, label: String(opts.label || '').slice(0, 200),
      matcher, snapshot: await walkLocal(localRoot, matcher).catch(err => { throw clean(err); }),
      pending: new Set(), made: new Set(), timer: null, poll: null, watcher: null, mode: null,
      busy: false, stopped: false, started: Date.now(), lastTransfer: null, lastFile: null, uploads: 0, error: null,
    };
    watches.set(w.id, w);
    if (opts.poll || process.env.S3CURE_WATCH_POLL) startPolling(w); else startWatcher(w);
    publish();
    return publicWatch(w);
  });

  ipcMain.handle('watch:stop', (_e, id) => stopWatch(id));
  ipcMain.handle('watch:list', () => [...watches.values()].map(publicWatch));

  // Tab geschlossen -> Beobachtungen dieses Tabs beenden (Neu verbinden behält sie)
  ipcMain.on('ssh:close', (_e, tabId) => { for (const w of [...watches.values()]) if (w.tabId === tabId) stopWatch(w.id); });

  return { stopAll: () => { for (const id of [...watches.keys()]) stopWatch(id); } };
}

// Abbrechen-Zustand teilen und Fortschritt melden
function watchState(state, progress) {
  return { get cancelled() { return state.cancelled; }, progress };
}

// Liegt rel (oder ein übergeordneter Ordner) in den Ausschlüssen?
function excludedRel(matcher, rel, isDir) {
  for (let i = rel.indexOf('/'); i >= 0; i = rel.indexOf('/', i + 1)) if (matcher(rel.slice(0, i), true)) return true;
  return matcher(rel, isDir);
}

module.exports = { register, walkLocal, walkRemote };
