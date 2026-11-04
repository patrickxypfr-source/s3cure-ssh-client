// S3cure SSH Client – Oberfläche für Tunnel (Port-Weiterleitung)
// Wird vor renderer.js geladen. Einhängepunkt: renderer.js ruft tunnelUi.setTab(tab) in updateToolbar() auf.
(() => {
  const api = window.s3tunnels;
  const q = sel => document.querySelector(sel);

  ICON_PATHS.tunnel = 'M4 8h13 M14 5l3 3-3 3 M20 16H7 M10 13l-3 3 3 3';
  ICON_PATHS.globe = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3.5 9h17 M3.5 15h17 M12 3c2.5 2.6 3.6 5.6 3.6 9s-1.1 6.4-3.6 9 M12 3C9.5 5.6 8.4 8.6 8.4 12s1.1 6.4 3.6 9';

  const TYPE_INFO = {
    local: { label: 'Lokal', help: 'Ein Dienst auf dem Server (oder in seinem Netz) wird hier auf deinem Rechner unter localhost erreichbar – z. B. eine Web-Oberfläche oder Datenbank.' },
    remote: { label: 'Remote', help: 'Ein Dienst auf deinem Rechner wird auf dem Server erreichbar (nur dort selbst, unter localhost).' },
    dynamic: { label: 'SOCKS-Proxy', help: 'Programme wie der Browser können über den Server ins Internet bzw. in dessen Netz. Im Programm als SOCKS5-Proxy eintragen: localhost und dieser Port.' },
  };

  let tab = null;           // aktiver Tab aus renderer.js
  const statusByTab = new Map();
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cleanError = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // ---------- Bausteine ----------
  document.body.insertAdjacentHTML('beforeend', `
    <div id="tunnel-panel" hidden>
      <div class="tp-head">
        <div class="tp-title">Tunnel<span class="tp-host"></span></div>
        <button type="button" class="btn" id="tp-add">${icon('plus')}Neu</button>
      </div>
      <div class="tp-body"></div>
      <div class="tp-foot">Lokale Ports sind nur auf diesem Rechner erreichbar (127.0.0.1).</div>
    </div>
    <div id="tunnel-modal" class="modal" hidden>
      <form class="dialog" id="tunnel-form" novalidate>
        <h2 id="tunnel-form-title">Neuer Tunnel</h2>
        <label>Name <span class="muted">(optional)</span><input name="name" placeholder="z. B. Router-Oberfläche" autocomplete="off"></label>
        <div class="seg tunnel-types" id="tunnel-type">
          <button type="button" data-type="local">Lokal</button>
          <button type="button" data-type="remote">Remote</button>
          <button type="button" data-type="dynamic">SOCKS-Proxy</button>
        </div>
        <p class="tunnel-help" id="tunnel-help"></p>
        <label data-for="local dynamic">Port auf diesem Rechner<input name="localPort" type="number" min="1" max="65535" placeholder="z. B. 8080"></label>
        <label data-for="remote">Port auf dem Server<input name="remotePort" type="number" min="1" max="65535" placeholder="z. B. 9000"></label>
        <div class="row" data-for="local remote">
          <label class="grow"><span id="tunnel-target-label">Ziel</span><input name="targetHost" spellcheck="false" autocomplete="off"></label>
          <label class="port">Ziel-Port<input name="targetPort" type="number" min="1" max="65535" placeholder="80"></label>
        </div>
        <label data-for="local">Web-Seite?
          <select name="web" class="tunnel-select">
            <option value="">Nein</option>
            <option value="http">Ja, http – Knopf „Im Browser öffnen“</option>
            <option value="https">Ja, https – Knopf „Im Browser öffnen“</option>
          </select>
        </label>
        <label class="toggle"><input type="checkbox" name="autoStart"><span class="track"><span class="knob"></span></span>Beim Verbinden automatisch starten</label>
        <p class="tunnel-error" id="tunnel-error" hidden></p>
        <div class="actions">
          <button type="button" class="btn" data-cancel>Abbrechen</button>
          <button type="submit" class="btn primary">Speichern</button>
        </div>
      </form>
    </div>`);

  const panel = q('#tunnel-panel');
  const button = () => q('#btn-tunnels');

  // ---------- Panel ----------
  function placePanel() {
    const b = button();
    if (!b) return;
    const r = b.getBoundingClientRect();
    panel.style.top = `${r.bottom + 6}px`;
    panel.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
  }

  function togglePanel(show = panel.hidden) {
    panel.hidden = !show;
    button()?.classList.toggle('on', show);
    if (show) { placePanel(); refresh(); }
  }

  function currentStatus() { return tab ? statusByTab.get(tab.id) : null; }

  function stateText(t, connected) {
    if (t.state === 'active') {
      const n = t.active;
      const where = t.type === 'remote' ? `Server-Port ${t.boundPort}` : `localhost:${t.boundPort}`;
      return { cls: 'ok', text: `Aktiv auf ${where} · ${n} Verbindung${n === 1 ? '' : 'en'}` };
    }
    if (t.state === 'starting') return { cls: 'warn', text: 'Startet …' };
    if (t.state === 'error') return { cls: 'err', text: t.error || 'Fehler' };
    return { cls: '', text: connected ? 'Aus' : 'Aus – erst verbinden' };
  }

  function render() {
    const b = button();
    const st = currentStatus();
    const hostName = tab?.spec?.name || null;
    const activeCount = st ? st.tunnels.filter(t => t.state === 'active').length : 0;
    if (b) {
      const c = q('#tunnel-count');
      c.textContent = activeCount;
      c.hidden = activeCount === 0;
      b.classList.toggle('has-active', activeCount > 0);
    }
    if (panel.hidden) return;
    placePanel();
    panel.querySelector('.tp-host').textContent = hostName ? ` · ${hostName}` : '';
    q('#tp-add').hidden = !hostName;
    const body = panel.querySelector('.tp-body');

    if (!hostName) {
      body.innerHTML = '<div class="tp-empty">Tunnel lassen sich nur für gespeicherte Verbindungen einrichten.<br>Leg die Verbindung links mit ＋ an.</div>';
      return;
    }
    const list = st?.tunnels || [];
    const connected = tab.state === 'open' && st?.connected !== false;
    if (!list.length) {
      body.innerHTML = '<div class="tp-empty">Noch keine Tunnel.<br>Mit „Neu“ leitest du z. B. die Web-Oberfläche eines Geräts im Server-Netz auf deinen Rechner weiter.</div>';
      return;
    }
    body.innerHTML = '';
    for (const t of list) {
      const s = stateText(t, connected);
      const on = t.state === 'active' || t.state === 'starting';
      const row = document.createElement('div');
      row.className = 'tp-row';
      row.innerHTML = `
        <label class="toggle" title="${on ? 'Tunnel stoppen' : 'Tunnel starten'}"><input type="checkbox" ${on ? 'checked' : ''} ${connected ? '' : 'disabled'}><span class="track"><span class="knob"></span></span></label>
        <div class="tp-text">
          <div class="tp-name">${esc(t.name || TYPE_INFO[t.type].label)}${t.autoStart ? '<span class="tp-badge" title="Startet beim Verbinden automatisch">Auto</span>' : ''}</div>
          <div class="tp-desc">${esc(t.text)}</div>
          <div class="tp-state ${s.cls}">${esc(s.text)}</div>
          ${t.warning && t.state === 'active' ? `<div class="tp-state err">${esc(t.warning)}</div>` : ''}
        </div>
        <div class="tp-actions">
          ${t.type === 'local' && t.web && t.state === 'active' ? `<button type="button" class="btn tp-open" title="Im Browser öffnen">${icon('globe')}Im Browser öffnen</button>` : ''}
          <button type="button" class="mini-btn tp-edit" title="Bearbeiten">${icon('edit')}</button>
          <button type="button" class="mini-btn danger tp-del" title="Löschen">${icon('trash')}</button>
        </div>`;
      const box = row.querySelector('input');
      box.addEventListener('change', () => (box.checked ? start(t) : stop(t)));
      row.querySelector('.tp-open')?.addEventListener('click', () => api.open(tab.id, t.id).catch(err => alertError(err)));
      row.querySelector('.tp-edit').addEventListener('click', () => openForm(t));
      row.querySelector('.tp-del').addEventListener('click', () => removeTunnel(t));
      body.appendChild(row);
    }
  }

  async function refresh() {
    if (!tab) return render();
    const id = tab.id;
    try { statusByTab.set(id, await api.status(id)); } catch { /* egal */ }
    if (tab?.id === id) render();
  }

  async function start(t) {
    const id = tab.id;
    try { statusByTab.set(id, await api.start(id, t.id)); } catch (err) { alertError(err); }
    if (tab?.id === id) render();
  }

  async function stop(t) {
    const id = tab.id;
    try { statusByTab.set(id, await api.stop(id, t.id)); } catch (err) { alertError(err); }
    if (tab?.id === id) render();
  }

  function alertError(err) {
    if (typeof showError === 'function') showError(new Error(cleanError(err)));
    else alert(cleanError(err));
  }

  async function removeTunnel(t) {
    const hostName = tab?.spec?.name;
    if (!hostName) return;
    const label = t.name || t.text;
    const ok = typeof askLocal === 'function'
      ? await askLocal({ kind: 'confirm', title: 'Tunnel löschen?', message: `„${label}“ wird gelöscht. Läuft er gerade, wird er gestoppt.`, okLabel: 'Löschen', danger: true })
      : confirm(`Tunnel „${label}“ löschen?`);
    if (!ok) return;
    try { await api.remove(hostName, t.id); } catch (err) { alertError(err); }
    refresh();
  }

  // ---------- Dialog zum Anlegen/Bearbeiten ----------
  const form = q('#tunnel-form');
  let editing = null;
  let formType = 'local';

  function setType(type) {
    formType = type;
    for (const b of form.querySelectorAll('#tunnel-type button')) b.classList.toggle('on', b.dataset.type === type);
    for (const el of form.querySelectorAll('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(type);
    q('#tunnel-help').textContent = TYPE_INFO[type].help;
    q('#tunnel-target-label').textContent = type === 'remote' ? 'Ziel auf diesem Rechner' : 'Ziel (vom Server aus gesehen)';
    form.targetHost.placeholder = type === 'remote' ? '127.0.0.1' : 'localhost oder z. B. 192.168.1.1';
  }
  for (const b of form.querySelectorAll('#tunnel-type button')) b.addEventListener('click', () => setType(b.dataset.type));

  // Typische Web-Ports: „Web-Seite“ vorschlagen
  form.targetPort.addEventListener('change', () => {
    if (editing || form.web.dataset.touched) return;
    const p = Number(form.targetPort.value);
    form.web.value = [443, 8443, 9443].includes(p) ? 'https' : [80, 8000, 8080, 8081, 3000, 5000, 8888, 9000].includes(p) ? 'http' : '';
  });
  form.web.addEventListener('change', () => { form.web.dataset.touched = '1'; });

  function openForm(t) {
    editing = t || null;
    q('#tunnel-form-title').textContent = t ? 'Tunnel bearbeiten' : 'Neuer Tunnel';
    form.name.value = t?.name || '';
    form.localPort.value = t?.localPort || '';
    form.remotePort.value = t?.remotePort || '';
    form.targetHost.value = t?.targetHost || '';
    form.targetPort.value = t?.targetPort || '';
    form.web.value = t?.web || '';
    delete form.web.dataset.touched;
    form.autoStart.checked = !!t?.autoStart;
    q('#tunnel-error').hidden = true;
    setType(t?.type || 'local');
    q('#tunnel-modal').hidden = false;
    form.name.focus();
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const hostName = tab?.spec?.name;
    if (!hostName) return;
    const tunnel = {
      id: editing?.id, type: formType, name: form.name.value,
      localPort: form.localPort.value, remotePort: form.remotePort.value,
      targetHost: form.targetHost.value, targetPort: form.targetPort.value,
      web: form.web.value, autoStart: form.autoStart.checked,
    };
    try {
      await api.save(hostName, tunnel);
      q('#tunnel-modal').hidden = true;
      refresh();
    } catch (err) {
      const el = q('#tunnel-error');
      el.textContent = cleanError(err);
      el.hidden = false;
    }
  });
  form.querySelector('[data-cancel]').addEventListener('click', () => { q('#tunnel-modal').hidden = true; });

  // ---------- Ereignisse ----------
  document.addEventListener('DOMContentLoaded', () => {
    button()?.addEventListener('click', e => { e.stopPropagation(); togglePanel(); });
  });
  q('#tp-add').addEventListener('click', () => openForm(null));
  document.addEventListener('mousedown', e => {
    if (panel.hidden || panel.contains(e.target) || button()?.contains(e.target)) return;
    if (!q('#tunnel-modal').hidden || !q('#ask-modal')?.hidden) return;
    togglePanel(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!q('#tunnel-modal').hidden) { q('#tunnel-modal').hidden = true; e.stopPropagation(); }
    else if (!panel.hidden && q('#ask-modal')?.hidden !== false) togglePanel(false);
  }, true);
  window.addEventListener('resize', () => { if (!panel.hidden) placePanel(); });

  api.onStatus((tabId, st) => {
    statusByTab.set(tabId, st);
    if (tab?.id === tabId) render();
  });

  window.tunnelUi = {
    // Aufruf aus renderer.js, wenn sich Tab oder Verbindungsstatus ändert
    setTab(t) {
      const changed = t?.id !== tab?.id || t?.state !== tab?._tunnelState;
      tab = t || null;
      if (tab) tab._tunnelState = tab.state;
      if (!tab) { togglePanel(false); return; }
      if (changed) refresh(); else render();
    },
  };
})();
