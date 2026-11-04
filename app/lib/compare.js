// Dateien vergleichen: lokale Textdatei lesen und auswählen (Oberfläche: src/compare.js)
// Die Server-Seite liest über 'sftp:readText' (lib/sftp-extra.js).
const fsp = require('fs').promises;
const path = require('path');
const { checkPath, friendly } = require('./localfs');

const LIMIT = 2 * 1024 * 1024;

function looksBinary(buf) {
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) return true;
  let ctrl = 0;
  for (const b of sample) if (b < 7 || (b > 13 && b < 32 && b !== 27)) ctrl++;
  return sample.length > 0 && ctrl / sample.length > 0.1;
}

function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return buf.toString('latin1'); }
}

function register({ ipcMain, dialog, getWin }) {
  ipcMain.handle('compare:readLocal', async (_e, file) => {
    const abs = checkPath(file);
    let st;
    try { st = await fsp.stat(abs); } catch (err) { throw friendly(err, path.basename(abs)); }
    if (st.isDirectory()) throw new Error('Das ist ein Ordner, keine Datei.');
    if (st.size > LIMIT) return { tooBig: true, size: st.size };
    const buf = await fsp.readFile(abs).catch(err => { throw friendly(err, path.basename(abs)); });
    if (looksBinary(buf)) return { binary: true };
    return { text: decode(buf), size: st.size, mtime: st.mtimeMs, path: abs };
  });

  ipcMain.handle('compare:pickLocal', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: 'Lokale Datei zum Vergleichen wählen', buttonLabel: 'Vergleichen',
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
      properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
}

module.exports = { register, LIMIT };
