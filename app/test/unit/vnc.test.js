// Remote Desktop (VNC): Ziel-Eingabe, Port-Erkennung, WebSocket-Brücke mit Einmal-Token (lib/vnc.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Duplex } = require('node:stream');
const {
  parseVncTarget, formatVncTarget, vncField, vncSettings, parseListening, vncCandidates, createVncBridge,
} = require('../../lib/vnc');

test('parseVncTarget versteht Port, Display-Nummer und Adresse', () => {
  assert.deepEqual(parseVncTarget(''), { host: 'localhost', port: 5900 });
  assert.deepEqual(parseVncTarget(':1'), { host: 'localhost', port: 5901 });
  assert.deepEqual(parseVncTarget('2'), { host: 'localhost', port: 5902 });
  assert.deepEqual(parseVncTarget('5905'), { host: 'localhost', port: 5905 });
  assert.deepEqual(parseVncTarget('pi.local'), { host: 'pi.local', port: 5900 });
  assert.deepEqual(parseVncTarget('10.0.0.5:3'), { host: '10.0.0.5', port: 5903 });
  assert.deepEqual(parseVncTarget('10.0.0.5:5901'), { host: '10.0.0.5', port: 5901 });
  assert.deepEqual(parseVncTarget('host::50'), { host: 'host', port: 50 });
  assert.deepEqual(parseVncTarget('[::1]:5901'), { host: '::1', port: 5901 });
  assert.deepEqual(parseVncTarget('[::1]'), { host: '::1', port: 5900 });
  assert.throws(() => parseVncTarget('a b'), /Leerzeichen|spaces/);
  assert.throws(() => parseVncTarget('host:abc'), /Port|port/);
  assert.throws(() => parseVncTarget('host:70000'), /Port|port/);
});

test('formatVncTarget setzt IPv6 in Klammern', () => {
  assert.equal(formatVncTarget({ host: 'localhost', port: 5900 }), 'localhost:5900');
  assert.equal(formatVncTarget({ host: '::1', port: 5901 }), '[::1]:5901');
});

test('vncField prüft Einstellungen und speichert Standardwerte nicht', () => {
  assert.equal(vncField(undefined), undefined);
  assert.equal(vncField({ enabled: false, target: 'localhost:5900' }), undefined);
  assert.deepEqual(vncField({ enabled: true, target: ':1', quality: 'low', viewOnly: true, scale: 'real' }),
    { enabled: true, host: 'localhost', port: 5901, quality: 'low', viewOnly: true, scale: 'real' });
  assert.deepEqual(vncField({ enabled: true, target: '', quality: 'quatsch', scale: 'x' }),
    { enabled: true, host: 'localhost', port: 5900, quality: 'balanced', viewOnly: false, scale: 'fit' });
  // aus hosts.json (host/port statt target)
  assert.equal(vncField({ enabled: true, host: 'pi', port: 5902 }).port, 5902);
  assert.throws(() => vncField({ enabled: true, target: 'x y' }));
});

test('vncSettings liefert Standardwerte für Verbindungen ohne VNC', () => {
  assert.deepEqual(vncSettings({ host: 'pi' }), { enabled: false, host: 'localhost', port: 5900, quality: 'balanced', viewOnly: false, scale: 'fit' });
  assert.equal(vncSettings({ vnc: { enabled: true, host: 'localhost', port: 5901 } }).port, 5901);
  assert.equal(vncSettings(null).port, 5900);
});

test('parseListening liest ss und netstat', () => {
  const ss = [
    'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
    'LISTEN 0      128          0.0.0.0:22        0.0.0.0:*',
    'LISTEN 0      5          127.0.0.1:5901      0.0.0.0:*',
    'LISTEN 0      5              [::1]:5901         [::]:*',
    'LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*',
    'LISTEN 0      32                 *:5900            *:*',
  ].join('\n');
  assert.deepEqual(parseListening(ss), [
    { addr: '0.0.0.0', port: 22 }, { addr: '127.0.0.1', port: 5901 }, { addr: '::1', port: 5901 },
    { addr: '127.0.0.53', port: 53 }, { addr: '*', port: 5900 },
  ]);
  const netstat = [
    'Active Internet connections (only servers)',
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State',
    'tcp        0      0 0.0.0.0:5900            0.0.0.0:*               LISTEN',
    'tcp6       0      0 :::5902                 :::*                    LISTEN',
  ].join('\n');
  assert.deepEqual(parseListening(netstat), [{ addr: '0.0.0.0', port: 5900 }, { addr: '::', port: 5902 }]);
});

test('vncCandidates schlägt nur VNC-Ports vor und erkennt „nur lokal“', () => {
  const list = vncCandidates([
    { addr: '0.0.0.0', port: 22 }, { addr: '127.0.0.1', port: 5901 }, { addr: '::1', port: 5901 },
    { addr: '*', port: 5900 }, { addr: '::1', port: 5903 }, { addr: '192.168.1.9', port: 5904 }, { addr: '0.0.0.0', port: 6000 },
  ]);
  assert.deepEqual(list.map(c => [c.port, c.display, c.host, c.loopbackOnly, c.target]), [
    [5900, 0, '127.0.0.1', false, '127.0.0.1:5900'],
    [5901, 1, '127.0.0.1', true, '127.0.0.1:5901'],
    [5903, 3, '::1', true, '[::1]:5903'],
    [5904, 4, '192.168.1.9', false, '192.168.1.9:5904'],
  ]);
});

