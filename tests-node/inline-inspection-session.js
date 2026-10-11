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
    refreshInlineTracingMenu() {}, wins: {} };
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
    getSelections: () => selections, setSelections: s => { selections = s; },
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
  api.ide.wins[0] = se;
  return se;
}

function tracer(api, id = 7) {
  const ed = { id, tc: true, entityType: 65536, HIGHLIGHT: { lineStart: 1, lineEnd: 1, colStart: 6, colEnd: 7 },
    focus() { api.ide.focusedWin = ed; }, execCommand: code => ed[code](), SetHighlightLine() {} };
  ed.me = { dyalogCmds: ed }; api.ide.wins[id] = ed; api.ide.focusedWin = ed;
  return ed;
}

test('inspection availability follows ranged protocol highlights and authoritative input state', () => {
  const api = load(); session(api); const ed = tracer(api);
  assert.equal(typeof api.ide.canInspectInline, 'function');
  assert.equal(api.ide.canInspectInline(), true);
  const reject = () => {
    api.ide.openInlineInspection('Left', ed.me);
    assert.equal(api.sent.length, 0, 'unavailable inspections never dispatch');
    assert.ok(!api.ide.wins[0].preserveDraft, 'rejection never changes draft handling');
  };
  for (const type of [0, 2, 3, 4, 5, 99]) {
    api.ide.promptType = type; assert.equal(api.ide.canInspectInline(), false, `prompt ${type}`); reject();
  }
  api.ide.promptType = 1;
  for (const property of ['dead', 'inputOperation']) {
    api.ide[property] = {}; assert.equal(api.ide.canInspectInline(), false, property); reject(); api.ide[property] = null;
  }
  api.ide.pending = ['later']; assert.equal(api.ide.canInspectInline(), false); reject(); api.ide.pending = [];
  api.ide.connected = false; assert.equal(api.ide.canInspectInline(), false); reject(); api.ide.connected = true;
  api.ide.quiescent = () => false; assert.equal(api.ide.canInspectInline(), false); reject(); api.ide.quiescent = () => true;
  ed.entityType = 1;
  ed.HIGHLIGHT = { lineStart: 1, lineEnd: 1, colStart: 0, colEnd: 0 };
  assert.equal(api.ide.canInspectInline(), false, 'ordinary tracer cannot advertise inline views');
  ed.name = '⎕SE.Inline.Left'; assert.equal(api.ide.canInspectInline(), false, 'name is not capability');
});

test('all nine inspection requests use the owning session and reject overlapping dispatch', () => {
  const aspects = ['Left', 'Function', 'Right', 'Axis', 'Result', 'PLeft', 'PFunction', 'PRight', 'PAxis'];
  for (const aspect of aspects) {
    const api = load(); session(api); const ed = tracer(api);
    assert.equal(typeof api.ide.openInlineInspection, 'function');
    api.ide.openInlineInspection(aspect, ed.me);
    assert.deepEqual(api.sent, [['Execute', { text: `]IT.${aspect}\n`, trace: 0 }]]);
    api.ide.openInlineInspection('Right', ed.me);
    assert.equal(api.sent.length, 1, 'second command before acknowledgement must be rejected');
    assert.deepEqual(Array.from(api.ide.pending), []);
  }
  const first = load(); session(first); const ed = tracer(first);
  const second = load(); session(second); tracer(second);
  first.ide.openInlineInspection('Left', ed.me);
  assert.equal(second.sent.length, 0, 'another session does not receive the command');
});

for (const echo of ['EchoInput', 'AppendSessionOutput']) {
  test(`${echo} inspection cycle preserves earlier dirty history, draft, and selection`, () => {
    const api = load(); const se = session(api); tracer(api);
    const selection = plain(se.me.getSelections());
    // Preservation applies for the entire inspection command, including output and prompt changes.
    se.preserveDraft = true;
    se.prompt(0);
    if (echo === 'EchoInput') api.handler('EchoInput', 'SetPromptType')({ input: ']IT.Left\n' });
    else se.add([{ text: ']IT.Left\n', type: 14, group: 0 }]);
    se.add([{ text: 'inspection output\n', type: 1, group: 0 }]);
    se.prompt(1);
    const lines = se.me.getValue().split('\n');
    assert.equal(lines[0], '      changed history');
    assert.equal(lines.at(-1), '      ⍝ unsent draft');
    assert.ok(lines.includes(']IT.Left'), 'command remains in canonical history');
    assert.ok(lines.includes('inspection output'), 'output remains visible');
    assert.deepEqual(plain(se.me.getSelections()), selection.map(s => ({ ...s,
      startLineNumber: lines.length, endLineNumber: lines.length,
      selectionStartLineNumber: lines.length, positionLineNumber: lines.length })));
    assert.equal(se.dirty[1], '      1+1');
    assert.equal(se.dirty[lines.length], '      ');
  });
}

