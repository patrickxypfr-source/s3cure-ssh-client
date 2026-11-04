// Zeilenweiser Textvergleich (Myers-Algorithmus) – ohne fremde Bibliotheken.
// Läuft in der Oberfläche (window.DiffCore, src/compare.js) und in Node (Tests).
//
// diffLines(a, b, opts) -> { rows, changes, approx }
//   rows:    nebeneinander ausgerichtete Zeilen { kind: 'eq'|'chg'|'del'|'ins', l, r }
//            l/r = Zeilennummer (0-basiert) links/rechts oder -1 (Leerzeile als Platzhalter)
//   changes: Anzahl Unterschiedsblöcke
//   approx:  true, wenn es so viele Unterschiede gab, dass grob verglichen wurde
// diffChars(a, b) -> [{ type: 'eq'|'del'|'ins', text }] für eine geänderte Zeile

(function (root) {
  const MAX_D = 4000; // ab so vielen Unterschieden nur noch grob vergleichen (Speicher/Zeit)

  // Myers O(ND): kürzeste Folge von Einfügen/Löschen zwischen zwei Zahlenfolgen.
  // Liefert Liste von [typ, i, j] mit typ 0 = gleich, 1 = gelöscht (nur a), 2 = eingefügt (nur b)
  function myers(a, b, maxD = MAX_D) {
    const n = a.length, m = b.length;
    const ops = [];
    // gemeinsamen Anfang und Ende abschneiden – macht die meisten Fälle schnell
    let start = 0;
    while (start < n && start < m && a[start] === b[start]) start++;
    let endA = n, endB = m;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    for (let i = 0; i < start; i++) ops.push([0, i, i]);

    const N = endA - start, M = endB - start;
    const tail = () => { for (let i = endA, j = endB; i < n; i++, j++) ops.push([0, i, j]); };
    if (N === 0 || M === 0) {
      for (let i = start; i < endA; i++) ops.push([1, i, -1]);
      for (let j = start; j < endB; j++) ops.push([2, -1, j]);
      tail();
      return { ops, approx: false };
    }

    const max = N + M;
    const limit = Math.min(max, maxD);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = []; // pro Schritt d: Kopie von v[-d..d]
    let found = -1;
    for (let d = 0; d <= limit; d++) {
      trace.push(v.slice(off - d, off + d + 1));
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && a[start + x] === b[start + y]) { x++; y++; }
        v[off + k] = x;
        if (x >= N && y >= M) { found = d; break; }
      }
      if (found >= 0) break;
    }

    if (found < 0) {
      // zu viele Unterschiede: alles dazwischen als geändert zeigen
      for (let i = start; i < endA; i++) ops.push([1, i, -1]);
      for (let j = start; j < endB; j++) ops.push([2, -1, j]);
      tail();
      return { ops, approx: true };
    }

    // Weg rückwärts nachverfolgen
    const middle = [];
    let x = N, y = M;
    for (let d = found; d > 0; d--) {
      const vd = trace[d]; // Zustand vor Schritt d (= nach Schritt d-1), Index k + d
      const get = k => vd[k + d];
      const k = x - y;
      const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
      const prevK = down ? k + 1 : k - 1;
      const prevX = get(prevK);
      const prevY = prevX - prevK;
      while (x > prevX + (down ? 0 : 1) && y > prevY + (down ? 1 : 0)) { x--; y--; middle.push([0, start + x, start + y]); }
      if (down) { y--; middle.push([2, -1, start + y]); }
      else { x--; middle.push([1, start + x, -1]); }
      x = prevX; y = prevY;
    }
    while (x > 0 && y > 0) { x--; y--; middle.push([0, start + x, start + y]); }
    for (let i = middle.length - 1; i >= 0; i--) ops.push(middle[i]);
    tail();
    return { ops, approx: false };
  }

  // Zeilen in Zahlen umwandeln (gleiche Zeile = gleiche Zahl)
  function tokenize(linesA, linesB, key) {
    const ids = new Map();
    const conv = lines => {
      const out = new Int32Array(lines.length);
      for (let i = 0; i < lines.length; i++) {
        const k = key(lines[i]);
        let id = ids.get(k);
        if (id === undefined) { id = ids.size; ids.set(k, id); }
        out[i] = id;
      }
      return out;
    };
    return [conv(linesA), conv(linesB)];
  }

  function splitLines(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // Zeilenumbruch am Ende
    return lines;
  }

  // opts.ignoreSpace: Leerzeichen/Tabs am Rand und mehrfach ignorieren
  // opts.ignoreCase: Groß-/Kleinschreibung ignorieren
  function diffLines(linesA, linesB, opts = {}) {
    if (typeof linesA === 'string') linesA = splitLines(linesA);
    if (typeof linesB === 'string') linesB = splitLines(linesB);
    const key = s => {
      let t = s;
      if (opts.ignoreSpace) t = t.replace(/\s+/g, ' ').trim();
      if (opts.ignoreCase) t = t.toLowerCase();
      return t;
    };
    const [ta, tb] = tokenize(linesA, linesB, key);
    const { ops, approx } = myers(ta, tb, opts.maxD);

    // Blöcke aus Löschen/Einfügen nebeneinander stellen
    const rows = [];
    let changes = 0;
    let dels = [], inss = [];
    const flush = () => {
      if (!dels.length && !inss.length) return;
      changes++;
      const n = Math.max(dels.length, inss.length);
      for (let i = 0; i < n; i++) {
        const l = i < dels.length ? dels[i] : -1;
        const r = i < inss.length ? inss[i] : -1;
        rows.push({ kind: l >= 0 && r >= 0 ? 'chg' : l >= 0 ? 'del' : 'ins', l, r });
      }
      dels = []; inss = [];
    };
    for (const [t, i, j] of ops) {
      if (t === 0) { flush(); rows.push({ kind: 'eq', l: i, r: j }); }
      else if (t === 1) dels.push(i);
      else inss.push(j);
    }
    flush();
    return { rows, changes, approx, left: linesA, right: linesB };
  }

  // Zeichenweiser Vergleich einer geänderten Zeile (für die Markierung innerhalb der Zeile)
  function diffChars(a, b) {
    a = String(a); b = String(b);
    if (a.length + b.length > 4000) return [{ type: 'del', text: a }, { type: 'ins', text: b }];
    const ca = Int32Array.from(a, c => c.codePointAt(0));
    const cb = Int32Array.from(b, c => c.codePointAt(0));
    const charsA = Array.from(a), charsB = Array.from(b);
    const { ops } = myers(ca, cb, 400);
    const out = [];
    const push = (type, ch) => {
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += ch; else out.push({ type, text: ch });
    };
    for (const [t, i, j] of ops) {
      if (t === 0) push('eq', charsA[i]);
      else if (t === 1) push('del', charsA[i]);
      else push('ins', charsB[j]);
    }
    return out;
  }

  const api = { diffLines, diffChars, splitLines, myers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DiffCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
