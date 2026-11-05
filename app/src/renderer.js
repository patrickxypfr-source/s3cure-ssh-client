// S3cure SSH Client – Oberfläche
const $ = sel => document.querySelector(sel);
const api = window.myssh;

// Mac oder Windows/Linux: Tastenkürzel und Texte passend
const IS_MAC = api.platform === 'darwin';
document.body.classList.add(IS_MAC ? 'mac' : 'win'); // Linux verhält sich wie Windows
if (api.platform === 'linux') document.body.classList.add('linux');
const modKey = e => (IS_MAC ? e.metaKey : e.ctrlKey);
const KEYS = IS_MAC
  ? { closeTab: 'Cmd+W', quick: 'Cmd+T', search: 'Cmd+F', up: 'Cmd+↑', del: 'Cmd+⌫' }
  : { closeTab: t('app.keyCtrlShift', { key: 'W' }), quick: t('app.keyCtrlShift', { key: 'T' }), search: t('app.keyCtrlShift', { key: 'F' }), up: 'Alt+↑', del: t('app.keyDel') };

let hosts = {};
const tabs = new Map(); // id -> { id, spec, title, term, fit, el, tabEl, state }
let activeId = null;

// Terminal-Farben passend zum hellen bzw. dunklen Neumorphism-Look
const TERM_THEMES = {
  light: {
    background: '#ffffff', foreground: '#18181b', cursor: '#e11d2a', cursorAccent: '#ffffff',
    selectionBackground: 'rgba(227,38,44,.2)',
    black: '#2f3136', red: '#d11f27', green: '#1f8f55', yellow: '#b7791f', blue: '#2f5bd3',
    magenta: '#a2389e', cyan: '#117e8e', white: '#787c86',
    brightBlack: '#858993', brightRed: '#e3262c', brightGreen: '#25a362', brightYellow: '#c98a2a',
    brightBlue: '#4470e6', brightMagenta: '#b94cb5', brightCyan: '#1693a5', brightWhite: '#17181b',
  },
  dark: {
    background: '#16161a', foreground: '#ededef', cursor: '#f0353f', cursorAccent: '#16161a',
    selectionBackground: 'rgba(255,59,65,.26)',
    black: '#18191b', red: '#ff5a60', green: '#5fd39a', yellow: '#f2c46d', blue: '#6f9bff',
    magenta: '#e07ad8', cyan: '#5fcfe0', white: '#c7c9cf',
    brightBlack: '#6c6f77', brightRed: '#ff7f84', brightGreen: '#7fe3b0', brightYellow: '#f8d48c',
    brightBlue: '#93b4ff', brightMagenta: '#ec9de6', brightCyan: '#86dfec', brightWhite: '#ffffff',
  },
};
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const termTheme = () => TERM_THEMES[darkQuery.matches ? 'dark' : 'light'];
darkQuery.addEventListener('change', () => { for (const t of tabs.values()) t.term.options.theme = termTheme(); });

applyIcons();

// ---------- Verbindungsliste ----------

async function refreshHosts() {
  hosts = await api.listHosts();
  renderHosts();
}

function renderHosts() {
  const list = $('#host-list');
  list.innerHTML = '';
  const names = Object.keys(hosts).sort((a, b) => a.localeCompare(b));
  $('#host-empty').hidden = names.length > 0;
  renderHostGroups(list, names, hostItem); // Suche, Gruppen, Farben: hosts-extra.js
}

function hostItem(name) {
  const h = hosts[name];
  const li = document.createElement('li');
  const connected = [...tabs.values()].some(t => t.spec.name === name && t.state === 'open');
  li.innerHTML = `
    <span class="host-avatar">${icon('server')}<span class="host-dot ${connected ? 'on' : ''}"></span></span>
    <div class="host-text"><div class="host-name"><span class="host-name-text"></span>${h.hasPassword || h.credentialName ? `<span class="pw-badge" title="${h.credentialName ? '' : t('host.pwSaved')}">${icon('lock')}</span>` : ''}</div><div class="host-addr"></div></div>
    <div class="host-actions">
      <button class="mini-btn" data-act="files" title="${t('host.openFiles')}">${icon('folder')}</button>
      <button class="mini-btn" data-act="edit" title="${t('common.edit')}">${icon('edit')}</button>
      <button class="mini-btn danger" data-act="delete" title="${t('common.delete')}">${icon('trash')}</button>
    </div>`;
  if (connected) li.classList.add('connected');
  li.querySelector('.host-name-text').textContent = name;
  if (h.credentialName) li.querySelector('.pw-badge').title = t('vault.hostBadge', { name: h.credentialName }); // Tresor: src/vault.js
  li.querySelector('.host-addr').textContent = `${h.user}@${h.host}${h.port !== 22 ? ':' + h.port : ''}`;
  li.title = t('host.dblClickConnect');
  li.addEventListener('dblclick', () => openTab({ name }, name));
  li.querySelector('[data-act=files]').addEventListener('click', e => { e.stopPropagation(); openTab({ name }, name, 'files'); });
  li.querySelector('[data-act=edit]').addEventListener('click', e => { e.stopPropagation(); editHost(name); });
  li.querySelector('[data-act=delete]').addEventListener('click', e => { e.stopPropagation(); deleteHost(name); });
  return li;
}

// ---------- Verbindung anlegen / bearbeiten ----------

let editingName = null;
let forgetPassword = false;

$('#forget-pw').addEventListener('click', () => {
  forgetPassword = true;
  const f = $('#host-form');
  f.password.value = '';
  f.password.placeholder = t('host.pwDeleteOnSave');
  $('#forget-pw').hidden = true;
});

function editHost(name) {
  editingName = name || null;
  const form = $('#host-form');
  form.reset();
  $('#host-form-title').textContent = t(name ? 'host.editTitle' : 'host.newTitle');
  if (name) {
    const h = hosts[name];
    form.label.value = name;
    form.host.value = h.host;
    form.port.value = h.port;
    form.user.value = h.user;
    form.key.value = h.key || '';
  }
  fillHostExtras(form, name); // Gruppe, Farbe, Sprung-Server: hosts-extra.js
  forgetPassword = false;
  const saved = !!(name && hosts[name].hasPassword);
  form.password.placeholder = t(saved ? 'host.pwSavedPh' : 'host.pwAskPh');
  $('#forget-pw').hidden = !saved;
  $('#host-modal').hidden = false;
  form.label.focus();
}

