// node --test test/agent_core.js
// The pure part of the agent tap (src/agent_core.js) over a fake session:
// the test feeds protocol messages and socket frames and reads what the core
// sent to the client, handed to the transcript and asked the IDE to do.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/agent_core');

const fake = (over) => {
  const io = {
    frames: [], // to the client
    appended: [], // transcript batches
    calls: [], // IDE actions asked for
    wins: {}, // token -> the wire shape of a window
    ideState: {
      connected: true, prompt: 1, pending: 0, caption: 'Dyalog', version: '21.0',
    },
    send(f) { io.frames.push(f); },
    append(lines) { io.appended.push(lines); },
    transcript: () => '/tmp/main-ride_1.jsonl',
    transcriptStatus: async () => ({ size: 42, rotated: false }),
    ide: () => io.ideState,
    // D.ide.exec sends Execute at once, which the tap sees through D.send.
    exec(text) { io.calls.push(['exec', text]); io.core.sent('Execute', { trace: 0, text: `${text}\n` }); },
    interrupt(s) { io.calls.push(['interrupt', s]); },
    windows: () => Object.values(io.wins),
    window: (t) => io.wins[t] || null,
    edit(name) { io.calls.push(['edit', name]); },
    save(token, lines, stops) {
      io.calls.push(['save', token, lines, stops]);
      io.core.sent('SaveChanges', { win: token, text: lines, stop: stops || [] });
      return true;
    },
    stops(token, lines) { io.calls.push(['stops', token, lines]); return [...lines].sort((a, b) => a - b); },
    trace(token, action) { io.calls.push(['trace', token, action]); },
    stack() { io.calls.push(['stack']); },
    value(name) { io.calls.push(['value', name]); return 7; },
    confirmNeeded: () => false,
    confirm: async () => true,
    now: () => '2026-10-09T10:21:03.412Z',
    ...over,
  };
  return io;
};
// A connected client at the given level; the connect and level events are
// dropped so a test sees only what it caused.
const setup = (t, level, over) => {
  const io = fake(over);
  const c = core.create(io);
  io.core = c;
  c.setLevel(level || 'control');
  c.socket(true);
  io.frames.length = 0;
  t.after(() => { c.setLevel(null); c.flush(); });
  return { io, c };
};
const req = (c, m) => c.frame(JSON.stringify(m));
const replies = (io) => io.frames.filter((f) => 'id' in f);
const last = (io) => replies(io).at(-1);
const events = (io) => io.frames.filter((f) => f.ev).map((f) => f.ev);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
// f over each x in turn, each awaited before the next.
const sequence = (xs, f) => xs.reduce((p, x) => p.then(() => f(x)), Promise.resolve());
// A session line as Dyalog 21.0 sends it: busy, the type-14 echo, output, ready.
const echo = (c, text) => c.recv('AppendSessionOutput', { type: 14, result: `${text}\n` });
const out = (c, text) => c.recv('AppendSessionOutput', { type: 1, result: text });
const prompt = (c, type) => c.recv('SetPromptType', { type });
const run = (c, text, outputs, p = 1) => {
  prompt(c, 0);
  echo(c, text);
  outputs.forEach((o) => out(c, o));
  prompt(c, p);
};
const editor = (token, kind = 'editor') => ({
  token, name: 'foo', kind, text: ['foo', ' 1'], currentLine: 0, stops: [], trace: [], monitor: [], saved: true,
});

test('a frame is a JSON object with a known req', async (t) => {
  const { io, c } = setup(t);
  await c.frame('nope');
  assert.equal(last(io).id, null);
  assert.equal(last(io).err.code, 'bad_request');
  await c.frame('[1, 2]');
  assert.equal(last(io).err.code, 'bad_request');
  await req(c, { id: 1, req: 'bogus' });
  assert.equal(last(io).id, 1);
  assert.equal(last(io).err.code, 'bad_request');
  await req(c, { id: 2 });
  assert.equal(last(io).err.code, 'bad_request');
  // Rust checks the Windows token; the core lets the frame pass.
  const n = replies(io).length;
  await req(c, { auth: 'abc' });
  assert.equal(replies(io).length, n);
});

