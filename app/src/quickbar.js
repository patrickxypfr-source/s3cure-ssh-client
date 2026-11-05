// Eigene Befehlsknöpfe pro Verbindung (Befehlsleiste #quickbar)
// Gespeichert in ~/.myssh/snippets.json über den Hauptprozess (app/lib/snippets.js).
// Dazu kommen Knöpfe „Für alle Server“ (eigene Gruppe, bei jeder Verbindung sichtbar).
// Wird vor renderer.js geladen – Zugriff auf tabs, askLocal, openMenu, runQuick usw. erst beim Aufruf.
const Quickbar = (() => {
  const api = window.myssh;
  const qs = sel => document.querySelector(sel);
  const PLACEHOLDER = /(?<!\$)\{([\p{L}_][\p{L}\p{N}_-]*)\}/gu;

  // Eingabe-Arten für Platzhalter wie {commit}
  const INPUT_KINDS = {
    ref: {
      label: t('quickbar.kindRefLabel'), placeholder: t('quickbar.kindRefPlaceholder'),
      test: v => /^[\p{L}\p{N}_~^.\/:@+=,-]+$/u.test(v) && !v.startsWith('-'),
      rule: t('quickbar.kindRefRule'),
      insert: v => v,
    },
    number: {
      label: t('quickbar.kindNumberLabel'), placeholder: t('quickbar.kindNumberPlaceholder'),
      test: v => /^\d{1,12}$/.test(v),
      rule: t('quickbar.kindNumberRule'),
      insert: v => v,
    },
    text: {
      label: t('quickbar.kindTextLabel'), placeholder: '',
      test: v => !/[\x00-\x1f\x7f]/.test(v),
      rule: t('quickbar.kindTextRule'),
      // Sicher in einfache Anführungszeichen; steht der Platzhalter schon in "…" oder '…',
      // wird das kurz geschlossen und danach wieder geöffnet
      insert: (v, quote) => {
        const sq = `'${v.replace(/'/g, `'\\''`)}'`;
        return quote ? quote + sq + quote : sq;
      },
    },
  };

  // ---------- Vorlagen ----------

  const B = (label, cmd, tip = '', extra = {}) => ({ type: 'button', label, cmd, tip, ...extra });
  const M = (label, tip, items, extra = {}) => ({ type: 'menu', label, tip, items, ...extra });
  const TEMPLATES = {
    s3cure: {
      name: 's3cure',
      groups: () => [
        { items: [
          B('Status', 's3 status', t('quickbar.tplStatusTip'), { icon: 'pulse' }),
          B('Check', 's3 check', t('quickbar.tplCheckTip'), { icon: 'checkCircle' }),
        ] },
        { items: [
          B('Update', 's3 update', t('quickbar.tplUpdateTip'), { icon: 'sync' }),
          B('Update all', 's3 update-all', t('quickbar.tplUpdateAllTip'),
            { icon: 'layers', confirm: t('quickbar.tplUpdateAllConfirm') }),
        ] },
        { items: [
          M('Restart', t('quickbar.tplRestartTip'), [B(t('quickbar.tplAll'), 's3 restart all'), B('Bot', 's3 restart bot'), B('Panel', 's3 restart panel')], { icon: 'restart' }),
          M('Start', t('quickbar.tplStartTip'), [B('Bot', 's3 start bot'), B('Panel', 's3 start panel')], { icon: 'play' }),
          M('Stop', t('quickbar.tplStopTip'), [B('Bot', 's3 stop bot'), B('Panel', 's3 stop panel')],
            { icon: 'stop', danger: true, confirm: t('quickbar.tplStopConfirm') }),
        ] },
        { items: [
          M('Logs', t('quickbar.tplLogsTip'), [B('Bot', 's3 logs bot'), B('Panel', 's3 logs panel'), B('Caddy', 's3 logs caddy')], { icon: 'logs' }),
          M(t('quickbar.tplLiveLog'), t('quickbar.tplLiveLogTip'),
            [B('Bot', 's3 live bot', '', { live: true }), B('Panel', 's3 live panel', '', { live: true })], { icon: 'radio' }),
          B('Commits', 's3 log', t('quickbar.tplCommitsTip'), { icon: 'gitBranch' }),
        ] },
        { items: [
          B('Build', 's3 build', t('quickbar.tplBuildTip'), { icon: 'hammer' }),
          B('Backup', 's3 backup', t('quickbar.tplBackupTip'), { icon: 'archive' }),
          M('Rollback', t('quickbar.tplRollbackTip'), [
            B(t('quickbar.tplRollbackOne'), 's3 rollback', '', { icon: 'undo' }),
            B(t('quickbar.tplRollbackPick'), 's3 rollback {commit}', '', { icon: 'gitCommit',
              inputs: { commit: { prompt: t('quickbar.tplRollbackPrompt'), kind: 'ref', value: '' } },
            }),
          ], { icon: 'undo', danger: true, confirm: t('quickbar.tplRollbackConfirm') }),
          B('.env', 's3 env', t('quickbar.tplEnvTip'), { icon: 'key' }),
        ] },
      ],
    },
  };

  // ---------- Icons ----------

  // Suchwörter (deutsch) für die Icon-Auswahl; das erste Wort ist der Name im Tooltip.
  // Reihenfolge = Reihenfolge im Raster. Nur diese Icons stehen zur Auswahl.
  const ICON_WORDS = {
    pulse: 'Status Puls Aktivität', checkCircle: 'Check Prüfen Gesundheit OK', check: 'Häkchen Prüfen OK', // i18n-ignore
    sync: 'Update Aktualisieren Synchronisieren', layers: 'Alles Ebenen Stapel', refresh: 'Neu laden Aktualisieren', // i18n-ignore
    restart: 'Neustart Restart Neu starten', play: 'Start Starten Abspielen', stop: 'Stop Stoppen Anhalten', // i18n-ignore
    pause: 'Pause Anhalten', power: 'Ein/Aus Power Strom', // i18n-ignore
    logs: 'Logs Protokoll Datei Text', list: 'Liste Logs Zeilen', radio: 'Live Mitlesen Wellen Stream', // i18n-ignore
    gitBranch: 'Commits Git Zweig Branch', gitCommit: 'Commit Git Version', // i18n-ignore
    hammer: 'Build Bauen Werkzeug', rocket: 'Deploy Rakete Veröffentlichen', archive: 'Backup Archiv Sicherung', // i18n-ignore
    undo: 'Rollback Zurück Rückgängig', gear: 'Einstellungen Zahnrad Konfiguration', sliders: 'Regler Einstellungen Optionen', // i18n-ignore
    key: 'Schlüssel .env Zugang Passwort', lock: 'Schloss Sperren Sicherheit', unlock: 'Entsperren Offen', // i18n-ignore
    shield: 'Firewall Schutz Sicherheit', shieldCheck: 'Zertifikat SSL Sicherheit geprüft', // i18n-ignore
    database: 'Datenbank DB SQL', container: 'Docker Container Paket', server: 'Server Dienst', // i18n-ignore
    terminal: 'Terminal Konsole Befehl Shell', code: 'Code Programm Skript', // i18n-ignore
    globe: 'Web Internet Domain', network: 'Netzwerk Verbindungen', wifi: 'WLAN Verbindung Signal', cloud: 'Cloud Wolke Drive', // i18n-ignore
    hardDrive: 'Festplatte Speicherplatz Disk', memory: 'Arbeitsspeicher RAM', cpu: 'Prozessor CPU Last', gauge: 'Auslastung Monitor Tacho', // i18n-ignore
    clock: 'Zeit Uhr Cron Timer', user: 'Benutzer Nutzer User', users: 'Gruppe Benutzer Team', // i18n-ignore
    trash: 'Papierkorb Löschen Aufräumen', download: 'Download Herunterladen', upload: 'Upload Hochladen', // i18n-ignore
    search: 'Suche Suchen Finden', alert: 'Warnung Achtung Fehler', info: 'Info Information Hinweis', help: 'Hilfe Frage', // i18n-ignore
    bell: 'Glocke Benachrichtigung Alarm', star: 'Stern Favorit', bolt: 'Blitz Schnell Aktion', // i18n-ignore
    file: 'Datei Dokument', folder: 'Ordner Verzeichnis', link: 'Link Verknüpfung URL', home: 'Home Haus Start', edit: 'Stift Bearbeiten Editor', // i18n-ignore
    save: 'Speichern Diskette', copy: 'Kopieren', eye: 'Ansehen Auge Anzeigen', zip: 'ZIP Packen Komprimieren', tunnel: 'Tunnel Weiterleitung Port', // i18n-ignore
  };
  // Englische Suchwörter (erstes Wort = Name im Tooltip, wenn die Oberfläche englisch ist)
  const ICON_WORDS_EN = {
    pulse: 'Status Pulse Activity', checkCircle: 'Check Health OK', check: 'Checkmark Check OK',
    sync: 'Update Sync', layers: 'All Layers Stack', refresh: 'Reload Refresh',
    restart: 'Restart Reboot', play: 'Start Play Run', stop: 'Stop Halt',
    pause: 'Pause Hold', power: 'Power On/Off',
    logs: 'Logs Log File Text', list: 'List Logs Lines', radio: 'Live Follow Waves Stream',
    gitBranch: 'Commits Git Branch', gitCommit: 'Commit Git Version',
    hammer: 'Build Tool', rocket: 'Deploy Rocket Publish Release', archive: 'Backup Archive',
    undo: 'Rollback Back Undo', gear: 'Settings Gear Configuration', sliders: 'Sliders Settings Options',
    key: 'Key .env Access Password', lock: 'Lock Security', unlock: 'Unlock Open',
    shield: 'Firewall Shield Protection Security', shieldCheck: 'Certificate SSL Security Verified',
    database: 'Database DB SQL', container: 'Docker Container Package', server: 'Server Service',
    terminal: 'Terminal Console Command Shell', code: 'Code Program Script',
    globe: 'Web Internet Domain', network: 'Network Connections', wifi: 'Wi-Fi WLAN Connection Signal', cloud: 'Cloud Drive',
    hardDrive: 'Disk Hard Drive Storage', memory: 'Memory RAM', cpu: 'Processor CPU Load', gauge: 'Usage Monitor Gauge',
    clock: 'Time Clock Cron Timer', user: 'User Person', users: 'Group Users Team',
    trash: 'Trash Delete Clean Up', download: 'Download', upload: 'Upload',
    search: 'Search Find', alert: 'Warning Alert Error', info: 'Info Information Note', help: 'Help Question',
    bell: 'Bell Notification Alarm', star: 'Star Favorite', bolt: 'Bolt Quick Action',
    file: 'File Document', folder: 'Folder Directory', link: 'Link Shortcut URL', home: 'Home House Start', edit: 'Pencil Edit Editor',
    save: 'Save Disk', copy: 'Copy', eye: 'View Eye Show', zip: 'ZIP Pack Compress', tunnel: 'Tunnel Forwarding Port',
  };
  const hasIcon = name => typeof name === 'string' && Object.hasOwn(ICON_PATHS, name);
  const iconNames = () => Object.keys(ICON_WORDS).filter(hasIcon);
  // Unbekannte Icons (z. B. aus einer Datei von einer neueren Version) beim Import weglassen
  const dropUnknownIcons = groups => groups.map(g => ({ ...g, items: g.items.map(function fix(it) {
    return { ...it, icon: hasIcon(it.icon) ? it.icon : '', ...(it.items ? { items: it.items.map(fix) } : {}) };
  }) }));
  const iconTitle = name => ((I18N.lang === 'en' ? ICON_WORDS_EN : ICON_WORDS)[name] || name).split(' ')[0];
  // Suche findet deutsche und englische Wörter
  const iconWords = name => `${name} ${ICON_WORDS[name] || ''} ${ICON_WORDS_EN[name] || ''}`;

  // Inhalt eines Knopfs: [Icon] Text [Pfeil bei Menüs]
  function fillButton(b, item, arrow) {
    if (hasIcon(item.icon)) {
      b.insertAdjacentHTML('beforeend', icon(item.icon, 'qicon'));
      b.classList.add('has-icon');
    }
    b.appendChild(el('span', 'qtext', item.label));
    if (arrow) b.insertAdjacentHTML('beforeend', icon('down', 'qarrow'));
  }

  // ---------- Daten ----------

  // Profil-Schlüssel der Knöpfe „Für alle Server“ – kann kein Verbindungsname sein
  const GLOBAL = '\u0000alle'; // i18n-ignore
  let profiles = {};
  let loaded = false;
  let loading = null;
  let editing = null;          // Profil, dessen Leiste gerade bearbeitet wird
  const rechecked = new Set(); // Profile, für die schon einmal neu von der Platte gelesen wurde

  const uid = () => crypto.randomUUID();
  const clone = v => JSON.parse(JSON.stringify(v));
  const withIds = groups => groups.map(g => ({ id: uid(), items: g.items.map(function re(it) {
    return { ...clone(it), id: uid(), ...(it.items ? { items: it.items.map(re) } : {}) };
  }) }));
  const keyOf = tab => tab.spec.name || tab.spec.text || tab.title;
  const groupsOf = key => profiles[key]?.groups || [];
  const countButtons = groups => groups.reduce((n, g) => n + g.items.reduce((m, it) => m + (it.type === 'menu' ? it.items.length : 1), 0), 0);
  const placeholders = cmd => [...new Set([...String(cmd || '').matchAll(PLACEHOLDER)].map(m => m[1]))];

  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }

  // Beim ersten Start: Verbindungen, die bisher die s3-Leiste sahen, bekommen die Vorlage
  async function migrationProfiles() {
    const candidates = new Set();
    try { Object.keys(await api.listHosts()).forEach(k => candidates.add(k)); } catch {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const m = /^quick:(.*):show$/.exec(localStorage.key(i) || '');
        if (m && lsGet(localStorage.key(i)) === '1') candidates.add(m[1]);
      }
    } catch {}
    const out = {};
    for (const key of candidates) {
      if (lsGet(`quick:${key}:show`) !== '0') out[key] = { groups: withIds(TEMPLATES.s3cure.groups()) };
    }
    return out;
  }

  function load(force = false) {
    if (loading) return loading;
    if (loaded && !force) return Promise.resolve();
    loading = (async () => {
      try {
        let data = await api.snippetsLoad();
        if (!data.migrated) data = await api.snippetsMigrate(await migrationProfiles());
        profiles = data.profiles || {};
        profiles[GLOBAL] = data.global || { groups: [] };
      } catch (err) {
        console.error('Befehlsknöpfe konnten nicht geladen werden', err);
      }
      loaded = true;
      loading = null;
      renderQuickbar();
    })();
    return loading;
  }

  async function setGroups(key, groups) {
    groups = groups.filter(g => g.items.length);
    profiles[key] = { groups };
    renderQuickbar();
    try { await (key === GLOBAL ? api.snippetsSaveGlobal({ groups }) : api.snippetsSave(key, { groups })); }
    catch (err) { showError(t('quickbar.saveFailed', { error: err.message || err })); }
  }

  // ---------- Ausführen ----------

  // Läuft der Befehl endlos (Live-Log o. Ä.)? Dann vor dem nächsten Knopf mit Strg+C beenden.
  const LIVE_RE = /^\s*(s3\s+live\b|tail\s+(.*\s)?-[a-zA-Z]*[fF]\b|tail\s+.*--follow|journalctl\b.*(\s-[a-zA-Z]*f\b|--follow)|watch\s|ping\s|(docker|kubectl|podman)\s+.*logs\b.*(\s-f\b|--follow))/;
  const isLive = cmd => LIVE_RE.test(cmd || '');

  async function fillInputs(item, title) {
    const values = {};
    for (const name of placeholders(item.cmd)) {
      const inp = item.inputs?.[name] || {};
      const kind = INPUT_KINDS[inp.kind] || INPUT_KINDS.ref;
      let value = inp.value || '';
      let error = '';
      for (;;) {
        const answer = await askLocal({
          kind: 'text', title,
          message: (error ? error + '\n\n' : '') + (inp.prompt || t('quickbar.valueFor', { name })),
          value, placeholder: kind.placeholder, okLabel: t('common.next'),
        });
        if (answer == null) return null;
        const v = answer.trim();
        if (!v) { error = t('quickbar.enterSomething'); value = ''; continue; }
        if (!kind.test(v)) { error = t('quickbar.invalidInput', { rule: kind.rule }); value = v; continue; }
        values[name] = { kind, v };
        break;
      }
    }
    return item.cmd.replace(PLACEHOLDER, (_m, n, offset) => values[n].kind.insert(values[n].v, quoteAt(item.cmd, offset)));
  }

  // Steht die Stelle in "…" oder '…'? (Shell-Regeln, vereinfacht)
  function quoteAt(str, end) {
    let q = null;
    for (let i = 0; i < end; i++) {
      const c = str[i];
      if (q === "'") { if (c === "'") q = null; }
      else if (c === '\\') i++;
      else if (q === '"') { if (c === '"') q = null; }
      else if (c === "'" || c === '"') q = c;
    }
    return q;
  }

  async function run(item, parent) {
    const tab = tabs.get(activeId);
    if (!tab || tab.state !== 'open') return;
    const title = parent ? `${parent.label}: ${item.label}` : item.label;
    let cmd = placeholders(item.cmd).length ? await fillInputs(item, title) : item.cmd;
    if (cmd == null) return;
    // Mehrere Zeilen: nacheinander, jeweils nur wenn die vorige geklappt hat
    cmd = cmd.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join(' && ');
    if (!cmd) return;
    const confirm = item.confirm || parent?.confirm;
    const confirmText = confirm ? (typeof confirm === 'string' ? confirm : t('quickbar.confirmRun', { title })) : null;
    runQuick(cmd, confirmText, item.live || isLive(cmd), title);
  }

  // ---------- Leiste anzeigen ----------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render(tab, bar, connected) {
    bar.classList.remove('editing');
    bar.oncontextmenu = null;
    if (!loaded) { load(); return; }
    const key = keyOf(tab);
    if (!profiles[key] && !rechecked.has(key)) { rechecked.add(key); load(true); }
    if (editing === key) { renderEdit(key, bar); return; }
    if (editing) editing = null; // anderer Tab -> Bearbeiten beenden

    const groups = groupsOf(key);
    const globals = groupsOf(GLOBAL);
    if (!countButtons(groups) && !countButtons(globals)) { renderEmpty(key, bar); return; }

    renderButtons(bar, key, key, groups, connected);
    if (countButtons(globals)) {
      if (countButtons(groups)) bar.appendChild(el('span', 'qsep'));
      const tag = el('span', 'qscope');
      tag.innerHTML = icon(hasIcon('globe') ? 'globe' : 'server');
      tag.title = t('quickbar.globalScopeTip');
      bar.appendChild(tag);
      renderButtons(bar, GLOBAL, key, globals, connected);
    }
    const edit = el('button', 'qbtn qghost');
    edit.innerHTML = icon('edit');
    edit.title = t('quickbar.editTip');
    edit.addEventListener('click', () => startEdit(key));
    bar.appendChild(edit);
    bar.oncontextmenu = e => {
      e.preventDefault();
      openMenu([
        [t('quickbar.editBar'), () => startEdit(key), '', 'edit'],
        [t('quickbar.newButtonMenu'), () => newButton(key), '', 'plus'],
      ], e.clientX, e.clientY);
    };
  }

  // owner: Profil, in dem die Knöpfe gespeichert sind (Verbindung oder GLOBAL); key: aktuelle Verbindung
  function renderButtons(bar, owner, key, groups, connected) {
    const global = owner === GLOBAL;
    groups.forEach((group, gi) => {
      if (gi) bar.appendChild(el('span', 'qsep'));
      for (const item of group.items) {
        const b = el('button', 'qbtn' + (item.danger ? ' danger' : '') + (global ? ' qglobal' : ''));
        b.disabled = !connected;
        fillButton(b, item, item.type === 'menu');
        // Mit Icon steht der Name auch im Tooltip (bei schmaler Leiste ist nur das Icon zu sehen)
        b.title = (hasIcon(item.icon) ? `${item.label}\n` : '') + (item.type === 'button' ? `${item.cmd}\n` : '') + (item.tip || '') + (global ? '\n' + t('quickbar.forAllServers') : '');
        b.setAttribute('aria-label', item.label);
        b.addEventListener('click', e => {
          if (item.type !== 'menu') return run(item);
          const r = e.currentTarget.getBoundingClientRect();
          const entries = item.items.map(sub => [sub.label, () => run(sub, item), sub.danger || item.danger ? 'danger' : '', hasIcon(sub.icon) ? sub.icon : 'terminal']);
          if (!entries.length) entries.push([t('quickbar.emptyMenu'), () => startEdit(key), '', 'plus']);
          openMenu(entries, r.left, r.bottom + 4);
        });
        b.addEventListener('contextmenu', e => {
          e.preventDefault();
          e.stopPropagation();
          openMenu([
            [t('quickbar.editEllipsis'), () => openEditor(owner, findPath(owner, item.id)), '', 'edit'],
            global
              ? [t('quickbar.showLocalOnly'), () => moveScope(owner, key, item.id), '', 'server']
              : [t('quickbar.showEverywhere'), () => moveScope(owner, GLOBAL, item.id), '', hasIcon('globe') ? 'globe' : 'server'],
            [t('quickbar.editBar'), () => startEdit(key), '', 'bolt'],
            null,
            [t('quickbar.deleteEllipsis'), () => deleteAt(owner, findPath(owner, item.id)), 'danger', 'trash'],
          ], e.clientX, e.clientY);
        });
        bar.appendChild(b);
      }
    });
  }

  // Knopf oder Menü zwischen „nur diese Verbindung“ und „alle Server“ verschieben (ans Ende)
  function moveScope(fromKey, toKey, id) {
    const p = findPath(fromKey, id);
    if (!p || p.ei != null) return;
    const to = groupsOf(toKey);
    const last = to.length - 1;
    move({ key: fromKey, ...p }, last >= 0 ? { key: toKey, gi: last, index: to[last].items.length } : { key: toKey, newGroup: true, index: 0 });
    flash(toKey === GLOBAL ? t('quickbar.movedGlobal') : t('quickbar.movedLocal'));
  }

  function renderEmpty(key, bar) {
    bar.appendChild(el('span', 'qempty', t('quickbar.emptyBar')));
    const add = el('button', 'qbtn', t('quickbar.createButton'));
    add.insertAdjacentHTML('afterbegin', icon('plus'));
    add.addEventListener('click', () => newButton(key));
    const tpl = el('button', 'qbtn', t('quickbar.applyTemplate'));
    tpl.insertAdjacentHTML('afterbegin', icon('bolt'));
    tpl.title = t('quickbar.applyTemplateTip');
    tpl.addEventListener('click', () => applyGroups(key, withIds(TEMPLATES.s3cure.groups()), t('quickbar.applyTemplate')));
    const imp = el('button', 'qbtn qghost', t('quickbar.importEllipsis'));
    imp.addEventListener('click', () => importFile(key));
    bar.append(add, tpl, imp);
  }

  // ---------- Bearbeiten-Modus (Ziehen & Ablegen) ----------

  function startEdit(key) {
    editing = key;
    const tab = tabs.get(activeId);
    if (tab && !quickPref(tab, 'show', true)) setQuickPref(tab, 'show', true);
    if (tab && tab.view !== 'terminal') setView('terminal');
    renderQuickbar();
  }

  function stopEdit() { editing = null; renderQuickbar(); }

  let drag = null; // { from: { gi, ii, ei? }, isMenu }
  const marker = el('span', 'qdrop');

  function chip(cls, item) {
    const c = el('button', 'qbtn qitem ' + cls + (item.danger ? ' danger' : ''));
    fillButton(c, item, false);
    c.type = 'button';
    c.draggable = true;
    return c;
  }

  function renderEdit(key, bar) {
    bar.classList.add('editing');
    const groups = groupsOf(key);
    bar.appendChild(el('span', 'qlabel qedit-label', t('quickbar.editLabel')));
    renderEditGroups(bar, key, key, groups);
    const zone = el('div', 'qgroup qnew', groups.length ? t('quickbar.dropNewGroup') : t('quickbar.noButtons'));
    dropTarget(zone, { key, newGroup: true }, true);
    bar.appendChild(zone);

    // Eigene Gruppe: Knöpfe für alle Server
    const globals = groupsOf(GLOBAL);
    const label = el('span', 'qlabel qscope-label');
    label.innerHTML = icon(hasIcon('globe') ? 'globe' : 'server');
    label.append(t('quickbar.allServers'));
    label.title = t('quickbar.allServersTip');
    bar.appendChild(label);
    renderEditGroups(bar, GLOBAL, key, globals);
    const gzone = el('div', 'qgroup qnew qglobal-zone', globals.length ? t('quickbar.dropNewGroupGlobal') : t('quickbar.dropGlobal'));
    dropTarget(gzone, { key: GLOBAL, newGroup: true }, true);
    bar.appendChild(gzone);

    const tools = el('div', 'qtools');
    const tool = (text, ic, fn, cls = '') => {
      const b = el('button', 'qbtn ' + cls, text);
      if (ic) b.insertAdjacentHTML('afterbegin', icon(ic));
      b.addEventListener('click', fn);
      tools.appendChild(b);
      return b;
    };
    tool(t('quickbar.toolButton'), 'plus', () => newButton(key)).title = t('quickbar.toolButtonTip');
    tool(t('quickbar.toolMenu'), 'plus', () => openEditor(key, null, { kind: 'menu' })).title = t('quickbar.toolMenuTip');
    tool(t('quickbar.toolTemplate'), 'bolt', e => templateMenu(key, e.currentTarget)).title = t('quickbar.toolTemplateTip');
    tool(t('quickbar.toolExport'), 'download', () => exportFile(key)).title = t('quickbar.toolExportTip');
    tool(t('quickbar.toolImport'), 'upload', () => importFile(key)).title = t('quickbar.toolImportTip');
    tool(t('common.done'), '', stopEdit, 'primary');
    bar.appendChild(tools);
  }

  function renderEditGroups(bar, owner, key, groups) {
    groups.forEach((group, gi) => {
      if (gi) bar.appendChild(el('span', 'qsep'));
      const box = el('div', 'qgroup' + (owner === GLOBAL ? ' qglobal' : ''));
      group.items.forEach((item, ii) => {
        if (item.type === 'menu') {
          const m = el('div', 'qmenu qitem' + (item.danger ? ' danger' : ''));
          m.draggable = true;
          const head = el('button', 'qmenu-head');
          head.type = 'button';
          fillButton(head, item, true);
          head.title = t('quickbar.menuHeadTip');
          head.addEventListener('click', () => openEditor(owner, { gi, ii }));
          const list = el('div', 'qmenu-items');
          item.items.forEach((sub, ei) => {
            const c = chip('qentry', sub);
            c.title = sub.cmd + '\n' + t('quickbar.chipTip');
            c.addEventListener('click', () => openEditor(owner, { gi, ii, ei }));
            c.addEventListener('dragstart', e => startDrag(e, { key: owner, gi, ii, ei }, false, c));
            list.appendChild(c);
          });
          const plus = el('button', 'qadd');
          plus.type = 'button';
          plus.innerHTML = icon('plus');
          plus.title = t('quickbar.addToMenuTip');
          plus.addEventListener('click', () => openEditor(owner, null, { kind: 'button', into: { gi, ii } }));
          list.appendChild(plus);
          dropTarget(list, { key: owner, gi, ii }, false);
          m.append(head, list);
          m.addEventListener('dragstart', e => startDrag(e, { key: owner, gi, ii }, true, m));
          box.appendChild(m);
        } else {
          const c = chip('', item);
          c.title = item.cmd + '\n' + t('quickbar.chipTip');
          c.addEventListener('click', () => openEditor(owner, { gi, ii }));
          c.addEventListener('dragstart', e => startDrag(e, { key: owner, gi, ii }, false, c));
          box.appendChild(c);
        }
      });
      dropTarget(box, { key: owner, gi }, true);
      bar.appendChild(box);
    });
  }

  function startDrag(e, from, isMenu, node) {
    e.stopPropagation(); // Eintrag im Menü: nicht das ganze Menü ziehen
    drag = { from, isMenu };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 's3cure-knopf');
    requestAnimationFrame(() => node.classList.add('dragging'));
    node.addEventListener('dragend', () => { drag = null; marker.remove(); node.classList.remove('dragging'); }, { once: true });
  }

  // Einfügestelle aus der Mausposition (Knöpfe können umbrechen)
  function dropIndex(container, x, y) {
    const kids = [...container.children].filter(c => c.classList.contains('qitem'));
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect();
      if (y < r.top) return { index: i, before: kids[i] };
      if (y <= r.bottom && x < r.left + r.width / 2) return { index: i, before: kids[i] };
    }
    return { index: kids.length, before: container.querySelector(':scope > .qadd') };
  }

  function dropTarget(container, to, acceptsMenus) {
    container.addEventListener('dragover', e => {
      if (!drag || (drag.isMenu && !acceptsMenus)) return; // Menü im Menü geht nicht
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (to.newGroup) { container.classList.add('over'); return; }
      const { before } = dropIndex(container, e.clientX, e.clientY);
      if (before) container.insertBefore(marker, before); else container.appendChild(marker);
    });
    container.addEventListener('dragleave', e => {
      if (!container.contains(e.relatedTarget)) { container.classList.remove('over'); if (marker.parentNode === container) marker.remove(); }
    });
    container.addEventListener('drop', e => {
      if (!drag || (drag.isMenu && !acceptsMenus)) return;
      e.preventDefault();
      e.stopPropagation();
      container.classList.remove('over');
      marker.remove(); // vor dropIndex entfernen, sonst zählt die Markierung mit
      const index = to.newGroup ? 0 : dropIndex(container, e.clientX, e.clientY).index;
      const from = drag.from;
      drag = null;
      move(from, { ...to, index });
    });
  }

  // Ziel-Liste: Gruppe { gi } oder Einträge eines Menüs { gi, ii }
  const listAt = (groups, c) => (c.ii == null ? groups[c.gi].items : groups[c.gi].items[c.ii].items);

  // from/to: { key, gi, ii?, ei? } bzw. { key, newGroup } – key darf verschieden sein (Verbindung <-> alle Server)
  function move(from, to) {
    const same = from.key === to.key;
    const srcGroups = clone(groupsOf(from.key));
    const dstGroups = same ? srcGroups : clone(groupsOf(to.key));
    const src = from.ei == null ? srcGroups[from.gi].items : srcGroups[from.gi].items[from.ii].items;
    const srcIndex = from.ei == null ? from.ii : from.ei;
    const target = to.newGroup ? [] : listAt(dstGroups, to); // Ziel merken, bevor sich Positionen verschieben
    let index = to.index;
    if (target === src && srcIndex < index) index--;
    const [item] = src.splice(srcIndex, 1);
    if (!item) return;
    target.splice(index, 0, item);
    if (to.newGroup) dstGroups.push({ id: uid(), items: target });
    setGroups(from.key, srcGroups);
    if (!same) setGroups(to.key, dstGroups);
  }

  function findPath(key, id) {
    const groups = groupsOf(key);
    for (let gi = 0; gi < groups.length; gi++) {
      for (let ii = 0; ii < groups[gi].items.length; ii++) {
        const it = groups[gi].items[ii];
        if (it.id === id) return { gi, ii };
        if (it.type === 'menu') { const ei = it.items.findIndex(s => s.id === id); if (ei >= 0) return { gi, ii, ei }; }
      }
    }
    return null;
  }

  const itemAt = (groups, p) => (p.ei == null ? groups[p.gi]?.items[p.ii] : groups[p.gi]?.items[p.ii]?.items[p.ei]);

  async function deleteAt(key, path) {
    if (!path) return false;
    const item = itemAt(groupsOf(key), path);
    if (!item) return false;
    const extra = item.type === 'menu' && item.items.length ? ' ' + t('quickbar.deleteMenuExtra', { count: item.items.length }) : '';
    const ok = await askLocal({ kind: 'confirm', title: item.type === 'menu' ? t('quickbar.deleteMenuTitle') : t('quickbar.deleteButtonTitle'), message: t('quickbar.deleteQ', { label: item.label }) + extra, okLabel: t('common.delete'), danger: true });
    if (!ok) return false;
    const groups = clone(groupsOf(key));
    const list = path.ei == null ? groups[path.gi].items : groups[path.gi].items[path.ii].items;
    list.splice(path.ei == null ? path.ii : path.ei, 1);
    setGroups(key, groups);
    return true;
  }

  function newButton(key) { openEditor(key, null, { kind: 'button' }); }

  // ---------- Vorlage, Export, Import ----------

  // Fragt nach, ob angehängt oder ersetzt werden soll (Ersetzen = destruktiv)
  async function applyGroups(key, incoming, title) {
    const current = groupsOf(key);
    const n = countButtons(current);
    let mode = 'replace';
    if (n) {
      mode = await choose({
        title,
        message: t('quickbar.applyQ', { count: n }),
        options: [{ label: t('common.cancel') }, { label: t('quickbar.append'), value: 'append' }, { label: t('quickbar.replaceAll'), value: 'replace', cls: 'danger' }],
      });
      if (!mode) return;
    }
    await setGroups(key, mode === 'append' ? [...clone(current), ...incoming] : incoming);
    flash(t('quickbar.applied', { count: countButtons(incoming) }));
  }

  function templateMenu(key, btn) {
    const r = btn.getBoundingClientRect();
    const entries = [[t('quickbar.templateEntry'), () => applyGroups(key, withIds(TEMPLATES.s3cure.groups()), t('quickbar.applyTemplate')), '', 'bolt']];
    const others = Object.keys(profiles).filter(k => k !== key && k !== GLOBAL && countButtons(groupsOf(k))).sort((a, b) => a.localeCompare(b, I18N.locale));
    if (others.length) entries.push(null);
    for (const k of others) entries.push([t('quickbar.copyFrom', { name: k }), () => applyGroups(key, withIds(groupsOf(k)), t('quickbar.copyFromTitle', { name: k })), '', 'server']);
    openMenu(entries, r.left, r.bottom + 4);
  }

  async function exportFile(key) {
    const groups = groupsOf(key);
    if (!countButtons(groups)) { showError(t('quickbar.nothingToExport')); return; }
    try { const file = await api.snippetsExport(key, groups); if (file) flash(t('quickbar.exported', { file })); }
    catch (err) { showError(err); }
  }

  async function importFile(key) {
    let groups;
    try { groups = await api.snippetsImport(); } catch (err) { showError(err); return; }
    if (groups) await applyGroups(key, dropUnknownIcons(groups), t('quickbar.importTitle'));
  }

  // ---------- Dialoge ----------

  // Kleiner Auswahldialog mit mehreren Knöpfen. Ergebnis: value der Option oder null
  function choose({ title, message, options }) {
    return new Promise(resolve => {
      const modal = el('div', 'modal snip-modal');
      const box = el('div', 'dialog');
      box.append(el('h2', '', title), el('p', 'snip-message', message));
      const actions = el('div', 'actions');
      const done = v => { modal.remove(); window.removeEventListener('keydown', onKey, true); resolve(v ?? null); };
      const onKey = e => { if (e.key === 'Escape' && qs('#ask-modal').hidden) { e.stopPropagation(); done(null); } };
      for (const o of options) {
        const b = el('button', 'btn' + (o.cls ? ' ' + o.cls : o.value && o === options[options.length - 1] ? ' primary' : ''), o.label);
        b.type = 'button';
        b.addEventListener('click', () => done(o.value));
        actions.appendChild(b);
      }
      box.appendChild(actions);
      modal.appendChild(box);
      document.body.appendChild(modal);
      window.addEventListener('keydown', onKey, true);
      actions.lastChild.focus();
    });
  }

  let editor = null;

  function buildEditor() {
    const modal = el('div', 'modal snip-modal');
    modal.hidden = true;
    modal.innerHTML = `
      <form class="dialog snip-dialog" autocomplete="off">
        <h2></h2>
        <label>${t('quickbar.labelName')}<input name="label" required maxlength="80" placeholder="${t('quickbar.labelPlaceholder')}"></label>
        <div class="snip-icons">
          <div class="snip-icons-head">
            <span>Icon <span class="muted">${t('common.optional')}</span></span>
            <input type="search" class="snip-icon-search" placeholder="${t('quickbar.iconSearch')}" spellcheck="false">
          </div>
          <div class="snip-icon-grid" role="listbox" aria-label="Icon"></div>
        </div>
        <label class="for-button">${t('quickbar.cmdLabel')}
          <textarea name="cmd" rows="3" spellcheck="false" placeholder="${t('quickbar.cmdPlaceholder')}"></textarea>
        </label>
        <p class="snip-help for-button">${t('quickbar.cmdHelp')}</p>
        <div class="snip-inputs for-button"></div>
        <label>${t('quickbar.tipLabel')} <span class="muted">${t('common.optional')}</span><input name="tip" maxlength="300"></label>
        <label class="toggle"><input type="checkbox" name="confirmOn"><span class="track"><span class="knob"></span></span>${t('quickbar.confirmOn')}</label>
        <input name="confirmText" class="snip-sub" maxlength="500" placeholder="${t('quickbar.confirmTextPlaceholder')}">
        <label class="toggle"><input type="checkbox" name="danger"><span class="track"><span class="knob"></span></span>${t('quickbar.dangerLabel')}</label>
        <label class="toggle for-button"><input type="checkbox" name="live"><span class="track"><span class="knob"></span></span>${t('quickbar.liveLabel')}</label>
        <div class="snip-scope">
          <span>${t('quickbar.scopeLabel')}</span>
          <div class="seg">
            <button type="button" data-scope="local">${t('quickbar.scopeLocal')}</button>
            <button type="button" data-scope="global">${t('quickbar.allServers')}</button>
          </div>
        </div>
        <p class="snip-help for-menu">${t('quickbar.menuHelp')}</p>
        <div class="actions">
          <button type="button" class="btn snip-delete">${icon('trash')}${t('common.delete')}</button>
          <span class="spacer"></span>
          <button type="button" class="btn" data-x>${t('common.cancel')}</button>
          <button type="submit" class="btn primary">${t('common.save')}</button>
        </div>
      </form>`;
    document.body.appendChild(modal);
    const form = modal.querySelector('form');
    const ed = { modal, form, inputs: {} };
    const syncConfirm = () => { form.confirmText.hidden = !form.confirmOn.checked; };
    form.confirmOn.addEventListener('change', () => { syncConfirm(); if (form.confirmOn.checked) form.confirmText.focus(); });
    form.cmd.addEventListener('input', () => renderInputs(ed));
    for (const b of modal.querySelectorAll('[data-scope]')) b.addEventListener('click', () => setScope(ed, b.dataset.scope));
    const search = modal.querySelector('.snip-icon-search');
    search.addEventListener('input', () => renderIconGrid(ed));
    search.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // nicht speichern – erstes Suchergebnis wählen
      const first = modal.querySelector('.snip-icon-grid [data-icon-name]:not([data-icon-name=""])');
      if (first) selectIcon(ed, first.dataset.iconName);
    });
    modal.querySelector('[data-x]').addEventListener('click', () => { modal.hidden = true; });
    modal.querySelector('.snip-delete').addEventListener('click', async () => {
      if (await deleteAt(ed.key, ed.path)) modal.hidden = true;
    });
    form.addEventListener('submit', e => { e.preventDefault(); saveEditor(ed); });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.hidden && qs('#ask-modal').hidden) { e.stopPropagation(); modal.hidden = true; }
    }, true);
    ed.syncConfirm = syncConfirm;
    return ed;
  }

  function setScope(ed, scope) {
    ed.scope = scope;
    for (const b of ed.modal.querySelectorAll('[data-scope]')) b.classList.toggle('on', b.dataset.scope === scope);
  }

  // Icon-Raster: „kein Icon“ + alle passenden Icons zur Suche
  function renderIconGrid(ed) {
    const grid = ed.form.querySelector('.snip-icon-grid');
    const q = ed.form.querySelector('.snip-icon-search').value.trim().toLowerCase();
    grid.innerHTML = '';
    const cell = (name, html, title) => {
      const b = el('button', 'snip-icon' + (ed.icon === name ? ' sel' : ''));
      b.type = 'button';
      b.dataset.iconName = name;
      b.title = title;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(ed.icon === name));
      b.innerHTML = html;
      b.addEventListener('click', () => selectIcon(ed, name));
      grid.appendChild(b);
    };
    if (!q) cell('', '<span class="snip-noicon"></span>', t('quickbar.noIcon'));
    const names = iconNames().filter(n => !q || iconWords(n).toLowerCase().includes(q));
    for (const n of names) cell(n, icon(n), iconTitle(n));
    if (q && !names.length) grid.appendChild(el('span', 'snip-icon-empty', t('quickbar.noIconFound')));
    const sel = grid.querySelector('.sel');
    if (sel) grid.scrollTop = sel.offsetTop - grid.clientHeight / 2 + sel.offsetHeight / 2;
  }

  function selectIcon(ed, name) {
    ed.icon = name;
    for (const b of ed.form.querySelectorAll('.snip-icon')) {
      const on = b.dataset.iconName === name;
      b.classList.toggle('sel', on);
      b.setAttribute('aria-selected', String(on));
    }
  }

  // Für jeden Platzhalter im Befehl: Frage, erlaubte Eingabe, Vorschlag
  function renderInputs(ed) {
    const box = ed.form.querySelector('.snip-inputs');
    for (const row of box.querySelectorAll('.snip-input')) {
      ed.inputs[row.dataset.name] = { prompt: row.querySelector('[data-f=prompt]').value, kind: row.querySelector('[data-f=kind]').value, value: row.querySelector('[data-f=value]').value };
    }
    box.innerHTML = '';
    const names = placeholders(ed.form.cmd.value);
    if (!names.length) return;
    box.appendChild(el('div', 'snip-inputs-head', t('quickbar.inputsHead')));
    for (const name of names) {
      const cur = ed.inputs[name] || { prompt: '', kind: 'ref', value: '' };
      const row = el('div', 'snip-input');
      row.dataset.name = name;
      const tag = el('code', '', `{${name}}`);
      const prompt = Object.assign(el('input'), { value: cur.prompt, placeholder: t('quickbar.promptPlaceholder', { name }), maxLength: 300 });
      prompt.dataset.f = 'prompt';
      const kind = el('select');
      kind.dataset.f = 'kind';
      kind.title = t('quickbar.kindTip');
      for (const [k, v] of Object.entries(INPUT_KINDS)) kind.appendChild(Object.assign(el('option', '', v.label), { value: k }));
      kind.value = INPUT_KINDS[cur.kind] ? cur.kind : 'ref';
      const value = Object.assign(el('input'), { value: cur.value, placeholder: t('quickbar.valuePlaceholder'), maxLength: 300 });
      value.dataset.f = 'value';
      row.append(tag, prompt, kind, value);
      box.appendChild(row);
    }
  }

  // path: vorhandener Eintrag | opts.kind + opts.into: neuer Eintrag
  function openEditor(key, path, opts = {}) {
    if (!editor) editor = buildEditor();
    const ed = editor;
    const item = path ? itemAt(groupsOf(key), path) : null;
    if (path && !item) return;
    const kind = item ? item.type : opts.kind;
    const inMenu = path ? path.ei != null : !!opts.into;
    const active = tabs.get(activeId);
    const localKey = key === GLOBAL ? (active ? keyOf(active) : null) : key;
    Object.assign(ed, { key, localKey, path, kind, into: opts.into || null, inputs: clone(item?.inputs || {}), icon: hasIcon(item?.icon) ? item.icon : '' });
    const f = ed.form;
    f.reset();
    f.classList.toggle('is-menu', kind === 'menu');
    ed.modal.querySelector('h2').textContent = item
      ? (kind === 'menu' ? t('quickbar.editMenu') : inMenu ? t('quickbar.editMenuEntry') : t('quickbar.editButton'))
      : (kind === 'menu' ? t('quickbar.newMenu') : inMenu ? t('quickbar.newMenuEntry') : t('quickbar.newButton'));
    f.label.value = item?.label || '';
    f.label.placeholder = kind === 'menu' ? t('quickbar.labelPlaceholderMenu') : t('quickbar.labelPlaceholder');
    f.cmd.value = item?.cmd || '';
    f.tip.value = item?.tip || '';
    f.confirmOn.checked = !!item?.confirm;
    f.confirmText.value = typeof item?.confirm === 'string' ? item.confirm : '';
    f.danger.checked = !!item?.danger;
    f.live.checked = !!item?.live;
    f.cmd.required = kind !== 'menu';
    ed.syncConfirm();
    renderInputs(ed);
    renderIconGrid(ed);
    ed.modal.querySelector('.snip-delete').hidden = !item;
    // Menü-Einträge gehören zu ihrem Menü – nur Knöpfe und Menüs selbst sind umschaltbar
    ed.modal.querySelector('.snip-scope').hidden = inMenu || !localKey;
    setScope(ed, key === GLOBAL ? 'global' : 'local');
    ed.modal.hidden = false;
    f.label.focus();
  }

  function saveEditor(ed) {
    const f = ed.form;
    renderInputs(ed); // aktuelle Werte der Platzhalter einsammeln
    const label = f.label.value.trim();
    if (!label) { f.label.focus(); return; }
    const confirm = f.confirmOn.checked ? (f.confirmText.value.trim() || true) : false;
    const base = { label, icon: ed.icon || '', tip: f.tip.value.trim(), confirm, danger: f.danger.checked };
    const groups = clone(groupsOf(ed.key));
    let item;
    if (ed.kind === 'menu') {
      const old = ed.path ? itemAt(groups, ed.path) : null;
      item = { id: old?.id || uid(), type: 'menu', ...base, items: old?.items || [] };
    } else {
      const cmd = f.cmd.value.replace(/\s+$/, '');
      if (!cmd.trim()) { f.cmd.focus(); return; }
      const inputs = {};
      for (const name of placeholders(cmd)) inputs[name] = ed.inputs[name] || { prompt: '', kind: 'ref', value: '' };
      const old = ed.path ? itemAt(groups, ed.path) : null;
      item = { id: old?.id || uid(), type: 'button', ...base, cmd, live: f.live.checked, inputs };
    }
    // „Anzeigen bei“ umgeschaltet: aus dem bisherigen Profil entfernen, im anderen hinten anfügen
    const target = ed.into || (ed.path && ed.path.ei != null) || !ed.localKey ? ed.key : ed.scope === 'global' ? GLOBAL : ed.localKey;
    if (ed.path && target !== ed.key) {
      groups[ed.path.gi].items.splice(ed.path.ii, 1);
      const other = clone(groupsOf(target));
      if (other.length) other[other.length - 1].items.push(item); else other.push({ id: uid(), items: [item] });
      ed.modal.hidden = true;
      setGroups(ed.key, groups);
      setGroups(target, other);
      return;
    }
    if (!ed.path && target !== ed.key) { ed.key = target; groups.splice(0, groups.length, ...clone(groupsOf(target))); }
    if (ed.path) {
      const list = ed.path.ei == null ? groups[ed.path.gi].items : groups[ed.path.gi].items[ed.path.ii].items;
      list[ed.path.ei == null ? ed.path.ii : ed.path.ei] = item;
    } else if (ed.into) {
      groups[ed.into.gi].items[ed.into.ii].items.push(item);
    } else if (groups.length) {
      groups[groups.length - 1].items.push(item);
    } else {
      groups.push({ id: uid(), items: [item] });
    }
    ed.modal.hidden = true;
    setGroups(ed.key, groups);
    // Neues Menü: gleich in den Bearbeiten-Modus, damit Einträge hinzugefügt werden können
    if (!ed.path && ed.kind === 'menu') startEdit(ed.localKey || ed.key);
  }

  // Alle ausführbaren Knöpfe der Verbindung (für die Befehlspalette): eigene zuerst, dann „alle Server“
  function entries(tab) {
    if (!tab) return [];
    if (!loaded) load();
    const out = [];
    for (const [owner, global] of [[keyOf(tab), false], [GLOBAL, true]]) {
      for (const g of groupsOf(owner)) {
        for (const it of g.items) {
          if (it.type === 'menu') for (const sub of it.items) out.push({ item: sub, parent: it, global, label: `${it.label}: ${sub.label}` });
          else out.push({ item: it, parent: null, global, label: it.label });
        }
      }
    }
    return out;
  }

  return { render, isLive, load, TEMPLATES, entries, run };
})();