$('#host-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const name = f.label.value.trim();
  if (editingName !== name && hosts[name]) {
    const ok = await askLocal({ kind: 'confirm', title: t('host.nameTakenTitle'), message: t('host.nameTakenMsg', { name }), okLabel: t('host.overwrite') });
    if (!ok) return;
  }
  try {
    hosts = await api.saveHost(name, {
      host: f.host.value.trim(), port: f.port.value, user: f.user.value.trim(), key: f.key.value.trim(),
      password: f.password.value, forgetPassword, ...readHostExtras(f),
    }, editingName);
  } catch (err) { showError(err); return; }
  f.password.value = '';
  $('#host-modal').hidden = true;
  renderHosts();
});

$('#pick-key').addEventListener('click', async () => {
  const key = await api.pickKey();
  if (key) $('#host-form').key.value = key;
});

async function deleteHost(name) {
  const users = jumpUsers(name); // hosts-extra.js
  const ok = await askLocal({ kind: 'confirm', title: t('host.deleteTitle'), message: t('host.deleteMsg', { name }), okLabel: t('common.delete'), danger: true,
    detail: users.length ? t('host.deleteJumpUsers', { list: users.join(', ') }) : '' });
  if (!ok) return;
  hosts = await api.deleteHost(name);
  renderHosts();
}

$('#add-host').addEventListener('click', () => editHost());
$('#welcome-add').addEventListener('click', () => editHost());
document.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => { b.closest('.modal').hidden = true; }));

$('#quick').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('#quick-input').value.trim();
  if (!text) return;
  $('#quick-input').value = '';
  if (hosts[text]) openTab({ name: text }, text);
  else openTab({ text }, text);
});

// ---------- Tabs & Terminals ----------

// opts.connect: false = noch nicht verbinden; opts.restore: gemerkter Zustand (session.js);
// opts.id: Tab aus einem anderen Fenster übernehmen – gleiche ID, Verbindung besteht schon (windows.js)
function openTab(spec, title, view = 'terminal', opts = {}) {
  const id = opts.id || crypto.randomUUID();
  if (window.FtpUi?.isFtpSpec(spec)) view = 'files'; // FTP: nur Dateien (ftp-ui.js)
  const el = document.createElement('div');
  el.className = 'term';
  $('#terminals').appendChild(el);

  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, monospace', fontSize: 13, lineHeight: 1.15,
    cursorBlink: true, theme: termTheme(), scrollback: 10000, macOptionIsMeta: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData(d => { api.write(id, d); if (d === '\x03' && tabs.get(id)) tabs.get(id).lastQuick = null; });
  if (!IS_MAC) addWindowsClipboard(term, el);
  term.buffer.onBufferChange(() => { if (activeId === id) renderQuickbar(); });
  term.onResize(({ cols, rows }) => api.resize(id, cols, rows));

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = `<span class="state"></span><span class="title"></span><button class="close" title="${t('app.closeTab', { key: KEYS.closeTab })}">${icon('close')}</button>`;
  tabEl.querySelector('.title').textContent = title;
  tabEl.addEventListener('mousedown', e => { if (!e.target.classList.contains('close')) activate(id); });
  tabEl.querySelector('.close').addEventListener('click', () => closeTab(id));
  $('#tabs').appendChild(tabEl);

  const tab = { id, spec, title, term, fit, el, tabEl, state: 'connecting', view, restore: opts.restore || null };
  tab.files = buildFilesView(tab);
  tabs.set(id, tab);
  window.TermExtra?.attach(tab); // Suche, Links, geteilte Ansicht … (term-extra.js)
  window.LocalPane?.attach(tab); // „Mein Computer“ neben den Server-Dateien (local-pane.js)
  window.FileNav?.attachRemote(tab); // Verlauf zurück/vor und Lesezeichen (file-nav.js)
  window.FileColumns?.attach(tab); // Spalten: sortieren, ein-/ausblenden, Breiten (file-columns.js)
  window.SyncTools?.attach(tab); // Synchronisieren, aktuell halten, extern bearbeiten (sync.js)
  window.WindowTabs?.attach(tab); // Rechtsklick und Ziehen: in ein anderes Fenster (windows.js)
  window.CmdNotify?.attach(tab); // Mitteilung, wenn ein langer Befehl fertig ist (cmd-notify.js)
  activate(id);
  if (opts.connect !== false) connect(tab);
  return tab;
}

// opts.reconnect: automatischer neuer Versuch nach Verbindungsabbruch (reconnect.js) –
// Terminalinhalt bleibt stehen, Fehler werden nur kurz vermerkt
async function connect(tab, opts = {}) {
  setState(tab, opts.reconnect ? 'reconnecting' : 'connecting');
  if (!opts.reconnect) {
    tab.term.reset();
    if (!tab.spec.local) tab.term.write(TermStyle.line('info', t('app.connectingTo', { name: tab.title })));
  }
  try {
    const info = await api.connect(tab.id, tab.spec, tab.term.cols, tab.term.rows);
    if (!tabs.has(tab.id)) { api.close(tab.id); return false; } // Tab inzwischen geschlossen
    tab.info = info;
    setState(tab, 'open');
    if (tab.spec.name) refreshHosts(); // Schloss-Symbol, falls Passwort gerade gespeichert wurde
    if (tab.view === 'files' || tab.files.loaded) loadDir(tab, tab.files.path || '~');
    else if (tab.id === activeId) tab.term.focus();
    return true;
  } catch (err) {
    const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    if (opts.reconnect) { tab.term.write(TermStyle.line('info', msg)); return false; }
    tab.term.write('\r\n' + TermStyle.line('error', msg));
    setState(tab, 'closed');
    window.FtpUi?.connectFailed(tab, msg);
    return false;
  }
}

function setState(tab, state) {
  tab.state = state;
  tab.tabEl.querySelector('.state').className = 'state ' + state;
  if (tab.id === activeId) updateToolbar();
  renderHosts();
}

function updateToolbar() {
  const tab = tabs.get(activeId);
  // FTP und lokales Terminal: keine Server-Übersicht, keine Tunnel
  const sshTab = window.FtpUi?.isFtpTab(tab) || window.LocalTerm?.isLocalTab(tab) ? null : tab;
  Monitor.update(sshTab); // Server-Übersicht (monitor.js)
  $('#toolbar').hidden = !tab;
  window.tunnelUi?.setTab(sshTab || null);
  window.TermExtra?.update(tab);
  window.Dashboard?.update(tab); // Ansicht „Übersicht“ (dashboard.js)
  window.Desktop?.update(tab); // Ansicht „Desktop“ – Remote Desktop über VNC (vnc.js)
  if (!tab) return;
  const texts = {
    connecting: t('app.statusConnecting'),
    open: tab.info ? t('app.statusConnectedTo', { target: `${tab.info.user}@${tab.info.host}` }) : t('app.statusConnected'),
    closed: t('app.statusClosed'),
    reconnecting: t('app.statusReconnecting'),
  };
  $('#tab-status-text').textContent = texts[tab.state];
  $('#tab-status').className = tab.state;
  $('#btn-reconnect').hidden = tab.state !== 'closed' && tab.state !== 'reconnecting';
  for (const b of document.querySelectorAll('#view-switch button')) b.classList.toggle('on', b.dataset.view === tab.view);
  renderFiles(tab);
  renderQuickbar();
  window.FtpUi?.update(tab);
  window.LocalTerm?.update(tab); // lokales Terminal (local-term.js)
}

