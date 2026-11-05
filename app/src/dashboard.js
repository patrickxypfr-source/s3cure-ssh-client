// S3cure SSH Client – Server-Übersicht (dritte Ansicht neben Terminal und Dateien)
// System (CPU, RAM, Platten, Prozesse, größte Ordner), Dienste (systemd) und Docker-Container.
// Daten kommen über eigene exec-Kanäle (app/lib/dashboard.js) – nichts wird ins Terminal getippt.
// Was es auf dem Server nicht gibt (kein systemd, kein Docker), wird ausgeblendet.
// Eingehängt in renderer.js über Dashboard.update(tab) und Dashboard.detach(tab).
window.Dashboard = (() => {
  const D = window.s3dash;
  const REFRESH = 15000; // Dienste/Container neu laden, solange sichtbar
  const states = new Map(); // Tab-ID -> Zustand der Ansicht

  // ---------- Kleine Helfer ----------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const errMsg = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const pct = (used, total) => (total ? Math.max(0, Math.min(100, (100 * used) / total)) : 0);
  const level = p => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : '');
  const fmtPct = p => t('dashboard.pct', { value: Math.round(p) });
  const num = (n, d = 2) => n.toLocaleString(I18N.locale, { minimumFractionDigits: d, maximumFractionDigits: d });
  const shortUnit = n => n.replace(/\.service$/, '');

  function uptimeLong(sec) {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    const parts = [];
    if (d) parts.push(t('dashboard.days', { count: d }));
    if (h || d) parts.push(t('dashboard.hours', { h }));
    parts.push(t('dashboard.minutes', { m }));
    return parts.join(', ');
  }

  function bar(p, cls = '') {
    const b = el('div', `dash-bar ${level(p)} ${cls}`);
    const i = el('i');
    i.style.width = p.toFixed(1) + '%';
    b.appendChild(i);
    return b;
  }

  function actionBtn(text, ic, fn, cls = '') {
    const b = el('button', 'btn dash-act ' + cls);
    b.type = 'button';
    b.innerHTML = icon(ic);
    b.append(text);
    b.addEventListener('click', fn);
    return b;
  }

  // ---------- Umschalter Terminal / Dateien / Übersicht ----------

  const viewBtn = el('button');
  viewBtn.dataset.view = 'dash';
  viewBtn.dataset.icon = 'gauge';
  viewBtn.textContent = t('dashboard.view');
  viewBtn.title = t('dashboard.viewTitle');
  viewBtn.insertAdjacentHTML('afterbegin', icon('gauge'));
  document.getElementById('view-switch').appendChild(viewBtn);
  viewBtn.addEventListener('click', () => setView('dash'));

  // ---------- Aufbau pro Tab ----------

  function build(tab) {
    const root = el('div', 'dash');
    root.hidden = true;
    root.innerHTML = `
      <div class="dash-head">
        <div class="seg dash-nav">
          <button data-sec="system">${icon('gauge')}System</button>
          <button data-sec="services">${icon('server')}${t('dashboard.services')}<span class="dash-badge" hidden></span></button>
          <button data-sec="docker">${icon('container')}Docker</button>
        </div>
        <span class="spacer"></span>
        <span class="dash-updated"></span>
        <button class="round-btn" data-a="refresh" title="${t('dashboard.refresh')}">${icon('refresh')}</button>
      </div>
      <div class="dash-body">
        <div class="dash-msg" hidden></div>
        <section data-sec="system" hidden></section>
        <section data-sec="services" hidden></section>
        <section data-sec="docker" hidden></section>
      </div>`;
    document.getElementById('terminals').appendChild(root);
    const st = {
      tab, root, sec: 'system', probe: null, probeFor: null, probing: null,
      services: null, servicesErr: '', containers: null, containersErr: '', system: null,
      filter: '', status: 'all', dFilter: '', busy: new Set(), du: null, duDir: '/', timer: null, sysTimer: null, updated: null,
    };
    for (const b of root.querySelectorAll('.dash-nav [data-sec]')) b.addEventListener('click', () => showSection(st, b.dataset.sec));
    root.querySelector('[data-a=refresh]').addEventListener('click', () => refresh(st, true));
    buildSystem(st);
    buildServices(st);
    buildDocker(st);
    return st;
  }

  const sec = (st, name) => st.root.querySelector(`section[data-sec=${name}]`);

  function showSection(st, name) {
    st.sec = name;
    for (const b of st.root.querySelectorAll('.dash-nav [data-sec]')) b.classList.toggle('on', b.dataset.sec === name);
    for (const s of st.root.querySelectorAll('section[data-sec]')) s.hidden = s.dataset.sec !== name || !st.probe;
    refresh(st);
  }

  // ---------- Laden ----------

  async function ensureProbe(st) {
    const tab = st.tab;
    if (st.probe && st.probeFor === tab.info) return st.probe;
    if (st.probing) return st.probing;
    st.probing = (async () => {
      try {
        st.probe = await D.probe(tab.id);
        st.probeFor = tab.info;
        st.services = st.containers = st.system = null;
      } catch (err) {
        st.probe = null;
        throw err;
      } finally { st.probing = null; }
      return st.probe;
    })();
    return st.probing;
  }

  async function refresh(st, force = false) {
    const tab = st.tab;
    if (tab.state !== 'open') { render(st); return; }
    try { await ensureProbe(st); } catch (err) { st.msg = t('dashboard.loadFailed', { error: errMsg(err) }); render(st); return; }
    st.msg = '';
    const p = st.probe;
    // Abschnitt nicht vorhanden -> auf System zurück
    if ((st.sec === 'services' && !p.systemd) || (st.sec === 'docker' && !p.docker)) st.sec = 'system';
    render(st);
    const jobs = [];
    if (st.sec === 'system' && (force || !st.system)) jobs.push(loadSystem(st));
    if (p.systemd && (st.sec === 'services' || force || !st.services)) jobs.push(loadServices(st));
    if (p.docker && (st.sec === 'docker' || force || !st.containers)) jobs.push(loadContainers(st));
    await Promise.all(jobs);
    st.updated = new Date();
    render(st);
  }

  async function loadSystem(st) {
    try { st.system = await D.system(st.tab.id); } catch (err) { st.system = { error: errMsg(err) }; }
  }
  async function loadServices(st) {
    try { const r = await D.services(st.tab.id); st.services = r.list; st.servicesErr = ''; }
    catch (err) { st.servicesErr = errMsg(err); }
  }
  async function loadContainers(st) {
    try { const r = await D.containers(st.tab.id); st.containers = r.list; st.containersErr = r.hint || ''; }
    catch (err) { st.containersErr = errMsg(err); }
  }

  // ---------- Anzeige ----------

  function render(st) {
    const tab = st.tab;
    const msg = st.root.querySelector('.dash-msg');
    const p = st.probe;
    const connected = tab.state === 'open';
    msg.textContent = !connected ? (tab.state === 'closed' ? t('dashboard.notConnected') : t('dashboard.connecting')) : st.msg || (!p ? t('dashboard.loading') : '');
    msg.hidden = !msg.textContent;
    const ok = connected && !!p && !st.msg;
    const nav = st.root.querySelector('.dash-nav');
    nav.querySelector('[data-sec=services]').hidden = !p?.systemd;
    nav.querySelector('[data-sec=docker]').hidden = !p?.docker;
    nav.hidden = !ok || (!p.systemd && !p.docker); // nur System -> kein Umschalter nötig
    for (const b of nav.querySelectorAll('[data-sec]')) b.classList.toggle('on', b.dataset.sec === st.sec);
    for (const s of st.root.querySelectorAll('section[data-sec]')) s.hidden = !ok || s.dataset.sec !== st.sec;
    st.root.querySelector('[data-a=refresh]').disabled = !connected;
    st.root.querySelector('.dash-updated').textContent = ok && st.updated ? t('dashboard.updatedAt', { time: st.updated.toLocaleTimeString(I18N.locale) }) : '';
    const failed = (st.services || []).filter(s => s.active === 'failed').length;
    const badge = nav.querySelector('.dash-badge');
    badge.hidden = !failed;
    badge.textContent = failed;
    badge.title = t('dashboard.failedServices', { count: failed });
    if (!ok) return;
    if (st.sec === 'system') renderSystem(st);
    if (st.sec === 'services') renderServices(st);
    if (st.sec === 'docker') renderDocker(st);
  }

  // ===================== System =====================

  function buildSystem(st) {
    const s = sec(st, 'system');
    s.innerHTML = `
      <div class="dash-cards"></div>
      <div class="dash-grid2">
        <div class="dash-card dash-info"><h3>Server</h3><dl></dl></div>
        <div class="dash-card dash-disks"><h3>${t('dashboard.drives')}</h3><div class="dash-disk-list"></div></div>
      </div>
      <div class="dash-card dash-procs"><h3>${t('dashboard.topProcs')}</h3><table class="dash-table"><thead><tr><th>${t('dashboard.colProgram')}</th><th>${t('dashboard.colUser')}</th><th class="r">CPU</th><th class="r">RAM</th><th class="r">PID</th></tr></thead><tbody></tbody></table></div>
      <div class="dash-card dash-du">
        <h3>${t('dashboard.bigDirs')}</h3>
        <p class="dash-note">${t('dashboard.bigDirsNote')}</p>
        <form class="dash-du-form">
          <div class="field grow"><span class="field-icon">${icon('folder')}</span><input class="dash-du-dir" spellcheck="false" value="/" title="${t('dashboard.duDirTitle')}"></div>
          <button type="submit" class="btn primary">${icon('hardDrive')}${t('dashboard.duRun')}</button>
          <button type="button" class="btn dash-du-cancel" hidden>${t('common.cancel')}</button>
        </form>
        <div class="dash-du-out"></div>
      </div>`;
    const form = s.querySelector('.dash-du-form');
    const input = s.querySelector('.dash-du-dir');
    form.addEventListener('submit', e => { e.preventDefault(); runDu(st, input.value.trim() || '/'); });
    s.querySelector('.dash-du-cancel').addEventListener('click', () => D.cancel(st.tab.id));
  }

  function card(title, value, sub, p) {
    const c = el('div', 'dash-card dash-stat' + (p == null ? '' : ' ' + level(p)));
    c.append(el('div', 'dash-stat-k', title), el('div', 'dash-stat-v', value));
    if (p != null) c.appendChild(bar(p));
    if (sub) c.appendChild(el('div', 'dash-stat-sub', sub));
    return c;
  }

  // cardsOnly: nur die großen Kennzahlen (Takt alle 2,5 s) – Listen bleiben stehen, damit Klicks nicht verloren gehen
  function renderSystem(st, cardsOnly = false) {
    const s = sec(st, 'system');
    const m = st.tab.monitorStats;
    const sys = st.system || {};
    const p = st.probe;

    const cards = s.querySelector('.dash-cards');
    cards.innerHTML = '';
    if (m) {
      const cpu = m.cpu != null ? m.cpu : m.cpuApprox;
      if (cpu != null) {
        const cores = m.cpus ? t('dashboard.cores', { count: m.cpus }) : '';
        const load = m.load ? t('dashboard.load', { values: m.load.map(x => (x == null ? '–' : num(x))).join(' / ') }) : '';
        cards.appendChild(card('CPU', m.cpu == null ? t('dashboard.approx', { value: fmtPct(cpu) }) : fmtPct(cpu), [cores, load].filter(Boolean).join(' · '), cpu));
      }
      if (m.mem) {
        const q = pct(m.mem.used, m.mem.total);
        cards.appendChild(card(t('dashboard.memory'), fmtPct(q), t('dashboard.usedOf', { used: formatSize(m.mem.used), total: formatSize(m.mem.total) }) + (m.swap ? ` · Swap ${formatSize(m.swap.used)}` : ''), q));
      }
      if (m.disk) {
        const q = pct(m.disk.used, m.disk.used + m.disk.free);
        cards.appendChild(card(t('dashboard.disk', { mount: m.disk.mount || '/' }), fmtPct(q), t('dashboard.freeOf', { free: formatSize(m.disk.free), total: formatSize(m.disk.total) }), q));
      }
      if (m.uptime != null) cards.appendChild(card(t('dashboard.uptime'), uptimeLong(m.uptime), m.at ? t('dashboard.updatedEvery', { time: new Date(m.at).toLocaleTimeString(I18N.locale) }) : ''));
    }
    cards.hidden = !cards.children.length;
    if (cardsOnly) return;

    const dl = s.querySelector('.dash-info dl');
    dl.innerHTML = '';
    const info = [[t('dashboard.hostname'), m?.hostname], [t('dashboard.os'), p.os], ['Kernel', p.kernel || m?.system], [t('dashboard.cpu'), p.cpuModel], [t('dashboard.loggedInAs'), p.root ? t('dashboard.userAdmin', { user: p.user }) : p.user],
      [t('dashboard.adminRights'), p.root ? t('dashboard.adminRoot') : p.sudo === 'nopass' ? t('dashboard.sudoNoPass') : p.sudo === 'password' ? t('dashboard.sudoPass') : t('dashboard.noSudo')]];
    for (const [k, v] of info) if (v) dl.append(el('dt', '', k), el('dd', '', v));

    const disks = s.querySelector('.dash-disk-list');
    disks.innerHTML = '';
    if (sys.error) disks.appendChild(el('p', 'dash-note', sys.error));
    for (const d of sys.disks || []) {
      const q = pct(d.used, d.used + d.free);
      const row = el('div', 'dash-disk');
      const head = el('div', 'dash-disk-head');
      head.append(el('span', 'dash-mono', d.mount), el('span', 'dash-muted', `${t('dashboard.freeOf', { free: formatSize(d.free), total: formatSize(d.total) })} · ${fmtPct(q)}`));
      row.append(head, bar(q));
      row.title = d.fs;
      disks.appendChild(row);
    }
    s.querySelector('.dash-disks').hidden = !sys.error && !(sys.disks || []).length;

    const body = s.querySelector('.dash-procs tbody');
    body.innerHTML = '';
    for (const pr of sys.procs || []) {
      const tr = el('tr');
      tr.append(el('td', 'dash-mono', pr.name), el('td', 'dash-muted', pr.user), el('td', 'r', t('dashboard.pct', { value: num(pr.cpu, 1) })), el('td', 'r', t('dashboard.pct', { value: num(pr.mem, 1) })), el('td', 'r dash-muted', String(pr.pid)));
      body.appendChild(tr);
    }
    s.querySelector('.dash-procs').hidden = !(sys.procs || []).length;
    renderDu(st);
  }

  async function runDu(st, dir, useSudo = false) {
    if (st.du?.running) return;
    st.du = { running: true, dir };
    renderDu(st);
    try { st.du = { ...(await D.bigDirs(st.tab.id, dir, useSudo)), running: false }; }
    catch (err) { st.du = { error: errMsg(err), dir, running: false }; }
    if (st.du.dir) sec(st, 'system').querySelector('.dash-du-dir').value = st.du.dir;
    renderDu(st);
  }

  function renderDu(st) {
    const s = sec(st, 'system');
    const out = s.querySelector('.dash-du-out');
    const du = st.du;
    s.querySelector('.dash-du-cancel').hidden = !du?.running;
    s.querySelector('.dash-du-form [type=submit]').disabled = !!du?.running;
    out.innerHTML = '';
    if (!du) return;
    if (du.running) { out.appendChild(el('p', 'dash-note', t('dashboard.duCounting', { dir: du.dir }))).prepend(el('span', 'spinner')); return; }
    if (du.cancelled) { out.appendChild(el('p', 'dash-note', t('dashboard.duCancelled'))); return; }
    if (du.error) { out.appendChild(el('p', 'dash-note dash-err', du.error)); return; }
    const head = el('div', 'dash-du-head');
    head.append(el('span', '', du.total != null ? t('dashboard.duTotal', { dir: du.dir, size: formatSize(du.total) }) : du.dir));
    if (du.dir !== '/') {
      const up = el('button', 'btn ghost', t('dashboard.duParent'));
      up.insertAdjacentHTML('afterbegin', icon('up'));
      up.addEventListener('click', () => runDu(st, parentPath(du.dir), du.usedSudo));
      head.appendChild(up);
    }
    out.appendChild(head);
    if (du.incomplete) {
      const note = el('p', 'dash-note', t('dashboard.duIncomplete'));
      if (du.canSudo) {
        const b = el('button', 'btn ghost', t('dashboard.duSudo'));
        b.addEventListener('click', () => runDu(st, du.dir, true));
        note.appendChild(b);
      }
      out.appendChild(note);
    }
    const max = Math.max(1, ...du.dirs.map(d => d.size));
    const list = el('div', 'dash-du-list');
    for (const d of du.dirs) {
      const row = el('button', 'dash-du-row');
      row.type = 'button';
      row.title = t('dashboard.duRowTitle', { path: d.path });
      const name = el('span', 'dash-mono', d.path.split('/').pop() || d.path);
      const size = el('span', 'dash-du-size', formatSize(d.size));
      row.append(name, bar(100 * d.size / max, 'neutral'), size);
      row.addEventListener('click', () => runDu(st, d.path, du.usedSudo));
      list.appendChild(row);
    }
    if (!du.dirs.length) list.appendChild(el('p', 'dash-note', t('dashboard.duEmpty')));
    out.appendChild(list);
  }

  // ===================== Dienste =====================

  const SVC_STATE = {
    active: [t('dashboard.stRunning'), 'ok'], failed: [t('dashboard.stFailed'), 'bad'], inactive: [t('dashboard.stStopped'), 'off'],
    activating: [t('dashboard.stStarting'), 'warn'], deactivating: [t('dashboard.stStopping'), 'warn'], reloading: [t('dashboard.stReloading'), 'warn'],
  };
  const svcState = s => SVC_STATE[s.active] || [s.active, 'off'];

  function buildServices(st) {
    const s = sec(st, 'services');
    s.innerHTML = `
      <div class="dash-tools">
        <div class="field dash-filter"><span class="field-icon">${icon('search')}</span><input placeholder="${t('dashboard.svcFilter')}" spellcheck="false"></div>
        <div class="seg dash-status">
          <button data-st="all">${t('dashboard.fAll')}</button>
          <button data-st="active">${t('dashboard.fRunning')}</button>
          <button data-st="failed">${t('dashboard.stFailed')}</button>
          <button data-st="inactive">${t('dashboard.stStopped')}</button>
        </div>
        <span class="dash-count"></span>
      </div>
      <div class="dash-hint" hidden></div>
      <div class="dash-card dash-list-card"><table class="dash-table dash-svc"><tbody></tbody></table><p class="dash-note dash-empty" hidden></p></div>`;
    const input = s.querySelector('.dash-filter input');
    input.addEventListener('input', () => { st.filter = input.value; renderServices(st); });
    input.addEventListener('keydown', e => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = st.filter = ''; renderServices(st); } });
    for (const b of s.querySelectorAll('[data-st]')) b.addEventListener('click', () => { st.status = b.dataset.st; renderServices(st); });
  }

  function adminHint(st) {
    const p = st.probe;
    if (p.root || p.sudo === 'nopass') return '';
    return p.sudo === 'password'
      ? t('dashboard.adminHintPass')
      : t('dashboard.adminHintNone');
  }

  function renderServices(st) {
    const s = sec(st, 'services');
    for (const b of s.querySelectorAll('[data-st]')) b.classList.toggle('on', b.dataset.st === st.status);
    const hint = s.querySelector('.dash-hint');
    hint.textContent = adminHint(st);
    hint.hidden = !hint.textContent;
    const all = st.services || [];
    const q = st.filter.trim().toLowerCase();
    const order = { failed: 0, activating: 1, deactivating: 1, reloading: 1, active: 2 };
    const list = all
      .filter(x => st.status === 'all' || (st.status === 'inactive' ? !['active', 'failed', 'activating', 'reloading'].includes(x.active) : x.active === st.status))
      .filter(x => !q || x.name.toLowerCase().includes(q) || x.description.toLowerCase().includes(q))
      .sort((a, b) => (order[a.active] ?? 3) - (order[b.active] ?? 3) || a.name.localeCompare(b.name));
    const failed = all.filter(x => x.active === 'failed').length;
    const running = all.filter(x => x.active === 'active').length;
    s.querySelector('.dash-count').textContent = st.services ? t('dashboard.svcCount', { running, failed, total: all.length }) : '';

    const body = s.querySelector('tbody');
    body.innerHTML = '';
    for (const svc of list) {
      const [label, cls] = svcState(svc);
      const tr = el('tr', 'dash-row-' + cls);
      const stTd = el('td', 'dash-state');
      stTd.append(el('span', 'dash-dot ' + cls), label);
      stTd.title = `${svc.active} (${svc.sub})`;
      const name = el('td', 'dash-name');
      name.append(el('div', 'dash-mono', shortUnit(svc.name)), el('div', 'dash-muted', svc.description));
      name.title = svc.name;
      const acts = el('td', 'dash-acts');
      const busy = st.busy.has(svc.name);
      const isOn = svc.active === 'active' || svc.active === 'activating' || svc.active === 'reloading';
      if (!isOn) acts.appendChild(actionBtn('Start', 'play', () => serviceAction(st, svc, 'start')));
      if (isOn) acts.appendChild(actionBtn('Stop', 'stop', () => serviceAction(st, svc, 'stop')));
      acts.appendChild(actionBtn(t('dashboard.restart'), 'restart', () => serviceAction(st, svc, 'restart')));
      if (st.probe.journal) acts.appendChild(actionBtn('Logs', 'logs', () => showLogs(st, { kind: 'service', id: svc.name, title: shortUnit(svc.name) }), 'ghost'));
      for (const b of acts.querySelectorAll('button')) b.disabled = busy || st.tab.state !== 'open';
      if (busy) acts.prepend(el('span', 'spinner'));
      tr.append(stTd, name, acts);
      tr.addEventListener('dblclick', e => { if (!e.target.closest('button') && st.probe.journal) showLogs(st, { kind: 'service', id: svc.name, title: shortUnit(svc.name) }); });
      body.appendChild(tr);
    }
    const empty = s.querySelector('.dash-empty');
    empty.textContent = st.servicesErr ? t('dashboard.svcLoadFailed', { error: st.servicesErr })
      : !st.services ? t('dashboard.svcLoading')
      : !list.length ? (q || st.status !== 'all' ? t('dashboard.svcNoMatch') : t('dashboard.svcNone')) : '';
    empty.hidden = !empty.textContent;
  }

  // Texte je Aktion: Rückfrage (Titel, Text), Knopf, Erfolg, Fehler
  const VERB = {
    start: {
      title: what => t('dashboard.askStartTitle', { what }), message: name => t('dashboard.askStart', { name }), ok: () => t('dashboard.btnStart'),
      done: name => t('dashboard.doneStart', { name }), failed: (name, error) => t('dashboard.failStart', { name, error }),
    },
    stop: {
      title: what => t('dashboard.askStopTitle', { what }), message: name => t('dashboard.askStop', { name }), ok: () => t('dashboard.btnStop'),
      done: name => t('dashboard.doneStop', { name }), failed: (name, error) => t('dashboard.failStop', { name, error }),
    },
    restart: {
      title: what => t('dashboard.askRestartTitle', { what }), message: name => t('dashboard.askRestart', { name }), ok: () => t('dashboard.btnRestart'),
      done: name => t('dashboard.doneRestart', { name }), failed: (name, error) => t('dashboard.failRestart', { name, error }),
    },
  };

  // Gemeinsamer Ablauf für Dienste und Container: Rückfrage, ausführen, ggf. Terminal anbieten
  async function runAction(st, { what, name, detail, action, call, reload, busyKey }) {
    const V = VERB[action];
    const ok = await askLocal({
      kind: 'confirm', title: V.title(what),
      message: V.message(name),
      detail, okLabel: V.ok(), danger: action !== 'start',
    });
    if (!ok) return;
    st.busy.add(busyKey);
    render(st);
    let res;
    try { res = await call(); } catch (err) { res = { ok: false, error: errMsg(err) }; }
    st.busy.delete(busyKey);
    if (res.ok) flash(V.done(name));
    else if (res.needsAdmin && res.terminal) {
      const go = await askLocal({
        kind: 'confirm', title: t('dashboard.adminNeeded'), okLabel: t('dashboard.runInTerminal'),
        message: t('dashboard.adminAskTerminal', { hint: res.hint }), detail: res.terminal,
      });
      if (go) runQuick(res.terminal);
    } else if (res.needsAdmin) askLocal({ kind: 'info', title: t('dashboard.adminNeeded'), message: res.hint, detail: res.detail || '' });
    else showError(V.failed(name, res.error));
    await reload();
    render(st);
  }

  function serviceAction(st, svc, action) {
    return runAction(st, {
      what: t('dashboard.whatService'), name: shortUnit(svc.name), detail: `${svc.name}${svc.description ? ' – ' + svc.description : ''}`, action, busyKey: svc.name,
      call: () => D.serviceAction(st.tab.id, svc.name, action),
      reload: async () => { await new Promise(r => setTimeout(r, 500)); await loadServices(st); },
    });
  }

  // ===================== Docker =====================

  const CT_STATE = { running: [t('dashboard.stRunning'), 'ok'], exited: [t('dashboard.stExited'), 'off'], created: [t('dashboard.stCreated'), 'off'], paused: [t('dashboard.stPaused'), 'warn'], restarting: [t('dashboard.stRestarting'), 'warn'], dead: [t('dashboard.stFailed'), 'bad'], removing: [t('dashboard.stRemoving'), 'warn'] };

  function buildDocker(st) {
    const s = sec(st, 'docker');
    s.innerHTML = `
      <div class="dash-tools">
        <div class="field dash-filter"><span class="field-icon">${icon('search')}</span><input placeholder="${t('dashboard.ctFilter')}" spellcheck="false"></div>
        <span class="dash-count"></span>
      </div>
      <div class="dash-hint" hidden></div>
      <div class="dash-card dash-list-card"><table class="dash-table dash-ct">
        <thead><tr><th>Status</th><th>Name</th><th>Image</th><th>Ports</th><th></th></tr></thead><tbody></tbody>
      </table><p class="dash-note dash-empty" hidden></p></div>`;
    const input = s.querySelector('.dash-filter input');
    input.addEventListener('input', () => { st.dFilter = input.value; renderDocker(st); });
    input.addEventListener('keydown', e => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = st.dFilter = ''; renderDocker(st); } });
  }

  function renderDocker(st) {
    const s = sec(st, 'docker');
    const all = st.containers || [];
    const q = st.dFilter.trim().toLowerCase();
    const list = all.filter(c => !q || `${c.name} ${c.image} ${c.ports}`.toLowerCase().includes(q))
      .sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || a.name.localeCompare(b.name));
    const hint = s.querySelector('.dash-hint');
    hint.textContent = st.containersErr;
    hint.hidden = !hint.textContent;
    s.querySelector('.dash-count').textContent = st.containers ? t('dashboard.ctCount', { running: all.filter(c => c.state === 'running').length, total: all.length }) : '';
    s.querySelector('table').hidden = !all.length;
    const body = s.querySelector('tbody');
    body.innerHTML = '';
    for (const c of list) {
      const [label, cls] = CT_STATE[c.state] || [c.state || '?', 'off'];
      const tr = el('tr', 'dash-row-' + cls);
      const stTd = el('td', 'dash-state');
      stTd.append(el('span', 'dash-dot ' + cls), label);
      stTd.title = c.status;
      const name = el('td', 'dash-name');
      name.append(el('div', 'dash-mono', c.name), el('div', 'dash-muted', c.status));
      name.title = `ID ${c.id}`;
      const ports = el('td', 'dash-ports dash-muted', c.ports.split(',').map(x => x.trim()).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join('\n') || '–');
      const acts = el('td', 'dash-acts');
      const run = c.state === 'running' || c.state === 'restarting';
      if (!run) acts.appendChild(actionBtn('Start', 'play', () => containerAction(st, c, 'start')));
      if (run) acts.appendChild(actionBtn('Stop', 'stop', () => containerAction(st, c, 'stop')));
      acts.appendChild(actionBtn(t('dashboard.restart'), 'restart', () => containerAction(st, c, 'restart')));
      acts.appendChild(actionBtn('Logs', 'logs', () => showLogs(st, { kind: 'container', id: c.name || c.id, title: c.name }), 'ghost'));
      const busy = st.busy.has('ct:' + c.id);
      for (const b of acts.querySelectorAll('button')) b.disabled = busy || st.tab.state !== 'open';
      if (busy) acts.prepend(el('span', 'spinner'));
      tr.append(stTd, name, el('td', 'dash-mono dash-image', c.image), ports, acts);
      body.appendChild(tr);
    }
    const empty = s.querySelector('.dash-empty');
    empty.textContent = !st.containers && !st.containersErr ? t('dashboard.ctLoading')
      : st.containers && !all.length && !st.containersErr ? t('dashboard.ctNone')
      : all.length && !list.length ? t('dashboard.ctNoMatch') : '';
    empty.hidden = !empty.textContent;
  }

  function containerAction(st, c, action) {
    return runAction(st, {
      what: t('dashboard.whatContainer'), name: c.name, detail: `${c.image} · ${c.status}`, action, busyKey: 'ct:' + c.id,
      call: () => D.containerAction(st.tab.id, c.name || c.id, action),
      reload: () => loadContainers(st),
    });
  }

  // ===================== Logs-Fenster =====================

  let logModal = null;
  function buildLogModal() {
    const m = el('div', 'modal dash-log-modal');
    m.hidden = true;
    m.innerHTML = `
      <div class="dialog dash-log">
        <div class="dash-log-head">
          <h2></h2>
          <span class="spacer"></span>
          <select class="dash-log-lines" title="${t('dashboard.linesTitle')}">
            <option value="200">${t('dashboard.nLines', { n: 200 })}</option><option value="500">${t('dashboard.nLines', { n: 500 })}</option><option value="1000">${t('dashboard.nLines', { n: 1000 })}</option>
          </select>
          <button class="btn" data-l="refresh">${icon('refresh')}${t('dashboard.refresh')}</button>
          <button class="btn" data-l="live" title="${t('dashboard.liveTitle')}">${icon('radio')}${t('dashboard.live')}</button>
          <button class="btn" data-l="copy">${icon(Object.hasOwn(ICON_PATHS, 'copy') ? 'copy' : 'file')}${t('common.copy')}</button>
          <button class="btn primary" data-l="close">${t('common.close')}</button>
        </div>
        <p class="dash-note dash-log-hint" hidden></p>
        <pre class="dash-log-text"></pre>
      </div>`;
    document.body.appendChild(m);
    m.querySelector('[data-l=close]').addEventListener('click', () => { m.hidden = true; });
    m.addEventListener('mousedown', e => { if (e.target === m) m.hidden = true; });
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && !m.hidden && document.getElementById('ask-modal').hidden) { e.stopPropagation(); m.hidden = true; } }, true);
    m.querySelector('[data-l=copy]').addEventListener('click', () => { navigator.clipboard.writeText(m.querySelector('pre').textContent); flash(t('dashboard.logsCopied')); });
    return m;
  }

  async function showLogs(st, target) {
    if (!logModal) logModal = buildLogModal();
    const m = logModal;
    const pre = m.querySelector('pre');
    const hint = m.querySelector('.dash-log-hint');
    const lines = m.querySelector('.dash-log-lines');
    m.querySelector('h2').textContent = t('dashboard.logsTitle', { title: target.title });
    const load = async () => {
      pre.textContent = t('dashboard.loadingShort');
      hint.hidden = true;
      let r;
      try {
        r = target.kind === 'service' ? await D.serviceLogs(st.tab.id, target.id, Number(lines.value)) : await D.containerLogs(st.tab.id, target.id, Number(lines.value));
      } catch (err) { r = { text: '', hint: errMsg(err) }; }
      pre.textContent = r.text?.trim() ? r.text : t('dashboard.logsEmpty');
      hint.textContent = r.hint || (r.timeout ? t('dashboard.logsTimeout') : '');
      hint.hidden = !hint.textContent;
      pre.scrollTop = pre.scrollHeight;
    };
    m.querySelector('[data-l=refresh]').onclick = load;
    lines.onchange = load;
    m.querySelector('[data-l=live]').onclick = () => {
      m.hidden = true;
      const id = target.id.replace(/'/g, '');
      const sudoJ = !st.probe.root && st.probe.sudo === 'nopass' ? 'sudo ' : '';
      runQuick(target.kind === 'service' ? `${sudoJ}journalctl -u '${id}' -f -n 50` : `docker logs -f --tail 50 '${id}'`, null, true);
    };
    m.hidden = false;
    m.querySelector('[data-l=close]').focus();
    await load();
  }

  // ---------- Einhängen in renderer.js ----------

  function startTimers(st) {
    if (!st.timer) st.timer = setInterval(() => { if (!document.hidden && st.sec !== 'system') refresh(st); }, REFRESH);
    // Systemwerte kommen von der Leiste (monitor.js, alle 5 s) – nur neu zeichnen
    if (!st.sysTimer) st.sysTimer = setInterval(() => { if (st.sec === 'system' && st.probe && !st.root.hidden) renderSystem(st, true); }, 2500);
  }
  function stopTimers(st) {
    clearInterval(st.timer); clearInterval(st.sysTimer);
    st.timer = st.sysTimer = null;
  }

  // Aufruf bei jedem Wechsel von Tab, Ansicht oder Verbindungsstatus (updateToolbar)
  function update(tab) {
    for (const st of states.values()) {
      const show = !!tab && st.tab === tab && tab.view === 'dash';
      st.root.hidden = !show;
      if (!show) stopTimers(st);
    }
    if (!tab || tab.view !== 'dash') return;
    let st = states.get(tab.id);
    if (!st) { st = build(tab); states.set(tab.id, st); }
    st.root.hidden = false;
    const wasOpen = st.lastState === 'open';
    st.lastState = tab.state;
    if (tab.state === 'open') {
      startTimers(st);
      if (!wasOpen || st.probeFor !== tab.info) refresh(st);
      else render(st);
    } else { stopTimers(st); render(st); }
  }

  function detach(tab) {
    const st = states.get(tab.id);
    if (!st) return;
    stopTimers(st);
    st.root.remove();
    states.delete(tab.id);
  }

  function openSection(name) {
    const tab = tabs.get(activeId);
    if (!tab) return;
    if (tab.view !== 'dash') setView('dash');
    const st = states.get(tab.id);
    if (st) showSection(st, name);
  }

  // Einträge für die Befehlspalette
  window.Palette?.register(() => {
    const tab = tabs.get(activeId);
    if (!tab) return [];
    const st = states.get(tab.id);
    const A = (id, label, ic, fn, keywords) => ({ key: 'act:dash-' + id, section: 'actions', icon: ic, label, run: fn, keywords });
    const list = [A('view', t('dashboard.palView'), 'gauge', () => setView('dash'), 'dashboard server status monitor overview übersicht')]; // i18n-ignore
    if (!st?.probe || st.probe.systemd) list.push(A('services', t('dashboard.palServices'), 'server', () => openSection('services'), 'systemctl service starten stoppen neustart logs start stop restart dienste')); // i18n-ignore
    if (!st?.probe || st.probe.docker) list.push(A('docker', t('dashboard.palDocker'), 'container', () => openSection('docker'), 'container docker ps'));
    list.push(A('du', t('dashboard.palDu'), 'hardDrive', () => { openSection('system'); setTimeout(() => sec(states.get(tab.id), 'system')?.querySelector('.dash-du-dir')?.focus(), 50); }, 'speicherplatz platte voll du disk space full largest folders')); // i18n-ignore

    return list;
  });

  return { update, detach, openSection };
})();
