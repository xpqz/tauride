const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.env.TAURIDE_TEST_ROOT || path.resolve(__dirname, '..');
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
    canRunOutputCommand() { return this.enabled; },
    runOutputCommand(code, me) { if (this.enabled) calls.push([code, me]); },
    openInlineInspection(view, me) { if (this.enabled) calls.push([view, me]); } };
  if (native) D.el = { Menu, MenuItem };
  vm.runInContext(read('src/menu.js'), context);
  return { D, calls, Menu, context, listeners };
}

const leaf = (items, command) => {
  for (const item of items) { if (item.rideCommand === command) return item;
    const found = item.submenu && leaf(item.submenu.items || item.submenu, command);
    if (found) return found; }
  return undefined;
};

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
    Menu: { updateInlineTracingState() {}, updateOutputCommandState: enabled => state.push(enabled) } });
  return { listeners, state };
}


const commands = {
  BXO: ']box off', BXN: ']box on -style=non', BXMIN: ']box on -style=min',
  BXMID: ']box on -style=mid', BXMAX: ']box on -style=max', BXQ: ']box ?', BXH: ']box -??',
  RWO: ']rows off', RWL: ']rows on -style=long', RWC: ']rows on -style=cut',
  RWW: ']rows on -style=wrap', RWFO: ']rows on -fold=off',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`RWF${n}`, `]rows on -fold=${n}`])),
  RWQ: ']rows ?', RWH: ']rows -??',
};
const outputMenu = (D, label) => D.parseMenuDSL(D.prf.menu())
  .find(item => item[''] === '&View').items.find(item => item[''] === label);

function flatten(items) {
  return items.flatMap(item => item.items ? flatten(item.items) : [item]);
}

test('Boxing and Rows expose exact documented actions with no new default shortcuts or checkmarks', () => {
  const { D } = load();
  assert.deepEqual({ ...D.outputCommands }, commands);
  const box = outputMenu(D, 'Boxing');
  const rows = outputMenu(D, 'Rows');
  assert.ok(box, 'View must expose Boxing');
  assert.ok(rows, 'View must expose Rows');
  assert.deepEqual(Array.from(box.items.filter(item => item.cmd), item => item.cmd),
    ['BXO', 'BXN', 'BXMIN', 'BXMID', 'BXMAX', 'BXQ', 'BXH']);
  assert.deepEqual(Array.from(rows.items.filter(item => item.cmd), item => item.cmd),
    ['RWO', 'RWL', 'RWC', 'RWW', 'RWQ', 'RWH']);
  const folding = rows.items.find(item => item[''] === 'Folding');
  assert.ok(folding, 'Rows must expose folding choices separately from style');
  assert.deepEqual(Array.from(folding.items, item => item.cmd),
    ['RWFO', ...Array.from({ length: 10 }, (_, n) => `RWF${n}`)]);
  for (const item of flatten([box, rows]).filter(item => item.cmd)) {
    assert.deepEqual(Array.from(D.cmds.find(entry => entry[0] === item.cmd)[2]), []);
    assert.equal(item.group, undefined);
    assert.equal(item.checkBoxPref, undefined);
  }
});

test('every output dispatcher supplies its code and actual focused editor to the owning IDE', () => {
  const { D, calls } = load();
  for (const code of Object.keys(commands)) {
    assert.equal(typeof D.commands[code], 'function', `${code} must have a dispatcher`);
    D.commands[code](D.ide.focusedWin.me);
    assert.deepEqual(calls.at(-1), [code, D.ide.focusedWin.me]);
  }
});

