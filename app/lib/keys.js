// SSH-Schlüssel erzeugen (ed25519) und auf einen Server übertragen – danach Anmeldung ohne Passwort.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { utils } = require('ssh2');

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
function generateKey(passphrase) {
  if (fs.existsSync(KEY_FILE) || fs.existsSync(KEY_FILE + '.pub')) throw new Error(`${KEY_SHORT} gibt es schon – er wird nicht überschrieben.`);
  const comment = `s3cure@${os.hostname()}`;
  const opts = { comment };
  if (passphrase) Object.assign(opts, { passphrase, cipher: 'aes256-ctr', rounds: 16 });
  const pair = utils.generateKeyPairSync('ed25519', opts);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, pair.private, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(KEY_FILE + '.pub', pair.public.trim() + '\n', { mode: 0o644, flag: 'wx' });
  return keyStatus();
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
  let freshPassphrase = null; // gerade beim Erzeugen eingegeben – nur im Arbeitsspeicher
  ipcMain.handle('keys:status', () => keyStatus());

  ipcMain.handle('keys:generate', (_e, passphrase, remember) => {
    const st = generateKey(passphrase || '');
    freshPassphrase = passphrase || null;
    if (passphrase && remember) passphrases.write(path.resolve(KEY_FILE), passphrase);
    return st;
  });

  // Mit der Verbindung anmelden (wie gewohnt, ggf. Passwort), Schlüssel eintragen,
  // dann mit nur dem Schlüssel testen und ihn in der Verbindung hinterlegen
  ipcMain.handle('keys:install', async (_e, name) => {
    const st = keyStatus();
    if (!st.exists || !st.publicKey) throw new Error('Es gibt noch keinen Schlüssel. Bitte zuerst erzeugen.');
    const hosts = loadHosts();
    const target = hosts[name];
    if (!target) throw new Error(`Keine Verbindung namens „${name}“ gespeichert.`);
    const cache = { passwords: new Map(), passphrases: new Map() };
    if (freshPassphrase) cache.passphrases.set(path.resolve(KEY_FILE), freshPassphrase);
    const client = await connection.connectTo(target, name, cache);
    let result;
    try { result = await installKey(client, st.publicKey); }
    catch (err) { throw new Error('Schlüssel konnte nicht übertragen werden: ' + (err.message || err)); }
    finally { client.end(); }

    let tested = false;
    let testError = null;
    try {
      const test = await connection.connectTo({ ...target, key: KEY_SHORT }, name, cache, { keyOnly: true });
      test.end();
      tested = true;
    } catch (err) { testError = err.message; }
    if (tested) {
      const fresh = loadHosts();
      if (fresh[name]) { fresh[name].key = KEY_SHORT; saveHosts(fresh); }
    }
    return { ...result, tested, testError, key: KEY_SHORT };
  });
}

module.exports = { register, keyStatus, generateKey, installKey, KEY_FILE };