test('explicit interpreter GotoWindow continues to refocus an inspection view', () => {
  const api = load(); session(api); const ed = tracer(api);
  const aspect = { id: 12, specialWindow: 16, focus() { api.ide.focusedWin = aspect; } };
  api.ide.wins[12] = aspect;
  const goto = api.handler('GotoWindow', 'WindowTypeChanged');
  goto({ win: 12 });
  assert.equal(api.ide.focusedWin, aspect, 'existing user commands retain explicit refocus');
  api.ide.focusedWin = ed;
  assert.equal(typeof api.ide.openInlineInspection, 'function');
  api.ide.openInlineInspection('Left', ed.me);
  goto({ win: 12 });
  assert.equal(api.ide.focusedWin, aspect, 'explicit inspection opens/refocuses the view');
});

test('floating inspection uses IPC and does not trust its initialized ready prompt', () => {
  const api = load(); const ed = tracer(api); api.ide.floating = true;
  assert.equal(typeof api.ide.canInspectInline, 'function');
  assert.equal(api.ide.canInspectInline(), false, 'floating window has no authoritative state initially');
  assert.equal(typeof api.ide.openInlineInspection, 'function');
  api.ide.openInlineInspection('Right', ed.me);
  assert.equal(api.sent.length, 0, 'floating view never sends Execute directly');
  assert.deepEqual(api.emitted, [['openInlineInspection', ['Right', 7]]]);
});

test('inspection dispatch protects and releases the draft across the real prompt handlers', () => {
  const api = load(); const se = session(api); const ed = tracer(api);
  assert.equal(typeof api.ide.openInlineInspection, 'function');
  api.ide.openInlineInspection('Left', ed.me);
  assert.equal(se.preserveDraft, true);
  // The handler uses constructor-local fanout; supply the same fanout in this isolated harness.
  const text = source('src/ide.js');
  const start = text.indexOf('    SetPromptType(');
  const end = text.indexOf('    HadError(', start);
  const applyPrompt = vm.runInNewContext(`({${text.slice(start, end)}}).SetPromptType`, {
    ide: api.ide, D: api.D, eachWin: f => f(se), monaco: { Range: api.Range }, setTimeout() {},
  });
  api.ide.updateInputState = () => {};
  applyPrompt({ type: 0 });
  api.handler('EchoInput', 'SetPromptType')({ input: ']IT.Left\n' });
  applyPrompt({ type: 1 });
  assert.equal(se.me.getValue().split('\n')[0], '      changed history');
  assert.equal(se.me.getValue().split('\n').at(-1), '      ⍝ unsent draft');
  assert.ok(!se.preserveDraft, 'completion releases preservation for ordinary execution');
  assert.equal(api.ide.canInspectInline(), true, 'a new request is possible after acknowledgement');
});

test('Next Primitive from an inspection targets the paused tracer while Session keeps inline entry behavior', () => {
  const api = load(); const se = session(api); const ed = tracer(api);
  const calls = [];
  se.IT = () => calls.push('session'); ed.IT = () => calls.push('tracer');
  const aspect = { id: 12, specialWindow: 17 }; aspect.me = { dyalogCmds: aspect };
  api.ide.wins[12] = aspect; api.ide.focusedWin = aspect;
  assert.equal(typeof api.ide.stepInline, 'function');
  api.ide.stepInline(aspect.me);
  assert.deepEqual(calls, ['tracer']);
  api.ide.stepInline(se.me);
  assert.deepEqual(calls, ['tracer', 'session']);
  api.ide.connected = false;
  api.ide.stepInline(aspect.me);
  assert.deepEqual(calls, ['tracer', 'session'], 'disconnected inspection cannot step');
});

