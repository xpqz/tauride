const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = process.env.TAURIDE_TEST_ROOT || path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const plain = x => JSON.parse(JSON.stringify(x));

function load() {
  const sent = []; const errors = []; const emitted = [];
  class Range {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
    }
  }
  class Selection extends Range {
    constructor(selectionStartLineNumber, selectionStartColumn, positionLineNumber, positionColumn) {
      super(selectionStartLineNumber, selectionStartColumn, positionLineNumber, positionColumn);
      Object.assign(this, { selectionStartLineNumber, selectionStartColumn, positionLineNumber, positionColumn });
    }
  }
  const pref = () => 0;
  const D = { prf: new Proxy({}, { get: () => pref }), send: (...x) => sent.push(plain(x)),
    refreshInlineTracingMenu() {}, refreshOutputCommandMenu() {}, wins: {},
    outputCommands: { BXO: ']box off', BXMAX: ']box on -style=max', BXQ: ']box ?',
      BXH: ']box -??', RWW: ']rows on -style=wrap', RWFO: ']rows on -fold=off',
      RWF0: ']rows on -fold=0', RWQ: ']rows ?', RWH: ']rows -??' } };
  const context = vm.createContext({ D, I: {}, window: {}, console,
    monaco: { Range, Selection, editor: { EditorOption: { lineHeight: 1 } } },
    toastr: { warning: x => errors.push(x), error: x => errors.push(x) },
    $: { err: x => errors.push(x) }, setTimeout() {}, clearTimeout() {} });
  ['src/ide.js', 'src/se.js', 'src/ed.js'].forEach(file => vm.runInContext(source(file), context));
  const ide = Object.assign(Object.create(D.IDE.prototype), {
    connected: true, promptReceived: true, promptType: 1, pending: [], inputOperation: null,
    wins: {}, hadErr: -1, getStats() {}, quiescent: () => true,
    ipc: { emit: (...x) => emitted.push(plain(x)) },
  });
  D.ide = ide; D.wins = ide.wins; context.ide = ide;
  const text = source('src/ide.js');
  const handler = (name, next) => {
    const begin = text.indexOf(`    ${name}(`);
    return vm.runInContext(`({${text.slice(begin, text.indexOf(`    ${next}(`, begin))}}).${name}`, context);
  };
  return { D, ide, sent, errors, emitted, Range, Selection, handler };
}

function session(api, dirty = true) {
  let value = dirty ? '      changed history\n2\n      ⍝ unsent draft' : '      1+1\n2\n      ';
  let selections = [new api.Selection(3, 10, 3, 17)];
  const offset = (line, column) => {
    const lines = value.split('\n');
    return lines.slice(0, line - 1).reduce((sum, s) => sum + s.length + 1, 0) + column - 1;
  };
  const model = {
    getValue: () => value, getLinesContent: () => value.split('\n'),
    getLineCount: () => value.split('\n').length,
    getLineContent: line => value.split('\n')[line - 1] || '',
    getLineMaxColumn: line => (value.split('\n')[line - 1] || '').length + 1,
    _commandManager: { clear() {} },
  };
  const me = {
    getModel: () => model, getValue: () => value,
    getPosition: () => ({ lineNumber: selections[0].positionLineNumber, column: selections[0].positionColumn }),
    getSelections: () => selections, setSelections: s => {
      selections = s.map(x => new api.Selection(x.selectionStartLineNumber,
        Math.min(x.selectionStartColumn, model.getLineMaxColumn(x.selectionStartLineNumber)),
        x.positionLineNumber, Math.min(x.positionColumn, model.getLineMaxColumn(x.positionLineNumber))));
    },
    setPosition: p => { selections = [new api.Selection(p.lineNumber, p.column, p.lineNumber, p.column)]; },
    executeEdits(_, edits, s) {
      edits.forEach(e => {
        const a = offset(e.range.startLineNumber, e.range.startColumn);
        const b = offset(e.range.endLineNumber, e.range.endColumn);
        value = value.slice(0, a) + e.text + value.slice(b);
      });
      if (s) selections = s;
    },
    getOption: () => 20, onKeyDown: () => ({ dispose() {} }), updateOptions() {}, revealLine() {}, setScrollLeft() {}, getScrollTop: () => 0,
    setScrollTop() {}, getTopForLineNumber: line => line * 20,
  };
  const se = Object.assign(Object.create(api.D.Se.prototype), {
    ide: api.ide, id: 0, me, promptType: 1, dirty: dirty ? { 1: '      1+1', 3: '      ' } : {},
    lines: [{ text: '      1+1\n', type: 14 }, { text: '2\n', type: 1 }],
    multiLineBlocks: {}, lineEditor: {}, taBuffer: [], dom: { clientHeight: 100 },
    setDecorations() {}, setPendent() {}, focus() {},
  });
  me.dyalogCmds = se;
  api.ide.wins[0] = se; api.ide.focusedWin = se;
  return se;
}

