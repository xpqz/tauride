const test = require('node:test');
const assert = require('node:assert/strict');
const errors = require('../src/error_context');

function setup(options = {}) {
  let current = { interpreter: { version: '21.0' }, windows: [] };
  const c = errors.create({ snapshot: () => current, stackTimeout: 0, ...options });
  c.setEnabled(true);
  return { c, snapshot: (x) => { current = x; } };
}
function failure(c, text = 'VALUE ERROR', code = 6) {
  c.sent('Execute', { text: 'foo\n' });
  c.recv('EchoInput', { input: '      foo\n' });
  c.recv('AppendSessionOutput', { type: 1, result: `${text}\n` });
  c.recv('HadError', { error: code, dmx: code });
  c.recv('SetPromptType', { type: 1 });
}

test('numeric HadError uses actual output and captures source at the settled boundary', async () => {
  const { c, snapshot } = setup();
  snapshot({ interpreter: { version: '21.0' }, windows: [{ token: 7, kind: 'tracer', text: ['foo;arg', 'arg+1'], executableText: ['foo;arg', 'arg+2'], saved: false, currentLine: 1 }] });
  failure(c);
  assert.equal(c.info(), null, 'the IDE has not handled queued messages yet');
  await c.settle();
  const info = c.info();
  assert.match(info.id, /\S/);
  assert.equal(info.message, 'VALUE ERROR');
  assert.equal(info.stale, false);
  const bundle = await c.context(info.id);
  assert.equal(bundle.error.error, 6);
  assert.equal(bundle.input.at(-1).text.trim(), 'foo');
  assert.equal(bundle.output.at(-1).text, 'VALUE ERROR\n');
  assert.deepEqual(bundle.windows[0].executableText, ['foo;arg', 'arg+2']);
  assert.equal(bundle.windows[0].saved, false);
  assert.ok(Object.isFrozen(bundle.windows[0].text));
  snapshot({ windows: [{ token: 7, text: ['later'] }] });
  assert.deepEqual((await c.context(info.id)).windows[0].text, ['foo;arg', 'arg+1']);
});

test('captured resolves once the pending error is frozen', async () => {
  const { c } = setup();
  failure(c);
  let done = false;
  const waiting = c.captured(5000).then(() => { done = true; });
  await new Promise((r) => { setTimeout(r, 20); });
  assert.equal(done, false, 'the error is still pending');
  await c.settle();
  await waiting;
  assert.equal((await c.context()).message, 'VALUE ERROR');
});

test('captured resolves at once with nothing pending, and at its deadline otherwise', async () => {
  const { c } = setup();
  await c.captured(5000);
  c.sent('Execute', { text: 'foo\n' });
  c.recv('AppendSessionOutput', { type: 1, result: 'VALUE ERROR\n' });
  c.recv('HadError', { error: 6, dmx: 6 });
  const started = Date.now();
  await c.captured(30);
  assert.ok(Date.now() - started >= 25, 'a pending error that never settles waits out the deadline');
  assert.equal(await c.context(), null);
});

test('breakpoints and ordinary output do not create errors', async () => {
  const { c } = setup();
  c.recv('AppendSessionOutput', { type: 1, result: 'VALUE ERROR\n' });
  await c.settle();
  assert.equal(c.info(), null);
  failure(c, 'Stopped', 1001);
  await c.settle();
  assert.equal(c.info(), null);
});

test('new execution makes old context stale and never fills it from a later frame', async () => {
  const { c, snapshot } = setup();
  failure(c);
  await c.settle();
  const old = c.info().id;
  c.sent('Execute', { text: 'bar\n' });
  snapshot({ windows: [{ token: 8, text: ['bar'] }], stack: [{ description: 'bar[1]' }] });
  await c.settle();
  assert.equal(c.info().stale, true);
  assert.deepEqual((await c.context(old)).windows, []);
  failure(c, 'DOMAIN ERROR', 11);
  await c.settle();
  assert.notEqual(c.info().id, old);
  assert.equal((await c.context(old)).message, 'VALUE ERROR');
  assert.equal((await c.context(old)).output.length, 1);
});