test('fields are validated before anything runs', async (t) => {
  const { io, c } = setup(t);
  const bad = async (m) => {
    await req(c, { id: 9, ...m });
    assert.equal(last(io).err.code, 'bad_request', JSON.stringify(m));
    assert.equal(last(io).id, 9);
  };
  await bad({ req: 'execute', text: 'a\nb' });
  await bad({ req: 'execute', text: 5 });
  await bad({ req: 'execute', text: 'a', timeout: -1 });
  await bad({ req: 'interrupt', strength: 'hard' });
  await bad({ req: 'tail', n: 'x' });
  await bad({ req: 'since', seq: 'x' });
  await bad({ req: 'edit', name: ' ' });
  await bad({ req: 'value', name: '1+2' });
  await bad({ req: 'value', name: 'foo bar' });
  await bad({ req: 'window_text', token: 'x' });
  await bad({ req: 'save', token: 1, text: 5 });
  await bad({
    req: 'save', token: 1, text: 'x', stops: ['a'],
  });
  await bad({ req: 'stops', token: 1, lines: [1.5] });
  await bad({ req: 'trace', token: 1, action: 'fly' });
  await bad({ req: 'wait', kinds: 5 });
  await bad({ req: 'wait', since: 'x' });
  assert.deepEqual(io.calls, []);
  // Names value accepts.
  ['foo', 'a.b', '⎕IO', '#.foo', '##.x', '⎕SE.y', '∆x_1'].forEach((n) => assert.ok(core.NAME.test(n), n));
  ['1+2', 'a b', '⍳5', '', 'a.'].forEach((n) => assert.ok(!core.NAME.test(n), n));
});

test('the request table and the error codes match the design', () => {
  const at = (l) => Object.keys(core.REQUESTS).filter((k) => core.REQUESTS[k].level === l).sort();
  assert.deepEqual(at('observe'), ['since', 'stack', 'status', 'tail', 'value', 'wait', 'window_text', 'windows']);
  assert.deepEqual(at('control'), ['answer', 'edit', 'execute', 'interrupt', 'save', 'stops', 'trace']);
  assert.equal(core.REQUESTS.interrupt.confirm, false);
  at('control').filter((k) => k !== 'interrupt').forEach((k) => assert.equal(core.REQUESTS[k].confirm, true, k));
  ['refused', 'prompt', 'busy', 'timeout', 'closed', 'bad_request', 'not_found', 'save', 'denied', 'unauthorized']
    .forEach((code) => assert.ok(core.CODES.includes(code), code));
  assert.deepEqual(core.TRACE_ACTIONS, ['step_into', 'step_over', 'continue', 'continue_trace', 'back', 'forward', 'cutback', 'restart', 'edit']);
});

test('control requests are refused at observe, and follow the level at once', async (t) => {
  const { io, c } = setup(t, 'observe');
  io.wins[7] = editor(7);
  const control = [
    { req: 'execute', text: '⍳5' }, { req: 'answer', text: 'x' }, { req: 'interrupt' }, { req: 'edit', name: 'foo' },
    { req: 'save', token: 7, text: 'x' }, { req: 'stops', token: 7, lines: [1] }, { req: 'trace', token: 7, action: 'step_into' },
  ];
  await sequence(control, async (m) => {
    await req(c, { id: 1, ...m });
    assert.equal(last(io).err.code, 'refused', m.req);
  });
  assert.deepEqual(io.calls, []);
  await req(c, { id: 2, req: 'windows' });
  assert.deepEqual(last(io).ok, [editor(7)]);

  assert.equal(c.setLevel('control'), 'control');
  assert.deepEqual(events(io).at(-1), {
    seq: 3, t: io.now(), kind: 'agent', event: 'level', level: 'control',
  });
  await req(c, { id: 3, req: 'interrupt', strength: 'strong' });
  assert.deepEqual(last(io).ok, { prompt: 1 });
  assert.deepEqual(io.calls, [['interrupt', 'strong']]);

  c.setLevel('observe');
  await req(c, { id: 4, req: 'interrupt' });
  assert.equal(last(io).err.code, 'refused');
  assert.throws(() => c.setLevel('bogus'));
  assert.equal(c.level(), 'observe');
});

