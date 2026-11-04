// Gruppe, Farbe, Sprung-Server gespeicherter Verbindungen (lib/hosts-extra.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hostExtras, updateJumpRefs } = require('../../lib/hosts-extra');

test('hostExtras übernimmt nur gültige Felder', () => {
  assert.deepEqual(hostExtras({}), {});
  assert.deepEqual(hostExtras({ group: '  Kunden ', color: 'red', jump: ' bastion ' }), { group: 'Kunden', color: 'red', jump: 'bastion' });
  assert.deepEqual(hostExtras({ color: 'lila', group: '   ' }), {});
  assert.equal(hostExtras({ group: 'x'.repeat(100) }).group.length, 60);
});

test('updateJumpRefs benennt Sprung-Server mit um', () => {
  const hosts = { a: { jump: 'alt' }, b: { jump: 'x, alt ,y' }, c: { jump: 'anders' }, d: {} };
  updateJumpRefs(hosts, 'alt', 'neu');
  assert.equal(hosts.a.jump, 'neu');
  assert.equal(hosts.b.jump, 'x,neu,y');
  assert.equal(hosts.c.jump, 'anders');
  assert.equal(hosts.d.jump, undefined);
});

test('updateJumpRefs entfernt gelöschte Sprung-Server', () => {
  const hosts = { a: { jump: 'weg' }, b: { jump: 'weg,bleibt' } };
  updateJumpRefs(hosts, 'weg', '');
  assert.equal('jump' in hosts.a, false);
  assert.equal(hosts.b.jump, 'bleibt');
});
