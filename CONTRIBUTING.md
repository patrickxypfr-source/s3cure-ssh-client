# Mitmachen

Danke fürs Mithelfen! Diese Seite erklärt kurz, wie man S3cure startet, testet und was beim Ändern zu beachten ist.
Die Oberfläche gibt es auf **Deutsch und Englisch**, einfach formuliert – Nutzer sind keine Entwickler. Wie Texte übersetzt werden, steht unten unter „Texte und Übersetzungen“.

## Starten

Voraussetzung: [Node.js](https://nodejs.org) 22 oder neuer.

```bash
cd app
npm install
npm start
```

## Tests

Es gibt zwei Arten von Tests, beide mit dem in Node eingebauten `node:test` (keine zusätzlichen Pakete):

| Befehl | Was wird geprüft | Dauer |
|---|---|---|
| `npm test` | **Einheitentests** in `app/test/unit/`: einzelne Funktionen ohne Fenster und ohne Netz – z. B. Versionsvergleich für Updates, Import aus `~/.ssh/config`, Platzhalter in Befehlsknöpfen, Tunnel-Eingaben, Schlüssel erzeugen, „Was ist neu?“, Fenster-Zuordnung und Sitzung | wenige Sekunden |
| `npm run test:integration` | **Integrationstest** in `app/test/integration/`: startet die echte App (Electron) und einen eigenen SSH-Server, verbindet sich, führt einen Befehl im Terminal aus, öffnet Ordner, lädt Dateien hoch und herunter und speichert im Editor. `windows.test.mjs`: mehrere Fenster – Tab verschieben ohne Neuverbinden, Übertragung im zweiten Fenster, Fenster schließen, Tab herausziehen, Neustart mit allen Fenstern; dazu Remote Desktop (VNC) gegen einen eigenen VNC-Server: Bild, Maus, Tastatur, Zwischenablage; `vault.test.mjs` prüft den Tresor (Eintrag mit Schlüssel anlegen, Verbindung verknüpfen und verbinden, Kopieren nach Entsperren, Löschen) | ca. 1 Minute |

### Integrationstest einrichten

**Linux** (so läuft er auch bei GitHub Actions):

```bash
sudo apt install openssh-server xvfb
# für den Remote-Desktop-Test (VNC), sonst wird er übersprungen:
sudo apt install tigervnc-standalone-server tigervnc-tools x11-utils xclip iproute2
cd app
xvfb-run -a npm run test:integration
```

`xvfb-run` stellt einen unsichtbaren Bildschirm bereit. Der Test startet einen **eigenen** `sshd` auf einem freien Port von `127.0.0.1` – der System-SSH-Server wird weder gebraucht noch verändert.

**macOS**: `npm run test:integration` – gedacht ist, dass der eingebaute `/usr/sbin/sshd` genügt („Entfernte Anmeldung“ muss nicht eingeschaltet sein). Auf dem Mac ist das noch nicht ausprobiert – läuft er dort nicht, bitte melden.

So bleibt dein Rechner unberührt:
- eigener Konfigurationsordner über `S3CURE_CONFIG_DIR` (statt `~/.myssh`) und eigener Home-Ordner (statt `~/.ssh`, Downloads)
- Datei-Dialoge werden im Test durch feste Antworten ersetzt (über den Inspector des Hauptprozesses)
- alles liegt in einem Temp-Ordner, der danach gelöscht wird
- die Anfrage nach neuen Versionen geht an einen kleinen Test-Server statt an GitHub

Fehlt `sshd` oder ein Bildschirm, wird der Integrationstest übersprungen (nicht rot).

### Testhaken (Umgebungsvariablen)

| Variable | Wirkung |
|---|---|
| `S3CURE_CONFIG_DIR` | anderer Ordner statt `~/.myssh` |
| `S3CURE_PLATFORM` | Verhalten eines anderen Systems ausprobieren: `darwin`, `win32`, `linux` |
| `S3CURE_UPDATE_URL` | Update-Abfrage an einen lokalen Server statt an GitHub |
| `S3CURE_EXPECT_KIND` | nur Rauchtest (`tools/smoke-test.mjs`): erwartete Update-Art, z. B. `linux-appimage` |

### Neue Tests schreiben

- Einheitentest: `app/test/unit/<bereich>.test.js` anlegen – wird von `npm test` automatisch gefunden.
- Reine Funktionen am besten im Hauptprozess-Modul (`app/lib/<feature>.js`) exportieren, dann sind sie ohne Electron testbar.
- Testnamen deutsch und als Satz: `test('isNewer vergleicht Zahl für Zahl', …)`.

## Automatische Prüfung bei GitHub

Bei jedem Push und Pull Request läuft `.github/workflows/build.yml`:

1. **Tests** (Ubuntu): Syntax, Einheitentests, Integrationstest
2. erst wenn alles grün ist: **Bauen** für Mac (Apple-Chip, Intel), Windows und Linux, jeweils mit kurzem Startversuch
3. bei einem Tag `v1.2.3`: **Release** mit allen Installern

## Mehrere Fenster

Die App kann mehrere Fenster haben; ein Tab lässt sich zwischen ihnen verschieben, ohne neu zu verbinden. Verbindungen, Tunnel, Übertragungen usw. gehören dem **Hauptprozess**, ein Fenster zeigt sie nur an. Für neue Features im Hauptprozess heißt das:

- **Kein festes Fenster** (`win`, `getWin()` als „das“ Fenster) annehmen. Die Zuordnung Tab → Fenster kennt `app/lib/windows.js`.
- Ereignis zu einem Tab: `windows.sendTab(tabId, 'kanal', …)` – geht nur an das Fenster dieses Tabs und wird beim Verschieben kurz zurückgehalten, damit nichts verloren geht.
- Ereignis für alle (Host-Liste, Einstellungen, Update-Hinweis): `windows.sendAll(…)`. Liste mit `tabId`-Feldern: `windows.sendList(…)` (jedes Fenster bekommt seine Einträge).
- Dialoge und Rückfragen: `windows.current()` – das Fenster, aus dem der IPC-Aufruf kam (sonst das zuletzt aktive).
- Schließen oder Neuladen eines Fensters beendet nur dessen Tabs (`main.js`, `closeTabs`).
- Verschieben: `app/lib/window-tabs.js` (Hauptprozess) und `app/src/windows.js` (Oberfläche, Terminal-Inhalt per `@xterm/addon-serialize`). Was ein Feature pro Tab in der Oberfläche merkt, geht beim Verschieben verloren, wenn es nicht im Hauptprozess liegt – z. B. Editor-Inhalte (es wird vorher gefragt) und ein laufender Mitschnitt (er endet beim Verschieben).

## Texte und Übersetzungen

Kein Text steht direkt im Code, sondern als Schlüssel in den Wörterbüchern `app/src/locales/de.js` und `app/src/locales/en.js`:

- Oberfläche: `t('bereich.name', { platzhalter })` (global, aus `app/src/i18n.js`), Datum/Zahlen mit `I18N.locale` bzw. `I18N.fmtNumber()`/`I18N.fmtDateTime()`.
- Statisches HTML: `data-i18n="schlüssel"`, `data-i18n-html`, `data-i18n-title`, `data-i18n-placeholder`, `data-i18n-aria-label` (der deutsche Text bleibt als Lesehilfe im HTML stehen).
- Hauptprozess: `const { t } = require('./i18n')` (`app/lib/i18n.js`) – `t()` erst beim Gebrauch aufrufen, nicht beim Laden des Moduls.
- Werte: Text mit `{platzhalter}`, Plural als `{ one: '{count} Datei', other: '{count} Dateien' }`, oder notfalls eine Funktion.
- Jeder Schlüssel muss in **beiden** Dateien stehen. `npm test` prüft das (über `app/tools/i18n-check.mjs`) und meldet auch übersehene deutsche Texte im Code. Muss eine Zeichenkette absichtlich deutsch bleiben (z. B. ein regulärer Ausdruck für Server-Ausgaben), bekommt die Zeile den Kommentar `// i18n-ignore`.
- Direkt prüfen: `node app/tools/i18n-check.mjs`
- Sprache: Einstellungen → Allgemein (System/Deutsch/English). Zum Testen erzwingt `S3CURE_LANG=de` bzw. `en` die Sprache.

## Was ist neu? (CHANGELOG.md, CHANGELOG.en.md)

Jede für Nutzer sichtbare Änderung bekommt eine Zeile in [`CHANGELOG.md`](CHANGELOG.md) unter **„Unveröffentlicht“** und dieselbe Zeile auf Englisch in [`CHANGELOG.en.md`](CHANGELOG.en.md) unter **„Unreleased“** (Überschriften `### New`, `### Improved`, `### Fixed`) – kurz, deutsch, aus Sicht der Nutzer („Dateien lassen sich jetzt …“), nicht aus Sicht des Codes.

Beim Release wird die Überschrift „Unveröffentlicht“ bzw. „Unreleased“ in beiden Dateien in `## 1.2.3 – JJJJ-MM-TT` umbenannt. Der Release-Text enthält dann zuerst den deutschen Abschnitt, danach (nach der Zeile `<!-- lang:en -->`) den englischen; die App zeigt den Teil in ihrer Sprache (ohne englischen Teil: Deutsch). Die Markierungszeile nicht selbst ins CHANGELOG schreiben. Der Release-Job nimmt genau diesen Abschnitt als Release-Text, und die App zeigt ihn im Update-Fenster und nach dem Update als „Was ist neu in 1.2.3“. Nur einfache Überschriften (`### Neu`, `### Verbessert`, `### Behoben`) und Listen verwenden – HTML wird nicht dargestellt.

Vorschau des Release-Texts:

```bash
node app/tools/release-notes.mjs 1.2.3
```

## Regeln

- Neue Funktionen möglichst in **eigene Dateien** (`app/src/<feature>.js`, `app/lib/<feature>.js`) und nur kleine Einhängepunkte in `main.js`, `renderer.js`, `preload.js` – mehrere Leute arbeiten parallel.
- Design: flach und ruhig, Farben über die CSS-Variablen aus `app/src/style.css` (hell/dunkel, Akzent Rot). Icons über `icon('name')`.
- Keine Skripte von CDNs laden (die Sicherheitsrichtlinie erlaubt nur lokale Dateien).
- Inhalte von außen (Server, GitHub) nie als HTML einsetzen – `textContent` statt `innerHTML`.
- Keine Geheimnisse ins Repo. Löschen und Überschreiben immer mit Rückfrage.
- Die Versionsnummer in `app/package.json` ändert nur, wer ein Release macht.
