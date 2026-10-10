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
    registerCompletionItemProvider: () => ({ dispose() {} }),
  }, { get: (o, k) => o[k] || (() => {}) });
  class Range {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
    }
  }
  const context = vm.createContext({ D, $: { extend: Object.assign },
    monaco: { languages, Range }, setTimeout });
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
  return { D, providers, formatters, model };
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
