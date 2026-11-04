#!/usr/bin/env python3
"""myssh – ein eigener kleiner SSH-Client.

Befehle:
  myssh add NAME user@host [-p PORT] [-i SCHLÜSSEL]   Verbindung speichern
  myssh list                                          gespeicherte Verbindungen
  myssh rm NAME                                       Verbindung löschen
  myssh connect ZIEL                                  interaktive Shell
  myssh run ZIEL BEFEHL...                            einzelnen Befehl ausführen
  myssh put ZIEL LOKAL REMOTE                         Datei hochladen (SFTP)
  myssh get ZIEL REMOTE LOKAL                         Datei herunterladen (SFTP)

ZIEL ist entweder ein gespeicherter Name oder user@host[:port].
"""
import argparse
import getpass
import json
import os
import select
import shutil
import signal
import socket
import sys
import termios
import tty

import paramiko

CONFIG_DIR = os.path.expanduser("~/.myssh")
HOSTS_FILE = os.path.join(CONFIG_DIR, "hosts.json")
KNOWN_HOSTS = os.path.join(CONFIG_DIR, "known_hosts")


# ---------- gespeicherte Verbindungen ----------

def load_hosts():
    try:
        with open(HOSTS_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_hosts(hosts):
    os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
    with open(HOSTS_FILE, "w") as f:
        json.dump(hosts, f, indent=2)


def parse_target(text, port=None):
    """'user@host:port' -> dict. Ohne user wird der lokale Benutzername genommen."""
    user, _, hostpart = text.rpartition("@")
    host, _, p = hostpart.partition(":")
    return {
        "user": user or getpass.getuser(),
        "host": host,
        "port": int(port or p or 22),
        "key": None,
    }


def resolve_target(text):
    hosts = load_hosts()
    if text in hosts:
        return hosts[text]
    return parse_target(text)


# ---------- Host-Key-Prüfung (Trust on first use) ----------

class AskPolicy(paramiko.MissingHostKeyPolicy):
    def missing_host_key(self, client, hostname, key):
        fp = key.fingerprint if hasattr(key, "fingerprint") else key.get_base64()[:32]
        print(f"Unbekannter Host {hostname}.")
        print(f"{key.get_name()} Fingerprint: {fp}")
        if input("Vertrauen und speichern? [j/N] ").strip().lower() not in ("j", "ja", "y", "yes"):
            raise paramiko.SSHException("Verbindung abgelehnt: Host nicht vertraut")
        client.get_host_keys().add(hostname, key.get_name(), key)
        os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
        client.save_host_keys(KNOWN_HOSTS)


# ---------- Verbindung aufbauen ----------

def connect(target):
    client = paramiko.SSHClient()
    # Systemweite und eigene known_hosts laden
    try:
        client.load_system_host_keys()
    except IOError:
        pass
    if os.path.exists(KNOWN_HOSTS):
        client.load_host_keys(KNOWN_HOSTS)
    client.set_missing_host_key_policy(AskPolicy())

    hostname = target["host"] if target["port"] == 22 else f"[{target['host']}]:{target['port']}"
    kwargs = dict(
        hostname=target["host"],
        port=target["port"],
        username=target["user"],
        timeout=10,
    )
    if target.get("key"):
        kwargs["key_filename"] = os.path.expanduser(target["key"])

    try:
        # 1. Versuch: Schlüssel / ssh-agent / Standardschlüssel in ~/.ssh
        client.connect(**kwargs, allow_agent=True, look_for_keys=True)
    except paramiko.BadHostKeyException as e:
        sys.exit(f"WARNUNG: Host-Key von {hostname} hat sich geändert! Mögliche Man-in-the-Middle-Attacke.\n{e}")
    except paramiko.PasswordRequiredException:
        pw = getpass.getpass(f"Passphrase für Schlüssel {kwargs.get('key_filename')}: ")
        client.connect(**kwargs, passphrase=pw, allow_agent=True, look_for_keys=True)
    except paramiko.AuthenticationException:
        password_login(client, kwargs, target)
    except paramiko.SSHException as e:
        # Keine Schlüssel gefunden -> direkt Passwort probieren
        if "No authentication methods" in str(e):
            password_login(client, kwargs, target)
        else:
            sys.exit(f"Verbindung fehlgeschlagen: {e}")
    except socket.gaierror:
        msg = f"Host '{target['host']}' nicht gefunden."
        if target["host"] not in load_hosts():
            msg += (f"\nFalls das ein gespeicherter Name sein soll: es gibt keine Verbindung namens"
                    f" '{target['host']}'. Anlegen mit: myssh add {target['host']} user@host")
        sys.exit(msg)
    except socket.error as e:
        sys.exit(f"Verbindung fehlgeschlagen: {e}")
    return client


def password_login(client, kwargs, target):
    # Bis zu 3 Versuche, wie bei OpenSSH
    for _ in range(3):
        pw = getpass.getpass(f"Passwort für {target['user']}@{target['host']}: ")
        try:
            client.connect(**kwargs, password=pw, allow_agent=False, look_for_keys=False)
            return
        except paramiko.AuthenticationException:
            print("Falsches Passwort.")
    sys.exit("Anmeldung fehlgeschlagen.")


# ---------- interaktive Shell ----------

def interactive_shell(client):
    cols, rows = shutil.get_terminal_size()
    chan = client.invoke_shell(term=os.environ.get("TERM", "xterm-256color"), width=cols, height=rows)

    def on_resize(*_):
        c, r = shutil.get_terminal_size()
        chan.resize_pty(width=c, height=r)

    signal.signal(signal.SIGWINCH, on_resize)

    stdin_fd = sys.stdin.fileno()
    old_tty = termios.tcgetattr(stdin_fd)
    try:
        tty.setraw(stdin_fd)
        chan.settimeout(0.0)
        while True:
            r, _, _ = select.select([chan, sys.stdin], [], [])
            if chan in r:
                try:
                    data = chan.recv(32768)
                except socket.timeout:
                    continue
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
            if sys.stdin in r:
                data = os.read(stdin_fd, 1024)
                if not data:
                    break
                chan.send(data)
    finally:
        termios.tcsetattr(stdin_fd, termios.TCSADRAIN, old_tty)
        signal.signal(signal.SIGWINCH, signal.SIG_DFL)
    return chan.recv_exit_status() if chan.exit_status_ready() else 0


# ---------- Befehle ----------

def cmd_add(a):
    hosts = load_hosts()
    t = parse_target(a.target, a.port)
    t["key"] = a.identity
    hosts[a.name] = t
    save_hosts(hosts)
    print(f"Gespeichert: {a.name} -> {t['user']}@{t['host']}:{t['port']}")


def cmd_list(a):
    hosts = load_hosts()
    if not hosts:
        print("Noch keine Verbindungen gespeichert. Füge eine hinzu mit: myssh add NAME user@host")
        return
    w = max(len(n) for n in hosts)
    for name, t in sorted(hosts.items()):
        key = f"  (Schlüssel: {t['key']})" if t.get("key") else ""
        print(f"{name.ljust(w)}  {t['user']}@{t['host']}:{t['port']}{key}")


def cmd_rm(a):
    hosts = load_hosts()
    if hosts.pop(a.name, None) is None:
        sys.exit(f"Keine Verbindung namens '{a.name}'.")
    save_hosts(hosts)
    print(f"Gelöscht: {a.name}")


def cmd_connect(a):
    t = resolve_target(a.target)
    client = connect(t)
    print(f"Verbunden mit {t['user']}@{t['host']}. Beenden mit 'exit'.\r")
    code = interactive_shell(client)
    client.close()
    print("\nVerbindung beendet.")
    sys.exit(code)


def cmd_run(a):
    client = connect(resolve_target(a.target))
    _, out, err = client.exec_command(" ".join(a.command))
    for line in out:
        sys.stdout.write(line)
    for line in err:
        sys.stderr.write(line)
    code = out.channel.recv_exit_status()
    client.close()
    sys.exit(code)


def progress(done, total):
    pct = done * 100 // total if total else 100
    bar = "#" * (pct // 4)
    sys.stdout.write(f"\r[{bar.ljust(25)}] {pct:3d}%  {done // 1024} KB")
    sys.stdout.flush()


def cmd_put(a):
    client = connect(resolve_target(a.target))
    sftp = client.open_sftp()
    sftp.put(a.local, a.remote, callback=progress)
    print(f"\nHochgeladen: {a.local} -> {a.remote}")
    client.close()


def cmd_get(a):
    client = connect(resolve_target(a.target))
    sftp = client.open_sftp()
    sftp.get(a.remote, a.local, callback=progress)
    print(f"\nHeruntergeladen: {a.remote} -> {a.local}")
    client.close()


def main():
    p = argparse.ArgumentParser(prog="myssh", description="Eigener SSH-Client")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("add", help="Verbindung speichern")
    s.add_argument("name")
    s.add_argument("target", help="user@host[:port]")
    s.add_argument("-p", "--port", type=int)
    s.add_argument("-i", "--identity", help="Pfad zum privaten Schlüssel")
    s.set_defaults(func=cmd_add)

    s = sub.add_parser("list", help="gespeicherte Verbindungen anzeigen")
    s.set_defaults(func=cmd_list)

    s = sub.add_parser("rm", help="Verbindung löschen")
    s.add_argument("name")
    s.set_defaults(func=cmd_rm)

    s = sub.add_parser("connect", help="interaktive Shell öffnen")
    s.add_argument("target")
    s.set_defaults(func=cmd_connect)

    s = sub.add_parser("run", help="einzelnen Befehl ausführen")
    s.add_argument("target")
    s.add_argument("command", nargs=argparse.REMAINDER)
    s.set_defaults(func=cmd_run)

    s = sub.add_parser("put", help="Datei hochladen")
    s.add_argument("target")
    s.add_argument("local")
    s.add_argument("remote")
    s.set_defaults(func=cmd_put)

    s = sub.add_parser("get", help="Datei herunterladen")
    s.add_argument("target")
    s.add_argument("remote")
    s.add_argument("local")
    s.set_defaults(func=cmd_get)

    args = p.parse_args()
    try:
        args.func(args)
    except KeyboardInterrupt:
        print("\nAbgebrochen.")
        sys.exit(130)


if __name__ == "__main__":
    main()