test('resume before settlement cannot attach current windows to the pending error', async () => {
  const { c, snapshot } = setup();
  failure(c);
  c.sent('RunCurrentLine', { win: 7 });
  snapshot({ windows: [{ token: 8, text: ['wrong frame'] }] });
  await c.settle();
  assert.equal(c.info().stale, true);
  assert.deepEqual((await c.context()).windows, []);
  assert.ok((await c.context()).unavailable.length);
});

test('storage and text are bounded, and disabling or disconnecting clears retained data', async () => {
  const { c } = setup({ maxErrors: 2, maxChars: 120, maxLines: 3 });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    failure(c, `DOMAIN ERROR ${'x'.repeat(500)}`, 11);
    await c.settle();
    ids.push(c.info().id);
  }
  assert.equal(await c.context(ids[0]), null);
  const bundle = await c.context();
  assert.ok(bundle.output.reduce((n, x) => n + x.text.length, 0) <= 120);
  assert.ok(bundle.truncated.length);
  c.setEnabled(false);
  assert.equal(c.info(), null);
  assert.equal(await c.context(ids[2]), null);
  failure(c);
  await c.settle();
  assert.equal(c.info(), null);
  c.setEnabled(true);
  failure(c);
  await c.settle();
  c.recv('Disconnect', {});
  assert.equal(c.info(), null);
});

test('listeners receive stable summaries and may unsubscribe', async () => {
  const { c } = setup();
  const seen = [];
  const stop = c.onChange((info) => seen.push(info));
  failure(c);
  await c.settle();
  c.sent('Execute', { text: 'next\n' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].stale, false);
  assert.equal(seen[1].stale, true);
  assert.equal(seen[0].id, seen[1].id);
  stop();
  c.setEnabled(false);
  assert.equal(seen.length, 2);
});

test('consecutive errors before settlement retain separate output and never borrow source', async () => {
  const { c } = setup();
  failure(c, 'FIRST ERROR');
  failure(c, 'SECOND ERROR');
  await c.settle();
  assert.equal(c.info().message, 'SECOND ERROR');
  assert.equal((await c.context()).output.length, 1);
  assert.equal((await c.context()).output[0].text, 'SECOND ERROR\n');
});

test('clearing notifies subscribers with null', async () => {
  const { c } = setup();
  const seen = [];
  c.onChange((x) => seen.push(x));
  failure(c);
  await c.settle();
  c.setEnabled(false);
  assert.equal(seen.at(-1), null);
});

test('bounded previews discard late replies after resume and complete on deadline', async () => {
  let resolve;
  let names;
  const { c, snapshot } = setup({ previewTimeout: 5, maxNames: 2, preview: (xs) => {
    names = xs;
    return new Promise((r) => { resolve = r; });
  } });
  snapshot({ windows: [{ token: 7, kind: 'tracer', text: ['r←foo a;b;c;d'], currentLine: 0 }] });
  failure(c);
  const settling = c.settle();
  await Promise.resolve();
  assert.ok(names.length <= 2);
  c.sent('Continue', { win: 7 });
  resolve([{ name: names[0], tip: ['wrong frame'] }]);
  await settling;
  assert.deepEqual((await c.context()).values, []);
  failure(c);
  await c.settle();
  assert.deepEqual((await c.context()).values, []);
  assert.ok((await c.context()).unavailable.some((s) => /preview/i.test(s)));
});

