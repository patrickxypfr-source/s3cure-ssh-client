// Sichere Brücke zwischen Oberfläche und Hauptprozess
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Sprache der Oberfläche (de/en) – synchron, damit src/i18n.js sie beim Laden schon kennt (lib/i18n.js)
const i18n = (() => { try { return ipcRenderer.sendSync('i18n:get') || {}; } catch { return {}; } })();

contextBridge.exposeInMainWorld('myssh', {
  // S3CURE_PLATFORM nur für Tests (Windows-Verhalten auf dem Mac ausprobieren)
  platform: process.env.S3CURE_PLATFORM || process.platform,
  lang: i18n.lang,
  langPref: i18n.pref,
  reloadForLanguage: () => ipcRenderer.invoke('i18n:reload'),
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
  // Warteschlange (app/lib/transfers.js, src/transfers.js)
  transferPause: jobId => ipcRenderer.send('transfer:pause', jobId),
  transferResume: jobId => ipcRenderer.send('transfer:resume', jobId),
  transferRetry: jobId => ipcRenderer.send('transfer:retry', jobId),
  transferMove: (jobId, delta) => ipcRenderer.send('transfer:move', jobId, delta),
  transferRemove: jobId => ipcRenderer.send('transfer:remove', jobId),
  transferClear: () => ipcRenderer.send('transfer:clear'),
  transferPauseAll: () => ipcRenderer.send('transfer:pause-all'),
  transferResumeAll: () => ipcRenderer.send('transfer:resume-all'),
  transferConfig: opts => ipcRenderer.invoke('transfer:config', opts),
  transferList: () => ipcRenderer.invoke('transfer:list'),
  snippetsLoad: () => ipcRenderer.invoke('snippets:load'),
  snippetsSave: (key, profile) => ipcRenderer.invoke('snippets:save', key, profile),
  snippetsSaveGlobal: profile => ipcRenderer.invoke('snippets:saveGlobal', profile),
  snippetsMigrate: profiles => ipcRenderer.invoke('snippets:migrate', profiles),
  snippetsExport: (name, groups) => ipcRenderer.invoke('snippets:export', name, groups),
  snippetsImport: () => ipcRenderer.invoke('snippets:import'),
  monitorStats: id => ipcRenderer.invoke('monitor:stats', id),

  onData: cb => ipcRenderer.on('ssh:data', (_e, id, data) => cb(id, data)),
  onClosed: cb => ipcRenderer.on('ssh:closed', (_e, id) => cb(id)),
  onLost: cb => ipcRenderer.on('ssh:lost', (_e, id) => cb(id)),
  onResume: cb => ipcRenderer.on('power:resume', () => cb()),
  onHostsChanged: cb => ipcRenderer.on('hosts:changed', () => cb()),
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

// Remote Desktop über VNC durch SSH (app/lib/vnc.js, Oberfläche: src/vnc.js)
contextBridge.exposeInMainWorld('s3vnc', {
  open: (tabId, opts) => ipcRenderer.invoke('vnc:open', tabId, opts),
  close: tabId => ipcRenderer.invoke('vnc:close', tabId),
  scan: tabId => ipcRenderer.invoke('vnc:scan', tabId),
  settings: hostName => ipcRenderer.invoke('vnc:settings', hostName),
  hasPassword: hostName => ipcRenderer.invoke('vnc:hasPassword', hostName),
  savePassword: (hostName, password) => ipcRenderer.invoke('vnc:savePassword', hostName, password),
  forgetPassword: hostName => ipcRenderer.invoke('vnc:forgetPassword', hostName),
  clipboardRead: () => ipcRenderer.invoke('vnc:clipboardRead'),
  clipboardWrite: text => ipcRenderer.invoke('vnc:clipboardWrite', text),
});

// Hinweis auf neue Version (app/lib/update-check.js, Oberfläche: src/update-notice.js)
contextBridge.exposeInMainWorld('s3update', {
  check: force => ipcRenderer.invoke('update:check', !!force),
  dismiss: version => ipcRenderer.invoke('update:dismiss', version),
  disable: () => ipcRenderer.invoke('update:disable'),
  open: () => ipcRenderer.invoke('update:open'),
  // Automatisches Update (app/lib/updater.js)
  install: () => ipcRenderer.invoke('updater:start'),
  cancel: () => ipcRenderer.invoke('updater:cancel'),
  close: () => ipcRenderer.invoke('updater:close'),
  state: () => ipcRenderer.invoke('updater:state'),
  kind: () => ipcRenderer.invoke('updater:kind'),
  onState: cb => ipcRenderer.on('updater:state', (_e, st) => cb(st)),
  fit: height => ipcRenderer.invoke('updater:fit', height),
  // „Was ist neu?“ nach dem ersten Start einer neuen Version (src/whats-new.js)
  whatsNew: () => ipcRenderer.invoke('update:whatsnew'),
  whatsNewSeen: () => ipcRenderer.invoke('update:whatsnew-seen'),
});

// Einstellungen (src/settings.js)
contextBridge.exposeInMainWorld('mysshSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: patch => ipcRenderer.invoke('settings:set', patch),
  onChanged: cb => ipcRenderer.on('settings:changed', (_e, values) => cb(values)),
});

// Mehrere Fenster, Tabs verschieben (app/lib/window-tabs.js, Oberfläche: src/windows.js)
contextBridge.exposeInMainWorld('s3windows', {
  newWindow: () => ipcRenderer.invoke('win:new'),
  list: () => ipcRenderer.invoke('win:list'),
  moveBegin: tabId => ipcRenderer.invoke('win:move-begin', tabId),
  moveAbort: tabId => ipcRenderer.invoke('win:move-abort', tabId),
  move: (payload, target) => ipcRenderer.invoke('win:move', payload, target),
  ready: () => ipcRenderer.invoke('win:ready'),
  adopted: tabId => ipcRenderer.invoke('win:adopted', tabId),
  dropTarget: () => ipcRenderer.invoke('win:drop-target'),
  onAdopt: cb => ipcRenderer.on('win:adopt', (_e, payload) => cb(payload)),
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

// Lesezeichen für Ordner (app/lib/bookmarks.js, src/file-nav.js)
contextBridge.exposeInMainWorld('s3bookmarks', {
  get: () => ipcRenderer.invoke('bookmarks:get'),
  set: (scope, key, list) => ipcRenderer.invoke('bookmarks:set', scope, key, list),
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

// Verbindungen-Pro: bekannte Server, Schlüssel, Proxy (app/lib/knownhosts.js, keyring.js, proxy.js; Oberfläche: src/conn-pro.js)
contextBridge.exposeInMainWorld('s3conn', {
  knownList: () => ipcRenderer.invoke('knownhosts:list'),
  knownMatch: query => ipcRenderer.invoke('knownhosts:match', query),
  knownRemove: (id, key) => ipcRenderer.invoke('knownhosts:remove', id, key),
  keysList: () => ipcRenderer.invoke('keyring:list'),
  keyCopy: file => ipcRenderer.invoke('keyring:copy', file),
  keyShow: file => ipcRenderer.invoke('keyring:show', file),
  keyGenerate: (name, passphrase, remember) => ipcRenderer.invoke('keyring:generate', name, passphrase, remember),
  keyInstall: (file, hostName) => ipcRenderer.invoke('keyring:install', file, hostName),
  proxyGet: () => ipcRenderer.invoke('proxy:get'),
  proxySet: (proxy, password) => ipcRenderer.invoke('proxy:set', proxy, password),
  proxyHasPassword: proxy => ipcRenderer.invoke('proxy:hasPassword', proxy),
  proxyForgetPassword: proxy => ipcRenderer.invoke('proxy:forgetPassword', proxy),
  proxyTest: (proxy, password, host, port) => ipcRenderer.invoke('proxy:test', proxy, password, host, port),
});

// Tresor für Zugangsdaten (app/lib/vault.js, Oberfläche: src/vault.js)
contextBridge.exposeInMainWorld('s3vault', {
  list: () => ipcRenderer.invoke('vault:list'),
  save: entry => ipcRenderer.invoke('vault:save', entry),
  remove: id => ipcRenderer.invoke('vault:delete', id),
  reveal: (id, kind) => ipcRenderer.invoke('vault:reveal', id, kind),
  copy: (id, kind) => ipcRenderer.invoke('vault:copy', id, kind),
  unlock: opts => ipcRenderer.invoke('vault:unlock', opts),
  setRequireUnlock: on => ipcRenderer.invoke('vault:require-unlock', on),
  generate: opts => ipcRenderer.invoke('vault:generate', opts),
});

// Sitzung wiederherstellen (app/lib/session.js, Oberfläche: src/session.js)
contextBridge.exposeInMainWorld('s3session', {
  take: () => ipcRenderer.invoke('session:take'),
  update: snapshot => ipcRenderer.send('session:update', snapshot),
});

// Backup & Umzug (app/lib/backup.js, Oberfläche: src/backup.js)
contextBridge.exposeInMainWorld('s3backup', {
  exportAll: opts => ipcRenderer.invoke('backup:export', opts),
  pick: () => ipcRenderer.invoke('backup:pick'),
  preview: (file, password) => ipcRenderer.invoke('backup:preview', file, password),
  apply: (token, opts) => ipcRenderer.invoke('backup:apply', token, opts),
  onChanged: cb => ipcRenderer.on('backup:changed', (_e, info) => cb(info)),
  // Abgleich über Cloud-Ordner (app/lib/sync.js)
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  syncPickFolder: () => ipcRenderer.invoke('sync:pick-folder'),
  syncEnable: opts => ipcRenderer.invoke('sync:enable', opts),
  syncDisable: () => ipcRenderer.invoke('sync:disable'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  syncSecrets: on => ipcRenderer.invoke('sync:secrets', on),
  onSyncStatus: cb => ipcRenderer.on('sync:status', (_e, st) => cb(st)),
});

// Synchronisieren, aktuell halten, extern bearbeiten, vergleichen (app/lib/sync.js, ext-edit.js, compare.js; Oberfläche: src/sync.js, src/ext-edit.js, src/compare.js)
contextBridge.exposeInMainWorld('s3sync', {
  compare: (tabId, opts) => ipcRenderer.invoke('sync:compare', tabId, opts),
  cancel: compareId => ipcRenderer.send('sync:cancel', compareId),
  run: (tabId, opts) => ipcRenderer.invoke('sync:run', tabId, opts),
  onProgress: cb => ipcRenderer.on('sync:progress', (_e, info) => cb(info)),
  watchStart: (tabId, opts) => ipcRenderer.invoke('watch:start', tabId, opts),
  watchStop: id => ipcRenderer.invoke('watch:stop', id),
  watchList: () => ipcRenderer.invoke('watch:list'),
  onWatch: cb => ipcRenderer.on('watch:status', (_e, list) => cb(list)),
  editors: () => ipcRenderer.invoke('extedit:editors'),
  pickApp: () => ipcRenderer.invoke('extedit:pick-app'),
  extOpen: (tabId, remote, opts) => ipcRenderer.invoke('extedit:open', tabId, remote, opts),
  extClose: id => ipcRenderer.invoke('extedit:close', id),
  extUpload: id => ipcRenderer.invoke('extedit:upload', id),
  extShow: id => ipcRenderer.invoke('extedit:show', id),
  extList: () => ipcRenderer.invoke('extedit:list'),
  onExt: cb => ipcRenderer.on('extedit:status', (_e, list) => cb(list)),
  onExtAsk: cb => ipcRenderer.on('extedit:ask', (_e, req) => cb(req)),
  extAnswer: (reqId, value) => ipcRenderer.send('extedit:answer', reqId, value),
  readLocal: file => ipcRenderer.invoke('compare:readLocal', file),
  pickLocal: defaultPath => ipcRenderer.invoke('compare:pickLocal', defaultPath),
});

// Server-Übersicht: Dienste, Docker, System (app/lib/dashboard.js, Oberfläche: src/dashboard.js)
contextBridge.exposeInMainWorld('s3dash', {
  probe: tabId => ipcRenderer.invoke('dash:probe', tabId),
  services: tabId => ipcRenderer.invoke('dash:services', tabId),
  serviceAction: (tabId, unit, action) => ipcRenderer.invoke('dash:serviceAction', tabId, unit, action),
  serviceLogs: (tabId, unit, lines) => ipcRenderer.invoke('dash:serviceLogs', tabId, unit, lines),
  containers: tabId => ipcRenderer.invoke('dash:containers', tabId),
  containerAction: (tabId, id, action) => ipcRenderer.invoke('dash:containerAction', tabId, id, action),
  containerLogs: (tabId, id, lines) => ipcRenderer.invoke('dash:containerLogs', tabId, id, lines),
  system: tabId => ipcRenderer.invoke('dash:system', tabId),
  bigDirs: (tabId, dir, useSudo) => ipcRenderer.invoke('dash:bigDirs', tabId, dir, useSudo),
  cancel: tabId => ipcRenderer.invoke('dash:cancel', tabId),
});

// Alle Server auf einen Blick (app/lib/server-watch.js, Oberfläche: src/server-watch.js)
// und Mitteilung „Befehl fertig“ (src/cmd-notify.js)
contextBridge.exposeInMainWorld('s3watch', {
  list: () => ipcRenderer.invoke('srvwatch:list'),
  check: names => ipcRenderer.invoke('srvwatch:check', names),
  onUpdate: cb => ipcRenderer.on('srvwatch:update', (_e, snap) => cb(snap)),
  onShow: cb => ipcRenderer.on('srvwatch:show', (_e, name) => cb(name)),
  notify: (title, body, tabId) => ipcRenderer.send('notify:show', { title, body, tabId }),
  onNotifyClick: cb => ipcRenderer.on('notify:clicked', (_e, tabId) => cb(tabId)),
});