// ---------- Schnellbefehle ----------
// Die Knöpfe selbst kommen aus quickbar.js (eigene Knöpfe pro Verbindung, Vorlage „s3cure“)

const quickKey = tab => 'quick:' + (tab.spec.name || tab.spec.text || tab.title);
function quickPref(tab, key, fallback) {
  try { const v = localStorage.getItem(quickKey(tab) + ':' + key); return v === null ? fallback : v === '1'; } catch { return fallback; }
}
function setQuickPref(tab, key, value) {
  try { localStorage.setItem(quickKey(tab) + ':' + key, value ? '1' : '0'); } catch {}
}

function renderQuickbar() {
  const bar = $('#quickbar');
  const tab = tabs.get(activeId);
  const enabled = !!tab && quickPref(tab, 'show', true);
  $('#btn-quick').classList.toggle('on', enabled);
  $('#btn-quick').hidden = !tab;
  const editorOpen = !!tab && tab.state === 'open' && tab.term.buffer.active.type === 'alternate';
  bar.hidden = !tab || (!enabled && !editorOpen) || tab.view !== 'terminal';
  if (bar.hidden) return;

  const connected = tab.state === 'open';
  bar.innerHTML = '';
  bar.className = '';
  if (connected && tab.term.buffer.active.type === 'alternate') { renderEditorBar(tab, bar); return; }
  Quickbar.render(tab, bar, connected);
}

// Knöpfe für nano – damit niemand Tastenkürzel braucht
function renderEditorBar(tab, bar) {
  const send = data => { api.write(tab.id, data); tab.term.focus(); };
  const label = document.createElement('span');
  label.className = 'qlabel';
  label.textContent = t('app.editorOpen');
  bar.appendChild(label);
  const buttons = [
    [t('app.editorSaveClose'), 'primary', () => send('\x0f\r\x18'), t('app.editorSaveCloseTip')],
    [t('common.save'), '', () => send('\x0f\r'), t('app.editorSaveTip')],
    [t('app.editorDiscard'), 'danger', async () => {
      const ok = await askLocal({ kind: 'confirm', title: t('app.editorDiscardTitle'), message: t('app.editorDiscardMsg'), okLabel: t('app.editorDiscardOk'), danger: true });
      if (!ok) return;
      send('\x18');
      // Hat nano Änderungen, fragt es nach – dann mit „Nein“ antworten
      setTimeout(() => { if (tab.term.buffer.active.type === 'alternate') send('n'); }, 350);
    }, t('app.editorDiscardTip')],
  ];
  for (const [text, cls, fn, tip] of buttons) {
    const b = document.createElement('button');
    b.className = 'qbtn' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.title = tip;
    b.addEventListener('click', fn);
    bar.appendChild(b);
  }
  const hint = document.createElement('span');
  hint.className = 'qhint';
  hint.textContent = t(IS_MAC ? 'app.editorHintMac' : 'app.editorHintWin');
  bar.appendChild(hint);
}

// live: Befehl läuft endlos (Live-Log o. Ä.) und wird vor dem nächsten Knopf mit Strg+C beendet
async function runQuick(cmd, confirmText, live = Quickbar.isLive(cmd), label = '') {
  const tab = tabs.get(activeId);
  if (!tab || tab.state !== 'open') return;
  if (confirmText) {
    const ok = await askLocal({ kind: 'confirm', title: t('app.quickConfirmTitle'), message: confirmText, detail: cmd, okLabel: t('app.quickRun'), danger: true });
    if (!ok) return;
  }
  if (tab.view !== 'terminal') setView('terminal');
  // Läuft gerade nano, less o. Ä. (Vollbild), würde der Befehl dort hineingetippt
  if (tab.term.buffer.active.type === 'alternate') {
    showError(t('app.quickBusy'));
    return;
  }
  // Ein Live-Log läuft endlos -> vorher beenden
  if (tab.lastQuick && tab.lastQuickLive) {
    api.write(tab.id, '\x03');
    await new Promise(r => setTimeout(r, 300));
  }
  tab.lastQuick = cmd;
  tab.lastQuickLive = !!live;
  // Übersichtlich, ohne etwas zu löschen: Trennlinie mit Name und Uhrzeit, dann Befehl ausführen
  // (Strg+U leert eine halb getippte Zeile). Die Ausgabe davor bleibt zum Hochscrollen erhalten.
  tab.term.scrollToBottom();
  const kind = live ? 'live' : confirmText ? 'confirm' : 'run';
  window.CmdNotify?.beforeRun(tab, label || cmd, live); // Eingabezeile merken (cmd-notify.js)
  await new Promise(r => tab.term.write(TermStyle.separator(tab.term.cols, label || cmd, kind), r));
  api.write(tab.id, '\x15' + cmd + '\r');
  tab.term.focus();
}

$('#btn-quick').addEventListener('click', () => {
  const tab = tabs.get(activeId);
  if (!tab) return;
  setQuickPref(tab, 'show', !quickPref(tab, 'show', true));
  if (tab.view !== 'terminal') setView('terminal');
  renderQuickbar();
});

function activate(id) {
  activeId = id;
  for (const t of tabs.values()) {
    const active = t.id === id;
    t.el.style.visibility = active && t.view === 'terminal' ? 'visible' : 'hidden';
    t.files.el.hidden = !(active && t.view === 'files');
    t.tabEl.classList.toggle('active', active);
  }
  $('#welcome').hidden = tabs.size > 0;
  const tab = tabs.get(id);
  if (tab) {
    if (tab.view === 'terminal') { tab.fit.fit(); tab.term.focus(); }
    else tab.files.list.focus();
  }
  updateToolbar();
}

function setView(view) {
  const tab = tabs.get(activeId);
  if (!tab || tab.view === view) return;
  if (view === 'terminal' && window.FtpUi?.blockTerminal(tab)) return;
  if (view === 'desktop' && window.Desktop?.block(tab)) return; // FTP: kein Remote Desktop
  tab.view = view;
  if (view === 'files' && tab.state === 'open' && !tab.files.loaded) loadDir(tab, tab.files.path || '~');
  activate(tab.id);
}

