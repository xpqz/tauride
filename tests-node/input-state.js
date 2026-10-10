const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.TAURIDE_TEST_ROOT || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/ide.js'), 'utf8');

function load() {
  const I = { cn: {}, ide: { hidden: true, classList: { add() {} } }, sb: { hidden: false },
    sb_busy: { hidden: true }, sb_input_state: { textContent: '' }, sb_busy_icon: { hidden: true } };
  for (const name of ['ml', 'io', 'trap', 'dq', 'cc', 'gc']) I[`sb_${name}`] = {};
  const pref = Object.assign(() => 0, { toggle() {} });
  const D = { prf: new Proxy({}, { get: () => pref }), InitHelp() {}, send() {} };
  const context = vm.createContext({ D, I, clearTimeout() {}, setTimeout() {},
    toggleStats() {}, updMenu() {}, eachWin: f => f(D.ide.wins[0]) });
  vm.runInContext(source, context);
  const ide = Object.assign(Object.create(D.IDE.prototype), {
    lbarRecreate() {}, updTitle() {}, updPW() {}, getStats() {},
  });
  // Use the constructor's actual state initialization without mounting GoldenLayout.
  const start = source.indexOf('  const ide = this;');
  const end = source.indexOf('  if (!ide.floating)', start);
  vm.runInContext(`(function(opts = {}) {${source.slice(start, end)}})`, context).call(ide);
  const se = { promptType: 0, prompt(t) { this.promptType = t; }, focus() {}, die() {} };
  ide.wins = { 0: se };
  context.ide = ide;
  function handler(name, next) {
    const begin = source.indexOf(`    ${name}(`);
    const finish = source.indexOf(`    ${next}(`, begin);
    return vm.runInContext(`({${source.slice(begin, finish)}}).${name}`, context);
  }
  const handlers = {
    Identify: handler('Identify', 'ReplyIdentify'),
    SetPromptType: handler('SetPromptType', 'HadError'),
    HadError: handler('HadError', 'GotoWindow'),
    UnknownCommand: vm.runInContext(`({${source.slice(source.indexOf('    UnknownCommand('), source.indexOf('\n  };', source.indexOf('    UnknownCommand(')))}}).UnknownCommand`, context),
  };
  return { ide, se, I, handlers };
}

const identity = { arch: 'U/64', apiVersion: 1, version: '20.0' };

test('input availability distinguishes identification, all prompt modes, and unknown states', () => {
  const { ide, se, I, handlers } = load();
  assert.equal(typeof ide.updateInputState, 'function', 'IDE must render input availability');
  ide.updateInputState();
  assert.equal(I.sb_input_state.textContent, 'Interpreter unavailable');
  handlers.Identify(identity);
  assert.equal(I.sb_input_state.textContent, 'Interpreter unavailable');
  for (const [type, text] of [[0, 'Busy'], [1, 'Ready'], [2, 'Enter expression (⎕)'],
    [3, 'Multiline input'], [4, 'Enter text (⍞)'], [5, 'Awaiting input'], [99, 'Input status unknown']]) {
    handlers.SetPromptType({ type });
    assert.equal(I.sb_input_state.textContent, text);
    assert.equal(I.sb_busy.hidden, false);
    assert.equal(I.sb_busy_icon.hidden, type !== 0);
    assert.equal(se.promptType, type);
  }
});

test('recoverable errors and unsupported status subscription preserve input state; disconnect overrides late messages', () => {
  const { ide, I, handlers } = load();
  handlers.Identify(identity);
  handlers.SetPromptType({ type: 4 });
  assert.equal(I.sb_input_state.textContent, 'Enter text (⍞)');
  I.sb.hidden = true;
  handlers.SetPromptType({ type: 2 });
  handlers.HadError();
  handlers.UnknownCommand({ name: 'Subscribe' });
  assert.equal(I.sb_input_state.textContent, 'Enter expression (⎕)');
  assert.equal(I.sb_busy.hidden, false);
  I.sb.hidden = false;
  assert.equal(I.sb_input_state.textContent, 'Enter expression (⎕)');
  ide.die();
  assert.equal(I.sb_input_state.textContent, 'Disconnected');
  for (const type of [0, 1, 4]) handlers.SetPromptType({ type });
  handlers.Identify(identity);
  assert.equal(I.sb_input_state.textContent, 'Disconnected');
  assert.equal(I.sb_busy_icon.hidden, true);
});

test('floating editors do not present an unsynchronized session input state', () => {
  const { ide, I } = load();
  I.sb_busy.hidden = false;
  I.sb_input_state.textContent = 'Ready';
  ide.floating = true;
  assert.equal(typeof ide.updateInputState, 'function');
  ide.updateInputState();
  assert.equal(I.sb_busy.hidden, true);
});


test('closing an old browser connection disconnects its own IDE without affecting a newer connection', () => {
  const init = fs.readFileSync(path.join(root, 'src/init.js'), 'utf8');
  const start = init.indexOf('      const ws = new WebSocket');
  const end = init.indexOf('\n    }\n    // Tauri', start);
  const sockets = [];
  const D = { IDE: function IDE() { this.deaths = 0; this.die = () => { this.deaths += 1; }; D.ide = this; } };
  class WebSocket {
    constructor() { sockets.push(this); this.readyState = 0; }
    send() {}
  }
  const context = vm.createContext({ D, WebSocket, I: { splash: {} },
    loc: { protocol: 'http:', host: 'localhost' } });
  const connect = vm.runInContext(`(() => {${init.slice(start, end)}})`, context);
  connect();
  const first = D.ide;
  connect();
  const second = D.ide;
  assert.equal(typeof sockets[0].onclose, 'function', 'browser disconnect must retire its session');
  sockets[0].onclose();
  assert.equal(first.deaths, 1);
  assert.equal(second.deaths, 0);
  sockets[1].onclose();
  assert.equal(second.deaths, 1);
});
