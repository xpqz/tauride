const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.env.TAURIDE_TEST_ROOT || path.resolve(__dirname, '..');
const views = [
  ['ITL', 'Left Argument', 'Left'], ['ITF', 'Current Function', 'Function'],
  ['ITR', 'Right Argument', 'Right'], ['ITA', 'Axis Specification', 'Axis'],
  ['ITRES', 'Previous Result', 'Result'], ['ITPL', 'Previous Left Argument', 'PLeft'],
  ['ITPF', 'Previous Function', 'PFunction'], ['ITPR', 'Previous Right Argument', 'PRight'],
  ['ITPA', 'Previous Axis', 'PAxis'],
];
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function load({ native = false, savedMenu, jquery } = {}) {
  const values = new Map(savedMenu ? [['menu', savedMenu]] : []);
  const storage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const calls = [];
  class Menu { constructor() { this.items = []; } append(item) { this.items.push(item); }
    static setApplicationMenu(menu) { Menu.current = menu; }
    static buildFromTemplate(items) { return { items, popup() { Menu.popup = this; } }; } }
  class MenuItem { constructor(options) { Object.assign(this, options); } }
  const D = { openExternal() {}, lb: { order: '' }, prf_tabs: {}, commands: {}, keyMap: {}, informal: [],
    kbds: { layouts: { en_US: ['', '', '', ''] } }, mac: native };
  const listeners = {};
  const context = vm.createContext({ D, nodeRequire: null, localStorage: storage,
    navigator: { language: 'en-US' }, $: jquery || { extend: Object.assign },
    document: { hasFocus: () => true }, window: { __RIDE__: native,
      addEventListener(name, callback) { listeners[name] = callback; } } });
  for (const name of ['prf', 'cmds', 'prf_menu', 'km']) vm.runInContext(read(`src/${name}.js`), context);
  D.ide = { enabled: true, focusedWin: { me: { id: 'main-tracer' } },
    canInspectInline() { return this.enabled; },
    openInlineInspection(view, me) { if (this.enabled) calls.push([view, me]); } };
  if (native) D.el = { Menu, MenuItem };
  vm.runInContext(read('src/menu.js'), context);
  return { D, calls, Menu, context, listeners };
}

const submenu = D => D.parseMenuDSL(D.prf.menu()).find(item => item[''] === '&Action')
  .items.find(item => item[''] === 'Inline Tracing');
const leaf = (items, command) => {
  for (const item of items) { if (item.rideCommand === command) return item;
    const found = item.submenu && leaf(item.submenu.items || item.submenu, command);
    if (found) return found; }
  return undefined;
};

test('default Action menu groups all existing inline views and retains primitive stepping shortcut', () => {
  const { D } = load();
  const menu = submenu(D);
  assert.ok(menu, 'Action must expose the Inline Tracing submenu');
  assert.deepEqual(Array.from(menu.items, item => item['']),
    ['Next Primitive', '-', ...views.slice(0, 4).map(item => item[1]), '-', ...views.slice(4).map(item => item[1])]);
  assert.equal(menu.items[0].cmd, 'IT');
  assert.deepEqual(Array.from(D.cmds.find(item => item[0] === 'IT')[2]), ['Ctrl+Alt+Enter']);
  for (const [code, label] of views) {
    assert.equal(menu.items.find(item => item.cmd === code)[''], label);
    assert.deepEqual(Array.from(D.cmds.find(item => item[0] === code)[2]), []);
  }
});

test('inspection actions pass exact current/previous views and the focused editor to the owning IDE', () => {
  const { D, calls } = load();
  for (const [code, , view] of views) {
    assert.equal(typeof D.commands[code], 'function', `${code} must have a dispatcher`);
    D.commands[code](D.ide.focusedWin.me);
    assert.deepEqual(calls.at(-1), [view, D.ide.focusedWin.me]);
  }
  D.commands.ITL(D.ide.focusedWin.me);
  assert.equal(calls.filter(item => item[0] === 'Left').length, 2, 'reopening must reach the interpreter command');
});

test('saved custom menus remain unchanged and inspection items recheck changed availability', () => {
  const savedMenu = '&Custom\n  Inspect Right =ITR\n  Preferences =PRF';
  const { D, calls } = load({ savedMenu });
  assert.equal(D.prf.menu(), savedMenu);
  const items = D.parseMenuDSL(D.prf.menu());
  assert.equal(items.length, 1);
  const item = items[0].items[0];
  assert.equal(typeof item.isEnabled, 'function', 'custom commands use the session availability predicate');
  assert.equal(item.isEnabled(), true);
  D.ide.enabled = false;
  assert.equal(item.isEnabled(), false);
  item.action();
  assert.equal(calls.length, 0, 'an item opened before a state change cannot dispatch into busy/input/disconnected states');
});

