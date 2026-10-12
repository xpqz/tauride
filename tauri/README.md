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
with the bundled Monaco editor and only the `node_modules` trees the pages use) and generates
`tauri-modules.js` (see below). The staged dist and `tauri/shim.js` are
embedded in the binary at compile time, so after a change to `src/`, `lib/`,
`style/` or the HTML pages run `node tauri/stage.js` and then rebuild
(`touch src-tauri/src/lib.rs` so cargo notices, then `cargo build` or
`cargo tauri build`); a plain `cargo build` without restaging runs the old
frontend. Ride's environment variables work as before:
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
`style/`, `_/version.js`, `_/monaco/` (the editor, stylesheet and workers),
and under `node_modules/` only jquery and toastr), zipped as
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
their own session window and close with it. Closing a session window ends that
session; on macOS, Command-W does this when the Session pane has text focus,
using the same confirmation and interpreter shutdown as the window's close button.
Command-Q quits all sessions. The macOS app stays open after its last session
window closes; on other platforms the app exits. Window titles follow the
page's `document.title` (the session caption).

On macOS, Observe Session, Allow Control and Show Trace/Edit Toolbar act on
whichever session or floating editor/tracer has native focus. Floating windows
propagate the preference to their owning session through the existing IPC path.
These commands and the Inline Tracing commands carry their command code in the
native menu item ID and are sent to the focused webview, even if another session
last installed the application menu. Inline inspection requests from floating
windows are checked by their owning session. The focused session supplies the
inspection items’ enabled state; helper windows disable them and do not change
session preferences.

Mac editing shortcuts and Strong Interrupt use the existing command registry,
Shortcuts preferences and menu DSL. Explicit custom assignments outrank defaults;
empty bindings and live remapping also remove inherited or stale Monaco bindings.
The effective assignments supply both editor bindings and menu accelerators.
Fix, Find, Replace, Command Palette, Toggle Comment, Reformat and Strong Interrupt
route to the eligible focused pane. Strong Interrupt remains available while the
Session is busy; search fields and helper inputs cannot trigger it. Focus changes
install the owning session's configured menu; other sessions cannot replace it.
Windows and Linux keep their previous defaults until physical user testing can
validate proposed platform mappings. See `docs/keyboard_shortcuts.md`.

Windows: `src/wm.js` gives Ride's code one small window API (create, find,
show/hide/focus/close, size, title, run a script, print, devtools) with two
implementations: Electron's `BrowserWindow`, and Tauri's JS window API
(`WebviewWindow`, monitors), where windows are addressed by label (`main`,
`w<id>`) and queries are promises. Calls on a window wait until Tauri has
created it. Content-size requests preserve fullscreen and maximized window
geometry; ordinary windows retain the queued resize and hidden-window handling.
A small plugin (`ride_plugin` in `lib.rs`) injects the shim into
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

## Inline tracing

Use **Action → Inline Tracing → Next Primitive** (the existing Ctrl+Alt+Enter
shortcut) to start or advance inline tracing. The same submenu is available in
the native tracer context menu. While paused within an expression, it offers
Left Argument, Current Function, Right Argument and Axis Specification, followed
by Previous Result and the previous arguments, function and axis.

These commands open Dyalog’s existing `]IT` inspection windows. Opening a view
again brings its existing window forward, and its contents update as execution
advances. An argument or result that is unavailable is shown as `<no value>`.
Next Primitive also works while an inspection window has focus. Inspection
windows keep the edit toolbar hidden and use the full pane for their values.

Inspection commands preserve unfinished Session input and selection. They are
unavailable while the interpreter is running, accepting input, or processing
another command. The commands have no additional default shortcuts. Saved
custom menus remain unchanged; the commands can be added through Preferences.

## Pair programming with an agent

An agent such as Claude Code can work in the same session as you: it runs
lines at your prompt, drives your tracer, and reads what you typed and what
the interpreter answered. Tauride stays the only thing talking to the
interpreter; the agent attaches to Tauride over a local socket. The design
and the wire format are in `agent-pairing.md`.

**Switching on.** Off by default. Per session, from the Agent menu: *Observe
Session* opens the socket and the transcript; *Allow Control* also lets the
agent execute, answer prompts, interrupt, edit, save and trace. The same two
switches, plus *Confirm each action*, are checkboxes under Agent on the
General tab of Preferences. `RIDE_AGENT=1` (observe) or `RIDE_AGENT=control`
in the environment sets the level when Tauride starts; after that the menu
drives it. Turning both switches off closes the socket and drops the agent.