// ---------- Brücke mit nachgebautem SSH-Client ----------

// forwardOut verbindet zu einem echten TCP-Server auf 127.0.0.1 (statt durch SSH)
function fakeClient(map) {
  return {
    forwardOut(_sa, _sp, host, port, cb) {
      const real = map[port];
      if (!real) return cb(new Error('(SSH) Channel open failure: Connection refused'));
      const sock = net.connect(real, '127.0.0.1');
      const ch = new Duplex({
        read() { sock.resume(); },
        write(chunk, _enc, done) { sock.write(chunk, done); },
        final(done) { sock.end(); done(); },
      });
      sock.on('data', d => { if (!ch.push(d)) sock.pause(); });
      sock.on('close', () => { ch.push(null); ch.emit('close'); });
      sock.on('error', () => {});
      ch.close = () => sock.destroy();
      sock.once('connect', () => cb(null, ch));
    },
  };
}

function listen(handler) {
  return new Promise(res => {
    const srv = net.createServer(handler);
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

const secretsStub = () => {
  const m = new Map();
  return { has: n => m.has(n), read: n => m.get(n) ?? null, write: (n, v) => { m.set(n, v); return true; }, remove: n => m.delete(n) };
};

test('Brücke: Einmal-Token, Daten in beide Richtungen, falsches Token abgelehnt', async () => {
  // Kleiner „VNC-Server“: schickt die Begrüßung und spiegelt danach alles zurück
  const vncSrv = await listen(sock => { sock.write('RFB 003.008\n'); sock.on('data', d => sock.write(d)); });
  const secrets = secretsStub();
  secrets.write('pi', 'geheim');
  const bridge = createVncBridge({
    getSession: id => (id === 'tab1' ? { client: fakeClient({ 5901: vncSrv.address().port }), hostName: 'pi' } : null),
    loadHosts: () => ({ pi: { vnc: { enabled: true, host: 'localhost', port: 5901 } } }),
    secrets, clipboard: { readText: () => '', writeText: () => {} },
  });
  try {
    const info = await bridge.open('tab1');
    assert.match(info.url, /^ws:\/\/127\.0\.0\.1:\d+\/vnc\/[0-9a-f]{48}$/);
    assert.equal(info.target, 'localhost:5901');
    assert.equal(info.version, '003.008');
    assert.equal(info.password, 'geheim');

    // falsches Token -> abgelehnt
    const bad = new WebSocket(info.url.replace(/[0-9a-f]{48}$/, '0'.repeat(48)));
    await new Promise(res => { bad.onerror = res; bad.onopen = () => { throw new Error('darf nicht öffnen'); }; });

    const ws = new WebSocket(info.url, ['binary']);
    ws.binaryType = 'arraybuffer';
    const got = [];
    ws.onmessage = e => got.push(Buffer.from(e.data).toString('latin1'));
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    assert.equal(ws.protocol, 'binary');
    ws.send(Buffer.from('hallo'));
    const deadline = Date.now() + 3000;
    while (got.join('') !== 'RFB 003.008\nhallo' && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(got.join(''), 'RFB 003.008\nhallo');

    // Token ist verbraucht
    const again = new WebSocket(info.url);
    await new Promise(res => { again.onerror = res; again.onopen = () => { throw new Error('Token zweimal benutzt'); }; });

    // Trennen schließt den WebSocket
    const closed = new Promise(res => { ws.onclose = res; });
    bridge.stopAll('tab1');
    await closed;
  } finally {
    bridge.closeAll();
    vncSrv.close();
  }
});

test('Brücke: verständliche Fehler, wenn kein VNC-Server läuft oder der Port etwas anderes ist', async () => {
  const httpLike = await listen(sock => { sock.write('SSH-2.0-OpenSSH_9.6\r\n'); });
  const bridge = createVncBridge({
    getSession: id => (id === 't' ? { client: fakeClient({ 5902: httpLike.address().port }), hostName: null } : null),
    loadHosts: () => ({}), secrets: secretsStub(), clipboard: {},
  });
  try {
    await assert.rejects(bridge.open('t', { target: ':0' }), /kein VNC-Server|No VNC server/);
    await assert.rejects(bridge.open('t', { target: ':2' }), /anderes Programm|different program/);
    await assert.rejects(bridge.open('nix'), /SSH/);
  } finally {
    bridge.closeAll();
    httpLike.close();
  }
});

test('Brücke: Passwort umbenennen und löschen mit der Verbindung', () => {
  const secrets = secretsStub();
  const bridge = createVncBridge({ getSession: () => null, loadHosts: () => ({}), secrets, clipboard: {} });
  bridge.onHostSaved('a', { vncPassword: 'x' });
  assert.equal(secrets.read('a'), 'x');
  bridge.onHostSaved('b', {}, 'a');
  assert.equal(secrets.read('a'), null);
  assert.equal(secrets.read('b'), 'x');
  bridge.onHostSaved('b', { vncForgetPassword: true });
  assert.equal(secrets.has('b'), false);
  bridge.onHostSaved('c', { vncPassword: 'y' });
  bridge.onHostDeleted('c');
  assert.equal(secrets.has('c'), false);
});
