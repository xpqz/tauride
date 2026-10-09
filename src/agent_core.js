// Agent pairing (tauri/agent-pairing.md): the part of the tap that needs
// neither the DOM nor Tauri, so `node --test test/agent_core.js` can drive it
// with fake protocol messages: frame validation, the request table with its
// levels, the execute/answer correlation, the correlations behind edit, save,
// trace, stack and value, the event ring, the transcript batches and the wait
// matcher. It loads as a plain script in the webview (D.agentCore) and as a
// module in node. src/agent.js supplies the io callbacks and feeds it the
// D.recv/D.send traffic and the socket's lines.
(function agentCoreModule(root) {
  const RING = 1000; // events kept for tail and since; the file has the rest
  const MAX_LINES = 200; // an execute result's cap
  const MAX_CHARS = 64 * 1024;
  const BATCH = 200; // transcript events handed over at once
  const FLUSH_MS = 100;
  const DEFAULT_TIMEOUT = 30000;
  const CONFIRM_MS = 60000; // no answer from the person is a deny
  const SETTLE_MS = 10; // the poll for ide.js having handled every message the tap has seen

  // The codes a reply can carry. unauthorized is Rust's: it closes a Windows
  // connection whose first frame is not the token. It is listed so a client
  // finds every code in one place.
  const CODES = ['refused', 'prompt', 'busy', 'timeout', 'closed', 'bad_request', 'not_found', 'save', 'denied', 'unauthorized'];
  // Each request's level, whether the confirm mode gates it, and whether it
  // reads or drives D.ide (settle: it runs once ide.js has handled every
  // message the tap has seen). The confirmed requests are the ones that hold
  // the session's one control slot.
  const REQUESTS = {
    status: { level: 'observe' },
    tail: { level: 'observe' },
    since: { level: 'observe' },
    windows: { level: 'observe', settle: true },
    window_text: { level: 'observe', settle: true },
    stack: { level: 'observe', settle: true },
    value: { level: 'observe', settle: true },
    wait: { level: 'observe' },
    execute: { level: 'control', confirm: true, settle: true },
    answer: { level: 'control', confirm: true, settle: true },
    interrupt: { level: 'control', confirm: false },
    edit: { level: 'control', confirm: true, settle: true },
    save: { level: 'control', confirm: true, settle: true },
    stops: { level: 'control', confirm: true, settle: true },
    trace: { level: 'control', confirm: true, settle: true },
  };
  const TRACE_ACTIONS = ['step_into', 'step_over', 'continue', 'continue_trace', 'back', 'forward', 'cutback', 'restart', 'edit'];
  // What value accepts: a dotted APL name, optionally from #, ## or ⎕SE.
  // Anything else is an expression, which value does not evaluate.
  const PART = '⎕?[\\p{L}_∆⍙][\\p{L}\\p{N}_∆⍙¯]*';
  const NAME = new RegExp(`^(?:(?:#|##|⎕SE)\\.)?${PART}(?:\\.${PART})*$`, 'u');
  // Dyalog 21.0 answers GetValueTip for a system name (⎕IO, ⎕PW, ⎕SE itself)
  // with nothing at all, so asking would only time out; a name inside ⎕SE is
  // answered.
  const SYSTEM = /(^|\.)⎕[^.]*$/u;

  const isInt = (x) => Number.isInteger(x);
  const isLines = (x) => Array.isArray(x) && x.every((l) => isInt(l) && l >= 0);
  const isStrings = (x) => Array.isArray(x) && x.every((s) => typeof s === 'string');
  const oneLine = (x) => typeof x === 'string' && !x.replace(/\n$/, '').includes('\n');

  // Whether an event is the one a wait is for. Input text carries the
  // session's indent, so the prefix also matches after leading blanks.
  const matches = (e, q) => (!q.kinds || q.kinds.includes(e.kind))
    && (!q.origin || e.origin === q.origin)
    && (!q.prefix || (typeof e.text === 'string'
      && (e.text.startsWith(q.prefix) || e.text.trimStart().startsWith(q.prefix))));

  // Why a request's fields are unusable, or null.
  const invalid = (m) => {
    const { req } = m;
    if (m.timeout !== undefined && !(+m.timeout > 0)) return 'timeout must be a positive number of milliseconds';
    switch (req) {
      case 'execute': case 'answer':
        return oneLine(m.text) ? null : 'text must be one line';
      case 'interrupt':
        return [undefined, 'weak', 'strong'].includes(m.strength) ? null : 'strength must be weak or strong';
      case 'tail':
        return m.n === undefined || typeof m.n === 'number' ? null : 'n must be a number';
      case 'since':
        return m.seq === undefined || typeof m.seq === 'number' ? null : 'seq must be a number';
      case 'edit':
        return oneLine(m.name) && m.name.trim() ? null : 'name must be a non-empty line';
      case 'value':
        if (!(typeof m.name === 'string' && NAME.test(m.name))) return 'name must be a name, not an expression';
        return SYSTEM.test(m.name) ? 'the interpreter gives no value tip for a system name such as ⎕IO; execute it instead' : null;
      case 'wait':
        if (m.since !== undefined && typeof m.since !== 'number') return 'since must be a seq number';
        if (m.kinds !== undefined && typeof m.kinds !== 'string' && !isStrings(m.kinds)) return 'kinds must be a kind or a list of kinds';
        if (m.origin !== undefined && typeof m.origin !== 'string') return 'origin must be a string';
        if (m.prefix !== undefined && typeof m.prefix !== 'string') return 'prefix must be a string';
        return null;
      case 'window_text': case 'save': case 'stops': case 'trace':
        if (!isInt(m.token)) return 'token must be a window token';
        if (req === 'save' && !(typeof m.text === 'string' || isStrings(m.text))) return 'text must be a string or a list of lines';
        if (req === 'save' && m.stops !== undefined && !isLines(m.stops)) return 'stops must be a list of line numbers';
        if (req === 'stops' && !isLines(m.lines)) return 'lines must be a list of line numbers';
        if (req === 'trace' && !TRACE_ACTIONS.includes(m.action)) return `action must be one of ${TRACE_ACTIONS.join(', ')}`;
        return null;
      default: return null;
    }
  };
  const ms = (m) => (m.timeout === undefined ? DEFAULT_TIMEOUT : +m.timeout);

  // io: send(frame) to the client; append(lines) to the transcript;
  // transcript() its path; transcriptStatus() -> Promise<{size, rotated}>;
  // ide() -> {connected, prompt, pending, caption, version} or null; the
  // actions exec(text), interrupt(strength), windows(), window(token),
  // edit(name), save(token, lines, stops) -> whether SaveChanges went out,
  // stops(token, lines) -> the window's stops, trace(token, action),
  // stack(), value(name) -> the GetValueTip token; confirmNeeded(),
  // confirm(request) -> Promise<boolean>; onAgentEcho(seq, text); now().
  const create = (io) => {
    const now = io.now || (() => new Date().toISOString());
    const ring = [];
    let seq = 0;
    let level = null; // null while the port is closed, else observe or control
    let connected = false;
    let prompt = 1; // as of the latest SetPromptType seen, ahead of D.ide.promptType
    let last = { origin: 'human', prompt: 1 }; // the line most recently executed
    let acting = false; // while an action the agent asked for runs: its sends are the agent's
    let inflight = null; // the control request being confirmed or carried out: one at a time
    const waiters = []; // correlations awaiting a protocol message or an event
    let batch = []; // transcript lines not yet handed over
    let flushTimer = null;

    const send = (frame) => { connected && io.send(frame); };
    const reply = (id, body) => { send({ id: id === undefined ? null : id, ...body }); };
    const failure = (code, message, more) => ({ err: { code, message, ...more } });

    const flush = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!batch.length) return;
      const lines = batch;
      batch = [];
      io.append(lines);
    };
    const record = (r) => {
      batch.push(JSON.stringify(r));
      if (batch.length >= BATCH) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    };

    const remove = (w) => {
      clearTimeout(w.timer);
      const i = waiters.indexOf(w);
      i >= 0 && waiters.splice(i, 1);
    };
    // feed sees ('recv', x, y) for protocol messages and ('event', r) for
    // transcript events, and returns true once the waiter is done.
    const expect = (timeout, feed, expired) => {
      const w = { feed };
      w.timer = setTimeout(() => { remove(w); expired(); }, timeout);
      waiters.push(w);
      return w;
    };
    const dispatch = (kind, a, b) => {
      waiters.slice().forEach((w) => { w.feed(kind, a, b) && remove(w); });
    };

    // Nothing is recorded while the port is closed; the protocol is still
    // followed, so the prompt and the origin of the running line are right
    // when it opens.
    const event = (e) => {
      if (!level) return null;
      seq += 1;
      const r = { seq, t: now(), ...e };
      ring.push(r);
      ring.length > RING && ring.shift();
      record(r);
      send({ ev: r });
      dispatch('event', r);
      return r;
    };
    const win = (ev, y) => event({
      kind: 'window', event: ev, token: y.token === undefined ? y.win : y.token, ...y,
    });
    const input = (text) => {
      const r = event({
        kind: 'input', origin: last.origin, prompt: last.prompt, text: text.replace(/\n$/, ''),
      });
      r && r.origin === 'agent' && io.onAgentEcho && io.onAgentEcho(r.seq, r.text);
    };
    const recv = (x, y) => {
      switch (x) {
        case 'EchoInput': input(y.input); break;
        // An interpreter with apiVersion 1 sends no EchoInput: the entered
        // line comes back as output of type 14.
        case 'AppendSessionOutput':
          if (y.type === 14) input(y.result);
          else {
            event({
              kind: 'output', origin: last.origin, type: y.type || 0, text: y.result,
            });
          }
          break;
        // The payload's own fields: Dyalog 21.0 sends {error, dmx} with the
        // error number in both.
        case 'HadError': event({ kind: 'error', origin: last.origin, ...y }); break;
        case 'SetPromptType': prompt = y.type; event({ kind: 'prompt', prompt: y.type }); break;
        case 'OpenWindow': win('open', y); break;
        case 'UpdateWindow': win('update', y); break;
        case 'CloseWindow': win('close', y); break;
        case 'SetHighlightLine': win('highlight', y); break;
        case 'ReplyGetSIStack': event({ kind: 'stack', stack: y.stack }); break;
        default:
      }
      dispatch('recv', x, y);
    };
    const sent = (x, y) => {
      const origin = acting ? 'agent' : 'human';
      if (x === 'Execute') {
        const i = io.ide();
        last = { origin, prompt: i ? i.prompt : 1 };
      } else if (x === 'SaveChanges') {
        event({
          kind: 'window', event: 'save', origin, token: y.win, ...y,
        });
      } else if (x === 'SetLineAttributes' && !acting) {
        // The agent's own stops are reported by the stops handler, with the
        // editor's resulting list.
        event({
          kind: 'window', event: 'stops', origin, token: y.win, stops: y.stop,
        });
      }
    };
    const act = (f) => {
      acting = true;
      try { return f(); } finally { acting = false; }
    };

    // cn.js drops most sends while D.ide.promptType is 0, so a request that
    // needs one fails now rather than at its timeout. A handler runs once
    // ide.js has caught up with the tap (handle settles first), so the tap's
    // prompt is D.ide.promptType too. slot: the request is a control request,
    // one at a time. busyAtZero: it sends such a message.
    const blocked = (fail, slot, busyAtZero) => {
      const i = io.ide();
      if (!i || !i.connected) return fail('closed', 'the session is not connected to an interpreter');
      if (slot && inflight) return fail('busy', 'a request is in flight');
      if (busyAtZero && !prompt) return fail('prompt', 'the interpreter is busy', { prompt: 0 });
      return false;
    };
    const exec = (m, ok, fail, prompts) => {
      if (blocked(fail, true, false)) return;
      if (!prompts.includes(prompt)) { fail('prompt', `prompt type is ${prompt}`, { prompt }); return; }
      // exec replaces the queue of lines the person pasted.
      if (io.ide().pending) { fail('busy', 'lines are queued for execution'); return; }
      const text = m.text.replace(/\n$/, '');
      const timeout = ms(m);
      const f = {
        echo: text, lines: [], chars: 0, error: null, truncated: false, echoed: m.req === 'answer', first: seq + 1, last: null, prompt: null,
      };
      const result = () => ({
        echo: f.echo, lines: f.lines, error: f.error, prompt: f.prompt, truncated: f.truncated, seq: [f.first, f.last],
      });
      inflight = { req: m.req, id: m.id };
      // The result is the transcript slice from the line's echo to the prompt
      // that follows it. ⍞ input is not echoed, so an answer's slice starts at
      // the send. The echo carries the session's input indent, so the text
      // comparison ignores leading blanks.
      expect(timeout, (kind, r) => {
        if (kind !== 'event') return false;
        if (!f.echoed) {
          if (r.kind === 'input' && (r.origin === 'agent' || r.text.trimStart() === text.trimStart())) {
            f.echoed = true;
            f.first = r.seq;
            f.echo = r.text;
          }
        } else if (r.kind === 'output' || r.kind === 'error') {
          const line = { ...r };
          ['seq', 't', 'origin'].forEach((k) => { delete line[k]; });
          if (r.kind === 'error') { f.error = { ...line }; delete f.error.kind; }
          if (f.lines.length >= MAX_LINES || f.chars >= MAX_CHARS) f.truncated = true;
          else {
            f.lines.push(line);
            f.chars += (r.text || '').length;
          }
        } else if (r.kind === 'prompt' && r.prompt !== 0) {
          f.prompt = r.prompt;
          f.last = r.seq;
          inflight = null;
          ok(result());
          return true;
        }
        return false;
      }, () => {
        inflight = null;
        f.prompt = prompt;
        fail('timeout', `no prompt within ${timeout} ms`, { partial: result() });
      });
      act(() => io.exec(text));
    };

    const handlers = {
      async status(m, ok) {
        flush();
        const i = io.ide();
        const t = io.transcriptStatus ? await io.transcriptStatus() : null;
        ok({
          caption: i ? i.caption : null,
          prompt: i ? i.prompt : null,
          level,
          version: i ? i.version : null,
          transcript: io.transcript ? io.transcript() : null,
          size: t ? t.size : null,
          rotated: t ? !!t.rotated : null,
          seq,
          connected,
        });
      },
      tail(m, ok) {
        const n = m.n === undefined ? 100 : +m.n;
        ok({ events: n > 0 ? ring.slice(-n) : [] });
      },
      since(m, ok) {
        const s = +m.seq || 0;
        const oldest = ring.length ? ring[0].seq : seq + 1;
        ok({ events: ring.filter((e) => e.seq > s), truncated: oldest > s + 1 });
      },
      windows(m, ok) { ok(io.windows()); },
      window_text(m, ok, fail) {
        const w = io.window(m.token);
        w ? ok(w) : fail('not_found', `no window ${m.token}`);
      },
      execute(m, ok, fail) { exec(m, ok, fail, [1]); },
      answer(m, ok, fail) { exec(m, ok, fail, [2, 4]); },
      interrupt(m, ok, fail) {
        if (blocked(fail, false, false)) return;
        const s = m.strength || 'weak';
        act(() => io.interrupt(s));
        ok({ prompt: io.ide().prompt });
      },
      edit(m, ok, fail) {
        if (blocked(fail, true, true)) return;
        const name = m.name.replace(/\n$/, '').trim();
        const timeout = ms(m);
        inflight = { req: 'edit', id: m.id };
        // A name already open comes back as GotoWindow or UpdateWindow
        // rather than a new OpenWindow.
        expect(timeout, (kind, x, y) => {
          if (kind !== 'recv') return false;
          let token;
          if (x === 'OpenWindow' || x === 'UpdateWindow') token = y.token;
          else if (x === 'GotoWindow') token = y.win;
          if (token === undefined) return false;
          inflight = null;
          ok({ token });
          return true;
        }, () => { inflight = null; fail('timeout', `no window within ${timeout} ms`); });
        act(() => io.edit(name));
      },
      save(m, ok, fail) {
        const w = io.window(m.token);
        if (!w) { fail('not_found', `no window ${m.token}`); return; }
        if (w.kind !== 'editor') { fail('bad_request', 'the window is a tracer; trace with action edit switches it to an editor'); return; }
        if (blocked(fail, true, false)) return;
        const lines = typeof m.text === 'string' ? m.text.replace(/\n$/, '').split('\n') : m.text;
        const timeout = ms(m);
        inflight = { req: 'save', id: m.id };
        const waiter = expect(timeout, (kind, x, y) => {
          if (kind !== 'recv' || x !== 'ReplySaveChanges' || y.win !== m.token) return false;
          inflight = null;
          // The interpreter explains a refusal in its own dialog; the reply
          // carries only the number.
          if (y.err) fail('save', `the interpreter refused the change (err ${y.err})`, { token: m.token, err: y.err });
          else ok({ token: m.token, saved: true });
          return true;
        }, () => { inflight = null; fail('timeout', `no ReplySaveChanges within ${timeout} ms`); });
        // The editor sends nothing when neither text nor stops changed.
        if (!act(() => io.save(m.token, lines, m.stops))) {
          remove(waiter);
          inflight = null;
          ok({ token: m.token, saved: true });
        }
      },
      stops(m, ok, fail) {
        const w = io.window(m.token);
        if (!w) { fail('not_found', `no window ${m.token}`); return; }
        // A tracer's stops go to the interpreter at once; an editor's with its save.
        if (blocked(fail, true, w.kind === 'tracer')) return;
        const stops = act(() => io.stops(m.token, m.lines));
        event({
          kind: 'window', event: 'stops', origin: 'agent', token: m.token, stops,
        });
        ok({ stops });
      },
      trace(m, ok, fail) {
        const w = io.window(m.token);
        if (!w) { fail('not_found', `no window ${m.token}`); return; }
        if (w.kind !== 'tracer') { fail('bad_request', 'the window is an editor, not a tracer'); return; }
        if (blocked(fail, true, true)) return;
        const timeout = ms(m);
        inflight = { req: 'trace', id: m.id };
        expect(timeout, (kind, x, y) => {
          if (kind !== 'recv') return false;
          let r;
          if (x === 'SetHighlightLine' && y.win === m.token) {
            r = {
              highlight: {
                line: y.line, end_line: y.end_line, start_col: y.start_col, end_col: y.end_col,
              },
            };
          } else if (x === 'CloseWindow' && y.win === m.token) r = { closed: true };
          else if (x === 'WindowTypeChanged' && y.win === m.token) r = { kind: y.tracer ? 'tracer' : 'editor' };
          // Every step passes through prompt 0 on its way to the highlight;
          // only a prompt that returns without one is the result.
          else if (x === 'SetPromptType' && y.type !== 0) r = { prompt: y.type };
          if (!r) return false;
          inflight = null;
          ok(r);
          return true;
        }, () => { inflight = null; fail('timeout', `no highlight, close or prompt within ${timeout} ms`); });
        act(() => io.trace(m.token, m.action));
      },
      stack(m, ok, fail) {
        if (blocked(fail, false, true)) return;
        const timeout = ms(m);
        expect(timeout, (kind, x, y) => {
          if (kind !== 'recv' || x !== 'ReplyGetSIStack') return false;
          ok({ ...y });
          return true;
        }, () => fail('timeout', `no ReplyGetSIStack within ${timeout} ms`));
        io.stack();
      },
      value(m, ok, fail) {
        if (blocked(fail, false, true)) return;
        const timeout = ms(m);
        const token = io.value(m.name);
        expect(timeout, (kind, x, y) => {
          if (kind !== 'recv' || x !== 'ValueTip' || y.token !== token) return false;
          ok({ name: m.name, tip: y.tip, class: y.class });
          return true;
        }, () => fail('timeout', `no ValueTip within ${timeout} ms`));
      },
      wait(m, ok, fail) {
        const q = { kinds: typeof m.kinds === 'string' ? [m.kinds] : m.kinds, origin: m.origin, prefix: m.prefix };
        const since = m.since === undefined ? seq : m.since;
        // The event may already have landed.
        const hit = ring.find((e) => e.seq > since && matches(e, q));
        if (hit) { ok(hit); return; }
        const timeout = ms(m);
        expect(timeout, (kind, r) => {
          if (kind !== 'event' || r.seq <= since || !matches(r, q)) return false;
          ok(r);
          return true;
        }, () => fail('timeout', `no matching event within ${timeout} ms`));
      },
    };

    const confirm = (m) => new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), CONFIRM_MS);
      Promise.resolve().then(() => io.confirm(m)).then(
        (r) => { clearTimeout(t); resolve(!!r); },
        () => { clearTimeout(t); resolve(false); },
      );
    });
    // ide.js handles the interpreter's messages from a queue that it runs
    // down on a timer and holds while a window is being built, so D.ide
    // (promptType, wins) lags what the tap saw at D.recv: by the rendering of
    // a large output, or by the opening of a tracer at a stop. A request that
    // reads or drives D.ide waits for the queue to drain, within its timeout:
    // the interpreter is ready, the session is only catching up. The poll is
    // a waiter, so a disconnect drops it along with the request.
    const settle = (deadline) => new Promise((resolve) => {
      const w = { feed: () => false };
      const poll = () => {
        const i = io.ide();
        if (!i || i.quiescent) {
          remove(w);
          resolve(true);
        } else if (Date.now() >= deadline) {
          remove(w);
          resolve(false);
        } else w.timer = setTimeout(poll, SETTLE_MS);
      };
      waiters.push(w);
      poll();
    });
    const handle = async (m) => {
      const { id, req } = m;
      const ok = (r) => { reply(id, { ok: r }); return true; };
      const fail = (code, message, more) => { reply(id, failure(code, message, more)); return true; };
      // Rust checks a Windows client's token before passing frames on.
      if (req === undefined && 'auth' in m) return;
      const spec = REQUESTS[req];
      if (typeof req !== 'string' || !spec) { fail('bad_request', `unknown request ${JSON.stringify(req)}`); return; }
      if (spec.level === 'control' && level !== 'control') { fail('refused', `${req} needs control (Agent ▸ Allow control, or RIDE_AGENT=control)`); return; }
      const why = invalid(m);
      if (why) { fail('bad_request', why); return; }
      if (spec.confirm && io.confirmNeeded && io.confirmNeeded()) {
        if (inflight) { fail('busy', 'a request is in flight'); return; }
        inflight = { req, id, confirming: true };
        const allowed = await confirm(m);
        inflight = null;
        if (!connected) return;
        if (level !== 'control') { fail('refused', `${req} needs control`); return; }
        if (!allowed) { fail('denied', 'the person denied the request'); return; }
      }
      let fields = m;
      if (spec.settle) {
        // A control request holds the slot while it waits, so a second one is
        // busy rather than interleaved.
        if (spec.confirm) {
          if (inflight) { fail('busy', 'a request is in flight'); return; }
          inflight = { req, id, settling: true };
        }
        const timeout = ms(m);
        const deadline = Date.now() + timeout;
        const settled = await settle(deadline);
        if (spec.confirm) inflight = null;
        if (spec.level === 'control' && level !== 'control') { fail('refused', `${req} needs control`); return; }
        if (!settled) { fail('timeout', `the session was still handling the interpreter's messages after ${timeout} ms`); return; }
        // The handler's own wait gets what is left of the timeout.
        fields = { ...m, timeout: Math.max(1, deadline - Date.now()) };
      }
      await handlers[req](fields, ok, fail);
    };
    const frame = (line) => {
      let m;
      try { m = JSON.parse(line); } catch (e) {
        reply(null, failure('bad_request', `not JSON: ${e.message}`));
        return Promise.resolve();
      }
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        reply(null, failure('bad_request', 'a frame is a JSON object'));
        return Promise.resolve();
      }
      return handle(m).catch((e) => reply(m.id, failure('bad_request', `${e}`)));
    };

    const socket = (on) => {
      if (on === connected) return;
      connected = on;
      // Replies to what was pending have nowhere to go.
      if (!on) { waiters.slice().forEach(remove); inflight = null; }
      event({ kind: 'agent', event: on ? 'connected' : 'disconnected' });
    };
    const setLevel = (l) => {
      if (![null, 'observe', 'control'].includes(l)) throw new Error(`agent level ${JSON.stringify(l)}`);
      if (l === level) return level;
      if (l) {
        level = l;
        event({ kind: 'agent', event: 'level', level: l });
      } else {
        // The glue closes the port, which takes the client with it; the
        // transcript shows both before recording stops.
        socket(false);
        event({ kind: 'agent', event: 'level', level: null });
        level = null;
        flush();
      }
      return level;
    };

    return {
      recv,
      sent,
      frame,
      socket,
      setLevel,
      flush,
      level: () => level,
      connected: () => connected,
      seq: () => seq,
    };
  };

  const api = {
    create, REQUESTS, CODES, TRACE_ACTIONS, NAME, matches, RING, MAX_LINES, MAX_CHARS, BATCH, FLUSH_MS, DEFAULT_TIMEOUT, CONFIRM_MS, SETTLE_MS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.agentCore = api;
    if (root.D) root.D.agentCore = api;
  }
}(typeof window !== 'undefined' ? window : {}));
