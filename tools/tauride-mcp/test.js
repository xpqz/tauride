// Runs the CLI, the MCP server and e2e.js against a fake Tauride that answers with the
// frames of the wire format sections in tauri/agent-pairing.md, so the adapter is known
// to work before the app's side does.  node --test test.js
//
// The fake keeps enough state for the checks to follow one another as they would in a
// session: a prompt type, variables, functions with stop lines, windows, one tracer, and
// a transcript file.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BIN = path.join(__dirname, 'tauride-mcp.js');
const E2E = path.join(__dirname, 'e2e.js');
// Unix socket paths are limited to about 100 bytes, so the fake lives in the system tmp dir.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmcp-'));
const SOCK = path.join(DIR, 'app.sock');
const OBSERVE_SOCK = path.join(DIR, 'observe.sock');
const TRANSCRIPT = path.join(DIR, 'main-1.jsonl');

// HadError as Dyalog 21.0 sends it: numbers only, the text is in the output lines.
const DMX = { error: 11, dmx: 1 };
const VALUE_ERROR = { error: 6, dmx: 1 };
const TRACE_ACTIONS = ['step_into', 'step_over', 'continue', 'continue_trace', 'back', 'forward', 'cutback', 'restart', 'edit'];
const MAX_LINES = 200;
const MAX_CHARS = 64 * 1024;

// --- the fake app -----------------------------------------------------------------------

const state = {
  seq: 0,
  events: [],
  prompt: 1,
  pendingVar: null, // the name a ⎕ prompt assigns to
  vars: {},
  fns: {}, // name → lines
  stops: {}, // name → stop lines the interpreter knows
  wins: {
    7: {
      token: 7, name: 'foo', kind: 'editor', text: ['foo', '⍝ a comment'], currentLine: 0, stops: [], trace: [], monitor: [], saved: true,
    },
  },
  nextToken: 8,
  tracer: null, // {token, name, arg} while a function is suspended
  slow: null, // the execute still running: {timer, timedOut, fixture, finish}
  waits: [], // pending wait requests
};
const clients = new Set(); // the served connections, one per socket

const matches = (w, e) => e.seq > w.since
  && (!w.kinds || w.kinds.includes(e.kind))
  && (!w.origin || e.origin === w.origin)
  && (!w.prefix || (typeof e.text === 'string' && e.text.startsWith(w.prefix)));
