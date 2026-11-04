// Übertragungen zwischen „Mein Computer“ und dem Server (geteilte Dateiansicht, src/local-pane.js)
// Hochladen in einen bestimmten Server-Ordner, Herunterladen in einen bestimmten lokalen Ordner,
// Ordner rekursiv. Gibt es eine Datei am Ziel schon, wird die Oberfläche gefragt:
// Überschreiben / Überspringen (optional „für alle“) / Abbrechen.
// Fortschritt und Abbrechen laufen über die bestehende Übertragungsliste (lib/transfers.js).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { checkPath, friendly, SYSTEM_FILES } = require('./localfs');
// Fehler vom lokalen Dateisystem haben Text-Codes (ENOENT …), SFTP-Fehler Zahlen
const cleanError = (err, sftpError) => (typeof err?.code === 'string' ? friendly(err) : sftpError(err));

const posix = path.posix;
const p = fn => new Promise((res, rej) => fn((e, r) => e ? rej(e) : res(r)));

function register({ ipcMain, getSftp, sftpError, transfers, getWin, platform }) {
  const IS_WIN = platform === 'win32' || process.platform === 'win32';
  const pending = new Map(); // reqId -> resolve

  ipcMain.on('xfer:conflict-answer', (_e, reqId, answer) => {
    const resolve = pending.get(reqId);
    pending.delete(reqId);
    if (resolve) resolve(answer || { action: 'cancel' });
  });

  function askConflict(info) {
    const win = getWin();
    if (!win || win.isDestroyed()) return Promise.resolve({ action: 'cancel' });
    return new Promise(resolve => {
      const reqId = crypto.randomUUID();
      pending.set(reqId, resolve);
      win.webContents.send('xfer:conflict', { reqId, ...info });
    });
  }

  // Liefert 'overwrite' oder 'skip'; bei Abbrechen wird der ganze Auftrag gestoppt
  async function resolveConflict(job, state, info) {
    if (state.all) return state.all;
    const a = await askConflict({ jobId: job.id, kind: job.kind, multi: state.multi, ...info });
    job.check();
    if (a.action !== 'overwrite' && a.action !== 'skip') {
      transfers.cancel(job.id);
      job.check();
    }
    if (a.all) state.all = a.action;
    return a.action;
  }

  const remoteStat = (sftp, remote) => p(cb => sftp.stat(remote, cb)).catch(() => null);
  const localStat = file => fsp.stat(file).catch(() => null);

  // Namen vom Server, die lokal nicht als Dateiname taugen, werden übersprungen
  const safeRemoteName = name => name && name !== '.' && name !== '..' && !name.includes('/') && !(IS_WIN && name.includes('\\'));

  async function uploadOne(job, sftp, local, remoteDir, state, fresh) {
    job.check();
    const name = path.basename(local);
    const remote = posix.join(remoteDir, name);
    const st = await fsp.stat(local);
    const existing = fresh ? null : await remoteStat(sftp, remote);
    if (st.isDirectory()) {
      if (existing && !existing.isDirectory()) throw new Error(`„${name}“ gibt es auf dem Server schon als Datei.`);
      if (!existing) await p(cb => sftp.mkdir(remote, cb)).catch(err => { throw sftpError(err, name); });
      for (const child of await fsp.readdir(local)) {
        if (SYSTEM_FILES.has(child)) continue;
        await uploadOne(job, sftp, path.join(local, child), remote, state, !existing);
      }
      return;
    }
    if (existing) {
      if (existing.isDirectory()) throw new Error(`„${name}“ gibt es auf dem Server schon als Ordner.`);
      const choice = await resolveConflict(job, state, {
        name, target: remote,
        source: { size: st.size, mtime: st.mtimeMs }, existing: { size: existing.size, mtime: existing.mtime * 1000 },
      });
      if (choice === 'skip') { state.skipped++; job.setTotal(job.total - st.size); return; }
    }
    await job.copy('put', sftp, local, remote, name);
  }

  async function downloadOne(job, sftp, remote, localDir, state, fresh) {
    job.check();
    const name = posix.basename(remote);
    if (!safeRemoteName(name)) { state.skipped++; return; }
    const local = path.join(localDir, name);
    const st = await p(cb => sftp.stat(remote, cb)).catch(err => { throw sftpError(err, name); });
    const existing = fresh ? null : await localStat(local);
    if (st.isDirectory()) {
      if (existing && !existing.isDirectory()) throw new Error(`„${name}“ gibt es auf diesem Computer schon als Datei.`);
      if (!existing) await fsp.mkdir(local);
      const list = await p(cb => sftp.readdir(remote, cb)).catch(err => { throw sftpError(err, name); });
      for (const it of list) await downloadOne(job, sftp, posix.join(remote, it.filename), local, state, !existing);
      return;
    }
    if (existing) {
      if (existing.isDirectory()) throw new Error(`„${name}“ gibt es auf diesem Computer schon als Ordner.`);
      const choice = await resolveConflict(job, state, {
        name, target: local,
        source: { size: st.size, mtime: st.mtime * 1000 }, existing: { size: existing.size, mtime: existing.mtimeMs },
      });
      if (choice === 'skip') { state.skipped++; job.setTotal(job.total - st.size); return; }
    }
    await job.copy('get', sftp, remote, local, name);
  }

  const titleFor = (names, base) => names.length === 1 ? base(names[0]) : `${names.length} Elemente`;

  // localPaths: absolute lokale Pfade, remoteDir: Zielordner auf dem Server
  ipcMain.handle('xfer:upload', async (_e, tabId, remoteDir, localPaths) => {
    if (typeof remoteDir !== 'string' || !remoteDir.startsWith('/')) throw new Error('Ungültiger Zielordner auf dem Server.');
    if (!Array.isArray(localPaths) || !localPaths.length) return { files: 0, skipped: 0 };
    const list = localPaths.map(checkPath);
    const sftp = await getSftp(tabId);
    const job = transfers.start(tabId, 'upload', titleFor(list, path.basename));
    const state = { all: null, skipped: 0, multi: list.length > 1 };
    try {
      if (!state.multi) state.multi = (await fsp.stat(list[0])).isDirectory();
      job.setTotal(transfers.localSize(list));
      for (const local of list) await uploadOne(job, sftp, local, remoteDir, state, false);
    } catch (err) {
      job.finish(err);
      throw cleanError(err, sftpError);
    }
    job.finish();
    return { files: job.files, skipped: state.skipped };
  });

  // items: [{ path }] auf dem Server, localDir: Zielordner auf diesem Computer
  ipcMain.handle('xfer:download', async (_e, tabId, localDir, items) => {
    const dir = checkPath(localDir);
    const dst = await localStat(dir);
    if (!dst || !dst.isDirectory()) throw new Error('Den Zielordner gibt es nicht mehr.');
    if (!Array.isArray(items) || !items.length) return { files: 0, skipped: 0 };
    const remotes = items.map(it => String(it.path));
    if (remotes.some(r => !r.startsWith('/'))) throw new Error('Ungültiger Pfad auf dem Server.');
    const sftp = await getSftp(tabId);
    const job = transfers.start(tabId, 'download', titleFor(remotes, posix.basename));
    const state = { all: null, skipped: 0, multi: remotes.length > 1 || !!items[0].isDir };
    try {
      job.setTotal(await transfers.remoteSize(sftp, remotes));
      for (const r of remotes) await downloadOne(job, sftp, r, dir, state, false);
    } catch (err) {
      job.finish(err);
      throw cleanError(err, sftpError);
    }
    job.finish();
    return { files: job.files, skipped: state.skipped, dir };
  });
}

module.exports = { register };
