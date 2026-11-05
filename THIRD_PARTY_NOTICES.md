# Third-party notices / Fremde Bibliotheken

S3cure SSH Client itself is MIT licensed (see [LICENSE](LICENSE)). The app ships the following
libraries from other projects (installed via npm, unchanged, from `app/node_modules`). Their full
license texts are included in the respective package folders of every build.

S3cure SSH Client selbst steht unter der MIT-Lizenz (siehe [LICENSE](LICENSE)). Mitgeliefert werden
diese Bibliotheken anderer Projekte (über npm installiert, unverändert, aus `app/node_modules`).
Die vollständigen Lizenztexte liegen in jedem Build im jeweiligen Paketordner.

| Library | Used for | License | Source |
|---|---|---|---|
| noVNC (`@novnc/novnc`) | Remote desktop (VNC) view | MPL-2.0 (core); vendored `pako`: MIT | https://github.com/novnc/noVNC |
| ws | Local WebSocket bridge for the remote desktop | MIT | https://github.com/websockets/ws |
| ssh2 | SSH and SFTP | MIT | https://github.com/mscdex/ssh2 |
| xterm.js (`@xterm/xterm`, `@xterm/addon-*`) | Terminal | MIT | https://github.com/xtermjs/xterm.js |
| basic-ftp | FTP / FTPS | MIT | https://github.com/patrickjuchli/basic-ftp |
| Electron | App runtime | MIT (+ Chromium licenses, see `LICENSES.chromium.html` in the build) | https://github.com/electron/electron |

## noVNC (MPL-2.0)

noVNC is Copyright (C) The noVNC authors. The noVNC core library is licensed under the
Mozilla Public License 2.0 (https://www.mozilla.org/MPL/2.0/). S3cure uses the unmodified files
from the npm package `@novnc/novnc` (`app/node_modules/@novnc/novnc/core/…`, loaded by
`app/src/vnc-loader.js`). The source code of noVNC is available at https://github.com/novnc/noVNC;
the license text is in `app/node_modules/@novnc/novnc/LICENSE.txt`.

noVNC wird unverändert aus dem npm-Paket verwendet; der Quelltext ist unter
https://github.com/novnc/noVNC erhältlich, der Lizenztext liegt in
`app/node_modules/@novnc/novnc/LICENSE.txt`.
