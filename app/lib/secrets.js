// Kleiner verschlüsselter Speicher (Electron safeStorage) für Geheimnisse wie Schlüssel-Passphrasen.
// In der Datei steht nur verschlüsselter Text.
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

function createSecretStore(file) {
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const save = store => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  };
  return {
    has: name => name in load(),
    read(name) {
      const enc = load()[name];
      if (!enc || !safeStorage.isEncryptionAvailable()) return null;
      try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
    },
    write(name, value) {
      if (!safeStorage.isEncryptionAvailable()) return false;
      const store = load();
      store[name] = safeStorage.encryptString(value).toString('base64');
      save(store);
      return true;
    },
    remove(name) {
      const store = load();
      if (!(name in store)) return;
      delete store[name];
      save(store);
    },
  };
}

module.exports = { createSecretStore };
