// Warnungen: prüft regelmäßig Messwerte, Dienste und weitere Server und meldet neue Probleme
// (und wenn sie wieder weg sind) per Web Push. Aktive Probleme sieht man auch in der App.

const LABELS = {
  de: {
    disk: v => `Platte zu ${v} % voll`, mem: v => `Arbeitsspeicher zu ${v} % belegt`, load: v => `Hohe Last (${v})`,
    service: s => `Dienst ausgefallen: ${s}`, offline: () => 'Nicht erreichbar', fixed: t => `Wieder in Ordnung: ${t}`,
  },
  en: {
    disk: v => `Disk ${v} % full`, mem: v => `Memory ${v} % used`, load: v => `High load (${v})`,
    service: s => `Service failed: ${s}`, offline: () => 'Unreachable', fixed: t => `Back to normal: ${t}`,
  },
};

// Messwerte + Dienste -> Liste von Problemen { id, text }
function evaluate(m, services, limits, lang = 'de') {
  const L = LABELS[lang] || LABELS.de;
  const out = [];
  if (m && m.disk && m.disk.total) { const v = Math.round(100 * (m.disk.total - m.disk.free) / m.disk.total); if (v >= limits.disk) out.push({ id: 'disk', text: L.disk(v), level: 'warn' }); }
  if (m && m.mem && m.mem.total) { const v = Math.round(100 * m.mem.used / m.mem.total); if (v >= limits.mem) out.push({ id: 'mem', text: L.mem(v), level: 'warn' }); }
  if (m && m.load && m.cpus && m.load[0] >= limits.loadPerCpu * m.cpus) out.push({ id: 'load', text: L.load(m.load[0].toFixed(1)), level: 'warn' });
  if (limits.serviceFailed) for (const s of (services || []).filter(x => x.active === 'failed')) out.push({ id: 'svc:' + s.name, text: L.service(s.name.replace(/\.service$/, '')), level: 'bad', service: s.name });
  return out;
}

function createAlerts({ getCfg, collect, push, audit }) {
  const active = new Map(); // "server|id" -> Problem
  let timer = null;
  let first = true;

  async function check() {
    const cfg = getCfg();
    const L = LABELS[cfg.language] || LABELS.de;
    let snapshot;
    try { snapshot = await collect(); } catch { return; }
    const next = new Map();
    for (const srv of snapshot) {
      const issues = srv.ok ? evaluate(srv.metrics, srv.services, cfg.alerts, cfg.language) : [{ id: 'offline', text: L.offline(), level: 'bad' }];
      for (const i of issues) next.set(`${srv.id}|${i.id}`, { ...i, server: srv.id, serverName: srv.name, since: active.get(`${srv.id}|${i.id}`)?.since || Date.now() });
    }
    // Neue Probleme melden (beim allerersten Durchlauf nach dem Start nur die schlimmen)
    for (const [k, i] of next) {
      if (active.has(k) || (first && i.level !== 'bad')) continue;
      push.send({ title: i.serverName, body: i.text, url: `/#/s/${encodeURIComponent(i.server)}`, tag: k, urgent: i.level === 'bad' }).catch(() => {});
      audit({ user: 'system', action: 'alert', target: i.serverName, detail: i.text });
    }
    for (const [k, i] of active) {
      if (next.has(k)) continue;
      push.send({ title: i.serverName, body: L.fixed(i.text), url: `/#/s/${encodeURIComponent(i.server)}`, tag: k }).catch(() => {});
    }
    active.clear();
    for (const [k, v] of next) active.set(k, v);
    first = false;
  }

  function start() {
    const loop = async () => { await check(); timer = setTimeout(loop, Math.max(15, Number(getCfg().alerts.everySec) || 60) * 1000); };
    timer = setTimeout(loop, 5000);
  }

  return { start, stop: () => clearTimeout(timer), check, list: () => [...active.values()] };
}

module.exports = { createAlerts, evaluate, LABELS };
