// Rahmen-Auswahl („Lasso“) für die Dateilisten – wie im Finder/Explorer:
// Mit gedrückter Maustaste im Leeren oder auf Größe/Datum einer Zeile einen Rahmen aufziehen,
// alle berührten Zeilen werden markiert. Mit Cmd/Strg bzw. Umschalt kommt die Auswahl dazu.
// Ziehen am Namen einer Zeile bleibt wie gehabt Drag & Drop.
const Lasso = (() => {
  const THRESHOLD = 4; // Pixel, ab denen aus einem Klick ein Rahmen wird
  const EDGE = 28;     // Abstand zum Rand, ab dem automatisch gescrollt wird

  // opts: { list, body, getSelected(): Set, setSelected(Set), onDone?() }
  function attach({ list, body, getSelected, setSelected }) {
    let st = null;

    const contentPoint = e => {
      const r = list.getBoundingClientRect();
      return { x: e.clientX - r.left + list.scrollLeft, y: e.clientY - r.top + list.scrollTop };
    };

    function startsLasso(e) {
      if (e.button !== 0 || e.target.closest('thead, input, button, .lp-ghost')) return false;
      const tr = e.target.closest('tbody tr');
      if (!tr) return true;                          // Klick ins Leere unter den Zeilen
      return !e.target.closest('td:first-child');    // Größe/Datum einer Zeile
    }

    list.addEventListener('mousedown', e => {
      if (!startsLasso(e)) return;
      e.preventDefault(); // kein Ziehen der Zeile, keine Textmarkierung
      list.focus({ preventScroll: true });
      const additive = (IS_MAC ? e.metaKey : e.ctrlKey) || e.shiftKey;
      st = { start: contentPoint(e), last: e, base: additive ? new Set(getSelected()) : new Set(), box: null, moved: false };
    });

    function update(e) {
      st.last = e;
      const p = contentPoint(e);
      const x = Math.min(p.x, st.start.x), y = Math.min(p.y, st.start.y);
      const w = Math.abs(p.x - st.start.x), h = Math.abs(p.y - st.start.y);
      if (!st.moved && Math.max(w, h) < THRESHOLD) return;
      if (!st.moved) {
        st.moved = true;
        st.box = document.createElement('div');
        st.box.className = 'lasso-box';
        list.appendChild(st.box);
        document.body.classList.add('lasso-active');
      }
      Object.assign(st.box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      // Zeilen, die der Rahmen (senkrecht) berührt
      const lr = list.getBoundingClientRect();
      const top = y - list.scrollTop + lr.top, bottom = top + h;
      const sel = new Set(st.base);
      for (const tr of body.children) {
        if (!tr.dataset.name || tr.offsetParent === null) continue;
        const r = tr.getBoundingClientRect();
        if (r.bottom > top && r.top < bottom) sel.add(tr.dataset.name);
      }
      setSelected(sel);
    }

    window.addEventListener('mousemove', e => {
      if (!st) return;
      // Maustaste wurde außerhalb losgelassen (kein mouseup bekommen) – Rahmen beenden
      if (e.buttons === 0) { window.dispatchEvent(new MouseEvent('mouseup')); return; }
      update(e);
    });
    window.addEventListener('mouseup', () => {
      if (!st) return;
      // Nach einem Rahmen kein „Klick“ hinterher, der die Auswahl wieder auf eine Zeile setzt
      if (st.moved) {
        const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      }
      if (st.box) st.box.remove();
      document.body.classList.remove('lasso-active');
      st = null;
    });

    // Am oberen/unteren Rand automatisch weiterscrollen
    (function autoScroll() {
      if (st && st.moved) {
        const r = list.getBoundingClientRect();
        const y = st.last.clientY;
        const dy = y < r.top + EDGE ? -Math.ceil((r.top + EDGE - y) / 3) : y > r.bottom - EDGE ? Math.ceil((y - r.bottom + EDGE) / 3) : 0;
        if (dy) { list.scrollTop += dy; update(st.last); }
      }
      requestAnimationFrame(autoScroll);
    })();
  }

  // Kurzer Hinweis für die Statuszeile unter einer Liste
  function hint(selectedCount) {
    if (selectedCount > 1) return ' – ' + t('lasso.dragToCopy');
    return ' · ' + t('lasso.multiHint', { key: IS_MAC ? '⌘' : t('app.keyCtrl') });
  }

  return { attach, hint };
})();
