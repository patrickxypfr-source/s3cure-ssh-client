// „Schlüssel verwalten“: SSH-Schlüssel in ~/.ssh auflisten (nur Paare mit passender .pub-Datei),
// öffentlichen Schlüssel kopieren, im Finder/Explorer zeigen, neuen Schlüssel erzeugen und
// auf einen Server übertragen (Logik aus keys.js). Private Schlüssel verlassen nie den Hauptprozess –
// es wird nur gelesen, ob sie mit einer Passphrase geschützt sind.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { utils } = require('ssh2');
const { t } = require('./i18n');

const MAX_FILES = 200;
const MAX_KEY_BYTES = 64 * 1024;

const sshDir = () => path.join(os.homedir(), '.ssh');
const short = file => file.startsWith(os.homedir()) ? '~' + file.slice(os.homedir().length) : file;

// Werte: fester Name oder Funktion (übersetzt, erst beim Gebrauch aufrufen)
const TYPE_NAMES = {
  'ssh-ed25519': 'Ed25519', 'ssh-rsa': 'RSA', 'ecdsa-sha2-nistp256': 'ECDSA 256',
  'ecdsa-sha2-nistp384': 'ECDSA 384', 'ecdsa-sha2-nistp521': 'ECDSA 521',
  'sk-ssh-ed25519@openssh.com': () => t('keyring.typeSkEd25519'), 'sk-ecdsa-sha2-nistp256@openssh.com': () => t('keyring.typeSkEcdsa'),
  'ssh-dss': () => t('keyring.typeDsa'),
};

const typeName = type => {
  const n = Object.prototype.hasOwnProperty.call(TYPE_NAMES, type) ? TYPE_NAMES[type] : type;
  return typeof n === 'function' ? n() : n;
};

// Öffentlichen Schlüssel lesen: Typ, Fingerprint, Kommentar
function parsePublic(text) {
  const line = text.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'));
  if (!line) return null;
  const parts = line.split(/\s+/);
  const idx = parts.findIndex(p => /^(ssh-|ecdsa-|sk-)/.test(p)); // Optionen vorne (authorized_keys-Stil) überspringen
  if (idx < 0 || !parts[idx + 1]) return null;
  let blob;
  try { blob = Buffer.from(parts[idx + 1], 'base64'); } catch { return null; }
  if (blob.length < 20) return null;
  const type = parts[idx];
  let bits = null;
  if (type === 'ssh-rsa') {
    try { // Blob: string typ, mpint e, mpint n
      let off = 0;
      const rd = () => { const n = blob.readUInt32BE(off); off += 4; const b = blob.subarray(off, off + n); off += n; return b; };
      rd(); rd(); const n = rd();
      bits = (n[0] === 0 ? n.length - 1 : n.length) * 8;
    } catch {}
  }
  return {
    type, typeName: typeName(type) + (bits ? ` ${bits}` : ''),
    fingerprint: 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''),
    comment: parts.slice(idx + 2).join(' '),
    publicKey: `${type} ${parts[idx + 1]}${parts[idx + 2] ? ' ' + parts.slice(idx + 2).join(' ') : ''}`,
  };
}

// Ist der private Schlüssel mit einer Passphrase geschützt? true/false, null = unbekannt/fehlt
function privateState(file) {
  let data;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_KEY_BYTES) return { exists: st.isFile(), passphrase: null };
    data = fs.readFileSync(file);
  } catch { return { exists: false, passphrase: null }; }
  const k = utils.parseKey(data);
  if (k instanceof Error) return { exists: true, passphrase: /passphrase|encrypted/i.test(k.message) ? true : null };
  return { exists: true, passphrase: false };
}

function listKeys(extraFiles = []) {
  const dir = sshDir();
  let names = [];
  try { names = fs.readdirSync(dir).slice(0, MAX_FILES * 2); } catch {}
  const pubs = new Set(names.filter(n => n.endsWith('.pub')).map(n => path.join(dir, n)));
  for (const f of extraFiles) if (f && fs.existsSync(f + '.pub')) pubs.add(f + '.pub');
  const keys = [];
  for (const pubFile of [...pubs].slice(0, MAX_FILES)) {
    let text;
    try {
      if (fs.statSync(pubFile).size > MAX_KEY_BYTES) continue;
      text = fs.readFileSync(pubFile, 'utf8');
    } catch { continue; }
    const info = parsePublic(text);
    if (!info) continue;
    const file = pubFile.slice(0, -4);
    const priv = privateState(file);
    keys.push({
      file: short(file), name: path.basename(file), ...info,
      hasPrivate: priv.exists, passphrase: priv.passphrase,
      s3cure: path.basename(file).startsWith('s3cure_'),
    });
  }
  keys.sort((a, b) => (b.s3cure - a.s3cure) || a.name.localeCompare(b.name));
  return keys;
}

// Nur Dateien aus der aktuellen Liste zulassen (keine beliebigen Pfade aus der Oberfläche)
function findKey(file, extraFiles) {
  const k = listKeys(extraFiles).find(x => x.file === file);
  if (!k) throw new Error(t('keyring.gone'));
  return k;
}

function register(ipcMain, { clipboard, shell, keys, extraFiles = () => [] }) {
  const expand = f => (f.startsWith('~') ? path.join(os.homedir(), f.slice(1)) : f);
  ipcMain.handle('keyring:list', () => listKeys(extraFiles()));
  ipcMain.handle('keyring:copy', (_e, file) => {
    const k = findKey(file, extraFiles());
    clipboard.writeText(k.publicKey + '\n');
    return true;
  });
  ipcMain.handle('keyring:show', (_e, file) => {
    const k = findKey(file, extraFiles());
    shell.showItemInFolder(expand(k.file + '.pub'));
    return true;
  });
  ipcMain.handle('keyring:generate', (_e, name, passphrase, remember) => keys.generateNamed(name, passphrase, remember));
  ipcMain.handle('keyring:install', (_e, file, hostName) => {
    const k = findKey(file, extraFiles());
    return keys.installFile(expand(k.file), k.publicKey, hostName);
  });
}

module.exports = { register, listKeys, parsePublic, privateState };
