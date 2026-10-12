# Dyalog Ride design request triage

The 222 open upstream issues divide into **95 design requests, 6 mixed bug/design issues, 88 bug reports, 17 maintenance tasks, 14 documentation tasks and 2 unclear reports**. The design requests describe useful work, but they are not 95 missing Tauride features: five have their core behavior already present, and one mixed issue is also addressed. Verify those before creating new work.

Start with state visibility, diagnostic text interactions, APL input guidance, toolbar discoverability and thread context. Plan settings, menus and source-file workflows as coherent groups. Keep interpreter-dependent debugging and history behavior separate from frontend-only improvements.

Scope: all issues open in `Dyalog/ride` on 10 October 2026, using issue bodies and comments. Closed issues are excluded. All issue numbers below refer to **Dyalog/ride**, not Tauride. Fork applicability uses Tauride main [`15f1452a`](https://github.com/xpqz/tauride/commit/15f1452a1943d8e2085142d6530d9dcc1c2dcbe0). No upstream issues, labels or comments were changed. The ordering and proposed choices below are planning recommendations, not accepted requirements or effort estimates.

## Classification

| Class | Count | Treatment |
| --- | ---: | --- |
| Design request | 95 | Specify the desired behavior, consolidate related requests, then implement. |
| Mixed bug and design | 6 | Separate the failing contract from the optional new behavior. |
| Bug report | 88 | Keep in the defect process; its label or an attractive proposed fix does not make it design work. |
| Maintenance | 17 | Keep build, release and contributor work in a separate backlog. |
| Documentation | 14 | Correct or publish documentation without inventing a product feature. |
| Unclear | 2 | Clarify the missing contract or reproduction before assigning work. |

A bug classification describes the report, not a fresh reproduction: several have already been fixed in Tauride. An `enhancement` label is not sufficient evidence of a feature request. Missing capabilities, deliberate defaults and competing valid interaction choices count as design; incorrect results, ignored existing settings and failures of supported actions count as bugs.

The [complete sortable inventory](upstream-design-triage-2026-10-10.json) contains every issue exactly once, with its rationale, proposed next step, dependency, confidence, source evidence and original labels. The detailed tables below cover all 95 design requests and 6 mixed issues.

## Suggested first specifications

These are bounded improvements with useful acceptance criteria and mostly existing frontend data. They still need a short behavior specification; the list is not an instruction to start coding.

| Order | Issues | Proposed scope | Decision to settle |
| ---: | --- | --- | --- |
| 1 | [#1339](https://github.com/Dyalog/ride/issues/1339) | Name each interpreter input/busy state in the status bar. | Makes an existing state signal understandable; specify concise wording and accessible text. |
| 2 | [#1295](https://github.com/Dyalog/ride/issues/1295), [#1296](https://github.com/Dyalog/ride/issues/1296), [#1297](https://github.com/Dyalog/ride/issues/1297) | Give Log and About consistent selection, Copy and Find actions. | Treat as one reusable text-view behavior; preserve the existing Copy All path. |
| 3 | [#1360](https://github.com/Dyalog/ride/issues/1360), [#848](https://github.com/Dyalog/ride/issues/848) | Add dismissible first-use APL input help and a direct route to full symbol documentation. | Improves entry and discovery without changing keyboard semantics; verify existing help before adding UI. |
| 4 | [#957](https://github.com/Dyalog/ride/issues/957), [#1227](https://github.com/Dyalog/ride/issues/1227) | Keep toolbar visibility configurable and expose its current state under View. | The discussion supplies valid uses for hiding it; removing the preference would sacrifice that workflow. |
| 5 | [#1386](https://github.com/Dyalog/ride/issues/1386) | Add a thread-ID title placeholder using interpreter status already received. | A bounded extension; define behavior before connection and when no thread ID is available. |

## Work that should be designed together

| Family | Design or mixed issues | Shared decision |
| --- | ---: | --- |
| Help and diagnostics | 5 | Use consistent, searchable and selectable diagnostic text; make symbol-entry help discoverable without recurring interruption. |
| Commands and menus | 17 | Choose a shared command model, context-sensitive availability and platform conventions before rearranging menus or toolbars. |
| Keyboard input and editing | 18 | Define precedence among glyph entry, completion, indentation and shortcuts; specify overwrite and PF-key semantics independently. |
| Settings themes and colours | 10 | Separate portable preferences from machine-specific state and define versioned import/migration before changing storage or colour formats. |
| Session state and text | 13 | Distinguish visible session text from interpreter-owned history and print width; define where authoritative namespace, thread and prompt state comes from. |
| Workspace and source files | 11 | Define workspace loading versus source-file opening, saving and association, including which machine owns files in remote sessions. |
| Debugging | 7 | Separate stack inspection, movement of the next line and execution; verify interpreter capabilities before adding controls. |
| Windows and sessions | 13 | Set docked/floating behavior, window discovery, sizing and session lifecycle together; do not inherit Electron workarounds automatically. |
| Rich output | 6 | Define output rendering, window reuse, update identity and printing scope before expanding HTML/SVG or demo behavior. |
| Distribution and platform support | 1 | Choose supported targets and update notification policy; separate shell support from interpreter display requirements. |

For portable settings, settle the data model and migration/import rules before moving files or adding theme formats. For menus, distinguish exposing an existing command from promising a new file or debugger operation. For source files, define local versus interpreter-host ownership, what Save means, and how association survives editing. These choices prevent related issues from introducing conflicting behavior.

## Consolidation candidates

These are relationships to carry into a Tauride backlog, not proposals to edit or close upstream issues. Related scope does not mean every issue is a duplicate.

| Issues | Relationship | Proposed consolidation |
| --- | --- | --- |
| [#988](https://github.com/Dyalog/ride/issues/988), [#1213](https://github.com/Dyalog/ride/issues/1213) | Same feature | One tracing-options design for skipping blank, comment and local-declaration lines. |
| [#512](https://github.com/Dyalog/ride/issues/512), [#950](https://github.com/Dyalog/ride/issues/950) | Same capability | One overwrite-mode design; keep overstrikes (#317) a separate decision. |
| [#799](https://github.com/Dyalog/ride/issues/799), [#933](https://github.com/Dyalog/ride/issues/933) | Same capability | One source-file Save/Save As workflow, designed with opening/association (#935). |
| [#748](https://github.com/Dyalog/ride/issues/748), [#922](https://github.com/Dyalog/ride/issues/922), [#825](https://github.com/Dyalog/ride/issues/825) | Overlapping scope | Unify retained-session colouring; distinguish syntax colouring from input/output role colouring. |
| [#583](https://github.com/Dyalog/ride/issues/583), [#982](https://github.com/Dyalog/ride/issues/982) | Same workflow | One stack-navigation design covering source access, frame selection and interpreter capability. |
| [#545](https://github.com/Dyalog/ride/issues/545), [#596](https://github.com/Dyalog/ride/issues/596) | Same workflow | One selection-to-search command with URL encoding and discoverable shortcut/menu access. |
| [#447](https://github.com/Dyalog/ride/issues/447), [#1396](https://github.com/Dyalog/ride/issues/1396), [#1386](https://github.com/Dyalog/ride/issues/1386) | Related scope | One context-display vocabulary for namespace/thread/caption; namespace switching is an additional feature. |
| [#960](https://github.com/Dyalog/ride/issues/960), [#276](https://github.com/Dyalog/ride/issues/276), [#1238](https://github.com/Dyalog/ride/issues/1238), [#1270](https://github.com/Dyalog/ride/issues/1270), [#1302](https://github.com/Dyalog/ride/issues/1302) | Shared design prerequisite | Portable preferences, schema/migration, theme files and storage locations need a coherent compatibility plan. |
| [#957](https://github.com/Dyalog/ride/issues/957), [#1227](https://github.com/Dyalog/ride/issues/1227) | Competing proposals | Resolve visibility/discoverability together; do not implement both removal and a new toggle independently. |
| [#967](https://github.com/Dyalog/ride/issues/967), [#986](https://github.com/Dyalog/ride/issues/986), [#35](https://github.com/Dyalog/ride/issues/35), [#1020](https://github.com/Dyalog/ride/issues/1020) | Related window architecture | Consolidate window discovery/grouping; reassess the proposed macOS floating-window removal against Tauri's existing process model. |
| [#1295](https://github.com/Dyalog/ride/issues/1295), [#1296](https://github.com/Dyalog/ride/issues/1296), [#1297](https://github.com/Dyalog/ride/issues/1297) | Reusable behavior | One common diagnostic-text interaction, with separate acceptance checks for Log and About. |

## Boundary cases and existing work

| Issues | Classification and consequence |
| --- | --- |
| [#253](https://github.com/Dyalog/ride/issues/253) | Design: instances are namespaces, and the existing i icon means Interface. Choose an icon taxonomy; do not assume replacing n with i is a correctness fix. |
| [#1275](https://github.com/Dyalog/ride/issues/1275) | Design: the discussion settles on adding whole-:Select folding while keeping :Case folding, not requiring blanket Windows IDE parity. |
| [#1302](https://github.com/Dyalog/ride/issues/1302) | Design: prefs.json is valid outer JSON. The request is a typed, readable nested schema instead of JSON embedded in strings; it needs compatibility and migration. |
| [#1389](https://github.com/Dyalog/ride/issues/1389) | Design: removing an intentional minimum window size needs a usable small-window layout policy. |
| [#431](https://github.com/Dyalog/ride/issues/431), [#604](https://github.com/Dyalog/ride/issues/604), [#849](https://github.com/Dyalog/ride/issues/849), [#927](https://github.com/Dyalog/ride/issues/927) | Bug reports despite enhancement labels: broken Tab behavior, idiom recognition, slow startup, and stale dead-interpreter confirmation. |
| [#1387](https://github.com/Dyalog/ride/issues/1387), [#1393](https://github.com/Dyalog/ride/issues/1393) | Bug reports despite feature-like wording: SSH executable persistence already exists according to the maintainer; indentation asks an existing width preference to be honored. |
| [#217](https://github.com/Dyalog/ride/issues/217) | The Reformat menu exists; the later report is a failure in floating-editor dispatch. Keep that in defect triage. |
| [#597](https://github.com/Dyalog/ride/issues/597) | Documentation: the maintainer chose to correct claims about unsupported commands. New command coverage belongs with #556/#941, not an automatic expansion of the documented contract. |
| [#192](https://github.com/Dyalog/ride/issues/192), [#212](https://github.com/Dyalog/ride/issues/212), [#230](https://github.com/Dyalog/ride/issues/230), [#969](https://github.com/Dyalog/ride/issues/969), [#1380](https://github.com/Dyalog/ride/issues/1380) | Core behavior already appears in Tauride source: standard Mac menu actions, local Open Workspace, Skip to line, New Session naming, and a zoom shortcut alias. Check the specific remaining scope instead of reimplementing the title. |
| [#932](https://github.com/Dyalog/ride/issues/932) | Partly present: docked editor tabs already expose ed.filename as their tooltip when filenameInTitle is enabled (the default). Verify that behavior; a persistently visible path would be a narrower additional request. |
| [#967](https://github.com/Dyalog/ride/issues/967), [#986](https://github.com/Dyalog/ride/issues/986), [#1020](https://github.com/Dyalog/ride/issues/1020) | Tauride already groups sessions in one process and registers the native macOS Window menu. Validate remaining platform/window-list behavior; removing floating windows is not an established prerequisite. |
| [#745](https://github.com/Dyalog/ride/issues/745) | The mixed Align Comments report is addressed in Tauride: code-preserving alignment and the explicit-selection rule are tested. Do not reopen a design task for the completed policy. |
| [#1232](https://github.com/Dyalog/ride/issues/1232), [#1103](https://github.com/Dyalog/ride/issues/1103) | Unclear: #1232 supplies no startup scenario; #1103 may be container configuration/quoting. Establish the contract or reproduce before classifying as new design. |

Current source anchors: [title placeholders and prompt handling](https://github.com/xpqz/tauride/blob/15f1452a1943d8e2085142d6530d9dcc1c2dcbe0/src/ide.js), [default menus and preference serialization](https://github.com/xpqz/tauride/blob/15f1452a1943d8e2085142d6530d9dcc1c2dcbe0/src/prf.js), [native Window menu](https://github.com/xpqz/tauride/blob/15f1452a1943d8e2085142d6530d9dcc1c2dcbe0/src-tauri/src/menu.rs), [session/window ownership](https://github.com/xpqz/tauride/blob/15f1452a1943d8e2085142d6530d9dcc1c2dcbe0/src-tauri/src/win.rs), and [completed comment-alignment validation](https://github.com/xpqz/tauride/blob/15f1452a1943d8e2085142d6530d9dcc1c2dcbe0/docs/prs/39.md). Source presence is not a new physical-input or cross-platform runtime test.

## Mixed issues to separate

| Issue | Bug versus design | Proposed decision | Next step |
| --- | --- | --- | --- |
| [#529](https://github.com/Dyalog/ride/issues/529) | Existing 2036⌶ behavior is ignored; discussion adds a separable client preference and disputes whether it overrides interpreter state. | Keep client Auto Status control and decide how explicit interpreter suppression interacts with it. | Split bug from design |
| [#530](https://github.com/Dyalog/ride/issues/530) | The requested picker guidance is a design change; comments separately report repeated false file-not-found prompts after opening a shortcut. | Offer meaningful type filters with an all-files escape hatch and explicit file-versus-workspace behavior. | Split bug from design |
| [#745](https://github.com/Dyalog/ride/issues/745) | Comments provide repeated-AC code mangling; the original request separately changes which comment-only lines alignment should touch. | Align trailing comments by default and include standalone comments only through an explicit selection rule. | Verify existing behavior |
| [#989](https://github.com/Dyalog/ride/issues/989) | Concrete label/help-text contradictions coexist with a separable proposal to merge the two fields. | Keep arguments and environment variables distinct, clarify quoting and whitespace rules, and fix misleading help. | Split bug from design |
| [#1253](https://github.com/Dyalog/ride/issues/1253) | The original ask is a new entry method; comments separately report broken or misleading existing prefix mappings on Finnish layouts. | Decide whether mnemonic Tab is an optional input method and how it interacts with indentation/completion; track the Finnish mapping defect separately. | Split bug from design |
| [#1255](https://github.com/Dyalog/ride/issues/1255) | Original is a performance defect; a comment introduces a separate discoverability/control request, while further discussion distinguishes visible session limits from interpreter file limits. | Separate performance investigation from a possible log-management UI; define which log is controlled and whether runtime truncation is actually supported. | Split bug from design |

## Complete design inventory

Within each family, entries are sorted by proposed next step, then issue number. **Specify next** is the shortlist above; **Design together** means a local behavior or shared design decision; **Coordinate interpreter support** means verify the supported protocol/interpreter behavior first, not that an extension is certainly required; **Verify existing behavior** avoids duplicating existing or partly implemented work; **Defer pending scope** needs a clearer use case or larger product commitment. Dependencies identify the affected layer, not an estimate of difficulty. Mixed reports are listed separately above.

### Help and diagnostics

| Issue and ask | Next step | Decision or acceptance boundary | Dependency |
| --- | --- | --- | --- |
| [#848](https://github.com/Dyalog/ride/issues/848) Add a full-documentation link to language-bar tips. | Specify next | Open version-appropriate symbol documentation from a keyboard-accessible More link. | Frontend |
| [#1295](https://github.com/Dyalog/ride/issues/1295) Provide mouse-accessible copy actions in the protocol log window. | Specify next | Provide Copy for selected text through context menu and Edit menu, with explicit focus routing shared with About. | Multiple layers |
| [#1296](https://github.com/Dyalog/ride/issues/1296) Add text search to the protocol log window. | Specify next | Choose one search UI with next/previous navigation and menu/shortcut entry points, reusable by About if useful. | Frontend |
| [#1297](https://github.com/Dyalog/ride/issues/1297) Allow selecting and copying just part of the About text through standard keyboard and context-menu actions. | Specify next | Make selection copy consistent with the log window and preserve Copy All as an explicit action; decide whether About also needs search. | Multiple layers |
| [#1360](https://github.com/Dyalog/ride/issues/1360) Offer first-use guidance for entering APL symbols with a persistent dismissal option. | Specify next | Choose the first-run trigger, brief layout-aware example, persistent dismissal, and a Help entry to reopen the guide. | Frontend |

### Commands and menus

| Issue and ask | Next step | Decision or acceptance boundary | Dependency |
| --- | --- | --- | --- |
| [#957](https://github.com/Dyalog/ride/issues/957) Provide an accessible command and shortcut for toggling the editor toolbar. | Specify next | Retain the space-saving option and expose a checked View command with optional shortcut. | Frontend |
| [#1227](https://github.com/Dyalog/ride/issues/1227) Reconsider the toolbar-visibility preference because hidden controls confuse users. | Specify next | Keep the preference and add a visible checked View > Show Trace/Edit Toolbar command. | Frontend |
| [#157](https://github.com/Dyalog/ride/issues/157) Expose ordinary workspace actions through discoverable menus and possibly a toolbar. | Design together | Define a small command set and whether menu actions prepare commands or immediately execute them. | Multiple layers |
| [#267](https://github.com/Dyalog/ride/issues/267) Make symbol groups visually distinct and prevent breaks within groups. | Design together | Preserve meaningful nonbreaking groups; decide labels and user-reordering policy separately. | Frontend |
| [#274](https://github.com/Dyalog/ride/issues/274) Offer a toolbar for common editing and workspace actions. | Design together | Choose a small configurable toolbar and its relationship to the language bar and menus. | Frontend |
| [#446](https://github.com/Dyalog/ride/issues/446) Expose comment and uncomment actions in the context menu with shortcuts. | Design together | Place both actions in the editor context menu and derive displayed shortcuts from user mappings. | Frontend |
| [#545](https://github.com/Dyalog/ride/issues/545) Search a configured website for the selected token using a shortcut. | Design together | Use URL-encoded selection templates with a defined fallback for an empty selection. | Frontend |
| [#594](https://github.com/Dyalog/ride/issues/594) Allow one-click actions directly on the menu bar. | Design together | Prefer a coherent toolbar command surface or explicitly support top-level actions across native menu conventions. | Native shell |
| [#596](https://github.com/Dyalog/ride/issues/596) Expand {selection} in configurable menu URLs. | Design together | Specify URL encoding, selected-text extraction and fallback to token under cursor. | Frontend |
| [#945](https://github.com/Dyalog/ride/issues/945) Choose consistent application-menu branding and Settings/Preferences wording. | Design together | Use client-platform conventions for Settings/Preferences and agree the application-menu name. | Native shell |
| [#976](https://github.com/Dyalog/ride/issues/976) Adopt clearer tracer toolbar icons aligned with the Windows IDE. | Design together | Agree a shared icon vocabulary, especially the ambiguous exit/up-stack control. | Frontend |
| [#1021](https://github.com/Dyalog/ride/issues/1021) Make context menus reflect the clicked object or interface region. | Design together | Start with relevant Edit/Help/Reset/Hide actions and suppress invalid actions; decide object-value operations separately. | Frontend |
| [#1071](https://github.com/Dyalog/ride/issues/1071) Reorganize menus and expose a broad set of file, workspace, window, and execution actions. | Design together | Split menu taxonomy and existing-action discoverability from separately scoped new file/session/debug features. | Multiple layers |
| [#192](https://github.com/Dyalog/ride/issues/192) Provide standard macOS Hide, Hide Others and Show All items. | Verify existing behavior | Retain native platform roles for these standard actions. | Native shell |
| [#969](https://github.com/Dyalog/ride/issues/969) Rename the connection screen to New Session. | Verify existing behavior | Use New Session consistently in the screen title and entry command. | Frontend |
| [#1397](https://github.com/Dyalog/ride/issues/1397) Rename the Title preference to Caption to match the Windows IDE. | Defer pending scope | Decide product terminology for visible labels and documentation; preserve the stored title key or provide compatibility if renamed. | Frontend |

### Keyboard input and editing

| Issue and ask | Next step | Decision or acceptance boundary | Dependency |
| --- | --- | --- | --- |
| [#159](https://github.com/Dyalog/ride/issues/159) Offer semantic dfn indentation and optional closing-brace prompting. | Design together | Decide opt-in indentation rules separately from inserting braces or moving the cursor. | Frontend |
| [#329](https://github.com/Dyalog/ride/issues/329) Make dead keys reliable prefix keys for APL entry. | Design together | Specify composition-event handling and consistent suggestion behavior for dead-key prefixes. | Multiple layers |
| [#512](https://github.com/Dyalog/ride/issues/512) Toggle insert and overwrite modes with Insert. | Design together | Define overwrite indicators, selection behavior and accessibility before binding Insert. | Frontend |
| [#556](https://github.com/Dyalog/ride/issues/556) Expose additional editor actions to shortcut and PF-key customization. | Design together | Expose a documented stable command set first; treat full modal editing as separate scope. | Frontend |
| [#941](https://github.com/Dyalog/ride/issues/941) Support more selection and editing commands inside PF-key definitions. | Design together | Choose the supported Monaco editing-command subset and document macro semantics. | Frontend |
| [#950](https://github.com/Dyalog/ride/issues/950) Add an Insert-key overwrite mode, optionally including overstrikes. | Design together | Define overwrite scope, mode indication and selection behavior; keep overstrike composition as the separate deferred proposal #317. | Frontend |
| [#974](https://github.com/Dyalog/ride/issues/974) Add French and Spanish macOS keyboard layouts. | Design together | Add fr_FR_Mac and es_ES_Mac mappings consistent with their native layouts. | Frontend |
| [#975](https://github.com/Dyalog/ride/issues/975) Offer ASCII compositions as an additional way to enter APL symbols. | Design together | Choose the composition trigger and mapping set, then expose a discoverable reference. | Frontend |
| [#1018](https://github.com/Dyalog/ride/issues/1018) Allow session-only Up/Down bindings without changing editor navigation. | Design together | Expose session-scoped bindings while preserving editor/tracer cursor keys. | Frontend |
| [#1181](https://github.com/Dyalog/ride/issues/1181) Allow users to disable middle-click paste on Linux. | Design together | Choose whether to honor system primary-selection settings or expose a per-app paste toggle. | Multiple layers |
| [#1254](https://github.com/Dyalog/ride/issues/1254) Investigate mapping physical keyboard keys instead of the characters they produce. | Design together | Choose which interactions need physical key identity and which should honor typed characters; validate across layouts before changing the input model. | Multiple layers |
| [#1275](https://github.com/Dyalog/ride/issues/1275) Allow folding an entire :Select block in addition to its :Case branches. | Design together | Support outer :Select folding while retaining branch folding, and define consistent nested-range boundaries. | Frontend |
| [#71](https://github.com/Dyalog/ride/issues/71) Complete file paths in user commands such as ]load. | Coordinate interpreter support | Identify file-taking command arguments and retain local/remote interpreter path semantics. | Interpreter/protocol |
| [#1230](https://github.com/Dyalog/ride/issues/1230) Allow Ride PF-key bindings to invoke the interpreter-side ⎕PFKEYS definitions. | Coordinate interpreter support | Choose an explicit interpreter-PF action versus the proposed self-reference convention; define execution while busy and fallback support. | Interpreter/protocol |
| [#1380](https://github.com/Dyalog/ride/issues/1380) Add Ctrl++ as an alias for increasing the font size. | Verify existing behavior | Keep both aliases and validate their physical-key behavior on relevant layouts. | Frontend |
| [#317](https://github.com/Dyalog/ride/issues/317) Support traditional APL overstrikes in overwrite mode. | Defer pending scope | Make overstrike composition optional and define its relationship to overwrite mode. | Frontend |

### Settings themes and colours

| Issue and ask | Next step | Decision or acceptance boundary | Dependency |
| --- | --- | --- | --- |
| [#276](https://github.com/Dyalog/ride/issues/276) Support reusable named configurations and portable theme settings. | Design together | Separate full environment profiles from colour-scheme import/export and define which machine-specific fields transfer. | Multiple layers |
| [#410](https://github.com/Dyalog/ride/issues/410) Use a calmer, readable colour palette for workspace object icons. | Design together | Select contrast-tested theme-aware colours while retaining text as a redundant type cue. | Frontend |
| [#619](https://github.com/Dyalog/ride/issues/619) Detect and syntax-highlight JSON, JSON5 and XML with a manual override. | Design together | Define detection thresholds and per-buffer overrides without changing APL editing defaults. | Frontend |
| [#938](https://github.com/Dyalog/ride/issues/938) Allow background colours on every syntax token type. | Design together | Choose token-background controls and error/selection precedence. | Frontend |
| [#960](https://github.com/Dyalog/ride/issues/960) Export and import settings for sharing, versioning, and migration. | Design together | Define portable settings categories, schema versions, conflict handling, and treatment of machine-specific connection data. | Multiple layers |
| [#979](https://github.com/Dyalog/ride/issues/979) Preview every configurable token and editor/session/status state in theme settings. | Design together | Choose preview tabs or state selectors covering session, tracer, values, and status. | Frontend |
| [#1238](https://github.com/Dyalog/ride/issues/1238) Store each colour scheme in a separate structured JSON file with expanded CSS colour support. | Design together | Agree a versioned scheme schema and import/export/migration rules alongside the general preference format and storage layout. | Multiple layers |
| [#1270](https://github.com/Dyalog/ride/issues/1270) Separate portable configuration from machine-specific runtime data using new platform storage paths. | Design together | Choose Tauride-specific versus shared Ride storage and a portable/machine-state split, with explicit migration before moving existing files. | Native shell |
| [#1302](https://github.com/Dyalog/ride/issues/1302) Store nested preferences as structured JSON rather than JSON encoded inside strings. | Design together | Adopt a versioned typed schema with backward-compatible reading and a migration strategy coordinated with colour-scheme files. | Multiple layers |
| [#1341](https://github.com/Dyalog/ride/issues/1341) Avoid misclassifying hybrid primitives and offer a dedicated hybrid syntax-colour category. | Design together | Decide whether all hybrids receive a stable hybrid class or are context-classified when safe, with defaults and migration for existing themes. | Frontend |

### Session state and text

| Issue and ask | Next step | Decision or acceptance boundary | Dependency |
| --- | --- | --- | --- |
| [#1339](https://github.com/Dyalog/ride/issues/1339) Display explanatory status text for busy, ready, text input, evaluated input, and multiline input states. | Specify next | Choose unambiguous labels for ⍞ versus ⎕ input, icon/text behavior, and visibility when the status bar is hidden. | Frontend |
| [#1386](https://github.com/Dyalog/ride/issues/1386) Allow the current APL thread ID in the configurable window caption. | Specify next | Define TID update events, which thread is current, and the disconnected/unknown value, then expose it with other caption substitutions. | Frontend |
| [#748](https://github.com/Dyalog/ride/issues/748) Optionally keep syntax highlighting on prior REPL input. | Design together | Preserve input/output provenance and allow syntax-coloured prior input without treating arbitrary output as APL. | Frontend |
| [#824](https://github.com/Dyalog/ride/issues/824) Clear the visible client session history on demand. | Design together | Separate Clear visible history from permanent interpreter-log deletion and make reconnect behavior explicit. | Frontend |
| [#825](https://github.com/Dyalog/ride/issues/825) Differentiate input, output and errors visually in the session. | Design together | Use existing input/output type metadata for theme-configurable role styles; scope richer semantic classification separately and preserve a non-colour distinction. | Frontend |
| [#922](https://github.com/Dyalog/ride/issues/922) Retain syntax colouring for prior session lines on Linux. | Design together | Consolidate with the cross-platform retained-input highlighting decision. | Frontend |
| [#378](https://github.com/Dyalog/ride/issues/378) Let APL query the session dimensions in characters and pixels. | Coordinate interpreter support | Agree window identifiers, pixel/character units and response behavior after resize. | Interpreter/protocol |
| [#447](https://github.com/Dyalog/ride/issues/447) Show the active namespace and optionally allow switching it. | Coordinate interpreter support | Ship an always-correct namespace indicator first; separately define namespace-picker scope and switching semantics. | Interpreter/protocol |
| [#816](https://github.com/Dyalog/ride/issues/816) Provide a GUI option to disable loading or using the interpreter session log. | Coordinate interpreter support | Make connection/startup ownership clear and distinguish disabling persistence from hiding or clearing client history. | Interpreter/protocol |
| [#1365](https://github.com/Dyalog/ride/issues/1365) Wrap system-command output to the visible Ride session width. | Coordinate interpreter support | Choose whether visual wrapping or changing interpreter print width governs system output, and define resize/history behavior without corrupting copied output. | Interpreter/protocol |
| [#1396](https://github.com/Dyalog/ride/issues/1396) Support long and short current-namespace placeholders in the window caption. | Coordinate interpreter support | Define NSID/SNSID formatting, update events and fallback behavior together with TID. | Interpreter/protocol |

### Workspace and source files

| Issue and ask | Next step | Decision or acceptance boundary | Dependency |
| --- | --- | --- | --- |
| [#77](https://github.com/Dyalog/ride/issues/77) Expose recently opened workspaces in the File menu and completion. | Design together | Define history scope per connection and whether selecting an item inserts or executes a load command. | Multiple layers |
| [#147](https://github.com/Dyalog/ride/issues/147) Open .dws files from Finder in RIDE. | Design together | Select default interpreter and new-session versus current-session behavior, including latent-expression consent. | Native shell |
| [#253](https://github.com/Dyalog/ride/issues/253) Visually distinguish class instances from ordinary namespaces. | Design together | Choose distinct accessible instance symbols without overloading Interface or relying on subtle letter case. | Frontend |
| [#483](https://github.com/Dyalog/ride/issues/483) Provide an APL-aware editor mode without starting an interpreter. | Design together | Define supported files, syntax services available offline and how users transition into a live session. | Multiple layers |
| [#799](https://github.com/Dyalog/ride/issues/799) Save an edited APL item to a text file through Save or Save As. | Design together | Distinguish fixing an object in the workspace from saving source, including local/remote destination and file format. | Multiple layers |
| [#933](https://github.com/Dyalog/ride/issues/933) Save an edited APL object as a text source file. | Design together | Define Save As formats and whether saving establishes or changes source association. | Multiple layers |
| [#935](https://github.com/Dyalog/ride/issues/935) Open a source file and retain its association with the APL objects it defines. | Design together | Define ownership, save-back behavior, and association with multi-object files. | Multiple layers |
| [#97](https://github.com/Dyalog/ride/issues/97) Show :Section structure in Workspace Explorer. | Coordinate interpreter support | Decide whether sections belong in the object tree or only the editor outline. | Interpreter/protocol |
| [#983](https://github.com/Dyalog/ride/issues/983) Search for workspace objects and open selected results for editing. | Coordinate interpreter support | Define search filters, result metadata, cancellation, and interpreter capability negotiation. | Interpreter/protocol |
| [#212](https://github.com/Dyalog/ride/issues/212) Load a workspace through File → Open. | Verify existing behavior | Keep existing local Open; scope any remote file picker and command-preview behavior as explicit follow-on decisions. | Multiple layers |
| [#932](https://github.com/Dyalog/ride/issues/932) Show the source-file path for docked editor windows. | Verify existing behavior | Check the existing docked-tab source-path tooltip; if persistent visibility is needed, specify its location and local/remote path semantics. | Frontend |

### Debugging

| Issue and ask | Next step | Decision or acceptance boundary | Dependency |
| --- | --- | --- | --- |
| [#1030](https://github.com/Dyalog/ride/issues/1030) Separate Threads and Stack into independent panels and simplify the Stack label. | Design together | Allow independently visible/dockable Threads and Stack panels. | Frontend |
| [#450](https://github.com/Dyalog/ride/issues/450) Choose consistent end-of-function behavior for tracer BK/FD navigation. | Coordinate interpreter support | Prefer stopping at both boundaries, subject to interpreter agreement and nested-dfn scope rules. | Interpreter/protocol |
| [#583](https://github.com/Dyalog/ride/issues/583) Navigate the tracer to a stack frame by clicking its SI Stack entry. | Coordinate interpreter support | Define frame selection, current execution marker and single-window reuse without resuming execution. | Interpreter/protocol |
| [#982](https://github.com/Dyalog/ride/issues/982) Make stack-frame selection show and navigate non-top function source. | Coordinate interpreter support | Agree interpreter capability support and frame identity before adding source and navigation controls. | Interpreter/protocol |
| [#988](https://github.com/Dyalog/ride/issues/988) Optionally skip blank, comment, and local-declaration lines during tracing. | Coordinate interpreter support | Choose independent skip categories and define interpreter-aware stepping behavior. | Interpreter/protocol |
| [#1213](https://github.com/Dyalog/ride/issues/1213) Add preferences to skip blank, comment, and local-declaration lines in tracing. | Coordinate interpreter support | Consolidate with #988 and choose independent skip categories with interpreter support. | Interpreter/protocol |
| [#230](https://github.com/Dyalog/ride/issues/230) Allow skipping directly to a selected tracer line without executing code. | Verify existing behavior | Keep Skip to line, and resolve target validity and boundary behavior before replacing repeated BK/FD messages. | Interpreter/protocol |

### Windows and sessions

| Issue and ask | Next step | Decision or acceptance boundary | Dependency |
| --- | --- | --- | --- |
| [#35](https://github.com/Dyalog/ride/issues/35) List open editors in the Window menu for quick switching. | Design together | Use one open-window list with active-window indication and reliable activation. | Native shell |
| [#716](https://github.com/Dyalog/ride/issues/716) Allow the session to appear above floating edit and trace windows. | Design together | Define parent/child and always-on-top rules per platform, with a clear user preference. | Native shell |
| [#973](https://github.com/Dyalog/ride/issues/973) Size newly opened editor windows according to their text height. | Design together | Choose content-fit limits and precedence over remembered/user-set geometry. | Native shell |
| [#980](https://github.com/Dyalog/ride/issues/980) Allow the status window to behave normally and optionally dock. | Design together | Choose a pin toggle and whether status belongs in the dockable panel model. | Multiple layers |
| [#1070](https://github.com/Dyalog/ride/issues/1070) Provide a macOS ride shell command using the default interpreter setup. | Design together | Choose CLI installation/discovery and argument forwarding to the saved default configuration. | Native shell |
| [#1194](https://github.com/Dyalog/ride/issues/1194) Offer restart and return-to-connect actions plus an interpreter-exit behavior choice. | Design together | Define restart versus disconnect semantics for spawned/remote interpreters and an explicit on-exit setting. | Multiple layers |
| [#1216](https://github.com/Dyalog/ride/issues/1216) Place a cloned configuration below its source. | Design together | Choose adjacent-below insertion or stable sorting and preserve a clear selection after cloning. | Frontend |
| [#1220](https://github.com/Dyalog/ride/issues/1220) Launch a saved configuration by name from a command-line argument. | Design together | Define a named-profile CLI flag, missing-name errors, and precedence over other startup options. | Native shell |
| [#1389](https://github.com/Dyalog/ride/issues/1389) Remove or relax minimum session window dimensions. | Design together | Choose responsive behavior and minimum usable content size, including connection/preferences dialogs, before removing hard limits. | Multiple layers |
| [#967](https://github.com/Dyalog/ride/issues/967) List and switch between all RIDE sessions in the macOS Window menu. | Verify existing behavior | Use the native application Window menu and shared session process, retaining floating editors. | Native shell |
| [#986](https://github.com/Dyalog/ride/issues/986) Group RIDE session windows under a shared application identity. | Verify existing behavior | Reuse native session grouping and separately check Windows taskbar and macOS Dock behavior. | Native shell |
| [#1020](https://github.com/Dyalog/ride/issues/1020) Remove macOS floating windows as a proposed way to enable session grouping. | Defer pending scope | Retain floating windows unless current native grouping proves incompatible; reassess the Electron-era premise. | Native shell |

### Rich output

| Issue and ask | Next step | Decision or acceptance boundary | Dependency |
| --- | --- | --- | --- |
| [#229](https://github.com/Dyalog/ride/issues/229) Render HTML results inline in the session. | Design together | Define inline output sizing, lifetime, trust boundary and transcript/export behavior. | Multiple layers |
| [#440](https://github.com/Dyalog/ride/issues/440) Allow APL tooling to prefill the IDE search field through 4454⌶. | Coordinate interpreter support | Decide whether a narrow supported IDE automation API belongs in the product before exposing this I-beam. | Interpreter/protocol |
| [#588](https://github.com/Dyalog/ride/issues/588) Allow several 3500⌶ output windows to coexist and be updated individually. | Coordinate interpreter support | Introduce explicit create/update handles and decide behavior when a referenced window has closed. | Interpreter/protocol |
| [#584](https://github.com/Dyalog/ride/issues/584) Support script-driven SVG animations in 3500⌶ output. | Verify existing behavior | Specify supported active SVG behavior and isolation consistently for native and browser clients. | Multiple layers |
| [#404](https://github.com/Dyalog/ride/issues/404) Let demo scripts independently control displaying and executing each line. | Defer pending scope | Reuse ]demo escape conventions and define whether display-only text is persisted in the interpreter log. | Interpreter/protocol |
| [#782](https://github.com/Dyalog/ride/issues/782) Explore printing session or editor content. | Defer pending scope | Establish the printing use case and desired content before committing a print UI. | Native shell |

### Distribution and platform support

| Issue and ask | Next step | Decision or acceptance boundary | Dependency |
| --- | --- | --- | --- |
| [#36](https://github.com/Dyalog/ride/issues/36) Check automatically for available RIDE updates. | Design together | Choose notification-only checks, frequency, release channel and an explicit opt-out. | Build/release |

## Separate maintenance and documentation work

The following work is non-bug work but does not belong in the product-design queue above. Platform support remains a release-policy choice; it is not a frontend UI feature.

| Workstream | Issues | Treatment |
| --- | --- | --- |
| Release/platform coverage | [#1005](https://github.com/Dyalog/ride/issues/1005), [#1319](https://github.com/Dyalog/ride/issues/1319), [#1398](https://github.com/Dyalog/ride/issues/1398), [#1412](https://github.com/Dyalog/ride/issues/1412) | Decide and execute the supported target/release matrix; the Pi report also points to an obsolete launcher hardware check. |
| Build tooling and packaging | [#943](https://github.com/Dyalog/ride/issues/943), [#953](https://github.com/Dyalog/ride/issues/953), [#991](https://github.com/Dyalog/ride/issues/991), [#1207](https://github.com/Dyalog/ride/issues/1207), [#1247](https://github.com/Dyalog/ride/issues/1247), [#1248](https://github.com/Dyalog/ride/issues/1248), [#1252](https://github.com/Dyalog/ride/issues/1252), [#1276](https://github.com/Dyalog/ride/issues/1276) | Dependency, packaging and reproducibility maintenance; reassess Electron-specific work for Tauri. |
| CI and contributor infrastructure | [#996](https://github.com/Dyalog/ride/issues/996), [#1092](https://github.com/Dyalog/ride/issues/1092), [#1094](https://github.com/Dyalog/ride/issues/1094), [#1231](https://github.com/Dyalog/ride/issues/1231), [#1246](https://github.com/Dyalog/ride/issues/1246) | Build efficiency and diagnostics. The Spectron replacement in #1231 has already been handled by the Tauri test port. |
| Docs | [#597](https://github.com/Dyalog/ride/issues/597), [#998](https://github.com/Dyalog/ride/issues/998), [#1163](https://github.com/Dyalog/ride/issues/1163), [#1164](https://github.com/Dyalog/ride/issues/1164), [#1165](https://github.com/Dyalog/ride/issues/1165), [#1166](https://github.com/Dyalog/ride/issues/1166), [#1175](https://github.com/Dyalog/ride/issues/1175), [#1242](https://github.com/Dyalog/ride/issues/1242), [#1262](https://github.com/Dyalog/ride/issues/1262), [#1263](https://github.com/Dyalog/ride/issues/1263), [#1264](https://github.com/Dyalog/ride/issues/1264), [#1285](https://github.com/Dyalog/ride/issues/1285), [#1320](https://github.com/Dyalog/ride/issues/1320), [#1411](https://github.com/Dyalog/ride/issues/1411) | Keep accuracy/publication tasks together; #1263/#1264 overlap on upgrade and preference migration guidance. |

## Planning result

| Next step across design and mixed reports | Issues |
| --- | ---: |
| Specify next | 9 |
| Design together | 56 |
| Coordinate interpreter support | 16 |
| Verify existing behavior | 10 |
| Defer pending scope | 5 |
| Split bug from design | 5 |

No production changes, issue mutations or new runtime tests were needed for this classification. The report and inventory are local review artifacts; they do not create a Tauride issue backlog or authorize any proposed behavior.
