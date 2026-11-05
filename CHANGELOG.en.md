# What’s New?

Here you’ll find what changed in each version – short and easy to understand.
The app shows the section for the new version in the update window and after the first start.

<!--
How to write a section (for contributors):
- This is the English version of CHANGELOG.md – every entry belongs in both files, with the same version headings.
- Collect new entries under “Unreleased” first.
- On release, rename the heading to “## x.y.z – YYYY-MM-DD” (matching the tag vX.Y.Z).
- Write for users: what you can do now, not how it’s programmed.
- Only simple lists and headings (### New, ### Improved, ### Fixed).
-->

## [Unreleased]

## 1.7.0 – 2026-11-05

### New
- **Database view (PostgreSQL):** new “Database” view next to Terminal and Files. The connection runs through SSH – the database never has to be open to the network. “Take from .env” reads the credentials (`DATABASE_URL` or `POSTGRES_*`) straight from the server’s .env files. Browse, sort, search and page through tables; change cells with a double-click and delete rows – only via the primary key, always confirmed and only if exactly one row is affected. Run SQL (commands that change data ask first), save results as CSV.
- **Security check:** under Overview → “Security” every server gets a grade from A to F: root login with password, password login, firewall, protection against password guessing (fail2ban), pending updates, automatic security updates, open ports (e.g. a database reachable from the internet), expiring certificates, clock. “Fix” shows the exact command and runs it visibly in the terminal only after you confirm. Turning off password login is only offered while you are signed in with a key – so you can’t lock yourself out.
- **.env manager:** under Overview → “.env” S3cure finds all .env files on the server. Values stay hidden until you reveal them. Comparing with e.g. `.env.example` shows missing keys (take them over with a click). Before every save the app creates a backup on the server (`~/.s3cure/env-backups`, not in the project folder); backups can be restored. If the file changed in the meantime, nothing is overwritten.

### Fixed
- **Updates after renaming the GitHub account:** the app now also finds installers when the project’s account was renamed (as long as the repo name stays the same). Note: if you still have version 1.5.1 or older, download 1.6.0 once from GitHub – after that, updates work with the button again.

## 1.6.0 – 2026-11-05

### New
- **Local terminal:** a tab with your own computer’s console right next to your servers – button next to “+” in the connections list, Cmd+Shift+T (Mac) or Ctrl+Shift+T, or via the command palette. Mac/Linux: your usual shell (zsh/bash), Windows: PowerShell.
- **All servers at a glance:** at the bottom of the sidebar under “All servers”: one card per connection with status, CPU, memory, disk, uptime and failed services. The app checks in the background (every 15 min by default) and sends a notification when a server is unreachable, the disk is almost full, memory runs low or a service fails – and when it’s back. It never asks for passwords: servers without a saved sign-in show “Sign-in needed”.
- **Notification when a long command finishes:** if a command runs longer than 30 seconds while you’re in another app or tab, S3cure lets you know when it’s done. The tab gets a red dot. Adjustable under Settings → Notifications.

## 1.5.1 – 2026-11-05

### Improved
- **Command buttons no longer clear the terminal:** instead of wiping everything, each button (Status, Check, Logs …) adds a divider with a coloured name tag and the time – red for normal commands, green with “● LIVE” for live logs, yellow for commands that ask first (Restart, Stop …). Earlier output stays – just scroll up.
- **Clearer messages in the terminal:** “Connection lost”, “Reconnected”, “Connection closed” and errors now have colour and a small symbol (⚠ ✓ ○ ✕).
- **More modern scrollbars:** In the terminal and in all lists, scrollbars are now slim, rounded pills with a little space to the edge. They get slightly wider and clearer when you hover over them.

## 1.5.0 – 2026-11-05

### New
- **Multiple windows:** “New window” with Cmd+N (Mac) or Ctrl+Shift+N (Windows/Linux), from the command palette, or on the Mac from the Dock and File menu.
- **Move tabs between windows:** right-click a tab → “Move tab to new window” or “Move tab to Window 2” – or simply drag the tab out of the tab bar (new window) or onto another window. The connection stays open and the terminal content comes along – no reconnecting.
- **Restore session with all windows:** after a restart or update, all windows are back – with their position, size and tabs.
- **Remote desktop (VNC):** New “Desktop” view next to Terminal, Files and Overview – shows the server’s screen. The connection runs encrypted through SSH, no VNC port has to be opened to the network. Set up per connection (address or display like “:1”, password, picture quality, view only). In the view: fit or 1:1, full screen, Ctrl+Alt+Del, clipboard both ways and keyboard help.
- **Find VNC servers:** One click checks whether a VNC server runs on the server and suggests the ports. If none is running, the app explains clearly how to set one up (TigerVNC, x11vnc, Raspberry Pi).
- **Credential vault:** save user name, password and SSH key once as an entry (e.g. “Company login”) and pick it for as many connections as you like under “Credentials” in the connection dialog. Change the password in the entry and it applies to all of them right away – including FTP/FTPS and jump servers. The key can be a file or stored encrypted in the vault.
- You’ll find the vault in Settings and under “Keys & Servers”: search, create, edit, delete (showing which connections use the entry) and **generate strong passwords** with an adjustable length.
- Secrets are never shown just like that: “Show” hides them again after 10 seconds, “Copy” clears the clipboard after 30 seconds. With the app lock turned on, you can choose to be asked for the app password or Touch ID first.
- Backup and cloud sync include the vault entries – passwords and keys only with the “Include saved passwords” or “Also sync saved passwords” checkbox.

### Improved
- Each window stands on its own: transfers, tunnels, questions and messages appear in the window of their tab. Closing a window only ends that window’s connections.
- New connections and changed settings show up right away in all open windows.
- Mac: after closing the last window, the app stays in the Dock as usual. Clicking the Dock icon brings the window back with its tabs.

## 1.4.0 – 2026-11-05

### Improved
- **A look with a bit of depth:** Buttons, switches, input fields and cards now look slightly three-dimensional – buttons gently stand out and press in when clicked, input fields are slightly recessed. In light and dark mode; everything works the same as before.

### Fixed
- After switching the language (window reload), old connections and tunnels stayed open in the background – they are now closed properly.

## 1.3.0 – 2026-11-05

### New
- **English:** The app is now available in English too. Choose the language in Settings → General – by default it follows your system language.

### Fixed
- **Settings → Terminal:** The “Font” and “Scrollback” dropdowns are normal width again – no sideways scrolling or squashed labels.

## 1.2.0 – 2026-11-05

### New
- **Sync folders:** Compare a folder on your computer with one on the server and match them with one click – in one or both directions, with a preview and exclusions (e.g. `node_modules`).
- **Keep a server folder up to date:** Every file you save on your computer is uploaded automatically.
- **Edit in your own editor:** Open server files in e.g. VS Code – every save uploads them again automatically.
- **Compare files:** See the differences between two files side by side, in color.
- **Pause and resume transfers**, continue interrupted transfers, run several at once and set a speed limit.
- **Bookmarks** for folders, Back/Forward and columns for permissions, owner and group.
- **Restore session:** After a restart or update, your tabs are back.
- **Backup & move:** Export all connections encrypted and import them on another computer – optionally synced automatically via iCloud or OneDrive.
- **FTP and FTPS** for web hosting plans without SSH.
- **Command palette** with Cmd/Ctrl+K: connections, tabs, commands and actions from the keyboard.
- **Up to four terminals** in one tab, and command buttons that work for all servers.
- **Overview:** See the server’s services and Docker containers, start and stop them and view their logs.
- **Keys & servers:** Manage known servers and your own SSH keys, a clear warning when a server key has changed, agent forwarding and connecting through a proxy.
- **Linux version** as an AppImage (64-bit), also with automatic updates.
- **“What’s new?”**: After an update, the app briefly shows what has changed.

### Improved
- Every new version is tested automatically before it’s released.
- The transfer list collapses by itself when it’s done and no longer gets in the way when you drag files.

## 1.1.0 – 2026-11-04

### Terminal
- Multiple servers in tabs, light and dark design, collapsible sidebar
- Reconnects automatically after a Wi-Fi change, sleep or a dropped connection
- Search in the terminal, clickable links, font size from the keyboard
- Split view: two terminals side by side on the same server
- Record a session as a text file
- “Send to all”: type into several servers at once
- Your own command buttons per server – with icons, confirmation before dangerous commands, input fields, drop-down menus and export/import
- Helper bar for nano (save & close with one click)
- Server overview: CPU, RAM, disk and uptime

### Files
- File browser with upload, download, rename, new folder and delete (with confirmation)
- “My Computer”: your own files on the left, the server on the right – simply drag files and folders back and forth
- Multiple selection by dragging a frame, Cmd/Ctrl-click and Shift-click
- Built-in editor with line numbers and search – edit configuration files right on the server
- Preview for images and text, change permissions, create and extract ZIP files
- Live search in the folder or across the whole server, transfer list with progress

### Connections & Security
- Saved connections with groups, colors and search
- Log in with password, SSH key or SSH agent; jump servers; import from ~/.ssh/config
- Create SSH keys and copy them to the server with one click
- Port forwarding (tunnels): local, remote and as a SOCKS proxy
- Passwords stored encrypted, host keys are verified
- Optional app lock with password or Touch ID

### Updates
- The app shows new versions by itself and installs them with one click on “Update”
- Proper installers for Mac (DMG) and Windows (Setup)
