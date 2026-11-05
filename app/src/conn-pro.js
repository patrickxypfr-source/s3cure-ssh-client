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
    search.placeholder = t('connPro.knownSearch');
    search.spellcheck = false;
    const reload = iconBtn('refresh', t('connPro.reload'), () => load());
    top.append(search, reload);
    const list = el('ul', 'cp-list');
    const foot = el('p', 'cp-note');
    foot.textContent = t('connPro.knownNote');
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
        list.appendChild(el('li', 'cp-empty', entries.length ? t('connPro.noHits') : t('connPro.knownEmpty')));
        return;
      }
      for (const e of shown) {
        const li = el('li', 'cp-item');
        const main = el('div', 'cp-main');
        const title = el('div', 'cp-title');
        title.append(el('span', 'cp-name', e.hosts || t('connPro.hashedName')));
        if (e.hashed) title.title = t('connPro.hashedTip');
        title.append(el('span', 'cp-badge', e.type.replace(/^ssh-/, '')));
        const fp = el('div', 'cp-fp', e.fingerprint);
        fp.title = t('connPro.fingerprintTitle');
        const meta = el('div', 'cp-meta', t('connPro.fromFile', { file: e.file }));
        main.append(title, fp, meta);
        li.appendChild(main);
        if (e.writable) {
          li.appendChild(iconBtn('trash', t('common.remove'), () => removeEntry(e), 'danger'));
        } else {
          const ro = el('span', 'cp-ro');
          ro.innerHTML = icon('lock');
          ro.title = t('connPro.readOnlyTip');
          li.appendChild(ro);
        }
        list.appendChild(li);
      }
    }

    async function removeEntry(e) {
      const ok = await askLocal({
        kind: 'confirm', title: t('connPro.removeKnownTitle'),
        message: t('connPro.removeKnownMsg', { name: e.hosts || t('connPro.hashedNameLower') }),
        detail: `${e.type} ${e.fingerprint}\n\n${t('connPro.removeKnownDetail')}`,
        okLabel: t('common.remove'), danger: true,
      });
      if (!ok) return;
      try { entries = await conn.knownRemove(e.id, e.key); flash(t('connPro.entryRemoved')); } catch (err) { showError(err); await load(); return; }
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
    const gen = el('button', 'btn primary', t('connPro.genKey'));
    gen.type = 'button';
    gen.insertAdjacentHTML('afterbegin', icon('plus'));
    gen.addEventListener('click', () => generate());
    top.append(gen, el('div', 'spacer'), iconBtn('refresh', t('connPro.reload'), () => load()));
    const list = el('ul', 'cp-list');
    const note = el('p', 'cp-note', t('connPro.keysNote'));
    box.append(top, list, note);
    let keys = [];

    async function load() {
      try { keys = await conn.keysList(); } catch (err) { showError(err); keys = []; }
      render();
    }

    function render() {
      list.innerHTML = '';
      if (!keys.length) {
        list.appendChild(el('li', 'cp-empty', t('connPro.keysEmpty')));
        return;
      }
      for (const k of keys) {
        const li = el('li', 'cp-item');
        const main = el('div', 'cp-main');
        const title = el('div', 'cp-title');
        title.append(el('span', 'cp-name', k.name), el('span', 'cp-badge', k.typeName));
        if (!k.hasPrivate) title.append(el('span', 'cp-badge warn', t('connPro.publicOnly')));
        else if (k.passphrase === true) title.append(el('span', 'cp-badge ok', t('connPro.withPassphrase')));
        else if (k.passphrase === false) title.append(el('span', 'cp-badge', t('connPro.withoutPassphrase')));
        const fp = el('div', 'cp-fp', k.fingerprint);
        const meta = el('div', 'cp-meta', [k.file, k.comment].filter(Boolean).join(' · '));
        main.append(title, fp, meta);
        const btns = el('div', 'cp-btns');
        btns.append(
          iconBtn('copy', t('connPro.copyPublic'), async () => {
            try { await conn.keyCopy(k.file); flash(t('connPro.publicCopied')); } catch (err) { showError(err); }
          }),
          iconBtn('folder', t('connPro.showIn', { app: fileManager }), () => conn.keyShow(k.file).catch(showError)),
        );
        if (k.hasPrivate) btns.append(iconBtn('send', t('connPro.installTo'), ev => pickHost(k, ev)));
        li.append(main, btns);
        list.appendChild(li);
      }
    }

    function pickHost(k, ev) {
      const names = Object.keys(hosts).sort((a, b) => a.localeCompare(b, I18N.locale, { sensitivity: 'base' }));
      if (!names.length) { askLocal({ kind: 'info', title: t('connPro.noHostsTitle'), message: t('connPro.noHostsMsg') }); return; }
      const r = ev.currentTarget.getBoundingClientRect();
      openMenu(names.map(n => [`${n}  (${hosts[n].host})`, () => install(k, n), '', 'server']), r.left, r.bottom + 4);
    }

    async function install(k, name) {
      const ok = await askLocal({
        kind: 'confirm', title: t('connPro.installTitle'),
        message: t('connPro.installMsg', { key: k.name, host: name }),
        detail: `${k.typeName} ${k.fingerprint}\n${t('connPro.installDetail')}`,
        okLabel: t('connPro.installOk'),
      });
      if (!ok) return;
      flash(t('connPro.installing', { host: name }), 40);
      try {
        const r = await conn.keyInstall(k.file, name);
        flash(r.already ? t('connPro.alreadyInstalled') : t('connPro.installed'));
        await refreshHosts();
        if (r.tested) askLocal({ kind: 'info', title: t('common.done'), message: t('connPro.installedMsg', { host: name }), detail: t('connPro.installedDetail', { key: r.key }) });
        else askLocal({ kind: 'info', title: t('connPro.testFailedTitle'), message: t('connPro.testFailedMsg'), detail: r.testError || '' });
      } catch (err) { $('#progress').hidden = true; showError(err); }
    }

    async function generate() {
      const hasDefault = keys.some(k => k.name === 's3cure_ed25519');
      const name = await askLocal({
        kind: 'text', title: t('connPro.genKey'),
        message: t('connPro.genMsg'),
        value: hasDefault ? '' : 'ed25519', placeholder: t('connPro.genPlaceholder'), okLabel: t('common.next'),
      });
      if (name == null) return;
      const clean = name.trim().replace(/^s3cure_/, '') || 'ed25519';
      const pass = await askLocal({
        kind: 'secret', title: t('connPro.passTitle'),
        message: t('connPro.passMsg'),
        placeholder: t('connPro.passPlaceholder'), remember: true, rememberLabel: t('connPro.rememberPassphrase'),
        okLabel: t('connPro.genOk'),
      });
      if (pass == null) return;
      try {
        const st = await conn.keyGenerate(clean === 'ed25519' ? '' : clean, pass.value, pass.remember);
        flash(t('connPro.generated', { path: st.path }));
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
      ? [['', t('connPro.proxyDefault')], ['none', t('connPro.proxyNone')], ['socks5', t('connPro.proxySocks')], ['http', t('connPro.proxyHttp')]]
      : [['none', t('connPro.proxyNone')], ['socks5', t('connPro.proxySocks')], ['http', t('connPro.proxyHttp')]];
    for (const [v, label] of options) typeSel.appendChild(new Option(label, v));
    const details = el('div', 'cp-proxy-details');
    const mk = (labelText, attrs, cls = '') => {
      const l = el('label', cls);
      l.append(labelText);
      const i = el('input');
      Object.assign(i, { spellcheck: false, autocomplete: 'off' }, attrs);
      l.appendChild(i);
      return [l, i];
    };
    const [hostL, hostI] = mk(t('connPro.proxyAddress'), { placeholder: t('connPro.proxyHostPlaceholder') }, 'grow');
    const [portL, portI] = mk(t('connPro.port'), { type: 'number', min: 1, max: 65535, placeholder: '1080' }, 'port');
    const [userL, userI] = mk(t('connPro.user') + ' ', { placeholder: t('connPro.userPlaceholder') }, 'grow');
    userL.insertBefore(el('span', 'muted', t('common.optional')), userI);
    const [pwL, pwI] = mk(t('connPro.password'), { type: 'password', autocomplete: 'new-password' }, 'grow');
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
          pwI.placeholder = has ? t('connPro.passwordSaved') : t('connPro.passwordAsk');
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
    const intro = el('p', 'cp-note', t('connPro.proxyIntro'));
    const f = proxyFields({ withDefault: false });
    const actions = el('div', 'cp-top');
    const test = el('button', 'btn', t('connPro.test'));
    test.type = 'button';
    const save = el('button', 'btn primary', t('common.save'));
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
        flash(typeof p === 'object' ? t('connPro.proxySaved') : t('connPro.proxyOff'));
      } catch (err) { showError(err); }
    });

    test.addEventListener('click', async () => {
      if (!f.validate()) return;
      const p = f.get();
      if (typeof p !== 'object') { askLocal({ kind: 'info', title: t('connPro.noProxyTitle'), message: t('connPro.noProxyMsg') }); return; }
      const first = Object.values(hosts)[0];
      const where = await askLocal({
        kind: 'text', title: t('connPro.testTitle'), message: t('connPro.testMsg'),
        value: first ? `${first.host}:${first.port || 22}` : '', placeholder: t('connPro.testPlaceholder'), okLabel: t('connPro.test'),
      });
      if (!where) return;
      const m = /^(.+?)(?::(\d+))?$/.exec(where.trim().replace(/^\[(.+)\]/, '$1'));
      flash(t('connPro.testing'), 40);
      try {
        const r = await conn.proxyTest(p, f.password(), m[1], Number(m[2]) || 22);
        flash(t('connPro.works'));
        askLocal({ kind: 'info', title: t('connPro.works'), message: t('connPro.reachable', { where }), detail: r.banner ? t('connPro.banner', { banner: r.banner }) : '' });
      } catch (err) { $('#progress').hidden = true; showError(err); }
    });
  }

  // ---------- Einstellungen + Seitenleiste ----------

  registerSettingsSection({
    id: 'knownhosts', title: t('connPro.knownTitle'), icon: 'shield', order: 60,
    description: t('connPro.knownDesc'),
    render: renderKnownHosts,
  });
  registerSettingsSection({
    id: 'sshkeys', title: t('connPro.keysTitle'), icon: 'key', order: 61,
    description: t('connPro.keysDesc'),
    render: renderKeys,
  });
  registerSettingsSection({
    id: 'proxy', title: t('connPro.proxyTitle'), icon: 'globe', order: 62,
    description: t('connPro.proxyDesc'),
    render: renderProxy,
  });

  const foot = document.getElementById('sidebar-foot');
  if (foot) {
    const b = el('button', 'foot-btn');
    b.id = 'open-conn-pro';
    b.type = 'button';
    b.title = t('connPro.footTitle');
    b.innerHTML = icon('key');
    b.append(t('connPro.footLabel'));
    b.addEventListener('click', () => {
      const r = b.getBoundingClientRect();
      const items = [
        // Tresor für Zugangsdaten: src/vault.js
        ...(window.Vault ? [[t('vault.menu'), () => Settings.open('vault'), '', 'vault']] : []),
        [t('connPro.menuKnown'), () => Settings.open('knownhosts'), '', 'shield'],
        [t('connPro.menuKeys'), () => Settings.open('sshkeys'), '', 'key'],
        [t('connPro.menuProxy'), () => Settings.open('proxy'), '', 'globe'],
      ];
      openMenu(items, r.left, r.top - 4 - items.length * 32);
    });
    foot.insertBefore(b, foot.firstChild);
  }

  // ---------- Host-Dialog: Agent-Weiterleitung und Proxy ----------

  const form = document.getElementById('host-form');
  const anchor = document.getElementById('conn-pro-fields');
  if (form && anchor) {
    const wrap = el('details', 'cp-host');
    const sum = el('summary', '', t('connPro.hostAdvanced'));
    wrap.appendChild(sum);

    const agentRow = el('div', 'cp-agent');
    const toggle = el('label', 'toggle');
    toggle.innerHTML = '<input type="checkbox" name="agentForward"><span class="track"><span class="knob"></span></span>';
    toggle.append(t('connPro.agentForward'));
    const hint = el('p', 'cp-hint', t('connPro.agentHint'));
    agentRow.append(toggle, hint);

    const proxyLabel = el('div', 'cp-label', t('connPro.proxyLabel'));
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
