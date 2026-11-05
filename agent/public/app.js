// S3cure – Web-App fürs iPhone (und jeden Browser). Spricht nur mit dem eigenen Agenten (/api/…).
// Seiten (Hash): #/login, #/ (alle Server), #/s/<id>/<status|services|docker|more>, #/logs/<id>/<service|container>/<name>, #/settings
(() => {
  'use strict';

  // ---------- Sprache ----------
  const LANG = /^de\b/i.test(navigator.language || '') ? 'de' : 'en';
  document.documentElement.lang = LANG;
  const DICT = {
    de: {
      tagline: 'Deine Server – immer dabei', user: 'Benutzer', password: 'Passwort', code: '2FA-Code', login: 'Anmelden', loggingIn: 'Anmelden …',
      loginHint: 'Den Code zeigt deine Authenticator-App. Benutzer legst du auf dem Server an: s3cure-agent user add <name> --admin',
      servers: 'Server', oneServer: '1 Server', nServers: '{n} Server', ok: 'Alles gut', warn: '{n} Warnung', warnN: '{n} Warnungen', offline: 'Nicht erreichbar',
      cpu: 'CPU', ram: 'RAM', disk: 'Platte', uptime: 'Läuft seit', network: 'Netzwerk', cores: '{n} Kerne · Last {l}', of: '{a} von {b}', free: '{a} frei',
      status: 'Status', services: 'Dienste', docker: 'Docker', more: 'Mehr', history: 'Verlauf', h24: '24 Std.', d7: '7 Tage', system: 'System',
      os: 'System', kernel: 'Kernel', hostname: 'Rechnername', problems: 'Probleme', noProblems: 'Keine Probleme',
      search: 'Suchen', all: 'Alle', failed: 'Fehler', running: 'Läuft', stopped: 'Aus', noServices: 'Keine Dienste gefunden.', noDocker: 'Docker ist auf diesem Server nicht installiert.', noContainers: 'Keine Container.',
      restart: 'Neu starten', start: 'Starten', stop: 'Stoppen', logs: 'Logs', cancel: 'Abbrechen', confirm: 'Bestätigen',
      confirmRestart: '{name} neu starten?', confirmStop: '{name} stoppen?', confirmStart: '{name} starten?',
      stopHint: 'Alles, was davon abhängt, ist danach nicht mehr erreichbar.', restartHint: 'Der Dienst ist für ein paar Sekunden nicht erreichbar.',
      done: 'Erledigt ✓', protectedHint: 'Geschützt – Stoppen geht nur auf dem Server selbst, damit du dich nicht aussperrst.', viewerHint: 'Nur ansehen – für Aktionen brauchst du Admin-Rechte.',
      reboot: 'Server neu starten', rebootTitle: '{name} neu starten?', rebootMsg: 'Der ganze Server startet neu und ist 1–2 Minuten nicht erreichbar. Gib zur Sicherheit einen frischen 2FA-Code ein.',
      rebootDone: 'Server startet neu …', audit: 'Protokoll', auditEmpty: 'Noch keine Einträge.', settings: 'Einstellungen',
      live: 'Live', refresh: 'Neu laden', filter: 'Filtern', noLogs: 'Keine Log-Einträge.', liveOnlyMain: 'Live gibt es nur für den Hauptserver.',
      install: 'Als App installieren', installMsg: 'Tippe unten auf Teilen und dann „Zum Home-Bildschirm“. Danach startet S3cure wie eine App – und kann dir Mitteilungen schicken.',
      notifications: 'Mitteilungen', notifyOn: 'Mitteilungen einschalten', notifyOff: 'Mitteilungen ausschalten', notifyTest: 'Test-Mitteilung senden',
      notifyDesc: 'Wenn ein Dienst ausfällt, die Platte voll wird oder ein Server nicht erreichbar ist.', notifyActive: 'Eingeschaltet auf diesem Gerät',
      notifyNeedsInstall: 'Auf dem iPhone gehen Mitteilungen nur, wenn S3cure auf dem Home-Bildschirm liegt (Teilen → Zum Home-Bildschirm).',
      notifyDenied: 'Mitteilungen sind blockiert. Erlaube sie in den iPhone-Einstellungen → Mitteilungen → S3cure.', notifyUnavailable: 'Dieser Browser kann keine Mitteilungen empfangen.',
      notifyBanner: 'Mitteilungen einschalten?', notifyBannerMsg: 'Dann sagt dir S3cure sofort Bescheid, wenn auf einem Server etwas nicht stimmt.', enable: 'Einschalten',
      account: 'Konto', role_admin: 'Admin – darf steuern', role_viewer: 'Nur ansehen', logout: 'Abmelden', version: 'Version', devices: '{n} Geräte mit Mitteilungen',
      error: 'Fehler', offlineNet: 'Keine Verbindung zum Server.', demo: 'Demo-Daten', ago: 'vor {n} Min.', now: 'gerade eben',
      days: '{d} T. {h} Std.', hours: '{h} Std. {m} Min.', sentTo: 'An {n} Gerät(e) gesendet.', back: 'Zurück',
      state_active: 'läuft', state_failed: 'Fehler', state_inactive: 'aus', state_activating: 'startet', state_deactivating: 'stoppt', state_running: 'läuft', state_exited: 'gestoppt', state_paused: 'pausiert', state_restarting: 'startet neu', state_created: 'angelegt', state_dead: 'beendet',
      act_login: 'angemeldet', 'act_login-failed': 'Anmeldung fehlgeschlagen', 'act_login-locked': 'gesperrt (zu viele Versuche)', act_reboot: 'Server neu gestartet', act_alert: 'Warnung',
      'act_service-start': 'Dienst gestartet', 'act_service-stop': 'Dienst gestoppt', 'act_service-restart': 'Dienst neu gestartet',
      'act_container-start': 'Container gestartet', 'act_container-stop': 'Container gestoppt', 'act_container-restart': 'Container neu gestartet',
    },
    en: {
      tagline: 'Your servers – always with you', user: 'User', password: 'Password', code: '2FA code', login: 'Sign in', loggingIn: 'Signing in…',
      loginHint: 'Your authenticator app shows the code. Create users on the server: s3cure-agent user add <name> --admin',
      servers: 'Servers', oneServer: '1 server', nServers: '{n} servers', ok: 'All good', warn: '{n} warning', warnN: '{n} warnings', offline: 'Unreachable',
      cpu: 'CPU', ram: 'RAM', disk: 'Disk', uptime: 'Uptime', network: 'Network', cores: '{n} cores · load {l}', of: '{a} of {b}', free: '{a} free',
      status: 'Status', services: 'Services', docker: 'Docker', more: 'More', history: 'History', h24: '24 h', d7: '7 days', system: 'System',
      os: 'System', kernel: 'Kernel', hostname: 'Hostname', problems: 'Problems', noProblems: 'No problems',
      search: 'Search', all: 'All', failed: 'Failed', running: 'Running', stopped: 'Stopped', noServices: 'No services found.', noDocker: 'Docker is not installed on this server.', noContainers: 'No containers.',
      restart: 'Restart', start: 'Start', stop: 'Stop', logs: 'Logs', cancel: 'Cancel', confirm: 'Confirm',
      confirmRestart: 'Restart {name}?', confirmStop: 'Stop {name}?', confirmStart: 'Start {name}?',
      stopHint: 'Everything that depends on it will be unreachable afterwards.', restartHint: 'The service will be unreachable for a few seconds.',
      done: 'Done ✓', protectedHint: 'Protected – stopping only works on the server itself, so you can’t lock yourself out.', viewerHint: 'View only – actions need admin rights.',
      reboot: 'Restart server', rebootTitle: 'Restart {name}?', rebootMsg: 'The whole server restarts and is unreachable for 1–2 minutes. For safety, enter a fresh 2FA code.',
      rebootDone: 'Server is restarting…', audit: 'Activity log', auditEmpty: 'No entries yet.', settings: 'Settings',
      live: 'Live', refresh: 'Reload', filter: 'Filter', noLogs: 'No log entries.', liveOnlyMain: 'Live is only available for the main server.',
      install: 'Install as app', installMsg: 'Tap Share below, then “Add to Home Screen”. S3cure then starts like an app – and can send you notifications.',
      notifications: 'Notifications', notifyOn: 'Turn on notifications', notifyOff: 'Turn off notifications', notifyTest: 'Send test notification',
      notifyDesc: 'When a service fails, the disk fills up or a server is unreachable.', notifyActive: 'On for this device',
      notifyNeedsInstall: 'On iPhone, notifications only work when S3cure is on the Home Screen (Share → Add to Home Screen).',
      notifyDenied: 'Notifications are blocked. Allow them in iPhone Settings → Notifications → S3cure.', notifyUnavailable: 'This browser cannot receive notifications.',
      notifyBanner: 'Turn on notifications?', notifyBannerMsg: 'S3cure will tell you right away when something is wrong on a server.', enable: 'Turn on',
      account: 'Account', role_admin: 'Admin – can control', role_viewer: 'View only', logout: 'Sign out', version: 'Version', devices: '{n} devices with notifications',
      error: 'Error', offlineNet: 'No connection to the server.', demo: 'Demo data', ago: '{n} min ago', now: 'just now',
      days: '{d} d {h} h', hours: '{h} h {m} min', sentTo: 'Sent to {n} device(s).', back: 'Back',
      state_active: 'running', state_failed: 'failed', state_inactive: 'stopped', state_activating: 'starting', state_deactivating: 'stopping', state_running: 'running', state_exited: 'stopped', state_paused: 'paused', state_restarting: 'restarting', state_created: 'created', state_dead: 'dead',
      act_login: 'signed in', 'act_login-failed': 'sign-in failed', 'act_login-locked': 'locked (too many attempts)', act_reboot: 'server restarted', act_alert: 'warning',
      'act_service-start': 'service started', 'act_service-stop': 'service stopped', 'act_service-restart': 'service restarted',
      'act_container-start': 'container started', 'act_container-stop': 'container stopped', 'act_container-restart': 'container restarted',
    },
  };
  const t = (k, p = {}) => String(DICT[LANG][k] ?? DICT.de[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => (p[x] ?? ''));

  // ---------- Symbole ----------
  const PATHS = {
    back: 'M15 18l-6-6 6-6', chev: 'M9 18l6-6-6-6', refresh: 'M20 12a8 8 0 1 1-2.34-5.66 M20 4v5h-5', gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    gauge: 'M12 14l4-4 M3.3 15a9 9 0 1 1 17.4 0', server: 'M5.5 4h13A2.5 2.5 0 0 1 21 6.5v2A2.5 2.5 0 0 1 18.5 11h-13A2.5 2.5 0 0 1 3 8.5v-2A2.5 2.5 0 0 1 5.5 4z M5.5 13h13a2.5 2.5 0 0 1 2.5 2.5v2a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-2A2.5 2.5 0 0 1 5.5 13z M7 7.5h.01 M7 16.5h.01',
    box: 'M21 8l-9-5-9 5v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8', dots: 'M5 12h.01 M12 12h.01 M19 12h.01', alert: 'M10.3 4.3L2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z M12 9.5v4 M12 17h.01',
    restart: 'M3 12a9 9 0 1 0 3-6.7 M3 4v5h5', play: 'M7 4.5v15l12-7.5z', stop: 'M7 7h10v10H7z', logs: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
    power: 'M18.4 6.6a9 9 0 1 1-12.8 0 M12 2v10', bell: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z M10 20.5a2 2 0 0 0 4 0', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-3.5-3.5',
    share: 'M12 3v12 M8 7l4-4 4 4 M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7', close: 'M6 6l12 12 M18 6L6 18', list: 'M4 6h16 M4 12h16 M4 18h10', user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3 M10 17l5-5-5-5 M15 12H3',
  };
  const ic = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${PATHS[n] || ''}"/></svg>`;

  // ---------- Hilfen ----------
  const $ = (s, r = document) => r.querySelector(s);
  const app = $('#app');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (u, tot) => (tot ? Math.round((100 * u) / tot) : null);
  const bytes = n => { if (n == null) return '–'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return n.toLocaleString(LANG, { maximumFractionDigits: n < 10 ? 1 : 0 }) + ' ' + u[i]; };
  const rate = n => bytes(n) + '/s';
  const upt = s => { if (s == null) return '–'; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? t('days', { d, h }) : t('hours', { h, m }); };
  const level = v => (v == null ? '' : v >= 90 ? 'hi' : v >= 75 ? 'mid' : '');
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const shortName = n => String(n).replace(/\.service$/, '');
  const word = (prefix, k) => DICT[LANG][prefix + k] ?? DICT.de[prefix + k] ?? k; // Zustand/Aktion lesbar, Unbekanntes wie es ist
  // Breiten erst nach dem Einfügen setzen (Sicherheitsregeln erlauben keine style-Attribute im HTML)
  const applyWidths = root => { for (const d of root.querySelectorAll('[data-w]')) d.style.width = Math.max(0, Math.min(100, Number(d.dataset.w) || 0)) + '%'; };

  function toast(msg, bad = false) {
    const el = $('#toast');
    el.textContent = msg; el.className = bad ? 'bad' : ''; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-S3cure': '1' }, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new Error(t('offlineNet')); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { state.me = null; go('#/login'); throw new Error(data.error || '401'); }
    if (!res.ok) throw new Error(data.error || `${t('error')} ${res.status}`);
    return data;
  }

  // ---------- Zustand und Navigation ----------
  const state = { me: null, servers: [], timers: [], es: null, filter: { q: '', chip: 'all' }, range: 24 };
  const clearTimers = () => { state.timers.forEach(clearInterval); state.timers = []; if (state.es) { state.es.close(); state.es = null; } };
  const every = (ms, fn) => state.timers.push(setInterval(() => { if (!document.hidden) fn(); }, ms));
  const go = h => { if (location.hash !== h) location.hash = h; else route(); };

  window.addEventListener('hashchange', route);
  window.addEventListener('scroll', () => $('.top')?.classList.toggle('scrolled', window.scrollY > 4), { passive: true });

  async function route() {
    clearTimers(); closeSheet();
    const h = location.hash || '#/';
    if (!state.me && h !== '#/login') {
      try { state.me = await api('GET', '/api/me'); } catch { return; }
    }
    window.scrollTo(0, 0);
    const p = h.slice(2).split('/').map(decodeURIComponent);
    if (h === '#/login') return renderLogin();
    if (p[0] === 's' && p[1]) return renderServer(p[1], p[2] || 'status');
    if (p[0] === 'logs' && p[3]) return renderLogs(p[1], p[2], p.slice(3).join('/'));
    if (p[0] === 'settings') return renderSettings();
    return renderHome();
  }

  // ---------- Anmelden ----------
  function renderLogin() {
    app.innerHTML = `
      <form class="login" autocomplete="on">
        <div class="brand"><img src="/icons/icon-180.png" alt=""><h1>S3cure</h1><p>${t('tagline')}</p></div>
        <div class="field"><label for="u">${t('user')}</label><input id="u" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required></div>
        <div class="field"><label for="p">${t('password')}</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="c">${t('code')}</label><input id="c" name="code" class="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" required></div>
        <div class="err" hidden></div>
        <button class="btn primary block" type="submit">${t('login')}</button>
        <p class="hint">${esc(t('loginHint'))}</p>
      </form>`;
    const f = $('form', app);
    const u = store.get('s3:user');
    if (u) { f.username.value = u; f.password.focus(); } else f.username.focus();
    f.code.addEventListener('input', () => { f.code.value = f.code.value.replace(/\D/g, '').slice(0, 6); });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('button[type=submit]', f), err = $('.err', f);
      btn.disabled = true; btn.textContent = t('loggingIn'); err.hidden = true;
      try {
        await api('POST', '/api/login', { user: f.username.value.trim(), password: f.password.value, code: f.code.value });
        store.set('s3:user', f.username.value.trim().toLowerCase());
        state.me = await api('GET', '/api/me');
        registerSw();
        go('#/');
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false; f.code.value = ''; f.code.focus();
      } finally { btn.disabled = false; btn.textContent = t('login'); }
    });
  }

  // ---------- Alle Server ----------
  function srvState(s) {
    if (!s.ok) return ['bad', t('offline')];
    const n = (s.issues || []).length || (s.failed || []).length;
    if (!n) return ['ok', t('ok')];
    const bad = (s.issues || []).some(i => i.level === 'bad') || (s.failed || []).length;
    return [bad ? 'bad' : 'warn', t(n === 1 ? 'warn' : 'warnN', { n })];
  }

  function bars(m) {
    if (!m) return '';
    const cpu = Math.round(m.cpu ?? 0), ram = pct(m.mem?.used, m.mem?.total), disk = m.disk ? pct(m.disk.total - m.disk.free, m.disk.total) : null;
    const b = (lbl, v) => `<div class="mini"><div class="lbl"><span>${lbl}</span><b>${v == null ? '–' : v + ' %'}</b></div><div class="track ${level(v)}"><div data-w="${v ?? 0}"></div></div></div>`;
    return `<div class="srv-bars">${b(t('cpu'), cpu)}${b(t('ram'), ram)}${b(t('disk'), disk)}</div>`;
  }

  function issuesHtml(s) {
    const list = s.ok ? (s.issues || []) : [{ text: s.error || t('offline'), level: 'bad' }];
    if (!list.length) return '';
    return `<div class="issues">${list.map(i => `<div class="issue ${i.level === 'warn' ? 'warn' : ''}">${ic('alert')}<span>${esc(i.text)}</span></div>`).join('')}</div>`;
  }

  async function renderHome() {
    app.innerHTML = `
      <header class="top"><img class="logo" src="/icons/icon-180.png" alt=""><h1>S3cure<span class="sub"></span></h1>
        <button class="icon-btn" data-a="refresh" aria-label="${t('refresh')}">${ic('refresh')}</button>
        <button class="icon-btn" data-a="settings" aria-label="${t('settings')}">${ic('gear')}</button></header>
      <main><div class="banners"></div><div class="list-srv"><div class="skeleton"></div><div class="skeleton"></div></div></main>`;
    $('[data-a=settings]', app).addEventListener('click', () => go('#/settings'));
    $('[data-a=refresh]', app).addEventListener('click', () => load(true));
    renderBanners($('.banners', app));
    const load = async spin => {
      const b = $('[data-a=refresh]', app);
      if (spin) b.classList.add('spin');
      try { state.servers = await api('GET', '/api/servers'); } catch (e) { toast(e.message, true); return; } finally { b.classList.remove('spin'); }
      const box = $('.list-srv', app);
      if (!box) return;
      $('.top .sub', app).textContent = (state.me.demo ? t('demo') + ' · ' : '') + (state.servers.length === 1 ? t('oneServer') : t('nServers', { n: state.servers.length }));
      box.innerHTML = state.servers.map(s => {
        const [cls, txt] = srvState(s);
        return `<a class="card srv" href="#/s/${encodeURIComponent(s.id)}/status">
          <div class="srv-head"><span class="srv-name">${esc(s.name)}</span><span class="pill ${cls}"><span class="dot"></span>${esc(txt)}</span></div>
          ${s.ok ? bars(s.metrics) : ''}${issuesHtml(s)}</a>`;
      }).join('');
      applyWidths(box);
    };
    await load();
    every(15000, load);
  }

  function renderBanners(box) {
    if (isIos() && !standalone() && !store.get('s3:noInstall')) {
      box.insertAdjacentHTML('beforeend', `<div class="banner" data-b="install">${ic('share')}<div><b>${t('install')}</b>${esc(t('installMsg'))}</div><button class="x" aria-label="×">${ic('close')}</button></div>`);
    } else if (pushSupported() && Notification.permission === 'default' && state.me.push && !store.get('s3:noPushAsk')) {
      box.insertAdjacentHTML('beforeend', `<div class="banner" data-b="push">${ic('bell')}<div><b>${t('notifyBanner')}</b>${esc(t('notifyBannerMsg'))}<div><button class="btn primary" data-a="enable">${t('enable')}</button></div></div><button class="x" aria-label="×">${ic('close')}</button></div>`);
      $('[data-a=enable]', box)?.addEventListener('click', async () => { if (await enablePush()) $('[data-b=push]', box)?.remove(); });
    }
    for (const x of box.querySelectorAll('.banner .x')) x.addEventListener('click', () => {
      const b = x.closest('.banner'); store.set(b.dataset.b === 'install' ? 's3:noInstall' : 's3:noPushAsk', '1'); b.remove();
    });
  }

  // ---------- Ein Server ----------
  async function renderServer(id, tab) {
    const known = state.servers.find(s => s.id === id);
    const multi = state.servers.length > 1;
    app.innerHTML = `
      <header class="top">
        ${multi ? `<button class="icon-btn" data-a="back" aria-label="${t('back')}">${ic('back')}</button>` : '<img class="logo" src="/icons/icon-180.png" alt="">'}
        <h1><span class="nm">${esc(known ? known.name : '')}</span><span class="sub"></span></h1>
        <button class="icon-btn" data-a="refresh" aria-label="${t('refresh')}">${ic('refresh')}</button>
        <button class="icon-btn" data-a="settings" aria-label="${t('settings')}">${ic('gear')}</button>
      </header>
      <main class="page"><div class="skeleton"></div></main>
      <nav class="tabbar"><div class="tabs">
        ${[['status', 'gauge'], ['services', 'server'], ['docker', 'box'], ['more', 'dots']].map(([k, i]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${ic(i)}<span>${t(k)}</span>${k === 'services' ? '<span class="badge" hidden></span>' : ''}</button>`).join('')}
      </div></nav>`;
    $('[data-a=back]', app)?.addEventListener('click', () => go('#/'));
    $('[data-a=settings]', app).addEventListener('click', () => go('#/settings'));
    for (const b of app.querySelectorAll('.tabbar [data-t]')) b.addEventListener('click', () => go(`#/s/${encodeURIComponent(id)}/${b.dataset.t}`));
    if (!state.servers.length) api('GET', '/api/servers').then(l => { state.servers = l; const s = l.find(x => x.id === id); if (s) $('.top .nm', app).textContent = s.name; if (l.length > 1 && !$('[data-a=back]', app)) route(); }).catch(() => {});
    const main = $('main', app);
    const refreshBtn = $('[data-a=refresh]', app);
    const view = { status: viewStatus, services: viewServices, docker: viewDocker, more: viewMore }[tab] || viewStatus;
    const load = async spin => {
      if (spin) refreshBtn.classList.add('spin');
      try { await view(id, main); } catch (e) { toast(e.message, true); } finally { refreshBtn.classList.remove('spin'); }
    };
    refreshBtn.addEventListener('click', () => load(true));
    await load();
    if (tab === 'status' || tab === 'services' || tab === 'docker') every(tab === 'status' ? 10000 : 15000, () => view(id, main, true));
  }

  // ----- Status -----
  async function viewStatus(id, main, quiet) {
    const o = await api('GET', `/api/s/${encodeURIComponent(id)}/overview?hours=${state.range}`);
    const m = o.metrics || {};
    $('.top .nm', app).textContent = o.name;
    $('.top .sub', app).textContent = m.os || '';
    const failed = (o.failed || []).length;
    const badge = $('.tabbar .badge', app); if (badge) { badge.hidden = !failed; badge.textContent = failed; }
    const ram = pct(m.mem?.used, m.mem?.total), disk = m.disk ? pct(m.disk.total - m.disk.free, m.disk.total) : null, cpu = Math.round(m.cpu ?? 0);
    const tile = (lbl, val, v, sub) => `<div class="tile"><div class="t-lbl">${lbl}</div><div class="t-val">${val}</div>${v != null ? `<div class="track ${level(v)}"><div data-w="${v}"></div></div>` : ''}<div class="t-sub">${esc(sub)}</div></div>`;
    const issues = o.issues || [];
    const html = `
      ${issues.length ? `<div class="card"><h3>${t('problems')}</h3>${issuesHtml({ ok: true, issues })}</div>` : ''}
      <div class="tiles">
        ${tile(t('cpu'), cpu + ' %', cpu, t('cores', { n: m.cpus || '?', l: (m.load || [0])[0].toFixed(2) }))}
        ${tile(t('ram'), ram == null ? '–' : ram + ' %', ram, m.mem ? t('of', { a: bytes(m.mem.used), b: bytes(m.mem.total) }) : '')}
        ${tile(t('disk'), disk == null ? '–' : disk + ' %', disk, m.disk ? t('free', { a: bytes(m.disk.free) }) : '')}
        ${tile(t('uptime'), `<span class="upt">${esc(upt(m.uptime))}</span>`, null, m.net ? `↓ ${rate(m.net.rx)} · ↑ ${rate(m.net.tx)}` : '')}
      </div>
      <div class="card">
        <div class="chart-head"><h3>${t('history')}</h3><div class="seg-small"><button data-r="24" class="${state.range === 24 ? 'on' : ''}">${t('h24')}</button><button data-r="168" class="${state.range === 168 ? 'on' : ''}">${t('d7')}</button></div></div>
        ${chart(o.history || [])}
        <div class="chart-legend"><span><i class="lg cpu"></i>${t('cpu')}</span><span><i class="lg mem"></i>${t('ram')}</span><span><i class="lg disk"></i>${t('disk')}</span></div>
      </div>
      <div class="card"><h3>${t('system')}</h3><dl class="kv"><dt>${t('hostname')}</dt><dd>${esc(m.hostname || '–')}</dd><dt>${t('os')}</dt><dd>${esc(m.os || '–')}</dd><dt>${t('kernel')}</dt><dd>${esc(m.kernel || '–')}</dd></dl></div>`;
    main.innerHTML = html;
    applyWidths(main);
    for (const b of main.querySelectorAll('[data-r]')) b.addEventListener('click', () => { state.range = Number(b.dataset.r); viewStatus(id, main); });
  }

  // Liniengrafik (SVG) für CPU, RAM, Platte in %
  function chart(points) {
    const W = 340, H = 120;
    if (points.length < 2) return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><text x="${W / 2}" y="${H / 2}" class="c-empty" text-anchor="middle">…</text></svg>`;
    const t0 = points[0][0], t1 = points[points.length - 1][0] || t0 + 1;
    const x = tm => ((tm - t0) / (t1 - t0 || 1)) * W;
    const y = v => H - 4 - (Math.max(0, Math.min(100, v)) / 100) * (H - 8);
    const line = k => points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
    const area = k => `${line(k)}L${W},${H}L0,${H}Z`;
    const grid = [25, 50, 75].map(v => `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="c-grid"/>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}<path d="${area(1)}" class="c-area"/><path d="${line(3)}" class="c-disk"/><path d="${line(2)}" class="c-mem"/><path d="${line(1)}" class="c-cpu"/></svg>`;
  }

  // ----- Dienste / Docker -----
  const svcState = s => (s.active === 'failed' ? 'bad' : s.active === 'active' ? 'ok' : /activating|deactivating|reloading/.test(s.active) ? 'warn' : '');
  const ctrState = c => (c.state === 'running' ? 'ok' : c.state === 'restarting' ? 'warn' : /dead|exited/.test(c.state) && /Exited \((?!0\))/.test(c.status) ? 'bad' : '');

  async function viewServices(id, main, quiet) {
    const r = await api('GET', `/api/s/${encodeURIComponent(id)}/services`);
    if (!r.available) { main.innerHTML = `<div class="empty">${t('noServices')}</div>`; return; }
    const list = r.list.sort((a, b) => (a.active === 'failed' ? 0 : 1) - (b.active === 'failed' ? 0 : 1) || a.name.localeCompare(b.name));
    const badge = $('.tabbar .badge', app); const nf = list.filter(s => s.active === 'failed').length; if (badge) { badge.hidden = !nf; badge.textContent = nf; }
    renderList(main, {
      quiet, items: list,
      chips: [['all', t('all'), () => true], ['failed', t('failed'), s => s.active === 'failed'], ['running', t('running'), s => s.active === 'active'], ['stopped', t('stopped'), s => s.active === 'inactive']],
      match: (s, q) => (s.name + ' ' + s.description).toLowerCase().includes(q),
      row: s => `<div class="row" data-k="${esc(s.name)}"><span class="dot ${svcState(s)}"></span><div class="r-main"><div class="r-title">${esc(shortName(s.name))}</div><div class="r-sub">${esc(word('state_', s.active))} · ${esc(s.description)}</div></div><span class="chev">${ic('chev')}</span></div>`,
      open: s => itemSheet(id, 'service', s),
      empty: t('noServices'),
    });
  }

  async function viewDocker(id, main, quiet) {
    const r = await api('GET', `/api/s/${encodeURIComponent(id)}/containers`);
    if (!r.available) { main.innerHTML = `<div class="empty">${t('noDocker')}</div>`; return; }
    renderList(main, {
      quiet, items: r.list,
      chips: [['all', t('all'), () => true], ['running', t('running'), c => c.state === 'running'], ['stopped', t('stopped'), c => c.state !== 'running']],
      match: (c, q) => (c.name + ' ' + c.image).toLowerCase().includes(q),
      row: c => `<div class="row" data-k="${esc(c.name)}"><span class="dot ${ctrState(c)}"></span><div class="r-main"><div class="r-title">${esc(c.name)}</div><div class="r-sub">${esc(c.status)} · ${esc(c.image)}</div></div><span class="chev">${ic('chev')}</span></div>`,
      open: c => itemSheet(id, 'container', c),
      empty: r.error || t('noContainers'),
    });
  }

  // Suchfeld + Filter + Liste (behält Eingabe beim automatischen Neuladen)
  function renderList(main, o) {
    const f = state.filter;
    if (!o.quiet || !$('.list', main)) {
      main.innerHTML = `<div class="search">${ic('search')}<input type="search" placeholder="${t('search')}" autocapitalize="none" autocorrect="off" spellcheck="false"></div><div class="chips"></div><div class="list"></div>`;
      const inp = $('input', main);
      inp.value = f.q;
      inp.addEventListener('input', () => { f.q = inp.value; paint(); });
    }
    function paint() {
      const q = f.q.trim().toLowerCase();
      const chip = o.chips.find(c => c[0] === f.chip) || o.chips[0];
      $('.chips', main).innerHTML = o.chips.map(([k, l, fn]) => `<button class="chip ${k === chip[0] ? 'on' : ''}" data-c="${k}">${esc(l)}<span class="n">${o.items.filter(fn).length}</span></button>`).join('');
      for (const b of main.querySelectorAll('.chip')) b.addEventListener('click', () => { f.chip = b.dataset.c; paint(); });
      const items = o.items.filter(chip[2]).filter(x => !q || o.match(x, q));
      const box = $('.list', main);
      box.innerHTML = items.length ? items.map(o.row).join('') : `<div class="empty">${esc(o.empty)}</div>`;
      for (const r of box.querySelectorAll('.row')) r.addEventListener('click', () => o.open(items.find(x => x.name === r.dataset.k)));
    }
    paint();
  }

  // ---------- Blatt mit Aktionen ----------
  function openSheet(html) {
    const sh = $('#sheet'), bd = $('#sheet-backdrop');
    sh.innerHTML = '<div class="grab"></div>' + html;
    sh.hidden = false; bd.hidden = false;
    bd.onclick = closeSheet;
    return sh;
  }
  function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; }

  function itemSheet(id, kind, it) {
    const admin = state.me.role === 'admin';
    const running = kind === 'service' ? it.active === 'active' : it.state === 'running';
    const title = kind === 'service' ? shortName(it.name) : it.name;
    const sub = kind === 'service' ? `${word('state_', it.active)} · ${it.description}` : `${it.status} · ${it.image}`;
    const canStop = running && !(kind === 'service' && it.protected);
    const sh = openSheet(`
      <h2>${esc(title)}</h2><div class="s-sub">${esc(sub)}</div>
      <div class="btn-row">
        ${admin ? `<button class="btn" data-x="restart">${ic('restart')}${t('restart')}</button>` : ''}
        ${admin ? (running ? `<button class="btn danger" data-x="stop" ${canStop ? '' : 'disabled'}>${ic('stop')}${t('stop')}</button>` : `<button class="btn" data-x="start">${ic('play')}${t('start')}</button>`) : ''}
        <button class="btn" data-x="logs">${ic('logs')}${t('logs')}</button>
      </div>
      ${!admin ? `<p class="hint">${esc(t('viewerHint'))}</p>` : running && kind === 'service' && it.protected ? `<p class="hint">${esc(t('protectedHint'))}</p>` : ''}
      <div class="s-btns"><button class="btn block" data-x="close">${t('cancel')}</button></div>`);
    sh.querySelector('[data-x=close]').addEventListener('click', closeSheet);
    sh.querySelector('[data-x=logs]').addEventListener('click', () => go(`#/logs/${encodeURIComponent(id)}/${kind}/${encodeURIComponent(it.name)}`));
    for (const a of ['restart', 'stop', 'start']) sh.querySelector(`[data-x=${a}]`)?.addEventListener('click', () => confirmAction(id, kind, it, a, title));
  }

  function confirmAction(id, kind, it, action, title) {
    const key = { restart: 'confirmRestart', stop: 'confirmStop', start: 'confirmStart' }[action];
    const sh = openSheet(`
      <h2>${esc(t(key, { name: title }))}</h2>
      <p class="s-msg muted">${action === 'stop' ? t('stopHint') : action === 'restart' ? t('restartHint') : ''}</p>
      <div class="s-btns"><button class="btn ${action === 'stop' ? 'primary' : 'primary'} block" data-x="go">${t(action)}</button><button class="btn block" data-x="cancel">${t('cancel')}</button></div>`);
    sh.querySelector('[data-x=cancel]').addEventListener('click', closeSheet);
    const btn = sh.querySelector('[data-x=go]');
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '…';
      try {
        await api('POST', `/api/s/${encodeURIComponent(id)}/${kind === 'service' ? 'services' : 'containers'}/${encodeURIComponent(it.name)}/${action}`);
        closeSheet(); toast(t('done'));
        route();
      } catch (e) { closeSheet(); toast(e.message, true); }
    });
  }

  // ----- Mehr -----
  async function viewMore(id, main) {
    const admin = state.me.role === 'admin';
    const name = $('.top .nm', app).textContent || state.servers.find(s => s.id === id)?.name || '';
    main.innerHTML = `
      ${admin ? `<div class="card"><button class="btn danger block" data-a="reboot">${ic('power')}${t('reboot')}</button></div>` : ''}
      <div class="list"><div class="row" data-a="settings">${ic('gear')}<div class="r-main"><div class="r-title">${t('settings')}</div><div class="r-sub">${t('notifications')} · ${t('account')}</div></div><span class="chev">${ic('chev')}</span></div></div>
      ${admin ? `<div class="section-title">${t('audit')}</div><div class="list audit"><div class="empty">…</div></div>` : ''}`;
    $('[data-a=settings]', main).addEventListener('click', () => go('#/settings'));
    $('[data-a=reboot]', main)?.addEventListener('click', () => rebootSheet(id, name));
    if (admin) {
      try {
        const log = await api('GET', '/api/audit');
        const box = $('.audit', main);
        box.innerHTML = log.length ? log.slice(0, 60).map(e => `<div class="row"><span class="dot ${/failed|locked|reboot|stop|alert/.test(e.action) ? 'warn' : 'ok'}"></span><div class="r-main"><div class="r-title">${esc(word('act_', e.action))}${e.target ? ' · ' + esc(e.target) : ''}</div><div class="r-sub">${esc(e.user)} · ${new Date(e.at).toLocaleString(LANG)}${e.ip ? ' · ' + esc(e.ip) : ''}${e.detail ? ' · ' + esc(e.detail) : ''}</div></div></div>`).join('') : `<div class="empty">${t('auditEmpty')}</div>`;
      } catch {}
    }
  }

  function rebootSheet(id, name) {
    const sh = openSheet(`
      <h2>${esc(t('rebootTitle', { name }))}</h2><p class="s-msg muted">${t('rebootMsg')}</p>
      <input class="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="000000">
      <div class="err" hidden></div>
      <div class="s-btns"><button class="btn primary block" data-x="go">${ic('power')}${t('reboot')}</button><button class="btn block" data-x="cancel">${t('cancel')}</button></div>`);
    const inp = sh.querySelector('input'), err = sh.querySelector('.err'), btn = sh.querySelector('[data-x=go]');
    inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 6); });
    sh.querySelector('[data-x=cancel]').addEventListener('click', closeSheet);
    btn.addEventListener('click', async () => {
      btn.disabled = true; err.hidden = true;
      try { await api('POST', `/api/s/${encodeURIComponent(id)}/reboot`, { code: inp.value }); closeSheet(); toast(t('rebootDone')); }
      catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; inp.value = ''; inp.focus(); }
    });
    setTimeout(() => inp.focus(), 300);
  }

  // ---------- Logs ----------
  async function renderLogs(id, kind, name) {
    const title = kind === 'service' ? shortName(name) : name;
    app.innerHTML = `
      <div class="logs-page">
        <header class="top"><button class="icon-btn" data-a="back" aria-label="${t('back')}">${ic('back')}</button><h1>${esc(title)}<span class="sub">${t('logs')}</span></h1>
          <button class="icon-btn" data-a="refresh" aria-label="${t('refresh')}">${ic('refresh')}</button></header>
        <div class="logbar"><div class="search">${ic('search')}<input type="search" placeholder="${t('filter')}" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
          <button class="live" data-a="live"><span class="dot"></span>${t('live')}</button></div>
        <div class="logview"></div>
      </div>`;
    const view = $('.logview', app), inp = $('.logbar input', app), liveBtn = $('[data-a=live]', app);
    let lines = [];
    $('[data-a=back]', app).addEventListener('click', () => history.length > 1 ? history.back() : go(`#/s/${encodeURIComponent(id)}/${kind === 'service' ? 'services' : 'docker'}`));
    const fmt = l => {
      const cls = /\b(error|err|fail(ed)?|fatal|panic|critical|exception)\b/i.test(l) ? 'err' : /\b(warn(ing)?)\b/i.test(l) ? 'wrn' : '';
      const m = /^(\d{4}-\d\d-\d\d[T ][\d:.]+(?:[+-]\d{2}:?\d{2}|Z)?)\s?(.*)$/.exec(l);
      return `<div class="ln ${cls}">${m ? `<span class="ts">${esc(m[1].replace('T', ' ').slice(5, 19))}</span> ${esc(m[2])}` : esc(l)}</div>`;
    };
    const paint = (stick = true) => {
      const q = inp.value.trim().toLowerCase();
      const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 60;
      const shown = q ? lines.filter(l => l.toLowerCase().includes(q)) : lines;
      view.innerHTML = shown.length ? shown.map(fmt).join('') : `<div class="empty">${t('noLogs')}</div>`;
      if (stick && (atBottom || !q)) view.scrollTop = view.scrollHeight;
    };
    const load = async () => {
      const b = $('[data-a=refresh]', app); b.classList.add('spin');
      try { const r = await api('GET', `/api/s/${encodeURIComponent(id)}/${kind === 'service' ? 'services' : 'containers'}/${encodeURIComponent(name)}/logs?lines=300`); lines = r.text.split('\n').filter(Boolean); paint(); }
      catch (e) { toast(e.message, true); } finally { b.classList.remove('spin'); }
    };
    $('[data-a=refresh]', app).addEventListener('click', load);
    inp.addEventListener('input', () => paint(false));
    liveBtn.addEventListener('click', () => {
      if (state.es) { state.es.close(); state.es = null; liveBtn.classList.remove('on'); return; }
      if (id !== 'local') { toast(t('liveOnlyMain')); return; }
      const es = new EventSource(`/api/s/local/follow?kind=${kind}&name=${encodeURIComponent(name)}`);
      state.es = es; liveBtn.classList.add('on');
      lines = [];
      es.onmessage = e => { try { lines.push(JSON.parse(e.data)); if (lines.length > 3000) lines.splice(0, lines.length - 3000); paint(); } catch {} };
      es.onerror = () => { if (es.readyState === 2) { liveBtn.classList.remove('on'); state.es = null; } };
    });
    await load();
  }

  // ---------- Einstellungen ----------
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const b64ToBytes = s => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); };

  async function registerSw() {
    if (!('serviceWorker' in navigator)) return null;
    try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { return null; }
  }

  async function currentSub() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function enablePush() {
    if (!pushSupported()) { toast(isIos() && !standalone() ? t('notifyNeedsInstall') : t('notifyUnavailable'), true); return false; }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast(t('notifyDenied'), true); return false; }
      const reg = (await registerSw()) || (await navigator.serviceWorker.ready);
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.me.push) }));
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      toast(t('done'));
      return true;
    } catch (e) { toast(e.message, true); return false; }
  }

  async function renderSettings() {
    const me = state.me;
    app.innerHTML = `
      <header class="top"><button class="icon-btn" data-a="back" aria-label="${t('back')}">${ic('back')}</button><h1>${t('settings')}</h1></header>
      <main>
        <div class="section-title">${t('notifications')}</div>
        <div class="list"><div class="setting">${ic('bell')}<div class="s-text"><div class="s-title">${t('notifications')}</div><div class="s-desc n-desc">${t('notifyDesc')}</div></div></div>
          <div class="setting"><div class="s-text n-actions"></div></div></div>
        <div class="section-title">${t('account')}</div>
        <div class="list">
          <div class="setting">${ic('user')}<div class="s-text"><div class="s-title">${esc(me.user)}</div><div class="s-desc">${t('role_' + me.role)}</div></div></div>
          <div class="setting">${ic('shield')}<div class="s-text"><div class="s-title">${esc(me.name)}</div><div class="s-desc">${t('version')} ${esc(me.version)}${me.demo ? ' · ' + t('demo') : ''}</div></div></div>
        </div>
        <div class="section-title"></div>
        <button class="btn danger block" data-a="logout">${ic('logout')}${t('logout')}</button>
      </main>`;
    $('[data-a=back]', app).addEventListener('click', () => (history.length > 1 ? history.back() : go('#/')));
    $('[data-a=logout]', app).addEventListener('click', async () => {
      try { const s = await currentSub(); if (s) { await api('POST', '/api/push/unsubscribe', { subscription: s.toJSON() }).catch(() => {}); await s.unsubscribe(); } } catch {}
      await api('POST', '/api/logout').catch(() => {});
      state.me = null; go('#/login');
    });
    const box = $('.n-actions', app);
    const paint = async () => {
      if (!pushSupported()) { box.innerHTML = `<p class="hint">${esc(isIos() && !standalone() ? t('notifyNeedsInstall') : t('notifyUnavailable'))}</p>`; return; }
      if (Notification.permission === 'denied') { box.innerHTML = `<p class="hint">${esc(t('notifyDenied'))}</p>`; return; }
      const sub = await currentSub();
      box.innerHTML = sub
        ? `<p class="hint">✓ ${t('notifyActive')}</p><div class="s-btns"><button class="btn block" data-n="test">${t('notifyTest')}</button><button class="btn block" data-n="off">${t('notifyOff')}</button></div>`
        : `<button class="btn primary block" data-n="on">${ic('bell')}${t('notifyOn')}</button>`;
      box.querySelector('[data-n=on]')?.addEventListener('click', async () => { if (await enablePush()) paint(); });
      box.querySelector('[data-n=test]')?.addEventListener('click', async () => { try { const r = await api('POST', '/api/push/test'); toast(t('sentTo', { n: r.sent })); } catch (e) { toast(e.message, true); } });
      box.querySelector('[data-n=off]')?.addEventListener('click', async () => { const s = await currentSub(); if (s) { await api('POST', '/api/push/unsubscribe', { subscription: s.toJSON() }).catch(() => {}); await s.unsubscribe(); } paint(); });
    };
    paint();
  }

  // ---------- Start ----------
  registerSw();
  // Zurück in der App: aktuelle Daten holen – aber nicht, während ein Aktionsfenster offen ist
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me && $('#sheet').hidden && /^#\/(s\/|$)|^$/.test(location.hash)) route(); });
  route();
})();
