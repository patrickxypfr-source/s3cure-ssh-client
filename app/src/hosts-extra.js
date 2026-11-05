// Verbindungsliste: Suche, Gruppen (einklappbar), Farben (auch am Tab), Sprung-Server,
// Import aus ~/.ssh/config und „Anmeldung ohne Passwort einrichten“ (SSH-Schlüssel).
// Nutzt aus renderer.js: hosts, tabs, api, $, icon, askLocal, showError, flash, refreshHosts,
// renderHosts, openTab, editHost, deleteHost, openMenu.

const HOST_COLORS = {
  red: [t('hostsExtra.colorRed'), '#e5484d'], orange: [t('hostsExtra.colorOrange'), '#f76b15'], yellow: [t('hostsExtra.colorYellow'), '#e2a336'],
  green: [t('hostsExtra.colorGreen'), '#30a46c'], teal: [t('hostsExtra.colorTeal'), '#12a594'], blue: [t('hostsExtra.colorBlue'), '#3e63dd'],
  purple: [t('hostsExtra.colorPurple'), '#8e4ec6'], pink: [t('hostsExtra.colorPink'), '#d6409f'], gray: [t('hostsExtra.colorGray'), '#8b8d98'],
};
const hostColor = name => (hosts[name] && HOST_COLORS[hosts[name].color] || [])[1] || null;

// ---------- Eingeklappte Gruppen merken ----------

const GROUPS_KEY = 'hosts:collapsedGroups';
let collapsedGroups;
try { collapsedGroups = new Set(JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]')); } catch { collapsedGroups = new Set(); }
function toggleGroup(g) {
  if (collapsedGroups.has(g)) collapsedGroups.delete(g); else collapsedGroups.add(g);
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify([...collapsedGroups])); } catch {}
  renderHosts();
}

// ---------- Liste ----------

function renderHostGroups(list, names, makeItem) {
  const q = $('#host-search').value.trim().toLowerCase();
  $('#host-search-wrap').hidden = names.length === 0;
  const matches = n => {
    if (!q) return true;
    const h = hosts[n];
    return [n, h.host, h.user, h.group || ''].some(s => String(s).toLowerCase().includes(q));
  };
  const groups = new Map(); // '' = ohne Gruppe
  for (const n of names.filter(matches)) {
    const g = hosts[n].group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(n);
  }
  for (const n of groups.get('') || []) list.appendChild(decorateHostItem(makeItem(n), n));
  const groupNames = [...groups.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, I18N.locale, { sensitivity: 'base' }));
  for (const g of groupNames) {
    const closed = !q && collapsedGroups.has(g); // beim Suchen alles aufklappen
    const head = document.createElement('li');
    head.className = 'host-group' + (closed ? ' closed' : '');
    head.innerHTML = `${icon('down')}<span class="g-name"></span><span class="g-count"></span>`;
    head.querySelector('.g-name').textContent = g;
    head.querySelector('.g-count').textContent = groups.get(g).length;
    head.title = closed ? t('hostsExtra.expand') : t('hostsExtra.collapse');
    head.addEventListener('click', () => toggleGroup(g));
    list.appendChild(head);
    if (!closed) for (const n of groups.get(g)) list.appendChild(decorateHostItem(makeItem(n), n, true));
  }
  if (q && !groups.size) {
    const li = document.createElement('li');
    li.className = 'host-nohit';
    li.textContent = t('hostsExtra.noHits');
    list.appendChild(li);
  }
  decorateTabs();
}

