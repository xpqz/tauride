const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function dialogShim() {
  const text = source('tauri/shim.js');
  const calls = [];
  let settle; let fail;
  const promise = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  const context = vm.createContext({ currentId: () => 7,
    invoke: (command, args) => { calls.push([command, plain(args)]); return promise; },
    messageText: () => '',
    sync: () => { throw new Error('asynchronous service used blocking XHR'); },
    window: { alert() { throw new Error('silent blocking fallback'); }, confirm() { throw new Error('silent consent fallback'); } },
  });
  vm.runInContext(text.slice(text.indexOf('  const dialogArgs ='), text.indexOf('  // Popup menus')), context);
  const start = text.indexOf('    dialog: {');
  const dialog = vm.runInContext(`({${text.slice(start, text.indexOf('    app: {', start))}}).dialog`, context);
  return { dialog, calls, settle, fail };
}

test('asynchronous messages preserve their owner and await the native response', async () => {
  const api = dialogShim();
  let completed = false;
  const result = api.dialog.showMessageBox({ id: 12, rideWindow: true },
    { buttons: ['Keep', 'Discard', 'Cancel'], cancelId: 2, checkboxLabel: 'Remember' });
  result.then(() => { completed = true; });
  assert.equal(completed, false);
  assert.deepEqual(api.calls, [['native_message', { options: { window: 12, buttons: ['Keep', 'Discard', 'Cancel'], cancelId: 2, checkboxLabel: 'Remember' } }]]);
  api.settle({ response: 1, checkboxChecked: true });
  assert.deepEqual(plain(await result), { response: 1, checkboxChecked: true });
});

test('picker cancellation and paths retain Electron result contracts without blocking', async () => {
  for (const save of [false, true]) {
    for (const paths of [null, ['/tmp/APL files/a.dws', '/tmp/b.dws']]) {
      const api = dialogShim();
      const pending = save ? api.dialog.showSaveDialog({ defaultPath: '/tmp/APL files' })
        : api.dialog.showOpenDialog({ properties: ['multiSelections'], defaultPath: '/tmp/APL files' });
      assert.equal(api.calls[0][0], 'native_file');
      assert.equal(api.calls[0][1].options.window, 7);
      assert.equal(api.calls[0][1].options.save, save);
      api.settle(paths);
      const result = await pending;
      assert.equal(result.canceled, !paths);
      if (save) assert.equal(result.filePath, paths ? paths[0] : undefined);
      else assert.deepEqual(plain(result.filePaths), paths || []);
    }
  }
});

test('native service errors reject without opening a synchronous fallback', async () => {
  const api = dialogShim();
  const pending = api.dialog.showMessageBox({ message: 'Delete?' });
  api.fail(new Error('native permission denied'));
  await assert.rejects(pending, /native permission denied/);
});

function utility(dialog) {
  const $ = {};
  const text = source('src/util.js');
  const context = vm.createContext({ $, window: { __RIDE__: true },
    D: { el: { dialog }, wm: { main: () => ({ native: { id: 1 } }), current: () => ({ native: { id: 12 } }) } },
  });
  vm.runInContext(text.slice(text.indexOf('  $.alert ='), text.lastIndexOf('\n}')), context);
  return $;
}

test('alert focus callbacks and confirmation choices wait for asynchronous dismissal', async () => {
  let settle; const pending = new Promise(resolve => { settle = resolve; });
  const $ = utility({ showMessageBox: () => pending,
    showMessageBoxSync() { throw new Error('blocking message'); } });
  let focused = false;
  const alert = $.err('Bad field', () => { focused = true; });
  assert.equal(focused, false);
  settle({ response: 0 }); await alert;
  assert.equal(focused, true);
  for (const response of [0, 1]) {
    const q = utility({ showMessageBox: async () => ({ response }) });
    assert.equal(await q.confirm('Continue?'), +(response === 0));
  }
});

function closing(spawned) {
  const sent = []; const questions = [];
  const ide = { connected: true };
  const D = { ide, spawned, prf: { sqp: () => true, connectOnQuit: () => false }, el: {}, ipc: { server: { stop() {} } },
    wins: { 0: { histWrite() {} } }, send: (...args) => sent.push(args) };
  const window = { __RIDE__: true, close() {} };
  const $ = { confirm: (_, __, answer) => { questions.push(answer); } };
  const text = source('src/init.js');
  vm.runInNewContext(text.slice(text.indexOf('    window.onbeforeunload ='), text.indexOf('    let platform =')), {
    D, $, window, document: { title: 'Session' }, process: { env: {} }, setTimeout: fn => fn(), console,
  });
  return { D, ide, window, questions, sent };
}

