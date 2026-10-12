const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadLanguage(initial = {}) {
  const values = { indent: 3, indentMethods: -1, indentComments: true,
    prefixKey: '`', autocompletion: 'classic', ...initial };
  const listeners = {};
  const providers = {};
  const formatters = {};
  const folding = {};
  const models = [];
  const prf = new Proxy({}, { get: (_, key) => (value) => {
    if (typeof value === 'function') {
      if (!listeners[key]) listeners[key] = [];
      listeners[key].push(value);
    }
    else if (value !== undefined) {
      values[key] = value;
      (listeners[key] || []).forEach((f) => f(value));
    }
    return values[key];
  } });
  const D = { informal: [], prf, mop: { then: (f) => f() }, bq: {}, bqbqc: {},
    wins: { 0: { promptType: 3, lines: [], dirty: {}, lineEditor: {} } } };
  const languages = new Proxy({
    setTokensProvider(id, provider) {
      providers[id] = provider;
      models.filter((m) => m.language === id).forEach((m) => m.invalidate());
    },
    registerDocumentFormattingEditProvider: (id, p) => { formatters[id] = p; },
    registerFoldingRangeProvider: (id, p) => { folding[id] = p; },
    registerCompletionItemProvider: () => ({ dispose() {} }),
  }, { get: (o, k) => o[k] || (() => {}) });
  class Range {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
    }
  }
  const context = vm.createContext({ D, $: { extend: Object.assign },
    monaco: { languages: Object.assign(languages, { FoldingRangeKind: class FoldingRangeKind {
      constructor(value) { this.value = value; }
    } }), Range }, setTimeout });
  ['syntax_info.js', 'mon_apl.js'].forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  });
  function model(lines, language = 'apl') {
    let version = 1;
    const m = { language, getLanguageId: () => language,
      getVersionId: () => version,
      getLineContent: (n) => lines[n - 1],
      getLineCount: () => lines.length,
      setLine(n, text) { lines[n - 1] = text; version += 1; },
      invalidate() {} };
    models.push(m);
    return m;
  }
  return { D, providers, formatters, folding, model };
}

function sessionLines(api, lines) {
  const se = api.D.wins[0];
  se.lines = lines.map(() => ({ type: 14 }));
  se.dirty = { [lines.length]: 1 };
  let state = api.providers['apl-session'].getInitialState();
  return lines.map((line) => {
    const result = api.providers['apl-session'].tokenize(line, state);
    state = result.endState;
    return result;
  });
}
function scopes(line, result) {
  return Array.from(line, (_, i) => result.tokens.filter((t) => t.startIndex <= i).at(-1).scopes);
}

function tokenizeLines(api, lines, language) {
  const provider = api.providers[language];
  let state = provider.getInitialState();
  return lines.map((line) => {
    const result = provider.tokenize(line, state);
    state = result.endState;
    return result;
  });
}

for (const language of ['apl', 'aplan']) {
  test(`${language} colours APLAN keys before in-prefixed values`, () => {
    const api = loadLanguage();
    for (const [line, value] of [
      ['x←(a:input ⋄ b:2)', 'input'],
      ['x←[a:in ⋄ b:2]', 'in'],
      ['x←[a :In ⋄ b:2]', 'In'],
      ['x←(a:INEachValue ⋄ b:2)', 'INEachValue'],
      ['x←[a:index ⋄ b:2]', 'index'],
      ['x←(a: input ⋄ b:2)', 'input'],
      ['x←[a:other ⋄ b:2]', 'other'],
      ['x←(a:1 ⋄ b:2)', '1'],
      ['x←(a:1 ⋄ b:integer)', 'integer'],
    ]) {
      const result = tokenizeLines(api, ['∇ f', line, '∇'], language)[1];
      const s = scopes(line, result);
      assert.equal(s[line.indexOf('a')], 'identifier.local.aplan.apl', line);
      assert.equal(s[line.indexOf('b')], 'identifier.local.aplan.apl', line);
      assert.equal(s[line.indexOf(':')], 'delimiter.aplan.apl', line);
      assert.equal(s[line.lastIndexOf(':')], 'delimiter.aplan.apl', line);
      assert.equal(s[line.indexOf(value)], value === '1' ? 'number.apl' : 'identifier.global.apl', line);
      assert.ok(!result.tokens.some((t) => /^(?:invalid|meta\.label)/.test(t.scopes)), line);
    }
    const line = 'a:input ⋄ b:integer';
    const result = tokenizeLines(api, ['∇ f', 'x←(', line, ')', '∇'], language)[2];
    const s = scopes(line, result);
    for (const key of ['a', 'b']) {
      assert.equal(s[line.indexOf(key)], 'identifier.local.aplan.apl');
    }
    assert.equal(s[line.indexOf(':')], 'delimiter.aplan.apl');
    assert.equal(s[line.lastIndexOf(':')], 'delimiter.aplan.apl');
    assert.equal(s[line.indexOf('input')], 'identifier.global.apl');
    assert.equal(s[line.indexOf('integer')], 'identifier.global.apl');
  });
}

