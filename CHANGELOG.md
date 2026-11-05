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
- **Mehrere Fenster:** „Neues Fenster“ mit Cmd+N (Mac) bzw. Strg+Umschalt+N (Windows/Linux), über die Befehlspalette oder auf dem Mac über das Dock- und Ablage-Menü.
- **Tabs zwischen Fenstern verschieben:** Rechtsklick auf einen Tab → „Tab in neues Fenster verschieben“ oder „Tab in Fenster 2 verschieben“ – oder den Tab einfach aus der Tab-Leiste herausziehen (neues Fenster) bzw. auf ein anderes Fenster ziehen. Die Verbindung bleibt dabei bestehen, der Terminal-Inhalt wandert mit – kein Neuverbinden.
- **Sitzung wiederherstellen mit allen Fenstern:** Nach einem Neustart oder Update sind alle Fenster wieder da – mit Position, Größe und ihren Tabs.

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
