// Sitzung wiederherstellen: offene Tabs beim Beenden merken und beim nächsten Start wieder öffnen.
// Hauptprozess: app/lib/session.js (~/.myssh/session.json, auch Fensterposition/-größe).
// Nutzt aus renderer.js: tabs, activeId, openTab, connect, activate, setState, hosts;
// aus local-pane.js: LocalPane.state; aus term-extra.js: TermExtra.isSplit/openSplit.
// Die eingeklappte Seitenleiste merkt sich layout.js selbst.
(() => {
  const S = window.s3session;
  if (!S) return;
  const SAVE_EVERY = 1500; // ms
  let saving = false;      // erst nach der Wiederherstellung speichern, sonst würde die leere Tab-Leiste die Datei überschreiben
  let last = '';
  // Texte vorab holen: unten heißt eine Variable „t“ (Tab-Eintrag)
  const TXT_RESTORING = t('session.restoring');
  const TXT_NOT_CONNECTED = t('session.notConnected');

  // Tabs in der Reihenfolge der Tab-Leiste
  function orderedTabs() {
    const byEl = new Map([...tabs.values()].map(t => [t.tabEl, t]));
    const list = [...document.querySelectorAll('#tabs .tab')].map(el => byEl.get(el)).filter(Boolean);
    for (const t of tabs.values()) if (!list.includes(t)) list.push(t);
    return list;
  }

  function snapshot() {
    const list = orderedTabs();
    return {
      tabs: list.map(t => ({
        spec: t.spec.name ? { name: t.spec.name } : { text: t.spec.text },
        title: t.title,
        view: t.view,
        remotePath: t.files.path || t.restore?.remotePath || null,
        local: window.LocalPane?.state?.(t) || null,
        split: !!window.TermExtra?.isSplit?.(t),
      })),
      active: Math.max(0, list.findIndex(t => t.id === activeId)),
    };
  }

  function save() {
    if (!saving) return;
    try {
      const snap = snapshot();
      const json = JSON.stringify(snap);
      if (json === last) return;
      last = json;
      S.update(snap);
    } catch (err) { console.error('Sitzung nicht gespeichert', err); }
  }

  const connKey = t => (t.spec.name ? 'n:' + t.spec.name : 't:' + t.spec.text);

  async function restore() {
    let data = null;
    try { data = await S.take(); } catch (err) { console.error(err); }
    try { await Settings.ready; } catch {}
    if (!data || !data.tabs || !data.tabs.length || Settings.get('session.restore') === false || tabs.size) return;

    // Gelöschte Verbindungen nicht wieder öffnen
    let known = {};
    try { known = await api.listHosts(); } catch {}
    const items = data.tabs.filter(t => !t.spec.name || known[t.spec.name]);
    if (!items.length) return;

    const opened = items.map(t => {
      const tab = openTab(t.spec, t.title, t.view, { connect: false, restore: t });
      if (t.remotePath) { tab.files.path = t.remotePath; tab.files.restoring = true; }
      tab.term.write(TermStyle.line('info', TXT_RESTORING));
      return { tab, t };
    });
    const activeItem = data.tabs[data.active];
    const first = opened.find(o => o.t === activeItem) || opened[0];
    activate(first.tab.id);

    // Ab jetzt laufend speichern (auch wenn die Verbindungen noch aufgebaut werden)
    saving = true;
    save();

    // Pro Verbindung nacheinander verbinden (nur eine Passwort- bzw. Host-Key-Frage),
    // verschiedene Verbindungen gleichzeitig. Der aktive Tab zuerst.
    const groups = new Map();
    for (const o of [first, ...opened.filter(o => o !== first)]) {
      const k = connKey(o.t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    await Promise.all([...groups.values()].map(async list => {
      let failed = false;
      for (const { tab, t } of list) {
        if (!tabs.has(tab.id)) continue; // inzwischen geschlossen
        if (failed) {
          // Kein Fehler-Hagel: weitere Tabs derselben Verbindung warten auf „Neu verbinden“
          tab.term.write(TermStyle.line('info', TXT_NOT_CONNECTED));
          setState(tab, 'closed');
          continue;
        }
        const ok = await connect(tab);
        if (!ok) { failed = true; continue; }
        if (t.split && tabs.has(tab.id)) {
          try { await window.TermExtra?.openSplit?.(tab); } catch (err) { console.error(err); }
        }
      }
    }));
  }

  window.addEventListener('DOMContentLoaded', () => {
    restore()
      .catch(err => { console.error('Sitzung konnte nicht wiederhergestellt werden', err); })
      .finally(() => { saving = true; save(); });
  });
  setInterval(save, SAVE_EVERY);
  // Beim Schließen des Fensters (auch beim Beenden für ein Update) den letzten Stand schicken
  window.addEventListener('beforeunload', save);

  registerSettingsSection({
    id: 'session', title: t('session.sectionTitle'), icon: 'refresh', order: 5,
    defaults: { 'session.restore': true },
    fields: [
      {
        key: 'session.restore', type: 'toggle', label: t('session.restoreLabel'),
        hint: t('session.restoreHint'),
      },
    ],
  });

  window.SessionRestore = { snapshot, save };
})();