test('closing the port drops the client and stops recording, but the prompt is still followed', async (t) => {
  const { io, c } = setup(t);
  // A long poll is dropped with the client: no reply, and no timer left behind.
  await req(c, {
    id: 1, req: 'wait', kinds: 'input', timeout: 60000,
  });
  c.setLevel(null);
  assert.equal(c.level(), null);
  assert.equal(c.connected(), false);
  // Both are in the transcript (flushed as recording stops); the client is gone.
  const ev = io.appended.at(-1).slice(-2).map((l) => JSON.parse(l));
  assert.deepEqual(ev.map((e) => [e.kind, e.event, e.level]), [['agent', 'disconnected', undefined], ['agent', 'level', null]]);
  const n = io.frames.length;
  const s = c.seq();
  echo(c, '⍳5');
  prompt(c, 2);
  assert.equal(c.seq(), s, 'nothing is recorded while closed');
  assert.equal(io.frames.length, n);

  c.setLevel('control');
  c.socket(true);
  io.ideState.prompt = 2;
  await req(c, { id: 2, req: 'execute', text: '⍳5' });
  assert.equal(last(io).err.code, 'prompt');
  assert.equal(last(io).err.prompt, 2);
});

test('execute collects the slice from its echo to the prompt', async (t) => {
  const { io, c } = setup(t);
  out(c, 'earlier output');
  await req(c, { id: 1, req: 'execute', text: '⍳5' });
  assert.deepEqual(io.calls, [['exec', '⍳5']]);
  assert.equal(replies(io).length, 0, 'no reply before the prompt returns');
  const first = c.seq() + 2; // the busy prompt, then the echo
  run(c, '⍳5', ['1 2 3 4 5']);
  const r = last(io);
  assert.equal(r.id, 1);
  assert.deepEqual(r.ok, {
    echo: '⍳5', lines: [{ kind: 'output', type: 1, text: '1 2 3 4 5' }], error: null, prompt: 1, truncated: false, seq: [first, c.seq()],
  });
  const input = events(io).find((e) => e.kind === 'input');
  assert.equal(input.origin, 'agent');
  assert.equal(input.prompt, 1);
  assert.equal(input.text, '⍳5');
  assert.equal(events(io).find((e) => e.kind === 'output' && e.text === '1 2 3 4 5').origin, 'agent');
  // The slot is free again.
  await req(c, { id: 2, req: 'execute', text: '1' });
  assert.equal(replies(io).length, 1);
});

test('the echo is matched by text when its origin is not known, ignoring the session indent', async (t) => {
  const { io, c } = setup(t, 'control', {
    exec(text) { io.calls.push(['exec', text]); }, // no Execute seen by the tap
  });
  await req(c, { id: 1, req: 'execute', text: '⍳3' });
  echo(c, '      1+1'); // not ours
  out(c, '2');
  echo(c, '      ⍳3');
  out(c, '1 2 3');
  prompt(c, 1);
  const r = last(io).ok;
  assert.equal(r.echo, '      ⍳3');
  assert.deepEqual(r.lines.map((l) => l.text), ['1 2 3']);
});

test('an error in the slice is the result\'s error', async (t) => {
  const { io, c } = setup(t);
  await req(c, { id: 1, req: 'execute', text: 'foo' });
  prompt(c, 0);
  echo(c, 'foo');
  out(c, 'VALUE ERROR: Undefined name: foo');
  c.recv('HadError', { error: 6, dmx: { Message: 'Undefined name: foo' } });
  prompt(c, 1);
  const r = last(io).ok;
  assert.deepEqual(r.error, { error: 6, dmx: { Message: 'Undefined name: foo' } });
  assert.deepEqual(r.lines.map((l) => l.kind), ['output', 'error']);
  assert.equal(events(io).find((e) => e.kind === 'error').origin, 'agent');
});

test('a result is capped at 200 lines', async (t) => {
  const { io, c } = setup(t);
  await req(c, { id: 1, req: 'execute', text: '⍳300' });
  run(c, '⍳300', Array.from({ length: 205 }, (_, i) => `${i}`));
  const r = last(io).ok;
  assert.equal(r.lines.length, core.MAX_LINES);
  assert.equal(r.lines.at(-1).text, '199');
  assert.equal(r.truncated, true);
  assert.equal(events(io).filter((e) => e.kind === 'output').length, 205, 'the rest is in the transcript');
});

