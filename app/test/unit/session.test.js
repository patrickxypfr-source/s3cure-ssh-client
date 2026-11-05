// Sitzung wiederherstellen mit mehreren Fenstern (lib/session.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { create, cleanData } = require('../../lib/session');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 's3session-'));
const tab = name => ({ spec: { name }, title: name, view: 'terminal' });

test('altes Format (ein Fenster) wird gelesen', () => {
  const d = cleanData({ version: 1, window: { x: 10, y: 20, width: 900, height: 600, maximized: true }, tabs: [tab('a'), { bogus: 1 }], active: 0 });
  assert.equal(d.windows.length, 1);
  assert.deepEqual(d.windows[0].window, { x: 10, y: 20, width: 900, height: 600, maximized: true });
  assert.equal(d.windows[0].tabs.length, 1);
  assert.match(d.windows[0].key, /^[\w-]+$/);
});

test('mehrere Fenster speichern, eines entfernen, erstes Fenster auch im alten Format', () => {
  const dir = tmp();
  const s = create(dir);
  s.add('w1');
  s.setTabs('w1', { tabs: [tab('a'), tab('b')], active: 1 });
  s.setWindow('w1', { x: 1, y: 2, width: 800, height: 500 });
  s.setTabs('w2', { tabs: [tab('c')], active: 0 });
  s.add('w3');
  s.remove('w3');
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  assert.equal(file.version, 2);
  assert.deepEqual(file.windows.map(w => w.key), ['w1', 'w2']);
  assert.deepEqual(file.windows[1].tabs.map(t => t.title), ['c']);
  assert.deepEqual(file.tabs.map(t => t.title), ['a', 'b'], 'ältere Versionen sehen das erste Fenster');
  assert.equal(file.active, 1);
  assert.deepEqual(file.window, { x: 1, y: 2, width: 800, height: 500 });

  const again = create(dir);
  assert.deepEqual(again.windows().map(w => w.key), ['w1', 'w2']);
  again.keep(['w2']);
  assert.deepEqual(create(dir).windows().map(w => w.key), ['w2']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('doppelte oder ungültige Fenster-Schlüssel werden ersetzt', () => {
  const d = cleanData({ windows: [{ key: 'x', tabs: [] }, { key: 'x', tabs: [] }, { key: '../böse', tabs: [] }, 'kaputt'] });
  assert.equal(d.windows.length, 3);
  assert.equal(new Set(d.windows.map(w => w.key)).size, 3);
  assert.ok(d.windows.every(w => /^[\w-]+$/.test(w.key)));
});