test('saved custom menus and shortcuts persist and stale output actions recheck availability', () => {
  const savedMenu = '&Custom\n  Box non =BXN\n  Fold three =RWF3\n  Preferences =PRF';
  const { D, calls } = load({ savedMenu });
  assert.equal(D.prf.menu(), savedMenu);
  D.prf.keys({ BXN: ['Ctrl+Shift+B'], RWF3: [] });
  assert.deepEqual(Array.from(D.prf.keys().BXN), ['Ctrl+Shift+B']);
  const items = D.parseMenuDSL(D.prf.menu())[0].items.slice(0, 2);
  for (const item of items) {
    assert.equal(typeof item.isEnabled, 'function');
    assert.equal(item.isEnabled(), true);
    D.ide.enabled = false;
    assert.equal(item.isEnabled(), false);
    item.action();
    assert.equal(calls.length, 0, 'stale custom menu cannot dispatch while busy/input/disconnected');
    D.ide.enabled = true;
    item.action();
    assert.deepEqual(calls.at(-1), [item.cmd, D.ide.focusedWin.me]);
    calls.length = 0;
  }
});

test('native custom output items refresh readiness and retain user accelerator overrides', () => {
  const { D, Menu } = load({ native: true,
    savedMenu: '&Custom\n  Box non =BXN\n  Rows help =RWH\n  Preferences =PRF' });
  D.prf.keys({ BXN: ['Ctrl+Shift+B'], RWH: [] });
  D.ide.enabled = false;
  D.installMenu(D.parseMenuDSL(D.prf.menu()));
  assert.equal(leaf(Menu.current.items, 'BXN').enabled, false);
  assert.equal(leaf(Menu.current.items, 'BXN').accelerator, 'Ctrl+Shift+B');
  assert.equal(leaf(Menu.current.items, 'RWH').accelerator, null);
  assert.equal(typeof D.refreshOutputCommandMenu, 'function');
  D.ide.enabled = true;
  D.refreshOutputCommandMenu();
  assert.equal(leaf(Menu.current.items, 'BXN').enabled, true);
  assert.equal(leaf(Menu.current.items, 'RWH').enabled, true);
});

test('HTML output items advertise disabled state and guard stale mouse actions', () => {
  const dom = htmlMenuDOM();
  const { D, calls } = load({ jquery: dom.$ });
  D.ide.enabled = false;
  D.installMenu(D.parseMenuDSL('&Custom\n  Rows wrap =RWW\n  Preferences =PRF'));
  const wrap = dom.anchors.find(anchor => anchor.markup.includes('Rows wrap'));
  assert.equal(wrap.attr('aria-disabled'), 'true');
  wrap.handlers.click();
  assert.equal(calls.length, 0);
  D.ide.enabled = true;
  D.refreshOutputCommandMenu();
  assert.equal(wrap.attr('aria-disabled'), 'false');
  D.ide.enabled = false;
  wrap.handlers.click();
  assert.equal(calls.length, 0);
});

test('native application menu IDs identify every output action regardless of installing session', () => {
  const { context } = shimMenu();
  for (const owner of ['main', 'w1000001', 'w1000012']) {
    for (const code of Object.keys(commands)) {
      const item = context.menuItems([{ label: code, rideCommand: code }], `app:${owner}:17`, new Map(), true)[0];
      assert.equal(item.id, `app:${owner}:17:0:${code}`);
    }
  }
});

test('semantic output dispatch supplies the focused floating editor rather than installer state', () => {
  const source = read('tauri/shim.js');
  const begin = source.indexOf("      sessionWindow.listen('ride-session-menu'");
  const end = source.indexOf('\n      });', begin) + '\n      });'.length;
  const handlers = {};
  const calls = [];
  const D = { ide: { focusedWin: { me: { id: 'floating-editor' } } }, commands: {} };
  for (const code of Object.keys(commands)) D.commands[code] = me => calls.push([code, me]);
  vm.runInNewContext(source.slice(begin, end), { window: { D }, D,
    sessionWindow: { listen: (name, callback) => { handlers[name] = callback; } } });
  for (const code of Object.keys(commands)) handlers['ride-session-menu']({ payload: code });
  assert.deepEqual(calls, Object.keys(commands).map(code => [code, D.ide.focusedWin.me]));
});

