const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.env.TAURIDE_TEST_ROOT || path.resolve(__dirname, '..');

function load() {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const D = {
    openExternal() {}, lb: { order: '' }, prf_tabs: {}, commands: {}, keyMap: {}, informal: [],
    kbds: { layouts: { en_US: ['', '', '', ''] } },
  };
  const context = vm.createContext({ D, nodeRequire: null, localStorage: storage,
    navigator: { language: 'en-US' }, $: { extend: Object.assign }, });
  for (const name of ['prf', 'cmds', 'prf_menu', 'km', 'ide']) {
    vm.runInContext(fs.readFileSync(path.join(root, `src/${name}.js`), 'utf8'), context);
  }
  D.ide = Object.create(D.IDE.prototype);
  return D;
}

function toolbarItem(D) {
  const view = D.parseMenuDSL(D.prf.menu()).find(item => item[''] === '&View');
  return view.items.find(item => item[''].replace(/&/g, '') === 'Show Trace/Edit Toolbar');
}

test('View toolbar action and command share the Preferences state without an active editor', () => {
  const D = load();
  const item = toolbarItem(D);
  assert.ok(item, 'View must expose Show Trace/Edit Toolbar');
  assert.equal(item.checkBoxPref(), 1);
  item.action();
  assert.equal(D.prf.showEditorToolbar(), 0);
  assert.equal(item.checkBoxPref(), 0);
  D.prf.showEditorToolbar(1);
  assert.equal(item.checkBoxPref(), 1);
  D.commands[item.cmd]();
  assert.equal(item.checkBoxPref(), 0);
  // The IDE dispatcher also supports command codes from custom menus.
  delete D.commands[item.cmd];
  item.action();
  assert.equal(item.checkBoxPref(), 1);
});

test('toolbar command is assignable but has no default keyboard shortcut', () => {
  const D = load();
  const item = toolbarItem(D);
  assert.ok(item, 'View must expose Show Trace/Edit Toolbar');
  const entry = D.cmds.find(command => command[0] === item.cmd);
  assert.ok(entry, 'toolbar command must appear in Preferences > Keys');
  assert.deepEqual(Array.from(entry[2]), []);
  assert.equal(typeof D.commands[item.cmd], 'function');
});
