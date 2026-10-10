const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.env.TAURIDE_TEST_ROOT || path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

function load(timers = {}) {
  const sent = []; const errors = []; const server = {}; const client = {};
  const prefs = { lineNums: 1, indent: 4, indentMethods: 2, indentComments: true, prefixKey: '`' };
  const D = {
    informal: [], prf: new Proxy({}, { get: (_, key) => () => prefs[key] }),
    mop: { then: fn => fn() }, bq: {}, bqbqc: {}, send: (...x) => sent.push(x),
    wins: { 0: { dirty: {}, lineEditor: {}, lines: [], promptType: 1 } },
    ipc: {
      config: {}, log() {}, serve: fn => fn(), connectTo: (_, fn) => fn(),
      server: { on: (key, fn) => { server[key] = fn; }, start() {}, emit() {} },
      of: { ride_master: { on: (key, fn) => { client[key] = fn; }, emit() {} } },
    },
  };
  const languages = new Proxy({
    CompletionItemKind: {}, CompletionItemInsertTextRule: {},
    registerCompletionItemProvider: () => ({ dispose() {} }),
  }, { get: (obj, key) => obj[key] || (() => {}) });
  const context = vm.createContext({
    D, $: { extend: Object.assign, err: x => errors.push(x), alert() {} }, console, toastr: { warning() {} }, setTimeout: timers.setTimeout || setTimeout, clearTimeout: timers.clearTimeout || clearTimeout,
    monaco: { languages, Range: class {}, editor: { EndOfLinePreference: { LF: 0 } } },
  });
  ['src/syntax_info.js', 'src/mon_apl.js', 'src/ed.js', 'src/ipc.js'].forEach(file => vm.runInContext(source(file), context));
  const km = source('src/km.js');
  D.commands = vm.runInContext(`({${km.slice(km.indexOf('    CAM()'), km.indexOf('    CAW()'))}})`, context);
  D.ide = { wins: {}, promptType: 1 };
  const ideSource = source('src/ide.js');
  context.ide = D.ide;
  const clearReply = vm.runInContext(`({${ideSource.slice(ideSource.indexOf('    ReplyClearTraceStopMonitor('), ideSource.indexOf('    ReplyGetSIStack('))}})`, context).ReplyClearTraceStopMonitor;
  const unknownStart = ideSource.indexOf('    UnknownCommand(');
  const unknownEnd = ideSource.indexOf('\n  };', unknownStart);
  const unknown = vm.runInContext(`({${ideSource.slice(unknownStart, unknownEnd)}})`, context).UnknownCommand;
  return { D, sent, errors, server, client, clearReply, unknown };
}

function editor(D, stops = [], saved = [], tc = 0) {
  return Object.assign(Object.create(D.Ed.prototype), {
    tc, stop: new Set(stops), oStop: saved, updStops() {}, setStop() {},
    setLineAttributes() { D.send('SetLineAttributes', {}); },
  });
}

function setupIPC(api) {
  const { D, server, client } = api;
  const main = D.ide;
  D.IPC_Server();
  D.IDE = function IDE() { this.wins = {}; D.ide = this; };
  D.IPC_Client(7);
  const floating = D.ide;
  D.ide = main;
  D.ipc.of.ride_master.emit = (key, data) => {
    const previous = D.ide;
    D.ide = main;
    server[key] && server[key](data);
    D.ide = previous;
  };
  D.ipc.server.emit = (socket, key, data) => {
    const previous = D.ide;
    D.ide = floating;
    client[key] && client[key](data);
    D.ide = previous;
  };
  D.send = (...x) => api.sent.push(x);
  return floating;
}

test('global clear counts docked unsaved stops and resets the saved baseline', async () => {
  const { D, sent, clearReply } = load();
  const ed = editor(D, [1, 2], [1]);
  D.ide.wins = { 0: {}, 1: ed, 2: editor(D, [4], [], 1) };
  await D.commands.CAM();
  assert.equal(D.ide.unsavedStops, 1);
  assert.equal(sent.at(-1)[0], 'ClearTraceStopMonitor');
  assert.equal(sent.length, 1);
  assert.equal(ed.stop.size, 2);
  assert.equal(ed.oStop[0], 1);
  clearReply({ stops: 1, traces: 0, monitors: 0 });
  assert.equal(ed.stop.size, 0);
  assert.equal(ed.oStop.length, 0);
  D.ide.clearingStops = false;
  ed.stop.add(1);
  await D.commands.CAM();
  assert.equal(D.ide.unsavedStops, 1);
  clearReply({ stops: 0, traces: 0, monitors: 0 });
  await D.commands.CAM();
  assert.equal(D.ide.unsavedStops, 0);
});

