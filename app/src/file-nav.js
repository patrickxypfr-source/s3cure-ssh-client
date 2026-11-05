// Verlauf (zurück/vor) und Lesezeichen für Ordner – in der Server-Liste und in „Mein Computer“.
// ← / → links in der Pfadleiste, Stern rechts im Pfadfeld: merkt den Ordner bzw. zeigt die
// Lesezeichen (öffnen, umbenennen, löschen). Tastatur: Mac Cmd+[ / Cmd+], Windows Alt+← / Alt+→,
// außerdem die Zurück-/Vor-Tasten der Maus.
// Gespeichert in ~/.myssh/bookmarks.json (app/lib/bookmarks.js). Eingehängt über
// FileNav.attachRemote(tab) in renderer.js und FileNav.attach({...}) in local-pane.js;
// nach jedem erfolgreichen Ordnerwechsel meldet die Liste nav.visited(pfad).

Object.assign(ICON_PATHS, {
  back: 'M19 12H5 M11 6l-6 6 6 6',
  forward: 'M5 12h14 M13 6l6 6-6 6',
  starFilled: ICON_PATHS.star,
});

window.FileNav = (() => {
  const store = window.s3bookmarks;
  const HISTORY_MAX = 50;
  let data = { remote: {}, local: [] };
  const navs = new Set();
  const ready = store.get().then(d => { data = d; refreshAll(); }).catch(() => {});

  const baseName = p => p.split(/[\\/]/).filter(Boolean).pop() || p;
  const listOf = nav => (nav.scope === 'local' ? data.local : data.remote[nav.key()] || []);
  const marked = (nav, p) => listOf(nav).find(b => b.path === p);

  async function saveList(nav, list) {
    try { data = await store.set(nav.scope, nav.scope === 'local' ? null : nav.key(), list); }
    catch (err) { showError(err); }
    refreshAll();
  }

  function refreshAll() { for (const n of navs) n.refresh(); }

  // ---------- Verlauf und Knöpfe für eine Liste ----------
  // opts: { bar, scope: 'remote'|'local', key(), getPath(), go(dir) -> Promise, list, root, enabled() }
  function attach(opts) {
    const nav = { ...opts, back: [], fwd: [], current: null, jumping: false };
    nav.enabled = opts.enabled || (() => true);
    nav.key = opts.key || (() => '');

    const mk = (cls, title, ic) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'round-btn ' + cls;
      b.title = title;
      b.innerHTML = icon(ic);
      return b;
    };
    const keys = IS_MAC ? ['Cmd+[', 'Cmd+]'] : ['Alt+←', 'Alt+→'];
    const backBtn = mk('nav-back', t('fileNav.back', { key: keys[0] }), 'back');
    const fwdBtn = mk('nav-fwd', t('fileNav.forward', { key: keys[1] }), 'forward');
    opts.bar.prepend(backBtn, fwdBtn);
    const field = opts.bar.querySelector('.field.grow');
    const star = mk('bm-star', t('fileNav.bookmarks'), 'star');
    field.classList.add('has-star');
    field.appendChild(star);

    nav.refresh = () => {
      const on = nav.enabled();
      backBtn.disabled = !on || !nav.back.length;
      fwdBtn.disabled = !on || !nav.fwd.length;
      const b = nav.current && marked(nav, nav.current);
      star.classList.toggle('on', !!b);
      star.innerHTML = icon(b ? 'starFilled' : 'star');
      star.title = b ? t('fileNav.starMarked', { name: b.name }) : t('fileNav.starEmpty');
      star.disabled = !on && !listOf(nav).length;
    };

    // Nach jedem erfolgreichen Laden eines Ordners
    nav.visited = p => {
      if (!p) return;
      if (nav.jumping) { nav.current = p; nav.refresh(); return; }
      if (p !== nav.current) {
        if (nav.current) { nav.back.push(nav.current); if (nav.back.length > HISTORY_MAX) nav.back.shift(); }
        nav.fwd = [];
        nav.current = p;
      }
      nav.refresh();
    };

    // Zurück (-1) bzw. vor (+1); klappt das Laden nicht, bleibt der Verlauf wie er war
    nav.step = async dir => {
      if (!nav.enabled()) return;
      const from = dir < 0 ? nav.back : nav.fwd;
      const to = dir < 0 ? nav.fwd : nav.back;
      if (!from.length) return;
      const target = from.pop();
      const prev = nav.current;
      nav.jumping = true;
      try { await nav.go(target); } finally { nav.jumping = false; }
      if (nav.getPath() === target) { if (prev) to.push(prev); }
      else from.push(target);
      nav.refresh();
    };

    backBtn.addEventListener('click', () => nav.step(-1));
    fwdBtn.addEventListener('click', () => nav.step(1));
    star.addEventListener('click', e => { e.stopPropagation(); openMenu(nav, star); });
    star.addEventListener('mousedown', e => e.stopPropagation());

    const onKey = e => {
      if (e.target.closest('input, textarea, select')) return;
      const back = IS_MAC ? e.metaKey && !e.altKey && e.key === '[' : e.altKey && !e.ctrlKey && e.key === 'ArrowLeft';
      const fwd = IS_MAC ? e.metaKey && !e.altKey && e.key === ']' : e.altKey && !e.ctrlKey && e.key === 'ArrowRight';
      if (back || fwd) { e.preventDefault(); e.stopPropagation(); nav.step(back ? -1 : 1); }
    };
    opts.root.addEventListener('keydown', onKey);
    // Maustasten „Zurück“/„Vor“
    opts.root.addEventListener('mouseup', e => {
      if (e.button === 3 || e.button === 4) { e.preventDefault(); nav.step(e.button === 3 ? -1 : 1); }
    });

    navs.add(nav);
    nav.detach = () => navs.delete(nav);
    nav.refresh();
    return nav;
  }

  function attachRemote(tab) {
    const f = tab.files;
    f.nav = attach({
      bar: f.el.querySelector('.files-bar'), scope: 'remote', root: f.el, list: f.list,
      key: () => tab.spec.name || tab.spec.text || tab.title,
      getPath: () => f.path, go: dir => loadDir(tab, dir), enabled: () => tab.state === 'open',
    });
    // Knöpfe passend zum Verbindungszustand (renderer.js schaltet „hoch“ an/aus)
    new MutationObserver(() => f.nav.refresh()).observe(f.el.querySelector('[data-a=up]'), { attributes: true, attributeFilter: ['disabled'] });
    return f.nav;
  }

  // ---------- Ausklappliste der Lesezeichen ----------

  const menu = document.createElement('div');
  menu.id = 'bm-menu';
  menu.hidden = true;
  document.body.appendChild(menu);
  let menuNav = null;
  let menuAnchor = null;

  function closeMenu() { menu.hidden = true; menuNav = null; menuAnchor = null; }
  document.addEventListener('mousedown', e => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', e => { if (!menu.hidden && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); } }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  function openMenu(nav, anchor) {
    if (!menu.hidden && menuNav === nav) { closeMenu(); return; }
    menuNav = nav;
    menuAnchor = anchor;
    renderMenu();
    menu.hidden = false;
    position();
  }

  function position() {
    const r = menuAnchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.right - m.width, innerWidth - m.width - 8)) + 'px';
    menu.style.top = Math.min(r.bottom + 6, innerHeight - m.height - 8) + 'px';
  }

  function renderMenu() {
    const nav = menuNav;
    const list = listOf(nav);
    const cur = nav.current;
    const here = cur && marked(nav, cur);
    menu.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'bm-head';
    head.textContent = nav.scope === 'local' ? t('fileNav.headLocal') : t('fileNav.headRemote', { name: nav.key() });
    menu.appendChild(head);

    if (cur && nav.enabled()) {
      const add = document.createElement('button');
      add.className = 'bm-add' + (here ? ' remove' : '');
      add.innerHTML = icon(here ? 'starFilled' : 'plus');
      add.append(here ? t('fileNav.removeBookmark', { name: here.name }) : t('fileNav.rememberFolder'));
      add.title = cur;
      add.addEventListener('click', async () => {
        if (here) { closeMenu(); await removeItem(nav, here); return; }
        const name = await askLocal({ kind: 'text', title: t('fileNav.addTitle'), message: t('fileNav.addMessage', { path: cur }), value: baseName(cur), okLabel: t('fileNav.addOk') });
        closeMenu();
        if (name == null) return;
        await saveList(nav, [...listOf(nav), { name: name.trim() || baseName(cur), path: cur }]);
        flash(t('fileNav.added', { name: name.trim() || baseName(cur) }));
      });
      menu.appendChild(add);
    }

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'bm-empty';
      empty.textContent = t('fileNav.empty');
      menu.appendChild(empty);
      return;
    }
    menu.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' }));
    const box = document.createElement('div');
    box.className = 'bm-list';
    list.forEach((b, idx) => {
      const row = document.createElement('div');
      row.className = 'bm-item' + (b.path === cur ? ' on' : '');
      row.innerHTML = `
        <button class="bm-open"><span class="bm-ico">${icon('folder')}</span><span class="bm-text"><span class="bm-name"></span><span class="bm-path"></span></span></button>
        <button class="mini-btn" data-b="up" title="${t('fileNav.moveUp')}">${icon('arrowUp')}</button>
        <button class="mini-btn" data-b="rename" title="${t('common.rename')}">${icon('rename')}</button>
        <button class="mini-btn danger" data-b="delete" title="${t('common.delete')}">${icon('trash')}</button>`;
      row.querySelector('.bm-name').textContent = b.name;
      row.querySelector('.bm-path').textContent = b.path;
      row.querySelector('.bm-open').title = b.path;
      row.querySelector('[data-b=up]').hidden = idx === 0;
      row.querySelector('.bm-open').addEventListener('click', () => {
        if (!nav.enabled()) return;
        closeMenu();
        nav.go(b.path);
        nav.list?.focus();
      });
      row.querySelector('[data-b=up]').addEventListener('click', async () => {
        const next = list.slice();
        next.splice(idx - 1, 0, next.splice(idx, 1)[0]);
        await saveList(nav, next);
        if (!menu.hidden) renderMenu();
      });
      row.querySelector('[data-b=rename]').addEventListener('click', async () => {
        const name = await askLocal({ kind: 'text', title: t('fileNav.renameTitle'), message: t('fileNav.renameMessage', { name: b.name }), value: b.name, okLabel: t('common.rename') });
        if (!name || !name.trim() || name.trim() === b.name) return;
        await saveList(nav, listOf(nav).map(x => (x.path === b.path && x.name === b.name ? { ...x, name: name.trim() } : x)));
        if (!menu.hidden) renderMenu();
      });
      row.querySelector('[data-b=delete]').addEventListener('click', () => removeItem(nav, b));
      box.appendChild(row);
    });
    menu.appendChild(box);
  }

  async function removeItem(nav, b) {
    const ok = await askLocal({
      kind: 'confirm', title: t('fileNav.deleteTitle'), message: t('fileNav.deleteMessage', { name: b.name }),
      detail: b.path, okLabel: t('common.delete'), danger: true,
    });
    if (!ok) return;
    await saveList(nav, listOf(nav).filter(x => !(x.path === b.path && x.name === b.name)));
    if (!menu.hidden && menuNav) { renderMenu(); position(); }
  }

  return { attach, attachRemote, ready };
})();