test('native menu inspection availability refreshes after owning session state changes', () => {
  const { D, Menu } = load({ native: true });
  D.ide.enabled = false;
  D.installMenu(D.parseMenuDSL(D.prf.menu()));
  for (const [code] of views) assert.equal(leaf(Menu.current.items, code)?.enabled, false, `${code} disabled`);
  assert.equal(typeof D.refreshInlineTracingMenu, 'function');
  D.ide.enabled = true;
  D.refreshInlineTracingMenu();
  for (const [code] of views) assert.equal(leaf(Menu.current.items, code)?.enabled, true, `${code} enabled`);
});

test('tracer context menu exposes the same grouped inline actions and a captured tracer target', () => {
  const { D, Menu, context, calls } = load({ native: true });
  const source = read('src/init.js');
  const start = source.indexOf('    D.createContextMenu =');
  vm.runInContext(source.slice(start, source.indexOf('    D.createContextMenu(window);', start)), context);
  const el = {};
  const win = { tc: true, me: { getSelection: () => ({ isEmpty: () => true }) }, session: { get: () => false } };
  const open = () => el.oncontextmenu({ preventDefault() {}, stopPropagation() {}, target: { classList: { contains: () => false } } });
  D.createContextMenu(el, win);
  open();
  const menu = Menu.popup.items.find(item => item.label === 'Inline Tracing');
  assert.ok(menu, 'tracer context menu must expose Inline Tracing');
  assert.deepEqual(Array.from(menu.submenu, item => item.label || '-'),
    ['Next Primitive', '-', ...views.slice(0, 4).map(item => item[1]), '-', ...views.slice(4).map(item => item[1])]);
  menu.submenu.find(item => item.label === 'Previous Right Argument').click();
  assert.deepEqual(calls.at(-1), ['PRight', win.me]);
  D.ide.enabled = false;
  open();
  for (const item of Menu.popup.items.find(item => item.label === 'Inline Tracing').submenu) {
    if (item.label && item.label !== 'Next Primitive') assert.equal(item.enabled, false);
  }
  win.tc = false;
  open();
  assert.equal(Menu.popup.items.some(item => item.label === 'Inline Tracing'), false);
});

function shimMenu() {
  const source = read('tauri/shim.js');
  const begin = source.indexOf('  const menuItems =');
  const end = source.indexOf('  const shell =', begin);
  const events = {};
  const clicks = new Map();
  const emitted = [];
  const invoked = [];
  const context = vm.createContext({ menuClicks: clicks, appClicks: new Map(), menuSeq: 0,
    window: { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: 'main' } } } },
    nodePlatform: 'darwin', currentId: () => 0, runRole() {}, menuReady: () => Promise.resolve(),
    invoke(command, args) { invoked.push([command, args]); return Promise.resolve(); },
    tev: () => ({ emit(name) { emitted.push(name); return Promise.resolve(); } }), rlog() {} });
  vm.runInContext(`${source.slice(begin, end)}\nthis.menuItems = menuItems; this.Menu = Menu;`, context);
  return { context, events, clicks, emitted, invoked };
}

test('macOS application menu IDs carry semantic commands for primitive stepping and all inspections', () => {
  const { context } = shimMenu();
  for (const code of ['IT', ...views.map(item => item[0])]) {
    const item = context.menuItems([{ label: code, rideCommand: code }], 'app:main:17', new Map(), true)[0];
    assert.equal(item.id, `app:main:17:0:${code}`, `${code} must route to native focus, independent of installing session`);
  }
});

test('semantic native menu dispatch supplies the focused floating or main editor', () => {
  const source = read('tauri/shim.js');
  const begin = source.indexOf("      sessionWindow.listen('ride-session-menu'");
  const end = source.indexOf('\n      });', begin) + '\n      });'.length;
  const handlers = {};
  const calls = [];
  const D = { ide: { focusedWin: { me: { id: 'floating-tracer' } } }, commands: { IT: me => calls.push(me), ITL: me => calls.push(me) } };
  vm.runInNewContext(source.slice(begin, end), { window: { D }, D,
    sessionWindow: { listen: (name, callback) => { handlers[name] = callback; } } });
  for (const command of ['IT', 'ITL']) handlers['ride-session-menu']({ payload: command });
  assert.deepEqual(calls, [D.ide.focusedWin.me, D.ide.focusedWin.me]);
});


