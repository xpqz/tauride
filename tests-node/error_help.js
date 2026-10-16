const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/error_help');
const setup = () => {
  const calls = []; let listener;
  const io = {
    level: () => 'observe', context: async id => ({ error: { id, message: '<img onerror=bad>' } }),
    listen: async f => { listener = f; calls.push(['listen']); return () => calls.push(['unlisten']); },
    invoke: async (cmd, args) => { calls.push([cmd, args]); },
    settings: () => ({ executable: '', model: '' }), render() {},
  };
  const c = create(io);
  return { c, io, calls, event: p => listener(p) };
};
test('observation required before collecting or sending context', async () => {
  const { c, io, calls } = setup(); io.level = () => null;
  await c.explain('chosen'); assert.equal(calls.length, 0);
  assert.match(c.state().status, /observ/i);
});
test('target and settings preserved; subscribe before invoke; streaming stays plain text', async () => {
  const { c, calls, event } = setup(); await c.explain('chosen');
  assert.equal(calls[0][0], 'listen');
  const [, args] = calls.find(x => x[0] === 'companion_explain');
  assert.equal(args.context.error.id, 'chosen'); assert.equal(args.model, ''); assert.equal(args.executable, '');
  event({ requestId: args.requestId, event: 'delta', text: '<script>bad</script>' });
  assert.equal(c.state().text, '<script>bad</script>');
  event({ requestId: 'unrelated', event: 'done' }); assert.equal(c.state().busy, true);
  event({ requestId: args.requestId, event: 'done' }); assert.equal(c.state().busy, false);
});
test('cancel and retry ignore late events from old request', async () => {
  const { c, calls, event } = setup(); await c.explain('chosen');
  const old = calls.find(x => x[0] === 'companion_explain')[1].requestId;
  await c.cancel(); await c.retry();
  event({ requestId: old, event: 'delta', text: 'stale' }); assert.equal(c.state().text, '');
  assert.ok(calls.some(x => x[0] === 'companion_cancel' && x[1].requestId === old));
  await c.close(); assert.equal(c.state().open, false);
  assert.ok(calls.some(x => x[0] === 'companion_close'));
});
test('closing while context loads prevents sending; invoke rejection is visible', async () => {
  const { c, io, calls } = setup(); let resolve;
  io.context = () => new Promise(r => { resolve = r; });
  const pending = c.explain('chosen'); await c.close(); resolve({ error: { id: 'chosen' } }); await pending;
  assert.ok(!calls.some(x => x[0] === 'companion_explain'));
  io.context = async () => ({ error: { id: 'chosen' } });
  io.invoke = async cmd => { if (cmd === 'companion_explain') throw new Error('Codex unavailable'); };
  await c.explain('chosen'); assert.match(c.state().status, /Codex unavailable/); assert.equal(c.state().busy, false);
});
test('menu command has no default shortcut and Code preferences expose executable and optional model', () => {
  const fs = require('node:fs');
  const read = name => fs.readFileSync(require('node:path').join(__dirname, '..', name), 'utf8');
  assert.match(read('src/cmds.js'), /\['AGE',\s*'Agent: explain last error',\s*\[\]\]/);
  assert.match(read('src/prf.js'), /Explain Last Error\s*=AGE/);
  assert.match(read('src/prf.js'), /\['agentExecutable',\s*''\]/);
  assert.match(read('src/prf.js'), /\['agentModel',\s*''\]/);
  assert.match(read('index.html'), /id=code_agexe/);
  assert.match(read('index.html'), /id=code_agmodel/);
});
test('close during subscription setup cannot send, including late listener cleanup', async () => {
  const { c, io, calls } = setup(); let resolve; let removed = false;
  io.listen = () => new Promise(r => { resolve = r; });
  const pending = c.explain('x'); await Promise.resolve(); await c.close();
  resolve(() => { removed = true; }); await pending;
  assert.equal(removed, true); assert.ok(!calls.some(x => x[0] === 'companion_explain'));
});
test('double clicks cancel the old attempt, and expired context is never sent', async () => {
  const { c, io, calls } = setup();
  await c.explain('x'); await c.explain('y');
  assert.equal(calls.filter(x => x[0] === 'companion_cancel').length, 1);
  io.context = async () => null; await c.explain('expired');
  assert.match(c.state().status, /unavailable|expired/i);
  assert.equal(calls.filter(x => x[0] === 'companion_explain').length, 2);
});
test('browser panel renders HTML-looking Codex output inertly and Escape restores focus', async () => {
  const vm = require('node:vm'); const fs = require('node:fs');
  const nodes = []; let listener; let focused;
  const make = tag => {
    const n = { tag, hidden: false, dataset: {}, attrs: {}, children: [], textContent: '',
      appendChild(x) { this.children.push(x); }, setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(k, fn) { this[k] = fn; }, focus() { focused = this; } };
    nodes.push(n); return n;
  };
  const original = { focus() { focused = original; } };
  const document = { createElement: make, body: make('body'), activeElement: original };
  let requestId; let nativeFocus = 0;
  const D = { wm: { main: () => ({ focus() { nativeFocus += 1; } }) }, prf: { agentExecutable: () => '', agentModel: () => '' }, agent: {
    level: () => 'observe', errorContext: async () => ({ message: '<img src=x>', error: {} }), onErrorChange() {},
  } };
  const window = { __RIDE__: true, addEventListener() {},
    __TAURI_INTERNALS__: { metadata: { currentWindow: { label: 'main' } }, invoke: async (cmd, args) => { if (cmd === 'companion_explain') requestId = args.requestId; } },
    __TAURI__: { event: { listen: async (name, fn) => { listener = fn; return () => {}; } } },
  };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../src/error_help.js'), 'utf8'), { D, window, document, navigator: {}, module: { exports: {} }, console });
  await D.errorHelp.explain('chosen');
  assert.equal(nativeFocus, 1);
  listener({ payload: { requestId, event: 'delta', text: '<script>bad()</script>' } });
  assert.equal(nodes.find(n => n.className === 'error-help-text').textContent, '<script>bad()</script>');
  assert.equal(nodes.some(n => n.tag === 'script' || n.tag === 'img'), false);
  assert.equal(nativeFocus, 1, 'streamed text does not steal native focus');
  focused = original;
  await D.errorHelp.explain('chosen');
  assert.equal(focused, nodes.find(n => n.id === 'error-help'), 'explicit explain focuses an already-open panel');
  assert.equal(nativeFocus, 2, 'explicit explain raises an already-open panel');
  const panel = nodes.find(n => n.id === 'error-help');
  let stopped = false;
  panel.keydown({ key: 'Escape', stopPropagation() { stopped = true; }, preventDefault() {} });
  assert.equal(panel.hidden, true); assert.equal(stopped, true); assert.equal(focused, original);
});
test('an old close cannot close a newer explanation after cancellation settles', async () => {
  const { c, io, calls } = setup(); await c.explain('old'); let finish;
  const invoke = io.invoke;
  io.invoke = (cmd, args) => cmd === 'companion_cancel' ? new Promise(r => { finish = r; }) : invoke(cmd, args);
  const closing = c.close(); const newer = c.explain('new');
  await Promise.resolve(); finish(); await Promise.all([closing, newer]);
  assert.equal(c.state().open, true);
  assert.ok(!calls.some(x => x[0] === 'companion_close'));
});

test('Retry waits for native cancellation to finish before sending a new request', async () => {
  const { c, io, calls } = setup(); await c.explain('chosen'); let finish;
  const invoke = io.invoke;
  io.invoke = (cmd, args) => cmd === 'companion_cancel' ? new Promise(r => { finish = r; }) : invoke(cmd, args);
  const cancellation = c.cancel(); const retry = c.retry();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(x => x[0] === 'companion_explain').length, 1);
  finish(); await Promise.all([cancellation, retry]);
  assert.equal(calls.filter(x => x[0] === 'companion_explain').length, 2);
});
test('Retry preserves the displayed error when the latest error changes', async () => {
  const { c, io, calls } = setup();
  io.context = async id => ({ id: id || 'first', message: 'VALUE ERROR' });
  await c.explain();
  io.context = async id => ({ id: id || 'newest', message: 'DOMAIN ERROR' });
  await c.retry();
  assert.equal(calls.filter(x => x[0] === 'companion_explain').at(-1)[1].context.id, 'first');
});