test('a result is capped at 64 KB', async (t) => {
  const { io, c } = setup(t);
  await req(c, { id: 1, req: 'execute', text: 'x' });
  const line = 'y'.repeat(1000);
  run(c, 'x', Array.from({ length: 70 }, () => line));
  const r = last(io).ok;
  assert.equal(r.truncated, true);
  const chars = r.lines.reduce((n, l) => n + l.text.length, 0);
  assert.ok(chars >= core.MAX_CHARS && chars < core.MAX_CHARS + line.length, `${chars} chars`);
});

test('a timeout carries the partial result and frees the slot', async (t) => {
  const { io, c } = setup(t);
  await req(c, {
    id: 1, req: 'execute', text: '⍳5', timeout: 20,
  });
  prompt(c, 0);
  echo(c, '⍳5');
  out(c, '1 2');
  await req(c, { id: 2, req: 'execute', text: '1' });
  assert.equal(last(io).err.code, 'busy');
  await sleep(40);
  const r = replies(io).find((f) => f.id === 1);
  assert.equal(r.err.code, 'timeout');
  assert.deepEqual(r.err.partial.lines, [{ kind: 'output', type: 1, text: '1 2' }]);
  assert.equal(r.err.partial.prompt, 0);
  assert.equal(r.err.partial.echo, '⍳5');
  // Free again, and the prompt is still 0.
  await req(c, { id: 3, req: 'execute', text: '1' });
  assert.equal(last(io).err.code, 'prompt');
  assert.equal(last(io).err.prompt, 0);
  prompt(c, 1);
  await req(c, { id: 4, req: 'execute', text: '1' });
  assert.equal(replies(io).length, 3);
});

test('execute needs prompt 1 and answer prompt 2 or 4, in both views of the prompt', async (t) => {
  const { io, c } = setup(t);
  prompt(c, 2);
  io.ideState.prompt = 2;
  await req(c, { id: 1, req: 'execute', text: '5' });
  assert.equal(last(io).err.code, 'prompt');
  await req(c, { id: 2, req: 'answer', text: '5' });
  assert.deepEqual(io.calls, [['exec', '5']]);
  // ⎕ input is echoed like a line; the slice starts at the send either way.
  out(c, 'got 5');
  prompt(c, 1);
  assert.deepEqual(last(io).ok.lines, [{ kind: 'output', type: 1, text: 'got 5' }]);
  assert.equal(last(io).ok.echo, '5');
  assert.equal(last(io).ok.prompt, 1);
  io.ideState.prompt = 1;
  await req(c, { id: 3, req: 'answer', text: '5' });
  assert.equal(last(io).err.code, 'prompt');
  // The IDE lags the tap by a tick: both must agree.
  prompt(c, 0);
  await req(c, { id: 4, req: 'execute', text: '5' });
  assert.equal(last(io).err.code, 'prompt');
  assert.equal(last(io).err.prompt, 0);
});

test('queued lines are busy and a dead session is closed', async (t) => {
  const { io, c } = setup(t);
  io.ideState.pending = 2;
  await req(c, { id: 1, req: 'execute', text: '1' });
  assert.equal(last(io).err.code, 'busy');
  io.ideState.pending = 0;
  io.ideState.connected = false;
  await req(c, { id: 2, req: 'execute', text: '1' });
  assert.equal(last(io).err.code, 'closed');
  await req(c, { id: 3, req: 'interrupt' });
  assert.equal(last(io).err.code, 'closed');
  await req(c, { id: 4, req: 'stack' });
  assert.equal(last(io).err.code, 'closed');
  assert.deepEqual(io.calls, []);
});

test('the ring keeps the last 1000 events; since says when older ones are gone', async (t) => {
  const { io, c } = setup(t);
  const base = c.seq();
  for (let i = 0; i < 1005; i++) out(c, `${i}`);
  assert.equal(c.seq(), base + 1005);
  await req(c, { id: 1, req: 'tail', n: 5000 });
  assert.equal(last(io).ok.events.length, core.RING);
  await req(c, { id: 2, req: 'tail' });
  assert.equal(last(io).ok.events.length, 100);
  await req(c, { id: 3, req: 'tail', n: 3 });
  assert.deepEqual(last(io).ok.events.map((e) => e.seq), [c.seq() - 2, c.seq() - 1, c.seq()]);
  await req(c, { id: 4, req: 'since', seq: 0 });
  assert.equal(last(io).ok.events.length, core.RING);
  assert.equal(last(io).ok.truncated, true);
  await req(c, { id: 5, req: 'since', seq: c.seq() - 5 });
  assert.equal(last(io).ok.events.length, 5);
  assert.equal(last(io).ok.truncated, false);
  await req(c, { id: 6, req: 'since', seq: c.seq() });
  assert.deepEqual(last(io).ok, { events: [], truncated: false });
});

