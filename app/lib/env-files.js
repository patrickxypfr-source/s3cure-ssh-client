// .env-Dateien auf dem Server: finden, lesen, speichern (mit Backup), Backups auflisten und zurückholen.
// Alles über eigene exec-Kanäle der Verbindung. Backups liegen in ~/.s3cure/env-backups auf dem Server
// (nicht im Projektordner – sonst landen sie womöglich in Git). Oberfläche: src/env-manager.js
const { t } = require('./i18n');
const { exec, sq } = require('./dashboard');

const MAX_SIZE = 256 * 1024;
const BACKUP_DIR = '"$HOME/.s3cure/env-backups"';
const NAME_RE = /^\.env($|[.-][\w.-]*$)/;       // .env, .env.local, .env.production … (nicht .envrc)
const BACKUP_RE = /\.(bak|backup|orig|swp)$|\.bak-\d/;  // fremde Sicherungskopien nicht anzeigen

// Pfad -> Name der Backup-Datei (ohne Schrägstriche)
const backupKey = file => String(file).replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]/g, '_');
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function checkPath(file) {
  const f = String(file || '');
  if (!f.startsWith('/') || f.includes('\n') || f.includes('\0') || f.length > 1024) throw new Error(t('env.badPath'));
  return f;
}

// Änderungszeit in Sekunden – GNU (Linux) und BSD (macOS)
const MTIME = f => `$(stat -c %Y -- ${f} 2>/dev/null || stat -f %m -- ${f})`;

// Ausgabe von find (ein Pfad pro Zeile; ältere Form mit Tabs wird auch gelesen) -> Liste
function parseFind(out) {
  const list = [];
  for (const line of String(out).split('\n')) {
    const [p, size, mtime] = line.split('\t');
    if (!p || !p.startsWith('/')) continue;
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (!NAME_RE.test(name) || BACKUP_RE.test(name)) continue;
    list.push({ path: p, name, dir: p.slice(0, p.lastIndexOf('/')) || '/', size: Number(size) || 0, mtime: Math.floor(Number(mtime) || 0) });
  }
  return list.sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));
}

// Shell-Befehl: .env-Dateien in den üblichen Ordnern suchen (ein Pfad pro Zeile; Linux und macOS/BSD)
function findCmd() {
  const roots = '"$HOME" /opt /srv /var/www /home /root';
  return `for d in ${roots}; do [ -d "$d" ] && echo "$d"; done | sort -u | while IFS= read -r d; do find "$d" -maxdepth 5 `
    + `\\( -name node_modules -o -name .git -o -name .cache -o -name .npm -o -name vendor -o -name .s3cure -o -name venv -o -name .venv -o -name Library \\) -prune -o `
    + `-type f -name '.env*' -size -${MAX_SIZE / 1024}k -print 2>/dev/null; done | head -n 300`;
}

function register(ipcMain, sessions) {
  const client = tabId => {
    const s = sessions.get(tabId);
    if (!s || !s.client) throw new Error(t('dashboard.notConnected'));
    return s.client;
  };
  const fail = r => new Error((r.err || r.out || '').trim().split('\n').slice(-3).join('\n') || t('env.failed'));

  ipcMain.handle('env:find', async (_e, tabId) => {
    const cmd = findCmd();
    const r = await exec(client(tabId), `echo "$HOME"; ${cmd}`, { timeout: 30000 });
    const home = r.out.split('\n')[0].trim().replace(/\/+$/, '');
    const seen = new Set();
    // Anzeige: Ordner im Home-Verzeichnis als ~/…
    return parseFind(r.out).filter(f => !seen.has(f.path) && seen.add(f.path))
      .map(f => ({ ...f, label: home && home !== '/' && (f.dir === home || f.dir.startsWith(home + '/')) ? '~' + f.dir.slice(home.length) : f.dir }));
  });

  ipcMain.handle('env:read', async (_e, tabId, file) => {
    const f = checkPath(file);
    const r = await exec(client(tabId), `[ -f ${sq(f)} ] || { echo missing >&2; exit 2; }; echo ${MTIME(sq(f))}; base64 < ${sq(f)} | tr -d '\\n'`);
    if (r.code !== 0) throw fail(r);
    const [mtime, b64 = ''] = r.out.split('\n');
    const buf = Buffer.from(b64.trim(), 'base64');
    if (buf.length > MAX_SIZE) throw new Error(t('env.tooLarge'));
    return { path: f, text: buf.toString('utf8'), mtime: Number(mtime) || 0 };
  });

  // Speichern: nur wenn die Datei seit dem Lesen nicht geändert wurde; vorher Backup, Rechte/Besitzer behalten
  ipcMain.handle('env:write', async (_e, tabId, file, text, expectMtime) => {
    const f = checkPath(file);
    const data = Buffer.from(String(text), 'utf8');
    if (data.length > MAX_SIZE) throw new Error(t('env.tooLarge'));
    const backup = `${BACKUP_DIR}/${backupKey(f)}.${stamp()}`;
    const cmd = [
      `f=${sq(f)}`,
      `[ "${MTIME('"$f"')}" = ${sq(String(Number(expectMtime) || 0))} ] || { echo @@changed; exit 3; }`,
      `mkdir -p ${BACKUP_DIR} && chmod 700 "$HOME/.s3cure" ${BACKUP_DIR}`,
      `cp -p -- "$f" ${backup}`,
      // erst vollständig in eine Hilfsdatei (im geschützten Backup-Ordner), dann in die bestehende Datei
      // schreiben – so bleiben Rechte und Besitzer der .env erhalten
      `echo ${data.toString('base64')} | base64 -d > ${BACKUP_DIR}/.next`,
      `cat -- ${BACKUP_DIR}/.next > "$f"`,
      `echo ${MTIME('"$f"')}`,
    ].join(' && ');
    const r = await exec(client(tabId), cmd);
    if (r.out.includes('@@changed')) throw new Error(t('env.changed'));
    if (r.code !== 0) throw fail(r);
    return { mtime: Number(r.out.trim().split('\n').pop()) || 0 };
  });

  ipcMain.handle('env:backups', async (_e, tabId, file) => {
    const key = backupKey(checkPath(file));
    const r = await exec(client(tabId), `ls -1 ${BACKUP_DIR} 2>/dev/null | grep -F ${sq(key + '.')} | sort -r | head -n 50`);
    return r.out.split('\n').map(s => s.trim()).filter(n => n.startsWith(key + '.') && /\.\d{8}-\d{6}$/.test(n))
      .map(n => { const m = /\.(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(n); return { name: n, at: Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) }; });
  });

  // Backup zurückholen: aktueller Stand wird vorher selbst gesichert
  ipcMain.handle('env:restore', async (_e, tabId, file, name) => {
    const f = checkPath(file);
    const n = String(name || '');
    if (!n.startsWith(backupKey(f) + '.') || n.includes('/')) throw new Error(t('env.badPath'));
    const cmd = [
      `f=${sq(f)}`, `b=${BACKUP_DIR}/${sq(n)}`, '[ -f "$b" ]',
      `cp -p -- "$f" ${BACKUP_DIR}/${backupKey(f)}.${stamp()}`,
      'cat -- "$b" > "$f"', `echo ${MTIME('"$f"')}`,
    ].join(' && ');
    const r = await exec(client(tabId), cmd);
    if (r.code !== 0) throw fail(r);
    return { mtime: Number(r.out.trim()) || 0 };
  });
}

module.exports = { register, findCmd, parseFind, backupKey, stamp };