test('browser errorAt resolves the clicked decoration and rejects unrelated output and tracer lines', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../src/agent.js'), 'utf8');
  const start = source.indexOf('      errorAt(win, lineNumber) {');
  const end = source.indexOf('      onErrorChange(', start);
  const model = { getDecorationRange: (id) => ({ startLineNumber: id === 'old' ? 4 : 9, endLineNumber: id === 'old' ? 4 : 9, startColumn: 1, endColumn: 12 }), getLineContent: () => 'VALUE ERROR' };
  const wins = { 0: { me: { getModel: () => model } }, 7: { id: 7, tc: true, HIGHLIGHT: { lineStart: 3 }, me: { getModel: () => ({}) } } };
  wins[9] = { id: 9, tc: true, me: {} };
  const errorCapture = { info: () => ({ id: 'new-error', stale: false }) };
  const api = vm.runInNewContext(`({${source.slice(start, end)}})`, { want: 'observe', errorCapture, protocolWindows: new Map([[9, { kind: 'tracer', currentLine: 2 }]]), errorTracers: new Map([['new-error', [7, 9]]]), D: { ide: { wins } }, errorMarks: new Map([['old-error', { model, decoration: 'old', text: 'VALUE ERROR' }], ['new-error', { model, decoration: 'new', text: 'VALUE ERROR' }]]) });
  assert.equal(api.errorAt(0, 4), 'old-error');
  assert.equal(api.errorAt(0, 9), 'new-error');
  assert.equal(api.errorAt(0, 5), null);
  model.getLineContent = () => 'replacement output';
  assert.equal(api.errorAt(0, 4), null);
  model.getLineContent = () => 'VALUE ERROR';
  assert.equal(api.errorAt(7, 3), 'new-error');
  assert.equal(api.errorAt(9, 3), 'new-error');
  assert.equal(api.errorAt(9, 2), null);
  assert.equal(api.errorAt(7, 2), null);
  errorCapture.info = () => ({ id: 'new-error', stale: true });
  assert.equal(api.errorAt(7, 3), null);
});


test('a stack reply requested before resume cannot be assigned to the next error', async () => {
  const { c } = setup();
  c.sent('GetSIStack', {});
  failure(c);
  c.recv('ReplyGetSIStack', { stack: [{ description: 'old[1]' }] });
  await c.settle();
  assert.equal((await c.context()).stack, undefined);
});

for (const markerFirst of [false, true]) {
  test(`error message ignores normal output, markerFirst=${markerFirst}`, async () => {
    const { c } = setup();
    c.sent('Execute', { text: 'foo\n' });
    c.recv('AppendSessionOutput', { type: 1, result: 'normal progress\n' });
    if (markerFirst) c.recv('HadError', { error: 5, dmx: 5 });
    c.recv('AppendSessionOutput', { type: 1, result: 'LENGTH ERROR\nfoo[2] 1+2 3\n' });
    if (!markerFirst) c.recv('HadError', { error: 5, dmx: 5 });
    c.recv('SetPromptType', { type: 1 });
    await c.settle();
    assert.equal(c.info().message, 'LENGTH ERROR');
    assert.equal((await c.context()).message, 'LENGTH ERROR');
  });
}

test('new error while preview is pending preserves old immutable context without late values', async () => {
  const pending = [];
  const { c, snapshot } = setup({ preview: () => new Promise((resolve) => pending.push(resolve)) });
  snapshot({ windows: [{ token: 7, kind: 'tracer', text: ['foo;a'], currentLine: 1 }] });
  failure(c);
  const first = c.settle();
  await Promise.resolve();
  const old = 'error-1';
  failure(c, 'DOMAIN ERROR', 11);
  pending[0]([{ name: 'a', tip: ['late'] }]);
  await first;
  assert.equal((await c.context(old)).stale, true);
  assert.deepEqual((await c.context(old)).values, []);
  assert.equal(c.info(), null);
  const second = c.settle();
  await Promise.resolve();
  pending[1]([]);
  await second;
  assert.equal(c.info().message, 'DOMAIN ERROR');
});

test('capture waits for a nonbusy prompt after delayed error output', async () => {
  const { c } = setup();
  c.sent('Execute', { text: 'foo\n' });
  c.recv('HadError', { error: 5 });
  await c.settle();
  assert.equal(c.info(), null);
  c.recv('AppendSessionOutput', { result: 'LENGTH ERROR\n' });
  await c.settle();
  assert.equal(c.info(), null);
  c.recv('SetPromptType', { type: 1 });
  await c.settle();
  assert.equal(c.info().message, 'LENGTH ERROR');
});

test('formal arguments precede locals and previews use the uniquely highlighted tracer', async () => {
  let seen;
  const { c, snapshot } = setup({ preview: async (names, token) => { seen = { names, token }; return []; } });
  snapshot({ windows: [{ token: 1, name: 'Other', kind: 'tracer', text: ['Other;x'] }, { token: 8, name: 'Fn', kind: 'tracer', text: ['r←left Fn right;temp'] }] });
  failure(c);
  c.recv('SetHighlightLine', { win: 8, line: 1 });
  await c.settle();
  assert.deepEqual(seen, { names: ['left', 'right', 'temp'], token: 8 });
});

