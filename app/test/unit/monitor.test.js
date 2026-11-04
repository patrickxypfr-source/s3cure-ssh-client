// Server-Übersicht: Auswertung der /proc-Ausgabe (lib/monitor.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../../lib/monitor');

const sample = (stat) => [
  '@@load', '0.50 0.40 0.30 1/100 1234',
  '@@stat', stat,
  '@@cpus', '4',
  '@@mem', 'MemTotal:  8000000 kB', 'MemFree:  1000000 kB', 'MemAvailable: 6000000 kB',
  '@@df', '/dev/sda1 100000000 25000000 75000000 25% /',
  '@@up', '3600.5 100.0',
  '@@host', 'testhost', 'Linux 6.1',
].join('\n');

test('liest Last, Speicher und Laufzeit', () => {
  const r = parse(sample('cpu  100 0 100 800 0 0 0 0 0 0'));
  assert.deepEqual(r.load, [0.5, 0.4, 0.3]);
  assert.equal(r.cpus, 4);
  assert.equal(r.cpu, undefined);
  assert.equal(Math.round(r.cpuApprox), 13);
  assert.deepEqual(r.cpuTicks, { idle: 800, total: 1000 });
});

test('CPU-Auslastung seit der letzten Abfrage', () => {
  const r = parse(sample('cpu  200 0 200 1400 0 0 0 0 0 0'), { idle: 800, total: 1000 });
  assert.equal(Math.round(r.cpu), 25);
});

test('leere Ausgabe führt nicht zu Fehlern', () => {
  assert.doesNotThrow(() => parse(''));
});
