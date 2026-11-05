// Prüft die Übersetzungen (läuft in npm test über test/unit/i18n.test.js, oder direkt):
//   node tools/i18n-check.mjs                 alles prüfen
//   node tools/i18n-check.mjs --files src/a.js lib/b.js   nur diese Dateien nach Texten durchsuchen
//   node tools/i18n-check.mjs --parts <ordner> zusätzliche Wörterbuch-Teile ({ de, en } je Datei) mitzählen
//
// 1. Schlüssel, die in de.js oder en.js fehlen, und abweichende Platzhalter/Pluralformen
// 2. t('…')- und data-i18n-Schlüssel, die es nicht gibt
// 3. offensichtlich übersehene deutsche Texte in Zeichenketten (Umlaute, typische Wörter)
//    Ausnahmen: Zeile mit „i18n-ignore“ (z. B. als Kommentar), console.*-Ausgaben, Dateien in IGNORE_FILES
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Dateien, die nicht nach deutschen Texten durchsucht werden (relativ zu app/)
const IGNORE_FILES = new Set(['src/i18n.js', 'lib/i18n.js', 'src/locales/de.js', 'src/locales/en.js']);

const GERMAN_WORDS = new Set((
  'nicht und oder der das dem den des ein eine einen einem einer ist sind wird werden wurde wurden kein keine keinen ' +
  'mit für bitte Bitte Verbindung Verbindungen Datei Dateien Ordner Fehler Abbrechen Speichern Löschen Neu neu neue neuer ' +
  'Einstellungen gespeichert fehlgeschlagen auf zu von bei nach noch schon jetzt alle Alle Passwort Schlüssel Benutzer ' +
  'hier Hier wählen Wählen öffnen Öffnen Ziel Anmeldung Sekunden Minuten Stunden Tage Größe Befehl Befehle Fenster ' +
  'kopieren Kopieren einfügen Einfügen laden hochladen Hochladen herunterladen Herunterladen Vorschau Suche gefunden ' +
  'läuft gestoppt gestartet Zeile aus im sich nur auch wenn dann als wie mehr Bearbeiten Schließen Zurück Weiter Fertig ' +
  'Übernehmen Hinzufügen Entfernen Zurücksetzen Achtung gibt kann können soll sollen muss bereits dieser diese dieses ' +
  'Sitzung Abgleich Vergleich Übertragung Übertragungen Warteschlange Lesezeichen Zertifikat Tunnel-Weiterleitung ' +
  'Gruppe Farbe Sprung-Server Schnellbefehle Weiterleitung Dienste Neustart Aktualisieren Ändern Rechte Besitzer'
).split(/\s+/));

const isGerman = text => {
  if (/[äöüÄÖÜß]/.test(text)) return true;
  for (const w of text.split(/[^A-Za-zÄÖÜäöüß-]+/)) if (w && GERMAN_WORDS.has(w)) return true;
  return false;
};

// ---------- Wörterbücher ----------

export function loadDicts({ parts } = {}) {
  const load = f => { delete require.cache[require.resolve(f)]; return require(f); };
  const de = { ...load(path.join(APP_DIR, 'src/locales/de.js')) };
  const en = { ...load(path.join(APP_DIR, 'src/locales/en.js')) };
  if (parts) {
    for (const f of fs.readdirSync(parts).filter(f => f.endsWith('.js')).sort()) {
      const part = load(path.join(path.resolve(parts), f));
      Object.assign(de, part.de || {});
      Object.assign(en, part.en || {});
    }
  }
  return { de, en };
}

const placeholders = v => {
  const texts = typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).filter(x => typeof x === 'string') : [];
  return [...new Set(texts.flatMap(s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1])).filter(n => n !== 'count'))].sort().join(',');
};

export function checkDicts({ de, en }) {
  const problems = [];
  for (const k of Object.keys(de)) if (!(k in en)) problems.push(`Fehlt in en.js: ${k}`);
  for (const k of Object.keys(en)) if (!(k in de)) problems.push(`Fehlt in de.js: ${k}`);
  for (const k of Object.keys(de)) {
    if (!(k in en)) continue;
    const a = de[k], b = en[k];
    const kind = v => (typeof v === 'function' ? 'function' : typeof v === 'object' && v ? 'plural' : typeof v);
    if (kind(a) === 'function' || kind(b) === 'function') continue;
    if (kind(a) === 'plural' && kind(b) === 'plural') {
      if (!('other' in a) || !('other' in b)) problems.push(`Pluralform ohne „other“: ${k}`);
    }
    if (placeholders(a) !== placeholders(b)) problems.push(`Platzhalter unterschiedlich in ${k}: de {${placeholders(a)}} / en {${placeholders(b)}}`);
    for (const [lang, v] of [['de', a], ['en', b]]) if (v === '' ) problems.push(`Leerer Text (${lang}): ${k}`);
  }
  return problems;
}

// ---------- Zeichenketten in JavaScript finden ----------

