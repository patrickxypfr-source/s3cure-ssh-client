// Probe nach echter Installation (GitHub Actions, Ubuntu mit systemd, als root):
// mit dem angelegten Benutzer anmelden (echter 2FA-Code) und echte Messwerte und Dienste abfragen.
// Aufruf: sudo env PATH=$PATH node test/probe.js <benutzer> <passwort>
process.env.S3CURE_AGENT_DIR = process.env.S3CURE_AGENT_DIR || '/var/lib/s3cure-agent';
const assert = require('node:assert/strict');
const totp = require('/opt/s3cure-agent/lib/totp');
const users = require(process.env.S3CURE_AGENT_DIR + '/users.json');

(async () => {
  const [user, password] = process.argv.slice(2);
  const base = 'http://127.0.0.1:7777';
  const h = { 'Content-Type': 'application/json', 'X-S3cure': '1' };
  const login = await fetch(base + '/api/login', { method: 'POST', headers: h, body: JSON.stringify({ user, password, code: totp.hotp(users[user].totp, totp.step()) }) });
  assert.equal(login.status, 200, 'Anmeldung');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = async p => { const r = await fetch(base + p, { headers: { Cookie: cookie } }); assert.equal(r.status, 200, p); return r.json(); };
  await new Promise(r => setTimeout(r, 11000)); // ein Messintervall abwarten (CPU braucht zwei Werte)
  const servers = await get('/api/servers');
  const m = servers[0].metrics;
  assert.ok(m.mem.total > 0 && m.disk.total > 0 && m.uptime > 0 && Number.isFinite(m.cpu), 'Messwerte');
  console.log('✓ Messwerte', JSON.stringify({ cpu: Math.round(m.cpu), mem: Math.round(100 * m.mem.used / m.mem.total), disk: Math.round(100 * (m.disk.total - m.disk.free) / m.disk.total), os: m.os }));
  const svc = await get('/api/s/local/services');
  assert.ok(svc.available && svc.list.length > 5, 'Dienste');
  assert.ok(svc.list.some(s => s.name === 's3cure-agent.service' && s.active === 'active'), 'Agent als Dienst');
  console.log('✓ Dienste', svc.list.length);
  const logs = await get('/api/s/local/services/s3cure-agent.service/logs?lines=20');
  assert.match(logs.text, /S3cure Agent läuft/, 'Logs');
  console.log('✓ Logs');
  const stop = await fetch(base + '/api/s/local/services/ssh.service/stop', { method: 'POST', headers: { ...h, Cookie: cookie } });
  assert.equal(stop.status, 400, 'ssh geschützt');
  console.log('✓ ssh geschützt');
  if (svc.list.some(s => s.name === 'cron.service')) {
    const restart = await fetch(base + '/api/s/local/services/cron.service/restart', { method: 'POST', headers: { ...h, Cookie: cookie } });
    assert.equal(restart.status, 200, 'cron neu starten');
    console.log('✓ cron neu gestartet');
  }
})().catch(err => { console.error('✕', err.message); process.exit(1); });
