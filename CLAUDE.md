# S3cure SSH Client

Desktop-SSH/SFTP-Client (Electron) für macOS, Windows und Linux (AppImage). Oberfläche **Deutsch und Englisch** (Texte als Schlüssel in `app/src/locales/de.js`/`en.js`, `t()` aus `src/i18n.js` bzw. `lib/i18n.js`, Prüfung `app/tools/i18n-check.mjs`), einfach formuliert (Nutzer ist kein Entwickler).

## Aufbau
- `app/main.js` – Hauptprozess: ssh2-Verbindungen, SFTP, Suche, Host-Liste, Passwörter (safeStorage), IPC (`ipcMain.handle('bereich:aktion')`).
- `app/preload.js` – Brücke (contextIsolation), stellt `window.api` bereit.
- `app/src/index.html`, `renderer.js`, `style.css`, `icons.js` – Oberfläche (kein Framework, kein Bundler). xterm.js 6 + addon-fit.
- FTP/FTPS (nur Dateien): `app/lib/ftp.js` (basic-ftp, bildet die SFTP-Schnittstelle von ssh2 nach), `app/lib/files-adapter.js` (`getSftp(tabId)` liefert SFTP oder FTP), Oberfläche `app/src/ftp-ui.js`. Felder in `hosts.json`: `protocol` (`ftp`/`ftps`/`ftps-implicit`, fehlt = SFTP), `ftpPassive`, `ftpInsecure`; gemerkte Zertifikate in `ftp_certs.json`.
- Mehrere Fenster: `app/lib/windows.js` (welcher Tab gehört zu welchem Fenster; Ereignisse eines Tabs mit `windows.sendTab(tabId, …)`, allgemeine mit `sendAll`, Dialoge an `windows.current()` – nie ein festes `win`), `app/lib/window-tabs.js` (Tab verschieben), Oberfläche `app/src/windows.js`. Verbindungen gehören dem Hauptprozess, ein Fenster zeigt sie nur an.
- Lokales Terminal: `app/lib/local-term.js` (node-pty, Bauvorbereitung `app/tools/pty-prepare.mjs`, Tab-Spec `{ local: true }`) + `app/src/local-term.js`. Alle Server: `app/lib/server-watch.js` (Hintergrund-Prüfung ohne Rückfragen, `noPrompt`) + `app/src/server-watch.js`. Mitteilung „Befehl fertig“: `app/src/cmd-notify.js`.
- Datenbank: `app/lib/db.js` (pg über lokalen Port + forwardOut) + `app/src/db-view.js` (Ansicht „db“). Übersicht-Bereiche per `Dashboard.addSection`: Sicherheit `app/lib/security-check.js` + `app/src/security-check.js`, .env `app/lib/env-files.js` + `app/src/env-core.js` (auch in Tests) + `app/src/env-manager.js` (Backups auf dem Server in `~/.s3cure/env-backups`).
- `app/tools/win-finish.mjs` – Icon/Infos in die Windows-exe (nutzt macOS-Werkzeuge `sips`/`ditto`).
- `agent/` – S3cure Agent (eigenes Node-Paket, läuft auf dem Server als root-Dienst): `lib/server.js` (API + Web-App aus `public/`, nur 127.0.0.1, HTTPS über nginx/Caddy), `lib/auth.js` (scrypt + TOTP, Rollen admin/viewer), `lib/system.js` (systemctl/journalctl/docker nur per execFile mit geprüften Namen, Demo-Modus `S3CURE_AGENT_DEMO=1`), `install.sh`, Tests `cd agent && npm test`. Release-Datei `s3cure-agent.tar.gz`.
- `myssh.py` – älteres Python-CLI. `server/s3` – Verwaltungsskript für den Server des Nutzers.
- Konfiguration: `~/.myssh/hosts.json`, `known_hosts`, `passwords.json` (verschlüsselt). Tresor für Zugangsdaten: `app/lib/vault.js` + `app/src/vault.js`, `vault.json` (Metadaten) und `vault-secrets.json` (verschlüsselt); Verbindungen verweisen per `credential: '<id>'` darauf. Testhaken: `S3CURE_CONFIG_DIR`, `S3CURE_PLATFORM` (`darwin`/`win32`/`linux`).
- Tests: `app/test/unit/*.test.js` (`npm test`), `app/test/integration/` (`xvfb-run -a npm run test:integration`, Electron + lokaler sshd). Anleitung: `CONTRIBUTING.md`.
- `CHANGELOG.md` + `CHANGELOG.en.md`: Nutzer-sichtbare Änderungen unter „Unveröffentlicht“ / „Unreleased“ eintragen (deutsch + englisch) – wird Release-Text und „Was ist neu?“ in der App.

## Regeln
- Neue Features möglichst in **eigene Dateien** (`app/src/<feature>.js`, `app/lib/<feature>.js` für den Hauptprozess) und nur kleine Einhängepunkte in `main.js`/`renderer.js`/`preload.js` – mehrere Leute arbeiten parallel.
- Design: clean, flach, CSS-Variablen aus `style.css` (hell/dunkel, Akzent Rot `--accent`). Icons über `icon('name')` aus `icons.js`.
- CSP erlaubt nur lokale Skripte (`script-src 'self'`) – nichts von CDNs laden.
- Keine Geheimnisse ins Repo. Destruktive Aktionen (Löschen, Überschreiben) immer mit Rückfrage.
- Starten: `cd app && npm install && npm start`. Bauen: `npm run build` (Mac), `npm run build:win`, `npm run build:linux`.