test('ambiguous tracer frames do not request previews', async () => {
  let requests = 0;
  const { c, snapshot } = setup({ preview: async () => { requests += 1; return []; } });
  snapshot({ windows: [1, 2].map((token) => ({ token, kind: 'tracer', text: ['Fn;a'] })) });
  failure(c);
  await c.settle();
  assert.equal(requests, 0);
});

test('floating tracer keeps executable source and labels missing display buffer', async () => {
  const { c, snapshot } = setup();
  snapshot({ windows: [{ token: 9, kind: 'tracer', executableText: ['r←Fn arg;temp', 'arg+1'], bufferUnavailable: 'Floating buffer unavailable' }] });
  failure(c);
  await c.settle();
  const w = (await c.context()).windows[0];
  assert.deepEqual(w.executableText, ['r←Fn arg;temp', 'arg+1']);
  assert.match(w.bufferUnavailable, /unavailable/);
});

test('complete serialized context stays below 64KiB with multibyte APL across fields', async () => {
  const { c, snapshot } = setup({ preview: async () => [{ name: 'a', tip: ['⍳'.repeat(24000)] }] });
  snapshot({ interpreter: { caption: '⍳'.repeat(24000) }, windows: [{ token: 7, kind: 'tracer', text: ['Fn;a', '⍳'.repeat(24000)], executableText: ['⍳'.repeat(24000)] }] });
  c.sent('Execute', { text: 'foo\n' });
  c.recv('EchoInput', { input: '⍳'.repeat(24000) });
  c.recv('AppendSessionOutput', { result: `VALUE ERROR\n${'⍳'.repeat(24000)}` });
  c.recv('HadError', { error: 6, dmx: '⍳'.repeat(24000) });
  c.recv('SetPromptType', { type: 1 });
  await c.settle();
  const bundle = await c.context();
  assert.ok(Buffer.byteLength(JSON.stringify(bundle)) <= 64 * 1024);
  assert.ok(bundle.truncated.includes('bundle'));
  assert.equal(bundle.message, 'VALUE ERROR');
});

test('current fifth tracer and its late failing line survive earlier long windows', async () => {
  const { c, snapshot } = setup();
  const windows = Array.from({ length: 5 }, (_, i) => ({ token: i + 1, kind: 'tracer', name: 'Fn', currentLine: 250, text: ['r←Fn arg', ...Array(300).fill('ordinary line')] }));
  windows[4].text[250] = 'arg÷0 ⍝ failing line';
  snapshot({ windows });
  failure(c);
  c.recv('SetHighlightLine', { win: 5, line: 250 });
  await c.settle();
  const bundle = await c.context();
  assert.equal(bundle.windows[0].token, 5);
  assert.ok(bundle.windows[0].sourceSnippet.lines.includes('arg÷0 ⍝ failing line'));
});

test('a delayed current execution stack reply is included within the capture deadline', async () => {
  const { c } = setup({ stackTimeout: 100 });
  failure(c);
  const capture = c.settle();
  setTimeout(() => { c.sent('GetSIStack', {}); c.recv('ReplyGetSIStack', { stack: [{ description: 'Fn[2]' }] }); }, 20);
  await capture;
  assert.deepEqual((await c.context()).stack, [{ description: 'Fn[2]' }]);
});

for (const command of ['SetThread', 'SetSIStack']) {
  test(`${command} invalidates pending previews and preserves historical context`, async () => {
    let release;
    const { c, snapshot } = setup({ preview: () => new Promise((resolve) => { release = resolve; }) });
    snapshot({ windows: [{ token: 7, name: 'Fn', kind: 'tracer', text: ['r←Fn arg;temp'], currentLine: 1 }] });
    failure(c);
    const pending = c.settle();
    await Promise.resolve();
    c.sent(command, { tid: 2, index: 1 });
    release([{ name: 'arg', tip: ['wrong frame'] }]);
    await pending;
    const bundle = await c.context('error-1');
    assert.equal(bundle.stale, true);
    assert.deepEqual(bundle.values, []);
    assert.equal(bundle.windows[0].token, 7);
    snapshot({ windows: [{ token: 8, text: ['other frame'] }] });
    assert.equal((await c.context('error-1')).windows[0].token, 7);
  });
}

