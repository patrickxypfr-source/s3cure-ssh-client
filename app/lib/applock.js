// Optionale App-Sperre: Beim Start erst entsperren (macOS Touch ID oder App-Passwort).
// Das App-Passwort wird nur als scrypt-Hash gespeichert. Standard: aus.
// Solange gesperrt, lädt das Fenster nur src/lock.html – die eigentliche Oberfläche erst danach.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { systemPreferences } = require('electron');

const SCRYPT = { N: 16384, r: 8, p: 1 };

function createAppLock({ configDir, isMac }) {
  // Eigene Datei: settings.json gehört lib/settings.js (das sie im Speicher hält und komplett neu schreibt)
  const file = path.join(configDir, 'applock.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const save = s => {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  };
  const conf = () => load().appLock || {};
  let unlocked = false;
  let failures = 0;

  const hash = (password, salt) => crypto.scryptSync(password, Buffer.from(salt, 'base64'), 32, SCRYPT);
  function checkPassword(password) {
    const c = conf();
    if (!c.hash || !c.salt || typeof password !== 'string') return false;
    const expected = Buffer.from(c.hash, 'base64');
    const actual = hash(password, c.salt);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  const canTouchId = () => {
    try { return isMac && process.platform === 'darwin' && systemPreferences.canPromptTouchID(); } catch { return false; }
  };

  const status = () => {
    const c = conf();
    return { enabled: !!c.enabled, touchId: !!c.touchId && canTouchId(), canTouchId: canTouchId(), locked: !!c.enabled && !unlocked };
  };

  function register(ipcMain, { onUnlocked }) {
    const done = () => { unlocked = true; failures = 0; onUnlocked(); return true; };

    ipcMain.handle('lock:status', () => status());

    ipcMain.handle('lock:unlock', async (_e, password) => {
      if (!status().locked) return done();
      if (failures > 2) await new Promise(r => setTimeout(r, Math.min(failures, 10) * 1000)); // bremst Raten
      if (checkPassword(password)) return done();
      failures++;
      return false;
    });

    ipcMain.handle('lock:touchid', async () => {
      if (!status().locked) return done();
      if (!status().touchId) return false;
      try { await systemPreferences.promptTouchID('S3cure SSH Client entsperren'); } catch { return false; }
      return done();
    });

    // opts: { enabled, touchId, password (neu), current (bisheriges App-Passwort) }
    ipcMain.handle('lock:configure', (_e, opts) => {
      const c = conf();
      if (c.enabled && !checkPassword(opts.current)) throw new Error('Das bisherige App-Passwort stimmt nicht.');
      const s = load();
      if (!opts.enabled) {
        delete s.appLock;
        save(s);
        return status();
      }
      const next = { enabled: true, touchId: !!opts.touchId && canTouchId(), salt: c.salt, hash: c.hash };
      if (opts.password) {
        if (opts.password.length < 4) throw new Error('Das App-Passwort muss mindestens 4 Zeichen haben.');
        next.salt = crypto.randomBytes(16).toString('base64');
        next.hash = hash(opts.password, next.salt).toString('base64');
      }
      if (!next.hash) throw new Error('Bitte ein App-Passwort festlegen.');
      s.appLock = next;
      save(s);
      unlocked = true; // wer es gerade einstellt, ist schon drin
      return status();
    });
  }

  return { register, status, isLocked: () => status().locked };
}

module.exports = { createAppLock };
