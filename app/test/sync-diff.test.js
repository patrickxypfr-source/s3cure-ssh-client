// Tests für den Textvergleich (src/diff-core.js) und die Ordner-Vergleichslogik (lib/sync-core.js).
// Ausführen (ohne Zusatzpakete): node --test app/test/sync-diff.test.js
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/diff-core.js');
const C = require('../lib/sync-core.js');

function lcsLength(a, b) {
  const t = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  return t[0][0];
}

test('diffLines: minimal und vollständig (Zufallstests gegen LCS)', () => {
  let seed = 42;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let it = 0; it < 1500; it++) {
    const alpha = 1 + rnd(4);
    const a = Array.from({ length: rnd(25) }, () => String(rnd(alpha)));
    const b = Array.from({ length: rnd(25) }, () => String(rnd(alpha)));
    const r = D.diffLines(a, b);
    const left = [], right = [];
    let eq = 0;
    for (const row of r.rows) {
      if (row.l >= 0) left.push(a[row.l]);
      if (row.r >= 0) right.push(b[row.r]);
      if (row.kind === 'eq') { eq++; assert.strictEqual(a[row.l], b[row.r]); }
    }
    assert.deepStrictEqual(left, a);
    assert.deepStrictEqual(right, b);
    assert.strictEqual(eq, lcsLength(a, b));
  }
});

test('diffLines: Blöcke, Leerzeichen ignorieren, Text mit Zeilenumbrüchen', () => {
  const r = D.diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.deepStrictEqual(r.rows.map(x => x.kind), ['eq', 'chg', 'eq', 'ins']);
  assert.strictEqual(r.changes, 2);
  assert.strictEqual(D.diffLines('x  = 1\n', 'x = 1  \n', { ignoreSpace: true }).changes, 0);
  assert.strictEqual(D.diffLines('a\r\nb', 'a\nb').changes, 0);
});

test('diffLines: sehr viele Unterschiede -> grob, aber vollständig', () => {
  const a = Array.from({ length: 6000 }, (_, i) => 'a' + i);
  const b = Array.from({ length: 6000 }, (_, i) => 'b' + i);
  const r = D.diffLines(a, b);
  assert.strictEqual(r.approx, true);
  assert.strictEqual(r.rows.filter(x => x.l >= 0).length, 6000);
});

test('diffChars: markiert nur den geänderten Teil', () => {
  assert.deepStrictEqual(D.diffChars('port = 80', 'port = 8080').filter(p => p.type !== 'eq'), [{ type: 'ins', text: '80' }]);
  assert.deepStrictEqual(D.diffChars('Zeile 1', 'ganz anders'), [{ type: 'del', text: 'Zeile 1' }, { type: 'ins', text: 'ganz anders' }]);
});

test('makeMatcher: Namen, Muster, Ordner, Pfade', () => {
  const m = C.makeMatcher([...C.DEFAULT_EXCLUDES, '*.log', 'build/', 'docs/**/*.tmp', 'config/secret.env']);
  assert.ok(m('node_modules', true));
  assert.ok(m('a/b/.git', true));
  assert.ok(m('x/y/Fehler.LOG', false));
  assert.ok(m('build', true));
  assert.ok(!m('build', false));
  assert.ok(m('docs/a/b/c.tmp', false));
  assert.ok(m('config/secret.env', false));
  assert.ok(!m('other/config/secret.env', false));
  assert.ok(!m('src/app.js', false));
});

test('safeRel lehnt gefährliche Pfade ab', () => {
  assert.ok(C.safeRel('a/b.txt'));
  for (const bad of ['', '../x', 'a/../b', '/abs', 'a//b', 'a/./b', 'a\0b']) assert.ok(!C.safeRel(bad), bad);
});

test('compareTrees: Einordnen, Ordner nur einmal, Prüfsumme', () => {
  const f = (size, mtime) => ({ isDir: false, size, mtime });
  const dir = { isDir: true, size: 0, mtime: 0 };
  const local = new Map([['a', dir], ['a/x', f(1, 0)], ['a.txt', f(3, 50000)], ['same', f(2, 10000)], ['diff', f(5, 7000)], ['h', f(4, 90000)]]);
  const remote = new Map([['a.txt', f(3, 1000)], ['same', f(2, 9500)], ['diff', f(6, 7000)], ['r', dir], ['r/q', f(5, 1)], ['h', f(4, 1000)]]);
  const { items, same } = C.compareTrees(local, remote, new Map([['h', { local: 'x', remote: 'x' }]]));
  const by = Object.fromEntries(items.map(i => [i.rel, i]));
  assert.strictEqual(by.a.status, 'onlyLocal');
  assert.strictEqual(by.a.files, 1);
  assert.ok(!by['a/x'], 'Inhalt eines nur lokalen Ordners nicht einzeln');
  assert.strictEqual(by['a.txt'].status, 'localNewer');
  assert.strictEqual(by.diff.status, 'differ');
  assert.strictEqual(by.r.status, 'onlyRemote');
  assert.ok(!by.h, 'gleiche Prüfsumme = gleich');
  assert.strictEqual(same, 2);
});

test('suggest: Richtungen und Löschen', () => {
  const it = s => ({ status: s });
  assert.deepStrictEqual(C.suggest(it('onlyLocal'), 'up', false), { action: 'upload', checked: true });
  assert.strictEqual(C.suggest(it('onlyRemote'), 'up', false).action, null);
  assert.strictEqual(C.suggest(it('onlyRemote'), 'up', true).action, 'deleteRemote');
  assert.strictEqual(C.suggest(it('remoteNewer'), 'up', false).checked, false);
  assert.strictEqual(C.suggest(it('onlyLocal'), 'down', true).action, 'deleteLocal');
  assert.strictEqual(C.suggest(it('remoteNewer'), 'both', false).action, 'download');
  assert.strictEqual(C.suggest(it('differ'), 'both', false).checked, false);
  assert.strictEqual(C.suggest(it('onlyRemote'), 'both', true).action, 'download'); // „Beide“ löscht nie
});
