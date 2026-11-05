// S3cure Agent: 2FA, Anmeldung, Auswertung, API (Demo-Modus, eigener Datenordner)
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.S3CURE_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 's3agent-'));
fs.writeFileSync(path.join(process.env.S3CURE_AGENT_DIR, 'config.json'), JSON.stringify({ port: 0, name: 'testserver' }));

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../lib/totp');
const { createAuth } = require('../lib/auth');
const system = require('../lib/system');
const { evaluate } = require('../lib/alerts');
const { createAgent } = require('../lib/server');

test('2FA: Testwerte aus RFC 6238 und Prüfung', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp.hotp(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totp.hotp(secret, Math.floor(1111111109 / 30)), '081804');
  const time = 1111111109000;
  const s = totp.verify(secret, '081804', { time });
  assert.equal(s, Math.floor(1111111109 / 30));
  assert.equal(totp.verify(secret, '081804', { time, lastStep: s }), null, 'derselbe Code darf nicht zweimal');
  assert.equal(totp.verify(secret, '000000', { time }), null);
  assert.match(totp.uri(secret, 'patrick@srv'), /^otpauth:\/\/totp\/S3cure:patrick%40srv\?secret=GEZD/);
});

test('Anmeldung: Passwort + Code, falscher Code, Sperre, Sitzung, Rollen', async () => {
  let now = Date.now();
  const auth = createAuth({ now: () => now });
  await assert.rejects(auth.addUser('ab', 'kurz'), /mindestens 10/);
  const info = await auth.addUser('Admin', 'ein-sicheres-passwort', 'admin');
  assert.equal(info.name, 'admin');
  const code = (off = 0) => totp.hotp(info.secret, totp.step(now) + off);
  assert.equal((await auth.login({ user: 'admin', password: 'falsch-falsch', code: code(), ip: '1.1.1.1' })).ok, false);
  assert.equal((await auth.login({ user: 'admin', password: 'ein-sicheres-passwort', code: '123456', ip: '1.1.1.1' })).ok, false);
  const r = await auth.login({ user: 'ADMIN', password: 'ein-sicheres-passwort', code: code(), ip: '1.1.1.2' });
  assert.equal(r.ok, true);
  assert.equal(auth.session(r.token).role, 'admin');
  // Code wiederverwenden geht nicht
  assert.equal((await auth.login({ user: 'admin', password: 'ein-sicheres-passwort', code: code(), ip: '1.1.1.3' })).ok, false);
  // Sperre je IP
  for (let i = 0; i < 5; i++) await auth.login({ user: 'nobody', password: 'x', code: '1', ip: '9.9.9.9' });
  now += 30000;
  assert.equal((await auth.login({ user: 'admin', password: 'ein-sicheres-passwort', code: code(), ip: '9.9.9.9' })).locked, true);
  // Sitzung läuft nach 14 Tagen ohne Nutzung ab
  now += 15 * 864e5;
  assert.equal(auth.session(r.token), null);
  // Passwort ändern meldet überall ab
  now += 60000;
  const r2 = await auth.login({ user: 'admin', password: 'ein-sicheres-passwort', code: code(), ip: '1.1.1.4' });
  await auth.setPassword('admin', 'noch-ein-passwort-1');
  assert.equal(auth.session(r2.token), null);
});

test('System: systemctl- und docker-Ausgabe lesen, Schutzliste', () => {
  const units = system.parseUnits([
    '  nginx.service            loaded active   running A high performance web server',
    '● backup.service           loaded failed   failed  Nächtliches Backup',
    '  ghost.service            not-found inactive dead ghost.service',
    'kaputt',
  ].join('\n'));
  assert.deepEqual(units.map(u => [u.name, u.active]), [['nginx.service', 'active'], ['backup.service', 'failed']]);
  const ctr = system.parseContainers('{"ID":"abcdef1234567890","Names":"web","Image":"nginx","State":"running","Status":"Up 2 hours","Ports":""}\nkaputt\n');
  assert.equal(ctr[0].id, 'abcdef123456');
  assert.ok(system.matches('systemd-journald.service', ['systemd-*']));
  assert.ok(!system.matches('nginx.service', ['ssh.service', 'systemd-*']));
  assert.ok(!system.UNIT_RE.test('x;rm -rf /.service'));
  assert.ok(!system.CONTAINER_RE.test('-rf'));
  const mem = system.parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n');
  assert.equal(mem.used, 750 * 1024);
});

