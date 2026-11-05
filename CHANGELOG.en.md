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

### New
- **Multiple windows:** “New window” with Cmd+N (Mac) or Ctrl+Shift+N (Windows/Linux), from the command palette, or on the Mac from the Dock and File menu.
- **Move tabs between windows:** right-click a tab → “Move tab to new window” or “Move tab to Window 2” – or simply drag the tab out of the tab bar (new window) or onto another window. The connection stays open and the terminal content comes along – no reconnecting.
- **Restore session with all windows:** after a restart or update, all windows are back – with their position, size and tabs.
- **Remote desktop (VNC):** New “Desktop” view next to Terminal, Files and Overview – shows the server’s screen. The connection runs encrypted through SSH, no VNC port has to be opened to the network. Set up per connection (address or display like “:1”, password, picture quality, view only). In the view: fit or 1:1, full screen, Ctrl+Alt+Del, clipboard both ways and keyboard help.
- **Find VNC servers:** One click checks whether a VNC server runs on the server and suggests the ports. If none is running, the app explains clearly how to set one up (TigerVNC, x11vnc, Raspberry Pi).

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
