const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.TAURIDE_TEST_ROOT || path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const commands = ['FX', 'SI', 'SC', 'RP', 'QCP', 'TGC', 'RD'];

function renderer() {
  const calls = [];
  const resolved = [];
  const keys = { FX: ['Cmd+S'], SI: ['Ctrl+C'], SC: ['Cmd+F'] };
  class Menu { constructor() { this.items = []; } append(item) { this.items.push(item); }
    static setApplicationMenu(menu) { Menu.current = menu; } }
  class MenuItem { constructor(options) { Object.assign(this, options); } }
  const D = { mac: true, el: { Menu, MenuItem }, cmds: [['FX', '', []], ['SI', '', []], ['SC', '', ['Ctrl+F']]],
    prf: { keys: () => ({}) }, effectiveKeys(prefs) { resolved.push(prefs); return keys; },
    focusedShortcutCommands: commands, runFocusedCommand: command => calls.push(command) };
  vm.runInNewContext(read('src/menu.js'), { D, window: { __RIDE__: true } });
  const install = () => D.installMenu([{ '': 'Custom', items: commands.map(code => ({
    '': `Custom ${code}`, cmd: code, action: () => calls.push(`legacy:${code}`),
  })) }]);
  return { D, Menu, keys, calls, resolved, install };
}

test('native menu uses resolved custom/default bindings and preserves the supplied custom layout', () => {
  const api = renderer(); api.install();
  assert.equal(api.resolved.length, 1, 'same effective resolver must feed the native accelerator');
  const items = api.Menu.current.items[0].submenu.items;
  assert.equal(items.find(item => item.rideCommand === 'FX').accelerator, 'Cmd+S');
  assert.equal(items.find(item => item.rideCommand === 'SC').accelerator, 'Cmd+F');
  assert.equal(api.Menu.current.items[0].label, 'Custom');
  api.keys.FX = []; api.keys.SI = ['Ctrl+Option+I']; api.install();
  const refreshed = api.Menu.current.items[0].submenu.items;
  assert.equal(refreshed.find(item => item.rideCommand === 'FX').accelerator, null);
  assert.equal(refreshed.find(item => item.rideCommand === 'SI').accelerator, 'Ctrl+Option+I');
});

test('Mac native editing and interrupt menu clicks use the same guarded focused dispatcher as keys', () => {
  const api = renderer(); api.install();
  for (const item of api.Menu.current.items[0].submenu.items) item.click();
  assert.deepEqual(api.calls, commands);
});

function shimMenu() {
  const text = read('tauri/shim.js');
  const begin = text.indexOf('  const menuItems =');
  const end = text.indexOf('  const shell =', begin);
  const context = vm.createContext({ menuClicks: new Map(), appClicks: new Map(), menuSeq: 0,
    window: { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: 'w1000001' } } } },
    nodePlatform: 'darwin', currentId: () => 1000001, runRole() {}, menuReady: () => Promise.resolve(),
    invoke: () => Promise.resolve(), rlog() {} });
  vm.runInContext(`${text.slice(begin, end)}\nthis.menuItems = menuItems;`, context);
  return context;
}

test('native IDs route all new customizable commands independently of last installing session', () => {
  const context = shimMenu();
  for (const code of commands) {
    const item = context.menuItems([{ label: code, rideCommand: code }], 'app:w1000001:9', new Map(), true)[0];
    assert.equal(item.id, `app:w1000001:9:0:${code}`);
  }
});

test('native focused session listener uses actual editor focus guards rather than last focusedWin', () => {
  const text = read('tauri/shim.js');
  const begin = text.indexOf("      sessionWindow.listen('ride-session-menu'");
  const end = text.indexOf('\n      });', begin) + '\n      });'.length;
  const listeners = {};
  const calls = [];
  const D = { ide: { focusedWin: { me: { id: 'stale-editor' } } },
    commands: { ...Object.fromEntries(commands.map(code => [code, () => calls.push(`unguarded:${code}`)])),
      ITL: me => calls.push(['ITL', me]), BXMAX: me => calls.push(['BXMAX', me]) },
    focusedShortcutCommands: commands, runFocusedCommand: code => calls.push(code) };
  vm.runInNewContext(text.slice(begin, end), { window: { D }, D,
    sessionWindow: { listen(name, callback) { listeners[name] = callback; } } });
  for (const code of commands) listeners['ride-session-menu']({ payload: code });
  for (const code of ['ITL', 'BXMAX']) listeners['ride-session-menu']({ payload: code });
  assert.deepEqual(calls, [...commands, ['ITL', D.ide.focusedWin.me], ['BXMAX', D.ide.focusedWin.me]]);
});