function setupSend(api) {
  Object.assign(api.ide, { pasteSources: new Set(), pasteStarts: new Map(),
    pasteFinishes: new Map(), saveRequests: new Map() });
  const text = source('src/ide.js');
  vm.runInNewContext(text.slice(text.indexOf('  if (!ide.floating)'), text.indexOf('  // The interpreter')), {
    ide: api.ide, D: api.D,
  });
}

function promptHandler(api, se) {
  const text = source('src/ide.js');
  const start = text.indexOf('    SetPromptType(');
  const end = text.indexOf('    HadError(', start);
  api.ide.updateInputState = () => {};
  return vm.runInNewContext(`({${text.slice(start, end)}}).SetPromptType`, {
    ide: api.ide, D: api.D, eachWin: f => f(se), monaco: { Range: api.Range }, setTimeout() {},
  });
}

function server(api) {
  const handlers = {}; const broadcasts = [];
  api.D.ipc = { config: {}, serve: f => f(), server: { start() {}, emit() {},
    on: (name, callback) => { handlers[name] = callback; },
    broadcast: (...args) => broadcasts.push(plain(args)),
  } };
  vm.runInNewContext(source('src/ipc.js'), { D: api.D, setTimeout, clearTimeout });
  api.D.IPC_Server();
  return { handlers, broadcasts };
}

test('output commands use authoritative ready state without requiring an inline tracer', () => {
  const api = load(); const se = session(api); setupSend(api);
  assert.equal(typeof api.ide.canRunOutputCommand, 'function');
  assert.equal(typeof api.ide.runOutputCommand, 'function');
  assert.equal(api.ide.canRunOutputCommand(), true);
  const reject = () => {
    const before = plain(se.me.getValue());
    api.ide.runOutputCommand('BXMAX', se.me);
    assert.equal(api.sent.length, 0, 'the unavailable dispatcher never sends Execute');
    assert.ok(!se.preserveDraft, 'rejection never changes preservation');
    assert.equal(se.me.getValue(), before);
  };
  for (const type of [0, 2, 3, 4, 5, 99]) {
    api.ide.promptType = type; assert.equal(api.ide.canRunOutputCommand(), false); reject();
  }
  api.ide.promptType = 1;
  for (const property of ['inputOperation', 'inlineInspection']) {
    api.ide[property] = {}; assert.equal(api.ide.canRunOutputCommand(), false); reject(); api.ide[property] = null;
  }
  api.ide.pending = ['later']; reject(); api.ide.pending = [];
  api.ide.promptReceived = false; reject(); api.ide.promptReceived = true;
  api.ide.connected = false; reject(); api.ide.connected = true;
  api.ide.dead = true; reject(); api.ide.dead = false;
  api.ide.quiescent = () => false; reject(); api.ide.quiescent = () => true;
  api.ide.runOutputCommand('constructor', se.me);
  api.ide.runOutputCommand('unknown', se.me);
  assert.equal(api.sent.length, 0, 'only registered output command codes are accepted');
});

test('output dispatch sends the exact registered command and refuses an overlapping operation', () => {
  for (const [code, text] of Object.entries(load().D.outputCommands)) {
    const api = load(); const se = session(api); setupSend(api);
    assert.equal(typeof api.ide.runOutputCommand, 'function');
    api.ide.runOutputCommand(code, se.me);
    assert.deepEqual(api.sent, [['Execute', { text: `${text}\n`, trace: 0 }]]);
    assert.equal(se.preserveDraft, true);
    api.ide.runOutputCommand('BXO', se.me);
    assert.equal(api.sent.length, 1);
    assert.deepEqual(Array.from(api.ide.pending), []);
  }
});

