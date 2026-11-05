// Übertragungs-Warteschlange unten rechts (wie bei FileZilla):
// Gesamtfortschritt, Geschwindigkeit und Restzeit oben; darunter jeder Auftrag mit
// Pausieren/Fortsetzen, Reihenfolge (↑/↓), „Erneut versuchen“ bei Fehlern und Abbrechen.
// Erledigte bleiben stehen, bis man sie entfernt. Dazu längere Vorgänge auf dem Server
// (z. B. ZIP packen) ohne Prozentanzeige. Hauptprozess: app/lib/transfers.js.
// Einstellungen (gleichzeitige Übertragungen, Limits): Abschnitt „Übertragungen“.

Object.assign(ICON_PATHS, {
  arrowUp: 'M12 19V5 M6 11l6-6 6 6',
  arrowDown: 'M12 5v14 M6 13l6 6 6-6',
  retry: 'M4 12a8 8 0 1 0 2.34-5.66 M4 4v5h5',
  transfers: 'M7 4v14 M3.5 14.5L7 18l3.5-3.5 M17 20V6 M13.5 9.5L17 6l3.5 3.5',
  broom: 'M14.5 3.5l-5 9 M6 12.5h8l1.5 8h-11z M8 16.5v4 M11.5 16.5v4',
});