test('global clear collects multiple floating editors through the real IPC handlers', async () => {
  const api = load(); const { D, sent } = api;
  const floating = setupIPC(api);
  floating.wins = { 1: editor(D, [3], []), 2: editor(D, [2, 5], [2]), 3: editor(D, [], []) };
  D.ide.wins[4] = editor(D, [7], []);
  [1, 2, 3].forEach(id => {
    const proxy = new D.IPC_WindowProxy(7, {});
    proxy.id = id; D.ide.wins[id] = proxy;
  });
  await D.commands.CAM();
  assert.equal(D.ide.unsavedStops, 3);
  assert.equal(sent.filter(x => x[0] === 'ClearTraceStopMonitor').length, 1);
  assert.equal(floating.wins[2].stop.size, 2);
  api.clearReply({ stops: 1, traces: 0, monitors: 0 });
  assert.equal(floating.wins[2].stop.size, 0);
  assert.equal(floating.wins[2].oStop.length, 0);
});

test('a floating editor closing during collection completes the clear without stale replies', async () => {
  const api = load(); const { D, sent } = api;
  setupIPC(api);
  const proxy = new D.IPC_WindowProxy(7, {});
  proxy.id = 1; D.ide.wins[1] = proxy; D.pwins.push(proxy);
  D.ipc.server.emit = () => {};
  const pending = D.commands.CAM();
  assert.equal(sent.length, 0);
  assert.equal(D.commands.CAM(), undefined);
  proxy.close();
  delete D.ide.wins[1];
  await pending;
  assert.equal(sent.at(-1)[0], 'ClearTraceStopMonitor');
  proxy.finishClearStops(1, 99);
  assert.equal(D.ide.unsavedStops, 0);
});

test('an unreachable floating editor reports an error and allows a new clear attempt', async () => {
  let timeout;
  const api = load({ setTimeout: fn => { timeout = fn; return 1; }, clearTimeout() {} });
  const { D, sent, errors } = api;
  setupIPC(api);
  const proxy = new D.IPC_WindowProxy(7, {});
  proxy.id = 1; D.ide.wins[1] = proxy;
  D.ipc.server.emit = () => {};
  const docked = editor(D, [3], [3]);
  D.ide.wins[2] = docked;
  const pending = D.commands.CAM();
  timeout();
  await pending;
  assert.equal(D.ide.clearingStops, false);
  assert.equal(sent.length, 0);
  assert.match(errors[0], /editor did not respond/);
  assert.equal(docked.stop.size, 1);
  assert.equal(docked.oStop[0], 3);
  const retry = D.commands.CAM();
  proxy.finishClearStops(1, 99);
  assert.equal(sent.length, 0);
  proxy.finishClearStops(2, 1);
  await retry;
  assert.equal(D.ide.unsavedStops, 1);
});

test('unsupported interpreter clear preserves editor stops and the saved baseline', async () => {
  const { D, sent, unknown } = load();
  const ed = editor(D, [1, 2], [1]);
  D.ide.wins[1] = ed;
  await D.commands.CAM();
  assert.equal(sent.at(-1)[0], 'ClearTraceStopMonitor');
  unknown({ name: 'ClearTraceStopMonitor' });
  assert.equal(ed.stop.size, 2);
  assert.equal(ed.oStop[0], 1);
  assert.equal(D.ide.clearingStops, false);
  assert.equal(D.ide.unsavedStops, 0);
});

test('busy interpreter prevents clear both before and during count collection', async () => {
  const { D, sent } = load();
  const ed = editor(D, [1], [1]);
  D.ide.wins[1] = ed;
  D.ide.promptType = 0;
  assert.equal(D.commands.CAM(), undefined);
  assert.equal(D.ide.clearingStops, undefined);
  D.ide.promptType = 1;
  const pending = D.commands.CAM();
  D.ide.promptType = 0;
  await pending;
  assert.equal(D.ide.clearingStops, false);
  assert.equal(sent.length, 0);
  assert.equal(ed.stop.size, 1);
  assert.equal(ed.oStop[0], 1);
});