test('events reach the transcript in batches of 200, or after 100 ms', async (t) => {
  const { io, c } = setup(t);
  const already = c.seq(); // the level and connect events
  for (let i = 0; i < core.BATCH - already; i++) out(c, 'x');
  assert.equal(io.appended.length, 1);
  assert.equal(io.appended[0].length, core.BATCH);
  const lines = io.appended[0].map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.seq), Array.from({ length: core.BATCH }, (_, i) => i + 1));
  assert.deepEqual(lines[0], {
    seq: 1, t: io.now(), kind: 'agent', event: 'level', level: 'control',
  });
  out(c, 'late');
  assert.equal(io.appended.length, 1);
  await sleep(core.FLUSH_MS + 50);
  assert.equal(io.appended.length, 2);
  assert.equal(JSON.parse(io.appended[1][0]).text, 'late');
  c.flush();
  assert.equal(io.appended.length, 2, 'nothing to flush');
});

test('the wait matcher', () => {
  const m = core.matches;
  const e = {
    kind: 'input', origin: 'human', prompt: 1, text: '      ⍝ Claude: look at foo',
  };
  assert.ok(m(e, {}));
  assert.ok(m(e, { kinds: ['input'], origin: 'human', prefix: '⍝ Claude:' }));
  assert.ok(m(e, { prefix: '      ⍝' }));
  assert.ok(!m(e, { prefix: 'Claude' }));
  assert.ok(!m(e, { origin: 'agent' }));
  assert.ok(!m(e, { kinds: ['output', 'error'] }));
  assert.ok(!m({ kind: 'prompt', prompt: 1 }, { prefix: 'x' }), 'no text, no prefix match');
});

test('wait returns the first matching event after since, now or later', async (t) => {
  const { io, c } = setup(t);
  const before = c.seq();
  echo(c, '      ⍝ Claude: hi');
  out(c, 'noise');
  await req(c, {
    id: 1, req: 'wait', since: before, origin: 'human', prefix: '⍝ Claude:',
  });
  assert.equal(last(io).ok.text, '      ⍝ Claude: hi');
  assert.equal(last(io).ok.kind, 'input');
  // since defaults to the latest, so the line already there does not count.
  await req(c, {
    id: 2, req: 'wait', kinds: 'input', prefix: '⍝ Claude:', timeout: 5000,
  });
  assert.equal(replies(io).length, 1);
  out(c, 'more noise');
  echo(c, '      1+1');
  assert.equal(replies(io).length, 1);
  echo(c, '      ⍝ Claude: next');
  assert.equal(last(io).id, 2);
  assert.equal(last(io).ok.text, '      ⍝ Claude: next');
  await req(c, {
    id: 3, req: 'wait', kinds: ['prompt', 'error'], timeout: 20,
  });
  out(c, 'not a prompt');
  await sleep(40);
  assert.equal(last(io).id, 3);
  assert.equal(last(io).err.code, 'timeout');
});

test('windows and window_text describe editors and tracers', async (t) => {
  const { io, c } = setup(t, 'observe');
  io.wins[7] = editor(7);
  io.wins[9] = editor(9, 'tracer');
  await req(c, { id: 1, req: 'windows' });
  assert.deepEqual(last(io).ok.map((w) => [w.token, w.kind]), [[7, 'editor'], [9, 'tracer']]);
  await req(c, { id: 2, req: 'window_text', token: 9 });
  assert.deepEqual(last(io).ok, editor(9, 'tracer'));
  await req(c, { id: 3, req: 'window_text', token: 8 });
  assert.equal(last(io).err.code, 'not_found');
});

