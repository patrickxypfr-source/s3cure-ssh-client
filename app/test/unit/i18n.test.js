// Übersetzungen: t(), Plural, Platzhalter, Sprache wählen – und tools/i18n-check.mjs (kein Text vergessen)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createI18n, resolveLang } = require('../../src/i18n.js');

const dicts = {
  de: { 'x.hi': 'Hallo {name}', 'x.files': { one: '{count} Datei', other: '{count} Dateien' }, 'x.fn': p => `F${p.n}`, 'x.onlyDe': 'Nur deutsch' },
  en: { 'x.hi': 'Hello {name}', 'x.files': { one: '{count} file', other: '{count} files' }, 'x.fn': p => `E${p.n}` },
};

test('t setzt Platzhalter ein und wählt die Pluralform', () => {
  const de = createI18n(dicts, 'de');
  const en = createI18n(dicts, 'en');
  assert.equal(de.t('x.hi', { name: 'Pi' }), 'Hallo Pi');
  assert.equal(en.t('x.hi', { name: 'Pi' }), 'Hello Pi');
  assert.equal(de.t('x.files', { count: 1 }), '1 Datei');
  assert.equal(en.t('x.files', { count: 2 }), '2 files');
  assert.equal(de.t('x.files', { count: 1500 }), '1.500 Dateien');
  assert.equal(en.t('x.files', { count: 1500 }), '1,500 files');
  assert.equal(en.t('x.fn', { n: 3 }), 'E3');
});

test('fehlender Text fällt auf Deutsch und dann auf den Schlüssel zurück', () => {
  const en = createI18n(dicts, 'en');
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(en.t('x.onlyDe'), 'Nur deutsch');
    assert.equal(en.t('x.gibtsNicht'), 'x.gibtsNicht');
  } finally { console.warn = warn; }
});

test('System-Sprache: Deutsch für de*, sonst Englisch', () => {
  assert.equal(resolveLang('system', 'de-AT'), 'de');
  assert.equal(resolveLang('system', 'de'), 'de');
  assert.equal(resolveLang('system', 'en-US'), 'en');
  assert.equal(resolveLang('system', 'fr-FR'), 'en');
  assert.equal(resolveLang('system', ''), 'en');
  assert.equal(resolveLang('de', 'en-US'), 'de');
  assert.equal(resolveLang('en', 'de-DE'), 'en');
});

test('Zahlen und Daten folgen der Sprache', () => {
  assert.equal(createI18n(dicts, 'de').fmtNumber(1234.5), '1.234,5');
  assert.equal(createI18n(dicts, 'en').fmtNumber(1234.5), '1,234.5');
});

test('Prüfskript erkennt deutsche Texte, aber keine Kommentare und regulären Ausdrücke', async () => {
  const { scanJs } = await import('../../tools/i18n-check.mjs');
  const src = [
    "// Kommentar mit Datei und Ordner",
    "const a = 'Datei löschen';",
    "const b = /Übertragung/.test(x);",
    "const c = `${t('x.y')} – ${n} Dateien`;",
    "const d = 'Abbrechen'; // i18n-ignore",
    "console.log('Fehler beim Laden');",
    "const e = 'Delete file';",
  ].join('\n');
  const found = scanJs('x.js', src).map(p => Number(p.split(':')[1]));
  assert.deepEqual(found, [2, 4]);
});

test('alle Texte sind übersetzt und kein deutscher Text ist übersehen (tools/i18n-check.mjs)', async () => {
  const { runCheck } = await import('../../tools/i18n-check.mjs');
  const problems = runCheck();
  assert.deepEqual(problems, [], problems.slice(0, 40).join('\n'));
});
