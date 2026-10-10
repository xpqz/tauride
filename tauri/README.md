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

## Tests

`npm test` builds the Tauri app and runs the AVA UI suite against its native
webviews. It requires Node.js 22 or later, the build prerequisites above, and
Dyalog on PATH. Set `RIDE_TEST_DYALOG` to use a specific interpreter executable.

    npm test
    npm test -- test/se.js
    npm run test:connection
    npm run test:unit

`test:connection` runs the three connection-screen cases that do not need an
interpreter. `test:unit` runs frontend and harness regressions without a display
or interpreter, including session, editor, tokenizer, floating-window IPC and
app lifecycle checks. CI runs these regressions and the connection-screen cases
under Xvfb on Linux, and compiles the test app on all three platforms. The full
interpreter suite must run where Dyalog is installed.

The UI runner stages the frontend and builds with Cargo's `ui-tests` feature into
`src-tauri/target/ui-tests`. This enables a loopback WebDriver server and test-only
native input commands, and disables single-instance redirection. Ordinary builds
exclude the automation code. Each test gets a fresh preference directory and an
app process; normal teardown quits that process and removes its profile. AVA uses
child processes with a 60-second inactivity timeout. A test-only stdin pipe also
quits the app and its owned interpreters if a worker terminates abruptly. Inherited
`RIDE_*` startup settings are cleared. Existing Ride preferences and sessions are
not used.

Keyboard, clipboard and hover cases use native input because the embedded
WebDriver's synthetic events do not implement those interactions faithfully.
They require an unlocked desktop with Tauride focused. macOS also needs
Accessibility permission for the test binary; the adapter fails with an error
when permission is absent. Linux needs an X11 session (Xvfb works) and `xclip`;
Windows reads the clipboard through PowerShell. On Linux, building the native
input adapter also requires `libxkbcommon-dev`. The suite checks the real OS
clipboard and therefore changes its contents. Running tests on a locked desktop
can validate app startup and connection forms, but does not validate native input.

`npm run test:build` builds without running tests. To reuse a test-enabled binary,
set `RIDE_TEST_BINARY` to its path; this skips the build, so rebuild it after source
changes. `CARGO_TARGET_DIR` overrides the test build directory and binary lookup.
Use a separate target directory from ordinary builds. AVA arguments pass through
`npm test --`, for example `npm test -- test/cn.js --match=cn-start-raw`.

## Zero-footprint Ride

`node mk zf` writes `_/zf`: the frontend laid out as Dyalog's `RIDEapp`
directory (`index.html` and the other pages at the root, `src/`, `lib/`,
`style/`, `_/version.js`, and under `node_modules/` only the jquery, toastr
and monaco-editor builds the pages load), zipped as
`_/tauride-zf-<version>.zip`, which unpacks as `RIDEapp/`. A Dyalog
interpreter started with `RIDE_INIT=HTTP:*:<port>` serves that directory
from `[DYALOG]/RIDEapp` to a web browser, and the page connects back to the
interpreter over a WebSocket on the same port. Putting the tree there is a
build-time concern for whoever assembles a Dyalog installation, not a step
an end user takes; the Tauride installers do not include it. CI's `zf` job
builds the zip and the release job publishes it with the installers.

Testing: `node tools/zf-smoke.js _/zf` serves the tree and loads it in
headless Chrome (`CHROME=<binary>` overrides the browser), printing the
console and failing on an uncaught exception, on a request for a file the
tree lacks, or when the DOM lacks the session tab and the html menu. In
browser mode the page builds its IDE before its WebSocket connects, so no
interpreter is involved. The interpreter-served check needs a real copy of
a Dyalog installation (`rsync -a --exclude RIDEapp`), since `[DYALOG]` is
resolved from the real path of the binary and a symlinked installation does
not work: symlink `RIDEapp` in the copy to `_/zf`, start `<copy>/mapl +s -q`
with `ENABLE_CEF=0` and `RIDE_INIT='HTTP:*:<port>'` in its environment, and
open `http://localhost:<port>` in a browser.