test('For iteration names before In and InEach retain ordinary identifier scopes', () => {
  const api = loadLanguage();
  for (const [keyword, space] of [['In', ''], ['iNeAcH', ''], ['In', ' '], ['InEach', ' ']]) {
    const line = `:For item${space}:${keyword} values`;
    const result = tokenizeLines(api, ['∇ f', line, ':EndFor', '∇'], 'apl');
    const s = scopes(line, result[1]);
    assert.equal(s[line.indexOf('item')], 'identifier.global.apl', line);
    assert.equal(s[line.lastIndexOf(':')], 'keyword.apl', line);
    assert.equal(s[line.indexOf('values')], 'identifier.global.apl', line);
    assert.equal(scopes(':EndFor', result[2])[0], 'keyword.apl', line);
  }
});

test('labels and dfn guards before in-prefixed values retain their scopes', () => {
  const api = loadLanguage();
  const lines = ['∇ f', 'label :input', 'label : input', 'f←{flag:input}', '∇'];
  const result = tokenizeLines(api, lines, 'apl');
  const label = scopes(lines[1], result[1]);
  assert.equal(label[0], 'identifier.global.apl');
  const spaced = scopes(lines[2], result[2]);
  assert.equal(spaced[0], 'meta.label.apl');
  assert.equal(spaced[lines[2].indexOf(':')], 'meta.label.apl');
  const guard = scopes(lines[3], result[3]);
  assert.equal(guard[lines[3].indexOf('flag')], 'identifier.local.apl');
  assert.equal(guard[lines[3].indexOf(':')], 'identifier.dfn.1.apl');
});

for (const [open, close] of [['[', ']'], ['(', ')']]) {
  test(`session preserves inherited ${open} opener across long body lines`, () => {
    const api = loadLanguage();
    const lines = [`      a←${open}`, '      12345', `      ${close}`];
    const results = sessionLines(api, lines);
    assert.deepEqual(scopes(lines[1], results[1]).slice(6), Array(5).fill('number.apl'));
    assert.equal(results[1].endState.h.a.at(-1).t, open);
    assert.equal(scopes(lines[2], results[2])[6], 'delimiter.aplan.apl');
    assert.equal(results[2].endState.h.a.length, 1);
  });
}
test('session preserves nested arrays and removes only new invalid openers', () => {
  const api = loadLanguage();
  const lines = ['      a←[', '      (', '      12345', '      )', '      ]'];
  const r = sessionLines(api, lines);
  assert.equal(r[2].endState.h.a.length, 3);
  assert.ok(!r.some((x) => x.tokens.some((t) => t.scopes.startsWith('invalid'))));
  assert.equal(r[4].endState.h.a.length, 1);
  const invalid = sessionLines(api, ["      ([{'"])[0];
  assert.deepEqual(scopes("      ([{'", invalid).slice(6),
    ['invalid.parenthesis.apl', 'invalid.square.apl', 'invalid.dfn.apl', 'invalid.string.apl']);
  assert.equal(invalid.endState.h.a.length, 1);
});

const classLines = [':Class C', '∇ r←f', 'r←1', '∇', ':EndClass'];
function indentAt(api, model, line) {
  return api.formatters.apl.provideDocumentFormattingEdits(model)
    .find((e) => e.range.startLineNumber === line)?.text.length || 0;
}
test('method indentation inherits general width and supports explicit zero and positive widths', () => {
  for (const [indent, indentMethods, expected] of [[3, -1, 6], [7, 20, 27], [7, 0, 7]]) {
    const api = loadLanguage({ indent, indentMethods });
    const m = api.model(classLines);
    assert.equal(indentAt(api, m, 2), indent);
    assert.equal(indentAt(api, m, 3), expected);
  }
});
test('preference changes refresh already tokenized model indentation', () => {
  const api = loadLanguage({ indent: 7, indentMethods: 20 });
  const m = api.model(classLines);
  assert.equal(indentAt(api, m, 3), 27);
  api.D.prf.indentMethods(-1);
  assert.equal(indentAt(api, m, 3), 14);
  api.D.prf.indent(3);
  assert.equal(indentAt(api, m, 3), 6);
  api.D.prf.indentMethods(0);
  assert.equal(indentAt(api, m, 3), 3);
  api.D.prf.indentMethods(20);
  api.D.prf.indent(7);
  assert.equal(indentAt(api, m, 3), 27);
});

