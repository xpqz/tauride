# Upstream Ride issues that still affect Tauride

Reviewed on 10 October 2026. **Six frontend defects remain, corresponding to seven upstream issues** because #1363 and #977 describe the same tracer limitation. The most serious are the inbound-message queue freeze and Workspace Explorer stale-reply race. All confirmed defects below are in the shared Ride frontend; none requires an interpreter fix.

The review is read-only with respect to `Dyalog/ride`. No upstream issues or comments were changed. No production code was changed or merged for this review.

## Scope and baseline

The inventory is the 222 open issues returned by GitHub on the review date, including feature requests and documentation work. Closed upstream issues are outside this pass. Bodies and comments were reviewed, then relevant source paths and selected reproductions were checked.

The tested tree is `/Users/stefan/work/tauride-issue-fixes`, branch `integrate/reopened-issues`, based on `01931d57dff5612331e751986ee265e04f8b5c9b` plus the existing uncommitted issue fixes and Tauri test port. Native tests used macOS Tauri/WKWebView and Dyalog **21.0.54424**. The staged native frontend matched the reviewed source for `ide.js`, `ed.js`, `ac.js`, `bonsai.js`, and `mon_apl.js`. The relevant defects also remain in the main source; main was not modified.

The screen was locked. Native checks used the real webview, real Monaco, real frontend command handlers, and real interpreter messages through the Tauri test driver. Controlled callback ordering and injected handler failure are identified below. These checks do not establish physical key delivery, mouse hit-testing, visual appearance, or focus behavior on an unlocked desktop. Windows and Linux native behavior was not tested.

## Confirmed frontend defects

