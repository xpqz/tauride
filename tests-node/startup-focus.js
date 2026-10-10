const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/ide.js'), 'utf8');
const start = source.indexOf('  D.mac && !ide.floating && setTimeout(');
const timerSource = source.slice(start, source.indexOf('  D.prf.lineNums(', start));

async function restore({ active = true, stale = false, closed = false, browser = false } = {}) {
  const focused = [];
  const current = { id: 1, focus() { focused.push('current'); } };
  const fallback = { id: 0, focus() { focused.push('fallback'); } };
  const ide = { focusedWin: current, wins: { 0: fallback }, getMRUWin: () => fallback };
  if (!stale) ide.wins[1] = current;
  const D = { mac: true };
  if (!browser) D.wm = { main: () => ({ async isFocused() {
    if (closed) throw new Error('window closed');
    return active;
  } }) };
  let callback;
  vm.runInNewContext(timerSource, {
    D, ide, document: { hasFocus: () => active },
    setTimeout(run, delay) { assert.equal(delay, 500); callback = run; },
  });
  await callback();
  return focused;
}

test('startup restoration respects the active native window and live editor', async () => {
  assert.deepEqual(await restore(), ['current']);
  assert.deepEqual(await restore({ active: false }), []);
  assert.deepEqual(await restore({ stale: true }), ['fallback']);
  assert.deepEqual(await restore({ closed: true }), []);
});

test('browser startup restoration respects document focus', async () => {
  assert.deepEqual(await restore({ browser: true }), ['current']);
  assert.deepEqual(await restore({ browser: true, active: false }), []);
});