test('disconnect during stop collection prevents a delayed clear request', async () => {
  const api = load(); const { D, sent } = api;
  setupIPC(api);
  const proxy = new D.IPC_WindowProxy(7, {});
  proxy.id = 1; D.ide.wins[1] = proxy;
  D.ipc.server.emit = () => {};
  const pending = D.commands.CAM();
  D.ide.clearingStops = false;
  D.ide.connected = 0;
  proxy.finishClearStops(1, 1);
  await pending;
  assert.equal(sent.length, 0);
});

test('save failures preserve generic fallback and carry explained state into floating editors', () => {
  const api = load(); const { D, errors } = api;
  const floating = setupIPC(api);
  const ed = editor(D); ed.ide = floating; ed.dialogCount = 0; ed.isClosing = 1; floating.wins[1] = ed;
  const proxy = new D.IPC_WindowProxy(7, {}); proxy.id = 1;
  proxy.saved(1, true);
  assert.equal(errors.length, 0);
  assert.equal(ed.isClosing, 0);
  proxy.saved(1, false);
  assert.equal(errors.length, 1);
  ed.saved(1, true);
  assert.equal(errors.length, 1);
  ed.saved(1);
  assert.equal(errors.length, 2);
  ed.me = { getValue: () => 'f' }; ed.id = 1; ed.isClosing = 1;
  proxy.saved(0, false);
  assert.equal(ed.oText, 'f');
  assert.equal(api.sent.at(-1)[0], 'CloseWindow');
});

function model(lines, version = 1) {
  return { getVersionId: () => version, getLineCount: () => lines.length, getLineContent: i => lines[i - 1] };
}

test('script numbering uses lexical tradfn boundaries, including recursive dfns', () => {
  const { D } = load();
  const lines = [':Namespace N', 'f←{', '  ⍵=0:0', '  ∇ ⍵-1', '}', '∇ r←g', 'r←1', '∇', ':EndNamespace'];
  const ed = { isScript: true, me: { getModel: () => model(lines) } };
  const fmt = D.Ed.prototype.lineNumFmt.call(ed);
  assert.deepEqual(lines.map((_, i) => fmt(i + 1)), ['[0]', '[1]', '[2]', '[3]', '[4]', '[5] [0]', '[6] [1]', '[7] [2]', '[8]']);
  const nested = [':Namespace N', '∇ f', 'd←{', ' ∇ ⍵', '}', '⍝ ∇', '∇', '∇ g', '1', '∇', ':EndNamespace'];
  ed.me.getModel = () => model(nested);
  assert.deepEqual(nested.map((_, i) => fmt(i + 1)), ['[0]', '[1] [0]', '[2] [1]', '[3] [2]', '[4] [3]', '[5] [4]', '[6] [5]', '[7] [0]', '[8] [1]', '[9] [2]', '[10]']);
});

test('script numbering refreshes after model edits and replacement with the same version', () => {
  const { D } = load();
  let current = model([':Namespace N', '∇ f', '1', '∇', ':EndNamespace']);
  const ed = { isScript: true, me: { getModel: () => current } };
  const fmt = D.Ed.prototype.lineNumFmt.call(ed);
  assert.equal(fmt(3), '[2] [1]');
  current = model([':Namespace N', '⍝ f', '1', '⍝', ':EndNamespace'], 2);
  assert.equal(fmt(3), '[2]');
  current = model([':Namespace N', '∇ f', '1', '∇', ':EndNamespace'], 2);
  assert.equal(fmt(3), '[2] [1]');
  assert.equal(D.Ed.prototype.lineNumChars.call(ed), 13);
});

test('embedded newlines retain one editor source line and make the entity read only', () => {
  const { D } = load();
  for (const [text, expected, readonly] of [
    [['f', 'a\nb\nc\r\rd'], 'f\na␤b␤c␍␍d', true],
    [['f', 'a←1'], 'f\na←1', false],
  ]) {
    let rendered;
    const stop = {};
    const ed = { id: 1, updateTitle() {}, me: { getModel: () => ({ getEOL: () => '\n', setValue: value => { rendered = value; throw stop; } }) } };
    assert.throws(() => D.Ed.prototype.open.call(ed, { name: 'f', text, entityType: 1 }), error => error === stop);
    assert.equal(rendered, expected);
    assert.equal(ed.isReadOnlyEntity, readonly);
  }
});
