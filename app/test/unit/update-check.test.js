// Versionsvergleich für den Update-Hinweis (lib/update-check.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isNewer, parseVersion } = require('../../lib/update-check');

test('parseVersion liest x.y.z, mit und ohne „v“', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('v10.0.12'), [10, 0, 12]);
  assert.deepEqual(parseVersion(' 2.5 '), [2, 5, 0]);
});

test('parseVersion lehnt Vorabversionen und Unsinn ab', () => {
  for (const v of ['1.3.0-beta', '1', 'abc', '', null, undefined, '1.2.3.4', 'v']) {
    assert.equal(parseVersion(v), null, String(v));
  }
});

test('isNewer vergleicht Zahl für Zahl (nicht als Text)', () => {
  assert.equal(isNewer('1.2.10', '1.2.9'), true);
  assert.equal(isNewer('v2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.1.1', '1.1.0'), true);
  assert.equal(isNewer('1.1.0', '1.1.0'), false);
  assert.equal(isNewer('1.0.9', '1.1.0'), false);
  assert.equal(isNewer('1.2', '1.2.0'), false);
});

test('isNewer ist bei unbekannten Versionen vorsichtig', () => {
  assert.equal(isNewer('2.0.0-beta', '1.0.0'), false);
  assert.equal(isNewer('2.0.0', 'kaputt'), false);
  assert.equal(isNewer(null, '1.0.0'), false);
});
