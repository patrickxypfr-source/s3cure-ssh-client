// Lokales Dateisystem für das zweite Dateifenster „Mein Computer“ (src/local-pane.js)
// Nur diese Funktionen greifen auf lokale Dateien zu. Alle Pfade werden geprüft:
// absolut, ohne Nullbyte, und Namen ohne Schrägstriche.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { t } = require('./i18n');

const MAX_PATH = 4096;
// Dateien, die das System selbst anlegt – werden wie versteckte Dateien behandelt
const SYSTEM_FILES = new Set(['.DS_Store', 'desktop.ini', 'Thumbs.db', '$RECYCLE.BIN', '$Recycle.Bin', 'System Volume Information',
  'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'DumpStack.log.tmp', 'DumpStack.log']);
const BAD_WIN_CHARS = /[<>:"|?*\x00-\x1f]/;

function friendly(err, where) {
  const w = where ? ` (${where})` : '';
  switch (err && err.code) {
    case 'ENOENT': return new Error(t('localfs.notFound', { where: w }));
    case 'EACCES': case 'EPERM': return new Error(t('localfs.noPermission', { where: w }));
    case 'ENOTDIR': return new Error(t('localfs.notDir', { where: w }));
    case 'EEXIST': return new Error(t('localfs.exists', { where: w }));
    case 'EBUSY': return new Error(t('localfs.busy', { where: w }));
    default: return err instanceof Error ? err : new Error(String(err));
  }
}

// Absoluten, normalisierten Pfad prüfen; ~ steht für den Benutzerordner
function checkPath(p) {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH || p.includes('\0')) throw new Error(t('localfs.invalidPath'));
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
  if (!path.isAbsolute(p)) throw new Error(t('localfs.needAbsolute'));
  return path.resolve(p);
}

// Einzelner Datei- oder Ordnername (Umbenennen, Neuer Ordner)
function checkName(name, isWin) {
  name = typeof name === 'string' ? name.trim() : '';
  if (!name || name === '.' || name === '..' || name.length > 255) throw new Error(t('localfs.invalidName'));
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) throw new Error(t('localfs.noSlash'));
  if (isWin && (BAD_WIN_CHARS.test(name) || /[. ]$/.test(name))) throw new Error(t('localfs.badWinChars'));
  return name;
}

const exists = p => fsp.lstat(p).then(() => true, () => false);
const isRoot = p => path.parse(p).root === p;

async function listDir(dir) {
  const abs = checkPath(dir);
  let dirents;
  try { dirents = await fsp.readdir(abs, { withFileTypes: true }); } catch (err) { throw friendly(err, abs); }
  const entries = await Promise.all(dirents.map(async d => {
    const full = path.join(abs, d.name);
    const isLink = d.isSymbolicLink();
    let st = null;
    try { st = await fsp.stat(full); } catch { try { st = await fsp.lstat(full); } catch {} }
    const isDir = st ? st.isDirectory() : d.isDirectory();
    return {
      name: d.name, path: full, isDir, isLink,
      size: st && !isDir ? st.size : 0, mtime: st ? st.mtimeMs : 0,
      hidden: d.name.startsWith('.') || SYSTEM_FILES.has(d.name),
    };
  }));
  return { path: abs, parent: isRoot(abs) ? null : path.dirname(abs), entries };
}

async function windowsDrives() {
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
  const found = await Promise.all(letters.map(l => fsp.access(l + ':\\').then(() => l, () => null)));
  return found.filter(Boolean).sort().map(l => ({ label: l + ':', path: l + ':\\' }));
}

function register({ app, ipcMain, shell, platform }) {
  const IS_WIN = platform === 'win32';
  const REAL_WIN = process.platform === 'win32';

  ipcMain.handle('localfs:places', async () => {
    const places = [];
    const add = async (label, key, icon) => {
      let p;
      try { p = app.getPath(key); } catch { return; }
      // Ohne eigenen Ordner liefert manches System den Benutzerordner – dann weglassen
      if (path.resolve(p) !== path.resolve(os.homedir()) && await exists(p)) places.push({ label, path: p, icon });
    };
    await add(t('localfs.desktop'), 'desktop', 'desktop');
    await add(t('localfs.downloads'), 'downloads', 'download');
    await add(t('localfs.documents'), 'documents', 'file');
    let drives = [];
    if (REAL_WIN) drives = await windowsDrives();
    // Test unter macOS/Linux mit S3CURE_PLATFORM=win32: Wurzel als „Laufwerk“ zeigen
    else if (IS_WIN) drives = [{ label: '/', path: '/' }];
    return { home: os.homedir(), places, drives, sep: path.sep };
  });

  ipcMain.handle('localfs:list', (_e, dir) => listDir(dir));

  // Mit dem Standardprogramm öffnen
  ipcMain.handle('localfs:open', async (_e, p) => {
    const abs = checkPath(p);
    if (!(await exists(abs))) throw friendly({ code: 'ENOENT' }, path.basename(abs));
    const msg = await shell.openPath(abs);
    if (msg) throw new Error(t('localfs.openFailed', { error: msg }));
  });

  ipcMain.handle('localfs:show', async (_e, p) => { shell.showItemInFolder(checkPath(p)); });

  ipcMain.handle('localfs:rename', async (_e, from, newName) => {
    const src = checkPath(from);
    const name = checkName(newName, IS_WIN);
    if (isRoot(src)) throw new Error(t('localfs.cantRename'));
    const dest = path.join(path.dirname(src), name);
    // Nur Groß-/Kleinschreibung geändert (macOS/Windows) ist erlaubt
    if (dest.toLowerCase() !== src.toLowerCase() && await exists(dest)) throw new Error(t('localfs.nameTaken', { name }));
    try { await fsp.rename(src, dest); } catch (err) { throw friendly(err, name); }
    return dest;
  });

  ipcMain.handle('localfs:mkdir', async (_e, dir, newName) => {
    const parent = checkPath(dir);
    const name = checkName(newName, IS_WIN);
    const dest = path.join(parent, name);
    try { await fsp.mkdir(dest); } catch (err) { throw friendly(err, name); }
    return dest;
  });

  // In den Papierkorb – nie endgültig löschen
  ipcMain.handle('localfs:trash', async (_e, paths) => {
    if (!Array.isArray(paths) || !paths.length) return 0;
    const list = paths.map(checkPath);
    const home = path.resolve(os.homedir());
    for (const p of list) {
      if (isRoot(p) || p === home) throw new Error(t('localfs.cantTrash'));
    }
    let n = 0;
    for (const p of list) {
      try { await shell.trashItem(p); n++; } catch (err) { throw new Error(t('localfs.trashFailed', { name: path.basename(p), error: err.message || err })); }
    }
    return n;
  });
}

module.exports = { register, checkPath, checkName, friendly, SYSTEM_FILES };
