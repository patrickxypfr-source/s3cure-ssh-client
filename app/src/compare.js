// Zwei Textdateien nebeneinander vergleichen (farbige Unterschiede, Sprung zum nächsten Unterschied).
// Diff-Berechnung: src/diff-core.js. Lokale Dateien lesen: app/lib/compare.js, Server: sftp:readText.
// Aufruf: Compare.open({ left: Seite, right: Seite }), Seite = { label, name, title, load: async () => text }

Object.assign(ICON_PATHS, {
  compare: 'M8 4v16 M16 4v16 M4 8h4 M4 12h4 M16 12h4 M16 16h4',
  chevUp: 'M7 14l5-5 5 5',
  chevDown: 'M7 10l5 5 5-5',
});

const Compare = (() => {
  const LIMIT = 2 * 1024 * 1024;
  const ROW_H = 20;          // px pro Zeile (fest, damit nur sichtbare Zeilen gezeichnet werden müssen)
  const OVERSCAN = 30;
  const T = {
    title: 'Dateien vergleichen',
    loading: 'Lade und vergleiche …',
    same: 'Die Dateien sind gleich.',
    sameSpace: 'Die Dateien sind gleich (bis auf Leerzeichen).',
    diffs: n => `${n} Unterschied${n === 1 ? '' : 'e'}`,
    stats: (a, d) => `+${a} / −${d} Zeilen`,
    approx: 'Sehr viele Unterschiede – grob verglichen.',
    ignoreSpace: 'Leerzeichen ignorieren',
    prev: 'Vorheriger Unterschied (Umschalt+F7 oder ↑ mit Alt)',
    next: 'Nächster Unterschied (F7 oder ↓ mit Alt)',
    close: 'Schließen (Esc)',
    binary: name => `„${name}“ ist keine Textdatei und kann nicht verglichen werden.`,
    tooBig: name => `„${name}“ ist zu groß zum Vergleichen (höchstens 2 MB).`,
  };
  const cleanMsg = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // ---------- Laden ----------

  // Server-Datei als Text (wirft verständliche Fehler)
  async function loadRemote(tab, file) {
    const name = file.split('/').pop();
    const r = await api.sftpReadText(tab.id, file);
    if (r.binary) throw new Error(T.binary(name));
    return r.text;
  }

  async function loadLocal(file) {
    const name = file.split(/[\\/]/).pop();
    const r = await window.s3sync.readLocal(file);
    if (r.binary) throw new Error(T.binary(name));
    if (r.tooBig) throw new Error(T.tooBig(name));
    return r.text;
  }

  // ---------- Ansicht ----------

  let cur = null; // offene Vergleichsansicht

  async function open({ left, right }) {
    close();
    const modal = document.createElement('div');
    modal.className = 'modal cmp-modal';
    modal.innerHTML = `
      <div class="dialog cmp-dialog" tabindex="-1">
        <div class="cmp-head">
          <span class="cmp-ico">${icon('compare')}</span>
          <div class="cmp-title"><div class="cmp-name">${T.title}</div><div class="cmp-summary"></div></div>
          <div class="spacer"></div>
          <span class="cmp-pos"></span>
          <label class="toggle cmp-ws"><input type="checkbox"><span class="track"><span class="knob"></span></span>${T.ignoreSpace}</label>
          <button class="round-btn" data-c="prev" title="${T.prev}">${icon('chevUp')}</button>
          <button class="round-btn" data-c="next" title="${T.next}">${icon('chevDown')}</button>
          <button class="round-btn" data-c="close" title="${T.close}">${icon('close')}</button>
        </div>
        <div class="cmp-sides">
          <div class="cmp-side-head" data-side="l"><span class="cmp-badge"></span><span class="cmp-file"></span></div>
          <div class="cmp-side-head" data-side="r"><span class="cmp-badge"></span><span class="cmp-file"></span></div>
        </div>
        <div class="cmp-body">
          <div class="cmp-pane" data-side="l"><div class="cmp-sizer"></div></div>
          <div class="cmp-pane" data-side="r"><div class="cmp-sizer"></div></div>
          <div class="cmp-map" title="Übersicht – klicken zum Springen"></div>
          <div class="cmp-msg"></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const dlg = modal.querySelector('.cmp-dialog');
    const c = {
      modal, dlg, left, right, textL: null, textR: null, result: null, hunks: [], hunk: -1, charCache: new Map(),
      panes: [...modal.querySelectorAll('.cmp-pane')], msg: modal.querySelector('.cmp-msg'), map: modal.querySelector('.cmp-map'),
      ignoreSpace: false,
    };
    cur = c;
    for (const [side, info] of [['l', left], ['r', right]]) {
      const h = modal.querySelector(`.cmp-side-head[data-side=${side}]`);
      h.querySelector('.cmp-badge').textContent = info.label || '';
      h.querySelector('.cmp-file').textContent = info.name || '';
      h.title = info.title || info.name || '';
    }
    modal.querySelector('[data-c=close]').addEventListener('click', close);
    modal.querySelector('[data-c=prev]').addEventListener('click', () => jump(c, -1));
    modal.querySelector('[data-c=next]').addEventListener('click', () => jump(c, 1));
    modal.querySelector('.cmp-ws input').addEventListener('change', e => { c.ignoreSpace = e.target.checked; compute(c); });
    modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });
    dlg.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'F7' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
        e.preventDefault();
        jump(c, e.shiftKey || e.key === 'ArrowUp' ? -1 : 1);
      }
    });
    // Beide Seiten gemeinsam scrollen
    let syncing = false;
    for (const pane of c.panes) {
      pane.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        for (const other of c.panes) if (other !== pane) { other.scrollTop = pane.scrollTop; other.scrollLeft = pane.scrollLeft; }
        syncing = false;
        draw(c);
      });
    }
    c.map.addEventListener('mousedown', e => {
      if (!c.result) return;
      const r = c.map.getBoundingClientRect();
      const row = Math.floor((e.clientY - r.top) / r.height * c.result.rows.length);
      scrollToRow(c, row);
    });
    c.ro = new ResizeObserver(() => { drawMap(c); draw(c); });
    c.ro.observe(c.panes[0]);
    dlg.focus();

    setMsg(c, T.loading);
    try {
      [c.textL, c.textR] = await Promise.all([left.load(), right.load()]);
    } catch (err) {
      if (cur !== c) return;
      setMsg(c, cleanMsg(err), true);
      return;
    }
    if (cur !== c) return;
    compute(c);
  }

  function close() {
    if (!cur) return;
    cur.ro.disconnect();
    cur.modal.remove();
    cur = null;
  }

  function setMsg(c, text, error = false) {
    c.msg.textContent = text || '';
    c.msg.hidden = !text;
    c.msg.classList.toggle('error', !!error);
  }

  function compute(c) {
    if (c.textL == null || c.textR == null) return;
    c.result = DiffCore.diffLines(c.textL, c.textR, { ignoreSpace: c.ignoreSpace });
    c.charCache.clear();
    // Unterschiedsblöcke (für Springen und Übersicht)
    c.hunks = [];
    const rows = c.result.rows;
    let adds = 0, dels = 0;
    for (let i = 0; i < rows.length; i++) {
      const k = rows[i].kind;
      if (k !== 'eq' && (i === 0 || rows[i - 1].kind === 'eq')) c.hunks.push({ start: i, end: i });
      if (k !== 'eq') c.hunks[c.hunks.length - 1].end = i;
      if (rows[i].l >= 0 && k !== 'eq') dels++;
      if (rows[i].r >= 0 && k !== 'eq') adds++;
    }
    c.hunk = -1;
    c.modal.querySelector('.cmp-pos').textContent = '';
    const sum = c.modal.querySelector('.cmp-summary');
    if (!c.hunks.length) sum.textContent = c.ignoreSpace ? T.sameSpace : T.same;
    else sum.textContent = `${T.diffs(c.hunks.length)} · ${T.stats(adds, dels)}${c.result.approx ? ' · ' + T.approx : ''}`;
    c.modal.querySelector('[data-c=prev]').disabled = !c.hunks.length;
    c.modal.querySelector('[data-c=next]').disabled = !c.hunks.length;
    setMsg(c, '');
    // Breite für waagerechtes Scrollen schätzen (längste Zeile)
    const longest = side => (side === 'l' ? c.result.left : c.result.right).reduce((m, s) => Math.max(m, s.length), 0);
    c.panes.forEach(pane => {
      const sizer = pane.querySelector('.cmp-sizer');
      sizer.style.height = rows.length * ROW_H + 'px';
      sizer.style.width = `calc(${Math.max(longest('l'), longest('r'))}ch + 80px)`;
      sizer.innerHTML = '';
      pane.dataset.drawn = '';
    });
    drawMap(c);
    draw(c, true);
    if (c.hunks.length) jump(c, 1);
  }

  // Nur die sichtbaren Zeilen zeichnen (auch bei 50 000 Zeilen flüssig)
  function draw(c, force = false) {
    if (!c.result) return;
    const pane0 = c.panes[0];
    const first = Math.max(0, Math.floor(pane0.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(c.result.rows.length, Math.ceil((pane0.scrollTop + pane0.clientHeight) / ROW_H) + OVERSCAN);
    const key = first + ':' + last + ':' + c.hunk;
    if (!force && pane0.dataset.drawn === key) return;
    for (const pane of c.panes) {
      const side = pane.dataset.side;
      const lines = side === 'l' ? c.result.left : c.result.right;
      const frag = document.createDocumentFragment();
      for (let i = first; i < last; i++) frag.appendChild(rowEl(c, i, side, lines));
      const sizer = pane.querySelector('.cmp-sizer');
      sizer.replaceChildren(frag);
      pane.dataset.drawn = key;
    }
  }

  function rowEl(c, i, side, lines) {
    const row = c.result.rows[i];
    const idx = side === 'l' ? row.l : row.r;
    const el = document.createElement('div');
    el.className = 'cmp-row ' + (idx < 0 ? 'gap' : row.kind === 'eq' ? 'eq' : row.kind === 'chg' ? 'chg' : side === 'l' ? 'del' : 'ins');
    const h = c.hunks[c.hunk];
    if (h && i >= h.start && i <= h.end) el.classList.add('cur');
    el.style.top = i * ROW_H + 'px';
    const ln = document.createElement('span');
    ln.className = 'cmp-ln';
    ln.textContent = idx >= 0 ? idx + 1 : '';
    const tx = document.createElement('span');
    tx.className = 'cmp-tx';
    if (idx >= 0) {
      if (row.kind === 'chg') {
        let parts = c.charCache.get(i);
        if (!parts) { parts = DiffCore.diffChars(c.result.left[row.l], c.result.right[row.r]); c.charCache.set(i, parts); }
        for (const part of parts) {
          if (part.type === 'eq') tx.append(part.text);
          else if ((part.type === 'del') === (side === 'l')) {
            const m = document.createElement('mark');
            m.textContent = part.text;
            tx.appendChild(m);
          }
        }
      } else tx.textContent = lines[idx];
    }
    el.append(ln, tx);
    return el;
  }

  // Übersicht rechts: farbige Striche, wo sich etwas unterscheidet
  function drawMap(c) {
    c.map.innerHTML = '';
    if (!c.result || !c.result.rows.length) return;
    const n = c.result.rows.length;
    for (const h of c.hunks.slice(0, 2000)) {
      const m = document.createElement('div');
      const kinds = new Set(c.result.rows.slice(h.start, h.end + 1).map(r => r.kind));
      m.className = 'cmp-mark ' + (kinds.size > 1 || kinds.has('chg') ? 'chg' : [...kinds][0]);
      m.style.top = (h.start / n * 100) + '%';
      m.style.height = `max(3px, ${((h.end - h.start + 1) / n * 100)}%)`;
      c.map.appendChild(m);
    }
  }

  function scrollToRow(c, row) {
    const pane = c.panes[0];
    pane.scrollTop = Math.max(0, row * ROW_H - pane.clientHeight / 3);
    draw(c, true);
  }

  function jump(c, dir) {
    if (!c.hunks.length) return;
    c.hunk = c.hunk < 0 ? (dir > 0 ? 0 : c.hunks.length - 1) : (c.hunk + dir + c.hunks.length) % c.hunks.length;
    scrollToRow(c, c.hunks[c.hunk].start);
    c.modal.querySelector('.cmp-pos').textContent = `${c.hunk + 1} von ${c.hunks.length}`;
  }

  // ---------- Bequeme Aufrufe ----------

  const baseName = s => s.split(/[\\/]/).filter(Boolean).pop() || s;

  function localVsRemote(tab, localPath, remotePath) {
    return open({
      left: { label: 'Dieser Computer', name: baseName(localPath), title: localPath, load: () => loadLocal(localPath) },
      right: { label: 'Server', name: baseName(remotePath), title: remotePath, load: () => loadRemote(tab, remotePath) },
    });
  }

  function remoteVsRemote(tab, a, b) {
    return open({
      left: { label: 'Server', name: baseName(a), title: a, load: () => loadRemote(tab, a) },
      right: { label: 'Server', name: baseName(b), title: b, load: () => loadRemote(tab, b) },
    });
  }

  function localVsLocal(a, b) {
    return open({
      left: { label: 'Dieser Computer', name: baseName(a), title: a, load: () => loadLocal(a) },
      right: { label: 'Dieser Computer', name: baseName(b), title: b, load: () => loadLocal(b) },
    });
  }

  return { open, close, localVsRemote, remoteVsRemote, localVsLocal, LIMIT, isOpen: () => !!cur };
})();
