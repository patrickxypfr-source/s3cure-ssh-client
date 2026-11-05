// Server-Übersicht in der Werkzeugleiste: CPU, RAM, Platte, Laufzeit des aktiven Tabs.
// Abfrage alle 5 s über einen eigenen exec-Kanal (app/lib/monitor.js), nur solange der Tab
// sichtbar ist. Liefert der Server keine Werte, bleibt die Anzeige ausgeblendet.
// Wird vor renderer.js geladen – tabs, activeId, formatSize erst beim Aufruf benutzen.
const Monitor = (() => {
  const api = window.myssh;
  const INTERVAL = 5000;
  const MAX_FAILS = 2;
  const unsupported = new WeakSet(); // tab.info der Verbindungen ohne Werte (neu verbinden = neuer Versuch)

  let current = null; // Tab-ID, die gerade abgefragt wird
  let timer = null;
  let round = 0;
  let pop = null;

  const btn = () => document.getElementById('monitor');

  function update(tab) {
    const want = tab && tab.state === 'open' && tab.info && !document.hidden && !unsupported.has(tab.info) ? tab.id : null;
    if (want !== current) {
      clearTimeout(timer);
      round++;
      current = want;
      if (!want) closePop();
      if (want) poll(round);
    }
    if (tab && tab.monitorInfo !== tab.info) { tab.monitorStats = null; tab.monitorFails = 0; tab.monitorInfo = tab.info; }
    show(tab && want ? tab : null);
  }

  async function poll(r) {
    const id = current;
    let res = null;
    try { res = await api.monitorStats(id); } catch { res = { ok: false }; }
    if (r !== round || current !== id) return; // inzwischen anderer Tab
    const tab = tabs.get(id);
    if (!tab) return;
    if (res && res.busy) { /* vorige Abfrage läuft noch */ }
    else if (res && res.ok) { tab.monitorStats = res; tab.monitorFails = 0; }
    else {
      tab.monitorFails = (tab.monitorFails || 0) + 1;
      if (!res || tab.monitorFails >= MAX_FAILS) {
        if (res && tab.info) unsupported.add(tab.info);
        tab.monitorStats = null;
        current = null;
        show(null);
        closePop();
        return;
      }
    }
    show(tab);
    if (pop) renderPop(tab);
    timer = setTimeout(() => poll(r), INTERVAL);
  }

  // ---------- Anzeige ----------

  const pct = (used, total) => (total ? Math.max(0, Math.min(100, (100 * used) / total)) : 0);
  const level = p => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : '');
  const fmtPct = p => t('monitor.pct', { value: Math.round(p) });
  const cpuOf = s => (s.cpu != null ? s.cpu : s.cpuApprox);

  function uptimeText(sec, long = false) {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (long) {
      const parts = [];
      if (d) parts.push(t('monitor.days', { count: d }));
      if (h || d) parts.push(t('monitor.hoursLong', { h }));
      parts.push(t('monitor.minutesLong', { m }));
      return parts.join(', ');
    }
    if (d) return t('monitor.upDays', { d, h });
    if (h) return t('monitor.upHours', { h, m });
    return t('monitor.upMinutes', { m });
  }

  function item(label, p, text, cls = '') {
    const lv = p == null ? '' : level(p);
    return `<span class="mon-item ${cls} ${lv}"><span class="mon-k">${label}</span>` +
      (p == null ? '' : `<span class="mon-bar"><i style="width:${p.toFixed(1)}%"></i></span>`) +
      `<span class="mon-v">${text}</span></span>`;
  }

  function show(tab) {
    const b = btn();
    if (!b) return;
    const s = tab && tab.monitorStats;
    if (!s) { b.hidden = true; return; }
    const parts = [];
    const cpu = cpuOf(s);
    if (cpu != null) parts.push(item('CPU', cpu, (s.cpu == null ? '~' : '') + fmtPct(cpu)));
    if (s.mem) { const p = pct(s.mem.used, s.mem.total); parts.push(item('RAM', p, fmtPct(p))); }
    if (s.disk) { const p = pct(s.disk.used, s.disk.used + s.disk.free); parts.push(item(t('monitor.disk'), p, fmtPct(p))); }
    if (s.uptime != null) parts.push(item(t('monitor.up'), null, uptimeText(s.uptime), 'mon-up'));
    if (!parts.length) { b.hidden = true; return; }
    b.innerHTML = parts.join('');
    b.hidden = false;
    b.classList.toggle('open', !!pop);
  }

  // ---------- Details (Popover) ----------

  function row(label, value, p) {
    return `<div class="mon-row"><span class="mon-rk">${label}</span><span class="mon-rv">${value}</span></div>` +
      (p == null ? '' : `<div class="mon-rbar ${level(p)}"><i style="width:${p.toFixed(1)}%"></i></div>`);
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (n, d = 2) => n.toLocaleString(I18N.locale, { minimumFractionDigits: d, maximumFractionDigits: d });

  function renderPop(tab) {
    const s = tab && tab.monitorStats;
    if (!pop || !s) return;
    let html = `<div class="mon-title">${esc(s.hostname || tab.title)}</div>`;
    if (s.system) html += `<div class="mon-sub">${esc(s.system)}</div>`;
    const cpu = cpuOf(s);
    if (cpu != null) {
      const cores = s.cpus ? ` · ${t('monitor.cores', { count: s.cpus })}` : '';
      html += row(t('monitor.cpuUsage'), `${s.cpu == null ? t('monitor.approx', { value: fmtPct(cpu) }) : fmtPct(cpu)}${cores}`, cpu);
    }
    if (s.load) html += row(t('monitor.load'), s.load.map(x => (x == null ? '–' : num(x))).join(' / '));
    if (s.mem) {
      const p = pct(s.mem.used, s.mem.total);
      html += row(t('monitor.memory'), `${t('monitor.usedOf', { used: formatSize(s.mem.used), total: formatSize(s.mem.total) })} · ${fmtPct(p)}`, p);
    }
    if (s.swap) {
      const p = pct(s.swap.used, s.swap.total);
      html += row(t('monitor.swap'), t('monitor.usedOf', { used: formatSize(s.swap.used), total: formatSize(s.swap.total) }), p);
    }
    if (s.disk) {
      const p = pct(s.disk.used, s.disk.used + s.disk.free);
      html += row(t('monitor.diskMount', { mount: esc(s.disk.mount || '/') }), t('monitor.diskValue', { used: formatSize(s.disk.used), total: formatSize(s.disk.total), free: formatSize(s.disk.free) }), p);
    }
    if (s.uptime != null) html += row(t('monitor.uptime'), uptimeText(s.uptime, true));
    const at = I18N.fmtTime(s.at || Date.now());
    html += `<div class="mon-foot">${t('monitor.footer', { time: at })}</div>`;
    pop.innerHTML = html;
  }

  function openPop() {
    const tab = tabs.get(activeId);
    if (!tab || !tab.monitorStats) return;
    pop = document.createElement('div');
    pop.id = 'monitor-pop';
    document.body.appendChild(pop);
    renderPop(tab);
    const r = btn().getBoundingClientRect();
    const w = pop.getBoundingClientRect().width;
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    pop.style.top = r.bottom + 6 + 'px';
    btn().classList.add('open');
  }

  function closePop() {
    if (!pop) return;
    pop.remove();
    pop = null;
    btn()?.classList.remove('open');
  }

  // Ereignisse erst anhängen, wenn die Seite steht
  function init() {
    btn().addEventListener('click', () => (pop ? closePop() : openPop()));
    document.addEventListener('mousedown', e => { if (pop && !e.target.closest('#monitor-pop, #monitor')) closePop(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });
    window.addEventListener('blur', closePop);
    // Fenster minimiert/verdeckt -> nicht weiter abfragen
    document.addEventListener('visibilitychange', () => update(tabs.get(activeId)));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return { update };
})();