for (const b of document.querySelectorAll('#view-switch button')) b.addEventListener('click', () => setView(b.dataset.view));

function closeTab(id, force = false) {
  const tab = tabs.get(id);
  if (!tab) return;
  // Ungespeicherte Änderungen im Editor (editor.js)?
  if (!force && Editor.isDirty(tab)) {
    if (activeId !== id) activate(id);
    if (tab.view !== 'files') setView('files');
    Editor.confirmDiscard(tab).then(ok => { if (ok) closeTab(id, true); });
    return;
  }
  api.close(id);
  disposeTab(tab);
}

// Tab aus der Oberfläche entfernen; die Verbindung schließt closeTab vorher (beim Verschieben
// in ein anderes Fenster bleibt sie bestehen, windows.js)
function disposeTab(tab) {
  const id = tab.id;
  window.TermExtra?.detach(tab);
  window.LocalPane?.detach(tab);
  window.FileColumns?.detach(tab);
  tab.files.nav?.detach();
  window.SyncTools?.detach(tab);
  window.Dashboard?.detach(tab);
  window.Desktop?.detach(tab);
  tab.term.dispose();
  tab.el.remove();
  tab.files.el.remove();
  tab.tabEl.remove();
  tabs.delete(id);
  const rest = [...tabs.keys()];
  activate(rest.length ? rest[rest.length - 1] : null);
  renderHosts();
}

api.onData((id, data) => tabs.get(id)?.term.write(data));
api.onHostsChanged?.(() => refreshHosts()); // in einem anderen Fenster geändert
api.onClosed(id => {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.term.write('\r\n' + TermStyle.line('end', t('app.connectionEnded')));
  setState(tab, 'closed');
});

new ResizeObserver(() => tabs.get(activeId)?.fit.fit()).observe($('#terminals'));

$('#btn-reconnect').addEventListener('click', () => { const t = tabs.get(activeId); if (t) reconnectNow(t); });

// Windows: Strg+C/V im Terminal wie bei Windows Terminal,
// App-Kürzel mit Strg+Umschalt, Rechtsklick kopiert bzw. fügt ein
function addWindowsClipboard(term, el) {
  const copy = () => { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); };
  const paste = () => navigator.clipboard.readText().then(t => { if (t) term.paste(t); });
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
    const k = e.key.toLowerCase();
    if (e.shiftKey && ['t', 'w', 'f', 'n'].includes(k)) return false;     // an die App weiterreichen
    if (k === 'c' && (e.shiftKey || term.hasSelection())) { e.preventDefault(); copy(); return false; }
    if (k === 'v') { e.preventDefault(); paste(); return false; }
    return true;                                                          // Strg+C ohne Markierung = Abbrechen
  });
  el.addEventListener('contextmenu', e => { e.preventDefault(); if (term.hasSelection()) copy(); else paste(); });
}

// Kürzel: schnell verbinden, Tab schließen, Suche
window.addEventListener('keydown', e => {
  if (!modKey(e) || !$('#host-modal').hidden || !$('#ask-modal').hidden) return;
  if (!IS_MAC && !e.shiftKey) return; // Windows: Strg+Umschalt+…
  const key = e.key.toLowerCase();
  if (key === 'w' && activeId) { e.preventDefault(); closeTab(activeId); }
  if (key === 't') { e.preventDefault(); $('#quick-input').focus(); }
  if (key === 'n') { e.preventDefault(); window.WindowTabs?.newWindow(); } // neues Fenster (windows.js)
  if (key === 'f' && activeId) {
    const tab = tabs.get(activeId);
    if (tab.state !== 'open') return;
    e.preventDefault();
    if (tab.view !== 'files') setView('files');
    tab.files.searchInput.focus();
    tab.files.searchInput.select();
  }
});

// ---------- Fehler & Fortschritt ----------

function showError(err) {
  if (FilesExtra.isCancel(err)) return; // vom Nutzer abgebrochen – kein Fehler
  const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  askLocal({ kind: 'info', title: t('common.error'), message: msg });
}

// ---------- Dateibrowser (SFTP) ----------

const joinPath = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;
const parentPath = p => (p === '/' ? '/' : p.replace(/\/[^/]*$/, '') || '/');
const localName = p => p.split(/[\\/]/).filter(Boolean).pop();

function formatSize(n) {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return n.toLocaleString(I18N.locale, { maximumFractionDigits: n < 10 ? 1 : 0 }) + ' ' + units[i];
}

