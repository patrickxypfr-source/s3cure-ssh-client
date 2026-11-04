// Verbindungen-Pro: „Bekannte Server“, „SSH-Schlüssel“ und „Proxy“ als Bereiche in den Einstellungen,
// erreichbar auch über „Schlüssel & Server“ unten in der Seitenleiste.
// Im Host-Dialog: Agent-Weiterleitung und Proxy pro Verbindung (über hostFormHooks aus hosts-extra.js).
// Hauptprozess: app/lib/knownhosts.js, app/lib/keyring.js, app/lib/proxy.js (Brücke window.s3conn).
(() => {
  const conn = window.s3conn;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const iconBtn = (name, title, onClick, cls = '') => {
    const b = el('button', 'mini-btn ' + cls);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon(name);
    b.addEventListener('click', onClick);
    return b;
  };
  const fileManager = api.platform === 'darwin' ? 'Finder' : 'Explorer';

  Object.assign(ICON_PATHS, {
    key: 'M15.5 3a5.5 5.5 0 0 0-5.24 7.18L3 17.44V21h3.56l.94-.94V18h2.06l1.5-1.5v-2.06l.76-.76A5.5 5.5 0 1 0 15.5 3z M16.5 6.5h.01',
    shield: 'M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z M9 12l2 2 4-4',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z',
    copy: 'M9 9h10.5A1.5 1.5 0 0 1 21 10.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 9 19.5z M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5',
    send: 'M21 3L10 14 M21 3l-6.5 18-4-7.5L3 9.5z',
  });

  // ---------- Bekannte Server ----------

  function renderKnownHosts(box) {
    box.className = 'cp-pane';
    const top = el('div', 'cp-top');
    const search = el('input', 'cp-search');
    search.placeholder = 'Suchen: Server, Typ oder Fingerprint';
    search.spellcheck = false;
    const reload = iconBtn('refresh', 'Neu laden', () => load());
    top.append(search, reload);
    const list = el('ul', 'cp-list');
    const foot = el('p', 'cp-note');
    foot.textContent = 'Einträge aus ~/.myssh/known_hosts gehören zu dieser App und können entfernt werden. '
      + 'Einträge aus ~/.ssh/known_hosts gehören zu OpenSSH (Terminal) und werden hier nur angezeigt.';
    box.append(top, list, foot);

    let entries = [];
    let hashedHits = new Set();
    let matchTimer = null;

    async function load() {
      try { entries = await conn.knownList(); } catch (err) { showError(err); entries = []; }
      render();
    }

    function render() {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      const shown = entries.filter(e => !q || hashedHits.has(e.id)
        || [e.hosts || '', e.type, e.fingerprint, e.file].some(s => s.toLowerCase().includes(q)));
      if (!shown.length) {
        list.appendChild(el('li', 'cp-empty', entries.length ? 'Keine Treffer.' : 'Noch keine bekannten Server. Beim ersten Verbinden wird der Schlüssel des Servers hier gespeichert.'));
        return;
      }
      for (const e of shown) {
        const li = el('li', 'cp-item');
        const main = el('div', 'cp-main');
        const title = el('div', 'cp-title');
        title.append(el('span', 'cp-name', e.hosts || 'Verschlüsselter Name'));
        if (e.hashed) title.title = 'OpenSSH speichert den Namen nur verschlüsselt. Tipp den Server ins Suchfeld, um ihn zu finden.';
        title.append(el('span', 'cp-badge', e.type.replace(/^ssh-/, '')));
        const fp = el('div', 'cp-fp', e.fingerprint);
        fp.title = 'Fingerprint (SHA256)';
        const meta = el('div', 'cp-meta', `aus ${e.file}`);
        main.append(title, fp, meta);
        li.appendChild(main);
        if (e.writable) {
          li.appendChild(iconBtn('trash', 'Entfernen', () => removeEntry(e), 'danger'));
        } else {
          const ro = el('span', 'cp-ro');
          ro.innerHTML = icon('lock');
          ro.title = 'Nur lesen – gehört zu OpenSSH. Entfernen im Terminal mit: ssh-keygen -R <server>';
          li.appendChild(ro);
        }
        list.appendChild(li);
      }
    }

    async function removeEntry(e) {
      const ok = await askLocal({
        kind: 'confirm', title: 'Bekannten Server entfernen?',
        message: `Den gespeicherten Schlüssel von „${e.hosts || 'verschlüsselter Name'}“ entfernen?`,
        detail: `${e.type} ${e.fingerprint}\n\nBeim nächsten Verbinden fragt die App wieder, ob du dem Server vertraust.`,
        okLabel: 'Entfernen', danger: true,
      });
      if (!ok) return;
      try { entries = await conn.knownRemove(e.id, e.key); flash('Eintrag entfernt'); } catch (err) { showError(err); await load(); return; }
      render();
    }

    search.addEventListener('input', () => {
      render();
      clearTimeout(matchTimer);
      const q = search.value.trim();
      matchTimer = setTimeout(async () => {
        hashedHits = new Set(q && entries.some(e => e.hashed) ? await conn.knownMatch(q).catch(() => []) : []);
        render();
      }, 250);
    });
    search.addEventListener('keydown', e => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; render(); } });
    load();
  }

  // ---------- SSH-Schlüssel ----------

  function renderKeys(box) {
    box.className = 'cp-pane';
    const top = el('div', 'cp-top');
    const gen = el('button', 'btn primary', 'Neuen Schlüssel erzeugen');
    gen.type = 'button';
    gen.insertAdjacentHTML('afterbegin', icon('plus'));
    gen.addEventListener('click', () => generate());
    top.append(gen, el('div', 'spacer'), iconBtn('refresh', 'Neu laden', () => load()));
    const list = el('ul', 'cp-list');
    const note = el('p', 'cp-note', 'Gezeigt werden Schlüssel aus ~/.ssh, zu denen es eine .pub-Datei gibt. '
      + 'Der private Teil bleibt immer auf diesem Computer – kopiert oder übertragen wird nur der öffentliche Schlüssel.');
    box.append(top, list, note);
    let keys = [];

    async function load() {
      try { keys = await conn.keysList(); } catch (err) { showError(err); keys = []; }
      render();
    }

    function render() {
      list.innerHTML = '';
      if (!keys.length) {
        list.appendChild(el('li', 'cp-empty', 'Noch keine SSH-Schlüssel gefunden. Mit „Neuen Schlüssel erzeugen“ legst du einen an.'));
        return;
      }
      for (const k of keys) {
        const li = el('li', 'cp-item');
        const main = el('div', 'cp-main');
        const title = el('div', 'cp-title');
        title.append(el('span', 'cp-name', k.name), el('span', 'cp-badge', k.typeName));
        if (!k.hasPrivate) title.append(el('span', 'cp-badge warn', 'nur öffentlich'));
        else if (k.passphrase === true) title.append(el('span', 'cp-badge ok', 'mit Passphrase'));
        else if (k.passphrase === false) title.append(el('span', 'cp-badge', 'ohne Passphrase'));
        const fp = el('div', 'cp-fp', k.fingerprint);
        const meta = el('div', 'cp-meta', [k.file, k.comment].filter(Boolean).join(' · '));
        main.append(title, fp, meta);
        const btns = el('div', 'cp-btns');
        btns.append(
          iconBtn('copy', 'Öffentlichen Schlüssel kopieren', async () => {
            try { await conn.keyCopy(k.file); flash('Öffentlicher Schlüssel kopiert'); } catch (err) { showError(err); }
          }),
          iconBtn('folder', `Im ${fileManager} zeigen`, () => conn.keyShow(k.file).catch(showError)),
        );
        if (k.hasPrivate) btns.append(iconBtn('send', 'Auf Server übertragen …', ev => pickHost(k, ev)));
        li.append(main, btns);
        list.appendChild(li);
      }
    }

    function pickHost(k, ev) {
      const names = Object.keys(hosts).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
      if (!names.length) { askLocal({ kind: 'info', title: 'Keine Verbindungen', message: 'Lege zuerst eine Verbindung an.' }); return; }
      const r = ev.currentTarget.getBoundingClientRect();
      openMenu(names.map(n => [`${n}  (${hosts[n].host})`, () => install(k, n), '', 'server']), r.left, r.bottom + 4);
    }

    async function install(k, name) {
      const ok = await askLocal({
        kind: 'confirm', title: 'Schlüssel auf Server übertragen',
        message: `Den öffentlichen Schlüssel „${k.name}“ auf „${name}“ eintragen? Danach meldest du dich dort ohne Passwort an.`,
        detail: `${k.typeName} ${k.fingerprint}\nAuf dem Server: ~/.ssh/authorized_keys (wird nur ergänzt)`,
        okLabel: 'Übertragen',
      });
      if (!ok) return;
      flash(`Trage Schlüssel auf „${name}“ ein …`, 40);
      try {
        const r = await conn.keyInstall(k.file, name);
        flash(r.already ? 'Schlüssel war schon eingetragen' : 'Schlüssel eingetragen');
        await refreshHosts();
        if (r.tested) askLocal({ kind: 'info', title: 'Fertig', message: `Anmeldung ohne Passwort für „${name}“ ist eingerichtet.`, detail: `Die Verbindung nutzt jetzt den Schlüssel ${r.key}.` });
        else askLocal({ kind: 'info', title: 'Schlüssel eingetragen, Test fehlgeschlagen', message: 'Der Schlüssel steht jetzt auf dem Server, aber die Anmeldung damit hat nicht geklappt.', detail: r.testError || '' });
      } catch (err) { $('#progress').hidden = true; showError(err); }
    }

    async function generate() {
      const hasDefault = keys.some(k => k.name === 's3cure_ed25519');
      const name = await askLocal({
        kind: 'text', title: 'Neuen Schlüssel erzeugen',
        message: 'Name für den Schlüssel (Typ Ed25519). Er wird in ~/.ssh gespeichert und beginnt mit „s3cure_“.',
        value: hasDefault ? '' : 'ed25519', placeholder: 'z. B. arbeit', okLabel: 'Weiter',
      });
      if (name == null) return;
      const clean = name.trim().replace(/^s3cure_/, '') || 'ed25519';
      const pass = await askLocal({
        kind: 'secret', title: 'Schlüssel mit Passphrase schützen?',
        message: 'Optional. Leer lassen = ohne Passphrase (bequemer; wer an diesen Rechner kommt, kann den Schlüssel aber benutzen).',
        placeholder: 'Leer lassen = keine Passphrase', remember: true, rememberLabel: 'Passphrase merken (verschlüsselt)',
        okLabel: 'Schlüssel erzeugen',
      });
      if (pass == null) return;
      try {
        const st = await conn.keyGenerate(clean === 'ed25519' ? '' : clean, pass.value, pass.remember);
        flash(`Schlüssel ${st.path} erzeugt`);
      } catch (err) { showError(err); }
      await load();
    }

    load();
  }

  // ---------- Proxy (Formular für global und pro Verbindung) ----------

  // Felder: Art, Adresse, Port, Benutzer, Passwort. Gibt { root, get(), set(p), password(), validate() } zurück.
  function proxyFields({ withDefault }) {
    const root = el('div', 'cp-proxy');
    const typeSel = el('select');
    const options = withDefault
      ? [['', 'Standard (wie in den Einstellungen)'], ['none', 'Kein Proxy – direkt verbinden'], ['socks5', 'SOCKS5-Proxy'], ['http', 'HTTP-Proxy (CONNECT)']]
      : [['none', 'Kein Proxy – direkt verbinden'], ['socks5', 'SOCKS5-Proxy'], ['http', 'HTTP-Proxy (CONNECT)']];
    for (const [v, t] of options) typeSel.appendChild(new Option(t, v));
    const details = el('div', 'cp-proxy-details');
    const mk = (labelText, attrs, cls = '') => {
      const l = el('label', cls);
      l.append(labelText);
      const i = el('input');
      Object.assign(i, { spellcheck: false, autocomplete: 'off' }, attrs);
      l.appendChild(i);
      return [l, i];
    };
    const [hostL, hostI] = mk('Proxy-Adresse', { placeholder: 'proxy.firma.de' }, 'grow');
    const [portL, portI] = mk('Port', { type: 'number', min: 1, max: 65535, placeholder: '1080' }, 'port');
    const [userL, userI] = mk('Benutzer ', { placeholder: 'leer = ohne Anmeldung' }, 'grow');
    userL.insertBefore(el('span', 'muted', '(optional)'), userI);
    const [pwL, pwI] = mk('Passwort', { type: 'password', autocomplete: 'new-password' }, 'grow');
    const r1 = el('div', 'row'); r1.append(hostL, portL);
    const r2 = el('div', 'row'); r2.append(userL, pwL);
    details.append(r1, r2);
    root.append(typeSel, details);

    const sync = () => {
      const on = typeSel.value === 'socks5' || typeSel.value === 'http';
      details.hidden = !on;
      hostI.required = on;
      portI.placeholder = typeSel.value === 'http' ? '8080' : '1080';
      pwL.hidden = !userI.value.trim();
    };
    // Pflichtfeld im zugeklappten Bereich: erst aufklappen, damit der Hinweis sichtbar ist
    hostI.addEventListener('invalid', () => { const d = root.closest('details'); if (d) d.open = true; });
    typeSel.addEventListener('change', sync);
    userI.addEventListener('input', sync);

    return {
      root, typeSel,
      get() {
        const t = typeSel.value;
        if (t !== 'socks5' && t !== 'http') return t; // '' oder 'none'
        return { type: t, host: hostI.value.trim(), port: Number(portI.value) || (t === 'http' ? 8080 : 1080), user: userI.value.trim() };
      },
      async set(p) {
        typeSel.value = p && typeof p === 'object' ? p.type : (p || (withDefault ? '' : 'none'));
        hostI.value = p && p.host || '';
        portI.value = p && p.port || '';
        userI.value = p && p.user || '';
        pwI.value = '';
        pwI.placeholder = '';
        sync();
        if (p && typeof p === 'object' && p.user) {
          const has = await conn.proxyHasPassword(p).catch(() => false);
          pwI.placeholder = has ? '•••••••• gespeichert' : 'Wird beim Verbinden abgefragt';
        }
      },
      password: () => (userI.value.trim() ? pwI.value : ''),
      validate() {
        const t = typeSel.value;
        if ((t === 'socks5' || t === 'http') && !hostI.value.trim()) { hostI.focus(); return false; }
        return true;
      },
    };
  }

  function renderProxy(box) {
    box.className = 'cp-pane';
    const intro = el('p', 'cp-note', 'Gilt für alle Verbindungen, bei denen im Verbindungs-Dialog „Standard“ eingestellt ist. '
      + 'Mit Sprung-Server geht nur die Verbindung zum ersten Server über den Proxy.');
    const f = proxyFields({ withDefault: false });
    const actions = el('div', 'cp-top');
    const test = el('button', 'btn', 'Testen');
    test.type = 'button';
    const save = el('button', 'btn primary', 'Speichern');
    save.type = 'button';
    actions.append(el('div', 'spacer'), test, save);
    box.append(intro, f.root, actions);
    conn.proxyGet().then(p => f.set(p || 'none')).catch(showError);

    save.addEventListener('click', async () => {
      if (!f.validate()) return;
      const p = f.get();
      try {
        await conn.proxySet(typeof p === 'object' ? p : null, f.password());
        await f.set((await conn.proxyGet()) || 'none');
        flash(typeof p === 'object' ? 'Proxy gespeichert' : 'Kein Proxy – direkte Verbindungen');
      } catch (err) { showError(err); }
    });

    test.addEventListener('click', async () => {
      if (!f.validate()) return;
      const p = f.get();
      if (typeof p !== 'object') { askLocal({ kind: 'info', title: 'Kein Proxy', message: 'Wähle zuerst SOCKS5 oder HTTP.' }); return; }
      const first = Object.values(hosts)[0];
      const where = await askLocal({
        kind: 'text', title: 'Proxy testen', message: 'Welcher Server soll über den Proxy erreicht werden? (Adresse:Port)',
        value: first ? `${first.host}:${first.port || 22}` : '', placeholder: 'server.de:22', okLabel: 'Testen',
      });
      if (!where) return;
      const m = /^(.+?)(?::(\d+))?$/.exec(where.trim().replace(/^\[(.+)\]/, '$1'));
      flash('Teste Proxy …', 40);
      try {
        const r = await conn.proxyTest(p, f.password(), m[1], Number(m[2]) || 22);
        flash('Proxy funktioniert');
        askLocal({ kind: 'info', title: 'Proxy funktioniert', message: `${where} ist über den Proxy erreichbar.`, detail: r.banner ? `Antwort des Servers: ${r.banner}` : '' });
      } catch (err) { $('#progress').hidden = true; showError(err); }
    });
  }

  // ---------- Einstellungen + Seitenleiste ----------

  registerSettingsSection({
    id: 'knownhosts', title: 'Bekannte Server', icon: 'shield', order: 60,
    description: 'Die Schlüssel der Server, denen du vertraust. Meldet sich ein Server später mit einem anderen Schlüssel, warnt die App.',
    render: renderKnownHosts,
  });
  registerSettingsSection({
    id: 'sshkeys', title: 'SSH-Schlüssel', icon: 'key', order: 61,
    description: 'Mit einem Schlüssel meldest du dich ohne Passwort an.',
    render: renderKeys,
  });
  registerSettingsSection({
    id: 'proxy', title: 'Proxy', icon: 'globe', order: 62,
    description: 'Verbindungen über einen Proxy-Server leiten, z. B. im Firmennetz.',
    render: renderProxy,
  });

  const foot = document.getElementById('sidebar-foot');
  if (foot) {
    const b = el('button', 'foot-btn');
    b.id = 'open-conn-pro';
    b.type = 'button';
    b.title = 'Bekannte Server, SSH-Schlüssel und Proxy';
    b.innerHTML = icon('key');
    b.append('Schlüssel & Server');
    b.addEventListener('click', () => {
      const r = b.getBoundingClientRect();
      openMenu([
        ['Bekannte Server …', () => Settings.open('knownhosts'), '', 'shield'],
        ['SSH-Schlüssel …', () => Settings.open('sshkeys'), '', 'key'],
        ['Proxy …', () => Settings.open('proxy'), '', 'globe'],
      ], r.left, r.top - 4 - 3 * 32);
    });
    foot.insertBefore(b, foot.firstChild);
  }

  // ---------- Host-Dialog: Agent-Weiterleitung und Proxy ----------

  const form = document.getElementById('host-form');
  const anchor = document.getElementById('conn-pro-fields');
  if (form && anchor) {
    const wrap = el('details', 'cp-host');
    const sum = el('summary', '', 'Erweitert: Agent-Weiterleitung, Proxy');
    wrap.appendChild(sum);

    const agentRow = el('div', 'cp-agent');
    const toggle = el('label', 'toggle');
    toggle.innerHTML = '<input type="checkbox" name="agentForward"><span class="track"><span class="knob"></span></span>';
    toggle.append('Agent-Weiterleitung');
    const hint = el('p', 'cp-hint', 'Damit kann der Server deinen lokalen SSH-Schlüssel benutzen, z. B. für „git pull“ dort. '
      + 'Nur bei Servern einschalten, denen du vertraust: Wer dort Administrator ist, kann deinen Schlüssel benutzen, solange du verbunden bist. '
      + 'Der Schlüssel muss im SSH-Agent geladen sein (ssh-add).');
    agentRow.append(toggle, hint);

    const proxyLabel = el('div', 'cp-label', 'Proxy');
    const pf = proxyFields({ withDefault: true });
    wrap.append(agentRow, proxyLabel, pf.root);
    anchor.appendChild(wrap);

    hostFormHooks.push({
      fill(f, name) {
        const h = (name && hosts[name]) || {};
        f.agentForward.checked = !!h.agentForward;
        pf.set(h.proxy || '');
        wrap.open = !!(h.agentForward || h.proxy);
      },
      read() {
        const p = pf.get();
        if (!pf.validate()) wrap.open = true;
        return { agentForward: form.agentForward.checked, proxy: p, proxyPassword: pf.password() };
      },
    });
  }
})();
