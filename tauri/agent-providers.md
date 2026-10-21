# Error explanation providers

Design note. What is built is in Status at the end.

## Goal

Explain Last Error (`AGE`) works with more than one agent. The person picks
a provider in Preferences; the context bundle, the panel, the request
lifecycle and the privacy rules are the same whichever provider answers.

## Provider-neutral baseline

#145 kept these independent of Codex; the extraction preserves them:

- **Context.** `src/error_context.js` freezes a bounded JSON bundle per
  error: identity, message, input and output, interpreter, windows, stack,
  value previews, `unavailable`, `truncated`, `stale`.
- **Panel protocol.** The `ride-companion` event carries `requestId` and
  one of `status`, `delta`, `done`, `error`, with timings. Any streaming
  backend produces these.
- **Lifecycle.** `validate_owner`, one active request per session
  (`Session::begin`), cancellation by request id, `cleanup` on window close
  and `cleanup_all` on exit, `TURN_TIMEOUT`, `MAX_CONTEXT`. Shared delivery
  now enforces `MAX_OUTPUT` too.
- **Prompt.** `explanation_prompt` names the snapshot as untrusted data.
  The extraction separates its instruction components and serialized snapshot
  while preserving the generated text.

## Codex-specific baseline

- `Server` in `src-tauri/src/companion.rs`: spawning `codex app-server` with
  the `features.*=false` overrides, the JSON-RPC exchange (`initialize`,
  `config/read`, `thread/start`, `turn/start`, `turn/completed`,
  `thread/unsubscribe`), disabling the user's MCP servers, `sandbox` and
  `approvalPolicy`.
- `check_setup` and `account_status`: `account/read` mapped to `ready` or
  `signin`.
- Before extraction, strings were hard-coded: the `AGE` label in `src/cmds.js`, `src/init.js` and the default
  menu in `src/prf.js`; the panel title, guidance and docs link in
  `src/error_help.js`; the `code_agexe` and `code_agmodel` preferences in
  `index.html`.

## The provider interface

`Session` holds an optional boxed provider and its process identity instead
of `Option<Server>`. Process settings (provider id and executable) form that
identity: a change stops the old provider before starting the replacement.
One registry lookup returns the selected descriptor and an unstarted provider
instance together. Construction and dropping an unused instance must not touch
an existing session child; only the instance installed for an explanation owns
that process.

Request settings (currently model) are passed to each explanation. A model
change does not restart a warm process, matching today's `thread/start`
behaviour. The setup cache uses the same process identity and ignores model.

Use boxed `Send` futures rather than native async trait methods so the trait
is object-safe. The emitter is fallible and `Send`, allowing shared output
limits to stop a provider immediately. The following is the interface shape;
concrete types live in `companion.rs`.

```rust
type ProviderFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

trait Provider: Send {
    fn descriptor(&self) -> &Descriptor;
    fn reusable(&self) -> bool;
    fn check(&mut self, timeout: Duration) -> ProviderFuture<'_, SetupStatus>;
    fn explain<'a>(
        &'a mut self,
        prompt: &'a Prompt,
        model: &'a str,
        emit: &'a mut (dyn FnMut(&str, String) -> Result<(), String> + Send),
    ) -> ProviderFuture<'a, Result<(), String>>;
    fn stop(&mut self) -> ProviderFuture<'_, ()>;
}

struct Descriptor {
    id: &'static str,
    name: &'static str,
    warm: bool,
    enforces_no_tools: bool,
    supports_model: bool,
    docs_url: Option<&'static str>,
    guidance: SetupGuidance,
}

struct Prompt {
    base_instructions: &'static str,
    developer_instructions: &'static str,
    user_prefix: &'static str,
    snapshot: String,
}
```

Do not combine the three instruction components. Codex puts the existing
base and developer strings in `thread/start`, and the existing user prefix
(including its final newline) immediately before the compact JSON snapshot
in `turn/start`. All three strings and their wire placement remain byte for
byte identical. Future providers can place them according to their own
protocol. Only the serialized snapshot counts toward `MAX_CONTEXT`.

