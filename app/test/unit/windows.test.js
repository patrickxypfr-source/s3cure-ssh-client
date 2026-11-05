// Mehrere Fenster: Zuordnung Tab -> Fenster, Weiterleitung, Umzug (lib/windows.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowRegistry, cascade, windowAt, cleanPayload } = require('../../lib/windows');

let nextId = 1;
function fakeWindow(bounds = { x: 0, y: 0, width: 800, height: 600 }) {
  const win = new EventEmitter();
  const wc = { id: nextId++, sent: [], destroyed: false, send(ch, ...a) { this.sent.push([ch, ...a]); }, isDestroyed() { return this.destroyed; } };
  Object.assign(win, { webContents: wc, isDestroyed: () => wc.destroyed, isMinimized: () => false, getBounds: () => bounds });
  return win;
}

test('Ereignisse eines Tabs gehen nur an sein Fenster, allgemeine an alle', () => {
  const reg = createWindowRegistry();
  const a = fakeWindow(), b = fakeWindow();
  reg.add(a); reg.add(b);
  reg.setOwner('t1', a.webContents);
  reg.setOwner('t2', b.webContents);
  reg.sendTab('t1', 'ssh:data', 't1', 'x');
  reg.sendTab('unbekannt', 'ssh:data', 'unbekannt', 'y');
  reg.sendAll('power:resume');
  reg.sendOthers(a.webContents, 'settings:changed', {});
  assert.deepEqual(a.webContents.sent, [['ssh:data', 't1', 'x'], ['power:resume']]);
  assert.deepEqual(b.webContents.sent, [['power:resume'], ['settings:changed', {}]]);
  assert.ok(reg.owns(a.webContents, 't1'));
  assert.ok(!reg.owns(b.webContents, 't1'));
});

test('Listen mit tabId bekommt jedes Fenster gefiltert', () => {
  const reg = createWindowRegistry();
  const a = fakeWindow(), b = fakeWindow();
  reg.add(a); reg.add(b);
  reg.setOwner('t1', a.webContents);
  reg.setOwner('t2', b.webContents);
  reg.sendList('watch:status', [{ id: 1, tabId: 't1' }, { id: 2, tabId: 't2' }, { id: 3, tabId: 'weg' }]);
  assert.deepEqual(a.webContents.sent, [['watch:status', [{ id: 1, tabId: 't1' }]]]);
  assert.deepEqual(b.webContents.sent, [['watch:status', [{ id: 2, tabId: 't2' }]]]);
});

test('Umzug: Ausgabe wird zurückgehalten und danach in Reihenfolge an das neue Fenster geschickt', () => {
  const reg = createWindowRegistry();
  const a = fakeWindow(), b = fakeWindow();
  reg.add(a); reg.add(b);
  const moves = [];
  reg.onMove((tabId, to, from) => moves.push([tabId, to, from]));
  reg.setOwner('t1', a.webContents);
  reg.hold('t1');
  reg.sendTab('t1', 'ssh:data', 't1', '1');
  reg.setOwner('t1', b.webContents);
  reg.sendTab('t1', 'ssh:data', 't1', '2');
  assert.equal(b.webContents.sent.length, 0, 'noch nichts, solange das Fenster den Tab nicht angelegt hat');
  reg.release('t1');
  assert.deepEqual(b.webContents.sent, [['ssh:data', 't1', '1'], ['ssh:data', 't1', '2']]);
  assert.equal(a.webContents.sent.length, 0);
  assert.deepEqual(moves[0], ['t1', b.webContents.id, a.webContents.id]);
  assert.ok(!reg.holding('t1'));
});

test('Fenster schließen oder neu laden: seine Tabs werden zurückgegeben und vergessen', () => {
  const reg = createWindowRegistry();
  const a = fakeWindow(), b = fakeWindow();
  reg.add(a); reg.add(b);
  reg.setOwner('t1', a.webContents);
  reg.setOwner('t2', a.webContents);
  reg.setOwner('t3', b.webContents);
  assert.deepEqual(reg.clearTabs(a.webContents.id).sort(), ['t1', 't2']);
  assert.equal(reg.ownerId('t1'), null);
  reg.setOwner('t4', a.webContents);
  assert.deepEqual(reg.remove(a.webContents.id), ['t4']);
  assert.equal(reg.has(a.webContents.id), false);
  assert.equal(reg.ownerId('t3'), b.webContents.id);
  reg.setOwner('t5', { id: 999 }); // unbekanntes Fenster (z. B. Update-Fenster) wird ignoriert
  assert.equal(reg.ownerId('t5'), null);
});

test('Fensternummern: kleinste freie Nummer', () => {
  const reg = createWindowRegistry();
  const a = fakeWindow(), b = fakeWindow(), c = fakeWindow();
  assert.equal(reg.add(a).no, 1);
  assert.equal(reg.add(b).no, 2);
  reg.remove(a.webContents.id);
  assert.equal(reg.add(c).no, 1);
});

test('Dialoge: Fenster des laufenden IPC-Aufrufs, sonst das zuletzt aktive', async () => {
  const reg = createWindowRegistry();
  const a = fakeWindow(), b = fakeWindow();
  reg.add(a); reg.add(b);
  b.emit('focus');
  assert.equal(reg.current(), b);
  const handlers = {};
  const ipc = { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { handlers[ch] = fn; }, once() {} };
  reg.wrapIpc(ipc);
  ipc.handle('x', async () => { await new Promise(r => setTimeout(r, 5)); return reg.current(); });
  assert.equal(await handlers.x({ sender: a.webContents }), a);
  assert.equal(reg.current(), b);
});

test('Hilfen: versetztes Fenster, Fenster unter der Maus, Tab-Übergabe säubern', () => {
  assert.deepEqual(cascade({ x: 100, y: 50, width: 800, height: 600 }, { x: 0, y: 0, width: 1920, height: 1080 }), { x: 130, y: 80, width: 800, height: 600 });
  assert.deepEqual(cascade({ x: 1500, y: 50, width: 800, height: 600 }, { x: 0, y: 0, width: 1920, height: 1080 }), { x: 30, y: 30, width: 800, height: 600 });
  const e1 = { id: 1, win: fakeWindow({ x: 0, y: 0, width: 500, height: 400 }) };
  const e2 = { id: 2, win: fakeWindow({ x: 600, y: 0, width: 500, height: 400 }) };
  assert.equal(windowAt([e1, e2], { x: 700, y: 10 }), e2);
  assert.equal(windowAt([e1, e2], { x: 700, y: 10 }, 2), null);
  assert.equal(windowAt([e1, e2], { x: 550, y: 10 }), null);

  assert.equal(cleanPayload(null), null);
  assert.equal(cleanPayload({ id: 'x' }), null);
  const p = cleanPayload({ id: 't', spec: { name: 'srv', evil: { a: 1 } }, view: 'bogus', state: 'open', screen: 'abc', cols: 80, rows: 24.5, info: { user: 'u', host: 'h', port: '2222' } });
  assert.deepEqual(p.spec, { name: 'srv' });
  assert.equal(p.view, 'terminal');
  assert.equal(p.state, 'open');
  assert.equal(p.cols, 80);
  assert.equal(p.rows, null);
  assert.deepEqual(p.info, { user: 'u', host: 'h', port: 2222 });
});
