// S3cure SSH Client – Ansicht „Desktop“: Remote Desktop über VNC, getunnelt durch die SSH-Verbindung.
// Bild und Eingaben macht noVNC (src/vnc-loader.js). Der Hauptprozess (app/lib/vnc.js) öffnet den Kanal
// zum VNC-Server über SSH und eine WebSocket-Brücke nur auf 127.0.0.1 mit Einmal-Token.
// Eingehängt in renderer.js über Desktop.update(tab), Desktop.detach(tab) und Desktop.block(tab) (setView).
// Im Host-Dialog: Abschnitt „Remote Desktop (VNC)“ über hostFormHooks (hosts-extra.js).
window.Desktop = (() => {
  const V = window.s3vnc;
  const states = new Map(); // Tab-ID -> Zustand der Ansicht
  // Bildqualität -> noVNC (JPEG-Qualität 0–9, Kompression 0–9)
  const QUALITY = { best: { q: 9, c: 1 }, balanced: { q: 6, c: 2 }, low: { q: 2, c: 9 } };
  const DEFAULTS = { enabled: false, host: 'localhost', port: 5900, quality: 'balanced', viewOnly: false, scale: 'fit' };

  Object.assign(ICON_PATHS, {
    desktop: ICON_PATHS.desktop || 'M4.5 4.5h15A1.5 1.5 0 0 1 21 6v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15.5V6a1.5 1.5 0 0 1 1.5-1.5z M9 21h6 M12 17v4',
    eye: ICON_PATHS.eye || 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    fullscreen: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
    keyboard: 'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10',
    clipboard: 'M9 3.5h6v3H9z M9 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H15',
    plug: 'M9 3v5 M15 3v5 M6.5 8h11v3a5.5 5.5 0 0 1-11 0z M12 16.5V21',
    fitScreen: 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8 M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8 M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16 M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16 M9 9h6v6H9z',
  });

  // noVNC wird als Modul geladen (kommt nach den normalen Skripten)
  const rfbReady = new Promise(res => {
    if (window.NoVncRFB) res(window.NoVncRFB);
    else window.addEventListener('novnc-ready', () => res(window.NoVncRFB), { once: true });
  });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const errMsg = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const isFtp = tab => !!window.FtpUi?.isFtpTab(tab);
  const hostName = tab => (tab?.spec?.name && hosts[tab.spec.name] ? tab.spec.name : null);
  const settingsOf = tab => ({ ...DEFAULTS, ...(hostName(tab) ? hosts[hostName(tab)].vnc || {} : {}) });
  const fmtTarget = s => `${String(s.host).includes(':') ? `[${s.host}]` : s.host}:${s.port}`;

  function btn(ic, text, title, fn, cls = '') {
    const b = el('button', 'btn ' + cls);
    b.type = 'button';
    b.innerHTML = icon(ic);
    if (text) b.append(el('span', 'vnc-btn-text', text));
    b.title = title || text || '';
    b.setAttribute('aria-label', b.title);
    b.addEventListener('click', fn);
    return b;
  }

  // ---------- Umschalter Terminal / Dateien / Übersicht / Desktop ----------

  const viewBtn = el('button');
  viewBtn.dataset.view = 'desktop';
  viewBtn.dataset.icon = 'desktop';
  viewBtn.textContent = t('vnc.view');
  viewBtn.title = t('vnc.viewTitle');
  viewBtn.insertAdjacentHTML('afterbegin', icon('desktop'));
  document.getElementById('view-switch').appendChild(viewBtn);
  viewBtn.addEventListener('click', () => setView('desktop'));

  // FTP: kein Remote Desktop (setView fragt hier nach)
  function block(tab) {
    if (!isFtp(tab)) return false;
    flash(t('vnc.ftpOnly'));
    return true;
  }

  // ---------- Aufbau pro Tab ----------

  function build(tab) {
    const root = el('div', 'vnc');
    root.hidden = true;
    const head = el('div', 'vnc-head');
    const status = el('div', 'vnc-status');
    status.append(el('span', 'vnc-dot'), el('span', 'vnc-status-text'));
    const tools = el('div', 'vnc-tools');

    const st = {
      tab, root, rfb: null, status: 'idle', error: '', name: '', target: '', scan: null, scanning: false,
      autoTried: false, wantConnected: false, userClosed: false, badStored: false, viewOnly: null, scale: null,
    };

    const scaleSeg = el('div', 'seg vnc-scale');
    const fitB = btn('fitScreen', t('vnc.scaleFit'), t('vnc.scaleFitTitle'), () => setScale(st, 'fit'));
    fitB.dataset.scale = 'fit';
    const realB = btn('search', t('vnc.scaleReal'), t('vnc.scaleRealTitle'), () => setScale(st, 'real'));
    realB.dataset.scale = 'real';
    scaleSeg.append(fitB, realB);

    const viewOnlyB = btn('eye', t('vnc.viewOnly'), t('vnc.viewOnlyTitle'), () => setViewOnly(st, !currentViewOnly(st)), 'ghost vnc-viewonly');
    const cadB = btn('keyboard', t('vnc.cad'), t('vnc.cadTitle'), () => { st.rfb?.sendCtrlAltDel(); st.rfb?.focus(); }, 'ghost');
    cadB.dataset.a = 'cad';
    const clipB = btn('clipboard', t('vnc.clipSend'), t('vnc.clipSendTitle'), () => sendClipboard(st), 'ghost');
    clipB.dataset.a = 'clip';
    const kbB = btn('keyboard', '', t('vnc.keyboardHelp'), () => keyboardHelp(), 'ghost vnc-icon');
    kbB.innerHTML = '?';
    kbB.classList.add('vnc-help');
    const fsB = btn('fullscreen', '', t('vnc.fullscreen'), () => toggleFullscreen(st), 'ghost vnc-icon');
    fsB.dataset.a = 'fullscreen';
    const connB = btn('plug', t('vnc.connect'), '', () => (st.rfb ? disconnect(st) : connect(st)), 'primary');
    connB.dataset.a = 'connect';
    tools.append(scaleSeg, viewOnlyB, cadB, clipB, kbB, fsB, connB);
    head.append(status, el('span', 'spacer'), tools);

    const body = el('div', 'vnc-body');
    const screen = el('div', 'vnc-screen');
    const panel = el('div', 'vnc-panel');
    body.append(screen, panel);
    root.append(head, body);
    document.getElementById('terminals').appendChild(root);

    Object.assign(st, { head, screen, panel, scaleSeg, viewOnlyB, cadB, clipB, fsB, connB });
    root.addEventListener('fullscreenchange', () => { root.classList.toggle('vnc-full', document.fullscreenElement === root); st.rfb?.focus(); });
    return st;
  }

  const currentViewOnly = st => (st.viewOnly != null ? st.viewOnly : settingsOf(st.tab).viewOnly);
  const currentScale = st => st.scale || settingsOf(st.tab).scale;

  function setScale(st, scale) {
    st.scale = scale;
    if (st.rfb) { st.rfb.scaleViewport = scale === 'fit'; st.rfb.clipViewport = false; }
    render(st);
    st.rfb?.focus();
  }

  function setViewOnly(st, on) {
    st.viewOnly = on;
    if (st.rfb) st.rfb.viewOnly = on;
    render(st);
    flash(t(on ? 'vnc.viewOnlyOn' : 'vnc.viewOnlyOff'));
  }

  function toggleFullscreen(st) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else st.root.requestFullscreen().catch(err => showError(err));
  }

  async function sendClipboard(st) {
    if (!st.rfb) return;
    let text = '';
    try { text = await V.clipboardRead(); } catch {}
    if (!text) { flash(t('vnc.clipEmpty')); return; }
    st.rfb.clipboardPasteFrom(text);
    flash(t('vnc.clipSent'));
    st.rfb.focus();
  }

  function keyboardHelp() {
    askLocal({ kind: 'info', title: t('vnc.kbTitle'), message: t('vnc.kbMessage'), detail: t('vnc.kbDetail') });
  }

  // ---------- Anzeige ----------

  function render(st) {
    const { tab } = st;
    const connected = st.status === 'connected';
    const sshOpen = tab.state === 'open';
    const texts = {
      idle: t('vnc.stIdle'),
      connecting: t('vnc.stConnecting', { target: st.target }),
      connected: st.name ? t('vnc.stConnectedName', { name: st.name, target: st.target }) : t('vnc.stConnected', { target: st.target }),
      error: t('vnc.stError'),
    };
    st.root.dataset.status = st.status;
    st.head.querySelector('.vnc-status-text').textContent = sshOpen ? texts[st.status] : t('vnc.stNoSsh');
    for (const b of st.scaleSeg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.scale === currentScale(st));
    st.viewOnlyB.classList.toggle('on', currentViewOnly(st));
    st.viewOnlyB.setAttribute('aria-pressed', String(currentViewOnly(st)));
    for (const b of [st.cadB, st.clipB, st.fsB]) b.disabled = !connected;
    st.cadB.disabled = st.clipB.disabled = !connected || currentViewOnly(st); // „Nur ansehen“: noVNC sendet nichts
    st.connB.disabled = !sshOpen && !st.rfb;
    st.connB.querySelector('.vnc-btn-text').textContent = st.rfb ? t('vnc.disconnect') : t('vnc.connect');
    st.connB.classList.toggle('primary', !st.rfb);
    st.connB.title = st.rfb ? t('vnc.disconnectTitle') : t('vnc.connectTitle');
    st.screen.hidden = !st.rfb;
    st.panel.hidden = connected;
    if (!connected) renderPanel(st);
  }

  function renderPanel(st) {
    const { tab, panel } = st;
    const s = settingsOf(tab);
    const name = hostName(tab);
    panel.innerHTML = '';
    const card = el('div', 'vnc-card');
    panel.appendChild(card);
    const h = el('h3');
    h.innerHTML = icon('desktop');
    h.append(t('vnc.title'));
    card.appendChild(h);

    if (tab.state !== 'open') {
      card.appendChild(el('p', 'vnc-text', t('vnc.needSsh')));
      return;
    }
    if (st.status === 'connecting') {
      card.appendChild(el('p', 'vnc-text', t('vnc.connectingMsg', { target: st.target })));
      card.appendChild(el('div', 'vnc-spinner'));
      return;
    }
    if (st.status === 'error' && st.error) {
      const e = el('div', 'vnc-error');
      e.setAttribute('role', 'alert');
      e.textContent = st.error;
      card.appendChild(e);
    } else {
      card.appendChild(el('p', 'vnc-text', t('vnc.intro')));
    }

    // Ziel und Verbinden
    const form = el('form', 'vnc-form');
    const label = el('label', 'grow', t('vnc.targetLabel'));
    const input = el('input');
    input.name = 'target';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = 'localhost:5900';
    input.value = st.target || fmtTarget(s);
    label.appendChild(input);
    const go = el('button', 'btn primary', t('vnc.connect'));
    go.type = 'submit';
    form.append(label, go);
    form.addEventListener('submit', e => { e.preventDefault(); connect(st, input.value.trim()); });
    card.appendChild(form);
    card.appendChild(el('p', 'vnc-small', t('vnc.targetHint')));

    // Suche nach VNC-Servern auf dem Server (ss -ltn)
    const scanBox = el('div', 'vnc-scan');
    const scanB = btn('search', st.scanning ? t('vnc.scanning') : t('vnc.scan'), t('vnc.scanTitle'), () => runScan(st), 'vnc-scan-btn');
    scanB.disabled = st.scanning;
    scanBox.appendChild(scanB);
    if (st.scan) {
      if (st.scan.error) scanBox.appendChild(el('p', 'vnc-small vnc-err-text', st.scan.error));
      else if (!st.scan.tool) scanBox.appendChild(el('p', 'vnc-small', t('vnc.scanNoTool')));
      else if (!st.scan.found.length) scanBox.appendChild(el('p', 'vnc-small', t('vnc.scanNone')));
      else {
        scanBox.appendChild(el('p', 'vnc-small', t('vnc.scanFound', { count: st.scan.found.length })));
        const list = el('ul', 'vnc-found');
        for (const f of st.scan.found) {
          const li = el('li');
          const txt = el('span', 'vnc-found-text', t('vnc.scanItem', { display: f.display, port: f.port }));
          const where = el('span', 'vnc-found-where', f.loopbackOnly ? t('vnc.scanLocal') : t('vnc.scanOpen'));
          if (!f.loopbackOnly) where.classList.add('warn');
          where.title = f.addrs.join(', ');
          const c = el('button', 'btn', t('vnc.connect'));
          c.type = 'button';
          c.addEventListener('click', () => connect(st, f.target));
          li.append(txt, where, c);
          list.appendChild(li);
        }
        scanBox.appendChild(list);
        if (st.scan.found.some(f => !f.loopbackOnly)) scanBox.appendChild(el('p', 'vnc-small', t('vnc.scanOpenHint')));
      }
    }
    card.appendChild(scanBox);

    if (name && !s.enabled) {
      const p = el('p', 'vnc-small vnc-setup');
      p.append(t('vnc.setupHint') + ' ');
      const a = el('button', 'linkish', t('vnc.setupOpen'));
      a.type = 'button';
      a.addEventListener('click', () => editHost(name));
      p.appendChild(a);
      card.appendChild(p);
    }

    const tips = el('details', 'vnc-tips');
    tips.appendChild(el('summary', '', t('vnc.tipsTitle')));
    tips.appendChild(el('pre', 'vnc-tips-text', t('vnc.tipsText')));
    card.appendChild(tips);
  }

  async function runScan(st) {
    st.scanning = true;
    render(st);
    try { st.scan = await V.scan(st.tab.id); } catch (err) { st.scan = { error: errMsg(err) }; }
    st.scanning = false;
    if (states.get(st.tab.id) === st) render(st);
  }

  // ---------- Verbinden / Trennen ----------

  async function askCredentials(st, types) {
    const name = hostName(st.tab);
    const creds = {};
    if (types.includes('username')) {
      const u = await askLocal({ kind: 'text', title: t('vnc.userTitle'), message: t('vnc.userMsg'), okLabel: t('common.next') });
      if (u == null) return null;
      creds.username = typeof u === 'object' ? u.value : u;
    }
    if (types.includes('password')) {
      const p = await askLocal({
        kind: 'secret', title: t('vnc.pwTitle'), message: t('vnc.pwMsg', { target: st.target }),
        remember: !!name, rememberLabel: t('vnc.pwRemember'), okLabel: t('vnc.connect'),
      });
      if (p == null) return null;
      const value = typeof p === 'object' ? p.value : p;
      creds.password = value;
      if (name && p.remember) {
        V.savePassword(name, value).catch(err => showError(err));
        st.badStored = false;
      }
    }
    return creds;
  }

  async function connect(st, target) {
    const { tab } = st;
    if (tab.state !== 'open' || st.status === 'connecting') return;
    if (st.rfb) { st.userClosed = true; st.rfb.disconnect(); st.rfb = null; }
    st.status = 'connecting';
    st.error = '';
    st.name = '';
    st.target = target || st.target || fmtTarget(settingsOf(tab));
    st.userClosed = false;
    render(st);
    let info;
    try {
      info = await V.open(tab.id, { target: st.target });
    } catch (err) {
      st.status = 'error';
      st.error = errMsg(err);
      render(st);
      return;
    }
    if (states.get(tab.id) !== st) { V.close(tab.id); return; }
    st.target = info.target;
    const s = settingsOf(tab);
    const RFB = await rfbReady;
    st.screen.innerHTML = '';
    st.screen.hidden = false;
    const usedStored = !!info.password && !st.badStored;
    let rfb;
    try {
      rfb = new RFB(st.screen, info.url, {
        shared: true, wsProtocols: ['binary'],
        credentials: usedStored ? { password: info.password } : undefined,
      });
    } catch (err) {
      st.status = 'error';
      st.error = errMsg(err);
      V.close(tab.id);
      render(st);
      return;
    }
    st.rfb = rfb;
    st.wantConnected = true;
    rfb.scaleViewport = currentScale(st) === 'fit';
    rfb.clipViewport = false;
    rfb.resizeSession = false;
    rfb.viewOnly = currentViewOnly(st);
    rfb.focusOnClick = true;
    const q = QUALITY[s.quality] || QUALITY.balanced;
    rfb.qualityLevel = q.q;
    rfb.compressionLevel = q.c;
    rfb.background = 'transparent';
    let handshakeDone = false;
    let secFail = null;

    rfb.addEventListener('connect', () => {
      if (st.rfb !== rfb) return;
      handshakeDone = true;
      st.status = 'connected';
      st.error = '';
      render(st);
      if (tab.id === activeId && tab.view === 'desktop') rfb.focus();
    });
    rfb.addEventListener('disconnect', e => {
      if (st.rfb !== rfb) return;
      st.rfb = null;
      V.close(tab.id);
      if (document.fullscreenElement === st.root) document.exitFullscreen().catch(() => {});
      if (st.userClosed) { st.status = 'idle'; st.wantConnected = false; }
      else if (secFail) { st.status = 'error'; st.error = secFail; st.wantConnected = false; }
      else if (!handshakeDone) { st.status = 'error'; st.error = t('vnc.errHandshake'); st.wantConnected = false; }
      else if (tab.state !== 'open') { st.status = 'idle'; } // SSH weg – nach dem Neuverbinden wieder verbinden
      else if (!e.detail.clean) { st.status = 'error'; st.error = t('vnc.errLost'); }
      else { st.status = 'idle'; st.wantConnected = false; }
      st.screen.innerHTML = '';
      if (states.get(tab.id) === st) render(st);
    });
    rfb.addEventListener('credentialsrequired', async e => {
      const creds = await askCredentials(st, e.detail.types || ['password']);
      if (st.rfb !== rfb) return;
      if (!creds) { st.userClosed = true; rfb.disconnect(); return; }
      rfb.sendCredentials(creds);
    });
    rfb.addEventListener('securityfailure', e => {
      const reason = e.detail.reason || '';
      if (usedStored) st.badStored = true; // nächster Versuch fragt neu nach dem Passwort
      secFail = e.detail.status === 1 || /auth|password|passwor/i.test(reason)
        ? t(usedStored ? 'vnc.errPasswordStored' : 'vnc.errPassword')
        : t('vnc.errSecurity', { reason: reason || e.detail.status });
    });
    // Das Gegenüber ist durch SSH schon geprüft – Server-Schlüssel von RA2/RSA-AES einfach annehmen
    rfb.addEventListener('serververification', () => rfb.approveServer());
    rfb.addEventListener('desktopname', e => { st.name = e.detail.name || ''; render(st); });
    rfb.addEventListener('clipboard', e => {
      const text = e.detail.text || '';
      if (!text) return;
      V.clipboardWrite(text).then(() => flash(t('vnc.clipReceived'))).catch(() => {});
    });
  }

  function disconnect(st) {
    st.userClosed = true;
    st.wantConnected = false;
    if (st.rfb) st.rfb.disconnect();
    else V.close(st.tab.id);
  }

  // ---------- Einhängen in renderer.js ----------

  // Aufruf bei jedem Wechsel von Tab, Ansicht oder Verbindungsstatus (updateToolbar)
  function update(tab) {
    const ftp = isFtp(tab);
    viewBtn.classList.toggle('ftp-off', ftp);
    viewBtn.setAttribute('aria-disabled', ftp ? 'true' : 'false');
    viewBtn.title = ftp ? t('vnc.ftpOnly') : t('vnc.viewTitle');
    for (const st of states.values()) {
      const show = !!tab && st.tab === tab && tab.view === 'desktop';
      st.root.hidden = !show;
    }
    if (!tab || tab.view !== 'desktop') return;
    let st = states.get(tab.id);
    if (!st) { st = build(tab); states.set(tab.id, st); }
    st.root.hidden = false;
    // SSH neu verbunden: vorher offene Desktop-Verbindung wieder aufbauen
    if (tab.state === 'open' && st.lastInfo !== tab.info) {
      const reconnected = st.lastInfo !== undefined;
      st.lastInfo = tab.info;
      if (!st.rfb && ((reconnected && st.wantConnected) || (!st.autoTried && settingsOf(tab).enabled))) {
        st.autoTried = true;
        connect(st);
        return;
      }
    }
    render(st);
    if (st.rfb && st.status === 'connected') setTimeout(() => { if (tab.id === activeId && tab.view === 'desktop') st.rfb?.focus(); }, 0);
  }

  function detach(tab) {
    const st = states.get(tab.id);
    if (!st) return;
    st.userClosed = true;
    try { st.rfb?.disconnect(); } catch {}
    V.close(tab.id);
    st.root.remove();
    states.delete(tab.id);
  }

  function openAndScan() {
    const tab = tabs.get(activeId);
    if (!tab || block(tab)) return;
    if (tab.view !== 'desktop') setView('desktop');
    const st = states.get(tab.id);
    if (st && tab.state === 'open') runScan(st);
  }

  // Einträge für die Befehlspalette
  window.Palette?.register(() => {
    const tab = tabs.get(activeId);
    if (!tab || isFtp(tab)) return [];
    const A = (id, label, ic, fn, keywords) => ({ key: 'act:vnc-' + id, section: 'actions', icon: ic, label, run: fn, keywords });
    return [
      A('view', t('vnc.palView'), 'desktop', () => setView('desktop'), 'vnc remote desktop bildschirm screen gui'), // i18n-ignore
      A('scan', t('vnc.palScan'), 'search', openAndScan, 'vnc server suchen find port 5900 display'), // i18n-ignore
    ];
  });

  // ---------- Host-Dialog: Remote Desktop (VNC) ----------

  const form = document.getElementById('host-form');
  const anchor = document.getElementById('conn-pro-fields');
  if (form && anchor && typeof hostFormHooks !== 'undefined') {
    const wrap = el('details', 'cp-host vnc-host');
    wrap.appendChild(el('summary', '', t('vnc.hostSection')));
    wrap.insertAdjacentHTML('beforeend', `
      <label class="toggle"><input type="checkbox" name="vncEnabled"><span class="track"><span class="knob"></span></span><span class="vnc-l-enabled"></span></label>
      <p class="cp-hint vnc-l-hint"></p>
      <div class="row">
        <label class="grow"><span class="vnc-l-target"></span><input name="vncTarget" placeholder="localhost:5900" spellcheck="false" autocomplete="off"></label>
        <label class="grow"><span class="vnc-l-quality"></span>
          <select name="vncQuality">
            <option value="best"></option><option value="balanced"></option><option value="low"></option>
          </select>
        </label>
      </div>
      <label><span class="vnc-l-pw"></span>
        <div class="row">
          <input name="vncPassword" type="password" class="grow" autocomplete="new-password">
          <button type="button" class="btn vnc-forget" hidden></button>
        </div>
      </label>
      <label class="toggle"><input type="checkbox" name="vncViewOnly"><span class="track"><span class="knob"></span></span><span class="vnc-l-viewonly"></span></label>`);
    const set = (sel, text) => { wrap.querySelector(sel).textContent = text; };
    set('.vnc-l-enabled', t('vnc.hostEnabled'));
    set('.vnc-l-hint', t('vnc.hostHint'));
    set('.vnc-l-target', t('vnc.hostTarget'));
    set('.vnc-l-quality', t('vnc.hostQuality'));
    set('.vnc-l-pw', t('vnc.hostPassword'));
    set('.vnc-l-viewonly', t('vnc.hostViewOnly'));
    set('.vnc-forget', t('host.forgetPw'));
    const opts = wrap.querySelectorAll('select[name=vncQuality] option');
    opts[0].textContent = t('vnc.qBest');
    opts[1].textContent = t('vnc.qBalanced');
    opts[2].textContent = t('vnc.qLow');
    anchor.appendChild(wrap);

    let forget = false;
    let currentScaleSetting = 'fit';
    const forgetB = wrap.querySelector('.vnc-forget');
    forgetB.addEventListener('click', () => {
      forget = true;
      forgetB.hidden = true;
      form.vncPassword.placeholder = t('vnc.hostPwPh');
    });
    const syncProto = () => { wrap.hidden = window.FtpUi ? form.protocol.value !== 'sftp' : false; };
    form.protocol?.addEventListener('change', syncProto);

    hostFormHooks.push({
      fill(f, name) {
        const h = (name && hosts[name]) || {};
        const v = { ...DEFAULTS, ...(h.vnc || {}) };
        f.vncEnabled.checked = !!v.enabled;
        f.vncTarget.value = fmtTarget(v);
        f.vncQuality.value = v.quality;
        f.vncViewOnly.checked = !!v.viewOnly;
        f.vncPassword.value = '';
        f.vncPassword.placeholder = t('vnc.hostPwPh');
        currentScaleSetting = v.scale;
        forget = false;
        forgetB.hidden = true;
        wrap.open = !!h.vnc?.enabled;
        if (name) V.hasPassword(name).then(has => {
          forgetB.hidden = !has;
          if (has) f.vncPassword.placeholder = t('vnc.hostPwSavedPh');
        }).catch(() => {});
        setTimeout(syncProto, 0); // nach FtpUi.fillForm
      },
      read(f) {
        return {
          vnc: { enabled: f.vncEnabled.checked, target: f.vncTarget.value.trim(), quality: f.vncQuality.value, viewOnly: f.vncViewOnly.checked, scale: currentScaleSetting },
          vncPassword: f.vncPassword.value, vncForgetPassword: forget,
        };
      },
    });
  }

  return { update, detach, block, _states: states };
})();
