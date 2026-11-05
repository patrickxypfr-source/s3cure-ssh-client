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

test('Download-Adressen: eigenes Repo, nach Umbenennung des Kontos auch das neue – fremde nie', () => {
  const { assetAllowed } = require('../../lib/update-check');
  const repo = 'alt/s3cure-ssh-client';
  const dl = o => `https://github.com/${o}/releases/download/v2.0.0/S3cure.dmg`;
  assert.ok(assetAllowed(dl('alt/s3cure-ssh-client'), repo, ''));
  assert.ok(assetAllowed(dl('neu/s3cure-ssh-client'), repo, 'https://github.com/neu/s3cure-ssh-client/releases/tag/v2.0.0'));
  assert.ok(!assetAllowed(dl('neu/s3cure-ssh-client'), repo, ''));
  assert.ok(!assetAllowed(dl('neu/anderes-repo'), repo, 'https://github.com/neu/anderes-repo/releases/tag/v2.0.0'));
  assert.ok(!assetAllowed('https://evil.example/alt/s3cure-ssh-client/releases/download/x', repo, ''));
  assert.ok(!assetAllowed(dl('neu/s3cure-ssh-client'), repo, 'https://evil.example/neu/s3cure-ssh-client/releases/tag/v2'));
});