test('edit resolves on the window that opens', async (t) => {
  const { io, c } = setup(t);
  await req(c, { id: 1, req: 'edit', name: 'foo' });
  assert.deepEqual(io.calls, [['edit', 'foo']]);
  assert.equal(replies(io).length, 0);
  c.recv('OpenWindow', {
    token: 9, name: 'foo', debugger: false, text: ['foo'], currentRow: 0,
  });
  assert.deepEqual(last(io), { id: 1, ok: { token: 9 } });
  const w = events(io).find((e) => e.kind === 'window');
  assert.equal(w.event, 'open');
  assert.equal(w.token, 9);
  assert.equal(w.name, 'foo');
  // A name already open comes back as GotoWindow.
  await req(c, { id: 2, req: 'edit', name: 'foo' });
  c.recv('GotoWindow', { win: 9 });
  assert.deepEqual(last(io), { id: 2, ok: { token: 9 } });
  // The message is dropped while the interpreter is busy, so the request fails now.
  prompt(c, 0);
  await req(c, { id: 3, req: 'edit', name: 'bar' });
  assert.equal(last(io).err.code, 'prompt');
  prompt(c, 1);
  await req(c, {
    id: 4, req: 'edit', name: 'bar', timeout: 20,
  });
  await sleep(40);
  assert.equal(last(io).err.code, 'timeout');
});

test('save goes through the editor and reports the interpreter\'s answer', async (t) => {
  const { io, c } = setup(t);
  io.wins[7] = editor(7);
  io.wins[9] = editor(9, 'tracer');
  await req(c, {
    id: 1, req: 'save', token: 7, text: 'foo\n 2\n', stops: [1],
  });
  assert.deepEqual(io.calls, [['save', 7, ['foo', ' 2'], [1]]]);
  const saveEv = events(io).find((e) => e.kind === 'window' && e.event === 'save');
  assert.equal(saveEv.origin, 'agent');
  assert.equal(saveEv.token, 7);
  assert.deepEqual(saveEv.text, ['foo', ' 2']);
  assert.equal(replies(io).length, 0);
  c.recv('ReplySaveChanges', { win: 8, err: 0 }); // another window's
  assert.equal(replies(io).length, 0);
  c.recv('ReplySaveChanges', { win: 7, err: 0 });
  assert.deepEqual(last(io), { id: 1, ok: { token: 7, saved: true } });

  await req(c, {
    id: 2, req: 'save', token: 7, text: ['x'],
  });
  c.recv('ReplySaveChanges', { win: 7, err: 1 });
  assert.equal(last(io).err.code, 'save');
  assert.equal(last(io).err.err, 1);

  io.save = () => false; // nothing changed: the editor sends nothing
  await req(c, {
    id: 3, req: 'save', token: 7, text: ['foo', ' 1'],
  });
  assert.deepEqual(last(io), { id: 3, ok: { token: 7, saved: true } });
  await req(c, {
    id: 4, req: 'save', token: 9, text: 'x',
  });
  assert.equal(last(io).err.code, 'bad_request');
  await req(c, {
    id: 5, req: 'save', token: 8, text: 'x',
  });
  assert.equal(last(io).err.code, 'not_found');
  // A human save is an event too, with its origin.
  c.sent('SaveChanges', { win: 7, text: ['z'], stop: [] });
  assert.equal(events(io).filter((e) => e.event === 'save').at(-1).origin, 'human');
});

test('stops are set as a margin click would, and reported', async (t) => {
  const { io, c } = setup(t);
  io.wins[7] = editor(7);
  io.wins[9] = editor(9, 'tracer');
  await req(c, {
    id: 1, req: 'stops', token: 7, lines: [3, 1],
  });
  assert.deepEqual(last(io), { id: 1, ok: { stops: [1, 3] } });
  assert.deepEqual(io.calls, [['stops', 7, [3, 1]]]);
  const ev = events(io).find((e) => e.event === 'stops');
  assert.deepEqual([ev.origin, ev.token, ev.stops], ['agent', 7, [1, 3]]);
  await req(c, {
    id: 2, req: 'stops', token: 8, lines: [],
  });
  assert.equal(last(io).err.code, 'not_found');
  // A tracer's stops go to the interpreter at once, which a busy prompt drops.
  prompt(c, 0);
  await req(c, {
    id: 3, req: 'stops', token: 9, lines: [0],
  });
  assert.equal(last(io).err.code, 'prompt');
  await req(c, {
    id: 4, req: 'stops', token: 7, lines: [0],
  });
  assert.deepEqual(last(io).ok, { stops: [0] });
  // The person's margin click in a tracer.
  c.sent('SetLineAttributes', {
    win: 9, stop: [2], trace: [], monitor: [],
  });
  const h = events(io).filter((e) => e.event === 'stops').at(-1);
  assert.deepEqual([h.origin, h.token, h.stops], ['human', 9, [2]]);
});

