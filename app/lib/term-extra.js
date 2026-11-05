// Terminal-Extras im Hauptprozess:
// - zweite Shell auf derselben Verbindung (geteilte Ansicht)
// - Mitschnitt einer Sitzung als Textdatei (ohne Farbcodes)
// - Links aus dem Terminal im Browser öffnen (nur http/https)
// - Cmd/Strg + Plus/Minus/0 an die Oberfläche weitergeben (statt die ganze Seite zu zoomen)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AnsiStripper } = require('./ansi-strip');
const i18n = require('./i18n');

function register({ app, ipcMain, dialog, shell, sessions, getWin, platform }) {
  const splits = new Map(); // Split-ID -> { tabId, stream }
  const logs = new Map();   // Terminal-ID (Tab oder Split) -> { file, out, strip, detach }

  const send = (...args) => { const win = getWin(); if (win && !win.isDestroyed()) win.webContents.send(...args); };
  const streamFor = id => splits.get(id)?.stream || sessions.get(id)?.stream || null;

  // ---------- Geteilte Ansicht ----------

  ipcMain.handle('split:open', (_e, tabId, splitId, cols, rows) => {
    const s = sessions.get(tabId);
    if (!s) throw new Error(i18n.t('termExtra.notConnected'));
    return new Promise((resolve, reject) => {
      s.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) return reject(new Error(i18n.t('termExtra.splitFailed', { error: err.message })));
        splits.set(splitId, { tabId, stream });
        stream.on('data', d => send('split:data', splitId, d));
        stream.stderr.on('data', d => send('split:data', splitId, d));
        stream.on('close', () => {
          splits.delete(splitId);
          send('split:closed', splitId);
        });
        resolve(true);
      });
    });
  });
  ipcMain.on('split:write', (_e, id, data) => splits.get(id)?.stream.write(data));
  ipcMain.on('split:resize', (_e, id, cols, rows) => splits.get(id)?.stream.setWindow(rows, cols, 0, 0));
  ipcMain.on('split:close', (_e, id) => {
    const s = splits.get(id);
    if (!s) return;
    splits.delete(id);
    try { s.stream.close(); } catch {}
  });

  // ---------- Mitschnitt ----------

  function stopLog(id, reason) {
    const log = logs.get(id);
    if (!log) return null;
    logs.delete(id);
    log.detach();
    const rest = log.strip.end();
    if (rest) log.out.write(rest);
    const when = new Date().toLocaleString(i18n.locale());
    log.out.end('\n' + (reason ? i18n.t('termExtra.logEndedReason', { when, reason }) : i18n.t('termExtra.logEnded', { when })) + '\n');
    send('log:stopped', id, log.file);
    return log.file;
  }

  ipcMain.handle('log:start', async (_e, id, title) => {
    const stream = streamFor(id);
    if (!stream) throw new Error(i18n.t('termExtra.notConnected'));
    if (logs.has(id)) return logs.get(id).file;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const safe = String(title || i18n.t('termExtra.sessionFallback')).replace(/[^\w.@-]+/g, '_').slice(0, 60);
    const docs = app.getPath('documents') || os.homedir();
    const r = await dialog.showSaveDialog(getWin(), {
      title: i18n.t('termExtra.logSaveTitle'),
      buttonLabel: i18n.t('termExtra.logSaveButton'),
      defaultPath: path.join(docs, `S3cure-${safe}-${stamp}.txt`),
      filters: [{ name: i18n.t('termExtra.textFile'), extensions: ['txt', 'log'] }],
    });
    if (r.canceled || !r.filePath) return null;
    // Zwischen Dialog und Antwort könnte die Verbindung weg sein
    const live = streamFor(id);
    if (!live) throw new Error(i18n.t('termExtra.connGone'));

    const out = fs.createWriteStream(r.filePath, { flags: 'w', mode: 0o600 });
    await new Promise((res, rej) => { out.once('open', res); out.once('error', rej); });
    const strip = new AnsiStripper();
    const onData = d => { const t = strip.push(d); if (t) out.write(t); };
    const onClose = () => stopLog(id, i18n.t('termExtra.reasonConnClosed'));
    live.on('data', onData);
    live.stderr.on('data', onData);
    live.once('close', onClose);
    out.on('error', err => { send('log:error', id, err.message); stopLog(id); });
    out.write(i18n.t('termExtra.logHeader', { title: title || '', when: new Date().toLocaleString(i18n.locale()) }) + '\n\n');
    logs.set(id, {
      file: r.filePath, out, strip,
      detach: () => { live.off('data', onData); live.stderr.off('data', onData); live.off('close', onClose); },
    });
    return r.filePath;
  });
  ipcMain.handle('log:stop', (_e, id) => stopLog(id));

  // ---------- Links ----------

  ipcMain.on('term:open-link', (_e, url) => {
    let u;
    try { u = new URL(String(url)); } catch { return; }
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href);
  });

  // ---------- Schriftgröße per Tastatur ----------
  // Vor dem Menü abfangen, sonst vergrößert Electron die ganze Oberfläche

  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.alt) return;
      const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
      if (!mod) return;
      const step = { '+': 1, '=': 1, '-': -1, '_': -1, '0': 0 }[input.key];
      if (step === undefined) return;
      event.preventDefault();
      win.webContents.send('term:zoom', step);
    });
  });

  app.on('before-quit', () => { for (const id of [...logs.keys()]) stopLog(id, i18n.t('termExtra.reasonAppQuit'));
 });
}

module.exports = { register };
