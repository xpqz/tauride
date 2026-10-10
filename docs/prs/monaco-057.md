# Monaco 0.57 migration

Upgrade Monaco from 0.31.1 to 0.57.0, the latest stable release checked on 10 October 2026. Monaco's AMD distribution is deprecated, so Ride now builds its supported ESM sources into local browser bundles. Tauri, Electron and zero-footprint packaging share the same build, including CSS, fonts and dedicated editor, JSON, CSS, HTML and TypeScript workers.

Editor options and preference updates use the current APIs. APL formatting, folding, completion and localisation obtain token states from Ride's tokenizer, cached by model version, language provider and indentation settings, rather than Monaco's removed private state store. Composition handling uses public editor events; Find/Replace input uses the current controls and input events.

Custom commands are scoped to their editor. Without that scope, Enter in the session could invoke a previously opened tracer. The active editor blurs before GoldenLayout creates or reparents editor DOM, preserving Monaco's focus state; closing disposes the editor before its model. The macOS startup focus callback preserves the current window. Native keyboard tests exposed these lifecycle interactions.

The optional Vim sample has a build script that shares Ride's Monaco instance and bundles the matching ShiftCommand implementation required by monaco-vim 0.4.1. Its README describes installation and rebuilding; no Vim dependency is added to Ride itself.

The native test bridge creates macOS input objects on the main thread and converts pointer coordinates using the actual webview's safe area and screen geometry. Test window selection identifies initialized editors in Tauri's precreated window pool. Keyboard and tooltip assertions now handle the current WebdriverIO key names and interpreter-provided title casing. Editor tests wait for opening-time formatting to finish, and clipboard assertions check OS line endings without assuming interpreter-specific padding.

Sources: [Monaco 0.57.0 release](https://github.com/microsoft/monaco-editor/releases/tag/v0.57.0), [ESM integration](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md).

## Validation

- Clean dependency installation and native test build completed.
- `npm run test:unit`: 107 tests passed.
- Full native Tauri suite: 24 tests passed on macOS with Dyalog 21.0.54424, including OS keyboard input, clipboard, breakpoints, floating windows, completion, formatting, folding, Find/Replace and worker RPC.
- `node mk zf` and `node tools/zf-smoke.js _/zf`: passed with a real worker RPC, no missing assets and no console errors.
- Electron smoke: worker RPC, APL prefix expansion and visible session passed with native EditContext enabled.
- Direct native UI check: session expression, function editing, Find match, save/close and execution of the saved function passed. Editor and session styling were visually checked.
- Optional Vim bundle: published monaco-vim 0.4.1 initialized and indented text using the shared Monaco instance.
- Independent implementation review completed with no outstanding findings.

Windows and Linux native keyboard behavior is not covered by the local macOS run; CI builds all three platforms and runs the Linux connection tests and browser smoke.
