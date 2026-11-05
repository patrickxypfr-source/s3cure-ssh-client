// Lokales Terminal: die Shell des eigenen Computers in einem Tab (node-pty).
// Läuft über dieselben Kanäle wie eine SSH-Sitzung ('ssh:data', 'ssh:closed'),
// damit Terminal, Suche, Trennlinien usw. ohne Sonderweg funktionieren.
const os = require('os');
const fs = require('fs');
const path = require('path');

// Welche Shell starten? Mac/Linux: die Shell des Benutzers als Login-Shell (lädt PATH aus dem Profil,
// wichtig wenn die App aus dem Finder/Dock gestartet wird). Windows: PowerShell.
function pickShell({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform === 'win32') {
    const root = env.SystemRoot || 'C:\\Windows';
    const ps = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(ps)) return { file: ps, args: ['-NoLogo'] };
    return { file: env.COMSPEC || 'cmd.exe', args: [] };
  }
  const candidates = [env.SHELL, platform === 'darwin' ? '/bin/zsh' : '/bin/bash', '/bin/bash', '/bin/sh'];
  const file = candidates.find(f => f && path.isAbsolute(f) && exists(f)) || '/bin/sh';
  return { file, args: ['-l'] };
}

// Umgebung für die Shell: ohne Electron-Variablen, mit Farben und UTF-8
function shellEnv({ platform = process.platform, env = process.env, lang = 'en' } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null || /^(ELECTRON_|CHROME_|S3CURE_)/.test(k) || k === 'NODE_OPTIONS') continue;
    out[k] = String(v);
  }
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  out.TERM_PROGRAM = 'S3cure';
  if (platform !== 'win32' && !out.LANG && !out.LC_ALL) out.LANG = lang === 'de' ? 'de_DE.UTF-8' : 'en_US.UTF-8';
  return out;
}

function createLocalTerm({ send, platform = process.platform, lang = () => 'en', loadPty = () => require('node-pty') }) {
  const terms = new Map(); // Tab-ID -> pty
  let pty = null;

  // Notlösung, falls „spawn-helper“ ohne Ausführrecht ankommt (Entwicklung; der Build setzt es, tools/pty-prepare.mjs)
  function fixHelper() {
    if (platform === 'win32') return;
    try {
      const dir = path.dirname(require.resolve('node-pty/package.json'));
      for (const sub of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
        const helper = path.join(dir, sub, 'spawn-helper');
        if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755);
      }
    } catch {}
  }

  function open(tabId, cols, rows) {
    close(tabId);
    if (!pty) { fixHelper(); pty = loadPty(); } // Fehler hier landen als Meldung im Tab
    const shell = pickShell({ platform });
    const p = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color', cols: Math.max(2, cols | 0) || 80, rows: Math.max(2, rows | 0) || 24,
      cwd: os.homedir(), env: shellEnv({ platform, lang: lang() }),
      useConpty: platform === 'win32' ? true : undefined,
    });
    terms.set(tabId, p);
    p.onData(d => send('ssh:data', tabId, d));
    p.onExit(() => {
      if (terms.get(tabId) !== p) return; // inzwischen ersetzt oder geschlossen
      terms.delete(tabId);
      send('ssh:closed', tabId);
    });
    let user = 'user';
    try { user = os.userInfo().username; } catch {}
    return { user, host: os.hostname().split('.')[0], local: true, shell: path.basename(shell.file) };
  }

  function write(tabId, data) {
    const p = terms.get(tabId);
    if (!p) return false;
    p.write(data);
    return true;
  }

  function resize(tabId, cols, rows) {
    const p = terms.get(tabId);
    if (!p) return false;
    try { p.resize(Math.max(2, cols | 0), Math.max(2, rows | 0)); } catch {}
    return true;
  }

  function close(tabId) {
    const p = terms.get(tabId);
    if (!p) return;
    terms.delete(tabId); // vorher entfernen: kein 'ssh:closed' für absichtlich geschlossene Tabs
    try { p.kill(); } catch {}
  }

  const closeAll = () => { for (const id of [...terms.keys()]) close(id); };

  return { open, write, resize, close, closeAll, has: id => terms.has(id), ids: () => [...terms.keys()] };
}

module.exports = { createLocalTerm, pickShell, shellEnv };
