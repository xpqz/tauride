# CLAUDE.md

Tauride is an unofficial fork of Dyalog's Ride (the IDE for Dyalog APL) that runs Ride's
existing frontend in a Tauri 2 shell instead of Electron. The Electron build (`main.js`,
`mk/`) still exists and must keep working. Its version follows Ride's latest release
(4.8.x).

- `index.html`, `src/*.js`, the other `*.html`: Ride's frontend, shared by both builds.
  Changes here must not break Electron; Tauri-only behaviour is gated on
  `window.__RIDE__` (set by the shim) and, for macOS, `D.mac`.
- `tauri/shim.js`: the Node/Electron compatibility layer injected into every webview.
  `tauri/stage.js` builds `_/tauri-dist`, the directory the app serves.
- `src-tauri/`: the Rust side (`win.rs`, `menu.rs`, `dialog.rs`, `net.rs`, `proc.rs`,
  `ssh.rs`, `sync.rs`, `winstate.rs`). `src/wm.js` is the frontend's window API.
- `tauri/README.md` is the architecture reference. Read it before changing the shim,
  the sync bridge or window handling, and keep it current when behaviour changes.

## Build and run

    npm ci                      # first time; `npm install` rewrites package-lock.json,
                                # so `git checkout package-lock.json` afterwards
    npm run css && node tauri/stage.js
    cd src-tauri && cargo build
    cargo run                   # debug app; or `cargo tauri dev` / `cargo tauri build`

- The app serves `_/tauri-dist`, not the source tree. After editing anything under
  `src/`, `lib/`, `style/` or the HTML files, run `node tauri/stage.js`. `shim.js` is
  also compiled into the binary (`include_str!`), so it needs a `cargo build` too.
- Useful environment: `RIDE_SPAWN=/usr/local/bin/dyalog` starts a session without the
  connect screen, `RIDE_TAURI_DEBUG=1` logs window and menu traffic, `RIDE_LOG`,
  `RIDE_CONNECT=host:port`. Webview `console.error`/`warn` and uncaught errors are
  printed on stderr as `[webview ...]`. `"devTools": true` in
  `~/.config/Ride-4.8/winstate.json` opens devtools on the main window.
- `npm test` builds and runs the Tauri UI suite (AVA/WebdriverIO). It needs a
  Dyalog interpreter on PATH or `RIDE_TEST_DYALOG`, plus an unlocked desktop for
  native input. See `tauri/README.md` for test setup and focused runs.
- `npm run test:unit` runs display-independent frontend and harness regressions.
- Verify changes in the running app, not only by compiling. Check the window with
  `screencapture -l <window id>` (window ids from `CGWindowListCopyWindowInfo`), never a
  full-screen capture.

## Platforms

Three Claude sessions work in this repo, one per OS, all on `main`:
`macos-claude-tauri` (this machine), `linux-claude` and `windows-claude-tauri`. Code in
`src-tauri/` and `tauri/shim.js` is shared, so gate platform behaviour with `cfg` and
`nodePlatform` rather than editing shared paths, and say in a message to the other
sessions when a push touches shared files so they can rebuild and confirm. Messages
only arrive over Remote Control; a send is not confirmation that it was read.

## Processes

Ride spawns Dyalog interpreters; `proc::kill_all` ends them when the app exits. When
testing, quit with Cmd-Q rather than `pkill`, which leaves interpreters (and their
`mapl` wrappers) running and keeps the Dock icon marked as running. After a crashed or
killed run, check `ps -axo pid,ppid,command | grep 'dyalog +s'` for survivors whose
parent is 1 before killing anything: the Dyalog app's own sessions look the same.

## Releases

A `v*` tag push makes CI build every platform and publish a GitHub release with the
installers. Installer names come from `package.json`, so bump the version in
`package.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` first, commit, then
tag `vX.Y.Z` and push both. macOS builds are Apple silicon only and ad-hoc signed.
`npx --yes @tauri-apps/cli@2.12.1 build --config src-tauri/tauri.bundle.conf.json
--bundles dmg` builds the same dmg locally.

## Git

- Never use `--no-verify`; fix the failure instead.
- Commit only when asked. Pushing, tagging and moving a tag are outward-facing: do them
  only when asked, and never move a published tag without being told to.
- Fixes: one branch per issue, named `<issue id>-<slug>`, from `main`, with no stacking
  of branches on each other. Once a fix is verified in the running app, merge it into
  `main` (`git merge --no-ff`) and delete the branch and its worktree
  (`git worktree remove --force`, `git branch -d`); do not leave spent branches around.
  Merging is local; pushing still waits for an instruction.
- Commit messages: a short imperative summary, then a body that says why. No attribution
  lines.

## Writing

State what you mean directly; do not decorate with metaphor. Code comments state the
invariant or the constraint the code cannot express, never the history of how it got
there, the review that asked for it, or what used to be here. Keep documentation
(`tauri/README.md`, this file) free of the same.