function decorateHostItem(li, name, inGroup = false) {
  const h = hosts[name];
  const color = hostColor(name);
  if (color) { li.classList.add('has-color'); li.style.setProperty('--host-color', color); }
  if (inGroup) li.classList.add('in-group');
  window.FtpUi?.decorateHost(li, name); // FTP/FTPS-Kennzeichen (ftp-ui.js)
  const ftp = !!window.FtpUi?.isFtpHost(name);
  if (h.jump && !ftp) {
    const addr = li.querySelector('.host-addr');
    addr.textContent += ` · ${t('hostsExtra.via', { jump: h.jump })}`;
    li.title += '\n' + t('hostsExtra.viaJumpTitle', { jump: h.jump });
  }
  li.addEventListener('contextmenu', e => {
    e.preventDefault();
    openMenu([
      ...(ftp ? [] : [[t('hostsExtra.openTerminal'), () => openTab({ name }, name), '', 'terminal']]),
      [t('hostsExtra.openFiles'), () => openTab({ name }, name, 'files'), '', 'folder'],
      null,
      [t('common.edit'), () => editHost(name), '', 'edit'],
      ...(ftp ? [] : [[t('hostsExtra.setupKeyMenu'), () => setupKeyLogin(name), '', 'lock']]),
      null,
      [t('common.delete'), () => deleteHost(name), 'danger', 'trash'],
    ], e.clientX, e.clientY);
  });
  return li;
}

// Farbiger Punkt am Tab
function decorateTabs() {
  for (const tab of tabs.values()) {
    let dot = tab.tabEl.querySelector('.tab-color');
    const color = tab.spec.name ? hostColor(tab.spec.name) : null;
    if (!color) { if (dot) dot.remove(); continue; }
    if (!dot) {
      dot = Object.assign(document.createElement('span'), { className: 'tab-color' });
      tab.tabEl.querySelector('.title').before(dot);
    }
    dot.style.background = color;
  }
}

$('#host-search').addEventListener('input', () => renderHosts());
$('#host-search').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); e.target.value = ''; renderHosts(); e.target.blur(); }
  if (e.key === 'Enter') { // Enter: einzigen bzw. ersten Treffer öffnen
    const first = $('#host-list li .host-name-text');
    if (first) openTab({ name: first.textContent }, first.textContent);
  }
});

// ---------- Host-Dialog: Gruppe, Farbe, Sprung-Server ----------

// Weitere Felder im Host-Dialog: hostFormHooks.push({ fill(form, name), read(form) => {…} }) (z. B. src/conn-pro.js)
const hostFormHooks = [];

let pickedColor = '';

function renderColorPick() {
  const box = $('#color-pick');
  box.innerHTML = '';
  for (const [key, [label, hex]] of [['', [t('hostsExtra.colorNone'), '']], ...Object.entries(HOST_COLORS)]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (key === pickedColor ? ' on' : '') + (key ? '' : ' none');
    b.title = label;
    if (hex) b.style.background = hex;
    b.addEventListener('click', () => { pickedColor = key; renderColorPick(); });
    box.appendChild(b);
  }
}

function fillHostExtras(form, name) {
  const h = (name && hosts[name]) || {};
  form.group.value = h.group || '';
  const groups = [...new Set(Object.values(hosts).map(x => x.group).filter(Boolean))].sort();
  $('#group-list').innerHTML = '';
  for (const g of groups) $('#group-list').appendChild(Object.assign(document.createElement('option'), { value: g }));

  const sel = form.jump;
  sel.innerHTML = '';
  sel.appendChild(new Option(t('hostsExtra.jumpNone'), ''));
  const others = Object.keys(hosts).filter(n => n !== name && !window.FtpUi?.isFtpHost(n)).sort((a, b) => a.localeCompare(b));
  for (const n of others) sel.appendChild(new Option(`${n} (${hosts[n].host})`, n));
  if (h.jump && !others.includes(h.jump)) sel.appendChild(new Option(h.jump, h.jump)); // z. B. aus ~/.ssh/config
  sel.value = h.jump || '';

  pickedColor = h.color || '';
  renderColorPick();
  $('#setup-key').hidden = !name;
  for (const h of hostFormHooks) h.fill?.(form, name, h);
  window.FtpUi?.fillForm(form, h); // Protokoll, FTP-Optionen (ftp-ui.js)
}