function formatDate(ms) {
  // Englisch: kurzes Jahr („11/5/26, 9:41 AM“), damit es mit AM/PM in die Spalte passt
  const opts = I18N.lang === 'en'
    ? { day: 'numeric', month: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' };
  return new Date(ms).toLocaleString(I18N.locale, opts);
}

function buildFilesView(tab) {
  const el = document.createElement('div');
  el.className = 'files';
  el.hidden = true;
  el.innerHTML = `
    <div class="files-bar">
      <button class="round-btn" data-a="up" title="${t('app.filesUp', { key: KEYS.up })}">${icon('up')}</button>
      <button class="round-btn" data-a="home" title="${t('app.filesHome')}">${icon('home')}</button>
      <div class="field grow"><span class="field-icon">${icon('folder')}</span><input class="files-path" spellcheck="false" title="${t('app.filesPathTip')}"></div>
      <button class="round-btn" data-a="refresh" title="${t('app.filesRefresh')}">${icon('refresh')}</button>
      <div class="field search-field">
        <span class="field-icon">${icon('search')}</span>
        <input class="files-search" placeholder="${t('app.filesSearchPh')}" spellcheck="false" title="${t('app.filesSearchTip', { key: KEYS.search })}">
        <select class="search-scope" title="${t('app.filesScopeTip')}">
          <option value="root">${t('app.filesScopeRoot')}</option>
          <option value="here">${t('app.filesScopeHere')}</option>
        </select>
      </div>
    </div>
    <div class="files-actions">
      <button class="btn primary" data-a="upload">${icon('upload')}${t('app.filesUpload')}</button>
      <button class="btn" data-a="mkdir">${icon('folderPlus')}${t('app.filesMkdir')}</button>
      <span class="sep"></span>
      <button class="round-btn" data-a="download" title="${t('app.filesDownload')}">${icon('download')}</button>
      <button class="round-btn" data-a="rename" title="${t('common.rename')}">${icon('rename')}</button>
      <button class="round-btn danger" data-a="delete" title="${t('app.filesDeleteTip', { key: KEYS.del })}">${icon('trash')}</button>
    </div>
    <div class="files-list" tabindex="0">
      <table>
        <thead><tr><th class="name" data-col="name">${t('app.colName')}</th><th class="size" data-col="size">${t('app.colSize')}</th><th class="date" data-col="mtime">${t('app.colModified')}</th><th class="mode" data-col="mode">${t('app.colMode')}</th><th class="owner" data-col="owner">${t('app.colOwner')}</th><th class="group" data-col="group">${t('app.colGroup')}</th></tr></thead>
        <tbody></tbody>
      </table>
      <div class="files-empty"></div>
      <div class="drop-hint">${t('app.dropHint')}</div>
    </div>
    <div class="files-status"></div>
    <div class="search-view">
      <div class="search-head">
        <span class="spinner"></span>
        <span class="search-title"></span>
        <div class="spacer"></div>
        <button class="btn" data-a="search-stop">${t('app.searchStop')}</button>
        <button class="btn" data-a="search-close">${icon('close')}${t('app.searchClose')}</button>
      </div>
      <div class="search-list" tabindex="0">
        <table>
          <thead><tr><th>${t('app.colName')}</th><th>${t('app.colLocation')}</th></tr></thead>
          <tbody></tbody>
        </table>
        <div class="search-empty"></div>
      </div>
      <div class="search-foot">${t('app.searchFoot')}</div>
    </div>`;
  $('#terminals').appendChild(el);

  const f = {
    el, path: null, entries: [], selected: new Set(), anchor: null, loaded: false,
    list: el.querySelector('.files-list'), body: el.querySelector('tbody'), pathInput: el.querySelector('.files-path'),
  };
  const on = (a, fn) => el.querySelector(`[data-a=${a}]`).addEventListener('click', fn);
  on('up', () => f.path && loadDir(tab, parentPath(f.path)));
  on('home', () => loadDir(tab, '~'));
  on('refresh', () => loadDir(tab, f.path || '~'));
  on('upload', e => {
    if (IS_MAC) return uploadPicked(tab);
    const r = e.currentTarget.getBoundingClientRect();
    openMenu([
      [t('app.uploadFiles'), () => uploadPicked(tab, 'files'), '', 'file'],
      [t('app.uploadFolders'), () => uploadPicked(tab, 'folders'), '', 'folder'],
    ], r.left, r.bottom + 4);
  });
  on('mkdir', () => makeDir(tab));
  on('download', () => downloadItems(tab, selectedEntries(f)));
  on('rename', () => renameSelected(tab));
  on('delete', () => deleteSelected(tab));
  f.pathInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadDir(tab, f.pathInput.value.trim() || '~'); });

  // Suche
  f.searchInput = el.querySelector('.files-search');
  f.searchScope = el.querySelector('.search-scope');
  f.searchBody = el.querySelector('.search-view tbody');
  f.searchList = el.querySelector('.search-list');
  // Live-Suche: kurz nach der letzten Eingabe automatisch starten
  f.searchInput.addEventListener('input', () => scheduleSearch(tab));
  f.searchScope.addEventListener('change', () => { if (f.searchInput.value.trim()) scheduleSearch(tab, 0); f.searchInput.focus(); });
  f.searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      // Treffer vorhanden -> in die Liste springen, sonst sofort suchen
      if (tab.search?.results.length) { selectSearchRow(tab, 0); f.searchList.focus(); }
      else if (e.key === 'Enter') scheduleSearch(tab, 0);
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); f.searchInput.value = ''; closeSearch(tab); }
  });
  on('search-stop', () => api.searchCancel(tab.id));
  on('search-close', () => closeSearch(tab));
  f.searchList.addEventListener('keydown', e => {
    const s = tab.search;
    if (!s) return;
    if (e.key === 'Enter' && s.sel >= 0) { e.preventDefault(); openSearchResult(tab, s.results[s.sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(tab); }
    else if (e.key === 'ArrowUp' && s.sel <= 0) { e.preventDefault(); selectSearchRow(tab, -1); f.searchInput.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!s.results.length) return;
      const next = s.sel < 0 ? 0 : Math.max(0, Math.min(s.results.length - 1, s.sel + (e.key === 'ArrowDown' ? 1 : -1)));
      selectSearchRow(tab, next);
      f.searchBody.children[next]?.scrollIntoView({ block: 'nearest' });
    }
  });

  // Drag & Drop aus dem Finder (und aus „Mein Computer“, auch auf Ordner: local-pane.js)
  f.list.addEventListener('dragover', e => { e.preventDefault(); if (window.LocalPane?.serverDragOver(tab, e)) return; if (tab.state === 'open') f.list.classList.add('dragging'); });
  f.list.addEventListener('dragleave', e => { if (!f.list.contains(e.relatedTarget)) f.list.classList.remove('dragging'); });
  f.list.addEventListener('drop', e => {
    e.preventDefault();
    f.list.classList.remove('dragging');
    if (window.LocalPane?.serverDrop(tab, e)) return;
    const paths = [...e.dataTransfer.files].map(file => api.pathForFile(file)).filter(Boolean);
    if (paths.length && tab.state === 'open') uploadPaths(tab, paths);
  });

  // Klick ins Leere hebt die Auswahl auf
  f.list.addEventListener('mousedown', e => {
    if (modKey(e) || e.shiftKey) return; // Auswahl bleibt, Rahmen ergänzt sie (lasso.js)
    if (!e.target.closest('tr') || e.target.closest('thead')) { f.selected.clear(); updateSelection(tab); }
  });
  // Rahmen-Auswahl mit der Maus
  Lasso.attach({ list: f.list, body: f.body, getSelected: () => f.selected, setSelected: sel => { f.selected = sel; updateSelection(tab); } });

  // Tastatur
  f.list.addEventListener('keydown', e => {
    const items = visibleEntries(f);
    if (e.key === 'Enter') { e.preventDefault(); const s = selectedEntries(f); if (s.length === 1) openEntry(tab, s[0]); }
    else if ((e.key === 'Backspace' && e.metaKey) || e.key === 'Delete') { e.preventDefault(); deleteSelected(tab); }
    else if (e.key === 'ArrowUp' && (IS_MAC ? e.metaKey : e.altKey)) { e.preventDefault(); loadDir(tab, parentPath(f.path)); }
    else if (e.key === 'Backspace' && !IS_MAC) { e.preventDefault(); loadDir(tab, parentPath(f.path)); }
    else if (e.key.toLowerCase() === 'a' && modKey(e)) { e.preventDefault(); items.forEach(x => f.selected.add(x.name)); updateSelection(tab); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      const idx = items.findIndex(x => x.name === f.anchor);
      const next = idx < 0 ? 0 : Math.max(0, Math.min(items.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      f.selected = new Set([items[next].name]);
      f.anchor = items[next].name;
      updateSelection(tab);
      f.body.querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' });
    }
  });
  return f;
}

// Es werden immer alle Dateien angezeigt, auch versteckte (mit Punkt am Anfang).
// Reihenfolge: gewählte Sortierung (file-columns.js)
function visibleEntries(f) {
  return window.FileColumns ? FileColumns.sorted(f) : f.entries;
}

function selectedEntries(f) {
  return f.entries.filter(e => f.selected.has(e.name));
}

function renderFiles(tab) {
  const f = tab.files;
  if (!f) return;
  const connected = tab.state === 'open';
  if (document.activeElement !== f.pathInput) f.pathInput.value = f.path || '';
  const items = visibleEntries(f);

  f.body.innerHTML = '';
  for (const it of items) {
    const tr = document.createElement('tr');
    tr.dataset.name = it.name;
    tr.innerHTML = '<td class="name"><span class="ico"></span><span class="n"></span></td><td class="size"></td><td class="date"></td><td class="mode"></td><td class="owner"></td><td class="group"></td>';
    tr.querySelector('.ico').innerHTML = icon(it.isDir ? 'folder' : it.isLink ? 'link' : 'file');
    tr.querySelector('.ico').classList.add(it.isDir ? 'dir' : 'doc');
    tr.querySelector('.n').textContent = it.name;
    tr.querySelector('.size').textContent = it.isDir ? '–' : formatSize(it.size);
    tr.querySelector('.date').textContent = formatDate(it.mtime);
    tr.querySelector('.mode').textContent = it.mode;
    tr.querySelector('.owner').textContent = it.owner ?? '';
    tr.querySelector('.group').textContent = it.group ?? '';
    if (it.uid != null) { tr.querySelector('.owner').title = `UID ${it.uid}`; tr.querySelector('.group').title = `GID ${it.gid}`; }
    tr.addEventListener('mousedown', e => { if (e.button === 0) selectRow(tab, it.name, e); });
    tr.addEventListener('dblclick', () => openEntry(tab, it));
    tr.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!f.selected.has(it.name)) { f.selected = new Set([it.name]); f.anchor = it.name; updateSelection(tab); }
      showContextMenu(tab, e.clientX, e.clientY);
    });
    f.body.appendChild(tr);
  }

  const empty = f.el.querySelector('.files-empty');
  empty.textContent = tab.state === 'reconnecting' ? t('app.statusReconnecting')
    : !connected ? t('app.filesNotConnected')
    : !f.loaded ? t('app.filesLoading')
    : items.length ? '' : t('app.filesEmpty');
  empty.hidden = !empty.textContent;
  updateSelection(tab);
}

