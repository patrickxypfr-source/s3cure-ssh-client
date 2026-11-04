// Import aus ~/.ssh/config (lib/sshconfig.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSshConfig, planImport, parseConfig } = require('../../lib/sshconfig');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's3cure-sshconfig-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f; };

test('liest Hosts, erster Wert gewinnt, Platzhalter-Blöcke gelten für alle', () => {
  const key = write('id_test', 'dummy');
  const file = write('config', `
# Kommentar
Host web prod-*
  HostName 10.0.0.%h
  User deploy
  Port=2222
  IdentityFile ${key}

Host web
  User wird-ignoriert

Host *
  User standard
  ProxyJump none
`);
  const list = readSshConfig(file);
  assert.deepEqual(list.map(e => e.name), ['web']);
  assert.deepEqual(list[0], { name: 'web', user: 'deploy', host: '10.0.0.web', port: 2222, key, jump: null });
});

test('ProxyJump, Anführungszeichen, Negation und fehlende Schlüsseldatei', () => {
  const file = write('config2', `
Host "mein server" db
  HostName db.example.org
  IdentityFile /gibt/es/nicht
  ProxyJump bastion
Host * !db
  Port 2200
`);
  const list = readSshConfig(file);
  const byName = Object.fromEntries(list.map(e => [e.name, e]));
  assert.ok(byName['mein server']);
  assert.equal(byName['mein server'].port, 2200);
  assert.equal(byName.db.port, 22);
  assert.equal(byName.db.key, null);
  assert.equal(byName.db.jump, 'bastion');
});

test('Include mit Platzhalter, relativ zum Ordner der Datei', () => {
  fs.mkdirSync(path.join(tmp, 'conf.d'), { recursive: true });
  write('conf.d/a.conf', 'Host inc-a\n  HostName a.local\n');
  write('conf.d/b.conf', 'Host inc-b\n  HostName b.local\n');
  const file = write('config3', 'Include conf.d/*.conf\nHost danach\n  HostName d.local\n');
  assert.deepEqual(readSshConfig(file).map(e => [e.name, e.host]), [['inc-a', 'a.local'], ['inc-b', 'b.local'], ['danach', 'd.local']]);
});

test('Match-Blöcke werden übersprungen', () => {
  const blocks = parseConfig('Host a\n  User x\nMatch host a\n  User y\n', tmp);
  assert.deepEqual(blocks.map(b => b.patterns), [['*'], ['a'], []]);
});

test('fehlende Datei -> null', () => {
  assert.equal(readSshConfig(path.join(tmp, 'gibtsnicht')), null);
});

test('planImport überspringt Doppelte und biegt ProxyJump um', () => {
  const hosts = { Bastion: { host: 'b.example', user: 'root', port: 22 }, web: { host: 'other', user: 'x', port: 22 } };
  const entries = [
    { name: 'bastion', host: 'b.example', user: 'root', port: 22, jump: null },
    { name: 'web', host: 'w.example', user: 'root', port: 22, jump: null },
    { name: 'app', host: 'a.example', user: 'root', port: 22, jump: 'bastion' },
  ];
  const { add, skip } = planImport(entries, hosts);
  assert.deepEqual(add.map(e => e.name), ['app']);
  assert.equal(add[0].jump, 'Bastion');
  assert.deepEqual(skip.map(s => s.name), ['bastion', 'web']);
  assert.match(skip[0].reason, /Bastion/);
  assert.equal(skip[1].reason, 'Name schon vergeben');
});