function readHostExtras(form) {
  const out = { group: form.group.value.trim(), color: pickedColor, jump: form.jump.value, ...window.FtpUi?.readForm(form) };
  for (const h of hostFormHooks) Object.assign(out, h.read?.(form) || {});
  return out;
}

// Hinweis beim Löschen, wenn andere Verbindungen diese als Sprung-Server nutzen
function jumpUsers(name) {
  return Object.keys(hosts).filter(n => (hosts[n].jump || '').split(',').map(s => s.trim()).includes(name));
}

$('#setup-key').addEventListener('click', () => { if (editingName) setupKeyLogin(editingName); });

// ---------- Import aus ~/.ssh/config ----------

$('#import-hosts').addEventListener('click', async () => {
  let plan;
  try { plan = await api.sshConfigScan(); } catch (err) { showError(err); return; }
  const addr = e => `${e.user}@${e.host}${e.port !== 22 ? ':' + e.port : ''}${e.jump ? ' ' + t('hostsExtra.via', { jump: e.jump }) : ''}`;
  const skipped = plan.skip.map(s => `–  ${s.name}: ${s.reason}`).join('\n');
  if (!plan.add.length) {
    askLocal({ kind: 'info', title: t('hostsExtra.importNothingTitle'), message: t('hostsExtra.importNothing'), detail: skipped });
    return;
  }
  const ok = await askLocal({
    kind: 'confirm', title: t('hostsExtra.importTitle'),
    message: t('hostsExtra.importFound', { count: plan.add.length }),
    detail: plan.add.map(e => `+  ${e.name}  (${addr(e)})`).join('\n') + (skipped ? `\n\n${t('hostsExtra.importSkipped')}\n${skipped}` : ''),
    okLabel: t('common.apply'),
  });
  if (!ok) return;
  try {
    const r = await api.sshConfigImport();
    await refreshHosts();
    flash(t('hostsExtra.imported', { count: r.added.length }));
  } catch (err) { showError(err); }
});

// ---------- Anmeldung ohne Passwort (SSH-Schlüssel) ----------

async function setupKeyLogin(name) {
  let st = await api.keyStatus();
  const ok = await askLocal({
    kind: 'confirm', title: t('hostsExtra.keyTitle'),
    message: st.exists
      ? t('hostsExtra.keyInstallExisting', { name })
      : t('hostsExtra.keyInstallNew', { name }),
    detail: t(st.exists ? 'hostsExtra.keyDetailExisting' : 'hostsExtra.keyDetailNew', { path: st.path }),
    okLabel: t('common.next'),
  });
  if (!ok) return;
  if (!st.exists) {
    const pass = await askLocal({
      kind: 'secret', title: t('connPro.passTitle'),
      message: t('connPro.passMsg'),
      placeholder: t('connPro.passPlaceholder'), remember: true, rememberLabel: t('connPro.rememberPassphrase'),
      okLabel: t('hostsExtra.passOk'),
    });
    if (pass == null) return;
    try { st = await api.keyGenerate(pass.value, pass.remember); } catch (err) { showError(err); return; }
  }
  flash(t('hostsExtra.keyInstalling', { name }), 40);
  try {
    const r = await api.keyInstall(name);
    flash(t('hostsExtra.keyInstalled'));
    await refreshHosts();
    const form = $('#host-form');
    if (!$('#host-modal').hidden && editingName === name && r.tested) form.key.value = r.key;
    if (r.tested) {
      askLocal({ kind: 'info', title: t('common.done'), message: t('hostsExtra.keyDone', { name }), detail: t('hostsExtra.keyDoneDetail', { key: r.key }) });
    } else {
      askLocal({ kind: 'info', title: t('hostsExtra.keyTestFailedTitle'), message: t('hostsExtra.keyTestFailed'), detail: r.testError || '' });
    }
  } catch (err) {
    $('#progress').hidden = true;
    showError(err);
  }
}
