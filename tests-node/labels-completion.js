const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function load(initial = {}) {
  const prefs = { indent: 4, indentMethods: -1, indentComments: true,
    prefixKey: '`', autocompletion: 'shell', autoCompleteCharacterLimit: 2, ...initial };
  const providers = {};
  const D = { informal: [], bq: {}, bqbqc: {}, mop: { then: fn => fn() },
    prf: new Proxy({}, { get: (_, key) => () => prefs[key] }) };
  class Range {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
    }
  }
  const languages = new Proxy({
    setTokensProvider: (id, provider) => { providers[id] = provider; },
    registerCompletionItemProvider: () => ({ dispose() {} }),
    CompletionItemKind: { Property: 9 },
  }, { get: (object, key) => object[key] || (() => {}) });
  const context = vm.createContext({ D, $: { extend: Object.assign },
    monaco: { languages, Range, Selection: Range }, setTimeout });
  ['syntax_info.js', 'mon_apl.js', 'ac.js', 'ed.js'].forEach(file => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  });
  function tokenize(lines) {
    let state = providers.apl.getInitialState();
    return lines.map(line => {
      const result = providers.apl.tokenize(line, state);
      state = result.endState;
      return result.tokens;
    });
  }
  return { D, tokenize };
}

function scopeAt(tokens, offset) {
  return tokens.filter(token => token.startIndex <= offset).at(-1)?.scopes;
}

for (const indent of [1, 4, 10]) {
  for (const separator of [':', ' :', '  :']) {
    test(`class label begins after ${indent} spaces, separator ${JSON.stringify(separator)}`, () => {
      const api = load();
      const label = `End${separator}`;
      const line = `${' '.repeat(indent)}${label} x←1`;
      const tokens = api.tokenize([':Class C', '∇ f', line, '∇', ':EndClass'])[2];
      assert.equal(scopeAt(tokens, indent - 1), 'white.apl');
      assert.equal(tokens.find(token => token.scopes === 'meta.label.apl').startIndex, indent);
      for (let i = indent; i < indent + label.length; i++) {
        assert.equal(scopeAt(tokens, i), 'meta.label.apl', `label character at ${i}`);
      }
      const code = indent + label.length + 1;
      assert.equal(scopeAt(tokens, code - 1), 'white.apl');
      assert.equal(scopeAt(tokens, code), 'identifier.global.apl');
      assert.equal(scopeAt(tokens, code + 1), 'keyword.operator.assignment.apl');
      assert.equal(scopeAt(tokens, code + 2), 'number.apl');
    });
  }
}

test('unindented label and ordinary name retain their scopes', () => {
  const api = load();
  const tokens = api.tokenize(['∇ f', 'End: x←1', 'End←1', '∇']);
  assert.equal(tokens[1][0].startIndex, 0);
  assert.equal(scopeAt(tokens[1], 0), 'meta.label.apl');
  assert.equal(scopeAt(tokens[1], 5), 'identifier.global.apl');
  assert.equal(scopeAt(tokens[2], 0), 'identifier.global.apl');
});

test('dfn guards and array notation separators do not become labels', () => {
  const api = load();
  const dfn = 'f←{ End: x←1 }';
  const dt = api.tokenize(['∇ f', dfn, '∇'])[1];
  assert.equal(scopeAt(dt, dfn.indexOf('End')), 'identifier.local.apl');
  assert.equal(scopeAt(dt, dfn.indexOf(':')), 'identifier.dfn.1.apl');
  for (const line of ['x←(End:1 ⋄ Other:2)', 'x←[End:1 ⋄ Other:2]']) {
    const tokens = api.tokenize(['∇ f', line, '∇'])[1];
    assert.equal(scopeAt(tokens, line.indexOf('End')), 'identifier.local.aplan.apl');
    assert.equal(scopeAt(tokens, line.indexOf(':')), 'delimiter.aplan.apl');
    assert.ok(!tokens.some(token => token.scopes === 'meta.label.apl'));
  }
});

function editor(api, text, column = text.length + 1) {
  let value = text;
  let position = { lineNumber: 1, column };
  let changed;
  const replies = [];
  const actions = [];
  const model = { getLineContent: () => value };
  const controller = { cancelSuggestWidget: () => actions.push('cancel') };
  const me = {
    getModel: () => model,
    getValue: () => value,
    getPosition: () => position,
    getSelections: () => [{ startLineNumber: 1, endLineNumber: 1 }],
    onDidCompositionStart: () => ({ dispose() {} }),
    onDidCompositionEnd: () => ({ dispose() {} }),
    onDidChangeModelContent: fn => { changed = fn; },
    onDidBlurEditorText: () => ({ dispose() {} }),
    getContribution: () => controller,
    executeEdits: (_, edits) => {
      for (const edit of edits) {
        const { range, text: inserted } = edit;
        value = value.slice(0, range.startColumn - 1) + inserted + value.slice(range.endColumn - 1);
        position = { lineNumber: 1, column: range.startColumn + inserted.length };
      }
      changed({ isFlush: true, changes: [] });
    },
    trigger: (_, action, data) => {
      actions.push(action);
      if (action === 'type') {
        value = value.slice(0, position.column - 1) + data.text + value.slice(position.column - 1);
        position = { lineNumber: 1, column: position.column + data.text.length };
        changed({ isFlush: true, changes: [] });
      }
    },
  };
  const complete = api.D.ac(me);
  const reply = (options, skip = 0, manual = 1) => {
    model.ac = { position, complete: result => replies.push(result) };
    me.tabComplete = manual;
    complete({ options, skip });
  };
  return { me, reply, replies, actions };
}

