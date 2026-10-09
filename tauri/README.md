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
drives it, and turning observe off closes the socket and drops the agent.

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

- Unix only. The socket is a Unix domain socket; on Windows `agent_listen`
  returns "not supported" and the feature is off. The loopback-port-and-token
  transport in the design is not written, and the CLI has no `.port` or
  `tcp://` handling.
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
- The Electron test suite (spectron) does not run against this build.
