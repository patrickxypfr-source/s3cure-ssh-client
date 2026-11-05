// „Alle Server“: eine Karte pro gespeicherter SSH-Verbindung mit Zustand, CPU, RAM, Platte und
// ausgefallenen Diensten. Geprüft wird im Hauptprozess (lib/server-watch.js) – regelmäßig im
// Hintergrund und auf Knopfdruck. Einstieg: unten in der Seitenleiste, Befehlspalette, Mitteilung.
window.ServerWatch = (() => {
  let snap = { running: false, enabled: true, list: [] };
  let highlight = null;
  let ticker = null;

  // ---------- Fenster ----------
  const modal = document.createElement('div');
  modal.id = 'watch-modal';
  modal.className = 'modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="dialog watch-dialog" role="dialog" aria-modal="true">
      <div class="watch-head">
        <div>
          <h2>${icon('server')}<span>${t('watch.title')}</span></h2>
          <div class="watch-sub"></div>
        </div>
        <div class="watch-actions">
          <button class="btn" data-w="check">${icon('refresh')}<span>${t('watch.checkAll')}</span></button>
          <button class="mini-btn" data-w="close" title="${t('common.close')}">${icon('close')}</button>
        </div>
      </div>
      <div class="watch-summary"></div>
      <div class="watch-grid"></div>
      <p class="watch-note"></p>
    </div>`;
  document.body.appendChild(modal);
  const $w = sel => modal.querySelector(sel);

  modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  $w('[data-w=close]').addEventListener('click', close);
  $w('[data-w=check]').addEventListener('click', () => check());

  function open(name = null) {
    highlight = name;
    modal.hidden = false;
    s3watch.list().then(s => {
      snap = s;
      render();
      // Noch nie geprüft? Dann gleich prüfen
      if (!s.running && s.list.length && s.list.every(r => r.state === 'pending')) check();
    });
    clearInterval(ticker);
    ticker = setInterval(renderSub, 30000); // „vor x Min.“ aktuell halten
    $w('[data-w=check]').focus();
  }
  function close() {
    modal.hidden = true;
    highlight = null;
    clearInterval(ticker);
  }
  function check(names) {
    s3watch.check(names || null).then(s => { snap = s; render(); });
  }

  // ---------- Darstellung ----------
  const RANK = { offline: 0, error: 1, hostkey: 2, warn: 3, auth: 4, pending: 5, ok: 6 };
  const pct = (used, total) => (total ? Math.round(100 * used / total) : null);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ago(at) {
    if (!at) return '';
    const m = Math.round((Date.now() - at) / 60000);
    return m < 1 ? t('watch.justNow') : t('watch.minAgo', { n: m });
  }

  function uptime(sec) {
    if (sec == null) return '';
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600);
    return d ? t('watch.upDays', { d, h }) : t('watch.upHours', { h, m: Math.floor(sec % 3600 / 60) });
  }

  function bar(label, value, detail, limit) {
    if (value == null) return '';
    const v = Math.max(0, Math.min(100, value));
    const level = v >= limit ? 'bad' : v >= limit - 15 ? 'mid' : 'good';
    return `<div class="wbar ${level}"><div class="wbar-top"><span>${label}</span><b>${Math.round(v)} %</b></div>
      <div class="wbar-track"><div style="width:${v}%"></div></div>${detail ? `<div class="wbar-detail">${esc(detail)}</div>` : ''}</div>`;
  }

  function stateLabel(r) {
    if (r.state === 'warn') {
      const n = (r.issues || []).length;
      return t(n === 1 ? 'watch.stateWarnOne' : 'watch.stateWarn', { n });
    }
    const keys = { ok: 'watch.state_ok', offline: 'watch.state_offline', error: 'watch.state_error', auth: 'watch.state_auth', hostkey: 'watch.state_hostkey', pending: 'watch.state_pending' };
    return t(keys[r.state] || keys.error);
  }

  function card(r) {
    const h = hosts[r.name] || {};
    const el = document.createElement('div');
    el.className = `wcard ${r.state}` + (highlight === r.name ? ' hl' : '');
    el.dataset.name = r.name;
    const color = typeof hostColor === 'function' ? hostColor(r.name) : null;
    if (color) el.style.setProperty('--host-color', color);
    const s = r.stats || null;
    let body = '';
    if (s) {
      const disk = s.disk ? pct(s.disk.used, s.disk.used + s.disk.free) : null;
      const cpu = s.cpu != null ? s.cpu : s.cpuApprox;
      body += bar(t('watch.cpu'), cpu, s.cpus ? t('watch.cores', { n: s.cpus }) : '', 90);
      body += bar(t('watch.ram'), s.mem ? pct(s.mem.used, s.mem.total) : null, s.mem ? `${formatSize(s.mem.used)} / ${formatSize(s.mem.total)}` : '', 95);
      body += bar(t('watch.disk'), disk, s.disk ? t('watch.free', { size: formatSize(s.disk.free) }) : '', Number(Settings.get('watch.disk')) || 90);
    }
    const failed = r.failed || [];
    const issuesHtml = failed.length
      ? `<div class="wfailed">${icon('alert')}<span>${esc(t(failed.length === 1 ? 'watch.failedOne' : 'watch.failed', { n: failed.length }))}: ${failed.map(esc).join(', ')}</span></div>` : '';
    const errorHtml = r.error && r.state !== 'ok' && r.state !== 'warn'
      ? `<div class="werror">${esc(hintFor(r))}</div>` : '';
    el.innerHTML = `
      <div class="wcard-head">
        <div class="wcard-title"><span class="wname"></span><span class="waddr"></span></div>
        <span class="wstate"><span class="wdot"></span>${esc(stateLabel(r))}</span>
      </div>
      ${body ? `<div class="wbars">${body}</div>` : ''}
      ${issuesHtml}${errorHtml}
      <div class="wcard-foot">
        <span class="wmeta">${esc([s && s.uptime != null ? uptime(s.uptime) : '', r.at ? ago(r.at) : ''].filter(Boolean).join(' · '))}</span>
        <span class="wbtns">
          <button class="mini-btn" data-a="check" title="${t('watch.checkOne')}">${icon('refresh')}</button>
          <button class="btn ghost small" data-a="open">${icon('terminal')}<span>${t('watch.openTerminal')}</span></button>
        </span>
      </div>`;
    el.querySelector('.wname').textContent = r.name;
    el.querySelector('.waddr').textContent = h.host ? `${h.user}@${h.host}${h.port && h.port !== 22 ? ':' + h.port : ''}` : '';
    el.querySelector('[data-a=check]').addEventListener('click', () => check([r.name]));
    el.querySelector('[data-a=open]').addEventListener('click', () => { close(); openTab({ name: r.name }, r.name); });
    return el;
  }

  // Verständlicher Hinweis, was zu tun ist
  function hintFor(r) {
    if (r.state === 'auth') return t('watch.hintAuth');
    if (r.state === 'hostkey') return t('watch.hintHostKey');
    if (r.state === 'offline') return t('watch.hintOffline', { error: r.error });
    return r.error;
  }

  function renderSub() {
    const done = snap.list.filter(r => r.at);
    const last = done.length ? Math.max(...done.map(r => r.at)) : 0;
    $w('.watch-sub').textContent = snap.running ? t('watch.checking')
      : last ? t('watch.lastCheck', { ago: ago(last) }) : t('watch.neverChecked');
    for (const el of modal.querySelectorAll('.wcard')) {
      const r = snap.list.find(x => x.name === el.dataset.name);
      const meta = el.querySelector('.wmeta');
      if (r && meta && r.at) meta.textContent = [r.stats && r.stats.uptime != null ? uptime(r.stats.uptime) : '', ago(r.at)].filter(Boolean).join(' · ');
    }
  }

  function render() {
    renderFoot();
    if (modal.hidden) return;
    const btn = $w('[data-w=check]');
    btn.disabled = snap.running;
    btn.classList.toggle('spinning', snap.running);
    renderSub();
    const counts = { bad: 0, warn: 0, ok: 0 };
    for (const r of snap.list) {
      if (r.state === 'offline' || r.state === 'error') counts.bad++;
      else if (r.state === 'warn' || r.state === 'auth' || r.state === 'hostkey') counts.warn++;
      else if (r.state === 'ok') counts.ok++;
    }
    $w('.watch-summary').innerHTML = snap.list.length ? `
      <span class="wsum ok"><span class="wdot"></span>${t('watch.sumOk', { n: counts.ok })}</span>
      <span class="wsum warn"><span class="wdot"></span>${t('watch.sumWarn', { n: counts.warn })}</span>
      <span class="wsum bad"><span class="wdot"></span>${t('watch.sumBad', { n: counts.bad })}</span>` : '';
    const grid = $w('.watch-grid');
    grid.innerHTML = '';
    if (!snap.list.length) {
      grid.innerHTML = `<div class="watch-empty">${t('watch.empty')}</div>`;
    } else {
      const list = [...snap.list].sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9) || a.name.localeCompare(b.name));
      for (const r of list) grid.appendChild(card(r));
      if (highlight) grid.querySelector('.wcard.hl')?.scrollIntoView({ block: 'nearest' });
    }
    $w('.watch-note').textContent = snap.enabled
      ? t('watch.noteOn', { min: Settings.get('watch.every') || 15 }) : t('watch.noteOff');
  }

  // ---------- Eintrag unten in der Seitenleiste ----------
  const foot = document.getElementById('sidebar-foot');
  const footBtn = document.createElement('button');
  footBtn.id = 'open-watch';
  footBtn.className = 'foot-btn';
  footBtn.type = 'button';
  footBtn.innerHTML = `${icon('server')}<span class="lbl">${t('watch.title')}</span><span class="watch-badge" hidden></span>`;
  footBtn.title = t('watch.footTitle');
  footBtn.addEventListener('click', () => open());
  if (foot) foot.prepend(footBtn);

  function renderFoot() {
    const badge = footBtn.querySelector('.watch-badge');
    const bad = snap.list.filter(r => r.state === 'offline' || r.state === 'error').length;
    const warn = snap.list.filter(r => r.state === 'warn').length;
    badge.hidden = !(bad || warn);
    badge.className = 'watch-badge ' + (bad ? 'bad' : 'warn');
    badge.textContent = bad + warn;
    footBtn.title = bad + warn ? t('watch.footTitleIssues', { n: bad + warn }) : t('watch.footTitle');
  }

  // ---------- Ereignisse ----------
  s3watch.onUpdate(s => { snap = s; render(); });
  s3watch.onShow(name => open(name || null));
  s3watch.list().then(s => { snap = s; renderFoot(); }).catch(() => {});

  window.Palette?.register(() => [{
    key: 'act:watch', section: 'actions', icon: 'server', label: t('watch.palette'), run: () => open(),
    keywords: 'alle server übersicht status überwachung monitoring all servers overview health', // i18n-ignore
  }]);

  return { open, close };
})();
