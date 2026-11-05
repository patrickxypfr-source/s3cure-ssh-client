// Lokales Terminal: die Shell des eigenen Computers in einem Tab (Hauptprozess: lib/local-term.js).
// Knopf neben „Neue Verbindung“, Cmd/Strg+Umschalt+T und Befehlspalette.
// In einem lokalen Tab gibt es nur das Terminal – Server-Funktionen (Dateien, Übersicht, Tunnel,
// Befehlsknöpfe, geteilte Ansicht, Mitschnitt) werden ausgeblendet (local-term.css).
window.LocalTerm = (() => {
  const isLocalSpec = spec => !!spec && spec.local === true;
  const isLocalTab = tab => !!tab && isLocalSpec(tab.spec);

  function open() {
    const n = [...tabs.values()].filter(isLocalTab).length;
    const title = n ? `${t('localTerm.title')} ${n + 1}` : t('localTerm.title');
    return openTab({ local: true }, title, 'terminal');
  }

  function update(tab) {
    const local = isLocalTab(tab);
    document.body.classList.toggle('local-tab', local);
    if (!local || !tab) return;
    if (tab.view !== 'terminal') tab.view = 'terminal';
    if (tab.state === 'open' && tab.info) {
      $('#tab-status-text').textContent = t('localTerm.status', { user: tab.info.user, host: tab.info.host });
    }
  }

  // Knopf in der Seitenleiste (vor „Neue Verbindung“)
  const btn = document.createElement('button');
  btn.id = 'local-term';
  btn.className = 'round-btn';
  btn.title = t('localTerm.open', { keys: IS_MAC ? '⌘⇧T' : t('app.keyCtrl') + '+Shift+T' });
  btn.innerHTML = icon('terminal');
  btn.addEventListener('click', () => open());
  document.getElementById('add-host')?.before(btn);

  // Cmd+Umschalt+T (Mac) bzw. Strg+Umschalt+T
  window.addEventListener('keydown', e => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); e.stopPropagation(); open(); }
  }, true);

  window.Palette?.register(() => [{
    key: 'act:local-term', section: 'actions', icon: 'terminal', label: t('localTerm.palette'), run: open,
    keywords: 'lokal terminal konsole shell mac pc computer local console', // i18n-ignore
  }]);

  return { open, update, isLocalTab, isLocalSpec };
})();