for (const echo of ['EchoInput', 'AppendSessionOutput']) {
  test(`${echo} output settings preserve draft, modified history, partial query/help output and selections`, () => {
    const api = load(); const se = session(api); setupSend(api);
    se.me.setSelections([new api.Selection(1, 3, 1, 10), new api.Selection(3, 19, 3, 10)]);
    assert.equal(typeof api.ide.runOutputCommand, 'function');
    api.ide.runOutputCommand('BXQ', se.me);
    const prompt = promptHandler(api, se);
    prompt({ type: 0 });
    if (echo === 'EchoInput') api.handler('EchoInput', 'SetPromptType')({ input: ']box ?\n' });
    else se.add([{ text: ']box ?\n', type: 14 }]);
    se.add([{ text: 'Boxing is ', type: 1 }]);
    se.add([{ text: 'on\n', type: 1 }]);
    prompt({ type: 1 });
    assert.deepEqual(se.me.getValue().split('\n'), [
      '      changed history', '2', ']box ?', 'Boxing is on', '      ⍝ unsent draft',
    ]);
    const selections = se.me.getSelections();
    assert.equal(selections[0].selectionStartLineNumber, 1);
    assert.equal(selections[1].selectionStartLineNumber, 5);
    assert.equal(selections[1].selectionStartColumn, 19);
    assert.equal(selections[1].positionColumn, 10);
    assert.equal(se.dirty[1], '      1+1');
    assert.equal(se.dirty[5], '      ');
    assert.ok(!se.preserveDraft);
    assert.equal(api.ide.canRunOutputCommand(), true);
  });
}

for (const historySelection of [false, true]) {
  test(`output command restores a clean prompt with ${historySelection ? 'reversed history selection' : 'the normal prompt caret'}`, () => {
    const api = load(); const se = session(api, false); setupSend(api);
    se.me.setSelections(historySelection
      ? [new api.Selection(1, 10, 1, 7)] : [new api.Selection(3, 7, 3, 7)]);
    api.ide.runOutputCommand('BXMAX', se.me);
    const prompt = promptHandler(api, se);
    prompt({ type: 0 });
    se.add([{ text: ']box on -style=max\n', type: 14 }]);
    se.add([{ text: 'Was -style=min\n', type: 1 }]);
    prompt({ type: 1 });
    assert.deepEqual(se.me.getModel().getLinesContent(), [
      '      1+1', '2', ']box on -style=max', 'Was -style=min', '      ',
    ]);
    const selection = se.me.getSelections()[0];
    assert.equal(selection.selectionStartLineNumber, historySelection ? 1 : 5);
    assert.equal(selection.positionLineNumber, historySelection ? 1 : 5);
    assert.equal(selection.selectionStartColumn, historySelection ? 10 : 7);
    assert.equal(selection.positionColumn, 7);
    assert.deepEqual(plain(se.dirty), {}, 'a clean prompt stays clean');
    assert.ok(!se.preserveDraft);
  });
}

test('clean prompt remains separate from partial and chunked command output', () => {
  const api = load(); const se = session(api, false); setupSend(api);
  se.me.setSelections([new api.Selection(3, 7, 3, 7)]);
  api.ide.runOutputCommand('BXQ', se.me);
  const prompt = promptHandler(api, se);
  prompt({ type: 0 });
  se.add([{ text: ']box ?\n', type: 14 }]);
  se.add([{ text: 'Boxing is ', type: 1 }]);
  assert.deepEqual(se.me.getModel().getLinesContent().slice(-2), ['Boxing is ', '      ']);
  se.add([{ text: 'on\n', type: 1 }]);
  prompt({ type: 1 });
  assert.deepEqual(se.me.getModel().getLinesContent().slice(-2), ['Boxing is on', '      ']);
  assert.equal(se.me.getPosition().column, 7);
  assert.deepEqual(plain(se.dirty), {}, 'completed output leaves a clean prompt');
  se.undoChanges();
  assert.deepEqual(se.me.getModel().getLinesContent().slice(-2), ['Boxing is on', '      ']);
});

