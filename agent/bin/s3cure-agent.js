#!/usr/bin/env node
// S3cure Agent – Befehle auf dem Server (als root):
//   s3cure-agent serve                       Agent starten (macht normalerweise systemd)
//   s3cure-agent user add <name> [--admin]   Benutzer anlegen (fragt Passwort, zeigt 2FA-QR-Code)
//   s3cure-agent user list | remove <name> | passwd <name> | reset-2fa <name>
//   s3cure-agent peer add <name> <url> <token> | peer remove <name> | peer list
//   s3cure-agent token                       Schlüssel, mit dem ein anderer Agent diesen Server einbindet
//   s3cure-agent set <name|publicUrl|language|port> <wert>
//   s3cure-agent info
const readline = require('readline');
const config = require('../lib/config');

const args = process.argv.slice(2);
const [cmd, sub, ...rest] = args;
const flag = f => args.includes(f);
const positional = rest.filter(a => !a.startsWith('--'));

function die(msg) { console.error('✕ ' + msg); process.exit(1); }

// Passwort verdeckt abfragen
function askHidden(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = s => write(s.startsWith(prompt) ? s : s.replace(/[^\r\n]/g, ''));
    rl.question(prompt, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function readPassword() {
  if (flag('--password-stdin')) {
    let s = '';
    for await (const c of process.stdin) s += c;
    return s.replace(/\r?\n$/, '');
  }
  const a = await askHidden('Passwort (mind. 10 Zeichen): ');
  const b = await askHidden('Passwort wiederholen: ');
  if (a !== b) die('Die Passwörter sind verschieden.');
  return a;
}

async function showQr(info) {
  console.log('\nZwei-Faktor-Anmeldung einrichten: Scanne den QR-Code mit deiner Authenticator-App');
  console.log('(iPhone: Kamera öffnen oder Einstellungen → Passwörter, Google Authenticator, 1Password …)\n');
  try { console.log(await require('qrcode').toString(info.uri, { type: 'terminal', small: true })); } catch {}
  console.log('Kein QR-Scanner? Diesen Schlüssel von Hand eintragen:\n  ' + info.secret.replace(/(.{4})/g, '$1 ').trim() + '\n');
}

async function main() {
  const { createAuth } = require('../lib/auth');
  if (cmd === 'serve') {
    const { createAgent } = require('../lib/server');
    const agent = createAgent();
    const srv = await agent.listen();
    const cfg = config.load();
    console.log(`S3cure Agent läuft auf http://${cfg.bind}:${cfg.port}${process.env.S3CURE_AGENT_DEMO ? ' (Demo-Daten)' : ''}`);
    if (!agent.auth.hasUsers()) console.log('Noch kein Benutzer – anlegen mit: s3cure-agent user add <name> --admin');
    process.on('SIGHUP', () => { agent.reloadConfig(); console.log('Konfiguration neu geladen'); });
    const bye = () => { agent.stop(); srv.close(); process.exit(0); };
    process.on('SIGTERM', bye); process.on('SIGINT', bye);
    return;
  }
  if (cmd === 'user') {
    const auth = createAuth();
    if (sub === 'add') {
      const name = positional[0] || die('Name fehlt: s3cure-agent user add <name> [--admin]');
      const info = await auth.addUser(name, await readPassword(), flag('--admin') ? 'admin' : 'viewer');
      console.log(`✓ Benutzer „${info.name}“ angelegt (${flag('--admin') ? 'Admin – darf steuern' : 'nur ansehen'}).`);
      await showQr(info);
      return;
    }
    if (sub === 'list') { for (const u of auth.listUsers()) console.log(`${u.name.padEnd(20)} ${u.role.padEnd(7)} zuletzt: ${u.lastLogin ? new Date(u.lastLogin).toLocaleString() : '–'}`); return; }
    if (sub === 'remove') { auth.removeUser(positional[0] || die('Name fehlt')); console.log('✓ Entfernt (alle Geräte abgemeldet).'); return; }
    if (sub === 'passwd') { await auth.setPassword(positional[0] || die('Name fehlt'), await readPassword()); console.log('✓ Passwort geändert (alle Geräte abgemeldet).'); return; }
    if (sub === 'reset-2fa') { const info = auth.resetTotp(positional[0] || die('Name fehlt')); console.log('✓ Neuer 2FA-Schlüssel (alle Geräte abgemeldet).'); await showQr(info); return; }
    die('Unbekannt. Möglich: user add|list|remove|passwd|reset-2fa');
  }
  if (cmd === 'peer') {
    const cfg = config.load();
    if (sub === 'add') {
      const [name, url, token] = positional;
      if (!name || !/^https?:\/\//.test(url || '') || !token) die('So: s3cure-agent peer add <name> <https://url> <token>');
      cfg.peers = (cfg.peers || []).filter(p => p.name !== name).concat({ name, url, token });
      config.save(cfg); console.log(`✓ Server „${name}“ eingebunden. Agent neu laden: systemctl reload s3cure-agent`); return;
    }
    if (sub === 'remove') { cfg.peers = (cfg.peers || []).filter(p => p.name !== positional[0]); config.save(cfg); console.log('✓ Entfernt.'); return; }
    if (sub === 'list') { for (const p of cfg.peers || []) console.log(`${p.name.padEnd(20)} ${p.url}`); return; }
    die('Unbekannt. Möglich: peer add|remove|list');
  }
  if (cmd === 'token') { console.log(config.load().agentToken); return; }
  if (cmd === 'set') {
    const cfg = config.load();
    const [key, value] = [sub, positional[0]];
    if (!['name', 'publicUrl', 'language', 'port', 'bind'].includes(key) || value == null) die('So: s3cure-agent set <name|publicUrl|language|port|bind> <wert>');
    cfg[key] = key === 'port' ? Number(value) : value;
    config.save(cfg); console.log(`✓ ${key} = ${value}. Agent neu starten: systemctl restart s3cure-agent`); return;
  }
  if (cmd === 'info') {
    const cfg = config.load();
    console.log(`Name: ${cfg.name}\nAdresse: http://${cfg.bind}:${cfg.port}\nÖffentlich: ${cfg.publicUrl || '(nicht gesetzt)'}\nDaten: ${config.DIR}\nBenutzer: ${createAuth().listUsers().length}\nWeitere Server: ${(cfg.peers || []).length}`);
    return;
  }
  console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 10).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}

main().catch(err => die(err.message || String(err)));
