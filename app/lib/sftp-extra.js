// Zusätzliche Datei-Funktionen: Editor (Text lesen/schreiben), Vorschau,
// Rechte ändern, ZIP packen/entpacken.
const path = require('path');
const crypto = require('crypto');
const i18n = require('./i18n');
const { t } = i18n;

const posix = path.posix;
const p = fn => new Promise((res, rej) => fn((e, r) => e ? rej(e) : res(r)));
const shQuote = str => `'${String(str).replace(/'/g, `'\\''`)}'`;

const TEXT_LIMIT = 2 * 1024 * 1024;      // Editor: bis 2 MB
const PREVIEW_TEXT_LIMIT = 256 * 1024;   // Text-Vorschau: nur der Anfang
const IMAGE_LIMIT = 10 * 1024 * 1024;    // Bild-Vorschau: bis 10 MB
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };

function formatMB(n) { return (n / 1024 / 1024).toLocaleString(i18n.locale(), { maximumFractionDigits: 1 }) + ' MB'; }

// Ab Position 0 bis zu `max` Bytes lesen
async function readStart(sftp, file, max) {
  if (sftp.readStart) return sftp.readStart(file, max); // FTP (lib/ftp.js)
  const handle = await p(cb => sftp.open(file, 'r', cb));
  try {
    const buf = Buffer.alloc(max);
    let pos = 0;
    while (pos < max) {
      const n = await new Promise((res, rej) => sftp.read(handle, buf, pos, Math.min(65536, max - pos), pos, (e, nb) => e ? rej(e) : res(nb)));
      if (!n) break;
      pos += n;
    }
    return buf.subarray(0, pos);
  } finally {
    await p(cb => sftp.close(handle, cb)).catch(() => {});
  }
}

// Binärdatei? (Null-Bytes oder viele Steuerzeichen)
function looksBinary(buf) {
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) return true;
  let ctrl = 0;
  for (const b of sample) if (b < 7 || (b > 13 && b < 32 && b !== 27)) ctrl++;
  return sample.length > 0 && ctrl / sample.length > 0.1;
}

function decodeText(buf) {
  let bom = false;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) { buf = buf.subarray(3); bom = true; }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf8', bom };
  } catch {
    // Kein gültiges UTF-8 -> Latin-1 (alte Windows-/Linux-Dateien)
    return { text: buf.toString('latin1'), encoding: 'latin1', bom: false };
  }
}

// Schreibt alles in einen geöffneten Handle
async function writeAll(sftp, handle, buf) {
  let pos = 0;
  while (pos < buf.length) {
    const len = Math.min(32768, buf.length - pos);
    await p(cb => sftp.write(handle, buf, pos, len, pos, cb));
    pos += len;
  }
}

function friendlyExecError(stderr, code) {
  const msg = String(stderr || '').trim().split('\n').slice(-3).join('\n');
  return msg || t('sftpExtra.commandFailed', { code });
}

// Befehl auf dem Server ausführen (immer über sh, egal welche Login-Shell)
function run(client, script) {
  return new Promise((resolve, reject) => {
    client.exec('sh -c ' + shQuote(script), (err, stream) => {
      if (err) return reject(new Error(t('sftpExtra.noExec', { error: err.message })));
      let out = '';
      let errOut = '';
      let code = null;
      stream.on('data', d => { out += d; });
      stream.stderr.on('data', d => { errOut += d; });
      stream.on('exit', c => { code = c; });
      stream.on('close', () => resolve({ code, out, err: errOut }));
    });
  });
}

const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz)$/i;

function register({ ipcMain, getSftp, getClient, sftpError }) {

  async function exists(sftp, file) {
    try { await p(cb => sftp.lstat(file, cb)); return true; } catch { return false; }
  }

  // ---------- Editor ----------

  ipcMain.handle('sftp:readText', async (_e, tabId, file) => {
    const sftp = await getSftp(tabId);
    try {
      const real = await p(cb => sftp.realpath(file, cb));
      const st = await p(cb => sftp.stat(real, cb));
      if (st.isDirectory()) throw new Error(t('sftpExtra.isFolder'));
      if (st.size > TEXT_LIMIT) {
        throw new Error(t('sftpExtra.tooBigForEditor', { size: formatMB(st.size), max: formatMB(TEXT_LIMIT) }));
      }
      const buf = await readStart(sftp, real, st.size + 1);
      if (looksBinary(buf)) return { binary: true };
      const { text, encoding, bom } = decodeText(buf);
      const eol = /\r\n/.test(text) ? 'crlf' : 'lf';
      return {
        binary: false, path: file, real, text: eol === 'crlf' ? text.replace(/\r\n/g, '\n') : text,
        encoding, bom, eol, size: st.size, mtime: st.mtime, mode: st.mode & 0o7777,
      };
    } catch (err) { throw sftpError(err, posix.basename(file)); }
  });

  // Atomar speichern: erst in eine temporäre Datei im selben Ordner schreiben,
  // Rechte übernehmen, dann über das Original umbenennen.
  // opts: { real, encoding, bom, eol, mtime (beim Öffnen), force }
  ipcMain.handle('sftp:writeText', async (_e, tabId, file, text, opts = {}) => {
    const sftp = await getSftp(tabId);
    const target = opts.real || file;
    try {
      let st = null;
      try { st = await p(cb => sftp.stat(target, cb)); } catch (err) { if (err.code !== 2) throw err; }
      if (st && opts.mtime && st.mtime !== opts.mtime && !opts.force) {
        return { conflict: true, mtime: st.mtime };
      }
      let body = opts.eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text;
      let buf = Buffer.from(body, opts.encoding === 'latin1' ? 'latin1' : 'utf8');
      if (opts.bom) buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
      const mode = st ? st.mode & 0o7777 : 0o644;

      const dir = posix.dirname(target);
      const tmp = posix.join(dir, `.${posix.basename(target)}.s3cure-${crypto.randomBytes(4).toString('hex')}.tmp`);
      let handle = null;
      try { handle = await p(cb => sftp.open(tmp, 'wx', { mode }, cb)); } catch { handle = null; }

      if (!handle) {
        // Ordner nicht beschreibbar (nur die Datei selbst) -> direkt hineinschreiben
        const h = await p(cb => sftp.open(target, 'w', cb));
        try { await writeAll(sftp, h, buf); } finally { await p(cb => sftp.close(h, cb)).catch(() => {}); }
      } else {
        try {
          await writeAll(sftp, handle, buf);
          await p(cb => sftp.fchmod(handle, mode, cb)).catch(() => {});
          if (st) await p(cb => sftp.fchown(handle, st.uid, st.gid, cb)).catch(() => {}); // klappt nur, wenn erlaubt
          await p(cb => sftp.close(handle, cb));
          handle = null;
          if (st) {
            try {
              await p(cb => sftp.ext_openssh_rename(tmp, target, cb)); // ersetzt in einem Schritt
            } catch {
              // Server ohne posix-rename: Original kurz beiseite, neue Datei hin, Original weg
              const old = tmp + '.alt';
              await p(cb => sftp.rename(target, old, cb));
              try { await p(cb => sftp.rename(tmp, target, cb)); }
              catch (err) { await p(cb => sftp.rename(old, target, cb)).catch(() => {}); throw err; }
              await p(cb => sftp.unlink(old, cb)).catch(() => {});
            }
          } else {
            await p(cb => sftp.rename(tmp, target, cb));
          }
        } catch (err) {
          if (handle) await p(cb => sftp.close(handle, cb)).catch(() => {});
          await p(cb => sftp.unlink(tmp, cb)).catch(() => {});
          throw err;
        }
      }
      const after = await p(cb => sftp.stat(target, cb));
      return { ok: true, mtime: after.mtime, size: after.size };
    } catch (err) { throw sftpError(err, posix.basename(file)); }
  });

  // ---------- Vorschau ----------

  ipcMain.handle('sftp:preview', async (_e, tabId, file) => {
    const sftp = await getSftp(tabId);
    try {
      const st = await p(cb => sftp.stat(file, cb));
      if (st.isDirectory()) throw new Error(t('sftpExtra.noFolderPreview'));
      const ext = (posix.extname(file).slice(1) || '').toLowerCase();
      const info = { size: st.size, mtime: st.mtime * 1000 };
      if (IMAGE_TYPES[ext]) {
        if (st.size > IMAGE_LIMIT) return { ...info, kind: 'toolarge', limit: IMAGE_LIMIT };
        const buf = await readStart(sftp, file, st.size);
        return { ...info, kind: 'image', mime: IMAGE_TYPES[ext], data: buf.toString('base64') };
      }
      const buf = await readStart(sftp, file, Math.min(st.size, PREVIEW_TEXT_LIMIT));
      if (looksBinary(buf)) return { ...info, kind: 'binary' };
      return { ...info, kind: 'text', text: decodeText(buf).text, truncated: st.size > PREVIEW_TEXT_LIMIT };
    } catch (err) { throw sftpError(err, posix.basename(file)); }
  });

  // ---------- Rechte ----------

  ipcMain.handle('sftp:stat', async (_e, tabId, file) => {
    const sftp = await getSftp(tabId);
    try {
      const st = await p(cb => sftp.stat(file, cb));
      return { mode: st.mode & 0o7777, uid: st.uid, gid: st.gid, size: st.size, isDir: st.isDirectory() };
    } catch (err) { throw sftpError(err, posix.basename(file)); }
  });

  // mode: nur die 9 Grundrechte (rwx für Besitzer/Gruppe/Andere); Sonderbits bleiben erhalten
  ipcMain.handle('sftp:chmod', async (_e, tabId, files, mode) => {
    const sftp = await getSftp(tabId);
    for (const file of files) {
      try {
        const st = await p(cb => sftp.stat(file, cb));
        await p(cb => sftp.chmod(file, (st.mode & 0o7000) | (mode & 0o777), cb));
      } catch (err) { throw sftpError(err, posix.basename(file)); }
    }
  });

  // ---------- ZIP ----------

  ipcMain.handle('archive:exists', async (_e, tabId, file) => exists(await getSftp(tabId), file));

  // names: Namen im Ordner dir; archive: Name der ZIP-Datei (im selben Ordner)
  ipcMain.handle('archive:pack', async (_e, tabId, dir, names, archive, overwrite) => {
    const client = getClient(tabId);
    const items = names.map(n => shQuote('./' + n)).join(' ');
    const zipPath = shQuote(archive);
    const tarName = archive.replace(/\.zip$/i, '') + '.tar.gz';
    const script = [
      `cd ${shQuote(dir)} || exit 90`,
      overwrite ? `rm -f -- ${zipPath}` : `[ -e ${zipPath} ] && exit 91`,
      `if command -v zip >/dev/null 2>&1; then zip -r -q -y ${zipPath} ${items}; exit $?; fi`,
      `if command -v python3 >/dev/null 2>&1; then python3 -m zipfile -c ${zipPath} ${items}; exit $?; fi`,
      `if command -v tar >/dev/null 2>&1; then tar -czf ${shQuote(tarName)} ${items} && echo TAR; exit $?; fi`,
      'exit 92',
    ].join('\n');
    const r = await run(client, script);
    if (r.code === 90) throw new Error(t('sftpExtra.folderNotFound'));
    if (r.code === 91) throw new Error(t('sftpExtra.exists', { name: archive }));
    if (r.code === 92) throw new Error(t('sftpExtra.noPackTool'));
    if (r.code !== 0) throw new Error(t('sftpExtra.packFailed', { error: friendlyExecError(r.err, r.code) }));
    return { name: /TAR/.test(r.out) ? tarName : archive, tar: /TAR/.test(r.out) };
  });

  // Entpackt in einen neuen Ordner neben dem Archiv (es wird nie etwas überschrieben)
  ipcMain.handle('archive:unpack', async (_e, tabId, file) => {
    const sftp = await getSftp(tabId);
    const client = getClient(tabId);
    const dir = posix.dirname(file);
    const base = posix.basename(file);
    const m = base.match(ARCHIVE_RE);
    if (!m) throw new Error(t('sftpExtra.unsupportedArchive'));
    const stem = base.slice(0, -m[0].length) || t('sftpExtra.archiveDefault');
    let target = posix.join(dir, stem);
    for (let i = 2; await exists(sftp, target); i++) target = posix.join(dir, `${stem} (${i})`);

    const isZip = m[1].toLowerCase() === 'zip';
    const f = shQuote(file);
    const tq = shQuote(target);
    const script = isZip ? [
      `mkdir -p -- ${tq} || exit 90`,
      `if command -v unzip >/dev/null 2>&1; then unzip -q -n ${f} -d ${tq}; c=$?; [ $c -le 1 ] && exit 0; rm -rf -- ${tq}; exit $c; fi`,
      `if command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e ${f} ${tq}; exit $?; fi`,
      `if command -v bsdtar >/dev/null 2>&1; then bsdtar -xf ${f} -C ${tq}; exit $?; fi`,
      `rmdir -- ${tq} 2>/dev/null; exit 92`,
    ].join('\n') : [
      `mkdir -p -- ${tq} || exit 90`,
      `tar -xf ${f} -C ${tq} || { c=$?; rm -rf -- ${tq}; exit $c; }`,
    ].join('\n');
    const r = await run(client, script);
    if (r.code === 90) throw new Error(t('sftpExtra.targetNotCreated'));
    if (r.code === 92) throw new Error(t('sftpExtra.noUnzip'));
    if (r.code === 127) throw new Error(t('sftpExtra.noTar'));
    if (r.code !== 0) throw new Error(t('sftpExtra.unpackFailed', { error: friendlyExecError(r.err, r.code) }));
    return { folder: target };
  });
}

module.exports = { register, ARCHIVE_RE };
