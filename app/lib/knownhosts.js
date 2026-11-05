// Bekannte Server (Host-Schlüssel): Prüfen beim Verbinden, Liste für „Bekannte Server verwalten“,
// einzelne Einträge entfernen und bei geändertem Schlüssel nachfragen.
// Gelesen werden ~/.myssh/known_hosts (S3cure, änderbar) und ~/.ssh/known_hosts (OpenSSH, nur lesen).
// Format wie bei OpenSSH: „host[,host2] typ base64 [kommentar]“, gehashte Namen „|1|salz|hash“.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { t } = require('./i18n');

function knownName(host, port) {
  return Number(port) === 22 ? host : `[${host}]:${port}`;
}

function keyType(rawKey) {
  const len = rawKey.readUInt32BE(0);
  return rawKey.slice(4, 4 + len).toString();
}

function fingerprint(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'base64');
  return 'SHA256:' + crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

function hostMatches(pattern, name) {
  if (pattern.startsWith('|1|')) { // gehashte Einträge
    const [, , salt, hash] = pattern.split('|');
    try {
      return crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64') === hash;
    } catch { return false; }
  }
  return pattern.split(',').includes(name);
}

// Eine Zeile zerlegen; null bei Kommentaren, Leerzeilen und @cert-authority/@revoked
function parseLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3 || parts[0].startsWith('#') || parts[0].startsWith('@')) return null;
  return { pattern: parts[0], type: parts[1], b64: parts[2], comment: parts.slice(3).join(' ') };
}

// „[host]:2222,host2“ -> lesbar „host:2222, host2“
function displayHosts(pattern) {
  if (pattern.startsWith('|1|')) return null;
  return pattern.split(',').map(p => {
    const m = /^\[(.+)\]:(\d+)$/.exec(p);
    return m ? `${m[1]}:${m[2]}` : p;
  }).join(', ');
}

function createKnownHosts({ configDir, ask, systemFile = path.join(os.homedir(), '.ssh', 'known_hosts') }) {
  const ownFile = path.join(configDir, 'known_hosts');
  const files = [
    { file: systemFile, source: 'system', label: '~/.ssh/known_hosts', writable: false },
    { file: ownFile, source: 's3cure', label: '~/.myssh/known_hosts', writable: true },
  ];

  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

  function keysFor(name) {
    const result = [];
    for (const f of files) {
      const text = read(f.file);
      if (text == null) continue;
      for (const line of text.split('\n')) {
        const e = parseLine(line);
        if (e && hostMatches(e.pattern, name)) result.push({ ...e, source: f.source, label: f.label });
      }
    }
    return result;
  }

  function writeOwn(lines) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tmp = ownFile + '.tmp';
    fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
    fs.renameSync(tmp, ownFile);
  }

  // Neuen Schlüssel eintragen; alte Einträge desselben Typs für diesen Namen (nur in der eigenen Datei) ersetzen
  function store(name, type, b64) {
    const text = read(ownFile) || '';
    const lines = text.split('\n').filter(line => {
      const e = parseLine(line);
      return !(e && e.type === type && hostMatches(e.pattern, name) && e.pattern.split(',').length === 1);
    });
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${name} ${type} ${b64}`, '');
    writeOwn(lines);
  }

  async function verifyHostKey(target, rawKey) {
    const name = knownName(target.host, target.port);
    const type = keyType(rawKey);
    const b64 = rawKey.toString('base64');
    const sameType = keysFor(name).filter(k => k.type === type);
    const fp = fingerprint(rawKey);

    if (sameType.some(k => k.b64 === b64)) return { ok: true };

    if (sameType.length) {
      const old = sameType[0];
      const accept = await ask({
        kind: 'confirm',
        title: t('knownHosts.changedTitle'),
        message: t('knownHosts.changedMsg', { name }),
        detail: t('knownHosts.changedDetail', { label: old.label, oldType: old.type, oldFingerprint: fingerprint(old.b64), type, fingerprint: fp }),
        okLabel: t('knownHosts.acceptNew'),
        danger: true,
        focusCancel: true,
      });
      if (!accept) return { ok: false, error: t('knownHosts.changedAbort', { name }) };
      store(name, type, b64);
      return { ok: true };
    }

    const trust = await ask({
      kind: 'confirm',
      title: t('knownHosts.unknownTitle'),
      message: t('knownHosts.unknownMsg', { name }),
      detail: t('knownHosts.unknownDetail', { type, fingerprint: fp }),
      okLabel: t('knownHosts.trust'),
    });
    if (!trust) return { ok: false, error: t('knownHosts.untrustedAbort') };
    store(name, type, b64);
    return { ok: true };
  }

  // Alle Einträge für die Verwaltung
  function list() {
    const out = [];
    for (const f of files) {
      const text = read(f.file);
      if (text == null) continue;
      text.split('\n').forEach((line, index) => {
        const e = parseLine(line);
        if (!e) return;
        out.push({
          id: `${f.source}:${index}`,
          source: f.source, file: f.label, writable: f.writable, line: index,
          hosts: displayHosts(e.pattern), hashed: e.pattern.startsWith('|1|'),
          type: e.type, fingerprint: fingerprint(e.b64), b64: e.b64,
        });
      });
    }
    return out;
  }

  // Suche auch in gehashten Einträgen: passt der gesuchte Name (ggf. mit Port) zum Hash?
  function matchHashed(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const m = /^(.+):(\d+)$/.exec(q);
    const names = m ? [knownName(m[1], m[2])] : [q];
    const ids = [];
    for (const e of list()) {
      if (!e.hashed) continue;
      const pattern = readPattern(e);
      if (pattern && names.some(n => hostMatches(pattern, n))) ids.push(e.id);
    }
    return ids;
  }

  function readPattern(entry) {
    const f = files.find(x => x.source === entry.source);
    const line = (read(f.file) || '').split('\n')[entry.line];
    const e = line && parseLine(line);
    return e ? e.pattern : null;
  }

  // Einen Eintrag aus ~/.myssh/known_hosts entfernen. b64 schützt davor, dass sich die Datei inzwischen geändert hat.
  function remove(id, b64) {
    const [source, idx] = String(id).split(':');
    if (source !== 's3cure') throw new Error(t('knownHosts.readOnly'));
    const lines = (read(ownFile) || '').split('\n');
    const i = Number(idx);
    const e = parseLine(lines[i] || '');
    if (!e || e.b64 !== b64) throw new Error(t('knownHosts.stale'));
    lines.splice(i, 1);
    writeOwn(lines);
    return list();
  }

  function register(ipcMain) {
    ipcMain.handle('knownhosts:list', () => list().map(({ b64, ...e }) => ({ ...e, key: b64 })));
    ipcMain.handle('knownhosts:match', (_e, query) => matchHashed(query));
    ipcMain.handle('knownhosts:remove', (_e, id, key) => remove(id, key).map(({ b64, ...e }) => ({ ...e, key: b64 })));
  }

  return { verifyHostKey, list, remove, keysFor, matchHashed, register, ownFile };
}

module.exports = { createKnownHosts, knownName, keyType, fingerprint, hostMatches, parseLine };