| Priority | Upstream issue | Confirmed remaining behavior | Evidence |
| --- | --- | --- | --- |
| High | [#1417](https://github.com/Dyalog/ride/issues/1417) | A thrown message handler can permanently stop the inbound queue. | Native controlled exception; subsequent valid interpreter output arrives but is never displayed. |
| High | [#1416](https://github.com/Dyalog/ride/issues/1416) | An old Workspace Explorer value-tip reply can prematurely complete a newer tree refresh and throw. | Actual native Bonsai class, controlled legal callback ordering. |
| Medium | [#1363](https://github.com/Dyalog/ride/issues/1363), [#977](https://github.com/Dyalog/ride/issues/977) | Edit in column 1 of an unindented tracer opens the adjacent name instead of converting the tracer. | Native editor save, trace, Edit command, and protocol control comparison. |
| Medium | [#745](https://github.com/Dyalog/ride/issues/745) | Align Comments moves an unselected standalone comment. | Actual command on real native Monaco. |
| Low | [#1391](https://github.com/Dyalog/ride/issues/1391) | The first character of an indented class-method label gets the whitespace scope. | Original attached workspace source tokenized by real native Monaco. |
| Low | [#431](https://github.com/Dyalog/ride/issues/431) | In shell completion mode, the first Tab with zero matches inserts no soft tab. | Actual completion callback on real native Monaco; second Tab and Classic controls work. |

### 1417 Inbound queue freeze

Source: `src/ide.js`, `rd` and `rrd`, around lines 193–225. The queue resets its timer marker only at the end of a successful rundown. A handler exception on a scheduled rundown bypasses that reset, leaving later messages queued behind a stale nonzero timer marker.

In a fresh test app, register a harmless handler and a throwing handler and deliver them in one JavaScript turn. The first message makes the second take the scheduled path:

```js
D.ide.handlers.AuditNoop = () => {};
D.ide.handlers.AuditThrow = () => { throw Error('queue audit'); };
D.recv('AuditNoop', {});
D.recv('AuditThrow', {});
```

After the uncaught exception, send `Execute` with `⎕←'upstream-proof-',⍕2+2`. The native transport received the input echo, prompt changes, and `AppendSessionOutput` containing `upstream-proof-4\n`; the session model stayed unchanged. The interpreter had completed the command correctly. This is a controlled error-injection reproduction, not a claim that every historical freeze issue has the same trigger.

A fix should restore queue scheduling after failure and allow later valid messages to run while exposing the original error. Its regression should force the **timer path**, make one handler throw, and verify that a later message is processed. A synchronous-only exception test would miss the persistent timer state.

### 1416 Workspace Explorer stale value-tip reply

Source: `src/bonsai.js`, `refresh`, `replaceTree`, and `requestValueTip`, around lines 154–200. Refresh resets shared pending-call accounting. A callback from the previous tree can then decrement the counter for the new tree and attempt to render it before its children exist.

Controlled native reproduction:

1. Construct the actual `D.Bonsai` with a children callback and value-tip callback that can be held pending. Populate a root with one variable child.
2. Request that child's value tip and retain its callback.
3. Call `refresh`, leaving the new root's children request pending.
4. Complete the old value tip before completing the new children request.

The native webview throws `TypeError: undefined is not an object (evaluating 'bt.nodes[0].children.map')` in `replaceTree`. The new refresh's pending count becomes zero while its children request is still outstanding. No interpreter is involved in this controlled race. Combined with #1417, an exception can also stop later inbound messages.

A fix should ensure callbacks from an earlier refresh cannot complete or mutate the current refresh. Test this exact ordering, then complete the current children request and verify the new tree remains usable. Do not treat a queue exception guard alone as a fix for the tree race.

### 1363 and 977 Editing an unindented tracer

Source: `src/ed.js`, `ED`, around lines 638–644.

1. Turn off format-on-open. Define `a←1` and `b←2`.
2. Open a function for editing and save exactly these lines, with **no leading spaces**:

```apl
r←audit977
r←a+b
```

3. Trace into `audit977`, place the caret at column 1 of its body line, and invoke Edit.

The real frontend sends `Edit` with `pos: 0`, `text: "r←a+b"`, and the tracer's window token. Dyalog responds by opening `r` in another editor; the original window remains a tracer. The native check invoked the bound Edit handler directly, so physical keyboard delivery is outside this result.

As a control, the existing empty-space Edit path sends `pos: 6` for that same text. Dyalog responds with `WindowTypeChanged`, `tracer: 0`, for the original token. The protocol already supports the intended conversion: the frontend must choose the appropriate position for the column-1 tracer action. Preserve ordinary Edit-on-name behavior elsewhere.

#977 is only partially outstanding: the gutter/empty-space route already provides a workaround. Also, creating the function with `⎕FX` alone inserts leading spaces and does **not** reproduce this case; saving the exact unindented source is essential.

### 745 Align Comments

Source: `src/ed.js`, `AC`, around lines 715–775.

Use this editor content with an empty selection and invoke Align Comments:

```apl
foo
⍝ standalone
x←1 ⍝ inline
```

Observed in real native Monaco:

```apl
foo
    ⍝ standalone
x←1 ⍝ inline
```

The standalone comment moves even though it was not selected. The older duplication failure involving selected text is already guarded, so this is a remaining part of the upstream issue. A fix should leave standalone comment lines alone during whole-function alignment while retaining their intended behavior when explicitly selected. Verify both modes with inline comments and uneven indentation.

### 1391 Indented class label colouring

Source: `src/mon_apl.js`, label token construction around line 545.

Load the upstream [class workspace attachment](https://github.com/user-attachments/files/28957105/class.zip), or tokenize this equivalent class structure:

```apl
:Class C
∇ f
          End: x←1
∇
:EndClass
```

The original attachment has ten spaces before `End:`. Native Monaco returns `white.apl` beginning at offset 0 and `meta.label.apl` beginning at offset 11. `E` is at offset 10, so it gets the whitespace scope; the label scope begins at `n`. This is a tokenization defect independent of Dyalog's execution of the function.

An unindented minimal example hides the bug: Monaco normalizes the first token's offset to zero. Preserve leading whitespace in the regression and check the final Monaco token ranges, not only the provider's raw first token. Construct the label token before advancing its start position.

### 431 Shell completion with no matches

Source: `src/ac.js`, completion reply handling around lines 169–195.

Set shell completion and indentation width 4. In a seven-character line, request completion with Tab at column 8 and receive an empty options list. The actual `D.ac` callback on native Monaco produced:

| Mode | Tab count | Result |
| --- | ---: | --- |
| Classic | 1 | One space inserted, reaching the next tab stop |
| Shell | 1 | No insertion; `tabComplete` remains 1 |
| Shell | 2 | One space inserted |

The shell-mode first-Tab early return runs before the no-options fallback. This reproduction controls the empty reply; it does not depend on which names happen to be in an interpreter workspace. Move the no-match handling to the appropriate point without losing shell common-prefix completion or its intentional second-Tab suggestion behavior. Test zero, one, and several matches. This is a narrower remaining variant of the upstream report.

## Cases excluded from the confirmed list

- **#913:** the actual runtime preference path correctly converts Off to a boolean. Both native Monaco suggestion options become false, and the custom Backspace path has an Off guard. Injecting the string `"off"` directly into a low-level handler bypasses the real call site and is not a product reproduction.
- **#1399:** the original quote-input function produced both `one` and `two` in the real native session when Enter was invoked through the session command. Dyalog 21.0.54424 did not reproduce the lost first output line.
- **#1401:** a direct protocol check using Tauride's launch arguments and an open stdin pipe accepted multiline input, returned to the regular prompt, and evaluated a subsequent expression. An alternate weak-interrupt path recovered too. The historical crash was not reproduced on this build.
- **#1395:** both actual native input and matched direct protocol retained the input expression and output in `GetLog`. The reported browser reconnect path remains unverified; this does not justify assigning it to the interpreter.
- **#589:** `3500⌶` HTML now sets both the document title and the actual native window caption from `<title>`.
- **#584:** the original SVG displays its first page and executes JavaScript; a simple timer-driven SVG animates. The original requestAnimationFrame-based animation did not advance during locked-screen sampling, so that motion remains unverified.
- **#1413:** the upstream maintainer identifies malformed AIX language-bar JSON generated by interpreter build tooling, tracked as Mantis 023191. No local AIX reproduction was attempted.
- **#915, #798, #529:** upstream discussion identifies absent protocol state or operations needed for the requested behavior. These are not established frontend-only fixes.
- **#1355:** the upstream diagnosis is a missing interpreter highlight notification. The current frontend guards the corresponding dereference; the exact multithreaded tracer scenario still needs a native run.

Prior issue work also matters: integrator regressions for **#1382 and #1388**, and the save-error work for **#1251**, are present in this working tree. A passing integrator check does not mean the same fix is on main. See [the existing fix validation](reopened-issue-validation.md) for those changes and their remaining native checks.

Next useful interactive checks are **#1357** (attached floating tracer/session reproduction), **#1392** (method navigation after scrolling), **#1400** (quote-input focus), **#1393** (Enter indentation), **#1358** (tracer backgrounds), **#1214** (fullscreen menu restoration), **#1221** (resize and print width), and **#217** (floating-window Reformat). They remain candidates, not confirmed Tauride defects. Historical disconnect/freeze reports #1182, #1184, and #1186 require their own triggers; resemblance to #1417 is insufficient.

## Complete open issue inventory

All 222 issues open on 10 October 2026 are included exactly once below. This is a triage inventory, not 222 successful runtime reproductions. “Not reproduced or addressed” includes negative probes and source evidence for an existing fix; each row states which. “Interpreter or protocol evidence” includes historical maintainer diagnoses and explicitly qualified probable ownership, not seven freshly reproduced interpreter defects.

| Classification | Issues |
| --- | ---: |
| Confirmed frontend defect | 7 |
| Candidate needing reproduction | 15 |
| Not reproduced or addressed | 40 |
| Interpreter or protocol evidence | 7 |
| Feature request or documentation | 125 |
| Platform or scenario unverified | 28 |

### Confirmed frontend defect

| Issue | Finding and evidence |
| --- | --- |
| [#1417](https://github.com/Dyalog/ride/issues/1417) An exception in a message handler can permanently freeze the inbound message queue | Actual-source VM timer-path throw leaves tid=1 and inbound Seen queued forever. Native parent probe independently receives output over transport while rendered model remains unchanged. |
| [#1416](https://github.com/Dyalog/ride/issues/1416) Workspace Explorer value tips can crash and freeze the session (input runs, nothing is echoed) | Actual-source Bonsai stale ValueTip callback after refresh resets pendingCalls to zero before outstanding children callback; replaceTree throws undefined.map. Parent confirms actual WKWebView callback ordering. |
| [#1391](https://github.com/Dyalog/ride/issues/1391) Syntax colouring of a label in a class can be wrong | Original class.dws source, line21: ten spaces + End:. Actual native Monaco returns white.apl at offset0 and meta.label.apl at11; E at offset10 has wrong scope. Unindented labels do not expose this defect. See detailed reproduction. |
| [#1363](https://github.com/Dyalog/ride/issues/1363) If the cursor is in the first column of the tracer window, hitting Edit should cause the tracer to be replaced with the editor | Native unindented tracer: ED at column1 sends Edit(pos0,text r←a+b), opens r, and leaves original tracer unchanged. Empty-space control sends pos6 and receives WindowTypeChanged(tracer0). #977 is partial: gutter/empty-space workaround exists. See detailed reproduction. |
| [#977](https://github.com/Dyalog/ride/issues/977) Need a way to switch from tracer to editor | Native unindented tracer: ED at column1 sends Edit(pos0,text r←a+b), opens r, and leaves original tracer unchanged. Empty-space control sends pos6 and receives WindowTypeChanged(tracer0). #977 is partial: gutter/empty-space workaround exists. See detailed reproduction. |
| [#745](https://github.com/Dyalog/ride/issues/745) AC (Align Comments) is broken | Actual native Monaco and AC command: without a selection, standalone comment moves four spaces to match an inline comment. Older partial-selection duplication is already guarded. See detailed reproduction. |
| [#431](https://github.com/Dyalog/ride/issues/431) Pressing <tab> at the end of the line has no effect. | Actual native Monaco and D.ac completion callback: shell mode first Tab with an empty completion reply inserts nothing; second Tab and Classic insert the expected space. Confirmed remaining variant, not a failure of every Tab. See detailed reproduction. |

### Candidate needing reproduction

| Issue | Finding and evidence |
| --- | --- |
| [#1400](https://github.com/Dyalog/ride/issues/1400) When Tracing a function, a line ⍞←’Msg’ ⋄ a←⍞ should make Ride switch focus to the session | Prompt2/4 handler explicitly calls session.focus; floating proxy and native focus must be exercised. Protocol is responsible for declaring prompt; OS focus belongs frontend. |
| [#1393](https://github.com/Dyalog/ride/issues/1393) WIBNI there were a way to get automatic indentation while typing a new function | General tabSize/indentSize now follow preference and language formatter preference tests pass. However automatic Enter indentation remains uncertain: on-type trigger declaration is commented and autoIndent option is boolean. Need actual Monaco/native Enter reproduction for reported 4 instead of7. |
| [#1392](https://github.com/Dyalog/ride/issues/1392) Double clicking on the name of a method of a class does not always accurately jump to that method's definition | Scrolldown class method doubleclick could involve cursor/display routing or interpreter method resolution. src/ed.js:638 sends clicked line text/column via Edit; OpenWindow cursor restoration uses protocol currentRow/currentColumn. No class.dws attachment in input and no native reproduction. |
| [#1364](https://github.com/Dyalog/ride/issues/1364) Type  function  into the editor with leading spaces; edit it again and the leading spaces do not appear; trace into it and they do, as does an edit session started from the tracer | Editing autoformat and tracer formatting differ; investigate with formatting disabled and raw OpenWindow/FormatCode payloads before attributing lost spaces to frontend. |
| [#1358](https://github.com/Dyalog/ride/issues/1358) Ride 4.6 shows odd background colours in a tracer window with 19.0 | Reported tracer background visual defect cannot be established by token scopes alone; requires floating tracer on affected interpreter20/19 and theme. Current theme active/pendent rules inspected, no native UI launched. |
| [#1357](https://github.com/Dyalog/ride/issues/1357) Typing in session and floating edit window can disconnect Ride from Dyalog where no output from Dyalog is echoed in the session | Exact floating-tracer/session interaction remains unverified. Upstream includes repro21497.zip; current session source alone cannot prove the issue fixed or identical to queue defect1417. |
| [#1221](https://github.com/Dyalog/ride/issues/1221) Changes to the size of the Ride window are not passed on the the APL session (Mac only) | Source Identify calls updPW after connected flag; layout resize calls updPW based on viewportColumn. Needs native preconnection resize to prove stale layout dimensions. |
| [#1214](https://github.com/Dyalog/ride/issues/1214) Toggling Full Screen off makes the menu bar disappear | FUL uses DOM full-screen enter/exit; Tauri uses HTML menu except macOS native menu. No native toggle reproduction, so different shell does not prove menu restoration fixed. |
| [#1186](https://github.com/Dyalog/ride/issues/1186) Bug: RIDE detaches from the interpreter and stops relaying any input or output; then orphans the process. | No reliable original trigger; output silence may involve queue1417 but issue also claims no input and orphan process. Cannot equate all symptoms or establish shared cause. |
| [#1184](https://github.com/Dyalog/ride/issues/1184) Bug: RIDE detaches from the interpreter and does not relay the output; however it still relays input and thinks that the interpreter crashed upon )off. | No reliable reproduction; output-only silence resembles queue failure but source-confirmed1417 does not establish same trigger in this historical issue. |
| [#1183](https://github.com/Dyalog/ride/issues/1183) Bug: RIDE layout shuffles upon connecting to a remote server. | Remote connection layout shuffle report without deterministic instructions. GoldenLayout persistence frontend-owned; actual layout restore needed. |
| [#1182](https://github.com/Dyalog/ride/issues/1182) Bug: RIDE detaches from the interpreter after issuing weak interrupt, assumes interpreter crashes, orphans an interpreter in a busy loop. | Weak interrupt historical detach/orphan report lacks repro. Direct1401 interrupt probe recovers but is different trigger; cannot call original fixed or interpreter bug. |
| [#981](https://github.com/Dyalog/ride/issues/981) Unix RIDE fails to automatically use ssh keys | SSH options use explicit key path only and otherwise password; no default key discovery or agent in cn.sshExec. Tauride Rust ssh transport may use different fallback, needs controlled SSH endpoint. |
| [#639](https://github.com/Dyalog/ride/issues/639) Ride needs to work on its speedwriting | Mixed issue: upstream confirms LF rendering difference occurs in Windows IDE (interpreter), but separate unlimited-session-log performance is frontend. Maintainer optimized once; benchmark/current slowdown not reproduced. Do not count as confirmed frontend fault. |
| [#217](https://github.com/Dyalog/ride/issues/217) WIBNI Reformat was a menuitem/context menuitem or toolbar item | Menu Reformat already added upstream; comment says floating-window dispatch remains broken. Needs current floating window menu action check, source presence alone cannot establish failure. |

### Not reproduced or addressed

| Issue | Finding and evidence |
| --- | --- |
| [#1405](https://github.com/Dyalog/ride/issues/1405) Autocomplete does not trigger after ##. in a namespace reference | At threshold0 provider sends GetAutocomplete for aa.bb.cc.##. and aa.bb.cc. alike; at threshold2 it suppresses both dot requests because left word has zero length. Upstream asks about threshold0; no ##-specific frontend defect established. |
| [#1403](https://github.com/Dyalog/ride/issues/1403) Text after :section and :endsection should be comment colour | VM tokenizer gives comment.apl to all suffix text after both :section and :endsection. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. |
| [#1402](https://github.com/Dyalog/ride/issues/1402) :field does not autocomplete | VM provider offers Field inside class and class section; no Field in namespace. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. |
| [#1401](https://github.com/Dyalog/ride/issues/1401) Interpreter SysError-crashes (with malformed dying message) or hangs unrecoverably when a RIDE client interacts with session multiline input (prompt type 3) | Exact Tauride spawn args +s -q -nokbd with open stdinPIPE, fresh directTCP Dyalog21.0.54424: :If1 prompt3; second Execute2+2 accepted, :EndIf returns regular prompt, subsequent2+2prints4. WeakInterrupt alternate also recovers and subsequent2+2prints4. Earlier inherited harness stdinDEVNULL caused competing consoleEOF and a SysError artifact; excluded. |
| [#1399](https://github.com/Dyalog/ride/issues/1399) ⍞ input glitch in RIDE 4.6 for Mac | Parent native exact function reproduction with actual session.exec(0) at quoteQuad prompt4 passed: transport sends which newline, returns one then newline then two newline; session visibly shows both rows. Dyalog21.0.54424. Native evidence ride-upstream-editor-native-results.json. |
| [#1394](https://github.com/Dyalog/ride/issues/1394) Get a "No suggestions." error if press Tab after setting Autocompletion→Make suggestions after to 2 characters | acBelowLimit prevents manual suggest below threshold and Tab indents instead; previous fix present. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. |
| [#1390](https://github.com/Dyalog/ride/issues/1390) Wrong colouring of text immediately following a colon in Array Notation | VM apl-session tokenizer of (a:2) and b←10 ⋄ (a:b) has no invalid scopes. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. |
| [#1388](https://github.com/Dyalog/ride/issues/1388) Function line numbers don't show in a namespace script while editing | 20 passing language/editor unit checks include script-relative numbering, edit refresh, first-line delimiter and recursive dfn cases. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. Regression checks pass on the integrator with its uncommitted fixes; this is not proof that main contains the fixes. |
| [#1387](https://github.com/Dyalog/ride/issues/1387) Save path of interpreters on SSH connections as you do for local session | Upstream maintainer cannot reproduce and reports remote exe remembered. Current exe selection onchange dispatches change, writes sel.exe, unlike described omission; requires an SSH endpoint for end-to-end confirmation. |
| [#1383](https://github.com/Dyalog/ride/issues/1383) Failure to colour unmatched parenthesis/bracket/brace as error | VM apl-session ([{' assigns invalid.parenthesis/invalid.square/invalid.dfn/invalid.string. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. |
| [#1382](https://github.com/Dyalog/ride/issues/1382) Wrong colouring of some parentheses and brackets as if they were array notation | VM apl-session (a)[] and (a)[]⋄ retain parenthesis/square scopes. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. Regression checks pass on the integrator with its uncommitted fixes; this is not proof that main contains the fixes. |
| [#1380](https://github.com/Dyalog/ride/issues/1380) Increase font size is not also on Ctrl + | Default Increase binding includes Ctrl+Shift+= (and Cmd+Shift+= on macOS), equivalent to Ctrl++ on ordinary layouts. Native keyboard event/layout still needs validation, but reported missing default binding is now present. |
| [#1366](https://github.com/Dyalog/ride/issues/1366) The hint for a namespace reference has the closing "]" in the wrong colour | Actual ValueTip handlers VM-tested with class9 #.[Namespace]: both return plaintext fenced tip; brackets cannot get APL syntax error colour. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. |
| [#1356](https://github.com/Dyalog/ride/issues/1356) Monaco editor line count gets out of sync with stored session lines | isInputLine now guards undefined line entries. Original crashing dereference removed; exact long tracing sequence unspecified and not reproduced. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. |
| [#1353](https://github.com/Dyalog/ride/issues/1353) Connections screen: if you change the host of the version, that is remembered for next time.  If you chance the exe path by selecting from the interpreter list it isn't | Current q.exes.onchange calls $(q.exe).change; q.exe.onchange writes selected configuration exe. Source no longer matches reported path failing to persist. Remote-host interpreter list scenario not executed. |
| [#1321](https://github.com/Dyalog/ride/issues/1321) Ride 4.6.4211 puts out an error/warning message about :ERROR:atom_cache.cc(229)] Add  _NET_WM_STATE_MODAL to kAtomsToCache | Exact Chromium atom_cache.cc warning belongs to Electron shell. Tauride uses WebKitGTK on Linux, so that exact warning path is not active. This does not establish general Wayland modal-window correctness. |
| [#1313](https://github.com/Dyalog/ride/issues/1313) Some idioms are not styled with a primitive function on their left | VM +⍴⍴, +≢⍴ retain idiom scopes; primitive runs stop at idiom start. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. |
| [#1273](https://github.com/Dyalog/ride/issues/1273) Ride should check the available hardware before establishing its main GUI somewhere invisible | Tauri geometry restore compares saved rectangle with primary monitor work area and drops mostly off-screen coordinates while clamping size, addressing described removed-left-monitor case. Not verified across every multi-monitor arrangement. |
| [#1256](https://github.com/Dyalog/ride/issues/1256) a←⎕ causes a VALUE ERROR when the user does not enter anything but presses "Enter" | Tauride session.exec returns for blank quad input. Direct Dyalog21 TCP blank Execute reprompts (type2), no VALUE ERROR. Original interpreter defect not reproducible in tested version. |
| [#1251](https://github.com/Dyalog/ride/issues/1251) When attempting to fix a function from file that cannot be fixed, Ride generates two msgboxes, whereas the IDE generates one. | Integrator-only save-explanation routing fix matches same Cant Fix + ReplySaveChanges reproduction; docs and source/IPC regressions support one explanation while retaining fallback. Native docked/floating save flow still unverified. Baseline had duplicate-message path. |
| [#1231](https://github.com/Dyalog/ride/issues/1231) Test software appears to be out of date. | Integrator replaces Spectron runner with Tauri native WebDriver harness and AVA, plus display-independent regressions. README documents unlocked desktop/Accessibility requirements; full native suite remains to run. Baseline test tooling was still old. |
| [#1229](https://github.com/Dyalog/ride/issues/1229) RIDE shows a red square if you use the APL Symbols (Dyalog APL) layout and type the keystroke for <ED> | Private-use U+F828 now maps to ED in Dyalog command table and native keydown handler prevents insertion; both editor and session install mapping. Target Wayland delivery of event remains unverified. |
| [#1228](https://github.com/Dyalog/ride/issues/1228) Unhelpful msgbox when attempting to connect to an interpreter via ssh, but no password added | Current SSH validate checks empty password/key and opens explicit password prompt before connecting; obsolete undefined-buffer error path does not match current guard. |
| [#1215](https://github.com/Dyalog/ride/issues/1215) Cloning a configuration creates an inconsistenly named config item | Clone stores suffixed name in cnData, list displays cnData.name, selection assigns that same name to details input. Old list/detail mismatch not present in current source. |
| [#1204](https://github.com/Dyalog/ride/issues/1204) Autocomplete does not work in brackets | VM at column9 in a[longva] sends GetAutocomplete pos8 with full line. Frontend right-bracket request suppression removed; interpreter reply not tested. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. |
| [#1192](https://github.com/Dyalog/ride/issues/1192) Some of the default editor colour schemes are too subtle for my old eyes .. I cannot see the Scrollbar Thumb | Source derives scrollbarSlider colours from foreground, addressing dark theme thumb visibility. No native visual reproduction. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. |
| [#1103](https://github.com/Dyalog/ride/issues/1103) Ride not able to connect to docker container | Upstream maintainer tested Docker and Podman successfully; correct quoted RIDE_INIT plus image command connects. No local container repro performed. |
| [#986](https://github.com/Dyalog/ride/issues/986) Open editors should group | Tauride explicitly runs all session windows in one process and registers native macOS Window menu role; addresses requested session grouping. Actual OS task-switcher presentation not exercised in this source audit. |
| [#980](https://github.com/Dyalog/ride/issues/980) Status windows is always on top | Status helper creation explicitly has alwaysOnTop:false, modal:false, parent session. Permanent always-on-top flag absent; parent-child platform stacking still requires UI. Docking part is enhancement. |
| [#967](https://github.com/Dyalog/ride/issues/967) Use the Window menu to switch between RIDE instances on MacOS | All sessions now share one application and native Window submenu is registered as NSApp windows menu, supporting cross-session switch. Source evidence; native Window menu check still advisable. |
| [#947](https://github.com/Dyalog/ride/issues/947) Autocomplete works only at the end of a line | VM provider at dot in #.APLGit2. -m "..." sends GetAutocomplete full line and cursor pos10 at limit0. Current frontend has no end-of-line restriction. Actual interpreter reply remains unverified. |
| [#939](https://github.com/Dyalog/ride/issues/939) Del editor in the session errors when trying to re-defined a pasted function with argument or local names | Both Tauride trees transform clear quadVR-style listings into quadFX, redefining functions; integrator batches long lines and preserves spacing. Existing raw audit twice quadFX and callFn7 succeeds. |
| [#916](https://github.com/Dyalog/ride/issues/916) :Property does not autocomplete with a code snippet if you type it within a :Section | VM Property snippet available within nested :Section in :Class. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. |
| [#914](https://github.com/Dyalog/ride/issues/914) Action>Clear all trace/stop/monitor fails to count stops in unsaved functions | Main counts unsaved stops; integrator tracks async floating replies, countUnsavedStops and clearAllStops, preventing stale count. Existing implementation directly addresses repro. |
| [#913](https://github.com/Dyalog/ride/issues/913) Autocomplete box always appears when you backspace even if Autcomplete is Off | Actual native preference change Classic to Off leaves quickSuggestions=false and suggestOnTriggerCharacters=false. ide.js converts the preference to a boolean for docked and floating windows; ac.js also guards Backspace when Off. Historical keyboard popup not reproduced; direct string injection into the low-level handler is not the product path. |
| [#731](https://github.com/Dyalog/ride/issues/731) Fresh install on Debian 10 asks for chrome-sandbox to be made setuid | Exact chrome-sandbox setuid abort belongs to Electron Chromium sandbox packaging absent from Tauride Linux shell. Debian10 support and general startup are not established by this exclusion. |
| [#634](https://github.com/Dyalog/ride/issues/634) Pasting extremely large lines results in infinite loop of "INPUT LIMIT" alerts | Main deduplicates repeated INPUT LIMIT dialogs; integrator scopes suppression to one Execute input operation and auto-answers repeats. Interpreter-origin limits still occur but infinite modal repeat addressed. |
| [#604](https://github.com/Dyalog/ride/issues/604) ^ isn't treated as ∧ in idioms | Fallback idioms include ^ variants; parseSyntaxInformation adds ^ aliases from interpreter ∧ idioms. Session tokenizer recognises alias. Initial apl first-line header tokenization is not a valid idiom reproduction. 9 issue-level VM assertions and 20 language/editor tests passed on integrator where applicable. |
| [#589](https://github.com/Dyalog/ride/issues/589) 3500⌶ doesn't use <html><head><title> as window caption | Native 3500⌶ HTML with <title>my audit title</title>: both document.title and native Tauri window title become my audit title. Current HTML title behavior verified. |
| [#136](https://github.com/Dyalog/ride/issues/136) Mac: Cmd+q appears to quit APL but can leave "invisible" background process running. | macOS/Unix owned process trees receive SIGTERM then SIGKILL at app exit, addressing old busy-loop orphan mechanism. Existing source unit coverage/lifecycle tests, native force-quit still distinct. Windows production kill_all is no-op; test feature uses taskkill, so do not generalize fix to Windows. |

### Interpreter or protocol evidence

| Issue | Finding and evidence |
| --- | --- |
| [#1413](https://github.com/Dyalog/ride/issues/1413) Ride 4.5 onwards, Dyalog 21.0 onwards: when trying to connect to Dyalog on AIX, get "Bad control character in string literal in JSON at position 4322 (line 270 column 12) | Upstream maintainer explicitly diagnoses invalid AIX languagebar.json generated by openxlC 17.1, Mantis 023191; not Ride. No AIX execution available. |
| [#1355](https://github.com/Dyalog/ride/issues/1355) Ride freezes / hangs after tracing into a dfn while another thread is running. | Upstream maintainer explicitly says interpreter fails to send SetHighlightLine; frontend ReplyFormatCode now guards absent HIGHLIGHT, so known interpreter omission no longer throws that dereference. Exact multithread UI repro not run. |
| [#915](https://github.com/Dyalog/ride/issues/915) Editor doesn't update upon ⎕STOP | Upstream maintainer explicitly states protocol has no support to reflect changes to stop vector; frontend never receives update. |
| [#884](https://github.com/Dyalog/ride/issues/884) Executing MA in the session works as it should as long as the function does not quit but syserrs when it finally does | Original report is an interpreter syserr3 and maintainer asks for aplcore; no reproducible function or current frontend exception evidence. Probable interpreter ownership, not a fresh diagnosis. |
| [#798](https://github.com/Dyalog/ride/issues/798) When deleting a block from the session log, only text content is removed, while the lines themselves remain | Upstream explains permanent deletion requires protocol extension RFE20011; temporary disappearing-line defect fixed in5210388. Current source cannot permanently remove interpreter-owned log. |
| [#529](https://github.com/Dyalog/ride/issues/529) RIDE always shows status window | Original 2036 I-beam state is not included in StatusOutput protocol; comments explicitly track interpreter Mantis17116. Frontend now honors its autoStatus preference, but cannot infer untransmitted I-beam state. Needs protocol/interpreter investigation, not frontend-only bug assertion. |
| [#514](https://github.com/Dyalog/ride/issues/514) Interrupts are generally ignored in Quote-Quad Input | Probable interpreter ownership based on upstream interpreter label and quote-input interrupt semantics; no fresh request/response reproduction. Excluded from confirmed frontend list, not declared fixed. |

### Feature request or documentation

| Issue | Finding and evidence |
| --- | --- |
| [#1412](https://github.com/Dyalog/ride/issues/1412) We no longer need (ie 4.7 and 4.8 onwards) to build for Raspberry Pi/32 and macOS/x86 | Build-target removal request for Dyalog releases; not a runtime defect. |
| [#1411](https://github.com/Dyalog/ride/issues/1411) Need 4.7 documentation and for 4.7 to appear in the dropdown | Upstream documentation version/dropdown publication request. |
| [#1398](https://github.com/Dyalog/ride/issues/1398) Create 4.7 branch to be shipped with 21.0 and bump master version | Upstream release branch/Jenkins bookkeeping request. |
| [#1397](https://github.com/Dyalog/ride/issues/1397) Ride's config tag "Title" | Requests preference terminology Caption rather than Title; no malfunction claimed. |
| [#1396](https://github.com/Dyalog/ride/issues/1396) In the "Title" section of the Ride config, support "NSID" and "SNSID" | Additional NSID/SNSID caption substitutions requested. |
| [#1389](https://github.com/Dyalog/ride/issues/1389) Remove minimum window height/width | Requests removal of a deliberate size constraint; not a broken existing behavior. |
| [#1386](https://github.com/Dyalog/ride/issues/1386) Enable the current thread Id to be included in the Window Title | Requests new TID caption placeholder; substitution map has no TID. Existing unsupported token remains literal by design. |
| [#1365](https://github.com/Dyalog/ride/issues/1365) WIBNI the output from system commands was wrapped according to the current width of the _Ride_ session - contentious issue possibly | Requests changed wrapping policy for system output; interpreter emits wrapped output and SetPW currently updates print width. Explicit contentious enhancement. |
| [#1360](https://github.com/Dyalog/ride/issues/1360) Offer hints on entering APL symbols to first-time users | Requests first-run symbol-entry hints. |
| [#1341](https://github.com/Dyalog/ride/issues/1341) Syntax colouring: New entity for hybrids | New hybrid token category requested; explicitly explains ambiguous primitive semantics. |
| [#1339](https://github.com/Dyalog/ride/issues/1339) Show status for all states | Requests richer text/status indicators for existing interpreter states. |
| [#1319](https://github.com/Dyalog/ride/issues/1319) Create a release for Linux/ARM64 | Requests new Linux ARM64 release artifact. |
| [#1302](https://github.com/Dyalog/ride/issues/1302) Proper JSON in prefs.json | Requests typed nested preference serialization. src/prf.js:229 writes valid outer JSON, while object-valued preferences intentionally use string serialization at :179; readability/schema enhancement, not invalid JSON. |
| [#1297](https://github.com/Dyalog/ride/issues/1297) WIBNI the About box had a context menu to allow you to copy selected text | Requests About selection context menu. |
| [#1296](https://github.com/Dyalog/ride/issues/1296) WIBNI you could search within the log window | Requests log-search feature. |
| [#1295](https://github.com/Dyalog/ride/issues/1295) WIBNI the log window supported mouse-based copy operations (context and menubar/menuitems) | Requests log copy menu features. |
| [#1285](https://github.com/Dyalog/ride/issues/1285) macOS documentation: Ride config files go in ~/Library/Application Support/Dyalog-<version>,  not ~/Library/Application Support/Ride-<version> | Documentation correction specifically for interpreter-integrated Ride storage, not standalone Tauride path. |
| [#1275](https://github.com/Dyalog/ride/issues/1275) Ride and windows IDE code folding differ | Parity/new folding feature for :Select requested; issue discussion recognises IDE differences. |
| [#1270](https://github.com/Dyalog/ride/issues/1270) New storage locations | Requests redesigned platform storage layout; src-tauri/src/lib.rs:59 uses current Ride-4.8 path intentionally. |
| [#1264](https://github.com/Dyalog/ride/issues/1264) Please document how to bring across settings from one version of RIDE to another  | Requests version-to-version settings migration documentation. |
| [#1263](https://github.com/Dyalog/ride/issues/1263) Upgrading to newer Ride section | Upgrade documentation requested. |
| [#1262](https://github.com/Dyalog/ride/issues/1262) Add a link to the 4.4 docs | Requests a link to historical PDF documentation. |
| [#1254](https://github.com/Dyalog/ride/issues/1254) Investigate better way to handle keyboard input | Research request for physical keyboard input architecture. |
| [#1253](https://github.com/Dyalog/ride/issues/1253) Implement tab input method in RIDE | Requests TryAPL tab input method; existing prefix keyboard implementation differs. |
| [#1252](https://github.com/Dyalog/ride/issues/1252) Consider adding a way to package for the current system | Requests host-platform packaging convenience; Electron mk path differs from cargo tauri build. |
| [#1248](https://github.com/Dyalog/ride/issues/1248) Build process: ensure that Ride can be built without the need to access any Dyalog private/internal repositories | Requests removal of private build dependencies; upstream build infrastructure scope, not frontend runtime. |
| [#1247](https://github.com/Dyalog/ride/issues/1247) Build process: on Windows, use VS2022 rather than VS2015 when packaging Ride | Requests internal Windows build toolchain migration. |
| [#1246](https://github.com/Dyalog/ride/issues/1246) Build process: we should not be deleting build directories after a build - they are deleted beforehand anyway, and may contain useful info | Requests Jenkins artifact retention; internal build workflow scope. |
| [#1242](https://github.com/Dyalog/ride/issues/1242) Deploy docs to use "Ride" instead of "RIDE" | Requests deployed documentation spelling correction. |
| [#1238](https://github.com/Dyalog/ride/issues/1238) Separate and expand colour schemes from preferences | New colour scheme storage/format requested. |
| [#1232](https://github.com/Dyalog/ride/issues/1232) RIDE commandline should use the default config | Empty issue body; title requests command-line default-config behavior without a reproduction. src/cn.js:1124 currently autostarts topmost config, defaultConfig is selected when autoStart false. |
| [#1230](https://github.com/Dyalog/ride/issues/1230) Add ability to invoke interpreter-side PFKeys | Requests interpreter-side PFKEY integration; frontend PFKEY queue currently executes local commands/text. |
| [#1227](https://github.com/Dyalog/ride/issues/1227) Get rid of config option "Show toolbar" | Requests removing toolbar preference; comments propose moving it into View menu. |
| [#1220](https://github.com/Dyalog/ride/issues/1220) WIBNI I could start a certain config by passing its name as a commandline argument | Named startup config feature exists through RIDE_CONF, src/cn.js:1112; command-line argument interface remains an enhancement. |
| [#1216](https://github.com/Dyalog/ride/issues/1216) Cloning a configuration puts the clone above the original in the "Available Configurations" | Requests clone below source. Existing deliberate insertBefore in src/cn.js:1067 places ordinary clone above; reproduced by source control flow, but this is ordering preference/enhancement. |
| [#1213](https://github.com/Dyalog/ride/issues/1213) Trace/Edit configuration should support "Skip [blank\|comment\|locals] lines when tracing" features that Windows IDE provides | Requests Windows tracer skip blank/comment/locals capabilities; no regression claimed. |
| [#1194](https://github.com/Dyalog/ride/issues/1194) Add menu items "quit to connect screen" and "quit and restart" | Requests restart/quit menu features; connectOnQuit already exists but full proposed restart behavior is enhancement. |
| [#1181](https://github.com/Dyalog/ride/issues/1181) Feature request: Option to disable middle click paste on Linux | Explicit Linux preference feature for suppressing middle-click primary clipboard paste. |
| [#1175](https://github.com/Dyalog/ride/issues/1175) Documentation: Zero footprint RIDE does not appear in any navigation | Requests discoverable zero-footprint documentation navigation. |
| [#1166](https://github.com/Dyalog/ride/issues/1166) Review RIDE User Guide Appendix A .. many of the keyboard commands are not appropriate when using RIDE | Documentation correction for unsupported keyboard command table. |
| [#1165](https://github.com/Dyalog/ride/issues/1165) Zero footprint RIDE app is now included in 17.1 and 18.0 installation directories | Documentation announcement/instructions for interpreter-bundled zero-footprint Ride. |
| [#1164](https://github.com/Dyalog/ride/issues/1164) More details needed on the RIDE_EDITOR configuration parameter | Requests clarification of RIDE_EDITOR documentation. |
| [#1163](https://github.com/Dyalog/ride/issues/1163) Additional info re HttpDir | Requests clarification of interpreter HttpDir configuration documentation. |
| [#1138](https://github.com/Dyalog/ride/issues/1138) Set ⎕SD | Requests protocol/interpreter update to quadSD; frontend SetPW sends only pw and no height. Interpreter/protocol enhancement labels align. |
| [#1094](https://github.com/Dyalog/ride/issues/1094) Review what we do at various stages of the commit/pull request/build process to reduce load and improve performance & stability | Requests CI performance/workflow redesign. |
| [#1092](https://github.com/Dyalog/ride/issues/1092) [Dyalog internal] The permissions on the o/s directories in /devt/builds/* are far too restrictive | Internal Dyalog build directory permissions request; no user frontend reproduction. |
| [#1071](https://github.com/Dyalog/ride/issues/1071) Menubar overhaul | Requests comprehensive menu redesign/additional features. |
| [#1070](https://github.com/Dyalog/ride/issues/1070) ride shell command on macOS | Requests macOS shell launcher/default interpreter convenience. |
| [#1030](https://github.com/Dyalog/ride/issues/1030) Split Debug window into Threads and Stack | Requests independent Threads and Stack panes. |
| [#1021](https://github.com/Dyalog/ride/issues/1021) Context menu rework | Requests context-sensitive editing menu features. |
| [#1020](https://github.com/Dyalog/ride/issues/1020) Remove floating windows option on MacOS | Requests removing floating-window preference on macOS to support session grouping; Tauride now groups session windows in one process, but removal remains policy enhancement. |
| [#1018](https://github.com/Dyalog/ride/issues/1018) Allow using up and down keys for non-navigation in the session | Requests configurable alternative use of up/down session keys. |
| [#1005](https://github.com/Dyalog/ride/issues/1005) RIDE client needs to work on 64-bit Raspberry Pi O/S (it may already do so, but it may need a new build target) | Requests Raspberry Pi ARM64 support/build target. Hardware-specific runtime requires ARM64 host and packaged artifact; not a confirmed frontend defect. |
| [#998](https://github.com/Dyalog/ride/issues/998) Documentation: Mention Docs in the readme | Requests README documentation link. |
| [#996](https://github.com/Dyalog/ride/issues/996) QOL upgrade: Jenkins setting can be changed to not build a PR if changes are to non code files | Jenkins trigger policy improvement, not app defect; Tauride uses different CI. |
| [#991](https://github.com/Dyalog/ride/issues/991) Windows packaging relies on code in the internal Dyalog svn repository (and hardcodes the path to svn too) | Requests removal of private Windows packaging dependencies. |
| [#989](https://github.com/Dyalog/ride/issues/989) The fields "Arguments and "Configuration parameters" need attention | Connection configuration labels/tooltips redesign requested. |
| [#988](https://github.com/Dyalog/ride/issues/988) Add support for "Skip comment lines when tracing" (and "..blank lines" as well as "local lines") | Tracer skip-comment/blank/local feature request, same family1213. |
| [#983](https://github.com/Dyalog/ride/issues/983) FEATURE: Find Objects | Requests Find Objects UI/protocol extension; comment tracks interpreter-side Mantis18535. |
| [#982](https://github.com/Dyalog/ride/issues/982) FEATURE: Functional stack navigation  | Requests stack navigation protocol/interpreter/UI features; body explicitly identifies missing interpreter SetSIStack/source support. |
| [#979](https://github.com/Dyalog/ride/issues/979) Colour testing area should demo all possible token types | More colour preview examples requested. |
| [#976](https://github.com/Dyalog/ride/issues/976) Adopt Windows IDE's tracer toolbar button icons | Requests alternative tracer icons; design preference. |
| [#975](https://github.com/Dyalog/ride/issues/975) Add ASCII compositions | Requests additional ASCII compositions. |
| [#974](https://github.com/Dyalog/ride/issues/974) add fr_FR_Mac and es_ES_Mac keyboard layouts | Requests two new macOS keyboard-layout definitions. |
| [#973](https://github.com/Dyalog/ride/issues/973) WIBNI RIDE new edit windows had a height that reflected the number of rows of the text | Requests initial editor window height derived from source rows instead of remembered geometry. |
| [#969](https://github.com/Dyalog/ride/issues/969) Connect screen title should be "New Session" | Requests connection screen title wording New Session. |
| [#960](https://github.com/Dyalog/ride/issues/960) Feature request: a way to export and import your RIDE settings | Requests settings import/export feature. |
| [#957](https://github.com/Dyalog/ride/issues/957) Add toggle for editor toolbar | Requests toolbar toggle command/menu shortcut; global preference already exists. |
| [#950](https://github.com/Dyalog/ride/issues/950) Missing overwrite mode | Overwrite mode feature requested. |
| [#946](https://github.com/Dyalog/ride/issues/946) On the Mac Ctrl+F8 does not have an effect | Ctrl+F8 is not default Reformat binding: src/cmds.js:56 uses NumPad_Divide; menu already includes Reformat at src/prf.js:97. User shortcut/platform support needs native check but title alone does not establish default-binding regression. |
| [#945](https://github.com/Dyalog/ride/issues/945) Same menu items differ on Windows and Mac | Intentional Settings/Preferences platform terminology discussed in comments; consistency request. |
| [#941](https://github.com/Dyalog/ride/issues/941) Support more editing commands in PF-key definitions | Requests additional programmable keyboard commands; underlying Monaco functions not all exposed. |
| [#938](https://github.com/Dyalog/ride/issues/938) Add ability to change background colour on any token type | Arbitrary token background control feature requested; Monaco token theme may constrain support. |
| [#936](https://github.com/Dyalog/ride/issues/936) The special trailing space on the language bar should be allowed to sit under the keyboard icon | Requests language-bar spacer wrapping/layout improvement. |
| [#935](https://github.com/Dyalog/ride/issues/935) Editor should be able to fetch a text source file and remember its association with APL items it defines | Requests file source association/open workflow. |
| [#933](https://github.com/Dyalog/ride/issues/933) Editor should be able to create text source files | Requests Save As text-source creation. |
| [#932](https://github.com/Dyalog/ride/issues/932) Show source file path even with docked windows | Requests docked editor source-path display. |
| [#922](https://github.com/Dyalog/ride/issues/922) Linux Color highlighting for all lines | Historical session syntax highlighting feature requested. |
| [#855](https://github.com/Dyalog/ride/issues/855) Window title tag {PROFILE} should point at the effective profile rather than "last configuration" | Requests effective profile title rather than selected last-configuration label; caption currently substitutes ide.profile populated at connection. |
| [#848](https://github.com/Dyalog/ride/issues/848) Language bar tip should include the "More" link | Requests More documentation links in language-bar tips. |
| [#825](https://github.com/Dyalog/ride/issues/825) Use colour to differentiate output from input | Input/output colour distinction feature requested. |
| [#824](https://github.com/Dyalog/ride/issues/824) Provide a way to clear the session log | Explicit clear-session-log feature; visible size limit exists. Permanent interpreter-log clearing requires protocol extension per upstream. |
| [#816](https://github.com/Dyalog/ride/issues/816) GUI Configuration item for LOG_FILE_INUSE | Requests GUI setting for interpreter LOG_FILE_INUSE. |
| [#799](https://github.com/Dyalog/ride/issues/799) File>Save/Save As… missing from menu | Requests Save/Save As text-file export menu. |
| [#782](https://github.com/Dyalog/ride/issues/782) Inquiry: Bringing in printer options | Printing roadmap inquiry, expressly not a bug request. |
| [#748](https://github.com/Dyalog/ride/issues/748) Option to syntax highlight past lines in REPL | Historical REPL syntax highlighting explicitly described as intended behaviour. |
| [#716](https://github.com/Dyalog/ride/issues/716) Missing "Allow session above edit and trace windows" config option | Requests layout preference session above editor/tracer. |
| [#619](https://github.com/Dyalog/ride/issues/619) Support syntax highlighting of JSON(5) and XML | JSON/XML language auto-detection feature requested. |
| [#597](https://github.com/Dyalog/ride/issues/597) Add support for documented commands | Requests currently unsupported keyboard commands documented incorrectly; maintainers identify future enhancement and documentation correction. |
| [#596](https://github.com/Dyalog/ride/issues/596) `selection` variable in menu | Requests selected-text substitution in custom URL menu entries. |
| [#594](https://github.com/Dyalog/ride/issues/594) Allow atomic items on the menu bar | Requests top-level one-click action menu items. |
| [#588](https://github.com/Dyalog/ride/issues/588) 3500⌶ should create a new window at every call | Requests multiple 3500 HTML windows/new protocol handles. src/ide.js:861 deliberately reuses singleton; discussion recognizes backwards compatibility/protocol design. |
| [#583](https://github.com/Dyalog/ride/issues/583) WIBNI, like the IDE, when you click on a line in the SIStack window, the tracer window showed that function | Requests SI stack click to show selected function in tracer. |
| [#556](https://github.com/Dyalog/ride/issues/556) shortcuts to delete a character, a word, to eol | Requests exposing more Monaco actions as programmable commands. |
| [#545](https://github.com/Dyalog/ride/issues/545) WIBNI: Search for a term on specified site with keyboard shortcut | Requests online selected-term search shortcut. |
| [#530](https://github.com/Dyalog/ride/issues/530) Ambiguity in File > Open menu | Requests File Open filter/affordance clarification; comments confirm all interpreter-supported source files are accepted, not just .dyalog/.dws. |
| [#512](https://github.com/Dyalog/ride/issues/512) Insert key should switch to overwrite mode | Insert overwrite toggle feature requested. |
| [#483](https://github.com/Dyalog/ride/issues/483) Stand alone editor | Requests standalone editor without interpreter. |
| [#450](https://github.com/Dyalog/ride/issues/450) In the tracer FD wraps but BK doesn't | Requests consistent BK/FD boundary semantics; commands are TraceBackward/TraceForward interpreter operations, upstream Mantis14716 and deliberate ODE decision. |
| [#447](https://github.com/Dyalog/ride/issues/447) Feature request: show current namespace in a status bar | Requests current namespace status display and namespace switcher. |
| [#446](https://github.com/Dyalog/ride/issues/446) Commenting and un-commenting selected lines should be available from the context menu | Comment commands in context menu feature requested. |
| [#440](https://github.com/Dyalog/ride/issues/440) Make 4454⌶ work in Ride | Requests undocumented interpreter-driven search integration; maintainers oppose scope. |
| [#410](https://github.com/Dyalog/ride/issues/410) Workspace explorer icons background colours are too harsh | Subjective workspace explorer icon palette redesign requested. |
| [#404](https://github.com/Dyalog/ride/issues/404) WIBNI: DM demo system: conditional display and execute of lines | Requests demo script display/execution escape conventions; comments explain protocol changes. |
| [#378](https://github.com/Dyalog/ride/issues/378) MacDyalog needs a way to query the session window height and width | Requests new client-rectangle/quadSD protocol capability; proposal ReplyGetClientRect requires interpreter support. |
| [#329](https://github.com/Dyalog/ride/issues/329) Allow user to use a dead key as the prefix key if they want to | Requests reliable dead-key prefix behavior. Actual composition needs target OS/layout testing; enhancement scope, not a reproduced regression. |
| [#317](https://github.com/Dyalog/ride/issues/317) Enable overstrikes | Traditional overstrike input feature requested. |
| [#276](https://github.com/Dyalog/ride/issues/276) WIBNI we had named "themes" of configuration settings | Requests whole-preference named configuration themes. |
| [#274](https://github.com/Dyalog/ride/issues/274) Make common actions available as a toolbar | Requests session toolbar/common action buttons. |
| [#267](https://github.com/Dyalog/ride/issues/267) Language bar: emphasise grouping a bit more | Requests clearer language-bar glyph grouping/wrapping. |
| [#253](https://github.com/Dyalog/ride/issues/253) Workspace Explorer shows ⓝ icon for instances | Upstream explicitly says instances are namespaces and icon choice not bug; current icon i is Interface. |
| [#250](https://github.com/Dyalog/ride/issues/250) Workspace Explorer shows expand symbol (+) on empty namespaces | Lazy namespace tree cannot know emptiness before request; upstream suggests protocol child-count/empty flag. |
| [#230](https://github.com/Dyalog/ride/issues/230) a better way of skipping lines in the tracer | Requested context skip-to-line is already present per upstream comments; protocol enhancement for direct skip remains. Incidental source bug STL reads HIGHLIGHT.line rather than lineStart; not conflated with original improvement. |
| [#229](https://github.com/Dyalog/ride/issues/229) display HTML inline in the session | Requests inline HTML instead of window; ShowHTML currently intentionally creates window. |
| [#212](https://github.com/Dyalog/ride/issues/212) New feature: File->Open to load a workspace | Workspace Open menu feature now exists per comments and src/km.js OWS; protocol redesign/remote handling enhancement remains. |
| [#204](https://github.com/Dyalog/ride/issues/204) RIDE should set ENABLE_CEF to 0 when using SSH | Requests ENABLE_CEF0 SSH launch environment; upstream discusses interpreter autodetect display. |
| [#192](https://github.com/Dyalog/ride/issues/192) Mac RIDE should have more standard menu items | Requests standard macOS Hide/Hide Others/Show All application menu items. |
| [#159](https://github.com/Dyalog/ride/issues/159) RFE: Smarter Editor Prompting | Smarter advisory dfn indentation feature requested. |
| [#157](https://github.com/Dyalog/ride/issues/157) Newbie-friendliness: integrate more ODE-Options into RIDE-Menu! | Requests beginner-oriented menus/toolbars/documentation. Separate old tracer performance report in comments was explicitly improved by db16248; not confirmation of current fault. |
| [#147](https://github.com/Dyalog/ride/issues/147) Feature request: associate .dws files in OSX with RIDE | Requests macOS .dws file association and interpreter/session selection behavior. |
| [#97](https://github.com/Dyalog/ride/issues/97) Workspace Explorer does not show :sections | Workspace explorer section display feature requested. |
| [#77](https://github.com/Dyalog/ride/issues/77) Add list of recently opened wss to File-Menu | Requests recent workspace list in File menu. |
| [#71](https://github.com/Dyalog/ride/issues/71) Autocomplete path-names when calling user-commands | User-command pathname completion enhancement; upstream maintainer says interpreter work Mantis15729 needed. |
| [#36](https://github.com/Dyalog/ride/issues/36) RIDE should check for updates automatically | Requests automatic update checks. |
| [#35](https://github.com/Dyalog/ride/issues/35) On Windows, the names of open editors should appear at the bottom of the Window menu | Requests dynamic open-editor Window menu list, including Windows; source prf.js:130 has static Close All Windows, macOS native Window role is separate platform facility. |

### Platform or scenario unverified

| Issue | Finding and evidence |
| --- | --- |
| [#1406](https://github.com/Dyalog/ride/issues/1406) Functions show differently on Windows and Linux | Cross-platform screenshots use function source containing embedded newlines. src/ed.js:409-412 now explicitly marks embedded CR/LF for variable editors, but issue concerns function display and may originate in interpreter formatted output. No equal-input Windows/Linux protocol capture or native comparison; cannot classify as frontend or fixed. |
| [#1395](https://github.com/Dyalog/ride/issues/1395) Reconnecting to running interpreter leaves session log input lines empty | Native typed 2+2 and GetLog preserve input text (six spaces + 2+2) and output4; matched direct protocol agrees. Original browser/ZFP disconnect-reconnect replay has not been exercised, so neither frontend nor interpreter ownership is established. |
| [#1362](https://github.com/Dyalog/ride/issues/1362) Updating Ride removes desktop shortcut on windows | Upstream comment assigns old MSI update shortcut removal to internal Windows installer. Tauride uses Tauri bundling; old installer path not applicable, but shortcut preservation through Tauride Windows upgrade has not been tested. |
| [#1354](https://github.com/Dyalog/ride/issues/1354) ZFP only: focus does not change to editor on Shift+Enter | Explicit zero-footprint browser-only focus report; desktop Tauri does not exercise its browser event/focus path. |
| [#1344](https://github.com/Dyalog/ride/issues/1344) An extra newline is inserted when copying and pasting text into Pages on Mac | Requires real macOS clipboard paste into Pages; Monaco copy payload and Pages interpretation not exercised by source-only review. |
| [#1324](https://github.com/Dyalog/ride/issues/1324) Connecting RIDE 4.6 to an already running 20.0 interpreter on Windows shows Right and Left tabs in the editor.    Same with zero footprint Ride on Windows | Windows interpreter emits special Left/Right editor windows; report specifically narrows interpreter platform. Need Windows interpreter protocol payload to decide ownership. |
| [#1320](https://github.com/Dyalog/ride/issues/1320) APL characters under Wayland on Ubuntu 25.04 does not work for me | Body says Ride accepts APL characters but terminal/native editors do not; maintainer identifies GNOME/Wayland layout configuration outside Ride. Target Linux keyboard setup untested; no Tauride frontend defect established. |
| [#1276](https://github.com/Dyalog/ride/issues/1276) Bump the used version of `nan` to support NodeJS 22 | package-lock still resolves nan2.17.0 at node_modules/nan; therefore cannot say source dependency request fixed. Tauride staging/build does not use Electron native rebuild, but clean Node22 npm installation/Electron build not run in this audit. |
| [#1255](https://github.com/Dyalog/ride/issues/1255) RIDE on Linux gets very slow once the session log is long | Linux session performance with large history requires timings in Linux WebKitGTK and real interpreter; frontend keeps underlying lines while applying visible sessionLogSize, so concern plausible but unquantified. |
| [#1219](https://github.com/Dyalog/ride/issues/1219) Limiting session log size can break on 19.0 | Version19-specific long group log truncation and persistent restart scenario not exercised; se.add visible truncation plus se.lines grouping needs actual19 output. |
| [#1207](https://github.com/Dyalog/ride/issues/1207) Windows installer uses an old logo | Old Windows installer logo path belongs to upstream packaging; Tauride bundle selects its own icons. Actual installed Windows wizard/logo not inspected. |
| [#1185](https://github.com/Dyalog/ride/issues/1185) Bug: RIDE Syntax Highlighting & backtick stops working. | Linux Compose-key sequence unspecified; macOS environment cannot verify Linux native key/composition state. No deterministic tokenizer failure established. |
| [#1007](https://github.com/Dyalog/ride/issues/1007) Pasting APL code into a function causes a problem on the PI | RaspberryPi32bit interpreter tracer paste display requires matching platform/source payload; no same setup available. |
| [#964](https://github.com/Dyalog/ride/issues/964) Linux: starting Ride (4.4) as a different user with sudo, Ride tries to open the login user's config file(s) | Tauride uses inherited XDG_CONFIG_HOME/HOME to choose settings. If sudo preserves login-user variables path can still point to wrong home. No different-user Linux environment reproduction; not fixed merely by replacing Electron. |
| [#962](https://github.com/Dyalog/ride/issues/962) RIDE steals focus | Startup calls D.wm.main().focus at helper setup; behavior depends on compositor/window manager and remote X11. No target Linux focus-stealing reproduction. |
| [#953](https://github.com/Dyalog/ride/issues/953) RIDE 4.5 has a dependency on libgconf-2-so.4(64bit).  This is not available on openSUSE | Reported legacy libgconf installer dependency is specific to Electron packages. Tauride uses Tauri bundler/WebKitGTK, but installability on stated openSUSE/Mint targets has not been tested; not a generic fixed claim. |
| [#949](https://github.com/Dyalog/ride/issues/949) RIDE tracer locks up with a Classic interpreter  | Classic interpreter character encoding and tracer behavior needs Classic interpreter. Interpreter label is suggestive but no protocol proof in available body/comments. |
| [#943](https://github.com/Dyalog/ride/issues/943) Linux: RIDE rpms include files which will end up in /usr/lib/.build_id/.. (unnoticed change in fpm) | Old Electron RPM fpm packaging path differs from Tauri RPM; inspect built Linux package to confirm no unwanted build-id entries. |
| [#942](https://github.com/Dyalog/ride/issues/942) Floating windows doesn't work with Windows Powertoys Fancy Zones | FancyZones handling depends on Windows native window styles/ownership. Floating editors retain parent session in src/ipc.js; no Windows host or snapping test. |
| [#927](https://github.com/Dyalog/ride/issues/927) You are asked to confirm whether you want to disconnect from a dead interpreter | Browser HTTP refresh disconnect prompt report belongs zero-footprint beforeunload network state; native shell cannot establish behavior. |
| [#885](https://github.com/Dyalog/ride/issues/885) Review RIDE_EDITOR feature | RIDE_EDITOR spawns executable with temp source file and handles exit/save. Windows notepad example cannot be validated on macOS; README reports Linux verification only. No minimal error payload/path supplied. |
| [#879](https://github.com/Dyalog/ride/issues/879) RIDE does not accept APL characters typed with alt key in Ubuntu 22.04 under Wayland | Exact Electron Ozone workaround does not apply to WebKitGTK Tauride, but Alt/APL layout delivery under Wayland remains target-platform input behavior requiring native Linux test. |
| [#849](https://github.com/Dyalog/ride/issues/849) RIDE is slow to startup | Old slow-start figures span low-spec Linux and cold/warm macOS starts. No comparable hardware/timing measurements; shell replacement alone is not performance reproduction or fix. |
| [#828](https://github.com/Dyalog/ride/issues/828) RIDE under Windows can't connect to interpreter in WSL2 using localhost | WSL2 localhost routing requires Windows+WSL networking. Upstream commenter recommends SERVE::4502. No Windows setup available. |
| [#809](https://github.com/Dyalog/ride/issues/809) On Mac Cmd-§ is accepted and displays as Cmd-` for the en_GB_Mac keyboard layout | Requires UK physical macOS keyboard producing § while shortcut capture normalizes scan codes; no such layout/native test. Cannot establish same display mismatch with VM keyboard events. |
| [#730](https://github.com/Dyalog/ride/issues/730) Running ride as different (non-root) user with sudo on Debian 10 and Mint 20.1 causes an abort | No protocol specified/futex abort when sudo changes user can involve display authentication and runtime. GTK shell replacement does not prove different-user launch works; no Debian/Mint test. |
| [#669](https://github.com/Dyalog/ride/issues/669) RIDE on Windows does not show in the All Apps List after being installed | Windows Start All Apps shortcut registration is installer-specific. Tauride uses Tauri bundler and different product name; installed Windows Start menu not inspected. |
| [#584](https://github.com/Dyalog/ride/issues/584) WIBNI RIDE supported SVG javascript animations | Native original SVG loads its first visible page and runs onload JavaScript. A simpler setInterval SVG alternates fill correctly. Original animation stayed on page1 during locked-screen sampling; it uses requestAnimationFrame, so original motion remains unverified. No current blank-window reproduction or interpreter fault established. |