test('Warnungen: Platte, RAM, Last, ausgefallene Dienste', () => {
  const m = { cpus: 2, load: [7, 1, 1], mem: { total: 100, used: 97 }, disk: { total: 100, free: 5 } };
  const list = evaluate(m, [{ name: 'a.service', active: 'failed' }, { name: 'b.service', active: 'active' }], { disk: 90, mem: 95, loadPerCpu: 3, serviceFailed: true });
  assert.deepEqual(list.map(i => i.id), ['disk', 'mem', 'load', 'svc:a.service']);
  assert.equal(evaluate({ cpus: 4, load: [1], mem: { total: 100, used: 10 }, disk: { total: 100, free: 90 } }, [], { disk: 90, mem: 95, loadPerCpu: 3, serviceFailed: true }).length, 0);
});

// ---------- API über HTTP (Demo-Daten) ----------
let srv, base, agent;
after(() => { agent && agent.stop(); srv && srv.close(); });

test('API: Anmeldung, Rechte, Aktionen, Schutz', async () => {
  process.env.S3CURE_AGENT_DEMO = '1';
  agent = createAgent({ demo: true });
  srv = await agent.listen();
  base = `http://127.0.0.1:${srv.address().port}`;
  const admin = await agent.auth.addUser('chef', 'chef-passwort-123', 'admin');
  const viewer = await agent.auth.addUser('gast', 'gast-passwort-123', 'viewer');
  const call = async (method, p, { body, cookie, header = true } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(header ? { 'X-S3cure': '1' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0], csp: r.headers.get('content-security-policy') };
  };
  const login = async (u, pw, secret) => (await call('POST', '/api/login', { body: { user: u, password: pw, code: totp.hotp(secret, totp.step()) } })).cookie;

  assert.equal((await call('GET', '/api/servers')).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { user: 'chef', password: 'chef-passwort-123', code: totp.hotp(admin.secret, totp.step()) }, header: false })).status, 403);
  const c = await login('chef', 'chef-passwort-123', admin.secret);
  assert.match(c, /^s3s=/);
  const servers = await call('GET', '/api/servers', { cookie: c });
  assert.equal(servers.data[0].name, 'testserver');
  assert.equal((await call('POST', '/api/s/local/services/nginx.service/restart', { cookie: c })).status, 200);
  assert.equal((await call('POST', '/api/s/local/services/ssh.service/stop', { cookie: c })).status, 400);
  assert.equal((await call('POST', '/api/s/local/reboot', { cookie: c, body: { code: '000000' } })).status, 403);
  assert.equal((await call('GET', '/api/s/nope/services', { cookie: c })).status, 404);
  const g = await login('gast', 'gast-passwort-123', viewer.secret);
  assert.equal((await call('GET', '/api/s/local/containers', { cookie: g })).status, 200);
  assert.equal((await call('POST', '/api/s/local/containers/umami/stop', { cookie: g })).status, 403);
  assert.equal((await call('GET', '/api/audit', { cookie: g })).status, 403);
  const audit = await call('GET', '/api/audit', { cookie: c });
  assert.ok(audit.data.some(e => e.action === 'service-restart' && e.user === 'chef'));
  // Andere Agenten: nur mit Schlüssel
  const cfg = require('../lib/config').load();
  assert.equal((await fetch(base + '/api/agent/overview')).status, 401);
  assert.equal((await fetch(base + '/api/agent/overview', { headers: { Authorization: 'Bearer ' + cfg.agentToken } })).status, 200);
  // Web-App mit Sicherheits-Header, keine Dateien außerhalb von public
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await page.text(), /<title>S3cure<\/title>/);
  const sneaky = await fetch(base + '/..%2fpackage.json');
  assert.ok(!(await sneaky.text()).includes('"dependencies"'));
});