test('generic preservation releases on ready or unexpected input prompts without an inline marker', () => {
  for (const type of [1, 2, 4]) {
    const api = load(); const se = session(api);
    se.preserveDraft = true;
    const prompt = promptHandler(api, se);
    prompt({ type: 0 });
    api.handler('EchoInput', 'SetPromptType')({ input: ']rows ?\n' });
    prompt({ type });
    assert.ok(!se.preserveDraft, `prompt ${type} releases the preservation scope`);
    assert.equal(se.me.getValue().split('\n').at(-1), '      ⍝ unsent draft');
  }
});

test('output command failure retains canonical error output and releases preservation on prompt return', () => {
  const api = load(); const se = session(api); setupSend(api);
  assert.equal(typeof api.ide.runOutputCommand, 'function');
  api.ide.runOutputCommand('BXMAX', se.me);
  const prompt = promptHandler(api, se);
  prompt({ type: 0 });
  se.add([{ text: 'command unavailable\n', type: 5 }]);
  api.handler('HadError', 'GotoWindow')();
  prompt({ type: 1 });
  assert.ok(se.me.getValue().includes('command unavailable'));
  assert.equal(se.me.getValue().split('\n').at(-1), '      ⍝ unsent draft');
  assert.ok(!se.preserveDraft);
  api.ide.updTitle = () => {};
  api.ide.dom = { classList: { add() {} } }; se.die = () => {};
  api.ide.runOutputCommand('RWQ', se.me);
  api.ide.die();
  assert.ok(!se.preserveDraft);
  assert.equal(api.ide.canRunOutputCommand(), false);
});

test('floating output requests reach only the owning server and are rechecked against real prompt state', () => {
  const api = load(); const se = session(api); setupSend(api); const own = server(api);
  const proxy = new api.D.IPC_WindowProxy(50, {}); proxy.id = 7; api.ide.wins[7] = proxy;
  const floating = Object.assign(Object.create(api.D.IDE.prototype), {
    floating: true, connected: true, promptType: 1, wins: { 7: { id: 7 } },
    ipc: { emit: (...args) => api.emitted.push(plain(args)) },
  });
  const me = { dyalogCmds: floating.wins[7] };
  assert.equal(typeof floating.runOutputCommand, 'function');
  assert.equal(floating.canRunOutputCommand(), false, 'initial floating ready state is not authoritative');
  floating.runOutputCommand('RWW', me);
  assert.deepEqual(api.emitted, [['runOutputCommand', ['RWW', 7]]]);
  assert.equal(api.sent.length, 0);
  assert.equal(typeof own.handlers.runOutputCommand, 'function');
  api.ide.promptType = 4;
  own.handlers.runOutputCommand(['RWW', 7]);
  assert.equal(api.sent.length, 0);
  assert.ok(!se.preserveDraft);
  api.ide.promptType = 1;
  own.handlers.runOutputCommand(['RWW', 7]);
  assert.deepEqual(api.sent, [['Execute', { text: ']rows on -style=wrap\n', trace: 0 }]]);
  const other = load(); session(other); setupSend(other);
  assert.equal(other.sent.length, 0, 'another session receives no command');
  api.ide.inputOperation = null; se.preserveDraft = false;
  own.handlers.runOutputCommand(['BXO', 99]);
  assert.equal(api.sent.length, 1, 'closed or unknown floating panes cannot send commands');
});

test('output menu readiness refreshes when inline readiness is unchanged', () => {
  const api = load(); session(api); const own = server(api);
  assert.equal(typeof api.ide.refreshOutputCommandState, 'function');
  api.ide.refreshInlineInspectionState();
  assert.ok(own.broadcasts.some(([name, value]) => name === 'outputCommandState' && value === true));
  api.ide.promptType = 2;
  api.ide.refreshInlineInspectionState();
  assert.ok(own.broadcasts.some(([name, value]) => name === 'outputCommandState' && value === false),
    'ordinary Session input-mode changes refresh without an inline tracer');
});
