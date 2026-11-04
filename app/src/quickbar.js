// Eigene Befehlsknöpfe pro Verbindung (Befehlsleiste #quickbar)
// Gespeichert in ~/.myssh/snippets.json über den Hauptprozess (app/lib/snippets.js).
// Wird vor renderer.js geladen – Zugriff auf tabs, askLocal, openMenu, runQuick usw. erst beim Aufruf.
const Quickbar = (() => {
  const api = window.myssh;
  const qs = sel => document.querySelector(sel);
  const PLACEHOLDER = /(?<!\$)\{([\p{L}_][\p{L}\p{N}_-]*)\}/gu;

  // Eingabe-Arten für Platzhalter wie {commit}
  const INPUT_KINDS = {
    ref: {
      label: 'Wort (Name, Commit, Pfad)', placeholder: 'z. B. main oder a1b2c3d',
      test: v => /^[\p{L}\p{N}_~^.\/:@+=,-]+$/u.test(v) && !v.startsWith('-'),
      rule: 'Erlaubt sind Buchstaben, Zahlen sowie ~ ^ . / - _ : @ + = , (keine Leerzeichen, nicht mit - am Anfang).',
      insert: v => v,
    },
    number: {
      label: 'Zahl', placeholder: 'z. B. 5',
      test: v => /^\d{1,12}$/.test(v),
      rule: 'Bitte nur eine ganze Zahl eingeben (z. B. 5).',
      insert: v => v,
    },
    text: {
      label: 'Beliebiger Text', placeholder: '',
      test: v => !/[\x00-\x1f\x7f]/.test(v),
      rule: 'Der Text darf keine Zeilenumbrüche oder Steuerzeichen enthalten.',
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
          B('Status', 's3 status', 'Dienste, Stand, Backup-Timer'),
          B('Check', 's3 check', 'Gesundheitscheck: Dienste, Ports, Firewall, RAM, Platte'),
        ] },
        { items: [
          B('Update', 's3 update', 'Code holen, nur Nötiges bauen und neu starten'),
          B('Update all', 's3 update-all', 'Alles: pull, install, Panel-Build, beide neu starten',
            { confirm: 'Alles neu installieren, das Panel neu bauen und Bot und Panel neu starten?' }),
        ] },
        { items: [
          M('Restart', 'Dienste neu starten', [B('Alles', 's3 restart all'), B('Bot', 's3 restart bot'), B('Panel', 's3 restart panel')]),
          M('Start', 'Dienst starten', [B('Bot', 's3 start bot'), B('Panel', 's3 start panel')]),
          M('Stop', 'Dienst stoppen', [B('Bot', 's3 stop bot'), B('Panel', 's3 stop panel')],
            { danger: true, confirm: 'Den Dienst wirklich stoppen? Er ist dann offline, bis du ihn wieder startest.' }),
        ] },
        { items: [
          M('Logs', 'Letzte 60 Zeilen', [B('Bot', 's3 logs bot'), B('Panel', 's3 logs panel'), B('Caddy', 's3 logs caddy')]),
          M('Live-Log', 'Log live mitlesen – endet mit Strg+C oder beim nächsten Knopf',
            [B('Bot', 's3 live bot', '', { live: true }), B('Panel', 's3 live panel', '', { live: true })]),
          B('Commits', 's3 log', 'Letzte 8 Commits'),
        ] },
        { items: [
          B('Build', 's3 build', 'Panel neu bauen und neu starten'),
          B('Backup', 's3 backup', 'DB-Sicherung und Drive-Kopie jetzt ausführen'),
          M('Rollback', 'Auf einen alten Stand zurück', [
            B('Ein Commit zurück', 's3 rollback'),
            B('Bestimmter Commit …', 's3 rollback {commit}', '', {
              inputs: { commit: { prompt: 'Auf welchen Commit zurück? (Hash aus „Commits“ oder z. B. HEAD~2)', kind: 'ref', value: '' } },
            }),
          ], { danger: true, confirm: 'Wirklich auf einen alten Stand zurückgehen? Der Bot wird dabei neu gestartet.' }),
          B('.env', 's3 env', '.env im Editor nano öffnen – speichern: Strg+O, Enter · beenden: Strg+X'),
        ] },
      ],
    },
  };

  // ---------- Daten ----------

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
    try { await api.snippetsSave(key, { groups }); }
    catch (err) { showError('Befehlsknöpfe konnten nicht gespeichert werden: ' + (err.message || err)); }
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
          message: (error ? error + '\n\n' : '') + (inp.prompt || `Wert für „${name}“:`),
          value, placeholder: kind.placeholder, okLabel: 'Weiter',
        });
        if (answer == null) return null;
        const v = answer.trim();
        if (!v) { error = 'Bitte etwas eingeben.'; value = ''; continue; }
        if (!kind.test(v)) { error = 'Ungültige Eingabe. ' + kind.rule; value = v; continue; }
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
    const confirmText = confirm ? (typeof confirm === 'string' ? confirm : `„${title}“ wirklich ausführen?`) : null;
    runQuick(cmd, confirmText, item.live || isLive(cmd));
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
    if (!countButtons(groups)) { renderEmpty(key, bar); return; }

    groups.forEach((group, gi) => {
      if (gi) bar.appendChild(el('span', 'qsep'));
      for (const item of group.items) {
        const b = el('button', 'qbtn' + (item.danger ? ' danger' : ''), item.label);
        b.disabled = !connected;
        if (item.type === 'menu') b.insertAdjacentHTML('beforeend', icon('down'));
        b.title = (item.type === 'button' ? `${item.cmd}\n` : '') + (item.tip || '');
        b.addEventListener('click', e => {
          if (item.type !== 'menu') return run(item);
          const r = e.currentTarget.getBoundingClientRect();
          const entries = item.items.map(sub => [sub.label, () => run(sub, item), sub.danger || item.danger ? 'danger' : '', 'terminal']);
          if (!entries.length) entries.push(['Leer – Einträge hinzufügen …', () => startEdit(key), '', 'plus']);
          openMenu(entries, r.left, r.bottom + 4);
        });
        b.addEventListener('contextmenu', e => {
          e.preventDefault();
          e.stopPropagation();
          openMenu([
            ['Bearbeiten …', () => openEditor(key, findPath(key, item.id)), '', 'edit'],
            ['Leiste bearbeiten', () => startEdit(key), '', 'bolt'],
            null,
            ['Löschen …', () => deleteAt(key, findPath(key, item.id)), 'danger', 'trash'],
          ], e.clientX, e.clientY);
        });
        bar.appendChild(b);
      }
    });
    const edit = el('button', 'qbtn qghost');
    edit.innerHTML = icon('edit');
    edit.title = 'Knöpfe bearbeiten, sortieren, Vorlage, Export/Import';
    edit.addEventListener('click', () => startEdit(key));
    bar.appendChild(edit);
    bar.oncontextmenu = e => {
      e.preventDefault();
      openMenu([
        ['Leiste bearbeiten', () => startEdit(key), '', 'edit'],
        ['Neuer Knopf …', () => newButton(key), '', 'plus'],
      ], e.clientX, e.clientY);
    };
  }

  function renderEmpty(key, bar) {
    bar.appendChild(el('span', 'qempty', 'Noch keine Befehlsknöpfe für diese Verbindung.'));
    const add = el('button', 'qbtn', 'Knopf anlegen');
    add.insertAdjacentHTML('afterbegin', icon('plus'));
    add.addEventListener('click', () => newButton(key));
    const tpl = el('button', 'qbtn', 'Vorlage „s3cure“ übernehmen');
    tpl.insertAdjacentHTML('afterbegin', icon('bolt'));
    tpl.title = 'Die bekannten s3-Knöpfe (Status, Update, Logs, Rollback …) übernehmen';
    tpl.addEventListener('click', () => applyGroups(key, withIds(TEMPLATES.s3cure.groups()), 'Vorlage „s3cure“ übernehmen'));
    const imp = el('button', 'qbtn qghost', 'Importieren …');
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

  function chip(text, cls, item) {
    const c = el('button', 'qbtn qitem ' + cls + (item.danger ? ' danger' : ''), text);
    c.type = 'button';
    c.draggable = true;
    return c;
  }

  function renderEdit(key, bar) {
    bar.classList.add('editing');
    const groups = groupsOf(key);
    bar.appendChild(el('span', 'qlabel qedit-label', 'Bearbeiten'));

    groups.forEach((group, gi) => {
      if (gi) bar.appendChild(el('span', 'qsep'));
      const box = el('div', 'qgroup');
      group.items.forEach((item, ii) => {
        if (item.type === 'menu') {
          const m = el('div', 'qmenu qitem' + (item.danger ? ' danger' : ''));
          m.draggable = true;
          const head = el('button', 'qmenu-head', item.label);
          head.type = 'button';
          head.insertAdjacentHTML('beforeend', icon('down'));
          head.title = 'Menü bearbeiten (Name, Rückfrage) – ziehen zum Verschieben';
          head.addEventListener('click', () => openEditor(key, { gi, ii }));
          const list = el('div', 'qmenu-items');
          item.items.forEach((sub, ei) => {
            const c = chip(sub.label, 'qentry', sub);
            c.title = sub.cmd + '\nKlick: bearbeiten · ziehen: verschieben';
            c.addEventListener('click', () => openEditor(key, { gi, ii, ei }));
            c.addEventListener('dragstart', e => startDrag(e, { gi, ii, ei }, false, c));
            list.appendChild(c);
          });
          const plus = el('button', 'qadd');
          plus.type = 'button';
          plus.innerHTML = icon('plus');
          plus.title = 'Eintrag zu diesem Menü hinzufügen';
          plus.addEventListener('click', () => openEditor(key, null, { kind: 'button', into: { gi, ii } }));
          list.appendChild(plus);
          dropTarget(list, key, { gi, ii }, false);
          m.append(head, list);
          m.addEventListener('dragstart', e => startDrag(e, { gi, ii }, true, m));
          box.appendChild(m);
        } else {
          const c = chip(item.label, '', item);
          c.title = item.cmd + '\nKlick: bearbeiten · ziehen: verschieben';
          c.addEventListener('click', () => openEditor(key, { gi, ii }));
          c.addEventListener('dragstart', e => startDrag(e, { gi, ii }, false, c));
          box.appendChild(c);
        }
      });
      dropTarget(box, key, { gi }, true);
      bar.appendChild(box);
    });

    const zone = el('div', 'qgroup qnew', groups.length ? 'Hierher ziehen = neue Gruppe' : 'Noch keine Knöpfe');
    dropTarget(zone, key, { newGroup: true }, true);
    bar.appendChild(zone);

    const tools = el('div', 'qtools');
    const tool = (text, ic, fn, cls = '') => {
      const b = el('button', 'qbtn ' + cls, text);
      if (ic) b.insertAdjacentHTML('afterbegin', icon(ic));
      b.addEventListener('click', fn);
      tools.appendChild(b);
      return b;
    };
    tool('Knopf', 'plus', () => newButton(key)).title = 'Neuen Befehlsknopf anlegen';
    tool('Menü', 'plus', () => openEditor(key, null, { kind: 'menu' })).title = 'Neues Ausklappmenü anlegen (mehrere Befehle unter einem Knopf)';
    tool('Vorlage', 'bolt', e => templateMenu(key, e.currentTarget)).title = 'Vorlage oder Knöpfe einer anderen Verbindung übernehmen';
    tool('Export', 'download', () => exportFile(key)).title = 'Knöpfe dieser Verbindung als JSON-Datei speichern';
    tool('Import', 'upload', () => importFile(key)).title = 'Knöpfe aus einer JSON-Datei übernehmen';
    tool('Fertig', '', stopEdit, 'primary');
    bar.appendChild(tools);
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

  function dropTarget(container, key, to, acceptsMenus) {
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
      move(key, from, { ...to, index });
    });
  }

  // Ziel-Liste: Gruppe { gi } oder Einträge eines Menüs { gi, ii }
  const listAt = (groups, c) => (c.ii == null ? groups[c.gi].items : groups[c.gi].items[c.ii].items);

  function move(key, from, to) {
    const groups = clone(groupsOf(key));
    const src = from.ei == null ? groups[from.gi].items : groups[from.gi].items[from.ii].items;
    const srcIndex = from.ei == null ? from.ii : from.ei;
    const target = to.newGroup ? [] : listAt(groups, to); // Ziel merken, bevor sich Positionen verschieben
    let index = to.index;
    if (target === src && srcIndex < index) index--;
    const [item] = src.splice(srcIndex, 1);
    if (!item) return;
    target.splice(index, 0, item);
    if (to.newGroup) groups.push({ id: uid(), items: target });
    setGroups(key, groups);
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
    const extra = item.type === 'menu' && item.items.length ? ` Die ${item.items.length} Einträge darin werden mitgelöscht.` : '';
    const ok = await askLocal({ kind: 'confirm', title: item.type === 'menu' ? 'Menü löschen?' : 'Knopf löschen?', message: `„${item.label}“ wirklich löschen?${extra}`, okLabel: 'Löschen', danger: true });
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
        message: `Diese Verbindung hat schon ${n === 1 ? 'einen Knopf' : `${n} Knöpfe`}. Neue Knöpfe hinten anhängen oder alle bisherigen ersetzen?`,
        options: [{ label: 'Abbrechen' }, { label: 'Anhängen', value: 'append' }, { label: 'Alle ersetzen', value: 'replace', cls: 'danger' }],
      });
      if (!mode) return;
    }
    await setGroups(key, mode === 'append' ? [...clone(current), ...incoming] : incoming);
    flash(`${countButtons(incoming)} Knöpfe übernommen`);
  }

  function templateMenu(key, btn) {
    const r = btn.getBoundingClientRect();
    const entries = [['Vorlage „s3cure“ (s3-Befehle)', () => applyGroups(key, withIds(TEMPLATES.s3cure.groups()), 'Vorlage „s3cure“ übernehmen'), '', 'bolt']];
    const others = Object.keys(profiles).filter(k => k !== key && countButtons(groupsOf(k))).sort((a, b) => a.localeCompare(b));
    if (others.length) entries.push(null);
    for (const k of others) entries.push([`Von „${k}“ kopieren`, () => applyGroups(key, withIds(groupsOf(k)), `Knöpfe von „${k}“ übernehmen`), '', 'server']);
    openMenu(entries, r.left, r.bottom + 4);
  }

  async function exportFile(key) {
    const groups = groupsOf(key);
    if (!countButtons(groups)) { showError('Diese Verbindung hat noch keine Knöpfe zum Exportieren.'); return; }
    try { const file = await api.snippetsExport(key, groups); if (file) flash(`Exportiert: ${file}`); }
    catch (err) { showError(err); }
  }

  async function importFile(key) {
    let groups;
    try { groups = await api.snippetsImport(); } catch (err) { showError(err); return; }
    if (groups) await applyGroups(key, groups, 'Knöpfe importieren');
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
        <label>Name auf dem Knopf<input name="label" required maxlength="80" placeholder="z. B. Neustart"></label>
        <label class="for-button">Befehl
          <textarea name="cmd" rows="3" spellcheck="false" placeholder="z. B. sudo systemctl restart nginx"></textarea>
        </label>
        <p class="snip-help for-button">Tipp: <code>{name}</code> im Befehl fragt beim Klick nach einer Eingabe, z. B. <code>s3 rollback {commit}</code>. Mehrere Zeilen laufen nacheinander.</p>
        <div class="snip-inputs for-button"></div>
        <label>Hinweis beim Darüberfahren <span class="muted">(optional)</span><input name="tip" maxlength="300"></label>
        <label class="toggle"><input type="checkbox" name="confirmOn"><span class="track"><span class="knob"></span></span>Vorher nachfragen</label>
        <input name="confirmText" class="snip-sub" maxlength="500" placeholder="Frage, z. B. Wirklich neu starten? (leer = Standardfrage)">
        <label class="toggle"><input type="checkbox" name="danger"><span class="track"><span class="knob"></span></span>Rot markieren (vorsichtig benutzen)</label>
        <label class="toggle for-button"><input type="checkbox" name="live"><span class="track"><span class="knob"></span></span>Läuft dauerhaft (z. B. Live-Log) – vor dem nächsten Knopf mit Strg+C beenden</label>
        <p class="snip-help for-menu">Die Rückfrage gilt für alle Einträge im Menü. Einträge bearbeitest du direkt in der Leiste: anklicken, ziehen oder mit ＋ hinzufügen.</p>
        <div class="actions">
          <button type="button" class="btn snip-delete">${icon('trash')}Löschen</button>
          <span class="spacer"></span>
          <button type="button" class="btn" data-x>Abbrechen</button>
          <button type="submit" class="btn primary">Speichern</button>
        </div>
      </form>`;
    document.body.appendChild(modal);
    const form = modal.querySelector('form');
    const ed = { modal, form, inputs: {} };
    const syncConfirm = () => { form.confirmText.hidden = !form.confirmOn.checked; };
    form.confirmOn.addEventListener('change', () => { syncConfirm(); if (form.confirmOn.checked) form.confirmText.focus(); });
    form.cmd.addEventListener('input', () => renderInputs(ed));
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

  // Für jeden Platzhalter im Befehl: Frage, erlaubte Eingabe, Vorschlag
  function renderInputs(ed) {
    const box = ed.form.querySelector('.snip-inputs');
    for (const row of box.querySelectorAll('.snip-input')) {
      ed.inputs[row.dataset.name] = { prompt: row.querySelector('[data-f=prompt]').value, kind: row.querySelector('[data-f=kind]').value, value: row.querySelector('[data-f=value]').value };
    }
    box.innerHTML = '';
    const names = placeholders(ed.form.cmd.value);
    if (!names.length) return;
    box.appendChild(el('div', 'snip-inputs-head', 'Eingaben, die beim Klick abgefragt werden'));
    for (const name of names) {
      const cur = ed.inputs[name] || { prompt: '', kind: 'ref', value: '' };
      const row = el('div', 'snip-input');
      row.dataset.name = name;
      const tag = el('code', '', `{${name}}`);
      const prompt = Object.assign(el('input'), { value: cur.prompt, placeholder: `Frage, z. B. Welcher ${name}?`, maxLength: 300 });
      prompt.dataset.f = 'prompt';
      const kind = el('select');
      kind.dataset.f = 'kind';
      kind.title = 'Was eingegeben werden darf – wird vor dem Ausführen geprüft';
      for (const [k, v] of Object.entries(INPUT_KINDS)) kind.appendChild(Object.assign(el('option', '', v.label), { value: k }));
      kind.value = INPUT_KINDS[cur.kind] ? cur.kind : 'ref';
      const value = Object.assign(el('input'), { value: cur.value, placeholder: 'Vorschlag (optional)', maxLength: 300 });
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
    Object.assign(ed, { key, path, kind, into: opts.into || null, inputs: clone(item?.inputs || {}) });
    const f = ed.form;
    f.reset();
    f.classList.toggle('is-menu', kind === 'menu');
    ed.modal.querySelector('h2').textContent = item
      ? (kind === 'menu' ? 'Menü bearbeiten' : inMenu ? 'Menü-Eintrag bearbeiten' : 'Knopf bearbeiten')
      : (kind === 'menu' ? 'Neues Menü' : inMenu ? 'Neuer Menü-Eintrag' : 'Neuer Knopf');
    f.label.value = item?.label || '';
    f.label.placeholder = kind === 'menu' ? 'z. B. Logs' : 'z. B. Neustart';
    f.cmd.value = item?.cmd || '';
    f.tip.value = item?.tip || '';
    f.confirmOn.checked = !!item?.confirm;
    f.confirmText.value = typeof item?.confirm === 'string' ? item.confirm : '';
    f.danger.checked = !!item?.danger;
    f.live.checked = !!item?.live;
    f.cmd.required = kind !== 'menu';
    ed.syncConfirm();
    renderInputs(ed);
    ed.modal.querySelector('.snip-delete').hidden = !item;
    ed.modal.hidden = false;
    f.label.focus();
  }

  function saveEditor(ed) {
    const f = ed.form;
    renderInputs(ed); // aktuelle Werte der Platzhalter einsammeln
    const label = f.label.value.trim();
    if (!label) { f.label.focus(); return; }
    const confirm = f.confirmOn.checked ? (f.confirmText.value.trim() || true) : false;
    const base = { label, tip: f.tip.value.trim(), confirm, danger: f.danger.checked };
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
    if (!ed.path && ed.kind === 'menu') startEdit(ed.key);
  }

  return { render, isLive, load, TEMPLATES };
})();
