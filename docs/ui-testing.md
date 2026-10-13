# Native UI testing

Run `npm test` for the full native Tauri suite. Run `npm run test:ui-qa` for a focused campaign covering window layout, interpreter lifecycle and startup failures, highlighting, menu actions, connection sizing, Monaco, session closing, and output menus. Both commands use the same serial runner and start an isolated application for each test. `npm run test:unit` runs the separate Node unit suite.

The runner compiles styles, stages the frontend, and builds a Tauri binary with the `ui-tests` feature before testing. Rust/Cargo and the normal project dependencies must be available. Interpreter tests need a real Dyalog executable: put `dyalog` on `PATH`, or set `RIDE_TEST_DYALOG` to its executable path. Tests fail when the interpreter cannot be found.

On macOS, leave the desktop unlocked and grant Accessibility access to the Tauride test application (and the launching terminal if macOS requests it). Native keyboard and menu tests need an interactive desktop; run only one native suite at a time. Screen locking, another application taking focus, or concurrent native input can invalidate a run.

For a narrower selection, pass files and AVA filters to the runner, for example:

```sh
node tools/test-tauri.js test/window-layout.js --match='*docked*'
```

`RIDE_TEST_BINARY` selects an existing test binary and skips **all** build and staging steps. It must have been built with the `ui-tests` feature and must include the frontend and Rust changes being tested. After changing either, unset this variable and rebuild with `npm run test:build` before reusing the binary. A passing run against an old binary does not validate current sources.

Native application menu routing and Cmd-W/Cmd-Q coverage are macOS-specific. Interpreter process checks use POSIX `ps` identities and run on macOS/Linux; they do not establish Windows process cleanup coverage. Check each test's platform guard when interpreting skips.

Lifecycle tests record each locally spawned interpreter's PID and process identity, then verify it exits **before** harness teardown. A surviving sibling must still evaluate an expression. Teardown checks the recorded identity before cleaning up a leftover interpreter; never use blanket process-name kills to make these tests pass. Such cleanup would hide leaks and could terminate unrelated sessions.

CI runs a small native connection subset and the failing-interpreter startup regression under Linux/Xvfb, plus the Node unit suite. It does not run this complete interactive QA campaign. Run the focused suite on an unlocked macOS desktop to exercise its native menu and keyboard paths.

The isolated test environment defaults `ENABLE_CEF=0`: these tests do not use Dyalog's HTMLRenderer, and its embedded Chromium has crashed during interpreter startup on macOS. This does not disable Tauride's own webview. Set `ENABLE_CEF=1` explicitly when testing HTMLRenderer; the harness preserves that override. Production interpreter settings are unchanged.

Startup uses ordinary WebDriver with the existing readiness requirements and time limits. An unexpected native message dialog during startup fails with its actual message. The harness does not dismiss it, restart the app, or retry an interpreter crash as though startup succeeded.

Startup failures print a retained `tauride-startup-diagnostics-*` directory under the operating system's temporary directory. Preserve that directory with the test log: `startup.json` records the failed phase, timing, app PID, last delivered frontend snapshot and a bounded read-only probe; `app-output.txt` contains the last 24 KiB of app output, including bounded `[ui-test-dialog]` records emitted by test builds before native message dialogs open. On macOS, `native-sample.txt` samples the owned live app before teardown when sampling is available. A failed diagnostic is recorded without replacing the startup error. Profiles and owned processes are still cleaned up.

The frontend snapshot contains readiness, connection-screen and dialog visibility, and geometry metadata, without source text or environment values. Native dialogs, including asynchronous macOS sheets, live outside the main-page DOM; inspect their test-build records too. Startup alerts fail the test with their actual text even when the asynchronous page can still answer WebDriver. The original #132 thread sample captured a synchronous modal before that production migration. An HTTP timeout alone does not establish that WebKit lost a callback. Compare the last snapshot, the failure probe and the native sample before assigning a cause.
