const test = require('node:test');
const assert = require('node:assert/strict');
const { create, renderExplanation } = require('../src/error_help');
const fakeDocument = () => {
  const document = { createElement: tag => make(tag), createTextNode: text => make('#text', text) };
  const make = (tag, text = '') => ({
    tag, ownerDocument: document, children: [], value: text,
    get textContent() { return this.value + this.children.map(n => n.textContent).join(''); },
    set textContent(value) { this.value = value; this.children = []; },
    appendChild(node) { this.children.push(node); return node; },
  });
  return document;
};
const providers = [{ id: 'codex', name: 'Codex', warm: true, enforces_no_tools: true, supports_model: true, docs_url: 'https://example.test/codex', guidance: { missing: 'Install Codex', signin: 'Sign in with Codex' } }];
const setup = () => {
  const calls = []; let listener;
  const io = {
    level: () => 'observe', context: async id => ({ error: { id, message: '<img onerror=bad>' } }),
    listen: async f => { listener = f; calls.push(['listen']); return () => calls.push(['unlisten']); },
    invoke: async (cmd, args) => { calls.push([cmd, args]); return { status: 'ready' }; },
    providers: async () => providers,
    settings: () => ({ provider: 'codex', settings: { executable: '', model: '' } }), render() {},
  };
  const c = create(io);
  return { c, io, calls, event: p => listener(p) };
};
test('observation required before collecting or sending context', async () => {
  const { c, io, calls } = setup(); io.level = () => null;
  let collected = false; io.context = async () => { collected = true; };
  await c.explain('chosen');
  assert.deepEqual(calls.map(x => x[0]), ['companion_check']); assert.equal(collected, false);
  assert.match(c.state().status, /observ/i);
});
test('target and settings preserved; subscribe before invoke; streaming stays plain text', async () => {
  const { c, calls, event } = setup(); await c.explain('chosen');
  assert.ok(calls.findIndex(x => x[0] === 'listen') < calls.findIndex(x => x[0] === 'companion_explain'));
  const [, args] = calls.find(x => x[0] === 'companion_explain');
  assert.equal(args.context.error.id, 'chosen'); assert.equal(args.settings.model, ''); assert.equal(args.settings.executable, '');
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
  const pending = c.explain('chosen'); await new Promise(r => setImmediate(r)); await c.close(); resolve({ error: { id: 'chosen' } }); await pending;
  assert.ok(!calls.some(x => x[0] === 'companion_explain'));
  io.context = async () => ({ error: { id: 'chosen' } });
  io.invoke = async cmd => { if (cmd === 'companion_explain') throw new Error('Codex unavailable'); return { status: 'ready' }; };
  await c.explain('chosen'); assert.match(c.state().status, /Codex unavailable/); assert.equal(c.state().busy, false);
});
test('menu command has no default shortcut and Code preferences expose executable and optional model', () => {
  const fs = require('node:fs');
  const read = name => fs.readFileSync(require('node:path').join(__dirname, '..', name), 'utf8');
  assert.match(read('src/cmds.js'), /\['AGE',\s*'Explain Last Error…',\s*\[\]\]/);
  assert.match(read('src/prf.js'), /Explain Last Error…\s*=AGE/);
  assert.match(read('src/prf.js'), /\['agentProvider',\s*'codex'\]/);
  assert.match(read('src/prf.js'), /\['agentProviderSettings',\s*\{ codex: \{ executable: '', model: '' \} \}\]/);
  assert.match(read('index.html'), /id=code_provider_executable/);
  assert.match(read('index.html'), /id=code_provider_model/);
});
test('close during subscription setup cannot send, including late listener cleanup', async () => {
  const { c, io, calls } = setup(); let resolve; let removed = false;
  io.listen = () => new Promise(r => { resolve = r; });
  const pending = c.explain('x'); await new Promise(r => setImmediate(r)); await c.close();
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
    const n = { tag, ownerDocument: document, hidden: false, dataset: {}, attrs: {}, children: [], value: '',
      get textContent() { return this.value + this.children.map(x => x.textContent).join(''); },
      set textContent(value) { this.value = value; this.children = []; },
      appendChild(x) { this.children.push(x); }, setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(k, fn) { this[k] = fn; }, focus() { focused = this; } };
    nodes.push(n); return n;
  };
  const original = { focus() { focused = original; } };
  const document = { createElement: make, createTextNode: text => ({ tag: '#text', textContent: text }), activeElement: original };
  document.body = make('body');
  let requestId; let nativeFocus = 0;
  const D = { wm: { main: () => ({ focus() { nativeFocus += 1; } }) }, prf: { agentProvider: () => 'codex', agentProviderSettings: () => ({}) }, agent: {
    level: () => 'observe', errorContext: async () => ({ message: '<img src=x>', error: {} }), onErrorChange() {},
  } };
  const window = { __RIDE__: true, addEventListener() {},
    __TAURI_INTERNALS__: { metadata: { currentWindow: { label: 'main' } }, invoke: async (cmd, args) => { if (cmd === 'companion_providers') return providers; if (cmd === 'companion_explain') requestId = args.requestId; return { status: 'ready' }; } },
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

test('explanation renders screenshot APL spans as code and HTML as inert text', () => {
  const element = fakeDocument().createElement('div');
  renderExplanation(element, 'The name `foo` is undefined; try `⎕←foo`. `<img src=x onerror=bad>` <script>bad()</script>');
  assert.deepEqual(element.children.filter(n => n.tag === 'code').map(n => n.textContent), ['foo', '⎕←foo', '<img src=x onerror=bad>']);
  assert.equal(element.textContent, 'The name foo is undefined; try ⎕←foo. <img src=x onerror=bad> <script>bad()</script>');
  assert.ok(element.children.every(n => ['#text', 'code'].includes(n.tag)));
});
test('streaming rerenders split delimiters without dropping unmatched or literal ticks', () => {
  const element = fakeDocument().createElement('div');
  const chunks = ['Try ', '`', '⎕←x', '`', ' and ``literal`` with `unfinished'];
  let text = '';
  chunks.forEach(chunk => {
    text += chunk; renderExplanation(element, text);
    assert.equal(element.textContent, text.includes('⎕←x`') ? text.replace('`⎕←x`', '⎕←x') : text);
  });
  assert.equal(element.children.filter(n => n.tag === 'code').length, 1);
  renderExplanation(element, '`one\ntwo`');
  assert.equal(element.textContent, '`one\ntwo`');
});
test('fenced code preserves indentation, newlines and HTML across split closing fences', () => {
  const element = fakeDocument().createElement('div');
  const opening = 'Correction:\n```apl\n  ⎕←x\n    `<img src=x>`\n';
  [opening, `${opening}\u0060`, `${opening}\u0060\u0060`].forEach(text => {
    renderExplanation(element, text);
    assert.equal(element.textContent, text);
  });
  renderExplanation(element, `${opening}\u0060\u0060\u0060\nThen use \u0060x\u0060.`);
  const pre = element.children.find(n => n.tag === 'pre');
  assert.equal(pre.children[0].tag, 'code');
  assert.equal(pre.textContent, '  ⎕←x\n    `<img src=x>`\n');
  assert.equal(element.textContent, 'Correction:\n  ⎕←x\n    `<img src=x>`\nThen use x.');
});

for (const status of ['missing', 'signin']) {
  test(`setup ${status} prevents context collection and model requests`, async () => {
    const { c, io, calls } = setup(); let collected = false;
    io.context = async () => { collected = true; };
    io.invoke = async (cmd, args) => { calls.push([cmd, args]); return { status, message: 'Setup required' }; };
    await c.explain('x');
    assert.equal(c.state().setup, status); assert.equal(collected, false);
    assert.equal(calls.some(x => x[0] === 'companion_explain'), false);
  });
}
test('enabling observation never starts a model request', async () => {
  const { c, io, calls } = setup(); let enabled = 0;
  io.level = () => null; io.enableObservation = () => { enabled += 1; };
  await c.explain(); c.enableObservation();
  assert.equal(enabled, 1); assert.deepEqual(calls.map(x => x[0]), ['companion_check']);
  assert.match(c.state().status, /Reproduce the error/);
});
test('successful checks are cached by executable and Check Again probes without sending', async () => {
  const { c, io, calls } = setup();
  await c.explain('x'); await c.retry();
  assert.equal(calls.filter(x => x[0] === 'companion_check').length, 1);
  await c.checkAgain();
  assert.equal(calls.filter(x => x[0] === 'companion_check').length, 2);
  assert.equal(calls.filter(x => x[0] === 'companion_explain').length, 2);
  io.settings = () => ({ provider: 'codex', settings: { executable: '/other/codex', model: '' } });
  await c.retry(); assert.equal(calls.filter(x => x[0] === 'companion_check').length, 3);
});
test('closing during setup ignores a late response and never sends old context', async () => {
  const { c, io, calls } = setup(); let finish;
  io.invoke = (cmd, args) => { calls.push([cmd, args]); return cmd === 'companion_check' ? new Promise(r => { finish = r; }) : Promise.resolve(); };
  const pending = c.explain('old'); await new Promise(r => setImmediate(r)); await c.close(); finish({ status: 'ready' }); await pending;
  assert.equal(c.state().open, false); assert.equal(calls.some(x => x[0] === 'companion_explain'), false);
});

test('missing setup stays actionable when observation is enabled', async () => {
  const { c, io, calls } = setup(); io.level = () => null;
  io.enableObservation = () => {};
  io.invoke = async (cmd, args) => { calls.push([cmd, args]); return { status: 'missing', message: 'Install Codex' }; };
  await c.explain(); c.enableObservation();
  assert.equal(c.state().setup, 'missing'); assert.equal(c.state().status, 'Install Codex');
  assert.deepEqual(calls.map(x => x[0]), ['companion_check']);
});


test('model is per request while setup identity includes provider and executable', async () => {
  const { c, io, calls } = setup();
  io.providers = async () => [...providers, { ...providers[0], id: 'other', name: 'Other' }];
  let provider = 'codex'; let model = 'first';
  io.settings = () => ({ provider, settings: { executable: '', model } });
  await c.explain('x'); model = 'second'; await c.retry();
  assert.equal(calls.filter(x => x[0] === 'companion_check').length, 1);
  assert.equal(calls.filter(x => x[0] === 'companion_explain').at(-1)[1].settings.model, 'second');
  provider = 'other'; await c.retry();
  assert.equal(calls.filter(x => x[0] === 'companion_check').length, 2);
  assert.equal(calls.filter(x => x[0] === 'companion_explain').at(-1)[1].provider, 'other');
});
test('unknown providers and invalid settings never collect context or invoke a provider', async () => {
  for (const settings of [
    { provider: 'unknown', settings: {} },
    { provider: 'codex', settings: { command: 'anything' } },
    { provider: 'codex', settings: { executable: 42 } },
  ]) {
    const { c, io, calls } = setup(); let collected = false;
    io.settings = () => settings; io.context = async () => { collected = true; };
    await c.explain('x');
    assert.equal(collected, false); assert.deepEqual(calls, []);
    assert.match(c.state().status, /provider|settings/i);
  }
});

test('panel only claims tool enforcement when the selected provider guarantees it', async () => {
  const fs = require('node:fs'); const vm = require('node:vm');
  for (const config of [undefined, {}, null, false, 0, 'invalid', [], { malformedMap: null }, { malformedMap: [] }, { malformedMap: false }, { malformedMap: 0 }, { malformedMap: 'invalid' }]) {
    const enforced = config === undefined;
    const nodes = []; let document;
    const make = tag => { const node = {
      tag, ownerDocument: document, dataset: {}, children: [], value: '',
      get textContent() { return this.value + this.children.map(n => n.textContent).join(''); },
      set textContent(value) { this.value = value; this.children = []; },
      appendChild(n) { this.children.push(n); }, setAttribute() {}, addEventListener() {}, focus() {},
    }; nodes.push(node); return node; };
    document = { createElement: make, createTextNode: text => ({ textContent: text }) }; document.body = make('body');
    const provider = { ...providers[0], enforces_no_tools: enforced };
    let setupCalls = 0;
    const D = { wm: { main: () => ({ focus() {} }) }, prf: { agentProvider: () => 'codex', agentProviderSettings: () => config && Object.hasOwn(config, 'malformedMap') ? config.malformedMap : ({ codex: config }) }, agent: { level: () => 'observe', errorContext: async () => ({ id: 'x' }) } };
    const window = { __RIDE__: true, addEventListener() {}, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' } }, invoke: async cmd => { if (cmd === 'companion_providers') return [provider]; setupCalls += 1; return { status: 'missing' }; },
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/error_help'), 'utf8'), { D, window, document, navigator: {} });
    await D.errorHelp.explain('x');
    const disclosure = nodes.find(n => n.className === 'error-help-disclosure').textContent;
    assert.equal(disclosure.includes('prevented from using tools'), enforced);
    assert.equal(disclosure.includes('never executed'), enforced);
    assert.equal(disclosure.includes('Tauride cannot prevent'), !enforced);
    if (config === undefined || (config && !Array.isArray(config) && typeof config === 'object' && !Object.hasOwn(config, 'malformedMap'))) {
      assert.equal(setupCalls, 1);
      assert.ok(nodes.some(n => n.textContent === provider.guidance.missing));
      assert.ok(nodes.some(n => n.href === provider.docs_url));
    } else {
      assert.equal(setupCalls, 0);
      assert.ok(nodes.some(n => /Invalid provider settings/.test(n.textContent)));
    }
  }
});
test('arguments reach a provider that takes them and are refused for one that does not', async () => {
  const command = { id: 'command', name: 'Custom command', warm: false, enforces_no_tools: false, supports_model: false, supports_args: true, docs_url: null, guidance: { missing: 'Choose a command', unavailable: 'Check the command' } };
  const { c, io, calls } = setup();
  io.providers = async () => [...providers, command];
  io.settings = () => ({ provider: 'command', settings: { executable: '/x', args: 'a\nb' } });
  await c.explain('chosen');
  const [, args] = calls.find(x => x[0] === 'companion_explain');
  assert.equal(args.settings.args, 'a\nb');
  const other = setup();
  other.io.providers = async () => [...providers, command];
  other.io.settings = () => ({ provider: 'codex', settings: { executable: '', model: '', args: 'a' } });
  await other.c.explain('chosen');
  assert.match(other.c.state().status, /Invalid provider settings/);
  assert.ok(!other.calls.some(x => x[0] === 'companion_explain'));
});
