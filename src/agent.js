// Agent pairing, phase 1 (tauri/agent-pairing.md): the transcript file and
// the agent socket's request frames, in the session window of the Tauri
// build. The tap sees the protocol at D.recv and D.send through accessors
// on D, so it wraps whatever is assigned to them, including the functions
// assigned on connect. Rust (src-tauri/src/agent.rs) only carries lines
// between the socket and this window.
if (window.__RIDE__) {
  (() => {
    // Helper windows load this page too; their traffic reaches the session
    // window through the IPC server, so only the session window taps.
    if (/[?&]type=/.test(window.location.search)) return;
    const lv = `${process.env.RIDE_AGENT || D.prf.agent()}`; // the environment wins
    const level = { 1: 'observe', control: 'control' }[lv];
    if (!level) return;

    const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
    const fs = nodeRequire('fs');
    const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
    const RING = 1000; // events kept for tail and since; the file has the rest
    const MAX_LINES = 200; // an execute result's cap
    const MAX_CHARS = 64 * 1024;
    const ring = [];
    let seq = 0;
    let started = false;
    let transcript = '';
    let connected = false;
    let prompt = 1; // as of the latest SetPromptType seen, ahead of D.ide.promptType
    let last = { origin: 'human', prompt: 1 }; // the line most recently executed
    let sending = false; // while the tap's own exec runs
    let inflight = null; // the execute or answer being collected

    const status = () => {
      I.sb_agent.hidden = false;
      I.sb_agent.innerText = `agent: ${level === 'control' ? 'control' : 'observing'}${connected ? ' (connected)' : ''}`;
    };
    const send = (frame) => {
      connected && invoke('agent_send', { label, line: JSON.stringify(frame) }).catch(() => {});
    };
    const reply = (id, body) => send({ id: id === undefined ? null : id, ...body });

    const finish = (code) => {
      const f = inflight;
      inflight = null;
      clearTimeout(f.timer);
      const result = {
        echo: f.text, lines: f.lines, error: f.error, prompt: f.prompt, truncated: f.truncated, seq: [f.first, f.last],
      };
      if (code) reply(f.id, { err: { code, message: `no prompt within ${f.timeout} ms`, partial: result } });
      else reply(f.id, { ok: result });
    };
    // The result is the transcript slice from the line's echo to the prompt
    // that follows it. ⍞ input is not echoed, so an answer's slice starts at
    // the send.
    const collect = (r) => {
      const f = inflight;
      if (!f.echoed) {
        if (r.kind === 'input' && r.text === f.text) { f.echoed = true; f.first = r.seq; }
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
        finish();
      }
    };
    const ev = (e) => {
      seq += 1;
      const r = { seq, t: new Date().toISOString(), ...e };
      ring.push(r);
      ring.length > RING && ring.shift();
      try { fs.appendFileSync(transcript, `${JSON.stringify(r)}\n`); } catch (x) { console.error('agent transcript:', x); }
      send({ ev: r });
      inflight && collect(r);
    };
    const win = (event, y) => ev({
      kind: 'window', event, token: y.token === undefined ? y.win : y.token, ...y,
    });

    const input = (text) => ev({
      kind: 'input', origin: last.origin, prompt: last.prompt, text: text.replace(/\n$/, ''),
    });
    const recv = (x, y) => {
      switch (x) {
        case 'EchoInput': input(y.input); break;
        // An interpreter with apiVersion 1 sends no EchoInput: the entered
        // line comes back as output of type 14.
        case 'AppendSessionOutput':
          if (y.type === 14) input(y.result);
          else ev({ kind: 'output', origin: last.origin, type: y.type || 0, text: y.result });
          break;
        // The payload's own fields: Dyalog 21.0 sends {error, dmx} with the
        // error number in both.
        case 'HadError': ev({ kind: 'error', origin: last.origin, ...y }); break;
        case 'SetPromptType': prompt = y.type; ev({ kind: 'prompt', prompt: y.type }); break;
        case 'OpenWindow': win('open', y); break;
        case 'UpdateWindow': win('update', y); break;
        case 'CloseWindow': win('close', y); break;
        case 'SetHighlightLine': win('highlight', y); break;
        case 'ReplyGetSIStack': ev({ kind: 'stack', stack: y.stack }); break;
        default:
      }
    };
    const sent = (x, y) => {
      if (x === 'Execute') last = { origin: sending ? 'agent' : 'human', prompt: D.ide ? D.ide.promptType : 1 };
      else if (x === 'SaveChanges') ev({ kind: 'window', event: 'save', origin: 'human', token: y.win, ...y });
    };

    const handle = (m) => {
      const { id, req } = m;
      const fail = (code, message, more) => reply(id, { err: { code, message, ...more } });
      const ide = D.ide;
      switch (req) {
        case 'status': return reply(id, {
          ok: {
            caption: ide ? ide.caption : null,
            prompt: ide ? ide.promptType : null,
            level,
            version: (D.remoteIdentification || {}).version || null,
            transcript,
            seq,
          },
        });
        case 'tail': {
          const n = m.n === undefined ? 100 : +m.n;
          return reply(id, { ok: { events: n > 0 ? ring.slice(-n) : [] } });
        }
        case 'since': {
          const s = +m.seq || 0;
          const oldest = ring.length ? ring[0].seq : seq + 1;
          return reply(id, { ok: { events: ring.filter((e) => e.seq > s), truncated: oldest > s + 1 } });
        }
        case 'execute': case 'answer': case 'interrupt': {
          if (level !== 'control') return fail('refused', `${req} needs RIDE_AGENT=control`);
          if (!ide || !ide.connected) return fail('closed', 'the session is not connected to an interpreter');
          if (req === 'interrupt') {
            const s = m.strength || 'weak';
            if (s !== 'weak' && s !== 'strong') return fail('bad_request', 'strength must be weak or strong');
            D.commands[s === 'weak' ? 'WI' : 'SI']();
            return reply(id, { ok: { prompt: ide.promptType } });
          }
          const text = typeof m.text === 'string' ? m.text.replace(/\n$/, '') : null;
          if (text === null || text.includes('\n')) return fail('bad_request', 'text must be one line');
          if (inflight) return fail('busy', 'a request is in flight');
          // Both views of the prompt must agree: the tap's, so a change already
          // received is not missed, and the IDE's, as cn.js drops an Execute
          // while D.ide.promptType is 0.
          const p = ide.promptType;
          // The tap's prompt is the interpreter's latest; the IDE's lags it by a tick.
          if (!(req === 'execute' ? [1] : [2, 4]).includes(p) || p !== prompt) return fail('prompt', `prompt type is ${prompt}`, { prompt });
          // exec replaces the queue of lines the person pasted.
          if (ide.pending.length) return fail('busy', 'lines are queued for execution');
          const timeout = +m.timeout > 0 ? +m.timeout : 30000;
          inflight = {
            id, text, timeout, lines: [], chars: 0, error: null, truncated: false, echoed: req === 'answer', first: seq + 1, last: null, prompt: null,
          };
          inflight.timer = setTimeout(() => { inflight.prompt = prompt; finish('timeout'); }, timeout);
          sending = true;
          try { ide.exec([text], 0); } finally { sending = false; }
          return undefined;
        }
        default: return fail('bad_request', `unknown request ${JSON.stringify(req)}`);
      }
    };
    const onSocket = (p) => {
      if (p === true || p === null) { connected = p === true; status(); return; }
      if (typeof p !== 'string') return;
      let m;
      try { m = JSON.parse(p); } catch (e) { reply(null, { err: { code: 'bad_request', message: `not JSON: ${e.message}` } }); return; }
      if (!m || typeof m !== 'object') { reply(null, { err: { code: 'bad_request', message: 'a frame is a JSON object' } }); return; }
      try { handle(m); } catch (e) { reply(m.id, { err: { code: 'bad_request', message: `${e}` } }); }
    };

    const start = () => {
      started = true;
      const dir = `${D.el.app.getPath('userData')}/sessions`;
      fs.mkdirSync(dir, { recursive: true });
      transcript = `${dir}/${label}-${D.ipc.config.appspace}.jsonl`;
      status();
      window.__TAURI__.event.listen('ride-agent', ({ payload }) => onSocket(payload), { target: { kind: 'WebviewWindow', label } })
        .then(() => invoke('agent_listen', { label }))
        .catch((e) => console.error('agent socket:', e));
      window.addEventListener('pagehide', () => invoke('agent_close', { label }).catch(() => {}));
    };
    // D.recv is assigned when the IDE is created, D.send when the connect
    // page's module runs; both after this script. The accessor wraps each
    // assignment. The tap starts with the first message from an interpreter.
    const hook = (name, tap, starts) => {
      let f = D[name];
      Object.defineProperty(D, name, {
        configurable: true,
        enumerable: true,
        get() { return f; },
        set(g) {
          f = typeof g !== 'function' ? g : (x, y) => {
            try {
              if (starts && !started && D.ide) start();
              started && tap(x, y);
            } catch (e) { console.error(`agent ${name}:`, e); }
            return g(x, y);
          };
        },
      });
      if (f !== undefined) D[name] = f;
    };
    hook('recv', recv, true);
    hook('send', sent, false);
  })();
}