test('new unmatched brackets do not remove an inherited array opener', () => {
  const api = loadLanguage();
  const r = sessionLines(api, ['      a←[', "      ([{'", '      ]']);
  assert.equal(r[1].endState.h.a.length, 2);
  assert.equal(r[1].endState.h.a.at(-1).t, '[');
  assert.equal(scopes('      ]', r[2])[6], 'delimiter.aplan.apl');
});

test('tradfn numbering excludes recursive dfns, strings and comments', () => {
  const api = loadLanguage();
  const lines = [':Namespace N', 'f←{', '  ⍵=0:0', '  ∇ ⍵-1', '}',
    "s←'∇ r←fake'", '⍝ ∇ r←fake', '∇ r←g', 'r←1', '∇', ':EndNamespace'];
  assert.deepEqual(Array.from(api.D.aplTradfnLines(api.model(lines))).slice(1),
    [-1, -1, -1, -1, -1, -1, -1, 0, 1, 2, -1]);
});

test('script tradfn numbering recognizes a delimiter on the first line', () => {
  const api = loadLanguage();
  assert.deepEqual(Array.from(api.D.aplTradfnLines(api.model(['∇ r←f', 'r←1', '∇']))).slice(1),
    [0, 1, 2]);
});

test('formatting initializes token states for a fresh model', () => {
  const api = loadLanguage();
  const m = api.model(classLines.slice());
  assert.equal(indentAt(api, m, 2), 3);
  assert.equal(indentAt(api, m, 3), 6);
});

test('formatting updates after editing an earlier block opener', () => {
  const api = loadLanguage();
  const m = api.model(classLines.slice());
  assert.equal(indentAt(api, m, 3), 6);
  m.setLine(1, 'plain text');
  assert.equal(indentAt(api, m, 3), 3);
});

