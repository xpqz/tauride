const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/ide.js'), 'utf8');

function load() {
  let title = 'thread {tid} / {PID}';
  const captions = [];
  const cell = () => ({ classList: { toggle() {} }, hidden: false });
  const I = {};
  for (const name of ['ml', 'io', 'sis', 'trap', 'dq', 'threads', 'cc', 'gc']) I[`sb_${name}`] = cell();
  const document = { title: '' };
  const pref = Object.assign(() => 0, { toggle() {} });
  const prf = new Proxy({ title: () => title }, { get: (object, key) => object[key] || pref });
  const D = {
    prf,
    remoteIdentification: { arch: 'U/64', version: '20.0', pid: 8123 },
    versionInfo: { version: '4.8' },
    ipc: { server: { broadcast: (_, caption) => captions.push(caption) } },
  };
  const context = vm.createContext({ D, I, document, toggleStats() {}, clearTimeout() {} });
  vm.runInContext(source, context);
  const ide = Object.assign(Object.create(D.IDE.prototype), {
    connected: 1, hasSubscribe: true, wsid: 'ws', host: 'localhost', port: 4502,
    profile: 'default', dom: { classList: { add() {} } }, updateInputState() {},
    saveRequests: new Map(), pasteSources: new Set(), pasteFinishes: new Map(),
    pasteStarts: new Map(), wins: { 0: { die() {} } },
  });
  context.ide = ide;
  D.ide = ide;
  function handler(name, next) {
    const start = source.indexOf(`    ${name}(`);
    const end = source.indexOf(`    ${next}(`, start);
    return vm.runInContext(`({${source.slice(start, end)}}).${name}`, context);
  }
  const status = handler('InterpreterStatus', 'ReplyFormatCode');
  const unknownStart = source.indexOf('    UnknownCommand(');
  const unknownEnd = source.indexOf('\n  };', unknownStart);
  const unknown = vm.runInContext(`({${source.slice(unknownStart, unknownEnd)}}).UnknownCommand`, context);
  return { ide, document, captions, status, unknown,
    renderTemplate(value) { title = value; ide.updTitle(); } };
}

function status(tid) {
  return { ML: 1, IO: 1, SI: 0, TRAP: 0, DQ: 0, NumThreads: 1,
    CompactCount: 0, GarbageCount: 0, ...tid };
}

test('caption shows an unknown thread until status reports a valid nonnegative integer', () => {
  const app = load();
  app.ide.updTitle();
  assert.equal(app.document.title, 'thread ? / 8123');
  app.status(status({ TID: 0 }));
  assert.equal(app.document.title, 'thread 0 / 8123');
  app.status(status({ TID: 7 }));
  assert.equal(app.document.title, 'thread 7 / 8123');
  assert.equal(app.captions.at(-1), app.document.title);
  const broadcasts = app.captions.length;
  app.status(status({ TID: 7 }));
  assert.equal(app.captions.length, broadcasts);
  app.status(status({ TID: 8 }));
  assert.equal(app.captions.length, broadcasts + 1);
  assert.equal(app.captions.at(-1), 'thread 8 / 8123');
});

test('partial status retains the live thread; an explicitly invalid ID clears it', () => {
  const app = load();
  app.status(status({ TID: 4 }));
  app.status(status({ IO: 0 }));
  assert.equal(app.document.title, 'thread 4 / 8123');
  app.status(status({ TID: -1 }));
  assert.equal(app.document.title, 'thread ? / 8123');
  app.status(status({ TID: null }));
  assert.equal(app.document.title, 'thread ? / 8123');
});

test('disconnect and unsupported status subscription clear the last known thread', () => {
  const disconnected = load();
  disconnected.status(status({ TID: 3 }));
  disconnected.ide.die();
  assert.equal(disconnected.document.title, 'thread ? / 8123');
  disconnected.status(status({ TID: 9 }));
  assert.equal(disconnected.document.title, 'thread ? / 8123');

  const unsupported = load();
  unsupported.status(status({ TID: 5 }));
  unsupported.unknown({ name: 'Subscribe' });
  assert.equal(unsupported.document.title, 'thread ? / 8123');
  unsupported.status(status({ TID: 9 }));
  assert.equal(unsupported.document.title, 'thread ? / 8123');
});