`Session` retains the shared child-process slot outside the provider mutex.
Each provider registers its child there before its first asynchronous wait.
This lets `terminate` call `start_kill` while an explanation owns the provider
lock. `stop` is idempotent, kills the owned child and reaps it. Drop is the
fallback for interrupted startup. A cold provider registers the current
request's child, reaps and clears it on completion, and can succeed with an
empty slot; absence of a child is not itself a failed explanation. After a
successful request, `Provider::reusable` decides whether Session retains the
instance. Child presence and the `warm` descriptor are adapter concerns, not
Session policy.

Setup uses a separate provider instance and child slot, never the session's
warm process. Its own bounded timeout and cleanup cover every result,
including startup failures. Closing the panel discards the result but does
not cancel the probe. Explanation cancellation, `cleanup` and `cleanup_all`
operate only on the session's explanation provider.

Setup states keep their names (`missing`, `signin`, `ready`,
`unavailable`); the provider supplies the message and its descriptor supplies
the guidance for `missing`, `signin` and `unavailable`, so `error_help.js` holds
no provider-specific text. There is no unused `ready` guidance field.

### Rules every provider keeps

- A new conversation per error, with persistence disabled where the provider
  supports that control. This is not a promise about service-side retention.
- The working directory is the empty per-companion directory `Server`
  creates now.
- No tools and no approvals where the provider allows Tauride to enforce
  it. A request for a tool or approval fails the explanation.
- Explanation cancellation, observation off and session close kill the
  explanation process. A setup check runs to its own time limit and cleans
  itself up; the closed panel ignores its result.
- Shared delivery caps streamed text at `MAX_OUTPUT`; each protocol adapter
  bounds framing at `MAX_LINE`.
- `check` sends nothing from the session.

## Providers

### `codex`

The present `Server`, moved behind the trait without behaviour change.
`warm: true`, `enforces_no_tools: true`, `supports_model: true`. The
existing behavioural assertions against `fake-codex-app-server.py` remain
unchanged. Commit a request-capture test before extraction and show that it
passes both before and after with its source unchanged. Mechanical test
harness, mock, preference setter, DOM selector, renamed label and signature
changes are allowed; list each edit and its reason in the PR document.
Behavioural assertions must not be removed, weakened or have their expected
values changed. Following the unchanged before/after extraction proof, final
review explicitly replaces the capture test's hard-coded client version with
`package.json`'s version; the protocol and prompt checks remain the same.

### `claude`

