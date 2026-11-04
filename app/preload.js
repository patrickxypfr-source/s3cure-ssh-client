// Sichere Brücke zwischen Oberfläche und Hauptprozess
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('myssh', {
  // S3CURE_PLATFORM nur für Tests (Windows-Verhalten auf dem Mac ausprobieren)
  platform: process.env.S3CURE_PLATFORM || process.platform,
  listHosts: () => ipcRenderer.invoke('hosts:list'),
  saveHost: (name, host, oldName) => ipcRenderer.invoke('hosts:save', name, host, oldName),
  deleteHost: name => ipcRenderer.invoke('hosts:delete', name),
  pickKey: () => ipcRenderer.invoke('pick-key'),
  sshConfigScan: () => ipcRenderer.invoke('sshconfig:scan'),
  sshConfigImport: () => ipcRenderer.invoke('sshconfig:import'),
  keyStatus: () => ipcRenderer.invoke('keys:status'),
  keyGenerate: (passphrase, remember) => ipcRenderer.invoke('keys:generate', passphrase, remember),
  keyInstall: name => ipcRenderer.invoke('keys:install', name),

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
  snippetsLoad: () => ipcRenderer.invoke('snippets:load'),
  snippetsSave: (key, profile) => ipcRenderer.invoke('snippets:save', key, profile),
  snippetsMigrate: profiles => ipcRenderer.invoke('snippets:migrate', profiles),
  snippetsExport: (name, groups) => ipcRenderer.invoke('snippets:export', name, groups),
  snippetsImport: () => ipcRenderer.invoke('snippets:import'),
  monitorStats: id => ipcRenderer.invoke('monitor:stats', id),

  onData: cb => ipcRenderer.on('ssh:data', (_e, id, data) => cb(id, data)),
  onClosed: cb => ipcRenderer.on('ssh:closed', (_e, id) => cb(id)),
  onLost: cb => ipcRenderer.on('ssh:lost', (_e, id) => cb(id)),
  onResume: cb => ipcRenderer.on('power:resume', () => cb()),
  onAsk: cb => ipcRenderer.on('ask', (_e, req) => cb(req)),
  answer: (reqId, value) => ipcRenderer.send('ask-answer', reqId, value),

  lockStatus: () => ipcRenderer.invoke('lock:status'),
  unlock: password => ipcRenderer.invoke('lock:unlock', password),
  unlockTouchId: () => ipcRenderer.invoke('lock:touchid'),
  configureLock: opts => ipcRenderer.invoke('lock:configure', opts),
});

// Tunnel (app/lib/tunnels.js, Oberfläche: src/tunnels.js)
contextBridge.exposeInMainWorld('s3tunnels', {
  status: tabId => ipcRenderer.invoke('tunnels:status', tabId),
  start: (tabId, id) => ipcRenderer.invoke('tunnels:start', tabId, id),
  stop: (tabId, id) => ipcRenderer.invoke('tunnels:stop', tabId, id),
  save: (hostName, tunnel) => ipcRenderer.invoke('tunnels:save', hostName, tunnel),
  remove: (hostName, id) => ipcRenderer.invoke('tunnels:delete', hostName, id),
  open: (tabId, id) => ipcRenderer.invoke('tunnels:open', tabId, id),
  onStatus: cb => ipcRenderer.on('tunnels:status', (_e, tabId, st) => cb(tabId, st)),
});

// Hinweis auf neue Version (app/lib/update-check.js, Oberfläche: src/update-notice.js)
contextBridge.exposeInMainWorld('s3update', {
  check: () => ipcRenderer.invoke('update:check'),
  dismiss: version => ipcRenderer.invoke('update:dismiss', version),
  disable: () => ipcRenderer.invoke('update:disable'),
  open: () => ipcRenderer.invoke('update:open'),
});

// Einstellungen (src/settings.js)
contextBridge.exposeInMainWorld('mysshSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: patch => ipcRenderer.invoke('settings:set', patch),
});

// Terminal-Extras (src/term-extra.js)
contextBridge.exposeInMainWorld('mysshTerm', {
  splitOpen: (tabId, splitId, cols, rows) => ipcRenderer.invoke('split:open', tabId, splitId, cols, rows),
  splitWrite: (id, data) => ipcRenderer.send('split:write', id, data),
  splitResize: (id, cols, rows) => ipcRenderer.send('split:resize', id, cols, rows),
  splitClose: id => ipcRenderer.send('split:close', id),
  onSplitData: cb => ipcRenderer.on('split:data', (_e, id, data) => cb(id, data)),
  onSplitClosed: cb => ipcRenderer.on('split:closed', (_e, id) => cb(id)),
  logStart: (id, title) => ipcRenderer.invoke('log:start', id, title),
  logStop: id => ipcRenderer.invoke('log:stop', id),
  onLogStopped: cb => ipcRenderer.on('log:stopped', (_e, id, file) => cb(id, file)),
  onLogError: cb => ipcRenderer.on('log:error', (_e, id, msg) => cb(id, msg)),
  openLink: url => ipcRenderer.send('term:open-link', url),
  onZoom: cb => ipcRenderer.on('term:zoom', (_e, step) => cb(step)),
});

// Geteilte Dateiansicht „Mein Computer“ (app/lib/localfs.js, app/lib/pane-transfer.js, src/local-pane.js)
contextBridge.exposeInMainWorld('localFs', {
  places: () => ipcRenderer.invoke('localfs:places'),
  list: dir => ipcRenderer.invoke('localfs:list', dir),
  open: file => ipcRenderer.invoke('localfs:open', file),
  show: file => ipcRenderer.invoke('localfs:show', file),
  rename: (file, name) => ipcRenderer.invoke('localfs:rename', file, name),
  mkdir: (dir, name) => ipcRenderer.invoke('localfs:mkdir', dir, name),
  trash: files => ipcRenderer.invoke('localfs:trash', files),
  upload: (tabId, remoteDir, localPaths) => ipcRenderer.invoke('xfer:upload', tabId, remoteDir, localPaths),
  download: (tabId, localDir, items) => ipcRenderer.invoke('xfer:download', tabId, localDir, items),
  onConflict: cb => ipcRenderer.on('xfer:conflict', (_e, info) => cb(info)),
  answerConflict: (reqId, answer) => ipcRenderer.send('xfer:conflict-answer', reqId, answer),
});