// Liefert [{ text, line }] für alle Zeichenketten und Template-Texte (ohne Kommentare und reguläre Ausdrücke)
export function jsStrings(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let prev = ''; // letztes bedeutsames Zeichen/Wort (für die Erkennung von /regex/)
  const n = src.length;

  const regexAllowed = () => !prev || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /^(return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(prev);

  function readQuoted(q) {
    const startLine = line;
    let s = '';
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') { s += src[i + 1] || ''; if (src[i + 1] === '\n') line++; i += 2; continue; }
      if (src[i] === '\n') line++;
      s += src[i++];
    }
    i++;
    out.push({ text: s, line: startLine });
    prev = 'str';
  }

  function readTemplate() {
    const startLine = line;
    let s = '';
    i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { s += src[i + 1] || ''; i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        s += ' ';
        code(true);
        continue;
      }
      if (src[i] === '\n') line++;
      s += src[i++];
    }
    i++;
    out.push({ text: s, line: startLine });
    prev = 'str';
  }

  function readRegex() {
    i++;
    let inClass = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') break;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { i++; break; }
      i++;
    }
    while (i < n && /[a-z]/i.test(src[i])) i++;
    prev = 'regex';
  }

  // Code lesen; inExpr: bis zur schließenden } eines ${…}
  function code(inExpr) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
        i = stop;
        continue;
      }
      if (c === '"' || c === "'") { readQuoted(c); continue; }
      if (c === '`') { readTemplate(); continue; }
      if (c === '/') { if (regexAllowed()) { readRegex(); continue; } prev = '/'; i++; continue; }
      if (inExpr) {
        if (c === '{') depth++;
        if (c === '}') { if (depth === 0) { i++; return; } depth--; }
      }
      if (/[A-Za-z_$0-9]/.test(c)) {
        let w = '';
        while (i < n && /[A-Za-z_$0-9]/.test(src[i])) w += src[i++];
        prev = w;
        continue;
      }
      prev = c;
      i++;
    }
  }

  code(false);
  return out;
}

export function scanJs(file, src) {
  const lines = src.split('\n');
  const problems = [];
  for (const { text, line } of jsStrings(src)) {
    const l = lines[line - 1] || '';
    if (/i18n-ignore/.test(l) || /\bconsole\.\w+\(/.test(l)) continue;
    if (isGerman(text)) problems.push(`${file}:${line}: deutscher Text ohne t(): ${JSON.stringify(text.trim().slice(0, 80))}`);
  }
  return problems;
}

// ---------- HTML ----------

export function scanHtml(file, src) {
  const problems = [];
  const clean = src.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, m => m.replace(/[^\n]/g, ' '));
  const stack = []; // { tag, translated }
  const VOID = new Set(['meta', 'link', 'img', 'input', 'br', 'hr', 'source']);
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
  let m;
  const lineAt = idx => clean.slice(0, idx).split('\n').length;
  while ((m = re.exec(clean))) {
    if (m[3] !== undefined) {
      const text = m[3].replace(/&[a-z]+;/g, ' ').trim();
      if (!text || !isGerman(text)) continue;
      const top = stack[stack.length - 1];
      if (!(top && top.text) && !stack.some(s => s.html)) problems.push(`${file}:${lineAt(m.index)}: Text ohne data-i18n: ${JSON.stringify(text.slice(0, 80))}`);
      continue;
    }
    const tag = m[1].toLowerCase();
    if (m[0].startsWith('</')) {
      while (stack.length && stack.pop().tag !== tag) { /* nicht geschlossene Elemente überspringen */ }
      continue;
    }
    const attrs = m[2];
    for (const a of ['title', 'placeholder', 'alt', 'aria-label']) {
      const v = attrs.match(new RegExp(`(?:^|\\s)${a}="([^"]*)"`));
      if (v && isGerman(v[1]) && !new RegExp(`data-i18n-${a}=`).test(attrs)) problems.push(`${file}:${lineAt(m.index)}: ${a}="…" ohne data-i18n-${a}: ${JSON.stringify(v[1].slice(0, 80))}`);
    }
    if (!VOID.has(tag) && !attrs.trim().endsWith('/')) stack.push({ tag, text: /\sdata-i18n="/.test(attrs), html: /\sdata-i18n-html="/.test(attrs) });
  }
  return problems;
}

// ---------- benutzte Schlüssel ----------

export function usedKeys(src) {
  const keys = [];
  for (const m of src.matchAll(/(?<![\w.])(?:t|I18N\.t|i18n\.t)\(\s*['"]([\w.-]+)['"]/g)) keys.push(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-html|-title|-placeholder|-aria-label)?="([\w.-]+)"/g)) keys.push(m[1]);
  return keys;
}

export function sourceFiles() {
  const list = ['main.js', 'preload.js'];
  for (const dir of ['src', 'lib']) {
    for (const f of fs.readdirSync(path.join(APP_DIR, dir)).sort()) {
      if (/\.(js|html)$/.test(f)) list.push(`${dir}/${f}`);
    }
  }
  return list;
}

export function runCheck({ parts, files } = {}) {
  const dicts = loadDicts({ parts });
  const problems = checkDicts(dicts);
  const all = sourceFiles();
  for (const rel of all) {
    const src = fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
    if (IGNORE_FILES.has(rel)) continue;
    for (const k of usedKeys(src)) if (!(k in dicts.de)) problems.push(`${rel}: Schlüssel gibt es nicht: ${k}`);
    if (files && !files.includes(rel)) continue;
    if (IGNORE_FILES.has(rel)) continue;
    problems.push(...(rel.endsWith('.html') ? scanHtml(rel, src) : scanJs(rel, src)));
  }
  return [...new Set(problems)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = { files: null, parts: null };
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '--parts') opt.parts = args[++k];
    else if (args[k] === '--files') { opt.files = []; while (args[k + 1] && !args[k + 1].startsWith('--')) opt.files.push(args[++k]); }
  }
  const problems = runCheck(opt);
  for (const p of problems) console.log(p);
  console.log(problems.length ? `\n${problems.length} Probleme gefunden.` : 'Übersetzungen: alles in Ordnung.');
  process.exitCode = problems.length ? 1 : 0;
}
