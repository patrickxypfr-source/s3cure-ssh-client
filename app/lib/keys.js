// SSH-Schlüssel erzeugen (ed25519) und auf einen Server übertragen – danach Anmeldung ohne Passwort.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { utils } = require('ssh2');
const { t } = require('./i18n');

const KEY_FILE = path.join(os.homedir(), '.ssh', 's3cure_ed25519');
const KEY_SHORT = '~/.ssh/s3cure_ed25519';
const posix = path.posix;
const p = fn => new Promise((res, rej) => fn((e, r) => (e ? rej(e) : res(r))));

function keyStatus() {
  const exists = fs.existsSync(KEY_FILE);
  let publicKey = null;
  try { publicKey = fs.readFileSync(KEY_FILE + '.pub', 'utf8').trim(); } catch {}
  return { exists, path: KEY_SHORT, publicKey };
}

// Erzeugt den Schlüssel nur, wenn es ihn noch nicht gibt – nie überschreiben
function generateKey(passphrase, file = KEY_FILE) {
  const shortName = file === KEY_FILE ? KEY_SHORT : '~/.ssh/' + path.basename(file);
  if (fs.existsSync(file) || fs.existsSync(file + '.pub')) throw new Error(t('keys.exists', { name: shortName }));
  const comment = `s3cure@${os.hostname()}`;
  const opts = { comment };
  if (passphrase) Object.assign(opts, { passphrase, cipher: 'aes256-ctr', rounds: 16 });
  const pair = utils.generateKeyPairSync('ed25519', opts);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, pair.private, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(file + '.pub', pair.public.trim() + '\n', { mode: 0o644, flag: 'wx' });
  return file === KEY_FILE ? keyStatus() : { exists: true, path: shortName, publicKey: pair.public.trim() };
}

// Dateiname für einen weiteren Schlüssel (Schlüssel verwalten): ~/.ssh/s3cure_<name>
function namedKeyFile(name) {
  const clean = String(name || '').trim();
  if (!clean) return KEY_FILE;
  if (!/^[\w.-]{1,40}$/.test(clean) || clean.startsWith('.')) throw new Error(t('keys.badName'));
  return path.join(path.dirname(KEY_FILE), clean.startsWith('s3cure_') ? clean : 's3cure_' + clean);
}

// Public Key an ~/.ssh/authorized_keys anhängen, wenn er noch nicht drinsteht (per SFTP, ohne Shell-Befehle)
async function installKey(client, publicKey) {
  const sftp = await p(cb => client.sftp(cb));
  try {
    const home = await p(cb => sftp.realpath('.', cb));
    const dir = posix.join(home, '.ssh');
    const file = posix.join(dir, 'authorized_keys');
    try { await p(cb => sftp.mkdir(dir, { mode: 0o700 }, cb)); } catch { /* gibt es schon */ }
    await p(cb => sftp.chmod(dir, 0o700, cb));
    let current = '';
    try { current = (await p(cb => sftp.readFile(file, cb))).toString('utf8'); } catch { /* Datei fehlt noch */ }
    const blob = publicKey.split(/\s+/)[1];
    const already = current.split(/\r?\n/).some(l => l.trim().split(/\s+/).includes(blob));
    if (!already) {
      const prefix = current && !current.endsWith('\n') ? '\n' : '';
      await p(cb => sftp.appendFile(file, prefix + publicKey + '\n', { mode: 0o600 }, cb));
    }
    await p(cb => sftp.chmod(file, 0o600, cb));
    return { already };
  } finally {
    sftp.end();
  }
}

function register(ipcMain, { connection, loadHosts, saveHosts, passphrases }) {
  const fresh = new Map(); // gerade beim Erzeugen eingegebene Passphrasen – nur im Arbeitsspeicher
  ipcMain.handle('keys:status', () => keyStatus());

  function generateNamed(name, passphrase, remember) {
    const file = namedKeyFile(name);
    const st = generateKey(passphrase || '', file);
    if (passphrase) fresh.set(path.resolve(file), passphrase);
    if (passphrase && remember) passphrases.write(path.resolve(file), passphrase);
    return st;
  }
  ipcMain.handle('keys:generate', (_e, passphrase, remember) => generateNamed('', passphrase, remember));

  // Mit der Verbindung anmelden (wie gewohnt, ggf. Passwort), Schlüssel eintragen,
  // dann mit nur dem Schlüssel testen und ihn in der Verbindung hinterlegen
  async function installFile(keyFile, publicKey, name) {
    const keyShort = keyFile.startsWith(os.homedir()) ? '~' + keyFile.slice(os.homedir().length) : keyFile;
    const hosts = loadHosts();
    const target = hosts[name];
    if (!target) throw new Error(t('keys.noHost', { name }));
    const cache = { passwords: new Map(), passphrases: new Map() };
    const id = path.resolve(keyFile);
    if (fresh.has(id)) cache.passphrases.set(id, fresh.get(id));
    const client = await connection.connectTo(target, name, cache);
    let result;
    try { result = await installKey(client, publicKey); }
    catch (err) { throw new Error(t('keys.installFailed', { error: err.message || err })); }
    finally { client.end(); }

    let tested = false;
    let testError = null;
    if (fs.existsSync(keyFile)) {
      try {
        const test = await connection.connectTo({ ...target, key: keyShort }, name, cache, { keyOnly: true });
        test.end();
        tested = true;
      } catch (err) { testError = err.message; }
    } else testError = t('keys.noPrivate');
    if (tested) {
      const now = loadHosts();
      if (now[name]) { now[name].key = keyShort; saveHosts(now); }
    }
    return { ...result, tested, testError, key: keyShort };
  }

  ipcMain.handle('keys:install', async (_e, name) => {
    const st = keyStatus();
    if (!st.exists || !st.publicKey) throw new Error(t('keys.noKey'));
    return installFile(KEY_FILE, st.publicKey, name);
  });

  return { generateNamed, installFile };
}

module.exports = { register, keyStatus, generateKey, installKey, KEY_FILE };
