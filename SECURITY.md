# Security Policy · Sicherheit

## Reporting a vulnerability

Please **do not** open a public issue for security problems.
Report them privately via **[GitHub Security Advisories](https://github.com/s3cureofficial/s3cure-ssh-client/security/advisories/new)** (“Report a vulnerability”).

Please include the app version (bottom-left in the app), your operating system, and steps to reproduce. You'll get an answer as soon as possible; fixes ship as a normal update that the app offers automatically.

## Sicherheitslücke melden

Bitte Sicherheitsprobleme **nicht** als öffentliches Issue melden, sondern vertraulich über **[GitHub Security Advisories](https://github.com/s3cureofficial/s3cure-ssh-client/security/advisories/new)** („Report a vulnerability“).

Bitte Version (unten links in der App), Betriebssystem und die Schritte zum Nachstellen angeben. Korrekturen kommen als normales Update, das die App selbst anbietet.

## Supported versions · Unterstützte Versionen

Only the latest release receives fixes – the app updates itself with one click.
Nur die neueste Version bekommt Korrekturen – die App aktualisiert sich mit einem Klick.

## How S3cure protects your data · So schützt S3cure deine Daten

- Passwords and passphrases are encrypted with the operating system's keychain (macOS Keychain, Windows DPAPI, Linux Secret Service) via Electron `safeStorage`.
- Server host keys are checked and remembered (trust on first use); changed keys trigger a clear warning.
- Tunnel ports listen on `127.0.0.1` only.
- Updates are downloaded only from this repository's releases and checked before installing (size; on macOS also code signature and version number).
- No accounts, no telemetry. The app only talks to your servers and to GitHub (update check).
