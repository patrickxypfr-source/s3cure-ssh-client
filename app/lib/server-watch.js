// Alle Server auf einen Blick: prüft die gespeicherten SSH-Verbindungen im Hintergrund
// (CPU, RAM, Platte, ausgefallene Dienste) und meldet neue Probleme als Mitteilung des Systems.
// Fragt nie nach Passwörtern oder Server-Schlüsseln – wer sich nicht ohne Rückfrage anmelden lässt,
// erscheint als „Anmeldung nötig“. Oberfläche: src/server-watch.js
const { t } = require('./i18n');
const monitor = require('./monitor');

const CONNECT_TIMEOUT = 20000;
const PARALLEL = 4;
const FIRST_RUN_DELAY = 60 * 1000; // erste Prüfung im Hintergrund eine Minute nach dem Start
const MEM_LIMIT = 95;               // Arbeitsspeicher ab dieser Auslastung melden (%)

// Standardwerte – gleich wie in der Oberfläche (src/server-watch.js)
const DEFAULTS = { 'watch.enabled': true, 'watch.every': 15, 'watch.disk': 90, 'watch.notify': true };

// Ausgefallene systemd-Dienste (leer, wenn es kein systemd gibt)
const FAILED_CMD = "{ systemctl list-units --state=failed --no-legend --plain 2>/dev/null | awk '{print $1}' | head -n 20; } 2>/dev/null";
const COMMAND = `${monitor.COMMAND}; echo @@failed; ${FAILED_CMD}`;

// Rohtext -> Werte + Liste ausgefallener Dienste
function parseResult(text) {
  const stats = monitor.parse(text);
  delete stats.cpuTicks;
  const i = text.indexOf('@@failed');
  const failed = i < 0 ? [] : text.slice(i + 8).split('\n').map(s => s.trim()).filter(s => /^[\w@.:\\-]+$/.test(s)).slice(0, 20);
  return { stats, failed };
}

const pct = (used, total) => (total ? Math.round(100 * used / total) : null);

// Probleme eines Servers. limits: { disk } in Prozent
function findIssues(r, limits) {
  const issues = [];
  if (r.state === 'offline') issues.push({ id: 'offline' });
  if (r.stats) {
    const d = r.stats.disk ? pct(r.stats.disk.used, r.stats.disk.used + r.stats.disk.free) : null;
    if (d != null && d >= limits.disk) issues.push({ id: 'disk', value: d });
    const m = r.stats.mem ? pct(r.stats.mem.used, r.stats.mem.total) : null;
    if (m != null && m >= MEM_LIMIT) issues.push({ id: 'mem', value: m });
  }
  for (const s of r.failed || []) issues.push({ id: 'service:' + s, service: s });
  return issues;
}

// Fehler beim Verbinden einordnen
function classify(err) {
  if (err && err.level === 'host-key') return 'hostkey';
  if (err && err.level === 'client-authentication') return 'auth';
  if (err && (err.level === 'client-timeout' || err.level === 'client-socket'
    || /^(ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET)$/.test(err.code || ''))) return 'offline';
  if (err && err.timeout) return 'offline';
  return 'error';
}

function issueText(name, issue) {
  if (issue.id === 'offline') return t('watch.nOffline', { name });
  if (issue.id === 'disk') return t('watch.nDisk', { name, value: issue.value });
  if (issue.id === 'mem') return t('watch.nMem', { name, value: issue.value });
  return t('watch.nService', { name, service: issue.service });
}