test('native focus refreshes ready/busy owning sessions and floating views, disabling helper output items', () => {
  const updates = [];
  const ready = { refreshInlineTracingMenu() {}, refreshOutputCommandMenu: () => updates.push(['first', true]) };
  const busy = { refreshInlineTracingMenu() {}, refreshOutputCommandMenu: () => updates.push(['second', false]) };
  const first = focusHooks('', ready);
  const second = focusHooks('', busy);
  const floating = focusHooks('editor', ready);
  const helper = focusHooks('prf');
  for (const hooks of [second, first, floating, helper]) hooks.listeners.focus();
  assert.deepEqual(updates, [['second', false], ['first', true], ['first', true]]);
  assert.deepEqual(helper.state, [false]);
});


test('Electron native output callbacks refuse helpers and preserve session/floating targets', () => {
  const { D, calls, context } = load();
  context.URL = URL;
  context.window.__RIDE__ = false;
  let url = 'file:///ride/index.html';
  let focused = true;
  D.el = { BrowserWindow: { getFocusedWindow: () => focused
    ? { webContents: { getURL: () => url } } : null } };
  const pane = D.ide.focusedWin.me;
  D.commands.BXN(pane);
  assert.deepEqual(calls.pop(), ['BXN', pane]);
  for (const helper of ['index.html?type=prf', 'about.html', 'log.html', 'status.html', 'dialog.html']) {
    url = `file:///ride/${helper}`;
    D.commands.BXN(pane);
    assert.equal(calls.length, 0, `${helper} cannot act on the stale main pane`);
  }
  url = 'file:///ride/index.html?type=editor&id=12';
  const floating = { id: 'floating-proxy' };
  D.ide.focusedWin.me = floating;
  D.commands.RWF3(floating);
  assert.deepEqual(calls.pop(), ['RWF3', floating]);
  focused = false;
  D.commands.BXN(pane);
  assert.equal(calls.length, 0);
  delete D.ide;
  assert.doesNotThrow(() => D.commands.BXN(pane));
});


test('native default output labels never replace explicit commands with built-in roles', () => {
  const { D, Menu } = load({ native: true });
  D.installMenu(D.parseMenuDSL(D.prf.menu()));
  for (const code of ['RWC', 'RWQ', 'RWH', 'BXQ', 'BXH']) {
    assert.equal(leaf(Menu.current.items, code).role, undefined, `${code} must retain its command`);
  }
  for (const [code, role] of [['CT', 'cut'], ['CP', 'copy'], ['PT', 'paste']]) {
    assert.equal(leaf(Menu.current.items, code).role, role);
  }
});

test('native roles follow clipboard command codes even after custom relabeling', () => {
  const { D, Menu } = load({ native: true, savedMenu: '&Custom\n  Cut =BXN\n  Help =RWH'
    + '\n  Remove Selection =CT\n  Duplicate Selection =CP\n  Insert Clipboard =PT'
    + '\n  Cut\n  Toggle Full Screen\n  Show All\n  Window\n  Help\n  Hide\n  Hide Others\n  Preferences =PRF' });
  D.installMenu(D.parseMenuDSL(D.prf.menu()));
  assert.equal(leaf(Menu.current.items, 'BXN').role, undefined);
  assert.equal(leaf(Menu.current.items, 'RWH').role, undefined);
  for (const [code, role] of [['CT', 'cut'], ['CP', 'copy'], ['PT', 'paste']]) {
    assert.equal(leaf(Menu.current.items, code).role, role);
  }
  const items = Menu.current.items[0].submenu.items;
  for (const [label, role] of [['Cut', 'cut'], ['Toggle Full Screen', 'togglefullscreen'], ['Show All', 'unhide'],
    ['Window', 'window'], ['Help', 'help'], ['Hide', 'hide'], ['Hide Others', 'hideothers']]) {
    assert.equal(items.find(item => item.label === label && !item.rideCommand).role, role);
  }
});