In this mode only the serving interpreter is available (no New Session),
preferences live in browser storage, window captions cannot be set, and
floating Trace/Edit windows are not available (`docs/ride_in_the_browser.md`).

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
| `BrowserWindow`, `getCurrentWindow`, `screen` | not emulated: Ride's code calls `src/wm.js` (below) |
| `@electron/remote`: `getGlobal`, `app`, `shell`, `clipboard` | `winstate.rs` (main.js's window geometry), `open_url` |
| `dialog.*Sync` | `dialog.rs`: GTK dialogs on Linux; task dialogs and the common item dialogs (rfd) on Windows |
| `Menu.popup()` | `menu.rs`: native popup menus |

Sessions: unlike Electron Ride, which starts another process for each
session, Tauride runs every session in one process, each in its own window,
as VS Code does; the OS lists them as one app's windows (macOS Window menu
and Dock, Windows taskbar, GNOME and KDE task switchers). New Session, New
Session... and a listening session's respawn call `D.wm.newSession(env)`,
which opens a session window (`session_new` in `win.rs`) whose page takes
`env` as its environment overrides (`RIDE_SPAWN`, `RIDE_CONNECT`,
`RIDE_LISTEN`, ...), as the spawned process took its environment. Starting
Tauride again opens a session window in the running one (single-instance
plugin). Session k's window has id k * 1e6 + 1 (label `main` for the
first), and its helper windows (preferences, dialog, status, floating
editors, About, ...) ids in its range, so helpers route their messages to
their own session window and close with it. Quitting ends a session; the
app exits when its last session window closes. Window titles follow the
page's `document.title` (the session caption).

Windows: `src/wm.js` gives Ride's code one small window API (create, find,
show/hide/focus/close, size, title, run a script, print, devtools) with two
implementations: Electron's `BrowserWindow`, and Tauri's JS window API
(`WebviewWindow`, monitors), where windows are addressed by label (`main`,
`w<id>`) and queries are promises. Calls on a window wait until Tauri has
created it. A small plugin (`ride_plugin` in `lib.rs`) injects the shim into
every webview, however its window was created, reports page loads, and
attaches `win.rs`'s handling to every window: close requests go to the page
first (Ride's `onbeforeunload`), the main window's geometry is saved, and the
app exits with the main window. `win_op` does what the JS API cannot do to
another window: run a script in it, print it, toggle its devtools, navigate it.

The main window collects unsaved-stop counts from floating editors before
requesting a global clear. An editor that closes completes its pending count
request; an unresponsive editor aborts the operation without changing stops.
Save replies carry whether the interpreter already explained a failed save,
so the owning editor can retain its generic error when no explanation exists.

Under Tauri, pasted numbered traditional-function listings are assembled in a
uniquely named temporary variable in `⎕SE` using bounded input commands. The
temporary is erased before `⎕FX` fixes the function in the current namespace.
Replacing or interrupting a transfer schedules cleanup. Losing the connection
mid-transfer can leave the temporary in the remote interpreter's `⎕SE`.

Two channels connect the webview to Rust:

- **Synchronous**: Ride calls `fs.readFileSync`, `dialog.showMessageBoxSync`
  and the like synchronously. The shim answers them with synchronous XHR to
  a custom `ridesync://` scheme (`http://ridesync.localhost` on Windows,
  where WebView2 preflights the POST), which Rust serves on the main thread.
- **Asynchronous**: sockets, processes and windows use Tauri commands and
  events (`ride-net`, `ride-proc`, `ride-ssh`, `ride-ipc`, `ride-menu`,
  `ride-page-load`).

A second scheme, `ridefile://`, serves local files to windows Ride points at
a `file://` URL outside the app (3500⌶ writes its HTML to a temp file).

Ride's frontend changes:

- Window management goes through `src/wm.js` (`init.js`, `ipc.js`, `util.js`,
  `ide.js`, `abt.js`, `km.js`, `ed.js`, `cn.js`, `se.js`, `prf_*.js`,
  `dialog.html`, `status.html`); queries such as a window's bounds are now
  promises.

- `dialog.html`, `status.html`: a top-level `ipc` renamed `nodeIpc`; on
  Linux wry defines `window.ipc`, and the duplicate declaration rejected the
  whole script.
- `src/menu.js`: the HTML menu under Tauri.
- `src/init.js`: `RIDE_JS` files run through `D.wm.current().eval`, as Tauri
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
