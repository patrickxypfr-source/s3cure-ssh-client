// Mitschnitt: Steuercodes entfernen (lib/ansi-strip.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AnsiStripper } = require('../../lib/ansi-strip');

test('Farben weg, Wagenrücklauf und Rücktaste wie auf dem Bildschirm', () => {
  const s = new AnsiStripper();
  let out = s.push('\x1b[31mrot\x1b[0m normal\r\n');
  out += s.push('abc\bX\r\n');
  out += s.push('alt\rneu\r\n');
  assert.equal(out, 'rot normal\nabX\nneu\n');
});

test('Codes über mehrere Stücke hinweg und UTF-8 in Teilen', () => {
  const s = new AnsiStripper();
  const buf = Buffer.from('ä\x1b[1mfett\x1b[0m', 'utf8');
  let out = s.push(buf.subarray(0, 1));
  out += s.push(buf.subarray(1, 5));
  out += s.push(buf.subarray(5));
  out += s.end();
  assert.equal(out, 'äfett\n');
});