// Nur Markierung, Knöpfe und Statuszeile aktualisieren – die Zeilen bleiben stehen,
// sonst erkennt macOS den zweiten Klick eines Doppelklicks nicht.
function updateSelection(tab) {
  const f = tab.files;
  if (!f) return;
  const connected = tab.state === 'open';
  for (const tr of f.body.children) tr.classList.toggle('sel', f.selected.has(tr.dataset.name));
  const items = visibleEntries(f);
  const n = f.selected.size;
  const dis = (a, v) => { f.el.querySelector(`[data-a=${a}]`).disabled = v; };
  for (const a of ['up', 'home', 'refresh', 'upload', 'mkdir']) dis(a, !connected);
  dis('download', !connected || n === 0);
  dis('rename', !connected || n !== 1);
  dis('delete', !connected || n === 0);
  f.pathInput.disabled = !connected;

  f.el.querySelector('.files-status').textContent = connected && f.loaded
    ? `${t('app.filesCount', { count: items.length })}${n ? ` · ${t('app.filesSelected', { count: n })}` : ''}${items.length > 1 && window.LocalPane?.isOpen?.(tab) ? Lasso.hint(n) : ''}`
    : '';
}

function selectRow(tab, name, e) {
  const f = tab.files;
  if (modKey(e)) {
    if (f.selected.has(name)) f.selected.delete(name); else f.selected.add(name);
    f.anchor = name;
  } else if (e.shiftKey && f.anchor) {
    const items = visibleEntries(f).map(x => x.name);
    const [a, b] = [items.indexOf(f.anchor), items.indexOf(name)].sort((x, y) => x - y);
    f.selected = new Set(items.slice(a, b + 1));
  } else {
    f.selected = new Set([name]);
    f.anchor = name;
  }
  updateSelection(tab);
}

async function loadDir(tab, dir) {
  const f = tab.files;
  try {
    const r = await api.sftpList(tab.id, dir);
    f.path = r.path;
    f.entries = r.entries;
    f.selected.clear();
    f.anchor = null;
    f.loaded = true;
    f.nav?.visited(f.path); // Verlauf (file-nav.js)
  } catch (err) {
    // Wiederhergestellter Ordner gibt es nicht mehr (session.js): still zum Benutzerordner
    if (f.restoring && dir !== '~') { f.restoring = false; f.path = null; return loadDir(tab, '~'); }
    showError(err);
  }
  f.restoring = false;
  renderFiles(tab);
}

function openEntry(tab, it) {
  if (it.isDir) loadDir(tab, joinPath(tab.files.path, it.name));
  else FilesExtra.openFile(tab, it); // Editor, Vorschau oder Herunterladen (files-extra.js)
}

async function uploadPicked(tab, kind) {
  const paths = await api.pickUpload(kind);
  if (paths) uploadPaths(tab, paths);
}

async function uploadPaths(tab, paths) {
  const f = tab.files;
  const dir = f.path;
  const clashes = paths.map(localName).filter(n => f.entries.some(e => e.name === n));
  if (clashes.length) {
    const ok = await askLocal({
      kind: 'confirm', title: t('app.clashTitle'),
      message: clashes.length === 1 ? t('app.clashOne', { name: clashes[0] }) : t('app.clashMany', { count: clashes.length }),
      okLabel: t('host.overwrite'), danger: true,
    });
    if (!ok) return;
  }
  try {
    await api.sftpUpload(tab.id, dir, paths);
    flash(paths.length === 1 ? t('app.uploadedOne', { name: localName(paths[0]) }) : t('app.uploadedMany', { count: paths.length }));
  } catch (err) { showError(err); }
  if (tab.files.path === dir) loadDir(tab, dir);
}

async function downloadItems(tab, items) {
  if (!items.length) return;
  try {
    const targets = await api.sftpDownload(tab.id, items.map(it => ({ path: joinPath(tab.files.path, it.name), isDir: it.isDir })));
    if (targets) { flash(items.length === 1 ? t('app.downloadedOne', { name: items[0].name }) : t('app.downloadedMany', { count: items.length })); api.showFile(targets[0]); }
  } catch (err) { showError(err); }
}

