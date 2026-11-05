// Sicherheits-Check (lib/security-check.js), .env (src/env-core.js, lib/env-files.js), Datenbank (lib/db.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sec = require('../../lib/security-check');
const E = require('../../src/env-core');
const envFiles = require('../../lib/env-files');
const db = require('../../lib/db');

// Typischer frisch eingerichteter Debian-Server, als root geprüft
const DEBIAN = [
  '@@mode', 'root', '@@who', '0',
  '@@sshd', 'port 22', 'permitrootlogin yes', 'passwordauthentication yes', 'kbdinteractiveauthentication no', 'permitemptypasswords no',
  '@@ufw', 'Status: inactive', '@@nft', '0', '@@ipt', '-P INPUT ACCEPT', '0',
  '@@f2b', 'fail2ban inactive', 'crowdsec inactive',
  '@@apt', '12', '3', '@@unattended',
  '@@reboot', 'yes',
  '@@ports', 'tcp 0.0.0.0:22 users:(("sshd",pid=1,fd=3))', 'tcp 0.0.0.0:5432 users:(("postgres",pid=2,fd=5))',
  'tcp 127.0.0.1:6379 users:(("redis-server",pid=3,fd=6))', 'tcp [::]:443 users:(("nginx",pid=4,fd=7))', 'tcp 0.0.0.0:3000 users:(("node",pid=5,fd=8))', 'udp 0.0.0.0:68 users:(("dhclient",pid=6,fd=9))',
  '@@uid0', 'root', '@@emptypw',
  '@@certs', `panel.example.com|${new Date(Date.now() + 5 * 86400000).toUTCString()}`,
  '@@ntp', 'yes', '@@os', 'debian',
].join('\n');

test('Sicherheit: frischer Debian-Server bekommt eine schlechte Note und passende Befehle', () => {
  const r = sec.evaluate(DEBIAN, { auth: 'publickey' });
  const by = Object.fromEntries(r.checks.map(c => [c.id, c]));
  assert.equal(r.admin, true);
  assert.equal(by.rootLogin.status, 'bad');
  assert.match(by.rootLogin.fix, /PermitRootLogin prohibit-password/);
  assert.match(by.rootLogin.fix, /sshd -t/); // erst prüfen, dann neu laden
  assert.equal(by.passwordAuth.status, 'warn');
  assert.ok(by.passwordAuth.fix, 'per Schlüssel angemeldet -> Beheben erlaubt');
  assert.equal(by.firewall.status, 'bad');
  assert.match(by.firewall.fix, /ufw allow 22\/tcp/);
  assert.equal(by.bruteforce.status, 'warn');
  assert.equal(by.updates.status, 'bad'); // Sicherheits-Updates offen
  assert.equal(by.autoUpdates.status, 'warn');
  assert.equal(by.reboot.status, 'warn');
  assert.equal(by.ports.status, 'bad');
  assert.match(by.ports.detail, /5432/);
  assert.match(by.ports.detail, /3000/);
  assert.doesNotMatch(by.ports.detail, /6379|:68\b/); // nur lokal bzw. DHCP
  assert.equal(by.certs.status, 'warn');
  assert.equal(by.ntp.status, 'ok');
  assert.ok(['E', 'F'].includes(r.grade), r.grade);
});

test('Sicherheit: mit Passwort angemeldet -> Passwort-Anmeldung nicht abschaltbar (sonst ausgesperrt)', () => {
  const r = sec.evaluate(DEBIAN, { auth: 'password' });
  const pw = r.checks.find(c => c.id === 'passwordAuth');
  assert.equal(pw.fix, null);
  assert.ok(pw.blocked);
});

test('Sicherheit: gut eingerichteter Server bekommt A; ohne Rechte keine Note', () => {
  const good = DEBIAN
    .replace('permitrootlogin yes', 'permitrootlogin prohibit-password').replace('passwordauthentication yes', 'passwordauthentication no')
    .replace('Status: inactive', 'Status: active').replace('fail2ban inactive', 'fail2ban active')
    .replace('@@apt\n12\n3', '@@apt\n0\n0').replace('@@unattended', '@@unattended\ninstalled\nAPT::Periodic::Unattended-Upgrade "1";')
    .replace('@@reboot\nyes', '@@reboot').replace('0.0.0.0:5432', '127.0.0.1:5432').replace(/\n@@certs\n[^\n]+/, '');
  const r = sec.evaluate(good, { auth: 'publickey' });
  assert.equal(r.grade, 'A', JSON.stringify(r.checks.filter(c => c.status !== 'ok')));
  const limited = sec.evaluate('@@mode\nuser\n@@f2b\nfail2ban inactive\n', {});
  assert.equal(limited.admin, false);
  assert.equal(limited.grade, null);
  assert.ok(limited.unknown > 0);
});

