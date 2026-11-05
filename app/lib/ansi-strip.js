// Macht aus Terminal-Ausgabe lesbaren Text: Farb- und Steuercodes raus,
// Zeilen werden so übernommen, wie sie am Ende auf dem Bildschirm stehen
// (Rücktaste, Wagenrücklauf und „Zeile löschen“ werden berücksichtigt).
// Die Ausgabe kommt in Stücken – angefangene Codes werden über Stücke hinweg gemerkt.
const { StringDecoder } = require('string_decoder');
const i18n = require('./i18n');

const ALT_SCREEN = /^\?(1049|1047|47)$/;

class AnsiStripper {
  constructor() {
    this.decoder = new StringDecoder('utf8');
    this.state = 'text'; // text | esc | csi | str | strEsc | skip1
    this.seq = '';
    this.line = [];
    this.col = 0;
    this.alt = false; // Vollbild-Programm (nano, less, top …) – Inhalt wird nicht mitgeschrieben
  }

  // Gibt fertige Zeilen zurück (mit \n), Rest bleibt im Puffer
  push(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let out = '';
    for (const ch of text) out += this.char(ch);
    return out;
  }

  // Letzte, nicht abgeschlossene Zeile ausgeben
  end() {
    const rest = this.decoder.end();
    let out = rest ? this.push(rest) : '';
    if (this.line.length) out += this.flush();
    return out;
  }

  flush() {
    const text = this.line.join('').replace(/\s+$/, '');
    this.line = [];
    this.col = 0;
    return text + '\n';
  }

  put(ch) {
    if (this.alt) return;
    while (this.line.length < this.col) this.line.push(' ');
    this.line[this.col++] = ch;
  }

  char(ch) {
    const code = ch.codePointAt(0);
    switch (this.state) {
      case 'esc':
        this.state = 'text';
        if (ch === '[') { this.state = 'csi'; this.seq = ''; }
        else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') this.state = 'str';
        else if ('()*+-./#%'.includes(ch)) this.state = 'skip1';
        return '';
      case 'skip1':
        this.state = 'text';
        return '';
      case 'csi':
        if (code >= 0x40 && code <= 0x7e) { this.state = 'text'; return this.csi(this.seq, ch); }
        this.seq += ch;
        if (this.seq.length > 64) this.state = 'text'; // kaputter Code
        return '';
      case 'str': // OSC/DCS … endet mit BEL oder ESC \
        if (ch === '\x07') this.state = 'text';
        else if (ch === '\x1b') this.state = 'strEsc';
        return '';
      case 'strEsc':
        this.state = ch === '\\' ? 'text' : 'str';
        return '';
    }
    // normaler Text
    if (ch === '\x1b') { this.state = 'esc'; return ''; }
    if (ch === '\x9b') { this.state = 'csi'; this.seq = ''; return ''; }
    if (ch === '\n') return this.alt ? '' : this.flush();
    if (ch === '\r') { this.col = 0; return ''; }
    if (ch === '\b') { if (this.col > 0) this.col--; return ''; }
    if (ch === '\t') { if (!this.alt) do this.put(' '); while (this.col % 8); return ''; }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) return '';
    this.put(ch);
    return '';
  }

  csi(params, final) {
    const n = Math.max(1, parseInt(params, 10) || 1);
    if ((final === 'h' || final === 'l') && ALT_SCREEN.test(params)) {
      const enter = final === 'h';
      if (enter === this.alt) return '';
      let out = '';
      if (enter && this.line.length) out = this.flush();
      this.alt = enter;
      if (enter) { this.line = []; this.col = 0; return out + i18n.t('ansiStrip.fullscreen') + '\n'; }
      this.line = []; this.col = 0;
      return '';
    }
    if (this.alt) return '';
    if (final === 'K') { // Zeile (teilweise) löschen
      const mode = parseInt(params, 10) || 0;
      if (mode === 0) this.line.length = Math.min(this.line.length, this.col);
      else if (mode === 1) for (let i = 0; i < Math.min(this.col + 1, this.line.length); i++) this.line[i] = ' ';
      else this.line = [];
    } else if (final === 'C') this.col += n;
    else if (final === 'D') this.col = Math.max(0, this.col - n);
    else if (final === 'G') this.col = n - 1;
    else if (final === 'P') this.line.splice(this.col, n); // Zeichen löschen
    else if (final === '@') { while (this.line.length < this.col) this.line.push(' '); this.line.splice(this.col, 0, ...' '.repeat(n)); }
    return '';
  }
}

module.exports = { AnsiStripper };
