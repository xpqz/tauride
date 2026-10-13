const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function gate() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function preferences() {
  const ready = gate();
  const emitted = [];
  const shown = [];
  const D = {
    el: {},
    ipc: { server: { emit: (...args) => emitted.push(args) } },
    ensureHelper: kind => {
      assert.equal(kind, 'prf');
      D.prf_bw = { socket: 'preferences', win: { show: () => shown.push('preferences') } };
      return ready.promise;
    },
  };
  const $ = () => ({});
  $.err = error => { throw new Error(error); };
  const context = vm.createContext({ D, I: {}, $ });
  vm.runInContext(source('src/prf_ui.js'), context);
  return { D, ready, emitted, shown };
}

test('Preferences first use waits for its IPC handshake and keeps its requested tab', async () => {
  const { D, ready, emitted, shown } = preferences();
  D.prf_ui('shc');
  assert.deepEqual(emitted, []);
  assert.deepEqual(shown, []);
  ready.resolve(D.prf_bw);
  await tick();
  assert.deepEqual(emitted, [['preferences', 'show', 'shc']]);
  assert.deepEqual(shown, ['preferences']);
});

function dialogs() {
  const ready = gate();
  const emitted = [];
  const shown = [];
  const D = {
    el: { dialog: { showMessageBox: async () => ({ response: 0 }) } },
    ipc: { server: { emit: (...args) => emitted.push(args) } },
    prf: { confirmations: () => ({}) },
    ensureHelper: kind => {
      assert.equal(kind, 'dialog');
      D.dlg_bw = { socket: 'dialog', win: { show: () => shown.push('dialog') } };
      return ready.promise;
    },
  };
  const $ = {};
  vm.runInNewContext(source('src/util.js'), { D, $, window: { __RIDE__: true }, setTimeout });
  return { D, ready, emitted, shown, $ };
}

test('early interpreter string dialogs wait for the helper and retain callbacks', async () => {
  const { D, ready, emitted, shown } = dialogs();
  const replies = [];
  D.util.stringDialog({ token: 17, text: 'Name?' }, value => replies.push(value));
  D.util.stringDialog({ token: 18, text: 'Password?' }, value => replies.push(value));
  assert.deepEqual(emitted, []);
  assert.deepEqual(shown, []);
  ready.resolve(D.dlg_bw);
  await tick();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'dialog');
  assert.equal(emitted[0][1], 'show');
  assert.equal(emitted[0][2].token, 17);
  assert.deepEqual(shown, ['dialog']);
  D.util.replyDialog(17, { index: 'Alice' });
  assert.deepEqual(replies, ['Alice']);
  await tick();
  assert.equal(emitted.length, 2, 'second request starts after first reply');
  assert.equal(emitted[1][2].token, 18);
  D.util.replyDialog(18, { index: 'secret' });
  assert.deepEqual(replies, ['Alice', 'secret']);
});

test('a replaced interpreter cannot receive an early dialog reply after helper readiness', async () => {
  const { D, ready, emitted } = dialogs();
  const old = { dead: false };
  const replacement = { dead: false };
  const replies = [];
  D.ide = old;
  D.util.stringDialog({ token: 21, text: 'Old session?' }, value => replies.push(value));
  old.dead = true;
  D.ide = replacement;
  ready.resolve(D.dlg_bw);
  await tick();
  assert.deepEqual(replies, []);
  assert.deepEqual(emitted, []);
  D.util.stringDialog({ token: 22, text: 'New session?' }, value => replies.push(value));
  await tick();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][2].token, 22);
  D.util.replyDialog(22, { index: 'new' });
  assert.deepEqual(replies, ['new']);
});

test('a failed helper does not answer a dead interpreter or stall its next dialog', async () => {
  const { D, ready, emitted, $ } = dialogs();
  const old = { dead: false };
  const replies = [];
  const errors = [];
  $.err = message => errors.push(message);
  D.ide = old;
  D.util.stringDialog({ token: 31 }, value => replies.push(value));
  old.dead = true;
  D.ide = { dead: false };
  ready.reject(new Error('creation failed'));
  await tick();
  assert.deepEqual(replies, []);
  assert.deepEqual(emitted, []);
  assert.deepEqual(errors, []);
});