test('Sicherheit: Adressen lesen', () => {
  assert.deepEqual(sec.parseAddr('0.0.0.0:5432'), { addr: '0.0.0.0', port: 5432, public: true });
  assert.equal(sec.parseAddr('127.0.0.1:6379').public, false);
  assert.equal(sec.parseAddr('[::1]:5432').public, false);
  assert.equal(sec.parseAddr('[::]:80').port, 80);
  assert.equal(sec.parseAddr('*:22').public, true);
});

test('.env: lesen und schreiben ohne Formatverlust', () => {
  const text = '# Kommentar\nexport A=1\nB="x y" # Notiz\nC=\'lit $x\'\n\nURL=postgres://u:p@h/db\n';
  const lines = E.parse(text);
  assert.equal(E.serialize(lines), text); // unverändert -> genau gleich
  const m = E.toMap(lines);
  assert.equal(m.get('B'), 'x y');
  assert.equal(m.get('C'), 'lit $x');
  E.set(lines, 'A', '2'); E.set(lines, 'NEW', 'a b $c'); E.set(lines, 'Q', "it's"); E.remove(lines, 'URL');
  const out = E.serialize(lines);
  assert.match(out, /^# Kommentar\nexport A=2\nB="x y" # Notiz\n/);
  const back = E.toMap(E.parse(out));
  assert.equal(back.get('NEW'), 'a b $c');
  assert.equal(back.get('Q'), "it's");
  assert.equal(back.has('URL'), false);
  assert.deepEqual(E.diff(text, lines), { added: ['NEW', 'Q'], removed: ['URL'], changed: ['A'] });
});

test('.env: vergleichen und Geheimnisse erkennen', () => {
  const c = E.compare(E.parse('A=1\nB=2\n'), 'A=\nC=example\n');
  assert.deepEqual(c.missingHere, [{ key: 'C', value: 'example' }]);
  assert.deepEqual(c.onlyHere, ['B']);
  for (const k of ['DATABASE_URL', 'NEXTAUTH_SECRET', 'DISCORD_TOKEN', 'API_KEY', 'DB_PASSWORD']) assert.ok(E.isSecretKey(k), k);
  for (const k of ['PORT', 'LOG_LEVEL', 'NODE_ENV']) assert.ok(!E.isSecretKey(k), k);
});

test('.env-Dateien: Suchergebnis, Backup-Namen', () => {
  const list = envFiles.parseFind('/srv/app/.env\n/srv/app/.env.example\n/srv/app/.env.bak\n/srv/app/.env.bak-2024\n/srv/app/.envrc_old\n/home/x/bot/.env.local\nkaputt\n');
  assert.deepEqual(list.map(f => f.path), ['/home/x/bot/.env.local', '/srv/app/.env', '/srv/app/.env.example']);
  assert.equal(envFiles.backupKey('/srv/my app/.env'), 'srv_my_app_.env');
  assert.match(envFiles.stamp(new Date(Date.UTC(2026, 10, 5, 17, 30, 3))), /^20261105-173003$/);
});

test('Datenbank: Adressen und Zugangsdaten aus .env erkennen', () => {
  assert.deepEqual(db.parseUrl('postgresql://app:p%40ss@db.local:6543/shop?sslmode=disable'),
    { host: 'db.local', port: 6543, database: 'shop', user: 'app', password: 'p@ss' });
  const c = db.parseCandidates([
    '/srv/panel/.env:DATABASE_URL="postgres://panel:geheim@postgres:5432/panel"',
    '/srv/bot/.env:POSTGRES_USER=bot', '/srv/bot/.env:POSTGRES_PASSWORD=pw', '/srv/bot/.env:POSTGRES_DB=botdb',
  ].join('\n'));
  assert.equal(c.length, 2);
  assert.equal(c[0].host, '127.0.0.1'); // Docker-Name -> lokal
  assert.equal(c[0].dockerHost, 'postgres');
  assert.equal(c[1].database, 'botdb');
  assert.equal(c[1].password, 'pw');
});

test('Datenbank: nur lesende SQL-Befehle laufen ohne Rückfrage', () => {
  for (const s of ['select 1', 'WITH x AS (select 1) select * from x', 'explain select * from t', "select 'delete from x'", '-- kommentar\nselect 1;'])
    assert.ok(db.isReadOnly(s), s);
  for (const s of ['delete from t', 'update t set a = 1', 'select 1; drop table t', 'with d as (delete from t returning *) select * from d', 'truncate t', ''])
    assert.ok(!db.isReadOnly(s), s);
  assert.equal(db.qi('we"ird'), '"we""ird"');
  assert.equal(db.cell(null), null);
  assert.equal(db.cell(Buffer.from([1, 255])), '\\x01ff');
  assert.equal(db.cell({ a: 1 }), '{"a":1}');
});
