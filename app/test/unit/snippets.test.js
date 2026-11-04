// Eigene Befehlsknöpfe: Platzhalter, Import, Speicher (lib/snippets.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanGroups, parseImport, addTemplateIcons, createStore, PLACEHOLDER } = require('../../lib/snippets');

const names = cmd => [...cmd.matchAll(PLACEHOLDER)].map(m => m[1]);

test('Platzhalter {name} werden erkannt, ${VAR} der Shell nicht', () => {
  assert.deepEqual(names('docker logs {container} --tail {zeilen}'), ['container', 'zeilen']);
  assert.deepEqual(names('echo ${HOME} $HOME {größe}'), ['größe']);
  assert.deepEqual(names('awk \'{print $1}\' {1x} {_ok} {a-b}'), ['_ok', 'a-b']);
});

test('cleanButton legt für jeden Platzhalter ein Eingabefeld an', () => {
  const [g] = cleanGroups([{ items: [{ label: 'Logs', cmd: 'tail -n {n} {datei}', inputs: { n: { kind: 'number', prompt: 'Zeilen', value: 50 }, alt: { kind: 'text' } } }] }]);
  const b = g.items[0];
  assert.deepEqual(Object.keys(b.inputs).sort(), ['datei', 'n']);
  assert.deepEqual(b.inputs.n, { prompt: 'Zeilen', kind: 'number', value: '50' });
  assert.equal(b.inputs.datei.kind, 'ref');
});

test('cleanGroups wirft Leeres und Ungültiges weg', () => {
  const groups = cleanGroups([
    { items: [{ label: '', cmd: '  ' }, null, { cmd: 'uptime', icon: '<script>' }] },
    { items: [] },
    'unsinn',
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[0].items[0].label, 'uptime');
  assert.equal(groups[0].items[0].icon, '');
  assert.equal(cleanGroups('x').length, 0);
});

test('Menüs behalten ihre Einträge, confirm wird vereinheitlicht', () => {
  const [g] = cleanGroups([{ items: [{ type: 'menu', label: '', confirm: '  ', items: [{ cmd: 'a', confirm: 'Wirklich?' }, { cmd: 'b', confirm: 1 }] }] }]);
  const m = g.items[0];
  assert.equal(m.type, 'menu');
  assert.equal(m.label, 'Menü');
  assert.equal(m.confirm, false);
  assert.equal(m.items[0].confirm, 'Wirklich?');
  assert.equal(m.items[1].confirm, false);
});

test('parseImport: verschiedene Formate, neue IDs, verständliche Fehler', () => {
  const fromList = parseImport(JSON.stringify([{ id: 'alt', cmd: 'ls' }]));
  assert.equal(fromList.length, 1);
  assert.notEqual(fromList[0].items[0].id, 'alt');
  assert.equal(parseImport(JSON.stringify({ groups: [{ items: [{ cmd: 'ls' }] }] })).length, 1);
  assert.throws(() => parseImport('{kaputt'), /kein gültiges JSON/);
  assert.throws(() => parseImport('{"a":1}'), /keine Befehlsknöpfe/);
  assert.throws(() => parseImport('[{"items":[{"cmd":""}]}]'), /keine gültigen/);
});

test('addTemplateIcons rüstet bekannte s3-Befehle nach', () => {
  const groups = cleanGroups([{ items: [
    { cmd: 's3 status' }, { cmd: 's3 update', icon: 'star' }, { cmd: 'ls' },
    { type: 'menu', items: [{ cmd: 's3 restart a' }, { cmd: 's3 restart b' }] },
  ] }]);
  assert.equal(addTemplateIcons(groups), 2);
  assert.deepEqual(groups[0].items.map(i => i.icon), ['pulse', 'star', '', 'restart']);
});

test('Speicher: speichern, laden, umbenennen, kaputte Datei wird gesichert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3cure-snippets-'));
  try {
    const store = createStore(dir);
    store.saveProfile('srv', { groups: [{ items: [{ cmd: 'df -h' }] }] });
    assert.equal(store.load().profiles.srv.groups[0].items[0].cmd, 'df -h');
    store.rename('srv', 'srv2');
    assert.deepEqual(Object.keys(store.load().profiles), ['srv2']);
    fs.writeFileSync(store.file, '{kaputt');
    assert.deepEqual(createStore(dir).load().profiles, {});
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('snippets.json.defekt-')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