test('native focus requests the owning main menu for session, floating, and helper pages', () => {
  const text = read('tauri/shim.js');
  const begin = text.indexOf('  const pageType =');
  const end = text.indexOf('  const menuReady =', begin);
  for (const type of ['', 'editor', 'prf', 'other']) {
    const events = {};
    const refreshes = [];
    const availability = [];
    const D = { ide: { updMenu() { throw new Error('floating/helper handler must not install menus'); } } };
    const window = { location: { search: type ? `?type=${type}` : '' }, D,
      __TAURI__: { webviewWindow: { getCurrentWebviewWindow: () => ({ listen() {} }) } },
      addEventListener(name, callback) { events[name] = callback; } };
    vm.runInNewContext(text.slice(begin, end), { window, D, URLSearchParams, nodePlatform: 'darwin',
      Menu: { updateInlineTracingState: value => availability.push(['inline', value]),
        updateOutputCommandState: value => availability.push(['output', value]) },
      sessionLabel: () => 'w1000001', tev: () => ({ emitTo: (target, event) => { refreshes.push([target, event]); return Promise.resolve(); } }), rlog() {} });
    assert.equal(typeof events.focus, 'function'); events.focus();
    assert.deepEqual(refreshes, [['w1000001', 'ride-menu-refresh']]);
    assert.deepEqual(availability, [['inline', false], ['output', false]]);
  }
});

test('only the owning main IDE installs its saved menu, including preference updates', () => {
  const text = read('src/ide.js');
  const start = text.indexOf('  const updMenu =');
  const end = text.indexOf('  D.prf.lbar(', start);
  const installed = [];
  const ide = { floating: true };
  const D = { ide, mac: true,
    prf: { menu: Object.assign(() => 'Saved custom menu', { getDefault: () => 'Default menu' }) },
    parseMenuDSL: menu => menu, installMenu: menu => installed.push(menu) };
  vm.runInNewContext(text.slice(start, end), { ide, D, window: { __RIDE__: true }, $: { err() {} }, console });
  assert.equal(typeof ide.updMenu, 'function');
  ide.updMenu();
  assert.deepEqual(installed, [], 'floating menus must retain the owning main action handlers');
  ide.floating = false; ide.updMenu();
  assert.deepEqual(installed, ['Saved custom menu']);
  ide.updMenu({ FX: [] });
  assert.deepEqual(installed, ['Saved custom menu', 'Saved custom menu']);
});

test('HTML shortcut labels use resolved bindings including an explicitly disabled command', () => {
  const nodes = [{ command: 'SC' }, { command: 'FX' }];
  class Element {
    constructor(node) { this.node = node; this.length = 0; }
    prependTo() { return this; } empty() { return this; } addClass() { return this; }
    append() { return this; } find() { return this; } on() { return this; }
    keydown() { return this; } mousedown() { return this; }
    each(callback) { nodes.forEach((node, i) => callback(i, node)); return this; }
    data() { return this.node.command; } text(value) { this.node.text = value; return this; }
  }
  const $ = node => new Element(node);
  const D = { mac: false, cmds: [['SC', '', ['Ctrl+F']], ['FX', '', []]],
    prf: { keys: callback => { if (!callback) return {}; return undefined; } },
    effectiveKeys: () => ({ SC: [], FX: ['Ctrl+S'] }) };
  vm.runInNewContext(read('src/menu.js'), { D, $, window: {}, document: {} });
  D.installMenu([]);
  assert.deepEqual(nodes.map(node => node.text), ['', 'Ctrl+S']);
});

test('Explain Last Error has a semantic native ID so it follows the focused session', () => {
  const context = shimMenu();
  const item = context.menuItems([{ label: 'Explain Last Error', rideCommand: 'AGE' }], 'app:w1000001:9', new Map(), true)[0];
  assert.equal(item.id, 'app:w1000001:9:0:AGE');
});