test('named-function inline stops use column ranges and ordinary line stops are unavailable', () => {
  const api = load(); session(api); const ed = tracer(api);
  ed.entityType = 1;
  assert.equal(api.ide.canInspectInline(), true, 'named function keeps entityType1 while tracing primitives');
  ed.HIGHLIGHT = { lineStart: 2, lineEnd: 3, colStart: 20, colEnd: 4 };
  assert.equal(api.ide.canInspectInline(), true, 'multiline highlight may end before its starting column');
  ed.HIGHLIGHT = { lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 1 };
  assert.equal(api.ide.canInspectInline(), false, 'ordinary trace has zero-width columns');
});

test('an aspect formatting reply after prompt return cannot steal focus', () => {
  const api = load(); session(api); const ed = tracer(api);
  const formatted = [];
  const aspect = { id: 12, specialWindow: 19, ReplyFormatCode: text => formatted.push(text),
    focus() { api.ide.focusedWin = aspect; } };
  api.ide.wins[12] = aspect;
  api.ide.inputOperation = null; api.ide.inlineInspection = null; api.ide.promptType = 1;
  api.handler('ReplyFormatCode', 'ReplyGetConfiguration')({ win: 12, text: ['+'] });
  assert.equal(api.ide.focusedWin, ed);
  assert.deepEqual(formatted, [['+']], 'late formatting still updates view text');
});

test('inserted draft lines and reversed selections survive inspection output', () => {
  const api = load(); const se = session(api);
  se.me.executeEdits('human', [{ range: new api.Range(3, 22, 3, 22), text: '\n      second draft line' }]);
  se.dirty[4] = 0;
  se.me.setSelections([new api.Selection(4, 18, 3, 9)]);
  se.preserveDraft = true;
  se.prompt(0);
  se.add([{ text: ']IT.Right\n', type: 14 }]);
  se.add([{ text: 'output\n', type: 1 }]);
  se.prompt(1);
  const lines = se.me.getValue().split('\n');
  assert.equal(lines[0], '      changed history');
  assert.deepEqual(lines.slice(-2), ['      ⍝ unsent draft', '      second draft line']);
  const selection = se.me.getSelections()[0];
  assert.equal(selection.selectionStartLineNumber, lines.length);
  assert.equal(selection.positionLineNumber, lines.length - 1);
  assert.equal(selection.selectionStartColumn, 18);
  assert.equal(selection.positionColumn, 9);
  assert.equal(se.dirty[lines.length], 0);
});

test('floating commands reach the owning server guard and retain authoritative proxy metadata', () => {
  const api = load(); const se = session(api); tracer(api);
  const callbacks = {}; const broadcast = [];
  api.D.ipc = { config: {}, serve: f => f(), server: {
    on: (name, callback) => { callbacks[name] = callback; }, start() {},
    broadcast: (...x) => broadcast.push(x), emit() {},
  } };
  vm.runInNewContext(source('src/ipc.js'), { D: api.D, setTimeout, clearTimeout });
  api.D.IPC_Server();
  api.ide.promptType = 4;
  callbacks.openInlineInspection(['Right', 7]);
  assert.equal(api.sent.length, 0);
  assert.ok(!se.preserveDraft);
  api.ide.promptType = 1;
  callbacks.openInlineInspection(['Right', 7]);
  assert.deepEqual(api.sent, [['Execute', { text: ']IT.Right\n', trace: 0 }]]);
  assert.equal(se.preserveDraft, true);
  assert.deepEqual(broadcast.at(-1), ['inlineInspectionState', false]);
  api.ide.inlineInspection = null;
  const proxy = new api.D.IPC_WindowProxy(50, {});
  proxy.id = 7; proxy.tc = true;
  proxy.SetHighlightLine = () => {};
  proxy.focus = () => {};
  api.ide.wins[7] = proxy;
  api.ide.focusWin = () => {};
  api.handler('SetHighlightLine', 'UpdateWindow')({ win: 7, line: 0, end_line: 0, start_col: 5, end_col: 6 });
  assert.equal(api.ide.canInspectInline(), true, 'main tracks ranged highlights sent to the proxy');
  proxy.update = () => {};
  api.handler('UpdateWindow', 'ReplySaveChanges')({ token: 7, entityType: 1, special_window: 19 });
  assert.equal(proxy.specialWindow, 19);
});