test('trace runs the command and resolves on the next highlight, close or prompt', async (t) => {
  const { io, c } = setup(t);
  io.wins[5] = editor(5, 'tracer');
  io.wins[7] = editor(7);
  await req(c, {
    id: 1, req: 'trace', token: 5, action: 'step_into',
  });
  assert.deepEqual(io.calls, [['trace', 5, 'step_into']]);
  prompt(c, 0);
  c.recv('SetHighlightLine', {
    win: 6, line: 9, end_line: 9, start_col: 0, end_col: 0,
  }); // another tracer
  assert.equal(replies(io).length, 0);
  c.recv('SetHighlightLine', {
    win: 5, line: 3, end_line: 3, start_col: 0, end_col: 0,
  });
  assert.deepEqual(last(io), {
    id: 1,
    ok: {
      highlight: {
        line: 3, end_line: 3, start_col: 0, end_col: 0,
      },
    },
  });
  prompt(c, 1);
  const hl = events(io).filter((e) => e.event === 'highlight');
  assert.deepEqual(hl.map((e) => [e.token, e.line]), [[6, 9], [5, 3]]);

  await req(c, {
    id: 2, req: 'trace', token: 5, action: 'continue',
  });
  prompt(c, 0);
  c.recv('CloseWindow', { win: 5 });
  assert.deepEqual(last(io), { id: 2, ok: { closed: true } });
  prompt(c, 1);

  await req(c, {
    id: 3, req: 'trace', token: 5, action: 'continue_trace',
  });
  prompt(c, 0);
  prompt(c, 1);
  assert.deepEqual(last(io), { id: 3, ok: { prompt: 1 } });

  await req(c, {
    id: 4, req: 'trace', token: 5, action: 'edit',
  });
  c.recv('WindowTypeChanged', { win: 5, tracer: false });
  assert.deepEqual(last(io), { id: 4, ok: { kind: 'editor' } });

  await req(c, {
    id: 5, req: 'trace', token: 7, action: 'step_over',
  });
  assert.equal(last(io).err.code, 'bad_request');
  await req(c, {
    id: 6, req: 'trace', token: 8, action: 'step_over',
  });
  assert.equal(last(io).err.code, 'not_found');
  await req(c, {
    id: 7, req: 'trace', token: 5, action: 'back', timeout: 20,
  });
  await sleep(40);
  assert.equal(last(io).err.code, 'timeout');

  await sequence(core.TRACE_ACTIONS, async (action) => {
    await req(c, {
      id: 8, req: 'trace', token: 5, action,
    });
    assert.equal(replies(io).filter((f) => f.id === 8 && f.err).length, 0, action);
    c.recv('SetHighlightLine', {
      win: 5, line: 1, end_line: 1, start_col: 0, end_col: 0,
    });
  });
  assert.deepEqual(io.calls.slice(-core.TRACE_ACTIONS.length).map((x) => x[2]), core.TRACE_ACTIONS);
});

test('stack returns the ReplyGetSIStack payload', async (t) => {
  const { io, c } = setup(t, 'observe');
  await req(c, { id: 1, req: 'stack' });
  assert.deepEqual(io.calls, [['stack']]);
  const payload = { stack: [{ description: 'foo[1]' }], tid: 0 };
  c.recv('ReplyGetSIStack', payload);
  assert.deepEqual(last(io), { id: 1, ok: payload });
  assert.deepEqual(events(io).find((e) => e.kind === 'stack').stack, payload.stack);
});

test('value asks for a tip and matches the reply by token', async (t) => {
  const { io, c } = setup(t, 'observe');
  await req(c, { id: 1, req: 'value', name: 'foo' });
  assert.deepEqual(io.calls, [['value', 'foo']]);
  c.recv('ValueTip', { token: 6, tip: ['other'], class: 2 }); // a hover's
  assert.equal(replies(io).length, 0);
  c.recv('ValueTip', {
    token: 7, tip: ['1 2 3'], class: 2, startCol: 0, endCol: 3,
  });
  assert.deepEqual(last(io), { id: 1, ok: { name: 'foo', tip: ['1 2 3'], class: 2 } });
  prompt(c, 0);
  await req(c, { id: 2, req: 'value', name: 'foo' });
  assert.equal(last(io).err.code, 'prompt');
});