With *Confirm each action* enabled, disconnecting the agent or revoking control
cancels actions still awaiting confirmation or IDE readiness and dismisses their
toasts. Reconnecting or restoring control requires a fresh request. Actions
already sent to the interpreter continue normally.

**Status bar.** While the level is at least observe the status bar shows
`agent: observing` or `agent: control`, with ` (connected)` appended while a
client is attached.

**Where things are.** Under the Ride config directory
(`$XDG_CONFIG_HOME/Ride-4.8`, `~/.config/Ride-4.8` by default):

- the socket, `agent/<session>.sock`: `main.sock` for the first session
  window, `w<id>.sock` for the others. Unix domain socket, directory 0700,
  file 0600, removed when the session closes.
- the transcript, `sessions/<session>-<appid>.jsonl`: one JSON event per
  line (`input` with `origin: human | agent`, `output`, `error`, `prompt`,
  `window`, `stack`, `agent`), each with a `seq` and a timestamp, appended
  while observing and rotated once to `.1` at 32 MB. It is an ordinary
  file: `tail -f` it, or `jq` it afterwards to see who did what.

**The CLI.** `tools/tauride-mcp/tauride-mcp.js` is a Node script with no
dependencies. It talks to `--socket`, else `$TAURIDE_SOCKET`, else the
socket of `--session` (default `main`) in the config directory.

    node tools/tauride-mcp/tauride-mcp.js status
    node tools/tauride-mcp/tauride-mcp.js exec '⍳5'
    node tools/tauride-mcp/tauride-mcp.js watch           # events as they arrive
    node tools/tauride-mcp/tauride-mcp.js windows         # open editors and tracers

Run it without arguments for the full list (`answer`, `interrupt`, `tail`,
`window-text`, `edit`, `save`, `stops`, `trace`, `stack`, `value`, `wait`).
Exit status 0 is success, 1 means the line ended in an APL error, 2 anything
else, with the reason on stderr.

**Claude Code.** The same script serves MCP over stdio. From the Tauride
checkout:

    claude mcp add tauride -- node tools/tauride-mcp/tauride-mcp.js mcp

(use the absolute path to the script if you add it from elsewhere). Claude
gets one tool per request: `execute`, `answer`, `interrupt`, `tail`,
`status`, `windows`, `window_text`, `edit`, `save`, `stops`, `trace`,
`stack`, `value` and `wait_for_input`. The last one blocks until you enter a
line in the session, optionally one starting with a prefix, for up to five
minutes by default. The convention is to address the agent from the session
itself: type `⍝ Claude: have a look at foo`, and an agent waiting on
`wait_for_input` with prefix `⍝ Claude:` wakes with that line, so you can
tell Claude to wait for instructions in the session instead of polling.

**Confirm mode.** With *Confirm each action* on, every control request
except an interrupt shows a toast with the request text and Run / Deny
buttons. No answer within 60 seconds is a deny; a denied request fails with
`denied`. Interrupts are never gated, so you can always have the agent stop
a loop.

**Agent lines in the session.** A line the agent entered is echoed like any
other, with a `◆` in the margin and a muted background, so the session
itself shows who typed what; the transcript records it as `origin: agent`,
and a function the agent saved as a `window` event with `event: save` and
`origin: agent`.

**Limits.**

- On Windows the port is a loopback TCP socket instead of a Unix socket:
  `agent/<session>.port` holds `127.0.0.1:<port> <token>`, the client's first
  frame must be `{"auth": "<token>"}`, and the CLI reads the `.port` file
  itself (or `TAURIDE_SOCKET=tcp://127.0.0.1:<port>?token=<token>`).
- One agent per session: a second connection is answered `busy` and closed.
  Sessions are independent, so each can have its own agent. One request in
  flight per session; a second while one is running also gets `busy`.
- Output attribution is best effort. The interpreter does not tag output by
  request, so `execute` reports what arrived between its echo and the
  prompt's return; output from other threads (`&`) interleaves. Results are
  capped at 200 lines or 64 KB with `truncated: true`; the rest is in the
  transcript.
- The whole feature is gated on `window.__RIDE__`; the Electron build does
  not have it.

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
