# S3cure Agent – deine Server auf dem iPhone

Der S3cure Agent läuft auf deinem Server und bringt dir eine **App fürs iPhone** (Web-App, kein App Store nötig):

- **Status:** CPU, Arbeitsspeicher, Platte, Laufzeit, Netzwerk und Verlauf (24 Stunden / 7 Tage)
- **Dienste:** alle systemd-Dienste, ausgefallene zuerst, starten / stoppen / neu starten, Logs (auch live)
- **Docker:** Container starten / stoppen / neu starten, Logs
- **Server neu starten:** nur mit frischem 2FA-Code
- **Mitteilungen:** sofort, wenn ein Dienst ausfällt, die Platte voll wird oder ein Server nicht erreichbar ist
- **Mehrere Server**, **mehrere Benutzer** (Admin oder „nur ansehen“), **Protokoll** aller Aktionen

## Einrichten (einmal, ca. 5 Minuten)

**1. Adresse festlegen.** Lege bei deinem Domain-Anbieter einen DNS-Eintrag an, z. B. `ops.deine-domain.de` → IP deines Servers (A-Record).

**2. Agent installieren** (auf dem Server, als root):

```bash
cd /tmp && curl -fsSL https://github.com/s3cureofficial/s3cure-ssh-client/releases/latest/download/s3cure-agent.tar.gz | tar xz
```
```bash
/tmp/s3cure-agent/install.sh --domain ops.deine-domain.de
```

Das Skript installiert Node.js (falls nötig), richtet den Agenten als Dienst ein und – mit `--domain` – nginx oder Caddy mit HTTPS-Zertifikat. Ohne `--domain` läuft der Agent nur lokal (127.0.0.1:7777).

**3. Benutzer anlegen:**

```bash
s3cure-agent user add patrick --admin
```

Es fragt nach einem Passwort und zeigt einen **QR-Code**. Scanne ihn mit deiner Authenticator-App (iPhone: Einstellungen → Passwörter, oder Google Authenticator, 1Password …).

**4. Auf dem iPhone:** Öffne `https://ops.deine-domain.de` in **Safari** → unten auf **Teilen** → **„Zum Home-Bildschirm“**. Dann die App öffnen, anmelden und unter Einstellungen **Mitteilungen einschalten** (geht ab iOS 16.4 und nur aus der App auf dem Home-Bildschirm).

## Sicherheit

- Der Agent hört nur auf `127.0.0.1`. Von außen kommt man nur über HTTPS (nginx/Caddy) an ihn heran.
- Anmeldung mit **Passwort + 2FA-Code**. Nach 5 Fehlversuchen ist die IP 15 Minuten gesperrt; jeder Code gilt nur einmal.
- Das Handy bekommt **keinen SSH-Schlüssel** – es kann nur die vorgesehenen Aktionen auslösen. Es wird nie ein Text aus der App als Befehl ausgeführt.
- `ssh`, `systemd-*`, `dbus` und der Agent selbst lassen sich in der App nicht stoppen (Neustart geht) – damit du dich nicht aussperrst.
- Server-Neustart nur für Admins und nur mit frischem 2FA-Code. Jede Aktion steht im Protokoll (`/var/lib/s3cure-agent/audit.log`).

## Befehle

| Befehl | Was es tut |
|---|---|
| `s3cure-agent user add <name> [--admin]` | Benutzer anlegen (ohne `--admin`: nur ansehen) |
| `s3cure-agent user list` / `remove <name>` | Benutzer anzeigen / löschen |
| `s3cure-agent user passwd <name>` | Passwort ändern (meldet alle Geräte ab) |
| `s3cure-agent user reset-2fa <name>` | Neuer 2FA-QR-Code (z. B. neues Handy) |
| `s3cure-agent token` | Schlüssel dieses Servers (zum Einbinden in einen anderen Agenten) |
| `s3cure-agent peer add <name> <https://…> <token>` | Weiteren Server in dieser App anzeigen |
| `s3cure-agent info` | Übersicht |
| `systemctl status s3cure-agent` / `journalctl -u s3cure-agent` | Läuft er? Logs |

**Weitere Server:** Installiere den Agenten auch dort (mit eigener Domain, z. B. `ops2.deine-domain.de`), hole mit `s3cure-agent token` dessen Schlüssel und trage ihn auf dem Haupt-Server ein: `s3cure-agent peer add backup https://ops2.deine-domain.de <token>` → `systemctl reload s3cure-agent`. Die App zeigt dann alle Server.

**Update:** Schritt 2 erneut ausführen. Benutzer und Daten bleiben erhalten.

**Entfernen:** `systemctl disable --now s3cure-agent`, danach `/opt/s3cure-agent`, `/var/lib/s3cure-agent`, `/usr/local/bin/s3cure-agent` und `/etc/systemd/system/s3cure-agent.service` löschen (und ggf. den nginx-/Caddy-Eintrag).

---

**English (short):** The S3cure Agent runs on your server and serves a mobile web app (installable on iPhone via Safari → Share → Add to Home Screen) with live status, systemd services, Docker containers, logs, server reboot (with a fresh 2FA code) and push notifications. Install: download `s3cure-agent.tar.gz` from the latest release, run `install.sh --domain ops.example.com`, then `s3cure-agent user add <name> --admin` and scan the QR code. The agent only listens on 127.0.0.1; access is HTTPS-only via nginx/Caddy with password + TOTP.
