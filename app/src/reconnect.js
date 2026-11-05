// Automatisch neu verbinden, wenn die Verbindung abreißt (WLAN-Wechsel, Ruhezustand, Server-Neustart).
// Der Hauptprozess meldet 'ssh:lost'; hier wird mit wachsendem Abstand neu verbunden.
// Nutzt aus renderer.js: tabs, activeId, connect, setState.

const RECONNECT_DELAYS = [0, 2, 4, 8, 15, 30]; // Sekunden bis zum nächsten Versuch, danach alle 30 s
const RECONNECT_MAX_ATTEMPTS = 40;             // ungefähr 20 Minuten, danach aufgeben

function startReconnect(tab) {
  if (!tabs.has(tab.id) || tab.rc) return;
  tab.lost = true;
  tab.rc = { attempt: 0, timer: null, busy: false, next: 0 };
  tab.term.write(`\r\n\x1b[33m${t('reconnect.lost')}\x1b[0m\r\n`);
  setState(tab, 'reconnecting');
  scheduleReconnect(tab);
}

function scheduleReconnect(tab) {
  const rc = tab.rc;
  const delay = RECONNECT_DELAYS[Math.min(rc.attempt, RECONNECT_DELAYS.length - 1)] * 1000;
  rc.next = Date.now() + delay;
  clearTimeout(rc.timer);
  rc.timer = setTimeout(() => reconnectAttempt(tab), delay);
  showReconnectStatus();
}

async function reconnectAttempt(tab) {
  const rc = tab.rc;
  if (!rc || rc.busy) return;
  if (!tabs.has(tab.id)) { tab.rc = null; return; }
  clearTimeout(rc.timer);
  rc.busy = true;
  rc.attempt++;
  showReconnectStatus();
  const ok = await connect(tab, { reconnect: true });
  rc.busy = false;
  if (tab.rc !== rc || !tabs.has(tab.id)) return;
  if (ok) {
    tab.rc = null;
    tab.lost = false;
    // Altes Vollbildprogramm (z. B. nano) verlassen und Terminal-Modi zurücksetzen, Verlauf bleibt
    if (tab.term.buffer.active.type === 'alternate') tab.term.write('\x1b[?1049l');
    tab.term.write(`\x1b[!p\x1b[32m${t('reconnect.back')}\x1b[0m\r\n`);
    return;
  }
  if (rc.attempt >= RECONNECT_MAX_ATTEMPTS) {
    tab.rc = null;
    tab.term.write(`\x1b[31m${t('reconnect.gaveUp')}\x1b[0m\r\n`);
    setState(tab, 'closed');
    return;
  }
  setState(tab, 'reconnecting');
  scheduleReconnect(tab);
}

// Knopf „Neu verbinden“: läuft schon ein Wiederholen, sofort versuchen, sonst ganz normal verbinden
function reconnectNow(tab) {
  if (tab.rc) { if (!tab.rc.busy) reconnectAttempt(tab); }
  else connect(tab);
}

// Nach dem Aufwachen oder wenn das Netz wieder da ist: sofort versuchen (auch wenn schon aufgegeben)
function retryAllLost() {
  for (const tab of tabs.values()) {
    if (tab.rc) { if (!tab.rc.busy) reconnectAttempt(tab); }
    else if (tab.lost && tab.state === 'closed') startReconnect(tab);
  }
}

// Statuszeile mit Countdown („neuer Versuch in 8 s“)
function showReconnectStatus() {
  const tab = tabs.get(activeId);
  if (!tab || !tab.rc || tab.state !== 'reconnecting') return;
  const secs = Math.ceil((tab.rc.next - Date.now()) / 1000);
  $('#tab-status-text').textContent = tab.rc.busy || secs <= 0
    ? (tab.rc.attempt > 0 ? t('reconnect.statusAttempt', { n: tab.rc.attempt + 1 }) : t('reconnect.statusBusy'))
    : t('reconnect.statusWait', { secs });
}
setInterval(showReconnectStatus, 1000);

api.onLost(id => { const tab = tabs.get(id); if (tab) startReconnect(tab); });
api.onResume(retryAllLost);
window.addEventListener('online', retryAllLost);