for (const mode of ['shell', 'classic']) {
  for (const [indent, column, spaces] of [[4, 8, 1], [4, 5, 4], [3, 6, 1], [8, 3, 6], [0, 2, 3]]) {
    test(`${mode} first Tab with no matches reaches next stop: indent ${indent}, column ${column}`, () => {
      const api = load({ autocompletion: mode, indent });
      const text = '1234567';
      const { me, reply, actions, replies } = editor(api, text, column);
      reply([]);
      assert.equal(me.getValue(), text.slice(0, column - 1) + ' '.repeat(spaces) + text.slice(column - 1));
      assert.equal(me.tabComplete, 0);
      assert.equal(actions.filter(action => action === 'type').length, 1);
      assert.equal(replies.length, 0);
    });
  }
}

for (const mode of ['shell', 'classic']) {
  test(`${mode} automatic empty reply never inserts whitespace`, () => {
    const { me, reply, actions, replies } = editor(load({ autocompletion: mode }), '1234567');
    reply([], 0, 0);
    assert.equal(me.getValue(), '1234567');
    assert.equal(me.tabComplete, 0);
    assert.deepEqual(actions, ['cancel']);
    assert.equal(replies.length, 0);
  });
  test(`${mode} second Tab with no matches inserts one soft tab`, () => {
    const { me, reply } = editor(load({ autocompletion: mode }), '1234567');
    reply([], 0, 2);
    assert.equal(me.getValue(), '1234567 ');
    assert.equal(me.tabComplete, 0);
  });
}

for (const [options, expected] of [[['alpha'], 'alpha'], [['alphabet', 'alphanumeric'], 'alpha']]) {
  test(`shell first Tab completes common prefix of ${options.length} matches`, () => {
    const { me, reply, replies, actions } = editor(load(), 'al');
    reply(options, 2);
    assert.equal(me.getValue(), expected);
    assert.equal(me.getPosition().column, expected.length + 1);
    assert.equal(me.tabComplete, 0);
    assert.equal(replies.length, 0);
    assert.deepEqual(actions, ['cancel']);
  });
}

test('shell waits on an unchanged prefix, then offers matches on the second Tab', () => {
  const { me, reply, replies, actions } = editor(load(), 'alpha');
  const options = ['alphabet', 'alphanumeric'];
  reply(options, 5);
  assert.equal(me.getValue(), 'alpha');
  assert.equal(me.tabComplete, 1);
  assert.equal(replies.length, 0);
  assert.deepEqual(actions, ['cancel']);
  reply(options, 5, 2);
  assert.equal(me.getValue(), 'alpha');
  assert.equal(me.tabComplete, 0);
  assert.deepEqual(Array.from(replies[0].suggestions, item => item.label), options);
  for (const item of replies[0].suggestions) {
    assert.equal(item.range.startColumn, 1);
    assert.equal(item.range.endColumn, 6);
  }
});

test('classic matching reply offers suggestions without inserting a prefix', () => {
  const { me, reply, replies, actions } = editor(load({ autocompletion: 'classic' }), 'al');
  reply(['alpha', 'alpine'], 2);
  assert.equal(me.getValue(), 'al');
  assert.deepEqual(Array.from(replies[0].suggestions, item => item.insertText), ['alpha', 'alpine']);
  assert.deepEqual(actions, []);
});

test('shell automatic matching reply suppresses suggestions without changing text', () => {
  const { me, reply, replies, actions } = editor(load(), 'al');
  reply(['alpha'], 2, 0);
  assert.equal(me.getValue(), 'al');
  assert.equal(replies.length, 0);
  assert.deepEqual(actions, ['cancel']);
});

test('classic below-threshold Tab still indents directly', () => {
  const api = load({ autocompletion: 'classic', autoCompleteCharacterLimit: 3 });
  const { me, actions } = editor(api, 'a');
  api.D.Ed.prototype.indentOrComplete(me);
  assert.equal(me.getValue(), 'a   ');
  assert.equal(me.tabComplete, 0);
  assert.deepEqual(actions, ['type']);
});