test('primitive stepping from a docked inspection forwards IT to the floating tracer proxy', () => {
  const api = load(); session(api);
  const forwarded = [];
  api.D.ipc = { config: {}, server: { emit: (...x) => forwarded.push(x) } };
  vm.runInNewContext(source('src/ipc.js'), { D: api.D, setTimeout, clearTimeout });
  const proxy = new api.D.IPC_WindowProxy(50, {});
  proxy.id = 7; proxy.tc = true;
  proxy.HIGHLIGHT = { lineStart: 2, lineEnd: 2, colStart: 6, colEnd: 7 };
  proxy.focus = () => {};
  api.ide.wins[7] = proxy;
  const aspect = { id: 12, specialWindow: 16 }; aspect.me = { dyalogCmds: aspect };
  api.ide.wins[12] = aspect;
  api.ide.stepInline(aspect.me);
  assert.deepEqual(plain(forwarded), [[{}, 'execCommand', [7, 'IT']]]);
});

test('partial and chunked inspection output remain separate from the preserved draft', () => {
  const api = load(); const se = session(api);
  se.preserveDraft = true; se.prompt(0);
  se.add([{ text: ']IT.Left\n', type: 14 }]);
  se.add([{ text: 'partial error', type: 1 }]);
  assert.ok(se.me.getValue().includes('partial error\n      ⍝ unsent draft'));
  se.add([{ text: ' without newline', type: 1 }]);
  assert.ok(se.me.getValue().includes('partial error without newline\n      ⍝ unsent draft'));
  se.add([{ text: '\nnext output\n', type: 1 }]);
  se.prompt(1);
  assert.ok(se.me.getValue().includes('partial error without newline\nnext output\n      ⍝ unsent draft'));
  assert.equal(se.me.getValue().split('\n')[0], '      changed history');
  se.undoChanges();
  assert.ok(se.me.getValue().includes('partial error without newline\nnext output\n      '));
});

test('primitive execution cannot cancel inspection draft preservation while a command is pending', () => {
  const api = load(); const se = session(api); const ed = tracer(api);
  Object.assign(api.ide, { pasteSources: new Set(), pasteStarts: new Map(), pasteFinishes: new Map(), saveRequests: new Map() });
  const text = source('src/ide.js');
  vm.runInNewContext(text.slice(text.indexOf('  if (!ide.floating)'), text.indexOf('  // The interpreter')), { ide: api.ide, D: api.D });
  api.ide.openInlineInspection('Left', ed.me);
  api.D.send('TracePrimitive', { win: ed.id });
  assert.equal(api.sent.length, 1, 'overlapping primitive request must be rejected');
  assert.equal(se.preserveDraft, true);
  assert.equal(api.ide.inlineInspection, 16);
});

test('existing ide.exec inspection commands preserve drafts through the authoritative send wrapper', () => {
  for (const command of [']IT.Left', ']it.pright', ' ]It.Function -aplan ']) {
    const api = load(); const se = session(api); tracer(api);
    Object.assign(api.ide, { pasteSources: new Set(), pasteStarts: new Map(), pasteFinishes: new Map(), saveRequests: new Map() });
    const text = source('src/ide.js');
    vm.runInNewContext(text.slice(text.indexOf('  if (!ide.floating)'), text.indexOf('  ide.host =')), {
      ide: api.ide, D: api.D, window: { __RIDE__: false },
    });
    api.ide.exec([command], 0);
    assert.equal(se.preserveDraft, true);
    se.prompt(0);
    api.handler('EchoInput', 'SetPromptType')({ input: `${command}\n` });
    se.prompt(1);
    assert.equal(se.me.getValue().split('\n')[0], '      changed history');
    assert.equal(se.me.getValue().split('\n').at(-1), '      ⍝ unsent draft');
  }
  const api = load(); const se = session(api); tracer(api);
  Object.assign(api.ide, { pasteSources: new Set(), pasteStarts: new Map(), pasteFinishes: new Map(), saveRequests: new Map() });
  const text = source('src/ide.js');
  vm.runInNewContext(text.slice(text.indexOf('  if (!ide.floating)'), text.indexOf('  ide.host =')), {
    ide: api.ide, D: api.D, window: { __RIDE__: false },
  });
  api.ide.exec([']IT.Unknown'], 0);
  assert.ok(!se.preserveDraft, 'unrecognized inputs retain ordinary execution semantics');
});

