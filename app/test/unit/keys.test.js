// SSH-Schlüssel erzeugen (lib/keys.js) – mit eigenem Home-Ordner, damit ~/.ssh unberührt bleibt
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 's3cure-keys-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
let keys, utils;
before(() => {
  keys = require('../../lib/keys');
  ({ utils } = require('ssh2'));
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('der Schlüssel liegt im (Test-)Home-Ordner', () => {
  assert.equal(keys.KEY_FILE, path.join(home, '.ssh', 's3cure_ed25519'));
  assert.deepEqual(keys.keyStatus(), { exists: false, path: '~/.ssh/s3cure_ed25519', publicKey: null });
});

test('erzeugt ein gültiges ed25519-Schlüsselpaar mit Passphrase', { skip: process.platform === 'win32' && 'Dateirechte nur unter macOS/Linux' }, () => {
  const st = keys.generateKey('geheim123');
  assert.equal(st.exists, true);
  assert.match(st.publicKey, /^ssh-ed25519 \S+ s3cure@/);
  const priv = fs.readFileSync(keys.KEY_FILE, 'utf8');
  assert.ok(utils.parseKey(priv) instanceof Error, 'ohne Passphrase darf der Schlüssel nicht lesbar sein');
  const parsed = utils.parseKey(priv, 'geheim123');
  assert.equal(parsed.type, 'ssh-ed25519');
  assert.equal(parsed.getPublicSSH().toString('base64'), st.publicKey.split(' ')[1]);
  assert.equal(fs.statSync(keys.KEY_FILE).mode & 0o777, 0o600);
});

test('ein vorhandener Schlüssel wird nie überschrieben', () => {
  const before = fs.readFileSync(keys.KEY_FILE, 'utf8');
  assert.throws(() => keys.generateKey(''), /nicht überschrieben/);
  assert.equal(fs.readFileSync(keys.KEY_FILE, 'utf8'), before);
});