function htmlMenuDOM() {
  const anchors = [];
  class Element {
    constructor(markup) { this.markup = markup; this.attributes = {}; this.handlers = {}; this.length = 0;
      if (typeof markup === 'string' && markup.startsWith('<a ')) { anchors.push(this); this.length = 1; } }
    append() { return this; }
    prependTo() { return this; }
    empty() { return this; }
    addClass() { return this; }
    removeClass() { return this; }
    toggleClass() { return this; }
    attr(name, value) { if (value === undefined) return this.attributes[name]; this.attributes[name] = value; return this; }
    css() { return this; }
    on(names, handler) { for (const name of names.split(' ')) this.handlers[name] = handler; return this; }
    find() { return new Element(''); }
    each() { return this; }
    keydown() { return this; }
    mousedown() { return this; }
    focus() { return this; }
  }
  const $ = element => element instanceof Element ? element : new Element(element);
  $.extend = Object.assign;
  return { $, anchors };
}

test('HTML inspection items advertise disabled state and guard stale mouse actions', () => {
  const dom = htmlMenuDOM();
  const { D, calls } = load({ jquery: dom.$ });
  D.ide.enabled = false;
  D.installMenu(D.parseMenuDSL(D.prf.menu()));
  const right = dom.anchors.find(anchor => anchor.markup.includes('Right Argument'));
  assert.ok(right, 'browser/HTML menu must render inspection actions');
  assert.equal(right.attr('aria-disabled'), 'true');
  right.handlers.click();
  assert.equal(calls.length, 0);
  D.ide.enabled = true;
  D.refreshInlineTracingMenu();
  assert.equal(right.attr('aria-disabled'), 'false');
  D.ide.enabled = false;
  right.handlers.click();
  assert.equal(calls.length, 0, 'availability is rechecked even if refresh has not reached the menu');
});

function focusHooks(type, D) {
  const source = read('tauri/shim.js');
  const begin = source.indexOf('  const pageType =');
  const end = source.indexOf('  const menuReady =', begin);
  const listeners = {};
  const state = [];
  const window = { location: { search: type ? `?type=${type}` : '' }, D,
    __TAURI__: { webviewWindow: { getCurrentWebviewWindow: () => ({ listen() {} }) } },
    addEventListener(name, callback) { listeners[name] = callback; } };
  vm.runInNewContext(source.slice(begin, end), { window, D, URLSearchParams,
    Menu: { updateInlineTracingState: enabled => state.push(enabled) } });
  return { listeners, state };
}

test('native focus requests the focused owner availability, including floating windows and helpers', () => {
  const updates = [];
  const readySession = { refreshInlineTracingMenu: () => updates.push(['first', true]) };
  const busySession = { refreshInlineTracingMenu: () => updates.push(['second', false]) };
  const first = focusHooks('', readySession);
  const second = focusHooks('', busySession);
  const floating = focusHooks('editor', readySession);
  const helper = focusHooks('prf');
  for (const hooks of [second, first, floating, helper]) {
    assert.equal(typeof hooks.listeners.focus, 'function', 'native focus must refresh shared app menu availability');
    hooks.listeners.focus();
  }
  assert.deepEqual(updates, [['second', false], ['first', true], ['first', true]]);
  assert.deepEqual(helper.state, [false], 'helpers must disable inspection actions');
});


test('reinstalling a native custom menu requests availability from its focused owner', async () => {
  const { context, emitted, invoked } = shimMenu();
  const menu = new context.Menu();
  menu.append({ label: 'Inspect Right', rideCommand: 'ITR', enabled: false });
  menu.append({ label: 'Toolbar', rideCommand: 'TTB', type: 'checkbox', checked: true });
  context.Menu.setApplicationMenu(menu);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(invoked[0][0], 'set_app_menu');
  assert.deepEqual(emitted, ['ride-inline-menu-refresh']);
  assert.deepEqual(Array.from(invoked[0][1].items, item => item.label), ['Inspect Right', 'Toolbar']);
  // Preference toggles reinstall the existing menu through the same entry point.
  menu.items[1].checked = false;
  context.Menu.setApplicationMenu(menu);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(emitted, ['ride-inline-menu-refresh', 'ride-inline-menu-refresh']);
  assert.equal(invoked[1][1].items[0].id.endsWith(':ITR'), true);
  assert.equal(invoked[1][1].items[1].checked, false);
});