const Transfers = (() => {
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const box = document.createElement('div');
  box.id = 'transfers';
  box.hidden = true;
  box.innerHTML = `
    <div class="tq-head">
      <span class="tq-ico">${icon('transfers')}</span>
      <div class="tq-text"><div class="tq-title">${t('transfers.title')}</div><div class="tq-sum"></div></div>
      <button class="mini-btn" data-q="pause-all" title="${t('transfers.pauseAll')}">${icon('pause')}</button>
      <button class="mini-btn" data-q="resume-all" title="${t('transfers.resumeAll')}">${icon('play')}</button>
      <button class="mini-btn" data-q="clear" title="${t('transfers.clear')}">${icon('broom')}</button>
      <button class="mini-btn tq-fold" data-q="fold" title="${t('transfers.collapse')}">${icon('down')}</button>
    </div>
    <div class="t-bar tq-bar"><div class="t-fill"></div></div>
    <div class="tq-list"></div>`;
  document.getElementById('main').appendChild(box);
  const list = box.querySelector('.tq-list');

  let folded = lsGet('transfers:folded', false);
  box.classList.toggle('folded', folded);

  const items = new Map(); // id -> { el, info }
  let seqCounter = 0;      // Reihenfolge für Vorgänge ohne Warteschlange (ZIP …)
  let busyCounter = 0;

  const FINAL = ['done', 'cancelled', 'error'];
  const isFinal = i => FINAL.includes(i.state);
  const ACTIVE = ['running', 'queued', 'preparing', 'pausing', 'waiting'];

  function duration(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '';
    if (sec < 60) return t('transfers.etaSec', { n: Math.max(1, Math.round(sec)) });
    if (sec < 3600) return t('transfers.etaMin', { n: Math.round(sec / 60) });
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m ? t('transfers.etaHoursMin', { h, m }) : t('transfers.etaHours', { h });
  }
  const speedText = bps => (bps > 0 ? `${formatSize(Math.round(bps))}/s` : '');
  const pctOf = i => (i.total ? Math.min(100, Math.floor(i.done * 100 / i.total)) : i.state === 'done' ? 100 : 0);
  const sizes = i => (i.total ? t('transfers.sizeOf', { done: formatSize(i.done), total: formatSize(i.total) }) : '');
  const pct = n => t('transfers.percent', { pct: n });

  function subText(i) {
    if (i.busy) return isFinal(i) ? (i.state === 'error' ? i.error : i.state === 'done' ? t('common.done') : t('transfers.stateCancelled')) : (i.sub || t('transfers.running'));
    const n = i.fileCount > 1 ? ` · ${t('transfers.filesOf', { files: i.files, total: i.fileCount })}` : '';
    switch (i.state) {
      case 'preparing': return t('transfers.preparing');
      case 'queued': return `${t('transfers.queued')}${i.total ? ` · ${sizes(i)}` : ''}`;
      case 'pausing': return t('transfers.pausing');
      case 'paused': return `${t('transfers.paused')} · ${sizes(i)} · ${pct(pctOf(i))}`;
      case 'waiting': return t('transfers.waiting');
      case 'cancelling': return t('transfers.cancelling');
      case 'cancelled': return t('transfers.stateCancelled');
      case 'done': return `${t('common.done')}${i.fileCount > 1 ? ` · ${t('transfers.files', { count: i.files })}` : ''} · ${formatSize(i.total)}`;
      case 'error': return (i.failed > 1 ? t('transfers.filesFailed', { count: i.failed }) : '') + (i.error || t('transfers.failed'));
      default: {
        const parts = [sizes(i), pct(pctOf(i)), speedText(i.speed), duration(i.speed ? (i.total - i.done) / i.speed : 0)].filter(Boolean);
        const file = i.file && i.file !== i.title ? `${i.file} · ` : '';
        return file + parts.join(' · ') + n;
      }
    }
  }

  function render(it) {
    const i = it.info;
    const el = it.el;
    el.className = `transfer ${i.state}${i.busy ? ' busy' : ''}`;
    el.querySelector('.t-ico').innerHTML = icon(i.kind === 'upload' ? 'upload' : i.kind === 'download' ? 'download' : i.kind === 'sync' ? 'refresh' : i.icon || 'zip');
    // 'sync': Titel sagt es (sync.js)
    el.querySelector('.t-title').textContent = i.kind === 'upload' ? t('transfers.titleUpload', { title: i.title })
      : i.kind === 'download' ? t('transfers.titleDownload', { title: i.title }) : i.title;
    const sub = subText(i);
    el.querySelector('.t-sub').textContent = sub;
    el.querySelector('.t-sub').title = sub;
    el.querySelector('.t-fill').style.width = (i.busy && !isFinal(i) ? 100 : pctOf(i)) + '%';

    const show = (a, v) => { el.querySelector(`[data-t=${a}]`).hidden = !v; };
    const paused = i.state === 'paused' || i.state === 'pausing';
    show('up', !i.busy && !isFinal(i));
    show('down', !i.busy && !isFinal(i));
    show('pause', !i.busy && ['running', 'queued', 'preparing', 'waiting'].includes(i.state));
    show('resume', !i.busy && paused);
    show('retry', !i.busy && i.state === 'error' && i.failed > 0);
    const x = el.querySelector('[data-t=x]');
    x.hidden = (i.busy && !isFinal(i)) || i.state === 'cancelling';
    x.title = isFinal(i) ? t('transfers.removeFromList') : t('common.cancel');
  }

  // Auftrag in der Reihenfolge der Warteschlange einsortieren
  function place() {
    const key = x => (x.info.busy ? 1e9 + x.info.seq : x.info.pos ?? 0);
    const sorted = [...items.values()].sort((a, b) => key(a) - key(b));
    sorted.forEach((x, idx) => { if (list.children[idx] !== x.el) list.insertBefore(x.el, list.children[idx] || null); });
  }

  function renderHead() {
    const all = [...items.values()].map(x => x.info);
    box.hidden = all.length === 0;
    if (!all.length) return;
    const jobs = all.filter(i => !i.busy);
    const open = jobs.filter(i => !isFinal(i));
    const running = open.filter(i => ACTIVE.includes(i.state));
    const total = open.reduce((s, i) => s + (i.total || 0), 0);
    const done = open.reduce((s, i) => s + Math.min(i.done || 0, i.total || 0), 0);
    const speed = running.reduce((s, i) => s + (i.speed || 0), 0);
    const percent = total ? Math.floor(done * 100 / total) : 0;
    const errors = jobs.filter(i => i.state === 'error').length;
    const finished = all.filter(i => i.state === 'done' || i.state === 'cancelled').length;
    const paused = open.filter(i => i.state === 'paused' || i.state === 'pausing').length;
    let sum;
    if (open.length) {
      sum = [t('transfers.openCount', { count: open.length }), total ? pct(percent) : '', speedText(speed), duration(speed ? (total - done) / speed : 0), paused ? t('transfers.pausedCount', { count: paused }) : '']
        .filter(Boolean).join(' · ');
    } else {
      sum = errors ? t('transfers.doneWithErrors', { count: errors }) : t('transfers.allDone');
    }
    box.querySelector('.tq-sum').textContent = sum;
    box.querySelector('.tq-bar .t-fill').style.width = (open.length ? percent : 100) + '%';
    box.classList.toggle('has-error', errors > 0 && !open.length);
    box.classList.toggle('all-done', !open.length && !errors);
    box.querySelector('[data-q=pause-all]').hidden = !open.some(i => !['paused', 'pausing', 'cancelling'].includes(i.state));
    box.querySelector('[data-q=resume-all]').hidden = !paused;
    box.querySelector('[data-q=clear]').hidden = !finished;
    box.querySelector('[data-q=fold]').title = folded ? t('transfers.expand') : t('transfers.collapse');
    autoFold(!open.length && !errors, open.length > 0);
  }

  // Alles fertig und ohne Fehler: nach ein paar Sekunden von selbst einklappen, damit die Liste
  // die Dateien nicht verdeckt. Kommt neue Arbeit dazu, wieder aufklappen (nur wenn wir selbst eingeklappt haben).
  let autoTimer = null, autoFolded = false;
  function autoFold(allDone, busy) {
    if (busy && autoFolded) { autoFolded = false; folded = false; box.classList.remove('folded'); }
    if (!allDone) { clearTimeout(autoTimer); autoTimer = null; return; }
    if (folded || autoTimer) return;
    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (box.matches(':hover') || folded) return;
      folded = true; autoFolded = true;
      box.classList.add('folded');
      box.querySelector('[data-q=fold]').title = t('transfers.expand');
    }, 3500);
  }

  function remove(id) {
    const it = items.get(id);
    if (!it) return;
    it.el.remove();
    items.delete(id);
    if (!it.info.busy) api.transferRemove(id);
    renderHead();
  }

  function upsert(info) {
    let it = items.get(info.id);
    if (!it) {
      const el = document.createElement('div');
      el.innerHTML = `
        <span class="t-ico"></span>
        <div class="t-text"><div class="t-title"></div><div class="t-sub"></div><div class="t-bar"><div class="t-fill"></div></div></div>
        <div class="t-actions">
          <button class="mini-btn t-move" data-t="up" title="${t('transfers.moveUp')}">${icon('arrowUp')}</button>
          <button class="mini-btn t-move" data-t="down" title="${t('transfers.moveDown')}">${icon('arrowDown')}</button>
          <button class="mini-btn" data-t="pause" title="${t('transfers.pause')}">${icon('pause')}</button>
          <button class="mini-btn" data-t="resume" title="${t('transfers.resume')}">${icon('play')}</button>
          <button class="mini-btn" data-t="retry" title="${t('transfers.retry')}">${icon('retry')}</button>
          <button class="mini-btn" data-t="x" title="${t('common.cancel')}">${icon('close')}</button>
        </div>`;
      const id = info.id;
      const act = (a, fn) => el.querySelector(`[data-t=${a}]`).addEventListener('click', fn);
      act('up', () => api.transferMove(id, -1));
      act('down', () => api.transferMove(id, 1));
      act('pause', () => api.transferPause(id));
      act('resume', () => api.transferResume(id));
      act('retry', () => api.transferRetry(id));
      act('x', () => {
        const cur = items.get(id);
        if (!cur) return;
        if (isFinal(cur.info)) remove(id);
        else if (!cur.info.busy) api.transferCancel(id);
      });
      list.appendChild(el);
      it = { el, info: { seq: ++seqCounter, ...info } };
      items.set(info.id, it);
    }
    const before = it.info.state;
    const oldPos = it.info.pos;
    it.info = { ...it.info, ...info };
    render(it);
    if (oldPos !== it.info.pos || before === undefined) place();
    renderHead();
    if (it.info.state === 'done' && before !== 'done' && it.info.retries > 0) refreshLists(it.info);
  }

  // Nach erfolgreichem „Erneut versuchen“ die passende Dateiliste neu laden
  function refreshLists(i) {
    const tab = typeof tabs !== 'undefined' ? tabs.get(i.tabId) : null;
    if (!tab) return;
    if (i.remoteDir && tab.files?.path === i.remoteDir && tab.state === 'open') loadDir(tab, i.remoteDir);
    if (i.localDir) window.LocalPane?.refresh?.(tab, i.localDir);
  }

  box.querySelector('[data-q=pause-all]').addEventListener('click', () => api.transferPauseAll());
  box.querySelector('[data-q=resume-all]').addEventListener('click', () => api.transferResumeAll());
  box.querySelector('[data-q=clear]').addEventListener('click', () => {
    api.transferClear();
    for (const [id, it] of [...items]) if (it.info.state === 'done' || it.info.state === 'cancelled') { it.el.remove(); items.delete(id); }
    renderHead();
  });
  const fold = () => { autoFolded = false; folded = !folded; lsSet('transfers:folded', folded); box.classList.toggle('folded', folded); renderHead(); };
  box.querySelector('[data-q=fold]').addEventListener('click', fold);
  box.querySelector('.tq-text').addEventListener('click', fold);

  api.onTransfer(upsert);
  // Nach einem Neuladen der Oberfläche: laufende Aufträge wieder anzeigen
  api.transferList?.().then(all => all.forEach(upsert)).catch(() => {});

  // Vorgang ohne Fortschritt (läuft auf dem Server)
  function busy(title, iconName = 'zip') {
    const id = 'local-' + ++busyCounter;
    upsert({ id, kind: 'task', title, icon: iconName, state: 'running', busy: true });
    return {
      done: () => upsert({ id, state: 'done' }),
      fail: err => upsert({ id, state: 'error', error: String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').split('\n')[0] }),
    };
  }

  // Abbruch-Text aus lib/transfers.js / lib/ftp.js (t('transfers.cancelled')) – kommt als Text über IPC;
  // in beiden Sprachen erkennen (die Sprache des Hauptprozesses kann vom Fenster abweichen)
  const CANCEL_RE = /Übertragung abgebrochen|Transfer cancelled/; // i18n-ignore
  const isCancel = err => { const m = String(err?.message || err); return CANCEL_RE.test(m) || m.includes(t('transfers.cancelled')); };

  // ---------- Einstellungen ----------

  const KEYS = { concurrency: 'transfers.concurrency', down: 'transfers.downKBs', up: 'transfers.upKBs' };
  if (window.registerSettingsSection) {
    registerSettingsSection({
      id: 'transfers', title: t('transfers.title'), icon: 'transfers', order: 30,
      description: t('transfers.settingsDesc'),
      defaults: { [KEYS.concurrency]: 3, [KEYS.down]: 0, [KEYS.up]: 0 },
      fields: [
        { key: KEYS.concurrency, type: 'number', label: t('transfers.concurrencyLabel'), hint: t('transfers.concurrencyHint'), min: 1, max: 10, unit: t('transfers.unitFiles') },
        { key: KEYS.down, type: 'number', label: t('transfers.downLimit'), hint: t('transfers.downLimitHint'), min: 0, max: 1000000, step: 50, unit: 'KB/s' },
        { key: KEYS.up, type: 'number', label: t('transfers.upLimit'), hint: t('transfers.upLimitHint'), min: 0, max: 1000000, step: 50, unit: 'KB/s' },
      ],
    });
    const push = () => api.transferConfig?.({
      concurrency: Settings.get(KEYS.concurrency), downKBs: Settings.get(KEYS.down), upKBs: Settings.get(KEYS.up),
    }).catch(() => {});
    Settings.ready.then(push);
    Settings.onChange((_v, changed) => { if (changed.some(k => k.startsWith('transfers.'))) push(); });
  }

  return { busy, isCancel };
})();

// Während Dateien gezogen werden, darf die schwebende Übertragungsliste nichts verdecken:
// sie wird durchlässig (Ablegen landet in der Dateiliste darunter) und halb durchsichtig.
(() => {
  let depth = 0;
  const on = () => document.body.classList.add('dnd-active');
  const off = () => { depth = 0; document.body.classList.remove('dnd-active'); };
  document.addEventListener('dragstart', on, true);
  document.addEventListener('dragenter', () => { depth++; on(); }, true);
  document.addEventListener('dragleave', () => { if (--depth <= 0) off(); }, true);
  document.addEventListener('drop', off, true);
  document.addEventListener('dragend', off, true);
})();
