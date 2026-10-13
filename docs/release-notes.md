# Tauride release notes

Cumulative changes since the fork of Dyalog Ride 4.8, through 13 October 2026 and [PR #140](https://github.com/xpqz/tauride/pull/140). This covers merged `main`, including changes after the 4.8.3 installer release. [Full change history](https://github.com/xpqz/tauride/compare/307003ef...bcddf734).

## Desktop and distribution

- Replaced Electron and its packaging tools with Tauri 2, retaining local, TCP, TLS and SSH interpreter connections, workspace drag-and-drop, floating editors and the bundled APL font. Active extension compatibility APIs remain available.
- Added native desktop integration and installers for Apple silicon macOS, Windows x64 and Linux x64, plus a separately packaged browser-only Ride bundle.
- Sessions share one application process with separate windows. Closing a session cleans up its spawned local interpreter; macOS Cmd-Q closes all sessions with one confirmation.

## Session, menus and keyboard

- Added explicit Ready, Busy, expression-input, text-input, multiline and disconnected status labels, plus a `{TID}` placeholder for window titles.
- Added View commands to show or hide the Trace/Edit toolbar and clear completed visible history while preserving the draft, command recall and workspace.
- Added View > Boxing and Rows controls, with Help and Current Settings queries that reflect commands entered directly in the interpreter.
- Added customizable Mac defaults, including Cmd-S for Fix, Control-C for Strong Interrupt and familiar Find, Replace, comment, reformat and command-palette shortcuts. Removed the unsupported default Weak Interrupt accelerator from Mac menus. Existing custom menus and key mappings are preserved.
- Cmd-W closes the focused Mac Session while retaining editor/tracer close behavior. Menus and shortcuts follow the focused session or floating pane; Preferences Cmd-A and diagnostic commands target their own fields.
- Fixed connection-name editing, plus-key zoom, the Mac § key label and dark-theme scrollbar contrast. Expanding connection settings preserves fullscreen and maximized sizing.

## Editing and tracing

- Upgraded Monaco from 0.31.1 to 0.57.0, with shared local bundles and workers for desktop and browser builds.
- Exposed inline tracing arguments, function, axis and previous results/operands through Action and tracer context menus. Inspection panes update with execution, preserve input and tracer focus, and hide the edit toolbar.
- Added whole `:Select` folding alongside individual branch folds and function-relative line numbers for traditional functions in scripts.
- Fixed autocomplete after deletion, completion before brackets, class snippets inside `:Section`, and Tab indentation below the completion threshold or after an empty shell-completion reply. Typing and formatting respect indentation preferences.
- Fixed Align Comments duplication and unwanted movement of standalone comments; tracer-to-editor conversion keeps the intended window. Pasted numbered function listings can redefine functions, including long definitions.
- Corrected array-notation keys, delimiters, indented labels, section comments, adjacent idioms, namespace-reference tips and unmatched-bracket highlighting. Syntax colours survive theme and indentation changes; embedded CR/LF markers display correctly in editors.

## Reliability and diagnostics

- Fixed stale Workspace Explorer replies corrupting refreshed trees and message-handler exceptions stopping subsequent interpreter messages.
- Fixed unsaved breakpoint clearing, repeated input-limit and save-error dialogs, and empty expression-prompt submission.
- Added Copy, Copy All and Find to About and protocol logs, with visible matches and counts. Incoming log output preserves selection, search position and reading position.
- Native dialogs and file pickers keep the interface responsive. Close and overwrite actions wait for consent; repeated closes and delayed replies respect cancellation and window ownership.
- Improved editor/window focus, resizing and shutdown behavior. Native test startup checks surface interpreter errors and retain diagnostics.

## Agent integration and testing

- Added opt-in, per-session desktop agent observation and control through a local CLI/MCP interface: execute, inspect, edit, save, interrupt and step through the tracer. Transcripts and session markings distinguish agent input; optional Run/Deny confirmations control actions.
- Disconnecting or revoking control cancels pending agent actions. Canceled confirmation prompts cannot reappear when hovered, and stale buttons cannot authorize a fresh request.
- Ported the Electron UI suite to real Tauri webviews and expanded coverage of resizing, native input, menus, syntax colours and interpreter cleanup. At this revision, all 296 unit tests and 95 native macOS UI tests pass; desktop builds and browser smoke tests pass in CI.

See the [keyboard guide](keyboard_shortcuts.md), [Tauride guide](../tauri/README.md) and [UI testing guide](ui-testing.md) for configuration and platform details.