async function foldRanges(api, model) {
  const ranges = await api.folding.apl.provideFoldingRanges(model, {}, { isCancellationRequested: false });
  return Array.from(ranges, ({ start, end }) => [start, end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

test('Select folds its whole block and keeps Case, CaseList, and Else branches', async () => {
  const api = loadLanguage();
  const model = api.model(['⍝ before', ':Select x', ':Case 1', 'a←1', ':CaseList 2 3',
    'a←2', ':Else', 'a←0', ':EndSelect', '⍝ after']);
  assert.deepEqual(await foldRanges(api, model), [[2, 9], [3, 4], [5, 6], [7, 9]]);
});

test('Select preamble comments belong to one whole-block range', async () => {
  const api = loadLanguage();
  const model = api.model([':Select x', '⍝ before first case', ':Case 1',
    'a←1', ':EndSelect', '⍝ outside']);
  assert.deepEqual(await foldRanges(api, model), [[1, 5], [3, 5]]);
});

test('nested and mixed-case Select blocks keep independent outer and branch folds', async () => {
  const api = loadLanguage();
  const model = api.model(['⍝ before', ':SeLeCt x', ':cAsE 1', '⍝ inside first branch',
    ':Select y', ':Case 2', 'a←2', ':EndSelect', 'a←1', ':Else', 'a←0', ':eNdSeLeCt', '⍝ after']);
  assert.deepEqual(await foldRanges(api, model), [[2, 12], [3, 9], [5, 8], [6, 8], [10, 12]]);
});

test('Select handles a missing terminator and branches with no body', async () => {
  const api = loadLanguage();
  assert.deepEqual(await foldRanges(api, api.model([':Select x', ':Case 1', 'a←1'])),
    [[1, 3], [2, 3]]);
  assert.deepEqual(await foldRanges(api, api.model([':Select x', ':Case 1', ':Case 2', 'a←2', ':EndSelect'])),
    [[1, 5], [3, 5]]);
  assert.deepEqual(await foldRanges(api, api.model([':Select x', '⍝ inside', ':EndSelect'])), [[1, 3]]);
  assert.deepEqual(await foldRanges(api, api.model([':Select x'])), []);
});

test('Select accepts generic and same-line closers without inventing extra ranges', async () => {
  const api = loadLanguage();
  assert.deepEqual(await foldRanges(api, api.model([':Select x', ':Case 1', 'a←1', ':End'])),
    [[1, 4], [2, 4]]);
  assert.deepEqual(await foldRanges(api, api.model([':Select x', ':Case 1', ':Select y',
    ':Case 2', 'a←2', ':EndSelect ⋄ :EndSelect', '⍝ after'])), [[1, 6], [2, 6], [3, 6], [4, 6]]);
  assert.deepEqual(await foldRanges(api, api.model([':Select x ⋄ :Case 1', 'a←1', ':EndSelect'])),
    [[1, 3]]);
  assert.deepEqual(await foldRanges(api, api.model([':Select x ⋄ :If flag', 'a←1',
    ':EndIf', ':EndSelect'])), [[1, 4]]);
  assert.deepEqual(await foldRanges(api, api.model([':Select x', ':Case 1', 'a←1',
    ':EndSelect ⋄ :If flag', 'b←1', ':EndIf'])), [[1, 4], [2, 4], [4, 6]]);
  assert.deepEqual(await foldRanges(api, api.model([':EndSelect', 'a←1'])), []);
});

test('a new Case header does not inherit folded lines from a closed nested Select', async () => {
  const api = loadLanguage();
  const model = api.model([':Select x', ':Case 1', ':Select y', ':Case 4', 'a←4',
    ':EndSelect ⋄ :Case 2', 'a←2', ':EndSelect', '⍝ after']);
  assert.deepEqual(await foldRanges(api, model), [[1, 8], [2, 5], [3, 5], [4, 5], [6, 8]]);
});

test('a final Case header closes the previous branch at EOF without an empty fold', async () => {
  const api = loadLanguage();
  assert.deepEqual(await foldRanges(api, api.model([':Select x', ':Case 1', 'a←1', ':Case 2'])),
    [[1, 4], [2, 3]]);
  assert.deepEqual(await foldRanges(api, api.model([':Select x', ':Case 1', ':Select y',
    ':Case 4', 'a←4', ':EndSelect ⋄ :Case 2'])), [[1, 6], [2, 5], [3, 5], [4, 5]]);
});

test('folding updates after editing a cached Select model and keeps If and Trap branches', async () => {
  const api = loadLanguage();
  const model = api.model([':Select x', ':Case 1', 'a←1', ':EndSelect']);
  assert.deepEqual(await foldRanges(api, model), [[1, 4], [2, 4]]);
  model.setLine(1, 'plain←1');
  assert.deepEqual(await foldRanges(api, model), []);
  model.setLine(1, ':Select x');
  assert.deepEqual(await foldRanges(api, model), [[1, 4], [2, 4]]);
  assert.deepEqual(await foldRanges(api, api.model([':If x', 'a←1', ':Else', 'a←2', ':EndIf',
    ':Trap 0', 'a←1', ':Case 1', 'a←2', ':EndTrap'])), [[1, 2], [3, 5], [6, 7], [8, 10]]);
});

test('nested If and Trap branches do not split the enclosing Select', async () => {
  const api = loadLanguage();
  const model = api.model([':Select x', ':Case 1', ':If flag', 'a←1', ':Else', 'a←0',
    ':EndIf', ':Trap 0', 'b←1', ':Case 2', 'b←0', ':EndTrap', ':EndSelect']);
  assert.deepEqual(await foldRanges(api, model), [[1, 13], [2, 13], [3, 4], [5, 7],
    [8, 9], [10, 12]]);
});

test('same-line nested If keywords keep one fold start and clamp replaced branches', async () => {
  const api = loadLanguage();
  assert.deepEqual(await foldRanges(api, api.model([':If a ⋄ :If b', 'x←1', ':EndIf',
    'y←2', ':EndIf', 'after←1'])), [[1, 5]]);
  assert.deepEqual(await foldRanges(api, api.model([':If a', ':If b', 'x←1',
    ':EndIf ⋄ :Else', 'y←2', ':EndIf', 'after←1'])), [[1, 3], [2, 3], [4, 6]]);
});
