// Sichere Brücke zwischen Oberfläche und Hauptprozess
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('myssh', {
  // S3CURE_PLATFORM nur für Tests (Windows-Verhalten auf dem Mac ausprobieren)
  platform: process.env.S3CURE_PLATFORM || process.platform,
  listHosts: () => ipcRenderer.invoke('hosts:list'),
  saveHost: (name, host, oldName) => ipcRenderer.invoke('hosts:save', name, host, oldName),
  deleteHost: name => ipcRenderer.invoke('hosts:delete', name),
  pickKey: () => ipcRenderer.invoke('pick-key'),

  connect: (id, spec, cols, rows) => ipcRenderer.invoke('ssh:connect', id, spec, cols, rows),
  write: (id, data) => ipcRenderer.send('ssh:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', id, cols, rows),
  close: id => ipcRenderer.send('ssh:close', id),

  sftpList: (id, dir) => ipcRenderer.invoke('sftp:list', id, dir),
  sftpMkdir: (id, remote) => ipcRenderer.invoke('sftp:mkdir', id, remote),
  sftpRename: (id, from, to) => ipcRenderer.invoke('sftp:rename', id, from, to),
  sftpDelete: (id, remotes) => ipcRenderer.invoke('sftp:delete', id, remotes),
  sftpUpload: (id, remoteDir, localPaths) => ipcRenderer.invoke('sftp:upload', id, remoteDir, localPaths),
  sftpDownload: (id, items) => ipcRenderer.invoke('sftp:download', id, items),
  pickUpload: kind => ipcRenderer.invoke('pick-upload', kind),
  pathForFile: file => webUtils.getPathForFile(file),
  showFile: file => ipcRenderer.send('show-file', file),
  searchStart: (id, root, query, searchId) => ipcRenderer.invoke('search:start', id, root, query, searchId),
  searchCancel: id => ipcRenderer.send('search:cancel', id),
  onSearchResults: cb => ipcRenderer.on('search:results', (_e, id, searchId, results) => cb(id, searchId, results)),
  onSearchDone: cb => ipcRenderer.on('search:done', (_e, id, searchId, info) => cb(id, searchId, info)),

  // Editor, Vorschau, Rechte, ZIP, Übertragungen (app/lib/sftp-extra.js, app/lib/transfers.js)
  sftpReadText: (id, file) => ipcRenderer.invoke('sftp:readText', id, file),
  sftpWriteText: (id, file, text, opts) => ipcRenderer.invoke('sftp:writeText', id, file, text, opts),
  sftpPreview: (id, file) => ipcRenderer.invoke('sftp:preview', id, file),
  sftpStat: (id, file) => ipcRenderer.invoke('sftp:stat', id, file),
  sftpChmod: (id, files, mode) => ipcRenderer.invoke('sftp:chmod', id, files, mode),
  archiveExists: (id, file) => ipcRenderer.invoke('archive:exists', id, file),
  archivePack: (id, dir, names, archive, overwrite) => ipcRenderer.invoke('archive:pack', id, dir, names, archive, overwrite),
  archiveUnpack: (id, file) => ipcRenderer.invoke('archive:unpack', id, file),
  transferCancel: jobId => ipcRenderer.send('transfer:cancel', jobId),
  onTransfer: cb => ipcRenderer.on('transfer:update', (_e, info) => cb(info)),

  onData: cb => ipcRenderer.on('ssh:data', (_e, id, data) => cb(id, data)),
  onClosed: cb => ipcRenderer.on('ssh:closed', (_e, id) => cb(id)),
  onAsk: cb => ipcRenderer.on('ask', (_e, req) => cb(req)),
  answer: (reqId, value) => ipcRenderer.send('ask-answer', reqId, value),
});
