// Tunnel-Konfiguration prüfen und beschreiben (lib/tunnels.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTunnel, tunnelsOf, describe } = require('../../lib/tunnels');

test('lokaler Tunnel: Standardwerte und Zahlen aus Text', () => {
  const t = normalizeTunnel({ localPort: '8080', targetPort: '80', web: 'http', autoStart: 1 });
  assert.equal(t.type, 'local');
  assert.equal(t.localPort, 8080);
  assert.equal(t.targetHost, 'localhost');
  assert.equal(t.targetPort, 80);
  assert.equal(t.web, 'http');
  assert.equal(t.autoStart, true);
  assert.match(t.id, /^[0-9a-f-]{36}$/);
  assert.equal(describe(t), 'localhost:8080 → localhost:80');
});

test('Remote- und SOCKS-Tunnel', () => {
  const r = normalizeTunnel({ id: 'x', type: 'remote', remotePort: 9000, targetPort: 3000 });
  assert.deepEqual(r, { id: 'x', type: 'remote', name: '', autoStart: false, remotePort: 9000, targetHost: '127.0.0.1', targetPort: 3000 });
  assert.match(describe(r), /^Server:9000 → 127\.0\.0\.1:3000/);
  const d = normalizeTunnel({ type: 'dynamic', localPort: 1080, targetPort: 'egal', web: 'http' });
  assert.equal(d.targetPort, undefined);
  assert.equal(d.web, undefined);
  assert.equal(describe(d), 'SOCKS-Proxy auf localhost:1080');
});

test('ungültige Eingaben ergeben verständliche Fehler', () => {
  assert.throws(() => normalizeTunnel({ localPort: '', targetPort: 80 }), /lokalen Port/);
  assert.throws(() => normalizeTunnel({ localPort: 70000, targetPort: 80 }), /lokalen Port/);
  assert.throws(() => normalizeTunnel({ localPort: 1.5, targetPort: 80 }), /lokalen Port/);
  assert.throws(() => normalizeTunnel({ type: 'remote', remotePort: 0, targetPort: 80 }), /Server/);
  assert.throws(() => normalizeTunnel({ localPort: 8080, targetPort: 80, targetHost: 'a b' }), /Leerzeichen/);
  assert.throws(() => normalizeTunnel({ localPort: 8080 }), /Ziel-Port/);
});

test('tunnelsOf überspringt kaputte Einträge', () => {
  assert.deepEqual(tunnelsOf(null), []);
  assert.deepEqual(tunnelsOf({}), []);
  const list = tunnelsOf({ tunnels: [{ localPort: 1, targetPort: 2 }, { localPort: 'x' }, null] });
  assert.equal(list.length, 1);
});
