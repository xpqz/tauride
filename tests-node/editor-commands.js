const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.env.TAURIDE_TEST_ROOT || path.resolve(__dirname, '..');

class Range {
  constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
    Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
  }
}

class Selection extends Range {
  isEmpty() {
    return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn;
  }

  getStartPosition() { return { lineNumber: this.startLineNumber, column: this.startColumn }; }
  getEndPosition() { return { lineNumber: this.endLineNumber, column: this.endColumn }; }
}

function load() {
  const sent = [];
  const D = { ide: { Edit: x => sent.push(x) }, util: { ucLength: x => [...x].length } };
  const context = vm.createContext({
    D, monaco: { Range, Selection, editor: { EndOfLinePreference: { LF: 0 } } },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/ed.js'), 'utf8'), context);
  return { D, sent };
}

function editor(D, text, selections = [new Selection(1, 1, 1, 1)], eol = '\n') {
  let value = text;
  const offset = (lineNumber, column) => {
    const lines = value.split(eol);
    return lines.slice(0, lineNumber - 1).join(eol).length
      + (lineNumber > 1 ? eol.length : 0)
      + Math.max(0, Math.min(column - 1, lines[lineNumber - 1].length));
  };
  const model = {
    getLineContent: i => value.split(eol)[i - 1],
    getLineCount: () => value.split(eol).length,
    getEOL: () => eol,
    getValueInRange: range => value.slice(
      offset(range.startLineNumber, range.startColumn),
      offset(range.endLineNumber, range.endColumn),
    ).split(eol).join('\n'),
  };
  const me = {
    getModel: () => model,
    getValue: () => value,
    getPosition: () => selections[0].getEndPosition(),
    getSelections: () => selections,
    executeEdits(source, edits, cursorState) {
      assert.equal(source, 'D');
      assert.equal(cursorState, selections);
      const replacements = edits.map(({ range, text: replacement }) => ({
        start: offset(range.startLineNumber, range.startColumn),
        end: offset(range.endLineNumber, range.endColumn),
        replacement,
      })).sort((a, b) => b.start - a.start);
      replacements.forEach(({ start, end, replacement }) => {
        value = value.slice(0, start) + replacement + value.slice(end);
      });
    },
  };
  return Object.assign(Object.create(D.Ed.prototype), {
    id: 17, tc: false, isReadOnly: false, me, jumps: [],
    addJump() { this.jumps.push(me.getPosition()); },
  });
}

test('Edit at column 1 of an unindented tracer uses the same window conversion request', () => {
  const { D, sent } = load();
  const ed = editor(D, 'r←audit977\nr←a+b', [new Selection(2, 1, 2, 1)]);
  ed.tc = true;
  ed.ED(ed.me, false);
  assert.deepEqual({ ...sent[0] }, { win: 17, pos: 6, text: 'r←a+b' });
  assert.equal(ed.jumps.length, 1);
});

test('Edit preserves name positions outside column 1 and in regular editors', () => {
  const { D, sent } = load();
  for (const [tc, text, column, pos] of [
    [true, 'r←a+b', 3, 2],
    [true, '  r←a+b', 3, 2],
    [false, 'r←a+b', 1, 0],
    [false, 'r←a+b', 5, 4],
    [true, "'😀' ⋄ name", 8, 6],
  ]) {
    const ed = editor(D, text, [new Selection(1, column, 1, column)]);
    ed.tc = tc;
    ed.ED(ed.me, false);
    assert.deepEqual({ ...sent.at(-1) }, { win: 17, pos, text });
  }
});

test('Edit keeps empty-space conversion and handles indented and empty tracer lines', () => {
  const { D, sent } = load();
  for (const [text, column, inEmptySpace] of [
    ['r←a+b', 3, true],
    ['  r←a+b', 1, false],
    ['', 1, false],
    ['', 1, true],
  ]) {
    const ed = editor(D, text, [new Selection(1, column, 1, column)]);
    ed.tc = true;
    ed.ED(ed.me, inEmptySpace);
    assert.deepEqual({ ...sent.at(-1) }, { win: 17, pos: text.length + 1, text });
  }
});

test('Align Comments without a selection preserves standalone indentation', () => {
  const { D } = load();
  const ed = editor(D, 'foo\n⍝ standalone\nx←1 ⍝ inline');
  ed.AC(ed.me);
  assert.equal(ed.me.getValue(), 'foo\n⍝ standalone\nx←1 ⍝ inline');
});

test('unselected standalone comments neither move nor set the inline alignment column', () => {
  const { D } = load();
  const before = '  ⍝ short\n                    ⍝ wide\n\t⍝ tabbed\nx←1 ⍝ first\nlong←2   ⍝ second\n\n';
  const expected = '  ⍝ short\n                    ⍝ wide\n\t⍝ tabbed\nx←1      ⍝ first\nlong←2   ⍝ second\n\n';
  const ed = editor(D, before, [new Selection(4, 3, 4, 3)]);
  ed.AC(ed.me);
  assert.equal(ed.me.getValue(), expected);
  ed.AC(ed.me);
  assert.equal(ed.me.getValue(), expected);
});

test('quoted delimiters and string expressions remain code during whole-function alignment', () => {
  const { D } = load();
  const before = "⍝ standalone\n'⍝' ⍝ expression\nx←'don''t ⍝'\nlong←1 ⍝ inline";
  const expected = "⍝ standalone\n'⍝'    ⍝ expression\nx←'don''t ⍝'\nlong←1 ⍝ inline";
  const ed = editor(D, before);
  ed.AC(ed.me);
  assert.equal(ed.me.getValue(), expected);
});

test('Align Comments preserves a comment-only function and read-only editors', () => {
  const { D } = load();
  const before = '⍝ first\n    ⍝ second\n\n\t⍝ third';
  const ed = editor(D, before);
  ed.AC(ed.me);
  assert.equal(ed.me.getValue(), before);
  const readonly = editor(D, '⍝ first\nx←1 ⍝ inline');
  readonly.isReadOnly = true;
  readonly.AC(readonly.me);
  assert.equal(readonly.me.getValue(), '⍝ first\nx←1 ⍝ inline');
});

test('an explicit selection still aligns standalone and inline comments', () => {
  const { D } = load();
  const before = 'foo\n⍝ standalone\nx←1 ⍝ inline\n  ⍝ outside';
  const ed = editor(D, before, [new Selection(2, 1, 3, 13)]);
  ed.AC(ed.me);
  assert.equal(ed.me.getValue(), 'foo\n    ⍝ standalone\nx←1 ⍝ inline\n  ⍝ outside');
});

test('partial selections preserve text before the range and do not duplicate comments', () => {
  const { D } = load();
  const before = 'x←1 ⍝ untouched\ny←2 ⍝ inside\nlong←3 ⍝ longest\n⍝ outside';
  const ed = editor(D, before, [new Selection(1, 8, 3, 17)]);
  ed.AC(ed.me);
  assert.equal(ed.me.getValue(), 'x←1 ⍝ untouched\ny←2    ⍝ inside\nlong←3 ⍝ longest\n⍝ outside');
  ed.AC(ed.me);
  assert.equal(ed.me.getValue(), 'x←1 ⍝ untouched\ny←2    ⍝ inside\nlong←3 ⍝ longest\n⍝ outside');
});

test('multiple explicit selections retain independent ranges and align their comments together', () => {
  const { D } = load();
  const ed = editor(D, '⍝ first\nx←1\ny←2 ⍝ second', [
    new Selection(1, 1, 1, 8), new Selection(3, 1, 3, 13),
  ]);
  ed.AC(ed.me);
  assert.equal(ed.me.getValue(), '    ⍝ first\nx←1\ny←2 ⍝ second');
});

test('whole-function alignment preserves CRLF line endings', () => {
  const { D } = load();
  const ed = editor(D, '  ⍝ standalone\r\nx←1 ⍝ first\r\nlong←2 ⍝ second', undefined, '\r\n');
  ed.AC(ed.me);
  assert.equal(ed.me.getValue(), '  ⍝ standalone\r\nx←1    ⍝ first\r\nlong←2 ⍝ second');
});