test('caption templates render the current thread case-insensitively with other placeholders', () => {
  const app = load();
  app.status(status({ TID: 6 }));
  app.renderTemplate('{TiD} @ {PROFILE}');
  assert.equal(app.document.title, '6 @ default');
  app.renderTemplate('{CAPTION}');
  assert.equal(app.document.title, 'ws');
  app.renderTemplate('tid={TID}');
  assert.equal(app.document.title, 'tid=6');
});

test('legacy title-only mode does not poll threads', () => {
  const start = source.indexOf('  const toggleStats = () => {');
  const end = source.indexOf('\n  };', start) + '\n  };'.length;
  let statusBar = 0;
  let polls = 0;
  let timers = 0;
  const ide = { floating: false, hasSubscribe: false, getStats() { polls += 1; } };
  const D = { prf: { sbar: () => statusBar, title: () => 'thread {TID}', dbg: () => 0 } };
  const context = vm.createContext({ ide, D,
    setInterval() { timers += 1; return timers; }, clearInterval() { timers -= 1; } });
  const toggleStats = vm.runInContext(`(() => { let statsTid = 0; ${source.slice(start, end)}; return toggleStats; })()`, context);
  toggleStats();
  assert.equal(polls, 0);
  assert.equal(timers, 0);
  statusBar = 1;
  toggleStats();
  assert.equal(polls, 1);
  assert.equal(timers, 1);
  statusBar = 0;
  toggleStats();
  assert.equal(timers, 0);
});

test('status subscriptions pass the protocol send guard while the interpreter is busy', () => {
  const cn = fs.readFileSync(path.join(__dirname, '../src/cn.js'), 'utf8');
  const start = cn.indexOf('    D.send = (x, y) => {');
  const end = cn.indexOf('\n    };', start) + '\n    };'.length;
  const sent = [];
  const D = { ide: { promptType: 0 } };
  vm.runInNewContext(cn.slice(start, end), { D, sendEach: messages => sent.push(...messages) });
  D.send('Subscribe', { status: ['statusfields'] });
  D.send('Subscribe', { status: [] });
  D.send('Execute', { text: '1+1\n' });
  assert.deepEqual(sent.map(JSON.parse), [
    ['Subscribe', { status: ['statusfields'] }],
    ['Subscribe', { status: [] }],
  ]);
  D.ide.promptType = 1;
  D.send('Execute', { text: '1+1\n' });
  assert.equal(JSON.parse(sent.at(-1))[0], 'Execute');
});

test('floating caption event updates the focused mounted editor and tolerates a pending editor', () => {
  const ipcSource = fs.readFileSync(path.join(__dirname, '../src/ipc.js'), 'utf8');
  const handlers = {};
  const ide = { wins: {}, caption: 'old', getMRUWin() { return this.wins[1] || null; } };
  const D = {
    ide,
    IDE: function IDE() { return ide; },
    ipc: { config: {}, connectTo: (_, ready) => ready(),
      of: { ride_master: { on: (name, listener) => { handlers[name] = listener; }, emit() {} } } },
  };
  vm.runInNewContext(ipcSource, { D, window: {}, setTimeout() {} });
  D.IPC_Client(46001);
  const first = { id: 1, container: {}, title: 'first-old',
    updateTitle() { this.title = `first-${ide.caption}`; } };
  const second = { id: 2, container: {}, title: 'second-old',
    updateTitle() { this.title = `second-${ide.caption}`; } };
  ide.wins = { 1: first, 2: second };
  ide.focusedWin = second;
  handlers.caption('thread 7');
  assert.equal(first.title, 'first-old');
  assert.equal(second.title, 'second-thread 7');

  ide.focusedWin = { id: 2 }; // the focused editor was replaced before the event arrived
  handlers.caption('thread 8');
  assert.equal(first.title, 'first-thread 8');
  assert.equal(second.title, 'second-thread 7');

  first.container = null;
  ide.getMRUWin = () => null;
  assert.doesNotThrow(() => handlers.caption('thread 9'));
  assert.equal(ide.caption, 'thread 9');
});
