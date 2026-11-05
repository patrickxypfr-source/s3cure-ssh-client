#!/usr/bin/env bash
# S3cure Agent installieren oder aktualisieren (Debian/Ubuntu mit systemd, als root).
#
#   sudo ./install.sh                                  Agent installieren/aktualisieren
#   sudo ./install.sh --domain ops.example.com         … und nginx bzw. Caddy mit HTTPS dafür einrichten
#
# Programm: /opt/s3cure-agent   Daten (Benutzer, Schlüssel, Protokoll): /var/lib/s3cure-agent
# Erneut ausführen = Update. Benutzer und Daten bleiben erhalten.
set -euo pipefail

DOMAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1;31m▸\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✕ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Bitte als root ausführen (sudo ./install.sh)."
[ -d /run/systemd/system ] || die "Dieser Server nutzt kein systemd – der Agent braucht systemd."
SRC="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SRC/package.json" ] && [ -f "$SRC/bin/s3cure-agent.js" ] || die "install.sh bitte aus dem entpackten s3cure-agent-Ordner starten."
if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'; then
  die "Ungültige Domain: $DOMAIN"
fi

# ---------- Node.js (mindestens 18) ----------
need_node() { ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; }
if need_node; then
  say "Installiere Node.js …"
  command -v apt-get >/dev/null 2>&1 || die "Bitte Node.js 18 oder neuer installieren (kein apt gefunden)."
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm >/dev/null
  need_node && die "Node.js ist zu alt ($(node -v)). Bitte Node.js 18+ installieren, z. B. über https://deb.nodesource.com"
fi
command -v npm >/dev/null 2>&1 || { apt-get install -y -qq npm >/dev/null || die "npm fehlt."; }
ok "Node.js $(node -v)"

# ---------- Programm kopieren ----------
say "Kopiere den Agenten nach /opt/s3cure-agent …"
install -d -m 755 /opt/s3cure-agent
for item in bin lib public package.json package-lock.json README.md; do
  [ -e "$SRC/$item" ] || continue
  rm -rf "/opt/s3cure-agent/$item.new"
  cp -a "$SRC/$item" "/opt/s3cure-agent/$item.new"
  rm -rf "/opt/s3cure-agent/$item"
  mv "/opt/s3cure-agent/$item.new" "/opt/s3cure-agent/$item"
done
( cd /opt/s3cure-agent && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null )
chmod 755 /opt/s3cure-agent/bin/s3cure-agent.js
ln -sf /opt/s3cure-agent/bin/s3cure-agent.js /usr/local/bin/s3cure-agent
install -d -m 700 /var/lib/s3cure-agent
ok "Programm installiert"

# ---------- systemd-Dienst ----------
# Genauer Pfad zu node (systemd kennt den PATH der Shell nicht, z. B. bei nvm)
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/s3cure-agent.service <<'UNIT'
[Unit]
Description=S3cure Agent (Server-Status und Steuerung fürs Handy)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env node /opt/s3cure-agent/bin/s3cure-agent.js serve
ExecReload=/bin/kill -HUP $MAINPID
Environment=NODE_ENV=production
Restart=always
RestartSec=3
User=root
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=/var/lib/s3cure-agent

[Install]
WantedBy=multi-user.target
UNIT
sed -i "s|^ExecStart=/usr/bin/env node |ExecStart=$NODE_BIN |" /etc/systemd/system/s3cure-agent.service
systemctl daemon-reload
systemctl enable s3cure-agent >/dev/null 2>&1
systemctl restart s3cure-agent
sleep 1
systemctl is-active --quiet s3cure-agent || { journalctl -u s3cure-agent -n 20 --no-pager; die "Der Agent startet nicht (siehe oben)."; }
ok "Dienst s3cure-agent läuft (nur lokal auf 127.0.0.1:7777)"

# ---------- Optional: HTTPS über nginx oder Caddy ----------
if [ -n "$DOMAIN" ]; then
  if command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
    if grep -q "^$DOMAIN" /etc/caddy/Caddyfile; then
      ok "Caddy: $DOMAIN ist schon eingetragen"
    else
      cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-s3cure-$(date +%Y%m%d%H%M%S)"
      printf '\n# S3cure Agent\n%s {\n\treverse_proxy 127.0.0.1:7777 {\n\t\tflush_interval -1\n\t}\n}\n' "$DOMAIN" >> /etc/caddy/Caddyfile
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || die "Caddy-Konfiguration ungültig – Sicherung liegt neben /etc/caddy/Caddyfile."
      systemctl reload caddy
      ok "Caddy: https://$DOMAIN eingerichtet (Zertifikat holt Caddy selbst)"
    fi
  elif command -v nginx >/dev/null 2>&1; then
    CONF=/etc/nginx/sites-available/s3cure-agent.conf
    cat > "$CONF" <<NGINX
# S3cure Agent – erstellt von install.sh
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:7777;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
NGINX
    ln -sf "$CONF" /etc/nginx/sites-enabled/s3cure-agent.conf
    nginx -t >/dev/null 2>&1 || { rm -f /etc/nginx/sites-enabled/s3cure-agent.conf; die "nginx-Konfiguration ungültig – nichts geändert."; }
    systemctl reload nginx
    ok "nginx: $DOMAIN → Agent"
    if ! command -v certbot >/dev/null 2>&1; then
      say "Installiere certbot …"
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
    fi
    say "Hole HTTPS-Zertifikat für $DOMAIN (der DNS-Eintrag muss schon auf diesen Server zeigen) …"
    certbot --nginx -d "$DOMAIN" --redirect || die "Zertifikat fehlgeschlagen. DNS prüfen und dann: certbot --nginx -d $DOMAIN --redirect"
    ok "HTTPS für $DOMAIN eingerichtet"
  else
    die "Weder nginx noch Caddy gefunden. Installiere einen der beiden (z. B. apt install caddy) und starte install.sh erneut mit --domain."
  fi
  s3cure-agent set publicUrl "https://$DOMAIN" >/dev/null
  systemctl restart s3cure-agent
fi

# ---------- Wie geht es weiter? ----------
echo
if [ ! -s /var/lib/s3cure-agent/users.json ] || [ "$(cat /var/lib/s3cure-agent/users.json)" = "{}" ]; then
  say "Jetzt deinen Benutzer anlegen (zeigt den QR-Code für die Authenticator-App):"
  echo "    s3cure-agent user add <dein-name> --admin"
fi
if [ -n "$DOMAIN" ]; then
  say "Danach auf dem iPhone in Safari öffnen: https://$DOMAIN"
else
  say "Von außen erreichbar machen (HTTPS):  sudo ./install.sh --domain ops.deine-domain.de"
fi
say "Auf dem iPhone: Teilen → „Zum Home-Bildschirm“ – dann Mitteilungen in der App einschalten."