test('failing source snippet uses executable definition when the tracer buffer was modified', async () => {
  const { c, snapshot } = setup();
  snapshot({ windows: [{ token: 7, kind: 'tracer', name: 'Fn', currentLine: 1, saved: false, text: ['Fn', 'edited buffer line'], executableText: ['Fn', 'actual executable line'] }] });
  failure(c);
  await c.settle();
  const w = (await c.context()).windows[0];
  assert.deepEqual(w.sourceSnippet.lines, ['Fn', 'actual executable line']);
  assert.equal(w.sourceSnippet.origin, 'executable');
  assert.deepEqual(w.text, ['Fn', 'edited buffer line']);
  assert.deepEqual(w.executableText, ['Fn', 'actual executable line']);
});

test('capture explicitly requests a stack without debugger subscription and avoids duplicate inflight requests', async () => {
  let requests = 0;
  let c;
  ({ c } = setup({ stackTimeout: 100, requestStack: () => {
    requests += 1;
    c.sent('GetSIStack', {});
    setTimeout(() => c.recv('ReplyGetSIStack', { stack: [{ description: 'Fn[2]' }] }), 5);
  } }));
  failure(c);
  await c.settle();
  assert.equal(requests, 1);
  assert.deepEqual((await c.context()).stack, [{ description: 'Fn[2]' }]);
  failure(c);
  c.sent('GetSIStack', {});
  const pending = c.settle();
  c.recv('ReplyGetSIStack', { stack: [{ description: 'Fn[3]' }] });
  await pending;
  assert.equal(requests, 1);
  assert.deepEqual((await c.context()).stack, [{ description: 'Fn[3]' }]);
});

test('explicit stack request discards a queued reply from an earlier execution', async () => {
  let c;
  ({ c } = setup({ stackTimeout: 100, requestStack: () => {
    c.sent('GetSIStack', {});
    c.recv('ReplyGetSIStack', { stack: [{ description: 'old[1]' }] });
    c.recv('ReplyGetSIStack', { stack: [{ description: 'current[2]' }] });
  } }));
  c.sent('GetSIStack', {});
  failure(c);
  await c.settle();
  assert.deepEqual((await c.context()).stack, [{ description: 'current[2]' }]);
});

test('connection reset discards abandoned stack request correlations', async () => {
  let c;
  ({ c } = setup({ stackTimeout: 40, requestStack: () => {
    c.sent('GetSIStack', {});
    c.recv('ReplyGetSIStack', { stack: [{ description: 'new session[1]' }] });
  } }));
  c.sent('GetSIStack', {});
  c.clear();
  failure(c);
  await c.settle();
  assert.deepEqual((await c.context()).stack, [{ description: 'new session[1]' }]);
});

test('disabled observation drains outstanding stack replies before reenable', async () => {
  let c;
  ({ c } = setup({ stackTimeout: 40, requestStack: () => {
    c.sent('GetSIStack', {});
    c.recv('ReplyGetSIStack', { stack: [{ description: 'after reenable[1]' }] });
  } }));
  c.sent('GetSIStack', {});
  c.setEnabled(false);
  c.recv('ReplyGetSIStack', { stack: [{ description: 'disabled[1]' }] });
  c.setEnabled(true);
  failure(c);
  await c.settle();
  assert.deepEqual((await c.context()).stack, [{ description: 'after reenable[1]' }]);
});

test('reenabled observation rejects an old reply still inflight until its successor arrives', async () => {
  let c;
  ({ c } = setup({ stackTimeout: 40, requestStack: () => {
    c.sent('GetSIStack', {});
    c.recv('ReplyGetSIStack', { stack: [{ description: 'before disable[1]' }] });
    c.recv('ReplyGetSIStack', { stack: [{ description: 'after reenable[1]' }] });
  } }));
  c.sent('GetSIStack', {});
  c.setEnabled(false);
  c.setEnabled(true);
  failure(c);
  await c.settle();
  assert.deepEqual((await c.context()).stack, [{ description: 'after reenable[1]' }]);
});
