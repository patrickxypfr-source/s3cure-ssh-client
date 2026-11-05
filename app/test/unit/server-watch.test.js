// Alle Server auf einen Blick (lib/server-watch.js) – mit nachgebauter Verbindung
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createServerWatch, parseResult, findIssues, classify } = require('../../lib/server-watch');

const OUTPUT = [
  '@@load', '0.10 0.20 0.30 1/100 123',
  '@@cpus', '4',
  '@@mem', 'MemTotal: 1000000 kB', 'MemAvailable: 20000 kB',
  '@@df', '/dev/sda1 100000 95000 5000 95% /',
  '@@up', '3600.5 100',
  '@@failed', 'nginx.service', 'backup.timer', '',
].join('\n');

test('Ausgabe lesen: Werte und ausgefallene Dienste', () => {
  const { stats, failed } = parseResult(OUTPUT);
  assert.ok(stats.ok);
  assert.equal(stats.cpus, 4);
  assert.deepEqual(failed, ['nginx.service', 'backup.timer']);
});

test('Probleme: Platte, Arbeitsspeicher, Dienste, offline', () => {
  const { stats, failed } = parseResult(OUTPUT);
  const ids = findIssues({ state: 'ok', stats, failed }, { disk: 90 }).map(i => i.id);
  assert.deepEqual(ids, ['disk', 'mem', 'service:nginx.service', 'service:backup.timer']);
  assert.deepEqual(findIssues({ state: 'ok', stats, failed: [] }, { disk: 99 }).map(i => i.id), ['mem']);
  assert.deepEqual(findIssues({ state: 'offline' }, { disk: 90 }).map(i => i.id), ['offline']);
});

test('Fehler einordnen', () => {
  assert.equal(classify({ level: 'client-authentication' }), 'auth');
  assert.equal(classify({ level: 'host-key' }), 'hostkey');
  assert.equal(classify({ code: 'ENOTFOUND' }), 'offline');
  assert.equal(classify({ level: 'client-timeout' }), 'offline');
  assert.equal(classify({ timeout: true }), 'offline');
  assert.equal(classify(new Error('irgendwas')), 'error');
});

// Nachgebauter ssh2-Client: exec liefert OUTPUT
function fakeClient(out = OUTPUT) {
  return {
    ended: false,
    end() { this.ended = true; },
    exec(cmd, cb) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      cb(null, stream);
      setImmediate(() => { stream.emit('data', Buffer.from(out)); stream.emit('close'); });
    },
  };
}

function setup({ fail = {}, settings = {} } = {}) {
  const hosts = {
    web: { host: 'web', user: 'u' },
    db: { host: 'db', user: 'u' },
    ftp: { host: 'f', user: 'u', protocol: 'ftp' },
    off: { host: 'x', user: 'u', watch: false },
  };
  const opts = [];
  const notes = [];
  const sent = [];
  const connection = {
    connectTo: async (target, name, _cache, o) => {
      opts.push(o);
      if (fail[name]) throw Object.assign(new Error(fail[name].msg || 'nein'), fail[name]);
      return fakeClient();
    },
  };
  const w = createServerWatch({
    connection, loadHosts: () => hosts, isFtpHost: h => h.protocol === 'ftp',
    settings: () => settings, send: (...a) => sent.push(a), notify: n => notes.push(n),
  });
  return { w, opts, notes, sent, fail };
}

test('Alle prüfen: ohne FTP und ohne abgewählte Server, nie mit Rückfragen', async () => {
  const s = setup({ fail: { db: { level: 'client-authentication' } } });
  await s.w.checkAll();
  const list = s.w.snapshot().list;
  assert.deepEqual(list.map(r => r.name), ['web', 'db']);
  assert.equal(list[0].state, 'warn'); // Platte 95 %, RAM 98 %, Dienste
  assert.equal(list[1].state, 'auth');
  assert.ok(s.opts.every(o => o.noPrompt === true));
});

test('Mitteilungen nur für neue Probleme, „wieder erreichbar“ danach', async () => {
  const s = setup({ fail: { db: { code: 'ECONNREFUSED' } } });
  await s.w.checkAll();
  assert.equal(s.notes.length, 2); // web: Probleme, db: offline
  assert.match(s.notes.find(n => n.name === 'db').body, /.+/);
  s.notes.length = 0;
  await s.w.checkAll();
  assert.equal(s.notes.length, 0); // nichts Neues
  delete s.fail.db;
  await s.w.checkAll();
  assert.equal(s.notes.length, 1); // db wieder erreichbar
  assert.equal(s.notes[0].name, 'db');
});

test('Prüfung von Hand: keine Mitteilungen; ausgeschaltet: keine Mitteilungen', async () => {
  const s = setup({ fail: { db: { code: 'ECONNREFUSED' } } });
  await s.w.checkAll({ silent: true });
  assert.equal(s.notes.length, 0);
  const t = setup({ fail: { db: { code: 'ECONNREFUSED' } }, settings: { 'watch.notify': false } });
  await t.w.checkAll();
  assert.equal(t.notes.length, 0);
  assert.ok(t.sent.some(([ch]) => ch === 'srvwatch:update'));
});
