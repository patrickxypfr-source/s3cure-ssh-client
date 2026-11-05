// Einmal-Codes für die Zwei-Faktor-Anmeldung (TOTP, RFC 6238: SHA-1, 30 Sekunden, 6 Ziffern).
// Funktioniert mit jeder Authenticator-App (Apple Passwörter, Google Authenticator, 1Password, Authy …).
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = (h.readUInt32BE(o) & 0x7fffffff) % 1e6;
  return String(code).padStart(6, '0');
}

const step = (time = Date.now()) => Math.floor(time / 30000);

// Prüft den Code (±1 Zeitfenster gegen Uhrabweichung). lastStep: zuletzt benutztes Fenster –
// derselbe Code darf nicht zweimal benutzt werden. Rückgabe: benutztes Fenster oder null.
function verify(secret, code, { time = Date.now(), lastStep = -1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = step(time);
  for (const s of [now, now - 1, now + 1]) {
    if (s <= lastStep) continue;
    const expected = hotp(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return null;
}

// Link für die Authenticator-App (als QR-Code anzeigen)
const uri = (secret, account, issuer = 'S3cure') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { newSecret, hotp, verify, uri, base32Encode, base32Decode, step };
