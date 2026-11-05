// Übersicht → „Sicherheit“: Note A–F und Prüfpunkte (lib/security-check.js).
// „Beheben“ zeigt den genauen Befehl, fragt nach und führt ihn sichtbar im Terminal aus (runQuick).
(() => {
  const ORDER = { bad: 0, warn: 1, unknown: 2, info: 3, ok: 4 };
  const ICON = { bad: 'alert', warn: 'alert', unknown: 'help', info: 'info', ok: 'checkCircle' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;

  function build(st, el) {
    st.security = { result: null, loading: false, error: '', stale: false };
    el.classList.add('sec-view');
    el.innerHTML = `
      <div class="sec-head card">
        <div class="sec-grade"><span></span></div>
        <div class="sec-summary">
          <div class="sec-title">${t('sec.title')}</div>
          <div class="sec-sub"></div>
          <div class="sec-mode" hidden></div>
        </div>
        <button class="btn" data-s="scan">${icon('refresh')}<span>${t('sec.scan')}</span></button>
      </div>
      <div class="sec-msg" hidden></div>
      <div class="sec-list"></div>
      <p class="sec-note">${t('sec.note')}</p>`;
    el.querySelector('[data-s=scan]').addEventListener('click', () => scan(st, el));
  }

  function show(st, el, force) {
    const s = st.security;
    if (force || s.stale || (!s.result && !s.loading && !s.error)) return scan(st, el);
    render(st, el);
  }

  async function scan(st, el) {
    const s = st.security;
    if (s.loading) return;
    s.loading = true; s.error = ''; s.stale = false;
    render(st, el);
    try {
      s.result = await s3sec.scan(st.tab.id, { auth: st.tab.info?.auth || null });
    } catch (err) {
      s.error = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      s.loading = false;
      render(st, el);
    }
  }

  function render(st, el) {
    const s = st.security;
    const r = s.result;
    const btn = el.querySelector('[data-s=scan]');
    btn.disabled = s.loading;
    btn.classList.toggle('spinning', s.loading);
    const msg = el.querySelector('.sec-msg');
    msg.hidden = !s.error && !(s.loading && !r);
    msg.textContent = s.error ? t('sec.failed', { error: s.error }) : s.loading && !r ? t('sec.scanning') : '';
    const gradeEl = el.querySelector('.sec-grade');
    gradeEl.className = 'sec-grade' + (r && r.grade ? ' g-' + r.grade : r ? ' limited' : '');
    gradeEl.querySelector('span').textContent = r ? r.grade || '?' : '–';
    gradeEl.title = r && !r.grade ? t('sec.noGrade') : '';
    const counts = r ? r.checks.reduce((m, c) => (m[c.status] = (m[c.status] || 0) + 1, m), {}) : {};
    el.querySelector('.sec-sub').textContent = s.loading ? t('sec.scanning')
      : r && !r.grade ? t('sec.summaryLimited', { bad: counts.bad || 0, warn: counts.warn || 0, unknown: r.unknown, time: new Date(r.at).toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' }) })
      : r ? t('sec.summary', { score: r.score, bad: counts.bad || 0, warn: counts.warn || 0, ok: counts.ok || 0, time: new Date(r.at).toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' }) })
      : '';
    const mode = el.querySelector('.sec-mode');
    mode.hidden = !r || r.admin;
    mode.textContent = r && !r.admin ? t('sec.limited') : '';

    const list = el.querySelector('.sec-list');
    list.innerHTML = '';
    if (!r) return;
    for (const c of [...r.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status])) {
      const row = document.createElement('div');
      row.className = 'sec-row ' + c.status;
      row.innerHTML = `
        <span class="sec-ic">${icon(ICON[c.status] || 'info')}</span>
        <div class="sec-text"><div class="sec-name">${esc(c.title)}</div><div class="sec-detail">${esc(c.detail)}</div>
          ${c.blocked ? `<div class="sec-blocked">${esc(c.blocked)}</div>` : ''}</div>
        ${c.fix ? `<button class="btn ${c.status === 'bad' ? 'primary' : ''} small" data-fix>${icon('hammer')}<span>${t('sec.fix')}</span></button>` : ''}`;
      row.querySelector('[data-fix]')?.addEventListener('click', () => fix(st, el, c, r));
      list.appendChild(row);
    }
  }

  async function fix(st, el, c, r) {
    // Nicht als root angemeldet -> mit sudo (fragt im Terminal nach dem Passwort)
    const cmd = r.mode === 'root' ? c.fix : `sudo sh -c ${sq(c.fix)}`;
    const ok = await askLocal({
      kind: 'confirm', title: t('sec.fixTitle', { title: c.title }),
      message: [c.fixNote || t('sec.fixMsg'), c.danger ? t('sec.fixDanger') : ''].filter(Boolean).join('\n\n'),
      detail: cmd, okLabel: t('sec.fixRun'), danger: !!c.danger,
    });
    if (!ok) return;
    st.security.stale = true; // beim nächsten Öffnen neu prüfen
    runQuick(cmd, null, false, t('sec.fixLabel', { title: c.title }));
  }

  window.Dashboard?.addSection({ id: 'security', label: t('sec.tab'), icon: 'shieldCheck', build, show });

  window.Palette?.register(() => (tabs.get(activeId) && !window.FtpUi?.isFtpTab(tabs.get(activeId)) && !window.LocalTerm?.isLocalTab(tabs.get(activeId))
    ? [{ key: 'act:security', section: 'actions', icon: 'shieldCheck', label: t('sec.palette'), run: () => Dashboard.openSection('security'),
      keywords: 'sicherheit security check firewall fail2ban ssh härten hardening audit' }] // i18n-ignore
    : []));
})();