const ev = (e) => {
  state.seq += 1;
  const r = { seq: state.seq, t: new Date().toISOString(), ...e };
  state.events.push(r);
  fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(r)}\n`);
  const line = `${JSON.stringify({ ev: r })}\n`;
  clients.forEach((s) => { if (!s.destroyed) s.write(line); });
  state.waits = state.waits.filter((w) => !w.take(r));
  return r;
};
const setPrompt = (p) => { state.prompt = p; ev({ kind: 'prompt', prompt: p }); };
const openWindow = (name, dbg) => {
  const token = state.nextToken;
  state.nextToken += 1;
  const text = state.fns[name] || [name];
  const w = {
    token, name, kind: dbg ? 'tracer' : 'editor', text, currentLine: 0, stops: state.stops[name] || [], trace: [], monitor: [], saved: true,
  };
  state.wins[token] = w;
  ev({
    kind: 'window', event: 'open', token, name, debugger: dbg, text, stop: w.stops,
  });
  return w;
};
const closeWindow = (token) => {
  delete state.wins[token];
  ev({ kind: 'window', event: 'close', token });
};

// A line at the prompt: output through out, an error through fail; returns the prompt
// type afterwards, 0 when the line is still running.
const evaluate = (text, out, fail) => {
  let m;
  if (text === '⍳5') out('1 2 3 4 5');
  else if (text === '1÷0') fail(DMX, ['DOMAIN ERROR: Divide by zero\n', '      1÷0\n', '       ∧\n']);
  else if (text === 'slow') { out('working'); return 0; }
  else if (/⎕DL/.test(text)) { out('tick'); return 0; }
  else if ((m = /^(\d+) (\d+)⍴'(.)'$/.exec(text))) for (let i = 0; i < +m[1]; i += 1) out(m[3].repeat(+m[2]));
  else if ((m = /^(\w+)←⎕$/.exec(text))) { state.pendingVar = m[1]; return 2; }
  else if ((m = /^\)ed (\w+)$/.exec(text))) openWindow(m[1], false);
  else if ((m = /^(\w+) (\d+)$/.exec(text)) && state.fns[m[1]]) {
    const [, name, arg] = m;
    if ((state.stops[name] || []).length) {
      const w = openWindow(name, true);
      [w.currentLine] = state.stops[name];
      state.tracer = { token: w.token, name, arg: +arg };
    } else out(String(2 * +arg));
  } else if ((m = /^(\d+)\+(\d+)$/.exec(text))) out(String(+m[1] + +m[2]));
  else if ((m = /^'(.*)'$/.exec(text))) out(m[1]);
  else if (state.vars[text] !== undefined) out(state.vars[text]);
  else fail(VALUE_ERROR, ['VALUE ERROR\n', `      ${text}\n`, '      ∧\n']);
  return 1;
};

const execute = (f, ok, err) => {
  const isAnswer = f.req === 'answer';
  // A stateless refusal kept from the phase 1 tests.
  if (f.text === 'input') return err('prompt', 'prompt type is 2', { prompt: 2 });
  if (!(isAnswer ? [2, 4] : [1]).includes(state.prompt)) return err('prompt', `prompt type is ${state.prompt}`, { prompt: state.prompt });
  const timeout = f.timeout > 0 ? f.timeout : 30000;
  const r = {
    echo: isAnswer ? f.text : `      ${f.text}`, lines: [], error: null, prompt: null, truncated: false, seq: [state.seq + 1, null],
  };
  let chars = 0;
  const line = (l) => {
    if (r.lines.length >= MAX_LINES || chars >= MAX_CHARS) r.truncated = true;
    else {
      r.lines.push(l);
      chars += (l.text || '').length;
    }
  };
  const out = (text, type = 1) => {
    ev({
      kind: 'output', origin: 'agent', type, text,
    });
    line({ kind: 'output', type, text });
  };
  // The result's error is the HadError payload, as the tap builds it.
  const fail = (dmx, lines) => {
    ev({ kind: 'error', origin: 'agent', ...dmx });
    r.error = dmx;
    line({ kind: 'error', ...dmx });
    lines.forEach((t) => out(t, 5));
  };
  ev({
    kind: 'input', origin: 'agent', prompt: state.prompt, text: f.text,
  });
  setPrompt(0);
  let p;
  if (isAnswer) {
    if (state.pendingVar) state.vars[state.pendingVar] = f.text;
    state.pendingVar = null;
    p = 1;
  } else p = evaluate(f.text, out, fail);
  if (p === 0) {
    const finish = () => {
      setPrompt(1);
      r.prompt = 1;
      r.seq[1] = state.seq;
      ok(r);
    };
    const slow = { fixture: f.text === 'slow', timedOut: false, finish };
    slow.timer = setTimeout(() => {
      slow.timedOut = true;
      r.prompt = 0;
      err('timeout', `no prompt within ${timeout} ms`, { partial: r });
      // The fixture line ends on its own; a ⎕DL line runs until interrupted.
      if (slow.fixture) { state.slow = null; setPrompt(1); }
    }, timeout);
    state.slow = slow;
    return undefined;
  }
  setPrompt(p);
  r.prompt = p;
  r.seq[1] = state.seq;
  return ok(r);
};

const handle = (f, send, level) => {
  const ok = (body) => send({ id: f.id, ok: body });
  const err = (code, message, more) => send({ id: f.id, err: { code, message, ...more } });
  const win = (t) => state.wins[t];
  const control = ['execute', 'answer', 'interrupt', 'edit', 'save', 'stops', 'trace'];
  if (control.includes(f.req) && level !== 'control') return err('refused', `${f.req} needs RIDE_AGENT=control`);
  switch (f.req) {
    case 'status': return ok({
      caption: 'CLEAR WS', prompt: state.prompt, level, version: '21.0', transcript: TRANSCRIPT, size: fs.statSync(TRANSCRIPT).size, seq: state.seq,
    });
    case 'tail': return ok({ events: state.events.slice(-(f.n === undefined ? 100 : f.n)) });
    case 'since': return ok({ events: state.events.filter((e) => e.seq > f.seq) });
    case 'execute':
    case 'answer': return execute(f, ok, err);
    case 'interrupt': {
      const s = f.strength || 'weak';
      if (s !== 'weak' && s !== 'strong') return err('bad_request', 'strength must be weak or strong');
      const was = state.prompt;
      const { slow } = state;
      if (slow && !slow.fixture) {
        clearTimeout(slow.timer);
        state.slow = null;
        setTimeout(() => {
          ev({
            kind: 'error', origin: 'agent', error: 1003, dmx: 1003,
          });
          ev({
            kind: 'output', origin: 'agent', type: 5, text: 'INTERRUPT\n',
          });
          if (slow.timedOut) setPrompt(1); else slow.finish();
        }, 20);
      }
      return ok({ prompt: was });
    }
    case 'windows': return ok(Object.values(state.wins));
    case 'window_text': return win(f.token) ? ok(win(f.token)) : err('not_found', `no window ${f.token}`);
    case 'edit': {
      if (typeof f.name !== 'string' || !f.name) return err('bad_request', 'name must be a string');
      const open = Object.values(state.wins).find((w) => w.name === f.name && w.kind === 'editor');
      return ok({ token: (open || openWindow(f.name, false)).token });
    }
    case 'save': {
      const w = win(f.token);
      if (!w) return err('not_found', `no window ${f.token}`);
      if (typeof f.text !== 'string') return err('bad_request', 'text must be a string');
      if (w.kind === 'tracer') return err('save', 'Cannot save a suspended function');
      w.text = f.text.split('\n');
      w.saved = true;
      if (Array.isArray(f.stops)) w.stops = f.stops;
      state.fns[w.name] = w.text;
      state.stops[w.name] = w.stops;
      ev({
        kind: 'window', event: 'save', origin: 'agent', token: w.token, text: w.text, stop: w.stops,
      });
      return ok({ token: w.token, saved: true });
    }
    case 'stops': {
      const w = win(f.token);
      if (!w) return err('not_found', `no window ${f.token}`);
      if (!Array.isArray(f.lines) || !f.lines.every(Number.isInteger)) return err('bad_request', 'lines must be an array of integers');
      w.stops = [...new Set(f.lines)].sort((a, b) => a - b);
      if (w.kind === 'tracer') { // immediate in a tracer, saved with an editor
        state.stops[w.name] = w.stops;
        ev({
          kind: 'window', event: 'stops', token: w.token, stop: w.stops,
        });
      }
      return ok({ stops: w.stops });
    }
    case 'trace': {
      const w = win(f.token);
      if (!w) return err('not_found', `no window ${f.token}`);
      if (w.kind !== 'tracer' || !state.tracer) return err('bad_request', `window ${f.token} is not a tracer`);
      if (!TRACE_ACTIONS.includes(f.action)) return err('bad_request', `unknown action ${f.action}`);
      const t = state.tracer;
      const highlight = () => {
        ev({
          kind: 'window', event: 'highlight', token: w.token, line: w.currentLine,
        });
        return ok({ highlight: { token: w.token, line: w.currentLine } });
      };
      const finish = (result) => {
        closeWindow(w.token);
        state.tracer = null;
        if (result) {
          setPrompt(0);
          ev({
            kind: 'output', origin: 'agent', type: 1, text: String(2 * t.arg),
          });
          setPrompt(1);
        }
        return ok({ closed: true });
      };
      switch (f.action) {
        case 'continue': case 'continue_trace': return finish(true);
        case 'cutback': case 'restart': return finish(false);
        case 'back': w.currentLine = Math.max(1, w.currentLine - 1); return highlight();
        case 'edit': return highlight();
        default: // step_into, step_over, forward
          w.currentLine += 1;
          return w.currentLine < w.text.length ? highlight() : finish(true);
      }
    }
    case 'stack': return ok({ stack: state.tracer ? [{ description: `${state.tracer.name}[${state.wins[state.tracer.token].currentLine}]` }] : [] });
    case 'value': {
      if (typeof f.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name)) return err('bad_request', 'value takes a name');
      if (state.tracer && f.name === 'n') return ok({ tip: [String(state.tracer.arg)], class: 2 });
      return ok({ tip: state.vars[f.name] === undefined ? [] : [state.vars[f.name]], class: 2 });
    }
    case 'wait': {
      const w = {
        since: f.since === undefined ? state.seq : +f.since, kinds: f.kinds, origin: f.origin, prefix: f.prefix,
      };
      const timeout = f.timeout > 0 ? f.timeout : 300000;
      const hit = state.events.find((e) => matches(w, e));
      if (hit) return ok(hit);
      const entry = {};
      entry.timer = setTimeout(() => {
        state.waits = state.waits.filter((x) => x !== entry);
        err('timeout', `no matching event within ${timeout} ms`);
      }, timeout);
      entry.take = (e) => {
        if (!matches(w, e)) return false;
        clearTimeout(entry.timer);
        ok(e);
        return true;
      };
      state.waits.push(entry);
      // The person types a line soon after the agent starts waiting for one, which is
      // what wait_for_input is for; the line carries the timeout the fake was given.
      // Only this prefix is answered, so a wait for any other times out as asked.
      if (f.origin === 'human' && f.prefix === '⍝ Claude:') {
        setTimeout(() => ev({
          kind: 'input', origin: 'human', prompt: 1, text: `${f.prefix} ${timeout}`,
        }), 50);
      }
      return undefined;
    }
    default: return err('bad_request', `unknown request ${f.req}`);
  }
};

// One connection at a time per socket, like the real one.
const serve = (sockPath, level) => {
  let current = null;
  const server = net.createServer((sock) => {
    if (current) {
      // end(), as the app does: the write half closes but the client's request is still
      // read, so the client's write cannot fail before it has seen the frame.
      sock.end('{"err":{"code":"busy"}}\n');
      return;
    }
    current = sock;
    clients.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => {
      current = null;
      clients.delete(sock);
      ev({ kind: 'agent', event: 'disconnected' });
    });
    // The transcript shows the attach, and the client has an unsolicited event to handle at once.
    ev({ kind: 'agent', event: 'connected', level });
    const send = (frame) => { if (!sock.destroyed) sock.write(`${JSON.stringify(frame)}\n`); };
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.filter(Boolean).forEach((l) => handle(JSON.parse(l), send, level));
    });
  });
  return new Promise((res) => { server.listen(sockPath, () => res(server)); });
};

let servers = [];
before(async () => {
  fs.writeFileSync(TRANSCRIPT, '');
  servers = await Promise.all([serve(SOCK, 'control'), serve(OBSERVE_SOCK, 'observe')]);
});
after(() => {
  state.waits.forEach((w) => clearTimeout(w.timer));
  servers.forEach((s) => s.close());
  fs.rmSync(DIR, { recursive: true, force: true });
});

// --- helpers ----------------------------------------------------------------------------

// Runs the CLI to completion; stdin is the text fed to it, if any.
const run = (args, { env = {}, stdin } = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, TAURIDE_SOCKET: SOCK, ...env },
  });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => resolve({ code, out, err }));
  if (stdin !== undefined) p.stdin.end(stdin);
});
const runJSON = async (args) => {
  const r = await run(args);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};

// Sends JSON-RPC messages to the MCP server and returns its replies once there are n.
const rpc = async (msgs, n, env) => {
  const p = spawn(process.execPath, [BIN, 'mcp'], { env: { ...process.env, TAURIDE_SOCKET: SOCK, ...env } });
  let out = '';
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const replies = new Promise((res) => {
    p.stdout.on('data', (d) => {
      out += d;
      const lines = out.split('\n').filter(Boolean);
      if (lines.length >= n) res(lines.map(JSON.parse));
    });
  });
  p.stdin.write(`${msgs.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('\n')}\n`);
  const got = await replies;
  p.stdin.end();
  const code = await new Promise((res) => { p.on('close', res); });
  assert.equal(code, 0, err);
  assert.equal(err, '');
  return got;
};
const call = (id, name, args) => ({
  jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
});
const content = (m) => JSON.parse(m.result.content[0].text);

const TOOL_NAMES = ['execute', 'answer', 'interrupt', 'tail', 'status', 'windows', 'window_text', 'edit', 'save', 'stops', 'trace', 'stack', 'value', 'wait_for_input'];

// --- phase 1 ----------------------------------------------------------------------------

test('status prints the status object', async () => {
  const s = await runJSON(['status']);
  assert.equal(s.caption, 'CLEAR WS');
  assert.equal(s.level, 'control');
  assert.equal(s.version, '21.0');
  assert.equal(s.prompt, 1);
  assert.equal(s.transcript, TRANSCRIPT);
  assert.ok(s.seq > 0);
});

test('exec prints the echo and the lines', async () => {
  const r = await run(['exec', '⍳5']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '      ⍳5\n1 2 3 4 5\n');
  assert.equal(r.err, '');
});

test('exec exits 1 on an APL error; the error text is in the lines, nothing more on stderr', async () => {
  const r = await run(['exec', '1÷0']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '      1÷0\nDOMAIN ERROR: Divide by zero\n      1÷0\n       ∧\n');
  assert.equal(r.err, '');
});

test('exec prints the partial result on a timeout and exits 2', async () => {
  const r = await run(['--timeout', '500', 'exec', 'slow']);
  assert.equal(r.code, 2);
  assert.equal(r.out, '      slow\nworking\n');
  assert.equal(r.err, 'tauride-mcp: no prompt within 500 ms\n');
});

test('exec at an input prompt is refused', async () => {
  const r = await run(['exec', 'input']);
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /prompt type is 2/);
});

test('interrupt says which strength it sent', async () => {
  assert.deepEqual(await runJSON(['interrupt']), { strength: 'weak', prompt: 1 });
  assert.deepEqual(await runJSON(['interrupt', 'strong']), { strength: 'strong', prompt: 1 });
  assert.equal((await run(['interrupt', 'medium'])).code, 2);
});

test('tail prints one event per line', async () => {
  const r = await run(['tail', '2']);
  assert.equal(r.code, 0, r.err);
  const evs = r.out.trim().split('\n').map(JSON.parse);
  assert.equal(evs.length, 2);
  assert.ok(evs[0].seq < evs[1].seq);
  evs.forEach((e) => { assert.equal(typeof e.kind, 'string'); assert.equal(typeof e.t, 'string'); });
});

test('usage errors exit 2 without connecting', async () => {
  const r = await run(['exec'], { env: { TAURIDE_SOCKET: '/nonexistent/x.sock' } });
  assert.equal(r.code, 2);
  assert.match(r.err, /exec needs <text>/);
  assert.match(r.err, /usage:/);
});

test('a missing socket is reported with its path', async () => {
  const r = await run(['status'], { env: { TAURIDE_SOCKET: '/nonexistent/x.sock' } });
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot connect to \/nonexistent\/x\.sock: no such socket/);
});

test('watch prints events as they arrive; a second connection is busy', async () => {
  const w = spawn(process.execPath, [BIN, 'watch'], { env: { ...process.env, TAURIDE_SOCKET: SOCK } });
  let out = '';
  await new Promise((res) => { w.stdout.on('data', (d) => { out += d; if (out.includes('\n')) res(); }); });
  const first = JSON.parse(out.split('\n')[0]);
  assert.equal(first.kind, 'agent');
  assert.equal(first.event, 'connected');
  const r = await run(['status']);
  assert.equal(r.code, 2);
  assert.match(r.err, /another client is connected/);
  w.kill('SIGINT');
  await new Promise((res) => { w.on('close', res); });
});

test('control requests are refused at observe level', async () => {
  const env = { TAURIDE_SOCKET: OBSERVE_SOCK };
  const s = await run(['status'], { env });
  assert.equal(JSON.parse(s.out).level, 'observe');
  const r = await run(['exec', '⍳5'], { env });
  assert.equal(r.code, 2);
  assert.match(r.err, /needs RIDE_AGENT=control/);
  assert.equal((await run(['tail', '1'], { env })).code, 0);
});

// --- phases 2 and 3: the CLI --------------------------------------------------------------

test('windows prints one window per line; window-text one window', async () => {
  const r = await run(['windows']);
  assert.equal(r.code, 0, r.err);
  const ws = r.out.trim().split('\n').map(JSON.parse);
  const foo = ws.find((w) => w.token === 7);
  assert.equal(foo.name, 'foo');
  assert.equal(foo.kind, 'editor');
  const w = await runJSON(['window-text', '7']);
  assert.deepEqual(w.text, ['foo', '⍝ a comment']);
  const nf = await run(['window-text', '999']);
  assert.equal(nf.code, 2);
  assert.match(nf.err, /no window 999/);
  assert.match((await run(['window-text', 'x'])).err, /needs a window token/);
});

test('edit opens an editor and prints its token', async () => {
  const { token } = await runJSON(['edit', 'bar']);
  assert.ok(Number.isInteger(token));
  const w = await runJSON(['window-text', `${token}`]);
  assert.equal(w.name, 'bar');
  assert.equal(w.kind, 'editor');
  assert.deepEqual(w.text, ['bar']);
  assert.match((await run(['edit'])).err, /edit needs <name>/);
});

test('save takes the text itself or a file, without a final newline', async () => {
  assert.deepEqual(await runJSON(['save', '7', 'foo\n⍝ changed']), { token: 7, saved: true });
  assert.deepEqual((await runJSON(['window-text', '7'])).text, ['foo', '⍝ changed']);
  const file = path.join(DIR, 'foo.aplf');
  fs.writeFileSync(file, 'foo\n⍝ from a file\n');
  assert.deepEqual(await runJSON(['save', '7', file]), { token: 7, saved: true });
  assert.deepEqual((await runJSON(['window-text', '7'])).text, ['foo', '⍝ from a file']);
  assert.match((await run(['save', '7'])).err, /save needs <token> <file-or-text>/);
  const nf = await run(['save', '999', 'x']);
  assert.equal(nf.code, 2);
  assert.match(nf.err, /no window 999/);
});

test('stops sets the stop list', async () => {
  assert.deepEqual(await runJSON(['stops', '7', '2', '1']), { stops: [1, 2] });
  assert.deepEqual(await runJSON(['stops', '7']), { stops: [] });
  assert.match((await run(['stops', '7', 'a'])).err, /stops takes line numbers/);
});

test('trace, stack and value follow a suspended function', async () => {
  const { token } = await runJSON(['edit', 'g']);
  await runJSON(['save', `${token}`, 'r←g n\nr←2×n\nr←r+0']);
  assert.deepEqual(await runJSON(['stops', `${token}`, '1']), { stops: [1] });
  await runJSON(['save', `${token}`, 'r←g n\nr←2×n\nr←r+0']); // stops on an editor reach the interpreter with the save
  const r = await run(['exec', 'g 5']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '      g 5\n'); // suspended: no result yet
  const ws = (await run(['windows'])).out.trim().split('\n').map(JSON.parse);
  const tr = ws.find((w) => w.kind === 'tracer');
  assert.equal(tr.name, 'g');
  assert.equal(tr.currentLine, 1);
  assert.deepEqual(await runJSON(['stack']), { stack: [{ description: 'g[1]' }] });
  assert.equal((await run(['value', 'n'])).out, '5\n');
  assert.deepEqual(await runJSON(['trace', `${tr.token}`, 'step_over']), { highlight: { token: tr.token, line: 2 } });
  assert.deepEqual(await runJSON(['stack']), { stack: [{ description: 'g[2]' }] });
  assert.deepEqual(await runJSON(['trace', `${tr.token}`, 'continue']), { closed: true });
  assert.deepEqual(await runJSON(['stack']), { stack: [] });
  // Each CLI run adds its own agent connected/disconnected events, so look back a little.
  const tail = (await run(['tail', '10'])).out.trim().split('\n').map(JSON.parse);
  assert.equal(tail.find((e) => e.kind === 'output').text, '10');
  assert.equal((await run(['trace', '7', 'step_over'])).code, 2); // an editor
  assert.match((await run(['trace', '7', 'jump'])).err, /trace takes one of step_into/);
  assert.match((await run(['value', '1+1'])).err, /value takes a name/);
});

test('wait prints the matching event or times out', async () => {
  const r = await run(['--timeout', '2000', 'wait', '--prefix', '⍝ Claude:', '--origin', 'human']);
  assert.equal(r.code, 0, r.err);
  const e = JSON.parse(r.out);
  assert.equal(e.kind, 'input');
  assert.equal(e.origin, 'human');
  assert.equal(e.text, '⍝ Claude: 2000');
  const first = JSON.parse((await run(['wait', '--since', '0', '--origin', 'agent'])).out);
  assert.equal(first.origin, 'agent');
  assert.equal(first.kind, 'input');
  const t = await run(['--timeout', '200', 'wait', '--prefix', 'nope']);
  assert.equal(t.code, 2);
  assert.match(t.err, /no matching event within 200 ms/);
  assert.match((await run(['wait', '--bogus'])).err, /wait does not take --bogus/);
  assert.match((await run(['wait', '--origin', 'robot'])).err, /--origin takes human or agent/);
});

// --- MCP ---------------------------------------------------------------------------------

test('mcp answers initialize, ping and tools/list; notifications get no reply', async () => {
  const [init, ping, list] = await rpc([
    {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'p', method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ], 3);
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, 'tauride');
  assert.deepEqual(ping, { jsonrpc: '2.0', id: 'p', result: {} });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOL_NAMES);
  list.result.tools.forEach((t) => {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 40, `${t.name} says when to use it`);
  });
  const wfi = list.result.tools.find((t) => t.name === 'wait_for_input');
  assert.match(wfi.description, /⍝ Claude:/);
  assert.deepEqual(Object.keys(wfi.inputSchema.properties), ['prefix', 'since', 'timeout']);
});

test('mcp tools/call returns text content, isError on APL and app errors', async () => {
  // The slow line's reply comes after the quick ones that follow it, so match by id.
  const got = await rpc([
    call(1, 'execute', { text: '⍳5' }),
    call(2, 'execute', { text: '1÷0' }),
    call(3, 'execute', { text: 'slow', timeout: 100 }),
    call(4, 'status', {}),
    call(5, 'tail', { n: 1 }),
    call(6, 'interrupt', {}),
  ], 6);
  const [a, b, c, d, e, f] = [1, 2, 3, 4, 5, 6].map((id) => got.find((m) => m.id === id));
  assert.equal(a.result.isError, false);
  assert.equal(content(a).lines[0].text, '1 2 3 4 5');
  assert.equal(b.result.isError, true);
  assert.deepEqual(content(b).error, DMX);
  assert.equal(c.result.isError, true);
  assert.equal(content(c).code, 'timeout');
  assert.equal(content(c).partial.lines[0].text, 'working');
  assert.equal(content(d).level, 'control');
  assert.equal(typeof content(e).seq, 'number');
  assert.equal(content(f).strength, 'weak');
  assert.equal(typeof content(f).prompt, 'number');
});

test('mcp window tools: windows, window_text, edit, save, stops, trace, stack, value', async () => {
  const [ws, wt, ed, nf] = await rpc([
    call(1, 'windows', {}),
    call(2, 'window_text', { token: 7 }),
    call(3, 'edit', { name: 'h' }),
    call(4, 'window_text', { token: 999 }),
  ], 4);
  assert.ok(content(ws).some((w) => w.token === 7 && w.kind === 'editor'));
  assert.equal(content(wt).name, 'foo');
  const { token } = content(ed);
  assert.ok(Number.isInteger(token));
  assert.equal(nf.result.isError, true);
  assert.equal(content(nf).code, 'not_found');
  const [sv, st, ex] = await rpc([
    call(1, 'save', { token, text: 'r←h n\nr←2×n\nr←r+0', stops: [1] }),
    call(2, 'stops', { token, lines: [1] }),
    call(3, 'execute', { text: 'h 7' }),
  ], 3);
  assert.deepEqual(content(sv), { token, saved: true });
  assert.deepEqual(content(st), { stops: [1] });
  assert.equal(content(ex).prompt, 1);
  const [ws2, stack] = await rpc([call(1, 'windows', {}), call(2, 'stack', {})], 2);
  const tr = content(ws2).find((w) => w.kind === 'tracer');
  assert.equal(tr.name, 'h');
  assert.deepEqual(content(stack), { stack: [{ description: 'h[1]' }] });
  const [v, so, co] = await rpc([
    call(1, 'value', { name: 'n' }),
    call(2, 'trace', { token: tr.token, action: 'step_over' }),
    call(3, 'trace', { token: tr.token, action: 'continue' }),
  ], 3);
  assert.equal(v.result.content[0].text, '7');
  assert.deepEqual(content(so), { highlight: { token: tr.token, line: 2 } });
  assert.deepEqual(content(co), { closed: true });
});

test('mcp wait_for_input waits for a human line with the prefix, default timeout 300000', async () => {
  const [w, t] = await rpc([
    call(1, 'wait_for_input', { prefix: '⍝ Claude:' }),
    call(2, 'wait_for_input', { prefix: '⍝ never:', timeout: 150 }),
  ], 2);
  assert.equal(w.result.isError, false);
  const e = content(w);
  assert.equal(e.kind, 'input');
  assert.equal(e.origin, 'human');
  assert.equal(e.text, '⍝ Claude: 300000');
  assert.equal(t.result.isError, true);
  assert.equal(content(t).code, 'timeout');
  assert.match(content(t).message, /150 ms/);
});

test('mcp protocol errors: unknown method, unknown tool, parse error', async () => {
  // Replies may come back in any order (the parse error needs no await), so match by id.
  const got = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'resources/list' },
    call(2, 'frobnicate', {}),
    '{not json', // sent as the raw line
  ], 3);
  const by = (id) => got.find((m) => m.id === id);
  assert.equal(by(1).error.code, -32601);
  assert.equal(by(2).error.code, -32602);
  assert.equal(by(null).error.code, -32700);
});

test('mcp without the app: tools/list works, tools/call is an isError result', async () => {
  const [list, c] = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    call(2, 'status', {}),
  ], 2, { TAURIDE_SOCKET: '/nonexistent/x.sock' });
  assert.equal(list.result.tools.length, TOOL_NAMES.length);
  assert.equal(c.result.isError, true);
  assert.match(c.result.content[0].text, /cannot connect to \/nonexistent\/x\.sock/);
});

// --- e2e.js against the fake --------------------------------------------------------------

// Last: the run leaves the fake with its own functions and windows. The parts that need
// the app (the launch, the CLI's socket resolution, the second launch) are SKIP lines.
test('e2e.js runs its socket checks and exits with the failure count', async () => {
  const p = spawn(process.execPath, [E2E], { env: { ...process.env, E2E_SOCKET: SOCK, TAURIDE_BIN: '' } });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((res) => { p.on('close', res); });
  const lines = out.trim().split('\n');
  const fails = lines.filter((l) => l.startsWith('FAIL '));
  assert.equal(code, fails.length, `${out}\n${err}`);
  assert.equal(fails.length, 0, out);
  assert.equal(err, '');
  lines.forEach((l) => assert.match(l, /^(PASS|FAIL|SKIP) .+: |^e2e: /));
  ['status', 'execute ⍳5', 'execute: 300 lines are truncated', 'interrupt brings the prompt back', 'second connection is busy',
    'save a function', 'execute suspends at the stop; windows shows the tracer', 'trace continue closes the tracer',
    'wait resolves on the next event', 'transcript parses with monotonic seqs'].forEach((name) => {
    assert.ok(lines.some((l) => l.startsWith(`PASS ${name}:`)), `PASS ${name}`);
  });
  assert.ok(lines.some((l) => l.startsWith('SKIP second launch')));
  assert.equal(lines[lines.length - 1], 'e2e: 0 failures');
});