test('ready-prompt echo keeps one draft line without accumulating blank prefixes', () => {
  const api = load(); const se = session(api);
  se.preserveDraft = true;
  for (let n = 0; n < 3; n += 1) se.add([{ text: ']IT.Left\n', type: 14 }]);
  assert.deepEqual(se.me.getValue().split('\n'), [
    '      changed history', '2', ']IT.Left', ']IT.Left', ']IT.Left', '      ⍝ unsent draft',
  ]);
  se.undoChanges();
  assert.equal(se.me.getValue().split('\n').at(-1), '      ');
});

test('inspection aspect validation accepts only own exact known names', () => {
  const api = load(); session(api); tracer(api);
  for (const aspect of ['constructor', 'toString', '__proto__', undefined, 'Left junk']) {
    api.ide.openInlineInspection(aspect);
    assert.equal(api.sent.length, 0);
  }
});

test('earlier inserted history lines preserve their positions and do not overwrite the final draft', () => {
  const api = load(); const se = session(api);
  const column = se.me.getModel().getLineMaxColumn(1);
  se.me.executeEdits('human', [{ range: new api.Range(1, column, 1, column), text: '\n      inserted history' }]);
  se.dirty = { 1: '      1+1', 2: 0, 4: '      ' };
  se.me.setSelections([new api.Selection(4, 10, 4, 17)]);
  se.preserveDraft = true; se.prompt(0);
  se.add([{ text: ']IT.Left\n', type: 14 }]);
  se.prompt(1);
  assert.deepEqual(se.me.getValue().split('\n'), [
    '      changed history', '      inserted history', '2', ']IT.Left', '      ⍝ unsent draft',
  ]);
  assert.equal(se.dirty[2], 0);
  assert.equal(se.dirty[5], '      ');
  assert.equal(se.me.getSelections()[0].positionLineNumber, 5);
  se.add([{ text: 'partial error', type: 1 }]);
  se.add([{ text: ' additional detail\n', type: 1 }]);
  assert.deepEqual(se.me.getValue().split('\n'), [
    '      changed history', '      inserted history', '2', ']IT.Left',
    'partial error additional detail', '      ⍝ unsent draft',
  ]);
});

test('session log truncation drops expired history while retaining the shifted draft and selection', () => {
  const api = load(); const se = session(api);
  api.D.prf = { sessionLogSize: () => 3, autocompletion: () => 'off' };
  se.preserveDraft = true; se.prompt(0);
  se.add([{ text: ']IT.Left\n', type: 14 }]);
  se.add([{ text: 'output\n', type: 1 }]);
  se.prompt(1);
  assert.deepEqual(se.me.getValue().split('\n'), [']IT.Left', 'output', '      ⍝ unsent draft']);
  assert.equal(se.dirty[3], '      ');
  assert.equal(se.me.getSelections()[0].positionLineNumber, 3);
});

test('truncation drops inserted history whose preceding anchor expired and preserves surviving edits', () => {
  const api = load(); const se = session(api);
  api.D.prf = { sessionLogSize: () => 3, autocompletion: () => 'off' };
  const column = se.me.getModel().getLineMaxColumn(1);
  se.me.executeEdits('human', [{ range: new api.Range(1, column, 1, column), text: '\n      inserted history' }]);
  se.me.executeEdits('human', [{ range: new api.Range(3, 1, 3, 2), text: 'changed output' }]);
  se.dirty = { 1: '      1+1', 2: 0, 3: '2', 4: '      ' };
  se.me.setSelections([new api.Selection(4, 10, 4, 17)]);
  se.preserveDraft = true; se.prompt(0);
  se.add([{ text: ']IT.Left\n', type: 14 }]);
  assert.deepEqual(se.me.getValue().split('\n'), [
    'changed output', ']IT.Left', '      ⍝ unsent draft',
  ]);
  assert.equal(se.me.getSelections()[0].positionLineNumber, 3);
  se.undoChanges();
  assert.deepEqual(se.me.getValue().split('\n'), ['2', ']IT.Left', '      ']);
});