async function makeDir(tab) {
  const name = await askLocal({ kind: 'text', title: t('app.filesMkdir'), message: t('app.mkdirMsg'), placeholder: t('app.mkdirPh') });
  if (!name || !name.trim()) return;
  try { await api.sftpMkdir(tab.id, joinPath(tab.files.path, name.trim())); } catch (err) { showError(err); }
  loadDir(tab, tab.files.path);
}

async function renameSelected(tab) {
  const [it] = selectedEntries(tab.files);
  if (!it) return;
  const name = await askLocal({ kind: 'text', title: t('common.rename'), message: t('app.renameMsg', { name: it.name }), value: it.name, okLabel: t('common.rename') });
  if (!name || !name.trim() || name.trim() === it.name) return;
  const dir = tab.files.path;
  try { await api.sftpRename(tab.id, joinPath(dir, it.name), joinPath(dir, name.trim())); } catch (err) { showError(err); }
  loadDir(tab, dir);
}

async function deleteSelected(tab) {
  const items = selectedEntries(tab.files);
  if (!items.length || tab.state !== 'open') return;
  const hasDir = items.some(i => i.isDir);
  const names = items.slice(0, 8).map(i => i.name + (i.isDir ? '/' : '')).join('\n') + (items.length > 8 ? '\n' + t('app.deleteMore', { count: items.length - 8 }) : '');
  const ok = await askLocal({
    kind: 'confirm', title: t('app.deleteTitle'),
    message: `${items.length === 1 ? t('app.deleteMsgOne') : t('app.deleteMsgMany', { count: items.length })}${hasDir ? ' ' + t('app.deleteDirNote') : ''} ${t('app.deleteUndo')}`,
    detail: names, okLabel: t('common.delete'), danger: true,
  });
  if (!ok) return;
  const dir = tab.files.path;
  try { await api.sftpDelete(tab.id, items.map(i => joinPath(dir, i.name))); flash(t('app.deleted', { count: items.length })); }
  catch (err) { showError(err); }
  loadDir(tab, dir);
}

// ---------- Suche ----------

const SEARCH_DELAY = 350; // ms Pause nach dem Tippen
let searchCounter = 0;

function minQueryLength(tab) {
  // Ganzer Server erst ab 2 Zeichen, sonst würde jeder Buchstabe alles durchsuchen
  return tab.files.searchScope.value === 'here' ? 1 : 2;
}

function scheduleSearch(tab, delay = SEARCH_DELAY) {
  const f = tab.files;
  clearTimeout(f.searchTimer);
  const query = f.searchInput.value.trim();
  if (!query) { closeSearch(tab, true); return; }
  if (query.length < minQueryLength(tab)) {
    // Noch zu kurz: laufende Suche stoppen, Hinweis zeigen
    if (tab.search?.running) api.searchCancel(tab.id);
    tab.search = { id: null, query, root: '/', results: [], sel: -1, running: false, info: { tooShort: true } };
    f.searchBody.innerHTML = '';
    f.el.classList.add('searching');
    renderSearchHead(tab);
    return;
  }
  f.searchTimer = setTimeout(() => startSearch(tab), delay);
}

