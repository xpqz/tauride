const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync('src/ide.js', 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function execution(lines, tauri = true, trace = false) {
  const sent = [];
  const ide = { getStats() {}, pending: [], pasteSources: new Set(), pasteFinishes: new Map(), pasteStarts: new Map() };
  vm.runInNewContext(extract('  const fxDefns =', '  ide.host ='), {
    ide, window: { __RIDE__: tauri, crypto: require('node:crypto').webcrypto, TextEncoder }, D: { send: (name, payload) => sent.push(payload) },
  });
  ide.exec(lines, trace);
  return [sent[0].text.trimEnd(), ...ide.pending];
}
test('large listing uses bounded commands and retains following input', () => {
  const lines = ['∇ Fn arg', ...Array.from({ length: 500 }, (_, i) => `[${i + 1}] ⍝${'a'.repeat(70)}`), '∇', 'Fn 5'];
  const commands = execution(lines);
  assert.ok(Math.max(...commands.map(x => Buffer.byteLength(x))) < 450);
  assert.equal(commands.at(-1), 'Fn 5');
});
test('quoted strings and blank source lines survive transfer', () => {
  const commands = execution(['∇ Fn arg', "[1] ⎕←'a''b'", '[2] ', '∇']);
  assert.ok(commands.join('\n').includes("⎕←''a''''b''"));
  assert.ok(commands.join('\n').includes("(⊂,'')"));
});
test('Electron and trace preserve original listing', () => {
  const lines = ['∇ Fn arg', '[1] ⎕←arg', '∇'];
  assert.deepEqual(execution(lines, false), lines);
  assert.equal(execution(lines, true, true)[0], lines[0]);
});
function dialogs(ide = { saveRequests: new Map() }) {
  const shown = []; const sent = [];
  const D = { send: (name, x) => sent.push(x), util: { optionsDialog: (x, answer) => { shown.push(x); answer(0); } } };
  const handler = vm.runInNewContext(`({${extract('    OptionsDialog(x) {', '    StringDialog(x) {')}}).OptionsDialog`, { ide, D });
  return { ide, shown, sent, handler };
}
test('ordinary identical dialogs always ask separately', () => {
  const d = dialogs(); const request = { title: 'Confirm', text: 'Proceed?', options: ['No', 'Yes'], type: 3 };
  d.handler({ ...request, token: 100 }); d.handler({ ...request, token: 101 });
  assert.equal(d.shown.length, 2);
});
test('INPUT LIMIT suppression belongs only to one submitted input', () => {
  const d = dialogs({ inputOperation: {}, saveRequests: new Map() });
  const request = { title: 'Dyalog APL', text: 'INPUT LIMIT', options: ['OK'], type: 4 };
  d.handler({ ...request, token: 1 }); d.handler({ ...request, token: 2 });
  assert.equal(d.shown.length, 1); assert.equal(d.sent.length, 2);
  d.ide.inputOperation = {};
  d.handler({ ...request, token: 3 }); assert.equal(d.shown.length, 2);
});
test('save explanation reaches only one corresponding editor reply', () => {
  for (const count of [1, 2]) {
    const ide = { saveRequests: new Map(), wins: {} }; const replies = [];
    for (let win = 1; win <= count; win++) {
      ide.saveRequests.set(win, { explained: false });
      ide.wins[win] = { saved: (...args) => replies.push([win, ...args]) };
    }
    const d = dialogs(ide);
    d.handler({ title: 'Dyalog APL', text: "Can't Fix", options: ['OK'], type: 4, token: 1 });
    const reply = vm.runInNewContext(`({${extract('    ReplySaveChanges(x) {', '    CloseWindow(x) {')}}).ReplySaveChanges`, { ide });
    for (let win = 1; win <= count; win++) reply({ win, err: 1 });
    assert.deepEqual(replies, count === 1 ? [[1, 1, true]] : [[1, 1, false], [2, 1, false]]);
    assert.equal(ide.saveRequests.size, 0);
  }
});

test('ordinary dialog cannot explain a save failure', () => {
  const ide = { saveRequests: new Map([[7, { explained: false }]]) };
  const d = dialogs(ide);
  d.handler({ title: 'Confirm', text: 'Proceed?', options: ['OK'], type: 4 });
  assert.equal(ide.saveRequests.get(7).explained, false);
});
function session() {
  const sent = []; const ide = { promptType: 1, pending: [], getStats() {} };
  const D = { send: (name, payload) => sent.push([name, payload]) };
  vm.runInNewContext(extract('  ide.saveRequests =', '  ide.host ='), {
    ide, D, window: { __RIDE__: true, crypto: require('node:crypto').webcrypto, TextEncoder },
  });
  return { ide, D, sent };
}
test('transfer state follows actual sends and replacement cleans first', () => {
  const s = session();
  s.ide.exec(['∇ Fn arg', '[1] ⍝comment', '∇']);
  assert.equal(s.ide.pasteSources.size, 1);
  const finish = s.ide.pending.at(-1);
  s.ide.exec(['2+2']);
  assert.ok(s.sent.at(-1)[1].text.includes('⎕EX'));
  assert.equal(s.ide.pasteSources.size, 0);
  assert.deepEqual(Array.from(s.ide.pending), ['2+2']);
  s.ide.exec(['∇ Fn arg', '[1] ⍝comment', '∇']);
  s.D.send('Execute', { text: `${s.ide.pending.at(-1)}\n` });
  assert.equal(s.ide.pasteSources.size, 0);
  assert.equal(s.ide.pasteFinishes.size, 0);
  assert.notEqual(finish, s.sent.at(-1)[1].text);
});
test('busy submission preserves active transfer and pending commands', () => {
  const s = session();
  s.ide.exec(['∇ Fn arg', '[1] ⍝comment', '∇']);
  const before = Array.from(s.ide.pending);
  s.ide.promptType = 0;
  s.ide.exec(['2+2']);
  assert.deepEqual(Array.from(s.ide.pending), before);
  assert.equal(s.ide.pasteSources.size, 1);
  assert.equal(s.sent.length, 1);
});
test('Unicode-heavy and apostrophe-heavy source remains below 450 UTF8 bytes per input', () => {
  for (const character of ['⍝', "'", '😀']) {
    const commands = execution(['∇ Fn arg', `[1] ⍝${character.repeat(4000)}`, '∇']);
    assert.ok(commands.every(command => Buffer.byteLength(command) < 450));
  }
});
test('new IDE send wrapper replaces the old IDE wrapper', () => {
  const s = session(); const oldIde = s.ide;
  const ide = { promptType: 1, pending: [], getStats() {} };
  vm.runInNewContext(extract('  ide.saveRequests =', '  // The interpreter'), { ide, D: s.D });
  s.D.send('SaveChanges', { win: 9 });
  assert.equal(oldIde.saveRequests.size, 0);
  assert.equal(ide.saveRequests.size, 1);
});
test('an interrupted transfer retains cleanup until it is sent', () => {
  const s = session();
  s.ide.wins = { 0: { focus() {} } };
  s.ide.exec(['∇ Fn arg', '[1] ⍝comment', '∇']);
  const error = vm.runInNewContext(`({${extract('    HadError() {', '    GotoWindow(x) {')}}).HadError`, {
    ide: s.ide, setTimeout: () => 1,
  });
  error();
  assert.equal(s.ide.pending.length, 1);
  assert.equal(s.ide.pasteSources.size, 1);
  s.ide.exec(['2+2']);
  assert.ok(s.sent.at(-1)[1].text.includes('⎕EX'));
  assert.equal(s.ide.pasteSources.size, 0);
  assert.deepEqual(Array.from(s.ide.pending), ['2+2']);
});