test('status output waits for the helper and retains the first message with auto-show off', async () => {
  const ready = gate();
  const emitted = [];
  const D = { el: {}, ipc: { server: { emit: (...args) => emitted.push(args) } },
    prf: { statusWindow: () => 0, autoStatus: () => 0 },
    ensureHelper(kind) {
      assert.equal(kind, 'status');
      D.stw_bw = { socket: 'status', win: { show() {} } };
      return ready.promise;
    } };
  const ide = { dead: false };
  D.ide = ide;
  const text = source('src/ide.js');
  const start = text.indexOf('    StatusOutput(x) {');
  const end = text.indexOf('    ReplyGetLog(x) {', start);
  const context = vm.createContext({ D, ide, $: { err: error => { throw new Error(error); } } });
  const handler = vm.runInContext(`({${text.slice(start, end)}}).StatusOutput`, context);
  const output = { text: 'first output', flags: 1 };
  handler(output);
  handler({ text: 'second output', flags: 2 });
  assert.deepEqual(emitted, []);
  ready.resolve(D.stw_bw);
  await tick();
  assert.deepEqual(emitted.map(([, event, data]) => [event, data.text]),
    [['add', 'first output'], ['add', 'second output']]);
});

test('status helper finishing after interpreter replacement does not steal focus', async () => {
  const ready = gate();
  const shown = [];
  let changed;
  const statusWindow = arg => {
    if (typeof arg === 'function') { changed = arg; return; }
    return 1;
  };
  const ide = { dead: false, focusMRUWin() {} };
  const D = { ide, prf: { statusWindow }, ensureHelper: () => ready.promise };
  const text = source('src/ide.js');
  const start = text.indexOf('  D.prf.statusWindow((x) => {');
  const end = text.indexOf('  D.prf.menu(updMenu);', start);
  vm.runInNewContext(text.slice(start, end), { D, ide, updMenu() {}, $: { err() {} } });
  changed(1);
  D.ide = { dead: false };
  ready.resolve({ win: { show: () => shown.push(true) } });
  await tick();
  assert.deepEqual(shown, []);
});

function ipcServer() {
  const handlers = {};
  const emitted = [];
  const creations = [];
  const destroyed = [];
  const pending = [];
  const D = {
    ipc: { config: {}, serve(callback) {
      this.server = {
        on: (name, handler) => { handlers[name] = handler; },
        emit: (...args) => emitted.push(args),
        start() {},
      };
      callback();
    } },
    db: { _getAll: () => ({ title: 'changed while loading' }) },
    prf: { title: () => 'current title', statusWindow: () => 0 },
    theme: 'dark',
  };
  vm.runInNewContext(source('src/ipc.js'), { D, Date, console, setTimeout, clearTimeout });
  const factories = Object.fromEntries(['prf', 'dialog', 'status'].map(kind => [kind, () => {
    creations.push(kind);
    const ready = gate();
    pending.push(ready);
    const label = `${kind}-${creations.length}`;
    const win = { label, ready: ready.promise, onClosed() {},
      destroy: () => destroyed.push(label), close() { throw new Error('close request cannot destroy helper'); } };
    return { id: creations.length + 10, win };
  }]));
  D.IPC_Server(factories);
  return { D, handlers, emitted, creations, pending, destroyed };
}

test('IPC helper creation is shared and waits for matching client registration', async () => {
  const { D, handlers, emitted, creations, pending } = ipcServer();
  assert.deepEqual(creations, []);
  assert.equal(typeof D.ensureHelper, 'function');
  const first = D.ensureHelper('prf');
  const second = D.ensureHelper('prf');
  assert.deepEqual(creations, ['prf']);
  pending[0].resolve();
  await tick();
  let settled = false;
  first.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  const socket = { label: 'prf-1' };
  handlers.prfCreated(null, socket);
  await Promise.all([first, second]);
  assert.equal(D.prf_bw.socket, socket);
  assert.deepEqual(emitted.filter(([, name]) => name === 'prf').map(([, , [key, value]]) => [key, value]),
    [['title', 'current title'], ['statusWindow', 0]]);
});

test('helper creation failures reject and a later call retries', async () => {
  const { D, creations, pending, handlers, destroyed } = ipcServer();
  const first = D.ensureHelper('dialog');
  pending[0].reject(new Error('create failed'));
  await assert.rejects(first, /create failed/);
  assert.deepEqual(destroyed, ['dialog-1']);
  const second = D.ensureHelper('dialog');
  assert.notEqual(second, first);
  assert.deepEqual(creations, ['dialog', 'dialog']);
  pending[1].resolve();
  handlers.dialogCreated(null, { label: 'dialog-1' });
  await tick();
  assert.equal(D.dlg_bw.socket, undefined, 'late registration from failed window is ignored');
  handlers.dialogCreated(null, { label: 'dialog-2' });
  await second;
});

test('splash markup, styles and startup gate are absent', () => {
  assert.equal(/id=splash\b/.test(source('index.html')), false, 'splash DOM');
  assert.equal(/I\.splash/.test(source('src/init.js')), false, 'splash startup gate');
  assert.equal(/#splash/.test(source('style/less/layout/windows.less')), false, 'splash layout');
  assert.equal(/#splash/.test(source('style/less/colour/setup.less')), false, 'splash colours');
});
