# Pair programming with an agent in Tauride

Design note. Nothing here is implemented.

## Goal

An agent such as Claude Code works in the same Dyalog session as the person:
it runs expressions, drives the tracer, and sees what the person typed and
what the interpreter produced. Both see one session, one workspace, one
tracer. This is not a second interpreter for the agent (that is what
`gritt` and `dyalogscript` already give), and not GUI automation.

## The governing constraint

An interpreter accepts one Ride connection. The agent cannot connect to
Dyalog alongside Tauride, and a proxy between Tauride and the interpreter
would still miss frontend state: the queue of lines waiting for the prompt,
`hadErr`, which window has focus, unsaved editor text. So the agent attaches
to Tauride, and Tauride stays the only thing that speaks to the interpreter.

Two consequences:

- The agent observes the protocol at Tauride's two chokepoints: `D.recv`
  (`src/ide.js`, every message from the interpreter) and `D.send`
  (`src/cn.js` for sockets, `src/init.js` for the browser transport). The tap
  lives in the session window, which is the IPC master: helper and floating
  windows already route their traffic through it (`src/ipc.js`), so one tap
  sees everything.
- The agent acts through Ride's command layer, never through raw `D.send`.
  Execution goes through `D.ide.exec`, so an agent line enters the same
  pending-lines queue as the person's input ("AtInputPrompt consumes one
  item, HadError empties it", `src/ide.js`) and interleaves correctly on the
  single prompt. Tracer actions go through the command codes in `src/cmds.js`
  / `src/km.js` (step into, run line, continue, continue trace, trace back
  and forward, cutback, restart threads, toggle stop), bound to a window
  token, so the tracer window the person is looking at reflects what the
  agent did. Raw protocol sends would desynchronise the frontend.

## What the agent sees

Three sources are available for "the session log"; they are not the same.