test('Session close waits for consent and coalesces repeated requests', () => {
  for (const spawned of [false, true]) {
    const api = closing(spawned);
    api.window.onbeforeunload({}); api.window.onbeforeunload({});
    assert.equal(api.questions.length, 1);
    assert.deepEqual(api.sent, []);
    api.questions[0](0);
    assert.equal(api.ide.closing, undefined);
    api.window.onbeforeunload({});
    api.questions[1](1);
    assert.deepEqual(plain(api.sent), spawned ? [['Exit', { code: 0 }]] : [['Disconnect', { message: 'User shutdown request' }]]);
  }
});


test('Session consent cannot act on a replaced, disconnected or dead interpreter', () => {
  for (const invalidate of [api => { api.D.ide = {}; }, api => { api.ide.connected = false; }, api => { api.ide.dead = true; }]) {
    const api = closing(true);
    api.window.onbeforeunload({}); invalidate(api); api.questions[0](1);
    assert.deepEqual(api.sent, []);
    assert.equal(api.ide.closePromptPending, undefined);
  }
});

function editorClose() {
  const answers = []; const actions = []; let reject;
  const promise = new Promise((_, fail) => { reject = fail; });
  const ed = { id: 4, name: 'changed', oText: 'old', oStop: [],
    me: { getValue: () => 'new', getModel: () => ({}) }, getStops: () => [],
    EP: () => actions.push('save'), QT: () => actions.push('discard'), focus: () => actions.push('focus'),
    ide: { connected: true, wins: {} } };
  ed.ide.wins[4] = ed;
  const text = source('src/ed.js');
  const method = text.slice(text.indexOf('  onClose() {'), text.indexOf('  ReplyFormatCode('));
  const close = vm.runInNewContext(`({${method}}).onClose`, {
    window: { focus() {} }, setTimeout: fn => fn(), console: { error() {} },
    D: { util: { optionsDialog: (_, answer) => { answers.push(answer); return promise; } } },
  });
  return { ed, answers, actions, reject, close: () => close.call(ed) };
}

test('dirty editor close coalesces consent and preserves Save, Discard and Cancel', () => {
  for (const [response, action] of [[0, 'save'], [1, 'discard'], [2, 'focus']]) {
    const api = editorClose(); api.close(); api.close();
    assert.equal(api.answers.length, 1); assert.deepEqual(api.actions, []);
    api.answers[0](response); assert.deepEqual(api.actions, [action]);
    assert.equal(api.ed.closePromptPending, undefined);
  }
});

test('late editor responses cannot save a removed or disconnected editor', () => {
  for (const invalidate of [ed => { delete ed.ide.wins[4]; }, ed => { ed.ide.connected = false; },
    ed => { ed.ide.dead = true; }, ed => { ed.me.getModel = () => null; }]) {
    const api = editorClose(); api.close(); invalidate(api.ed); api.answers[0](0);
    assert.deepEqual(api.actions, []);
  }
});

test('editor dialog failure releases the pending close without saving', async () => {
  const api = editorClose(); api.close(); api.reject(new Error('dialog unavailable'));
  await Promise.resolve();
  assert.deepEqual(api.actions, []); assert.equal(api.ed.closePromptPending, undefined);
  api.close(); assert.equal(api.answers.length, 2);
});

test('file selection cannot target a replaced or disconnected Session', async () => {
  for (const invalidate of [D => { D.ide = {}; }, D => { D.ide.connected = false; }]) {
    let settle; const pending = new Promise(resolve => { settle = resolve; }); const actions = [];
    const D = { ide: { connected: true, exec: (...args) => actions.push(args) }, isLocalInterpreter: true,
      el: { dialog: { showOpenDialog: () => pending } }, wm: { main: () => ({ native: {} }) } };
    const text = source('src/km.js');
    const method = text.slice(text.indexOf('    async OWS() {'), text.indexOf('    NEW() {'));
    const open = vm.runInNewContext(`({${method}}).OWS`, { D, window: { __RIDE__: true } });
    const result = open(); invalidate(D); settle({ filePaths: ['/tmp/example.aplf'] }); await result;
    assert.deepEqual(actions, []);
  }
});


test('global quit coalesces consent, cancellation and service failure allow retry', async () => {
  const answers = []; const rejected = []; let quits = 0;
  const D = { mac: true, ide: { connected: true }, prf: { sqp: () => true }, el: { app: { quit: () => { quits += 1; } } } };
  const text = source('src/init.js');
  vm.runInNewContext(text.slice(text.indexOf('    if (!D.quit && window.__RIDE__'), text.indexOf('    if (!D.quit) D.quit')), {
    D, window: { __RIDE__: true }, document: { title: 'Session' }, console: { error() {} },
    $: { confirm: (_, __, answer) => { answers.push(answer); return new Promise((resolve, reject) => rejected.push(reject)); } },
  });
  D.quit(); D.quit(); assert.equal(answers.length, 1); assert.equal(quits, 0);
  answers[0](0); D.quit(); assert.equal(answers.length, 2);
  rejected[1](new Error('dialog unavailable')); await Promise.resolve();
  D.quit(); assert.equal(answers.length, 3); assert.equal(quits, 0);
  answers[2](1); assert.equal(quits, 1);
});