test('interrupt reports the prompt and is never confirmed', async (t) => {
  const asked = [];
  const { io, c } = setup(t, 'control', {
    confirmNeeded: () => true,
    confirm: async (m) => { asked.push(m.req); return m.req !== 'execute'; },
  });
  io.wins[7] = editor(7);
  await req(c, { id: 1, req: 'interrupt' });
  assert.deepEqual(last(io), { id: 1, ok: { prompt: 1 } });
  assert.deepEqual(io.calls, [['interrupt', 'weak']]);
  await req(c, { id: 2, req: 'execute', text: '⍳5' });
  assert.equal(last(io).err.code, 'denied');
  await req(c, {
    id: 3, req: 'stops', token: 7, lines: [2],
  });
  assert.deepEqual(last(io).ok, { stops: [2] });
  assert.deepEqual(asked, ['execute', 'stops']);
  assert.deepEqual(io.calls, [['interrupt', 'weak'], ['stops', 7, [2]]]);
});

test('a request waiting for confirmation holds the slot', async (t) => {
  let answer;
  const { io, c } = setup(t, 'control', {
    confirmNeeded: () => true,
    confirm: () => new Promise((r) => { answer = r; }),
  });
  const p = req(c, { id: 1, req: 'execute', text: '⍳5' });
  await sleep(0);
  await req(c, { id: 2, req: 'execute', text: '1' });
  assert.equal(last(io).err.code, 'busy');
  await req(c, { id: 3, req: 'windows' });
  assert.deepEqual(last(io).ok, []);
  answer(true);
  await p;
  assert.deepEqual(io.calls, [['exec', '⍳5']]);
  run(c, '⍳5', ['1 2 3 4 5']);
  assert.equal(last(io).id, 1);
  // Control revoked while the toast was up: the answer no longer matters.
  const q = req(c, { id: 4, req: 'execute', text: '2' });
  await sleep(0);
  c.setLevel('observe');
  answer(true);
  await q;
  assert.equal(last(io).id, 4);
  assert.equal(last(io).err.code, 'refused');
});

test('connecting, disconnecting and the level are events; an agent echo is reported', async (t) => {
  const echoed = [];
  const io = fake({ onAgentEcho: (seq, text) => echoed.push([seq, text]) });
  const c = core.create(io);
  io.core = c;
  t.after(() => { c.setLevel(null); c.flush(); });
  echo(c, '1+1'); // before the port opens: nothing
  assert.equal(c.seq(), 0);
  c.setLevel('observe');
  c.socket(true);
  c.socket(true); // a repeat changes nothing
  c.setLevel('control');
  assert.deepEqual(io.frames.map((f) => [f.ev.seq, f.ev.event, f.ev.level]), [[2, 'connected', undefined], [3, 'level', 'control']]);
  c.flush();
  assert.deepEqual(io.appended[0].map((l) => JSON.parse(l).event), ['level', 'connected', 'level']);
  assert.equal(JSON.parse(io.appended[0][0]).level, 'observe');
  // The person's line: its Execute is not the tap's own.
  c.sent('Execute', { trace: 0, text: '1+1\n' });
  run(c, '      1+1', ['2']);
  assert.deepEqual(echoed, []);
  await req(c, { id: 1, req: 'execute', text: '⍳5' });
  echo(c, '⍳5');
  assert.deepEqual(echoed, [[c.seq(), '⍳5']]);
  prompt(c, 1);
  c.socket(false);
  assert.equal(c.connected(), false);
  assert.equal(c.level(), 'control', 'the port stays open');
  c.flush();
  assert.equal(JSON.parse(io.appended.at(-1).at(-1)).event, 'disconnected', 'the transcript shows the client leaving');
});

test('status reports the session, the level and the transcript', async (t) => {
  const { io, c } = setup(t);
  out(c, 'x');
  await req(c, { id: 1, req: 'status' });
  assert.deepEqual(last(io), {
    id: 1,
    ok: {
      caption: 'Dyalog', prompt: 1, level: 'control', version: '21.0', transcript: '/tmp/main-ride_1.jsonl', size: 42, rotated: false, seq: c.seq(), connected: true,
    },
  });
  assert.ok(io.appended.length > 0, 'status flushes the batch first');
});
