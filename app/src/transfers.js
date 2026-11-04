// Übertragungsliste unten rechts: laufende Uploads/Downloads mit Fortschritt und Abbrechen,
// außerdem längere Vorgänge auf dem Server (z. B. ZIP packen) ohne Prozentanzeige.

const Transfers = (() => {
  const box = document.createElement('div');
  box.id = 'transfers';
  box.hidden = true;
  document.getElementById('main').appendChild(box);

  const items = new Map(); // id -> { el, info, timer }

  const STATE_TEXT = { done: 'Fertig', cancelled: 'Abgebrochen', cancelling: 'Wird abgebrochen …', error: 'Fehlgeschlagen' };

  function render(id) {
    const it = items.get(id);
    const i = it.info;
    const finished = ['done', 'cancelled', 'error'].includes(i.state);
    const pct = i.total ? Math.min(100, Math.floor(i.done * 100 / i.total)) : (i.state === 'done' ? 100 : 0);
    it.el.className = `transfer ${i.state}${i.busy ? ' busy' : ''}`;
    it.el.querySelector('.t-ico').innerHTML = icon(i.kind === 'upload' ? 'upload' : i.kind === 'download' ? 'download' : i.icon || 'zip');
    const verb = i.kind === 'upload' ? 'Hochladen' : i.kind === 'download' ? 'Herunterladen' : '';
    it.el.querySelector('.t-title').textContent = verb ? `${verb}: ${i.title}` : i.title;
    let sub;
    if (i.state === 'error') sub = i.error || STATE_TEXT.error;
    else if (STATE_TEXT[i.state]) sub = STATE_TEXT[i.state];
    else if (i.busy) sub = i.sub || 'Läuft …';
    else {
      sub = i.total ? `${formatSize(i.done)} von ${formatSize(i.total)} · ${pct} %` : 'Startet …';
      if (i.file && i.file !== i.title) sub = `${i.file} · ${sub}`;
    }
    it.el.querySelector('.t-sub').textContent = sub;
    it.el.querySelector('.t-sub').title = sub;
    it.el.querySelector('.t-fill').style.width = (i.busy && !finished ? 100 : pct) + '%';
    const btn = it.el.querySelector('.t-cancel');
    btn.hidden = (finished && i.state !== 'error') || (i.busy && !finished) || i.state === 'cancelling';
    btn.title = finished ? 'Ausblenden' : 'Abbrechen';
    if (finished && !it.timer) {
      it.timer = setTimeout(() => remove(id), i.state === 'error' ? 10000 : i.state === 'cancelled' ? 2500 : 3500);
    }
  }

  function remove(id) {
    const it = items.get(id);
    if (!it) return;
    clearTimeout(it.timer);
    it.el.remove();
    items.delete(id);
    box.hidden = items.size === 0;
  }

  function upsert(info) {
    let it = items.get(info.id);
    if (!it) {
      const el = document.createElement('div');
      el.innerHTML = `
        <span class="t-ico"></span>
        <div class="t-text"><div class="t-title"></div><div class="t-sub"></div><div class="t-bar"><div class="t-fill"></div></div></div>
        <button class="t-cancel mini-btn" title="Abbrechen">${icon('close')}</button>`;
      el.querySelector('.t-cancel').addEventListener('click', () => {
        const cur = items.get(info.id);
        if (!cur) return;
        if (['done', 'cancelled', 'error'].includes(cur.info.state)) remove(info.id);
        else if (!cur.info.busy) api.transferCancel(info.id);
      });
      box.appendChild(el);
      it = { el, info, timer: null };
      items.set(info.id, it);
    }
    it.info = { ...it.info, ...info };
    box.hidden = false;
    render(info.id);
  }

  api.onTransfer(upsert);

  // Vorgang ohne Fortschritt (läuft auf dem Server)
  let localCounter = 0;
  function busy(title, iconName = 'zip') {
    const id = 'local-' + ++localCounter;
    upsert({ id, kind: 'task', title, icon: iconName, state: 'running', busy: true });
    return {
      done: () => upsert({ id, state: 'done' }),
      fail: err => upsert({ id, state: 'error', error: String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').split('\n')[0] }),
    };
  }

  const isCancel = err => /Übertragung abgebrochen/.test(String(err?.message || err));

  return { busy, isCancel };
})();