test('connection picker ignores a selection belonging to a previous connection', async () => {
  let settle; const promise = new Promise(resolve => { settle = resolve; });
  const state = { sel: {}, changes: 0 };
  const text = source('src/cn.js');
  const method = text.slice(text.indexOf('    const browse = async'), text.indexOf('    q.log_dots.onclick'));
  const context = vm.createContext({ sel: state.sel, window: { __RIDE__: true },
    D: { el: { dialog: { showOpenDialog: () => promise } }, util: { elastic() {} } },
    $: () => ({ change() { state.changes += 1; } }) });
  const browse = vm.runInContext(`${method}; browse`, context);
  const field = { value: 'original', isConnected: true }; const pending = browse(field, 'File');
  context.sel = {}; settle({ filePaths: ['/tmp/new'] }); await pending;
  assert.equal(field.value, 'original'); assert.equal(state.changes, 0);
});

test('options dialog maps native Escape to explicit Cancel, never Save', async () => {
  const text = source('src/util.js');
  const method = text.slice(text.indexOf('    optionsDialog(x, f) {'), text.indexOf('    stringDialog(x, f) {'));
  let options; let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const show = vm.runInNewContext(`({${method}}).optionsDialog`, { window: { __RIDE__: true },
    D: { ide: { focusedWin: { bwId: 0 } }, wm: { main: () => ({ native: {} }) },
      el: { dialog: { showMessageBox: (_, value) => { options = value; return pending; } } } } });
  let choice;
  const result = show({ options: ['Yes', 'No', 'Cancel'], text: 'Changed object' }, response => { choice = response; });
  assert.equal(options.cancelId, 2); assert.equal(choice, undefined);
  settle({ response: options.cancelId }); await result;
  assert.equal(choice, 2);
});

test('native opener preserves URL/path bytes and propagates failure', async () => {
  const text = source('tauri/shim.js'); const calls = []; let fail = false;
  const shell = vm.runInNewContext(`${text.slice(text.indexOf('  const shell = {'), text.indexOf('  const clipboard = {'))}; shell`, {
    invoke: async (command, args) => { calls.push([command, plain(args)]); if (fail) throw new Error('opener denied'); },
  });
  await shell.openExternal('https://example.org/help?q=⍳&x=two words');
  assert.equal(await shell.openPath('/tmp/APL files/a; b.dws'), '');
  await shell.showItemInFolder('/tmp/APL files/a; b.dws');
  assert.deepEqual(calls, [
    ['native_open', { target: 'https://example.org/help?q=⍳&x=two words', kind: 'url' }],
    ['native_open', { target: '/tmp/APL files/a; b.dws', kind: 'path' }],
    ['native_open', { target: '/tmp/APL files/a; b.dws', kind: 'reveal' }],
  ]);
  fail = true; await assert.rejects(shell.openExternal('https://example.org'), /opener denied/);
});

test('interpreter dialog responses cannot cross Session or input-operation boundaries', () => {
  for (const method of ['OptionsDialog', 'TaskDialog']) {
    for (const stale of ['replaced', 'disconnected', 'dead', 'input']) {
      if (method === 'TaskDialog' && stale === 'input') continue;
      const ide = { connected: true, saveRequests: new Map(), inputOperation: {} }; const input = ide.inputOperation;
      let answer; const sent = [];
      const D = { ide, send: (...args) => sent.push(args), util: {
        optionsDialog: (_, callback) => { answer = callback; }, taskDialog: (_, callback) => { answer = callback; },
      } };
      const text = source('src/ide.js');
      const end = method === 'OptionsDialog' ? '    StringDialog(x) {' : '    ReplyClearTraceStopMonitor(x) {';
      const handler = vm.runInNewContext(`({${text.slice(text.indexOf(`    ${method}(x) {`), text.indexOf(end))}}).${method}`, { ide, D });
      handler({ text: 'INPUT LIMIT', type: 4, options: ['OK'], token: 19 });
      if (stale === 'replaced') D.ide = {};
      if (stale === 'disconnected') ide.connected = false;
      if (stale === 'dead') ide.dead = true;
      if (stale === 'input') ide.inputOperation = {};
      answer(0); assert.deepEqual(sent, []); assert.equal(input.reply, undefined);
    }
  }
});
