// Lokales Terminal (lib/local-term.js) – mit nachgebautem node-pty, ohne echte Shell
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalTerm, pickShell, shellEnv } = require('../../lib/local-term');
const { cleanData } = require('../../lib/session');

test('Shell: Mac nimmt $SHELL als Login-Shell, sonst zsh', () => {
  assert.deepEqual(pickShell({ platform: 'darwin', env: { SHELL: '/opt/fish' }, exists: f => f === '/opt/fish' }), { file: '/opt/fish', args: ['-l'] });
  assert.deepEqual(pickShell({ platform: 'darwin', env: {}, exists: f => f === '/bin/zsh' }), { file: '/bin/zsh', args: ['-l'] });
  assert.equal(pickShell({ platform: 'linux', env: { SHELL: 'bash' }, exists: f => f === '/bin/bash' }).file, '/bin/bash'); // relativ -> ignoriert
});

test('Shell: Windows nimmt PowerShell, sonst cmd', () => {
  const ps = pickShell({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists: () => true });
  assert.match(ps.file, /powershell\.exe$/i);
  assert.equal(pickShell({ platform: 'win32', env: { COMSPEC: 'C:\\Windows\\cmd.exe' }, exists: () => false }).file, 'C:\\Windows\\cmd.exe');
});

test('Umgebung: ohne Electron-Variablen, mit Farben und UTF-8', () => {
  const env = shellEnv({ platform: 'darwin', lang: 'de', env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', S3CURE_CONFIG_DIR: '/tmp' } });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.S3CURE_CONFIG_DIR, undefined);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.LANG, 'de_DE.UTF-8');
  assert.equal(shellEnv({ platform: 'darwin', env: { LANG: 'fr_FR.UTF-8' } }).LANG, 'fr_FR.UTF-8');
});

function fakePty() {
  const spawned = [];
  return {
    spawned,
    spawn(file, args, opts) {
      const p = { file, args, opts, written: [], size: [opts.cols, opts.rows], killed: false, dataCb: null, exitCb: null,
        onData: cb => { p.dataCb = cb; }, onExit: cb => { p.exitCb = cb; },
        write: d => p.written.push(d), resize: (c, r) => { p.size = [c, r]; }, kill: () => { p.killed = true; } };
      spawned.push(p);
      return p;
    },
  };
}

test('Öffnen, schreiben, Größe, Ausgabe und Ende', () => {
  const pty = fakePty();
  const sent = [];
  const lt = createLocalTerm({ send: (...a) => sent.push(a), platform: 'darwin', loadPty: () => pty });
  const info = lt.open('t1', 100, 30);
  assert.equal(info.local, true);
  const p = pty.spawned[0];
  assert.deepEqual(p.size, [100, 30]);
  assert.ok(lt.write('t1', 'ls\r'));
  assert.deepEqual(p.written, ['ls\r']);
  assert.ok(lt.resize('t1', 80, 24));
  assert.deepEqual(p.size, [80, 24]);
  assert.equal(lt.write('anderer', 'x'), false); // gehört nicht zum lokalen Terminal -> SSH
  p.dataCb('hallo');
  assert.deepEqual(sent.pop(), ['ssh:data', 't1', 'hallo']);
  p.exitCb({ exitCode: 0 });
  assert.deepEqual(sent.pop(), ['ssh:closed', 't1']);
  assert.equal(lt.has('t1'), false);
});

test('Absichtlich geschlossen: Shell beendet, aber kein „Verbindung beendet“', () => {
  const pty = fakePty();
  const sent = [];
  const lt = createLocalTerm({ send: (...a) => sent.push(a), platform: 'darwin', loadPty: () => pty });
  lt.open('t1', 80, 24);
  lt.close('t1');
  assert.equal(pty.spawned[0].killed, true);
  pty.spawned[0].exitCb({ exitCode: 1 });
  assert.equal(sent.length, 0);
});

test('Sitzung merkt sich lokale Tabs', () => {
  const d = cleanData({ version: 2, windows: [{ tabs: [{ spec: { local: true }, title: 'Lokal', view: 'terminal' }, { spec: { local: 'ja' } }] }] });
  assert.deepEqual(d.windows[0].tabs.map(t => t.spec), [{ local: true }]);
});
