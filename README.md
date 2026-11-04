<p align="center">
  <img src="app/src/logo.png" alt="S3cure Logo" width="96">
</p>

<h1 align="center">S3cure SSH Client</h1>

<p align="center">
  Ein schlanker SSH- und SFTP-Client für <b>macOS</b> und <b>Windows</b> – Terminal, Dateibrowser, Tunnel und eigene Befehlsknöpfe in einem Fenster.
</p>

<p align="center">
  <a href="../../releases/latest">Download</a> ·
  <a href="#funktionen">Funktionen</a> ·
  <a href="#selbst-bauen">Selbst bauen</a>
</p>

---

## Download

Fertige Versionen gibt es unter **[Releases](../../releases/latest)**:

| System | Datei |
|---|---|
| **Windows 10/11** – einfach starten | `S3cure-SSH-Client-Windows-Portable.exe` (eine Datei, keine Installation) |
| Windows 10/11 – als Ordner | `S3cure-SSH-Client-Windows-x64.zip` (entpacken, `S3cure SSH Client.exe` starten) |
| Mac mit Apple-Chip (M1–M4) | `S3cure-SSH-Client-Mac-AppleSilicon.zip` |
| Mac mit Intel-Chip | `S3cure-SSH-Client-Mac-Intel.zip` |

> ⚠️ Bitte **nicht** den grünen Knopf „Code → Download ZIP“ benutzen – das ist der Quellcode, kein fertiges Programm.

**Erster Start** – die App ist nicht von Apple bzw. Microsoft signiert, deshalb fragt das System einmal nach:
- **macOS:** ZIP doppelklicken, App in den Programme-Ordner ziehen und öffnen. Kommt „kann nicht geöffnet werden, da der Entwickler nicht verifiziert werden kann“: **Systemeinstellungen → Datenschutz & Sicherheit** → ganz unten **Dennoch öffnen** klicken (ältere macOS-Versionen: Rechtsklick auf die App → **Öffnen**).
- **Windows:** Bei „Der Computer wurde durch Windows geschützt“ auf **Weitere Informationen** → **Trotzdem ausführen** klicken.

## Funktionen

### Terminal
- Mehrere Verbindungen in Tabs, helles und dunkles Design, einklappbare Seitenleiste (Cmd/Strg+B)
- Zeigt unten links die eigene Version – und deutlich „Veraltet“, sobald es eine neuere gibt
- **Automatisch neu verbinden** nach WLAN-Wechsel oder Ruhezustand
- Suche im Terminal (Cmd/Strg+F), anklickbare Links, Schriftgröße per Cmd/Strg +/−
- Geteilte Ansicht: zwei Terminals nebeneinander
- Mitschnitt einer Sitzung als Textdatei
- „An alle senden“: Eingaben gleichzeitig an mehrere Server
- Eigene **Befehlsknöpfe** pro Server mit Icons – mit Rückfrage, Eingabefeldern (`{name}`), Menüs, Export/Import
- Hilfsleiste für `nano` (Speichern & schließen per Klick)

### Dateien (SFTP)
- Dateibrowser mit Hochladen, Herunterladen, Umbenennen, Löschen
- **„Mein Computer“** daneben: eigene Dateien und Server-Dateien nebeneinander, per Ziehen & Ablegen in beide Richtungen kopieren
- **Geteilte Ansicht „Mein Computer“** wie bei FileZilla: eigene Dateien links, Server rechts – Dateien und ganze Ordner einfach hin- und herziehen, mit Rückfrage vor dem Überschreiben
- **Eingebauter Editor** – Dateien direkt auf dem Server bearbeiten, Cmd/Strg+S speichert
- Vorschau für Bilder und Text (Leertaste)
- Rechte ändern (chmod), ZIP packen und entpacken
- Live-Suche über Ordner oder den ganzen Server
- Übertragungsliste mit Fortschritt und Abbrechen
- „Terminal hier öffnen“

### Verbindungen
- Gespeicherte Verbindungen mit Gruppen, Farben und Suche
- Passwörter verschlüsselt im Schlüsselbund (macOS) bzw. per DPAPI (Windows)
- SSH-Schlüssel, Schlüssel mit Passphrase, SSH-Agent
- **SSH-Schlüssel erzeugen** und mit einem Klick auf den Server übertragen
- Sprung-Server (ProxyJump)
- Import aus `~/.ssh/config`
- **Port-Weiterleitung:** lokal, remote und SOCKS-Proxy, optional automatisch beim Verbinden
- Server-Übersicht: CPU, RAM, Platte und Laufzeit des Servers
- Optionale **App-Sperre** mit Passwort oder Touch ID
- Host-Schlüssel werden geprüft und gemerkt (wie bei OpenSSH)

## Datenschutz

Alles bleibt auf deinem Rechner. Verbindungen und Einstellungen liegen in `~/.myssh`, Passwörter verschlüsselt über das Betriebssystem. Die App nimmt nur Verbindung zu deinen Servern auf – und höchstens einmal pro Stunde zu GitHub, um nach einer neuen Version zu schauen.

## Selbst bauen

Voraussetzung: [Node.js](https://nodejs.org) 22 oder neuer.

```bash
git clone https://github.com/patrickxypfr-source/s3cure-ssh-client.git
cd s3cure-ssh-client/app
npm install
npm start                # App direkt starten
```

Pakete bauen (landen in `dist/`):

```bash
npm run build            # macOS Apple Silicon
npm run build:mac-intel  # macOS Intel
npm run build:win        # Windows x64
npm run build:all        # alles
```

Bei jedem Push baut GitHub Actions alle drei Versionen automatisch. Ein Tag `v*` (z. B. `v1.1.0`) erstellt zusätzlich ein Release mit den ZIP-Dateien.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `app/main.js`, `app/lib/` | Hauptprozess: SSH ([ssh2](https://github.com/mscdex/ssh2)), SFTP, Tunnel, Einstellungen |
| `app/src/` | Oberfläche (ohne Framework), Terminal mit [xterm.js](https://xtermjs.org) |
| `app/preload.js` | Sichere Brücke zwischen Oberfläche und Hauptprozess |
| `myssh.py` | Kleines Kommandozeilen-Werkzeug (Python, paramiko) |
| `server/s3` | Verwaltungsskript für einen Beispiel-Server |

Gebaut mit [Electron](https://www.electronjs.org).