function createServerWatch({ connection, loadHosts, isFtpHost, settings, send, notify, now = () => Date.now() }) {
  const results = new Map(); // Name -> Ergebnis
  let running = null;        // laufende Prüfung (Promise)
  let timer = null;
  let firstRun = true;

  const S = key => { const v = settings()[key]; return v === undefined ? DEFAULTS[key] : v; };

  function targets() {
    const hosts = loadHosts();
    return Object.keys(hosts).filter(n => !isFtpHost(hosts[n]) && hosts[n].watch !== false);
  }

  function run(client, cmd) {
    return new Promise((resolve, reject) => {
      client.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = '';
        const timer = setTimeout(() => { try { stream.close(); } catch {} reject(Object.assign(new Error(t('monitor.timeout')), { timeout: true })); }, 10000);
        stream.on('data', d => { if (out.length < 200000) out += d.toString('utf8'); });
        stream.stderr.on('data', () => {});
        stream.on('close', () => { clearTimeout(timer); resolve(out); });
      });
    });
  }

  async function checkOne(name) {
    const hosts = loadHosts();
    const target = hosts[name];
    const r = { name, at: now() };
    if (!target) return null;
    let client = null;
    try {
      const pending = connection.connectTo(target, name, undefined, { noPrompt: true });
      client = await Promise.race([
        pending,
        new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(t('watch.timeout')), { timeout: true })), CONNECT_TIMEOUT)),
      ]).catch(err => { pending.then(c => c.end(), () => {}); throw err; });
      const { stats, failed } = parseResult(await run(client, COMMAND));
      r.stats = stats.ok ? stats : null;
      r.failed = failed;
      r.state = 'ok';
    } catch (err) {
      r.state = classify(err);
      r.error = String(err.message || err);
    } finally {
      if (client) try { client.end(); } catch {}
    }
    r.issues = findIssues(r, { disk: S('watch.disk') });
    if (r.state === 'ok' && r.issues.length) r.state = 'warn';
    return r;
  }

  // Neue Probleme gegenüber der letzten Prüfung melden (nicht beim allerersten Mal nach dem Start
  // für Server, die noch nie geprüft wurden – außer sie sind wirklich auffällig)
  function announce(prev, next) {
    if (!S('watch.notify')) return;
    const before = new Set((prev?.issues || []).map(i => i.id));
    const fresh = next.issues.filter(i => !before.has(i.id));
    if (fresh.length) {
      notify({ title: t('watch.nTitle', { name: next.name }), body: fresh.map(i => issueText(next.name, i)).join('\n'), name: next.name });
    } else if (prev && prev.issues.some(i => i.id === 'offline') && next.state !== 'offline') {
      notify({ title: t('watch.nTitle', { name: next.name }), body: t('watch.nBack', { name: next.name }), name: next.name });
    }
  }

  function snapshot() {
    const names = targets();
    return {
      running: !!running,
      enabled: !!S('watch.enabled'),
      list: names.map(n => results.get(n) || { name: n, state: 'pending' }),
    };
  }
  const publish = () => send('srvwatch:update', snapshot());

  // names: nur diese Server (Standard: alle). silent: keine Mitteilungen (Prüfung von Hand)
  function checkAll({ names = null, silent = false } = {}) {
    if (running) return running;
    const list = (names || targets()).filter(n => targets().includes(n));
    let i = 0;
    running = (async () => {
      publish();
      const worker = async () => {
        while (i < list.length) {
          const name = list[i++];
          const r = await checkOne(name).catch(() => null);
          if (!r) continue;
          const prev = results.get(name);
          results.set(name, r);
          if (!silent) announce(prev, r);
          publish();
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
    })().finally(() => { running = null; firstRun = false; publish(); });
    return running;
  }

  // Regelmäßige Prüfung im Hintergrund nach den Einstellungen
  // Der Takt läuft immer; ob geprüft wird, entscheidet die Einstellung beim jeweiligen Zeitpunkt
  function schedule() {
    clearTimeout(timer);
    const every = Math.max(5, Number(S('watch.every')) || 15) * 60 * 1000;
    timer = setTimeout(async () => {
      if (S('watch.enabled')) { try { await checkAll(); } catch {} } else firstRun = false;
      schedule();
    }, firstRun ? FIRST_RUN_DELAY : every);
    if (timer.unref) timer.unref();
  }

  // Gelöschte Verbindungen vergessen
  function prune() {
    const names = new Set(targets());
    for (const n of [...results.keys()]) if (!names.has(n)) results.delete(n);
  }

  function register(ipcMain) {
    ipcMain.handle('srvwatch:list', () => { prune(); return snapshot(); });
    ipcMain.handle('srvwatch:check', (_e, names) => {
      checkAll({ names: Array.isArray(names) ? names.map(String) : null, silent: true });
      return snapshot();
    });
  }

  return { register, schedule, checkAll, checkOne, snapshot, stop: () => clearTimeout(timer) };
}

module.exports = { createServerWatch, parseResult, findIssues, classify, DEFAULTS };