function startSearch(tab) {
  const f = tab.files;
  const query = f.searchInput.value.trim();
  if (!query || tab.state !== 'open') return;
  if (tab.search && tab.search.query === query && tab.search.scope === f.searchScope.value && tab.search.running) return;
  const root = f.searchScope.value === 'here' && f.path ? f.path : '/';
  const id = ++searchCounter;
  tab.search = { id, query, root, scope: f.searchScope.value, results: [], sel: -1, running: true, info: null };
  f.searchBody.innerHTML = '';
  f.el.classList.add('searching');
  renderSearchHead(tab);
  api.searchStart(tab.id, root, query, id).catch(err => {
    if (tab.search?.id !== id) return;
    tab.search.running = false;
    tab.search.info = { error: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
    renderSearchHead(tab);
  });
}

function closeSearch(tab, keepFocus = false) {
  const f = tab.files;
  clearTimeout(f.searchTimer);
  if (tab.search?.running) api.searchCancel(tab.id);
  tab.search = null;
  f.el.classList.remove('searching');
  f.searchBody.innerHTML = '';
  if (!keepFocus) f.list.focus();
}

function renderSearchHead(tab) {
  const s = tab.search;
  const f = tab.files;
  if (!s) return;
  const where = s.root === '/' ? t('app.searchWhereRoot') : t('app.searchWhereDir', { dir: s.root });
  const n = s.results.length;
  let text;
  const p = { query: s.query, where, count: n };
  if (s.info?.tooShort) text = t('app.searchTooShort');
  else if (s.running) text = t('app.searchRunning', p);
  else if (s.info?.error) text = t('app.searchFailed', { error: s.info.error });
  else if (s.info?.cancelled) text = t('app.searchStopped', p);
  else text = t('app.searchDone', p) + (s.info?.limited ? ' ' + t('app.searchLimited') : '');
  f.el.querySelector('.search-title').textContent = text;
  f.el.querySelector('.spinner').hidden = !s.running;
  f.el.querySelector('[data-a=search-stop]').hidden = !s.running;
  const empty = f.el.querySelector('.search-empty');
  empty.textContent = n || s.info?.tooShort ? '' : s.running ? t('app.searchBusy') : t('app.searchNothing');
  empty.hidden = !empty.textContent;
}

// Name mit hervorgehobenem Suchbegriff
function highlightName(el, name, query) {
  const i = /[*?[]/.test(query) ? -1 : name.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) { el.textContent = name; return; }
  const mark = document.createElement('mark');
  mark.textContent = name.slice(i, i + query.length);
  el.append(name.slice(0, i), mark, name.slice(i + query.length));
}

function addSearchResults(tab, results) {
  const s = tab.search;
  const f = tab.files;
  for (const r of results) {
    const idx = s.results.length;
    s.results.push(r);
    const name = r.path.split('/').pop() || '/';
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="name"><span class="ico"></span><span class="n"></span></td><td class="loc"></td>';
    tr.querySelector('.ico').innerHTML = icon(r.isDir ? 'folder' : 'file');
    tr.querySelector('.ico').classList.add(r.isDir ? 'dir' : 'doc');
    highlightName(tr.querySelector('.n'), name, s.query);
    tr.querySelector('.loc').textContent = parentPath(r.path);
    tr.title = r.path;
    tr.addEventListener('mousedown', e => { if (e.button === 0) selectSearchRow(tab, idx); });
    tr.addEventListener('dblclick', () => openSearchResult(tab, r));
    tr.addEventListener('contextmenu', e => {
      e.preventDefault();
      selectSearchRow(tab, idx);
      openMenu([
        [t(r.isDir ? 'app.openFolder' : 'app.showInFolder'), () => openSearchResult(tab, r), '', 'folder'],
        [t('app.filesDownload'), () => downloadPaths(tab, [r]), '', 'download'],
        [t('app.copyPath'), () => navigator.clipboard.writeText(r.path), '', 'link'],
      ], e.clientX, e.clientY);
    });
    f.searchBody.appendChild(tr);
  }
  renderSearchHead(tab);
}

function selectSearchRow(tab, idx) {
  tab.search.sel = idx;
  [...tab.files.searchBody.children].forEach((tr, i) => tr.classList.toggle('sel', i === idx));
}

async function openSearchResult(tab, r) {
  tab.files.searchInput.value = '';
  closeSearch(tab);
  if (r.isDir) { await loadDir(tab, r.path); return; }
  const name = r.path.split('/').pop();
  await loadDir(tab, parentPath(r.path));
  const f = tab.files;
  f.selected = new Set([name]);
  f.anchor = name;
  updateSelection(tab);
  f.body.querySelector('tr.sel')?.scrollIntoView({ block: 'center' });
  f.list.focus();
}

async function downloadPaths(tab, items) {
  try {
    const targets = await api.sftpDownload(tab.id, items.map(r => ({ path: r.path, isDir: r.isDir })));
    if (targets) { flash(t('app.downloadedOne', { name: items[0].path.split('/').pop() })); api.showFile(targets[0]); }
  } catch (err) { showError(err); }
}

api.onSearchResults((id, searchId, results) => { const t = tabs.get(id); if (t?.search?.id === searchId) addSearchResults(t, results); });
api.onSearchDone((id, searchId, info) => {
  const t = tabs.get(id);
  if (t?.search?.id !== searchId) return;
  t.search.running = false;
  t.search.info = info;
  renderSearchHead(t);
});

// Rechtsklick-Menü
function showContextMenu(tab, x, y) {
  const sel = selectedEntries(tab.files);
  const entries = [];
  if (sel.length === 1 && sel[0].isDir) entries.push([t('common.open'), () => openEntry(tab, sel[0]), '', 'folder']);
  entries.push([t('app.filesDownload'), () => downloadItems(tab, sel), '', 'download']);
  if (sel.length === 1) entries.push([t('common.rename'), () => renameSelected(tab), '', 'rename']);
  FilesExtra.addMenuEntries(tab, sel, entries); // files-extra.js
  window.SyncTools?.addMenuEntries(tab, sel, entries); // extern bearbeiten, vergleichen (sync.js)
  entries.push(null);
  entries.push([t('common.delete'), () => deleteSelected(tab), 'danger', 'trash']);
  openMenu(entries, x, y);
}

// entries: [Text, Aktion, Klasse, Icon] oder null für Trennlinie
function openMenu(entries, x, y) {
  const menu = $('#ctx-menu');
  menu.innerHTML = '';
  for (const e of entries) {
    if (!e) { menu.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' })); continue; }
    const b = document.createElement('button');
    b.innerHTML = icon(e[3]);
    b.append(e[0]);
    if (e[2]) b.className = e[2];
    b.addEventListener('click', () => { hideContextMenu(); e[1](); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}

function hideContextMenu() { $('#ctx-menu').hidden = true; }
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx-menu')) hideContextMenu(); });
window.addEventListener('blur', hideContextMenu);

// Dateien, die neben die Liste fallen, sollen nicht das Fenster ersetzen
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());

let flashTimer;
function flash(text, pct = 100) {
  $('#progress').hidden = false;
  $('#progress-label').textContent = text;
  $('#progress-fill').style.width = pct + '%';
  clearTimeout(flashTimer);
  if (pct >= 100) flashTimer = setTimeout(() => { $('#progress').hidden = true; }, 4000);
}

// ---------- Dialoge ----------

const askQueue = [];
let askBusy = false;

function askLocal(req) {
  return new Promise(resolve => {
    askQueue.push({ req, resolve });
    if (!askBusy) nextAsk();
  });
}

function nextAsk() {
  const item = askQueue.shift();
  if (!item) { askBusy = false; tabs.get(activeId)?.term.focus(); return; }
  askBusy = true;
  const { req, resolve } = item;
  const input = $('#ask-input');
  $('#ask-title').textContent = req.title || '';
  $('#ask-message').textContent = req.message || '';
  $('#ask-detail').textContent = req.detail || '';
  $('#ask-detail').hidden = !req.detail;
  input.hidden = !(req.kind === 'secret' || req.kind === 'text');
  input.type = req.kind === 'secret' ? 'password' : 'text';
  input.value = req.value || '';
  input.placeholder = req.placeholder || '';
  $('#ask-cancel').hidden = req.kind === 'info';
  $('#ask-remember-wrap').hidden = !req.remember;
  $('#ask-remember').checked = true;
  $('#ask-remember-text').textContent = req.rememberLabel || t('ask.remember');
  $('#ask-ok').textContent = req.okLabel || t('common.ok');
  $('#ask-ok').className = 'btn ' + (req.danger ? 'danger' : 'primary');
  $('#ask-modal').hidden = false;
  // focusCancel: bei riskanten Fragen ist „Abbrechen“ vorausgewählt (Enter bricht ab)
  (input.hidden ? $(req.focusCancel ? '#ask-cancel' : '#ask-ok') : input).focus();

  const finish = value => {
    $('#ask-modal').hidden = true;
    $('#ask-form').onsubmit = null;
    $('#ask-cancel').onclick = null;
    resolve(value);
    nextAsk();
  };
  $('#ask-form').onsubmit = e => {
    e.preventDefault();
    if (input.hidden) finish(true);
    else if (req.remember) finish({ value: input.value, remember: $('#ask-remember').checked });
    else finish(input.value);
  };
  $('#ask-cancel').onclick = () => finish(req.kind === 'confirm' ? false : null);
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#ctx-menu').hidden) hideContextMenu();
  else if (!$('#ask-modal').hidden) $('#ask-cancel').click();
  else if (!$('#host-modal').hidden) $('#host-modal').hidden = true;
});

// Fragen vom Hauptprozess (Passwort, Host-Key)
api.onAsk(async req => api.answer(req.reqId, await askLocal(req)));

// Erst laden, wenn auch die Zusatz-Skripte (hosts-extra.js, …) bereit sind
window.addEventListener('DOMContentLoaded', () => refreshHosts());
activate(null);
