// Mitteilung, wenn ein langer Befehl im Terminal fertig ist – auch wenn gerade ein anderes Programm
// oder ein anderer Tab vorne ist. Ohne Hilfe vom Server: „fertig“ heißt, die Eingabezeile (Prompt)
// ist wieder da. Dazu der Bereich „Mitteilungen“ in den Einstellungen (auch für die Server-Prüfung,
// lib/server-watch.js). Einhängepunkte: openTab -> attach, runQuick -> beforeRun (renderer.js).
window.CmdNotify = (() => {
  registerSettingsSection({
    id: 'notify', title: t('notify.section'), icon: 'bell', order: 15,
    description: t('notify.sectionDesc'),
    defaults: {
      'notify.cmdDone': true, 'notify.cmdAfter': 30,
      // gleiche Standardwerte wie lib/server-watch.js
      'watch.enabled': true, 'watch.every': 15, 'watch.disk': 90, 'watch.notify': true,
    },
    fields: [
      { key: 'notify.cmdDone', type: 'toggle', label: t('notify.cmdDone'), hint: t('notify.cmdDoneHint') },
      { key: 'notify.cmdAfter', type: 'select', label: t('notify.cmdAfter'),
        options: [[10, t('notify.sec', { n: 10 })], [30, t('notify.sec', { n: 30 })], [60, t('notify.min', { n: 1 })], [120, t('notify.min', { n: 2 })], [300, t('notify.min', { n: 5 })]] },
      { key: 'watch.enabled', type: 'toggle', label: t('notify.watchEnabled'), hint: t('notify.watchEnabledHint') },
      { key: 'watch.every', type: 'select', label: t('notify.watchEvery'),
        options: [5, 15, 30, 60].map(n => [n, t('notify.min', { n })]) },
      { key: 'watch.disk', type: 'select', label: t('notify.watchDisk'),
        options: [80, 85, 90, 95].map(n => [n, n + ' %']) },
      { key: 'watch.notify', type: 'toggle', label: t('notify.watchNotify'), hint: t('notify.watchNotifyHint') },
    ],
  });

  const S = key => Settings.get(key);
  // Typische Enden einer Eingabezeile: user@host:~$  root@host:~#  %  >  ❯
  const PROMPT_END = /[$#%>❯›»λ]\s*$/;
  const runs = new Map(); // Tab-ID -> { line, label, start, timer }

  const lineAtCursor = term => {
    const b = term.buffer.active;
    const l = b.getLine(b.baseY + b.cursorY);
    return l ? l.translateToString(true) : '';
  };
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function duration(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? t('notify.durSec', { s }) : t('notify.durMin', { m: Math.floor(s / 60), s: s % 60 });
  }

  function start(tab, label, line) {
    if (tab.term.buffer.active.type === 'alternate') return; // nano, less, vim …
    runs.set(tab.id, { line: line.trimEnd(), label: cut(String(label).trim(), 80), start: Date.now(), timer: null });
  }

  // Befehlsknopf (runQuick): Eingabezeile merken, bevor die Trennlinie sie ersetzt
  function beforeRun(tab, label, live) {
    runs.delete(tab.id);
    if (!live) start(tab, label, lineAtCursor(tab.term));
  }

  function attach(tab) {
    // Selbst getippt: Enter in einer Eingabezeile
    tab.term.onData(d => {
      if (!d.includes('\r') || runs.has(tab.id) || tab.term.buffer.active.type === 'alternate') return;
      const line = lineAtCursor(tab.term);
      const m = /^.*?[$#%>❯›»λ]\s+(\S.*)$/.exec(line);
      if (!m) return; // nur Enter oder keine erkennbare Eingabezeile
      start(tab, m[1], line);
    });
    tab.term.onWriteParsed(() => {
      const r = runs.get(tab.id);
      if (!r) return;
      clearTimeout(r.timer);
      r.timer = setTimeout(() => check(tab), 500);
    });
    tab.tabEl.addEventListener('mousedown', () => tab.tabEl.classList.remove('cmd-done'));
  }

  function check(tab) {
    const r = runs.get(tab.id);
    if (!r) return;
    if (!tabs.has(tab.id)) { runs.delete(tab.id); return; }
    if (tab.term.buffer.active.type === 'alternate') return; // Vollbildprogramm läuft noch
    const now = lineAtCursor(tab.term).trimEnd();
    // Fertig, wenn wieder dieselbe Eingabezeile wie vor dem Befehl dasteht
    if (!now || !PROMPT_END.test(now) || !r.line.startsWith(now)) return;
    runs.delete(tab.id);
    finished(tab, r, Date.now() - r.start);
  }

  function finished(tab, r, ms) {
    if (!S('notify.cmdDone') || ms < Number(S('notify.cmdAfter')) * 1000) return;
    const away = document.hidden || !document.hasFocus() || activeId !== tab.id;
    if (!away) return;
    if (activeId !== tab.id) tab.tabEl.classList.add('cmd-done');
    window.s3watch?.notify(t('notify.doneTitle', { cmd: r.label }), t('notify.doneBody', { tab: tab.title, time: duration(ms) }), tab.id);
  }

  // Klick auf die Mitteilung: Tab nach vorn
  window.s3watch?.onNotifyClick(tabId => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    activate(tabId);
    tab.tabEl.classList.remove('cmd-done');
  });
  window.addEventListener('focus', () => tabs.get(activeId)?.tabEl.classList.remove('cmd-done'));

  return { attach, beforeRun, lineAtCursor };
})();