Claude Code in print mode (#147), one process per request: `warm: false`,
never reusable, `enforces_no_tools: true`, `supports_model: true`.

```
claude -p --output-format stream-json --verbose --include-partial-messages
       --tools "" --strict-mcp-config --setting-sources ""
       --no-session-persistence --disable-slash-commands
       --system-prompt <base>\n\n<developer> [--model=<m>]
```

The user prefix and snapshot go to stdin, which is then closed. The working
directory is a fresh empty directory per request, removed afterwards. The
model is passed as `--model=<m>` so that a value beginning with `-` is
never parsed as an option.

Measured against Claude Code 2.1.301:

- Text arrives only as `stream_event` messages whose `event` is a
  `content_block_delta` with a `text_delta`. The `assistant` message and
  `result.result` repeat the same text and are not streamed; `result.result`
  is used only when no delta arrived.
- The `result` message reports failure through `is_error`, independently of
  `subtype`: an API billing error arrives as `subtype: "success"`,
  `is_error: true`.
- With these flags the `system`/`init` message lists no tools, no MCP
  servers, no slash commands and no skills. The provider checks `init` and
  fails the request if any tool or MCP server is present, and fails on any
  `tool_use` content block.
- Without `--setting-sources ""`, user hooks run and a plugin's
  `SessionStart` hook injects its own instructions into the conversation.
  With it, neither happens.
- `--bare` is not used: it restricts authentication to `ANTHROPIC_API_KEY`
  or an `apiKeyHelper` and never reads the claude.ai sign-in.

`check` runs `claude auth status --json` and maps `loggedIn` to `ready` or
`signin`; it starts no inference. As for Codex, `ready` confirms local
setup, not model access: with `ANTHROPIC_API_KEY` set, Claude Code uses
that key in preference to the sign-in, and an account without credit fails
at explanation time with the service's message.

### `command`

"Custom command" (#148): a program and its arguments, one per line, run
directly with no shell; blank lines are skipped. `warm: false`, never
reusable, `enforces_no_tools: false`, `supports_model: false` (a model
belongs in the arguments), `supports_args: true`. Only a provider with
`supports_args` accepts an `args` setting, in the Rust configuration, in
Preferences and in the panel.

Tauride writes the whole prompt to stdin as one text (base instructions,
developer instructions, then the user prefix and snapshot, separated by
blank lines) and closes it. stdout is streamed as `Delta`, decoded as UTF-8
without splitting a character across deltas. The command runs in its own
process group in an empty private working directory, so cancellation,
disabling observation and session close end what it started too.

Exit status 0 with text completes the explanation. A non-zero exit is the
error, with at most 4 KiB of stderr; exit 0 without text is an error; a
command that closes stdout but does not exit within 3 s is ended and
reported. `check` reports `ready` when the executable resolves on `PATH` or
as a path and `missing` otherwise, including when none is set; it never runs
the command.

Because Tauride cannot know what an arbitrary command does with the data
or whether it can act, the panel's disclosure says so for this provider
instead of promising read-only behaviour.

## Preferences and commands

- One provider selector. Executable and model per provider under Advanced;
  for `command`, the argv. The `code_agexe`/`code_agmodel` preferences are
  controls and the `agentExecutable`/`agentModel` preferences are replaced
  outright; there is no migration or alias.
- `companion_providers` returns the descriptor list to both the session panel
  and Preferences helper window. Step 1 registers only `codex`.
- Store `agentProvider` (default `codex`) and `agentProviderSettings`, a map
  keyed by provider id, initially `{codex: {executable: "", model: ""}}`.
  Validate the map and each provider's allowed fields and types; reject
  unknown provider ids or settings. The native commands validate the selected
  provider's settings too. Executable belongs to process identity; model is a
  per-request override.
- The panel uses `name`, `docs_url` and state-specific `guidance` from the
  descriptor. Preferences uses `id`, `name` and `supports_model`; lifecycle
  uses `reusable`; the Codex adapter uses `warm` in its reuse decision. Disclosure promises enforced read-only operation and no tools
  only for `enforces_no_tools: true`, otherwise it explains the absence of
  that guarantee.
- `AGE` keeps its command code and the label `Explain Last Error…` in
  `cmds.js` and the default menu in `prf.js`. The specific-error context menu
  in `init.js` is `Explain This Error…`; the panel title names the provider. The native menu is built from the frontend's menu
  definition (`set_app_menu`), which the person may customise, so a label
  that changed with the provider would have to rewrite that definition.

## The attached agent

The pairing interface (`agent-pairing.md`, `tools/tauride-mcp`) already
lets an external agent attach to Tauride. It gains one request,
`last_error`, which returns the frozen bundle for the latest error (or for
an id), with its `stale` flag. An attached agent then explains an error in
its own conversation, with its own tools and permissions, and needs no
companion. This is the other direction from the providers above and does
not replace them: the companion works with no agent attached.

## Order

1. Provider trait; Codex behind it; neutral strings and preferences. Lands
   before #145 merges, so Codex-shaped preferences never ship.
2. `claude` provider.
3. `command` provider.
4. `last_error` in the pairing interface. Independent of 1 to 3.

## Status

Step 1 is implemented on the #145 branch: the provider trait, Codex adapter,
provider-neutral UI and preferences, and descriptor discovery. Validation
and the unchanged request-capture proof are recorded in `docs/prs/145.md`.

Step 2, the `claude` provider, is implemented in #147; validation, mutation
checks and a live run are recorded in `docs/prs/147.md`. Step 3, the `command` provider, is implemented in #148
(`docs/prs/148.md`). Step 4, the pairing interface's `last_error` request,
is implemented in #149 (`docs/prs/149.md`): the request, its row in
`agent-pairing.md`, the MCP tool `last_error` and the CLI command
`last-error`.
