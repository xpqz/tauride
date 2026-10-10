# Reopened issue fixes

Integrator branch: `integrate/reopened-issues`, based on
`01931d57dff5612331e751986ee265e04f8b5c9b`.

## Changes

| Issue | Implementation |
| --- | --- |
| #3 | Only the interpreter's INPUT LIMIT error can reuse a reply, within the same submitted input. Ordinary identical dialogs remain separate. |
| #6 | Collect unsaved-stop counts across IPC before requesting a global clear. Update editor stops and saved baselines after the interpreter acknowledges it. Closing windows, timeouts, busy interpreters, unsupported commands, and disconnects cannot leave a pending count blocking subsequent attempts. |
| #9 | Transfer numbered traditional-function source in bounded commands, preserving redefinition, quoting, blank lines, index origin, and the current namespace. Clean up temporary source before fixing, or when a transfer is replaced or interrupted. |
| #15 | Carry an interpreter save-error explanation through the main window's save reply into the owning docked or floating editor. Keep the generic fallback when no explanation can be associated with that save. |
| #21 | Identify newly opened brackets by stable range IDs, preserving inherited multiline arrays through tokenizer state cloning. |
| #22 | Derive script-relative tradfn numbering from lexer tokens, excluding recursive dfns, strings, and comments. Invalidate the cache on model replacement and edits. |
| #24 | Inherit the general indentation width when the method override is disabled. Refresh tokenization when preferences change and initialize untokenized models before formatting. |
| #34 | Added regression coverage for all embedded CR/LF editor markers and read-only handling. The remaining session staircase is present in the interpreter's output and is unchanged. |

## Verification

Run the durable frontend tests with:

```sh
npm run test:unit
```

The initial batch passed all 32 frontend tests. The complete integration suite now
passes 99 tests, including the Tauri harness and subsequent fixes documented in
`docs/prs/36.md` through `docs/prs/41.md`. The frontend tests execute the real methods
and registered language providers with small application stubs, including the
real floating-window IPC handlers. The zero-footprint CI job now runs this suite. It does not substitute
for native window interaction.

The following checks also passed on macOS:

- JavaScript syntax checks and `git diff --check`.
- `npm run css`, `node mk zf`, and `node tauri/stage.js`.
- `cargo check --locked --offline` using the existing dependency cache.
- `node tools/zf-smoke.js _/zf`: no uncaught errors or missing served files.
- Real Monaco in headless Chrome: change preferences on the same already-tokenized
  class model. General/method settings `3/-1`, `7/20`, `7/0`, and `5/-1` produce
  method-body indentation of 6, 27, 7, and 10 spaces respectively.
- Generated paste commands sent to Dyalog 21.0.54424 over RIDE: a 500-comment-line
  definition with both index origins, redefinition with quotes and a blank line,
  a 12,000-character source literal, Unicode-heavy source, a rejected definition
  preserving the previous function, and fixing in a child namespace. Calls return
  the expected values, with no INPUT LIMIT or HadError; temporary source variables
  are absent after completion.

The original file-linked save reproduction produced this actual dialog payload:

```json
{"type":4,"options":["OK"],"title":"Dyalog APL","text":"Can't Fix"}
```

The save-explanation regression test uses this payload. The bare protocol probe
did not receive a `ReplySaveChanges` after answering it, so it does not establish
the entire native save workflow. Reply routing and fallback behavior are covered
by the source/IPC tests.

## Remaining native checks and limits

The desktop was locked. With an unlocked Tauri app, confirm global clearing with
multiple floating editors, closing one during collection, and adding a stop again
on the same line. Repeat the file-linked Can't Fix reproduction in docked and
floating editors and verify the editor stays open with one explanation. Confirm
pasting and live indentation changes through the normal editor controls.

The protocol does not identify an editor in OptionsDialog. If several saves are
outstanding, the generic save error is retained rather than associating the
explanation with an arbitrary editor. Losing the connection during a source
transfer can leave its uniquely named temporary variable in remote `⎕SE`.

Issue #34's remaining session output requires an interpreter-side resolution;
Tauride does not remove whitespace from arbitrary interpreter output.
