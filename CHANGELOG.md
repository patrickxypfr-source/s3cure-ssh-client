# Was ist neu?

Hier steht für jede Version, was sich geändert hat – kurz und verständlich.
Die App zeigt den Abschnitt der neuen Version im Update-Fenster und nach dem ersten Start an.

<!--
So wird ein Abschnitt geschrieben (für Mitwirkende):
- Neue Einträge zuerst unter „Unveröffentlicht“ sammeln.
- Beim Release die Überschrift in „## x.y.z – JJJJ-MM-TT“ umbenennen (passend zum Tag vX.Y.Z).
- Für Nutzer formulieren: was man jetzt tun kann, nicht wie es programmiert ist.
- Nur einfache Listen und Überschriften (### Neu, ### Verbessert, ### Behoben).
- Jeden Eintrag auch auf Englisch in CHANGELOG.en.md schreiben (gleiche Überschriften, ### New / ### Improved / ### Fixed).
-->

## [Unveröffentlicht]

### Neu
- **iPhone-App (S3cure Agent):** Ein kleiner Agent auf dem Server bringt eine App fürs iPhone – über Safari „Zum Home-Bildschirm“, kein App Store nötig. Status mit Verlauf (24 Std./7 Tage), alle Dienste und Docker-Container mit Starten, Stoppen, Neu starten und Logs (auch live), Server neu starten (nur mit frischem 2FA-Code), Mitteilungen, wenn ein Dienst ausfällt, die Platte voll wird oder ein Server nicht erreichbar ist. Anmeldung mit Passwort und 2FA, mehrere Benutzer (Admin oder „nur ansehen“), Protokoll aller Aktionen, mehrere Server in einer App. Einrichten: `s3cure-agent.tar.gz` aus dem Release, `install.sh --domain …` – Anleitung in agent/README.md.

## 1.7.0 – 2026-11-05

### Neu
- **Datenbank-Ansicht (PostgreSQL):** Neue Ansicht „Datenbank“ neben Terminal und Dateien. Die Verbindung läuft durch SSH – die Datenbank muss nicht im Netz offen sein. „Aus .env übernehmen“ liest die Zugangsdaten (`DATABASE_URL` oder `POSTGRES_*`) direkt aus den .env-Dateien des Servers. Tabellen ansehen, sortieren, durchsuchen und blättern; Zellen per Doppelklick ändern und Zeilen löschen – nur über den Primärschlüssel, immer mit Rückfrage und nur, wenn genau eine Zeile betroffen ist. SQL ausführen (Befehle, die Daten ändern, fragen vorher nach), Ergebnis als CSV speichern.
- **Sicherheits-Check:** In der Übersicht unter „Sicherheit“ bekommt jeder Server eine Note von A bis F: Root-Anmeldung per Passwort, Anmeldung mit Passwort, Firewall, Schutz vor Passwort-Raten (fail2ban), offene Updates, automatische Sicherheits-Updates, offene Ports (z. B. Datenbank öffentlich erreichbar), ablaufende Zertifikate, Uhrzeit. „Beheben“ zeigt den genauen Befehl und führt ihn erst nach deiner Bestätigung sichtbar im Terminal aus. Passwort-Anmeldung abschalten geht nur, wenn du gerade per Schlüssel angemeldet bist – damit du dich nicht aussperrst.
- **.env-Verwaltung:** In der Übersicht unter „.env“ findet S3cure alle .env-Dateien auf dem Server. Werte sind verdeckt, bis du sie aufdeckst. Vergleich mit z. B. `.env.example` zeigt fehlende Schlüssel (per Klick übernehmen). Vor jedem Speichern legt die App ein Backup auf dem Server an (`~/.s3cure/env-backups`, nicht im Projektordner); Backups lassen sich zurückholen. Wurde die Datei zwischendurch geändert, wird nichts überschrieben.

### Behoben
- **Updates nach Umbenennung des GitHub-Kontos:** Die App erkennt Installer jetzt auch, wenn das Konto des Projekts umbenannt wurde (solange der Repo-Name gleich bleibt). Hinweis: Wer noch Version 1.5.1 oder älter hat, muss 1.6.0 einmalig von GitHub herunterladen – danach klappen Updates wieder per Knopf.

## 1.6.0 – 2026-11-05

### Neu
- **Lokales Terminal:** Ein Tab mit der Konsole deines eigenen Computers direkt neben den Servern – Knopf neben „+“ bei den Verbindungen, Cmd+Umschalt+T (Mac) bzw. Strg+Umschalt+T oder über die Befehlspalette. Mac/Linux: deine gewohnte Shell (zsh/bash), Windows: PowerShell.
- **Alle Server auf einen Blick:** Unten in der Seitenleiste unter „Alle Server“: eine Karte pro Verbindung mit Ampel, CPU, Arbeitsspeicher, Platte, Laufzeit und ausgefallenen Diensten. Die App prüft im Hintergrund (Standard alle 15 Min.) und schickt eine Mitteilung, wenn ein Server nicht erreichbar ist, die Platte fast voll ist, der Arbeitsspeicher knapp wird oder ein Dienst ausfällt – und wenn er wieder da ist. Dabei fragt sie nie nach Passwörtern: Server ohne gespeicherte Anmeldung erscheinen als „Anmeldung nötig“.
- **Mitteilung, wenn ein langer Befehl fertig ist:** Läuft ein Befehl länger als 30 Sekunden und du bist gerade in einem anderen Programm oder Tab, meldet sich S3cure, sobald er durch ist. Der Tab bekommt einen roten Punkt. Einstellbar unter Einstellungen → Mitteilungen.

## 1.5.1 – 2026-11-05

### Verbessert
- **Befehlsknöpfe löschen das Terminal nicht mehr:** Statt alles zu leeren, setzt jeder Knopf (Status, Check, Logs …) eine Trennlinie mit farbigem Namensschild und Uhrzeit – rot für normale Befehle, grün mit „● LIVE“ für Live-Logs, gelb für Befehle mit Rückfrage (Restart, Stop …). Die Ausgaben davor bleiben stehen – einfach hochscrollen.
- **Übersichtlichere Meldungen im Terminal:** „Verbindung verloren“, „Wieder verbunden“, „Verbindung beendet“ und Fehler haben jetzt Farbe und ein kleines Symbol (⚠ ✓ ○ ✕).
- **Modernere Scrollleisten:** Im Terminal und in allen Listen sind die Scrollleisten jetzt schmale, abgerundete Pillen mit etwas Abstand zum Rand. Beim Drüberfahren werden sie etwas breiter und deutlicher.

## 1.5.0 – 2026-11-05

### Neu
- **Mehrere Fenster:** „Neues Fenster“ mit Cmd+N (Mac) bzw. Strg+Umschalt+N (Windows/Linux), über die Befehlspalette oder auf dem Mac über das Dock- und Ablage-Menü.
- **Tabs zwischen Fenstern verschieben:** Rechtsklick auf einen Tab → „Tab in neues Fenster verschieben“ oder „Tab in Fenster 2 verschieben“ – oder den Tab einfach aus der Tab-Leiste herausziehen (neues Fenster) bzw. auf ein anderes Fenster ziehen. Die Verbindung bleibt dabei bestehen, der Terminal-Inhalt wandert mit – kein Neuverbinden.
- **Sitzung wiederherstellen mit allen Fenstern:** Nach einem Neustart oder Update sind alle Fenster wieder da – mit Position, Größe und ihren Tabs.
- **Remote Desktop (VNC):** Neue Ansicht „Desktop“ neben Terminal, Dateien und Übersicht – zeigt den Bildschirm des Servers. Die Verbindung läuft verschlüsselt durch SSH, ein VNC-Port muss nicht ins Netz geöffnet werden. Einstellbar pro Verbindung (Adresse oder Display wie „:1“, Passwort, Bildqualität, „Nur ansehen“). In der Ansicht: Anpassen oder 1:1, Vollbild, Strg+Alt+Entf, Zwischenablage hin und her und eine Tastatur-Hilfe.
- **VNC-Server finden:** Ein Klick prüft, ob auf dem Server ein VNC-Server läuft, und schlägt die Ports vor. Läuft keiner, sagt die App verständlich, wie man ihn einrichtet (TigerVNC, x11vnc, Raspberry Pi).
- **Tresor für Zugangsdaten:** Benutzername, Passwort und SSH-Schlüssel einmal als Eintrag speichern (z. B. „Firmen-Login“) und im Verbindungs-Dialog unter „Zugangsdaten“ für beliebig viele Verbindungen auswählen. Änderst du das Passwort im Eintrag, gilt es sofort für alle – auch für FTP/FTPS und Sprung-Server. Den Schlüssel kannst du als Datei angeben oder verschlüsselt im Tresor ablegen.
- Den Tresor findest du in den Einstellungen und unter „Schlüssel & Server“: Suche, Anlegen, Bearbeiten, Löschen (mit Hinweis, welche Verbindungen den Eintrag nutzen) und **starke Passwörter erzeugen** mit einstellbarer Länge.
- Geheimnisse werden nie einfach so angezeigt: „Anzeigen“ blendet sie nach 10 Sekunden wieder aus, „Kopieren“ leert die Zwischenablage nach 30 Sekunden. Mit eingeschalteter App-Sperre kannst du festlegen, dass vorher nach App-Passwort bzw. Touch ID gefragt wird.
- Backup und Cloud-Abgleich nehmen die Tresor-Einträge mit – Passwörter und Schlüssel nur mit dem Häkchen „Passwörter mitnehmen“ bzw. „Passwörter mit abgleichen“.

### Verbessert
- Jedes Fenster ist für sich: Übertragungen, Tunnel, Rückfragen und Meldungen erscheinen im Fenster des jeweiligen Tabs. Wer ein Fenster schließt, beendet nur dessen Verbindungen.
- Neue Verbindungen und geänderte Einstellungen erscheinen sofort in allen offenen Fenstern.
- Mac: Nach dem Schließen des letzten Fensters bleibt die App wie üblich im Dock. Ein Klick aufs Dock-Symbol öffnet das Fenster mit seinen Tabs wieder.

## 1.4.0 – 2026-11-05

### Verbessert
- **Neues Aussehen mit Tiefe:** Knöpfe, Umschalter, Eingabefelder und Karten wirken jetzt ganz leicht plastisch – Knöpfe heben sich sanft ab und geben beim Klicken nach, Eingabefelder sind leicht eingelassen. Hell und dunkel, die Bedienung bleibt gleich.

### Behoben
- Nach dem Umstellen der Sprache (Fenster neu laden) blieben alte Verbindungen und Tunnel im Hintergrund offen – jetzt werden sie sauber beendet.

## 1.3.0 – 2026-11-05

### Neu
- **Englisch:** Die App gibt es jetzt auch auf Englisch. Die Sprache stellst du unter Einstellungen → Allgemein ein – ab Werk richtet sie sich nach der Sprache deines Systems.

### Behoben
- **Einstellungen → Terminal:** Die Auswahlfelder „Schriftart“ und „Verlauf“ sind wieder normal breit – kein seitliches Scrollen und keine zerquetschten Beschriftungen mehr.

## 1.2.0 – 2026-11-05

### Neu
- **Ordner synchronisieren:** Ordner auf dem PC und auf dem Server vergleichen und mit einem Klick angleichen – in eine oder beide Richtungen, mit Vorschau und Ausschlüssen (z. B. `node_modules`).
- **Server-Ordner aktuell halten:** Jede Datei, die du am PC speicherst, wird automatisch hochgeladen.
- **Im eigenen Editor bearbeiten:** Server-Dateien z. B. in VS Code öffnen – jedes Speichern lädt sie automatisch wieder hoch.
- **Dateien vergleichen:** Unterschiede zwischen zwei Dateien farbig nebeneinander.
- **Übertragungen pausieren und fortsetzen**, abgebrochene Übertragungen weitermachen, mehrere gleichzeitig und ein Geschwindigkeitslimit.
- **Lesezeichen** für Ordner, Zurück/Vor und Spalten für Rechte, Besitzer und Gruppe.
- **Sitzung wiederherstellen:** Nach einem Neustart oder Update sind deine Tabs wieder da.
- **Backup & Umzug:** Alle Verbindungen verschlüsselt exportieren und auf einem anderen Rechner importieren – auf Wunsch automatisch über iCloud oder OneDrive abgleichen.
- **FTP und FTPS** für Webhosting-Pakete ohne SSH.
- **Befehlspalette** mit Cmd/Strg+K: Verbindungen, Tabs, Befehle und Aktionen per Tastatur.
- **Bis zu vier Terminals** in einem Tab und Befehlsknöpfe, die für alle Server gelten.
- **Übersicht:** Dienste und Docker-Container des Servers sehen, starten, stoppen und Logs ansehen.
- **Schlüssel & Server:** bekannte Server und eigene SSH-Schlüssel verwalten, klare Warnung bei geändertem Server-Schlüssel, Agent-Weiterleitung und Verbindung über Proxy.
- **Linux-Version** als AppImage (64 Bit), ebenfalls mit automatischen Updates.
- **„Was ist neu?“**: Nach einem Update zeigt die App kurz, was sich geändert hat.

### Verbessert
- Jede neue Version wird vor dem Veröffentlichen automatisch getestet.
- Die Übertragungsliste klappt sich nach getaner Arbeit von selbst ein und verdeckt beim Ziehen von Dateien nichts mehr.

## 1.1.0 – 2026-11-04

### Terminal
- Mehrere Server in Tabs, helles und dunkles Design, einklappbare Seitenleiste
- Automatisch neu verbinden nach WLAN-Wechsel, Ruhezustand oder Verbindungsabbruch
- Suche im Terminal, anklickbare Links, Schriftgröße per Tastatur
- Geteilte Ansicht: zwei Terminals nebeneinander auf demselben Server
- Mitschnitt einer Sitzung als Textdatei
- „An alle senden“: Eingaben gleichzeitig an mehrere Server
- Eigene Befehlsknöpfe pro Server – mit Icons, Rückfrage vor gefährlichen Befehlen, Eingabefeldern, Ausklappmenüs und Export/Import
- Hilfsleiste für nano (Speichern & schließen per Klick)
- Server-Übersicht: CPU, RAM, Platte und Laufzeit

### Dateien
- Dateibrowser mit Hochladen, Herunterladen, Umbenennen, Neuer Ordner und Löschen (mit Rückfrage)
- „Mein Computer“: eigene Dateien links, Server rechts – Dateien und Ordner einfach hin- und herziehen
- Mehrfachauswahl per Rahmen, Cmd/Strg-Klick und Umschalt-Klick
- Eingebauter Editor mit Zeilennummern und Suche – Konfigurationsdateien direkt auf dem Server bearbeiten
- Vorschau für Bilder und Text, Rechte ändern, ZIP packen und entpacken
- Live-Suche im Ordner oder auf dem ganzen Server, Übertragungsliste mit Fortschritt

### Verbindungen & Sicherheit
- Gespeicherte Verbindungen mit Gruppen, Farben und Suche
- Anmeldung mit Passwort, SSH-Schlüssel oder SSH-Agent; Sprung-Server; Import aus ~/.ssh/config
- SSH-Schlüssel erzeugen und mit einem Klick auf den Server übertragen
- Port-Weiterleitung (Tunnel): lokal, remote und als SOCKS-Proxy
- Passwörter verschlüsselt gespeichert, Host-Schlüssel werden geprüft
- Optionale App-Sperre mit Passwort oder Touch ID

### Updates
- Die App zeigt neue Versionen selbst an und installiert sie mit einem Klick auf „Update“
- Richtige Installer für Mac (DMG) und Windows (Setup)
