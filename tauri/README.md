# Tauride: Ride on Tauri

Tauride is an unofficial fork of Dyalog's Ride. Its version follows the latest
Ride release (4.8.x); the name Tauride and the green icon keep it from being
mistaken for the official Ride.

This directory and `src-tauri/` run Ride's existing frontend in a
[Tauri 2](https://tauri.app) shell instead of Electron. The frontend
(`index.html`, `src/*.js`, the HTML dialogs) is unchanged apart from a few
marked lines; what Electron and Node.js provided now comes from a small
compatibility layer in the webview backed by Rust.

## Build and run

Prerequisites: Rust (stable), Node.js, `npm ci`, the Tauri CLI
(`cargo install tauri-cli --locked`) and, on Linux, WebKitGTK 4.1 and GTK 3
development files.

    cargo tauri build      # release binary: src-tauri/target/release/tauride
    cargo tauri dev        # debug build, run from the source tree

Both first run `npm run css` and `node tauri/stage.js`, which copies the
files the pages load into `_/tauri-dist` (the Electron build's `mk` filter,
with only the `node_modules` trees the pages use) and generates
`tauri-modules.js` (see below). Ride's environment variables work as before:
`RIDE_SPAWN=/usr/bin/dyalog`, `RIDE_CONNECT=host:port`, `RIDE_LOG`,
`RIDE_JS`, `RIDE_EDITOR`, `RIDE_CONF`, `RIDE_PREFS`.

Preferences, saved connections and window state live in the same place as
Electron Ride's (`~/.config/Ride-4.8` on Linux), so the two share them.

## How it works

`tauri/shim.js` is injected into every Ride window ahead of the page's own
scripts. It provides the subset of Node and Electron Ride uses:

| Ride uses | Provided by |
|---|---|
| `require`, `module.exports` | a CommonJS loader over `tauri-modules.js`, which `stage.js` writes with each module (`src/cn.js`, `buffer` and its dependencies) wrapped as a function: the pages' CSP forbids `eval` |
| `process`, `Buffer`, `__dirname` | startup data from Rust; the `buffer` package |
| `fs`, `path`, `os`, `querystring`, `os-locale` | synchronous calls to Rust (`sync.rs`), JavaScript |
| `net`, `tls` | `net.rs`: tokio sockets and servers; rustls (ring) for TLS |
| `child_process.spawn` | `proc.rs`: tokio processes |
| `ssh2` | `ssh.rs`: russh (ring) |
| `node-ipc` | Tauri events addressed to window labels (`emitTo`); the main window serves, the others are its clients; no handshake polling |
| `@electron/remote`: `BrowserWindow`, `getGlobal`, `app`, `screen`, `shell`, `clipboard` | `win.rs` (windows with Electron's numeric ids), `winstate.rs` (main.js's window geometry), `open_url` |
| `dialog.*Sync` | `dialog.rs`: GTK dialogs on Linux; task dialogs and the common item dialogs (rfd) on Windows |
| `Menu.popup()` | `menu.rs`: native popup menus |

Two channels connect the webview to Rust:

- **Synchronous**: Ride calls `fs.readFileSync`, `dialog.showMessageBoxSync`,
  `BrowserWindow.isFocused()` and the like synchronously. The shim answers
  them with synchronous XHR to a custom `ridesync://` scheme
  (`http://ridesync.localhost` on Windows, where WebView2 preflights the
  POST), which Rust serves on the main thread; window getters called there
  run inline (Tauri does not queue them on the main thread), so they cannot
  deadlock. Windows are created from an async command, as building one from
  a synchronous command deadlocks on Windows.
- **Asynchronous**: sockets, processes and windows use Tauri commands and
  events (`ride-net`, `ride-proc`, `ride-ssh`, `ride-win`, `ride-menu`).

A second scheme, `ridefile://`, serves local files to windows Ride points at
a `file://` URL outside the app (3500⌶ writes its HTML to a temp file).

Ride's frontend changes, all marked:

- `dialog.html`, `status.html`: a top-level `ipc` renamed `nodeIpc`; on
  Linux wry defines `window.ipc`, and the duplicate declaration rejected the
  whole script.
- `src/menu.js`: the HTML menu under Tauri.
- `src/init.js`: `RIDE_JS` files run through `executeJavaScript`, as Tauri
  pages cannot load `file://` scripts.
- `src/abt.js`: About reports Tauri and the webview instead of Electron,
  Chrome and Node.

## Status

Verified against Dyalog 20.0 on Linux (Hyprland): spawning an interpreter,
connecting to a serving one, connecting and starting through SSH, TLS
(against `openssl s_server`), executing APL, docked and floating editors,
`RIDE_EDITOR`, the preferences window, About, the protocol log, 3500⌶,
native message boxes and popup menus, window geometry.

Not done or not yet checked interactively:

- Windows: checked that the app starts, the sync bridge, prefs (in
  `%APPDATA%\Ride-4.8`), helper windows, `ridefile://`, native message and
  file dialogs, process `kill`, finding interpreters in the registry
  (`execSync`), and starting Dyalog 21.0 and executing APL work.
- Native dialogs on macOS fall back to the webview's `alert`/`confirm`/
  `prompt`, and process `kill` is not implemented there.
- The application menu is Ride's HTML menu, not a native one.
- Drag and drop, printing, and clicking popup-menu items need checking by
  hand.
- The Electron test suite (spectron) does not run against this build.
