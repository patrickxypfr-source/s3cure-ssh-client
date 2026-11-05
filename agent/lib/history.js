// Verlauf der Messwerte: ein Punkt pro Minute (Mittelwert), 7 Tage lang. Für die Grafiken in der App.
const config = require('./config');

const KEEP = 7 * 24 * 60; // Minuten

function createHistory() {
  let points = config.readJson('history.json', []);
  if (!Array.isArray(points)) points = [];
  let bucket = null; // laufende Minute: { t, n, cpu, mem, disk, rx, tx }
  let dirty = 0;

  const pct = (u, t) => (t ? (100 * u) / t : null);

  function add(m) {
    const t = Math.floor(m.at / 60000) * 60000;
    if (bucket && bucket.t !== t) flushBucket();
    if (!bucket) bucket = { t, n: 0, cpu: 0, mem: 0, disk: 0, rx: 0, tx: 0 };
    bucket.n++;
    bucket.cpu += m.cpu || 0;
    bucket.mem += pct(m.mem && m.mem.used, m.mem && m.mem.total) || 0;
    bucket.disk += m.disk ? pct(m.disk.total - m.disk.free, m.disk.total) : 0;
    bucket.rx += (m.net && m.net.rx) || 0;
    bucket.tx += (m.net && m.net.tx) || 0;
  }

  function flushBucket() {
    const b = bucket; bucket = null;
    if (!b || !b.n) return;
    const r = v => Math.round((v / b.n) * 10) / 10;
    points.push([b.t, r(b.cpu), r(b.mem), r(b.disk), Math.round(b.rx / b.n), Math.round(b.tx / b.n)]);
    if (points.length > KEEP) points.splice(0, points.length - KEEP);
    if (++dirty >= 10) save(); // alle 10 Minuten auf die Platte
  }

  function save() { dirty = 0; try { config.writeJson('history.json', points); } catch {} }

  // Zeitraum in Stunden -> höchstens maxPoints Punkte (zusammengefasst)
  function range(hours = 24, maxPoints = 240) {
    const from = Date.now() - hours * 3600000;
    const list = points.filter(p => p[0] >= from);
    const step = Math.max(1, Math.ceil(list.length / maxPoints));
    const out = [];
    for (let i = 0; i < list.length; i += step) {
      const g = list.slice(i, i + step);
      const avg = k => Math.round((g.reduce((a, p) => a + p[k], 0) / g.length) * 10) / 10;
      out.push([g[0][0], avg(1), avg(2), avg(3), Math.round(avg(4)), Math.round(avg(5))]);
    }
    return out; // [Zeit, CPU %, RAM %, Platte %, rx B/s, tx B/s]
  }

  return { add, range, save, size: () => points.length };
}

module.exports = { createHistory };