| Source | Has inputs | Live | Use |
|---|---|---|---|
| Interpreter `GetLog` / `ReplyGetLog` | no: input lines come back as empty strings (xpqz/tauride#33) | on request | not used |
| The session window's own buffer (`src/se.js`), filled live from the input echo, `AppendSessionOutput`, `HadError` | yes | yes | the live transcript, and the backfill when the agent attaches |
| `hist.txt` in the user data dir, written by `se.histWrite` | inputs only | written on exit | history across restarts |

The tap writes a **transcript**: one JSON line per event, appended to a file
beside `hist.txt` (`sessions/<appid>.jsonl`) while agent mode is on, and
streamed to a connected agent. Events:

- `input`: an entered line, with `origin: human | agent` (the tap knows which
  `Execute` it sent itself) and the prompt type it was entered at.
- `output`: `AppendSessionOutput` text, with the `type` the interpreter
  gives it.
- `error`: `HadError` with the DMX fields.
- `prompt`: `SetPromptType` changes (0 busy, 1 ready, 2 `⎕` input, 4 `⍞`
  input, 3 line editor).
- `window`: `OpenWindow`, `UpdateWindow`, `CloseWindow`, `SaveChanges`,
  `SetHighlightLine`: editor and tracer text, which line is current.
- `stack`: `ReplyGetSIStack`.
"The person's typing" means entered lines, which is what `input` carries:
the echo of a submitted line (`EchoInput`, or the `AppendSessionOutput` of
type 14 that interpreters such as Dyalog 21.0 send instead) arrives once the
line has been entered, so the agent sees each complete line in order with
the output that followed it, and nothing of the
editing that preceded Enter. Keystrokes in progress are not part of this
design; if they are ever wanted, they are a separate `draft` subscription
from Monaco's content-change events, never mixed into the transcript.

A file the agent can `tail` with ordinary tools is deliberately the primary
channel for observation: it works with no MCP server at all, survives a
reconnect, and is the shared memory of the pairing session.

## What the agent can do

A small request/response surface over the same connection. Every request
names a session (`main` or `w<id>`, since Tauride runs every session in one
process).

| Request | Maps to | Returns |
|---|---|---|
| `execute(text, timeout)` | `D.ide.exec` | the output produced by that line: the slice of `output`/`error` events between its `EchoInput` and the next `SetPromptType 1`, capped (say 200 lines, with `truncated` and a `more` cursor), plus the final prompt type |
| `answer(text)` | `D.ide.exec` while prompt type is 2 or 4 | as above; `execute` refuses at those prompt types so an agent line is never taken as data input by mistake |
| `interrupt(weak \| strong)` | `WeakInterrupt` / `StrongInterrupt` | the prompt type afterwards |
| `tail(n)` / `since(cursor)` | the transcript | events |
| `windows()` | `D.ide.wins` | editors and tracers: token, name, kind, text, current line, stops, saved or not |
| `trace.step_into`, `step_over`, `continue`, `continue_trace`, `back`, `forward`, `cutback`, `restart` (token) | the `cmds.js` commands | the next `SetHighlightLine` or window close |
| `stops(token, lines)` | `SetLineAttributes` through the editor | the editor's stop list |
| `stack()` | `GetSIStack` | `ReplyGetSIStack` |
| `save(token, text)` | the editor's save path (`SaveChanges`, `ReplySaveChanges`) | success or the interpreter's error; the editor window shows the saved text |
| `value(expr)` | `GetValueTip` | the tip text: inspection in the current frame without an `Execute`, so no `⎕`-noise in the session |

Attribution of output is best-effort by construction: the interpreter does
not tag output by request, and output from other threads (`&`) interleaves.
`execute` reports what arrived between its echo and the prompt's return, and
says so.

## Transport

Rust already has listening sockets (`net.rs`) and per-window events. The
agent port is a Unix domain socket in the user data dir, mode 0600, carrying
newline-delimited JSON frames (`{id, session, request, ...}` /
`{id, result | error}` and unsolicited `{event}` frames). `agent.rs` only
moves frames between the socket and the session webview (`emit_to` /
`invoke`), as `net.rs` does for Ride's own sockets; the logic is in the
frontend tap (`src/agent.js`, gated on `window.__RIDE__` so Electron is
untouched). Windows gets a loopback TCP port with a token in a 0600 file.

Claude Code attaches through a thin MCP stdio adapter (`tools/tauride-mcp`)
that connects to the socket and exposes the requests above as tools and the
transcript as notifications. The same binary doubles as a CLI
(`tauride-mcp exec '⍳5'`), which is how the person tests it and how scripts
use it. Hosting MCP over HTTP inside Tauride is possible later; it is more
Rust for no gain while one adapter does the job.

## Staying in control

The person is about to let an agent run arbitrary APL in their workspace.

- Off by default. A menu item (Agent ▸ Allow control) or `RIDE_AGENT=1`
  turns the port on per session; the status bar shows "agent connected" and
  who ran the current line.
- Read-only first: observation works as soon as the port is on; `execute`,
  `save` and the tracer actions need the "allow control" toggle, which the
  person can revoke at any moment (the request then fails with a clear
  error). An optional "confirm each action" mode shows a toast with Run and
  Deny for people who want to watch the agent's hands.
- Agent-originated input is visibly marked in the session (a gutter glyph
  and a muted background on the input line), so a transcript read later
  still shows who typed what.
- `execute` never touches the person's half-typed line: it goes straight to
  `D.ide.exec`, and the session already renders lines it did not type (that
  is how pasted multi-line input works).
- One line in flight at a time; a request while the interpreter is busy
  waits or fails with `busy`, never queues silently. Weak interrupt on Dyalog
  21.0 can end the interpreter in some loops (xpqz/tauride#31), so the
  adapter says which interrupt it sent.

## Phases

1. Transcript file, socket, `execute`, `interrupt`, `tail`, the CLI. This
   alone gives "run expressions and see my typing and results".
2. Windows and tracer: `windows`, `trace.*`, `stops`, `stack`, `save`,
   `value`, bound to Ride's existing commands.
3. MCP notifications, the session decoration for agent lines, the
   confirm-each-action mode.

Each phase is useful on its own. If any of them starts to need a protocol
change or interpreter cooperation, it has gone wrong: everything here is
built from messages and commands Ride already has.

## Cheap prototype

`RIDE_JS` runs a JavaScript file in the session window at startup through
`D.wm.current().eval`, and the pages' CSP restricts only `script-src`, so a
file that installs the tap and opens a WebSocket to a local server tries the
whole observation side and `execute` with no Rust change. That is the way to
find out what the transcript should contain before any of the above is
written.

## Decisions

- The agent may edit and save functions. `save(token, text)` goes through
  the editor's own save path, so the interpreter's answer
  (`ReplySaveChanges`, including a refusal to change a suspended function
  from the tracer) comes back as the result, and the open editor shows the
  new text exactly as it would after the person pressed Escape. The saved
  text is an `input`-like `window` event in the transcript with
  `origin: agent`, so an edit is as visible afterwards as an executed line.
- One agent per session. The socket accepts one connection per session and
  refuses a second with `busy` until the first disconnects. Sessions are
  independent, so two sessions can each have an agent.

## Phase 1: wire format

Fixed here so the Rust side, the frontend tap and the CLI are written
against one description.

**Switching on.** `RIDE_AGENT=1` opens the port for observation only;
`RIDE_AGENT=control` also allows `execute`, `answer` and `interrupt`. The
same two levels exist as preferences `agent` (`0`, `1`, `control`) read at
session start; the environment wins. The status bar shows `agent: observing`
/ `agent: control` and ` (connected)` while a client is attached.

**Socket.** One Unix domain socket per session window:
`<userData>/agent/<label>.sock` (`main.sock` for the first session,
`w<id>.sock` for the others), directory mode 0700, socket 0600, removed
when the session window closes. One connection at a time; a second
connection is answered with `{"err":{"code":"busy"}}` and closed. Windows
is not in phase 1 (`agent_listen` returns an error there).

**Frames.** Newline-delimited JSON, UTF-8, one object per line, both ways.

Client to Tauride, `id` chosen by the client:

| `req` | fields | notes |
|---|---|---|
| `status` | | caption, prompt type, level (`observe`/`control`), interpreter version, transcript path, `seq` of the latest event |
| `execute` | `text`, `timeout` (ms, default 30000) | refused unless level is `control` and the prompt type is 1 |
| `answer` | `text`, `timeout` | as `execute`, but only at prompt types 2 and 4 |
| `interrupt` | `strength`: `weak` \| `strong` | control only |
| `tail` | `n` (default 100) | the last `n` transcript events |
| `since` | `seq` | every event after `seq` |

Tauride to client: `{"id": n, "ok": {...}}` or
`{"id": n, "err": {"code": c, "message": m, ...}}`, and unsolicited
`{"ev": {...}}` for every new transcript event while connected (so `tail`
and `since` are for backfill). Error codes: `refused` (level too low),
`prompt` (wrong prompt type; carries `prompt`), `busy` (a request is already
in flight, or a second connection), `timeout` (carries the `partial` result
collected so far), `closed` (session disconnected from the interpreter),
`bad_request`.

**`execute` / `answer` result.** `{"echo": text, "lines": [{"kind":
"output" | "error", "type": t, "text": s}, ...], "error": dmx | null,
"prompt": p, "truncated": bool, "seq": [first, last]}`. The line goes
through `D.ide.exec`; the result is the transcript slice from its echo
(`EchoInput`, or the type-14 `AppendSessionOutput` that Dyalog 21.0 sends
instead) to the next `SetPromptType` that leaves 0, capped at 200 lines
or 64 KB with `truncated: true` (the rest is in the transcript). One request
in flight per session; the human's own input in the meantime is reported as
`input` events, not mixed into the result.

**Transcript.** `<userData>/sessions/<label>-<appid>.jsonl`, one event per
line, appended as events happen while the level is at least `observe`:

```
{"seq": 17, "t": "2026-10-09T10:21:03.412Z", "kind": "input",  "origin": "human", "prompt": 1, "text": "⍳5"}
{"seq": 18, "t": "...", "kind": "output", "origin": "human", "type": 1, "text": "1 2 3 4 5"}
{"seq": 19, "t": "...", "kind": "prompt", "prompt": 1}
{"seq": 20, "t": "...", "kind": "error",  "origin": "agent", "dmx": {...}}
{"seq": 21, "t": "...", "kind": "window", "event": "open" | "update" | "close" | "save" | "highlight", "token": 7, "name": "foo", "debugger": true, ...}
```

`origin` on `output` and `error` is the origin of the line being executed
when they arrived (best effort, as the design says). `kind: window` events
carry the message's own fields; `save` ones add `origin`. `stack` events
carry `ReplyGetSIStack`.

**Hooks.** The tap wraps `D.recv` and `D.send` once `D.ide` exists and
re-wraps if either is reassigned (both are reassigned on connect). It is
loaded only under `window.__RIDE__`; the Electron build never sees it.

**CLI / MCP adapter.** `tools/tauride-mcp` (Node, no dependencies):
`tauride-mcp [--session main | --socket path] status | exec <text> |
answer <text> | interrupt [weak|strong] | tail [n] | watch | mcp`.
`watch` prints events as they arrive; `mcp` serves MCP over stdio
(newline-delimited JSON-RPC: `initialize`, `tools/list`, `tools/call`,
`ping`) with the tools `execute`, `answer`, `interrupt`, `tail`, `status`.
The socket path defaults to `~/.config/Ride-4.8/agent/<session>.sock` and
can be set with `TAURIDE_SOCKET`.
