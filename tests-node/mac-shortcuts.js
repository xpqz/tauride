const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = process.env.TAURIDE_TEST_ROOT || path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const plain = x => JSON.parse(JSON.stringify(x));

function load(mac = true, overrides = {}, tauri = false) {
  const handlers = new Map(); const bindings = []; const removed = []; const sent = [];
  const callbacks = {}; let next = 0;
  const prefs = { keys: overrides, pfkeys: [], kbdLocale: 'en_US', prefixKey: '`', prefixMaps: {} };
  const D = { mac, win: !mac, informal: [], prf_tabs: {}, commands: {}, keyMap: {},
    kbds: { layouts: { en_US: ['abc', 'ABC', '⍺⊥∩', '⍬⊢⊆'] } },
    prf: new Proxy({}, { get: (_, key) => (value) => {
      if (typeof value === 'function') { (callbacks[key] ||= []).push(value); return; }
      if (value !== undefined) prefs[key] = value;
      return prefs[key];
    } }), send: (...args) => sent.push(args), ide: { connected: true, wins: {} },
  };
  const codes = new Proxy({}, { get: (obj, key) => {
    if (obj[key] !== undefined) return obj[key];
    const code = ++next; obj[key] = code; obj[code] = key; return code;
  } });
  const register = (key, run, when, id = `old-${++next}`) => {
    bindings.push({ key, run, when, id, active: true });
    return id;
  };
  const monaco = { KeyCode: codes, KeyMod: { CtrlCmd: 2048, WinCtrl: 256, Shift: 1024, Alt: 512 },
    editor: {
      registerCommand(id, run) { handlers.set(id, run); return { dispose: () => handlers.delete(id) }; },
      addKeybindingRules(rules) {
        const entries = rules.map(rule => {
          if (rule.command.startsWith('-')) { removed.push(rule.command.slice(1)); return {}; }
          const entry = { key: rule.keybinding, id: rule.command, when: rule.when, active: true,
            run: () => handlers.get(rule.command)?.() }; bindings.push(entry); return entry;
        });
        return { dispose() { entries.forEach(entry => { entry.active = false; }); } };
      },
    },
  };
  const $ = () => []; $.extend = Object.assign;
  const closes = [];
  const context = vm.createContext({ D, monaco, navigator: { language: 'en-US' },
    $, URL, window: { __RIDE__: tauri, close: () => closes.push('current') }, setTimeout() {}, console });
  ['src/cmds.js', 'src/km.js', 'src/prf_shc.js', 'src/se.js', 'src/ed.js'].forEach(file => vm.runInContext(source(file), context));
  function pane(id, options = {}) {
    const w = Object.assign({ id, tc: false, isReadOnly: false, isReadOnlyEntity: false, ide: D.ide,
      FX() {}, RD() {}, STL() {}, DC() {}, UC() {}, RC() {}, indentOrComplete() {},
      execCommand(code) { this[code](this.me); } }, options);
    let textFocus = true; let widgetFocus = true; let disposed = () => {};
    const me = { dyalogCmds: w, getId: () => String(id), hasTextFocus: () => textFocus,
      hasWidgetFocus: () => widgetFocus, trigger() {}, onDidDispose(callback) { disposed = callback; },
      addCommand: register,
      addAction(action) {
        const entries = action.keybindings.map(key => ({ key, id: action.id, when: action.precondition,
          run: () => action.run(me), active: true })); bindings.push(...entries);
        return { dispose() { entries.forEach(entry => { entry.active = false; }); } };
      },
    };
    w.me = me; D.ide.wins[id] = w; D.ide.focusedWin = w;
    return { w, me, focus(text, widget = text) { textFocus = text; widgetFocus = widget; },
      dispose() { disposed(); textFocus = false; widgetFocus = false; },
      press(key) {
        const context = { editorId: String(id), editorTextFocus: textFocus,
          editorReadonly: w.isReadOnly, session: w.id === 0, tracer: w.tc };
        const binding = bindings.slice().reverse().find(b => {
          if (!b.active || b.key !== key) return false;
          try { return !b.when || vm.runInNewContext(b.when, context); } catch (_) { return false; }
        });
        binding?.run();
      },
    };
  }
  function remap(keys) {
    prefs.keys = keys;
    callbacks.keys?.forEach(f => f(keys));
  }
  function preferencesUI() {
    const cells = []; const fields = {};
    const span = title => ({ title, duplicate: false, scrollIntoViewIfNeeded() {},
      classList: { toggle(_, value) { this.owner.duplicate = value; return value; },
        add() { this.owner.duplicate = true; } } });
    const spans = keys => keys.map(key => { const node = span(key); node.classList.owner = node; return node; });
    const table = {
      set innerHTML(html) {
        cells.length = 0;
        for (const match of html.matchAll(/<td id=shc_itm_(\w+)>([\s\S]*?)<button/g)) {
          const cell = { id: `shc_itm_${match[1]}`, keys: spans([...match[2].matchAll(/class=shc_text title="([^"]+)"/g)].map(x => x[1])),
            querySelectorAll() { return this.keys; } }; cells.push(cell);
        }
      },
      querySelectorAll: () => cells.flatMap(cell => cell.keys),
      getElementsByClassName: () => cells.flatMap(cell => cell.keys).filter(key => key.duplicate),
    };
    const q = { tbl_wr: table, prnt: {}, rst_all: {}, sc: { value: '' }, sc_clr: {}, defined: {} };
    const dollar = () => cells; dollar.extend = Object.assign; context.$ = dollar;
    context.document = { getElementById: id => fields[id] ||= {} };
    context.J = { shc: q };
    const tab = {}; D.prf_tabs.shc.init(tab); D.prf_tabs.shc.load();
    const text = source('src/prf_shc.js');
    const dup = vm.runInNewContext(`(() => {${text.slice(text.indexOf('  const updDups ='), text.indexOf('  const getKeystroke ='))}; return updDups;})()`, { q, D });
    return { get: command => cells.find(cell => cell.id === `shc_itm_${command}`).keys.map(key => key.title),
      set(command, keys) { cells.find(cell => cell.id === `shc_itm_${command}`).keys = spans(keys); },
      save: () => { D.prf_tabs.shc.save(); return prefs.keys; }, dup,
      reset(command) {
        const cell = cells.find(c => c.id === `shc_itm_${command}`);
        cell.keys.forEach(node => { node.parentNode = { removeChild() {} }; });
        const row = { dataset: { code: command }, getElementsByClassName: () => cell.keys,
          querySelector: () => ({ insertAdjacentHTML(_, html) {
            cell.keys = spans([...html.matchAll(/class=shc_text title="([^"]+)"/g)].map(x => x[1]));
          } }) };
        tab.onclick({ target: { closest: selector => selector === '.shc_rst'
          ? { parentNode: {}, closest: () => row } : null } });
      },
    };
  }
  return { D, monaco, bindings, removed, sent, closes, context, pane, remap, register, preferencesUI };
}

test('Mac Tauri Session Close uses the current window close path only with Session text focus', () => {
  for (const [mac, tauri] of [[true, true], [true, false], [false, true]]) {
    const api = load(mac, {}, tauri);
    const session = api.pane(0, { CLS: api.D.Se.prototype.CLS });
    api.D.quit = () => { throw new Error('Session Close must not quit all sessions'); };
    api.D.commands.CLS(session.me);
    assert.equal(api.closes.length, mac && tauri ? 1 : 0);
    session.focus(false, true);
    api.D.commands.CLS(session.me);
    session.focus(false);
    api.D.commands.CLS(session.me);
    assert.equal(api.closes.length, mac && tauri ? 1 : 0, 'search fields and helper inputs cannot close a stale Session');
    session.focus(true);
    api.D.ide.connected = false; api.D.ide.dead = true;
    api.D.commands.CLS(session.me);
    assert.equal(api.closes.length, mac && tauri ? 2 : 0, 'a disconnected Session can still close');
  }
});

test('Session Close follows removal, rebinding and reset while editor and tracer Close retain onClose', () => {
  const api = load(true, {}, true);
  const session = api.pane(0, { CLS: api.D.Se.prototype.CLS });
  api.D.prf.keys(api.D.mapKeys.bind(null, session.w));
  const cmdW = 2048 | api.monaco.KeyCode.KeyW;
  const cmdY = 2048 | api.monaco.KeyCode.KeyY;
  api.remap({}); session.press(cmdW); assert.equal(api.closes.length, 1);
  api.remap({ CLS: [] }); session.press(cmdW); assert.equal(api.closes.length, 1);
  api.remap({ CLS: ['Cmd+Y'] });
  session.press(cmdW); assert.equal(api.closes.length, 1, 'the default binding is removed');
  session.press(cmdY); assert.equal(api.closes.length, 2);
  api.remap({});
  session.press(cmdY); assert.equal(api.closes.length, 2, 'the old custom binding is removed');
  session.press(cmdW); assert.equal(api.closes.length, 3);
  session.focus(false);
  for (const tc of [false, true]) {
    let closed = 0;
    const editor = api.pane(tc ? 5 : 4, { tc, CLS: api.D.Ed.prototype.CLS, onClose() { closed += 1; } });
    api.D.mapKeys(editor.w); editor.press(cmdW);
    assert.equal(closed, 1, 'editor/tracer Close still calls its existing onClose');
    assert.equal(api.closes.length, 3, 'editor/tracer Close cannot close the Session window');
    editor.focus(false);
  }
});

test('Session Close retains cancellation, spawned Exit, external Disconnect and disconnected window closure', () => {
  for (const spawned of [true, false]) {
    const api = load(true, {}, true);
    const session = api.pane(0, { CLS: api.D.Se.prototype.CLS });
    const prompts = []; let answer = false; let destroys = 0;
    api.D.spawned = spawned;
    api.D.wins = { 0: { histWrite() {} } };
    api.D.wm = { current: () => ({ native: {} }) };
    api.D.el = {};
    api.D.prf.sqp(1);
    api.context.$.confirm = (message, title, callback) => { prompts.push(message); callback(answer); };
    api.context.process = { env: {} };
    api.context.document = { title: 'Session Close' };
    api.context.setTimeout = callback => callback();
    api.context.thisWindow = () => ({ destroy() { destroys += 1; } });
    const init = source('src/init.js');
    vm.runInContext(init.slice(init.indexOf('    window.onbeforeunload ='), init.indexOf("    let platform =")), api.context);
    const shim = source('tauri/shim.js');
    vm.runInContext(shim.slice(shim.indexOf('  const closeWindow ='), shim.indexOf("  window.addEventListener('DOMContentLoaded'", shim.indexOf('  const closeWindow ='))), api.context);
    api.D.commands.CLS(session.me);
    assert.deepEqual(prompts, [spawned ? 'Quit Dyalog APL. Are you sure?' : 'Disconnect from interpreter. Are you sure?']);
    assert.equal(api.sent.length, 0); assert.equal(destroys, 0);
    assert.equal(api.D.ide.closing, undefined, 'Cancel leaves the Session usable');
    answer = true; api.D.commands.CLS(session.me);
    assert.deepEqual(plain(api.sent), spawned ? [['Exit', { code: 0 }]]
      : [['Disconnect', { message: 'User shutdown request' }]]);
    if (spawned) {
      assert.equal(destroys, 0, 'spawned sessions wait for the interpreter to disconnect');
      api.D.ide.connected = 0;
      api.context.window.close();
    }
    assert.equal(destroys, 1);
    assert.equal(prompts.length, 2, 'the final disconnected close does not ask again');
  }
});

test('busy Mac Tauri Session cannot replay a canceled Close chord after the prompt returns', () => {
  for (const tauri of [true, false]) {
    const api = load(true, {}, tauri); api.remap({});
    const se = { taBuffer: [] }; let capture;
    const text = source('src/se.js');
    const start = text.indexOf('      se.taCb = se.taCb || me.onKeyDown');
    const end = text.indexOf('    } else {', start);
    vm.runInNewContext(text.slice(start, end), {
      se, D: api.D, monaco: api.monaco, window: api.context.window,
      me: { onKeyDown(callback) { capture = callback; return { dispose() {} }; } },
    });
    const chord = letter => ({ keyCode: api.monaco.KeyCode[`Key${letter.toUpperCase()}`],
      browserEvent: { key: letter, ctrlKey: false, altKey: false, metaKey: true, shiftKey: false } });
    capture(chord('w'));
    assert.equal(se.taBuffer.length, tauri ? 0 : 1, 'the already executed Close must not be queued again');
    se.taBuffer.length = 0;
    api.remap({ CLS: ['Cmd+Y'] });
    capture(chord('y'));
    assert.equal(se.taBuffer.length, tauri ? 0 : 1, 'custom Close uses its effective binding');
    se.taBuffer.length = 0;
    capture(chord('w'));
    assert.deepEqual(plain(se.taBuffer), [chord('w').browserEvent], 'the old default retains normal typeahead');
    se.taBuffer.length = 0;
    api.remap({ CLS: [] }); capture(chord('y'));
    const textKey = { browserEvent: { key: 'a' } };
    const pfKey = { browserEvent: { key: 'F8' } };
    capture(textKey); capture(pfKey);
    assert.deepEqual(plain(se.taBuffer), [chord('y').browserEvent, 'a', pfKey.browserEvent],
      'unbound Close, ordinary text and PF keys retain normal typeahead');
  }
});

const newMac = { FX: ['Cmd+S'], SI: ['Ctrl+C'], SC: ['Cmd+F'], RP: ['Cmd+Option+F'],
  QCP: ['Cmd+Shift+P'], TGC: ['Cmd+/'], RD: ['Shift+Option+F', 'NumPad_Divide'], WI: [] };

test('Mac defaults change only the agreed commands; Windows/Linux defaults and PF bindings stay intact', () => {
  const mac = load().D; const other = load(false).D;
  for (const [command, keys] of Object.entries(newMac)) {
    assert.deepEqual(plain(mac.cmds.find(entry => entry[0] === command)[2]), keys);
  }
  const old = { FX: [], SI: [], SC: ['Ctrl+F'], RP: [], QCP: [], TGC: [], RD: ['NumPad_Divide'], WI: ['Ctrl+PauseBreak'] };
  for (const [command, keys] of Object.entries(old)) assert.deepEqual(plain(other.cmds.find(entry => entry[0] === command)[2]), keys);
  assert.deepEqual(plain(mac.cmds.filter(entry => /^PF/.test(entry[0]))), plain(other.cmds.filter(entry => /^PF/.test(entry[0]))));
});

test('explicit saved shortcuts and empty arrays beat new defaults, including modifier aliases and order', () => {
  const { D } = load();
  assert.equal(typeof D.effectiveKeys, 'function');
  const resolved = D.effectiveKeys({ AC: ['Meta+S'], AO: ['Option+Shift+F'], SC: [], RP: ['Alt+Cmd+R'], SI: [], BP: ['Shift+Meta+P'], WI: ['Ctrl+PauseBreak'] });
  assert.deepEqual(plain(resolved.AC), ['Cmd+S']);
  assert.deepEqual(plain(resolved.FX), []);
  assert.deepEqual(plain(resolved.RD), ['NumPad_Divide']);
  assert.deepEqual(plain(resolved.SC), []);
  assert.deepEqual(plain(resolved.SI), []);
  assert.deepEqual(plain(resolved.WI), ['Ctrl+PauseBreak'], 'saved Weak Interrupt bindings remain available');
  assert.deepEqual(plain(D.effectiveKeys({ WI: [] }).WI), []);
  assert.deepEqual(plain(D.effectiveKeys({ WI: ['Cmd+Shift+I'] }).WI), ['Cmd+Shift+I']);
  assert.deepEqual(plain(resolved.RP), ['Cmd+Option+R']);
  assert.deepEqual(plain(resolved.QCP), [], 'modifier order aliases must claim the same chord');
});

test('Mac mapping changes dispose previous bindings and suppress inherited find/replace/comment shortcuts', () => {
  const api = load(); const pane = api.pane(4);
  api.D.keyMap.dyalog = { 'Cmd+F': 'SC' };
  api.D.prf.keys(api.D.mapKeys.bind(null, pane.w));
  api.D.mapKeys(pane.w);
  const old = api.bindings.filter(b => b.active && b.key === (2048 | api.monaco.KeyCode.KeyF));
  assert.ok(old.length);
  api.remap({ SC: [] });
  assert.ok(old.every(binding => !binding.active), 'previous CmdF registration must be disposed');
  api.D.remDefaultMap();
  for (const command of ['actions.find', 'editor.action.startFindReplaceAction', 'editor.action.commentLine', 'editor.action.quickCommand']) {
    assert.ok(api.removed.includes(command), `inherited ${command} binding must not survive an empty preference`);
  }
  assert.equal(api.D.effectiveKeys({ SC: [] }).SC.length, 0);
});

test('focused Strong Interrupt works in busy read-only Session and rejects search/input/disconnected contexts', () => {
  const api = load(); const pane = api.pane(0, { isReadOnly: true }); api.D.ide.promptType = 0;
  assert.equal(typeof api.D.runFocusedCommand, 'function');
  api.D.runFocusedCommand('SI');
  assert.deepEqual(plain(api.sent), [['StrongInterrupt', {}]]);
  pane.focus(false, true); api.D.runFocusedCommand('SI');
  assert.equal(api.sent.length, 1, 'find-widget focus is not an APL text pane');
  pane.focus(false); api.D.runFocusedCommand('SI');
  assert.equal(api.sent.length, 1, 'ordinary input/helper focus cannot interrupt');
  pane.focus(true); api.D.ide.connected = false; api.D.runFocusedCommand('SI');
  assert.equal(api.sent.length, 1);
});

test('Fix dispatch applies only to writable editors, including variables, and finds actual focus', () => {
  const api = load(); let fixes = 0;
  const editor = api.pane(4, { FX() { fixes += 1; } });
  const stale = api.pane(5, { FX() { throw new Error('stale pane received Fix'); } }); stale.focus(false);
  assert.equal(typeof api.D.runFocusedCommand, 'function');
  api.D.runFocusedCommand('FX'); assert.equal(fixes, 1);
  for (const change of [{ tc: true }, { isReadOnly: true }, { isReadOnlyEntity: true }, { id: 0 }]) {
    const original = { id: editor.w.id, tc: editor.w.tc, isReadOnly: editor.w.isReadOnly, isReadOnlyEntity: editor.w.isReadOnlyEntity };
    Object.assign(editor.w, change); api.D.runFocusedCommand('FX'); Object.assign(editor.w, original);
    assert.equal(fixes, 1);
  }
});

test('Preferences displays effective shortcuts and preserves unchanged original override storage', () => {
  const original = { AC: ['Meta+S'], SC: [], RP: ['Alt+Cmd+R'] };
  const api = load(true, original); const ui = api.preferencesUI();
  assert.deepEqual(plain(ui.get('FX')), [], 'claimed defaults are not false UI duplicates');
  assert.deepEqual(plain(ui.get('AC')), ['Cmd+S']);
  assert.deepEqual(plain(ui.save()), original, 'unchanged Apply does not materialize suppressed default unbindings');
  ui.set('QCP', ['Cmd+Shift+G']);
  assert.deepEqual(plain(ui.save()), { ...original, QCP: ['Cmd+Shift+G'] });
});

test('Preferences duplicate detection recognizes aliases and modifier ordering', () => {
  const api = load(); const ui = api.preferencesUI();
  ui.set('AC', ['Shift+Meta+P']); ui.dup();
  assert.equal(api.D.prf_tabs.shc.validate()?.msg, 'Duplicate shortcuts');
  ui.set('AC', ['Alt+Cmd+F']); ui.dup();
  assert.equal(api.D.prf_tabs.shc.validate()?.msg, 'Duplicate shortcuts');
});

test('Fix keybinding uses real Monaco context keys and survives rebind/reset without stale actions', () => {
  const api = load(); let fixes = 0; const pane = api.pane(4, { FX() { fixes += 1; } });
  api.D.prf.keys(api.D.mapKeys.bind(null, pane.w));
  api.remap({});
  const save = 2048 | api.monaco.KeyCode.KeyS;
  pane.press(save); assert.equal(fixes, 1, 'default CmdS runs Fix in a writable editor');
  pane.w.isReadOnly = true; pane.press(save); assert.equal(fixes, 1);
  pane.w.isReadOnly = false;
  api.remap({ FX: ['Cmd+R'] });
  pane.press(save); assert.equal(fixes, 1, 'old action binding is disposed');
  pane.press(2048 | api.monaco.KeyCode.KeyR); assert.equal(fixes, 2);
  api.remap({}); pane.press(save); assert.equal(fixes, 3, 'reset restores the default');
  pane.dispose(); api.remap({ FX: ['Cmd+R'] });
  assert.equal(api.bindings.filter(b => b.active).length, 0, 'closed editors cannot recreate bindings on preference changes');
});

test('Electron helper focus rejects stale editor focus while diagnostic Find keeps its existing route', () => {
  const api = load(); api.pane(0);
  let current = 1; let focused = 2; let url = 'file:///preferences.html'; const scripts = [];
  api.D.el = { getCurrentWindow: () => ({ id: current }), BrowserWindow: { getFocusedWindow: () => ({
    id: focused, webContents: { getURL: () => url, executeJavaScript: code => scripts.push(code) },
  }) } };
  api.D.runFocusedCommand('SI'); assert.equal(api.sent.length, 0);
  url = 'file:///about.html'; api.D.runFocusedCommand('SC');
  assert.deepEqual(scripts, ['window.diagnosticText.find()']);
  focused = current; url = 'file:///index.html'; api.D.runFocusedCommand('SI');
  assert.deepEqual(plain(api.sent), [['StrongInterrupt', {}]]);
});

test('Electron native shortcuts forward to the focused floating editor and ignore helper windows', () => {
  const api = load(); let mainFixes = 0; api.pane(4, { FX() { mainFixes += 1; } });
  const scripts = []; let url = 'file:///app/index.html?type=editor&winId=50';
  api.D.el = { getCurrentWindow: () => ({ id: 1 }), BrowserWindow: { getFocusedWindow: () => ({
    id: 50, webContents: { getURL: () => url, executeJavaScript: code => scripts.push(code) },
  }) } };
  api.D.runFocusedCommand('FX');
  assert.deepEqual(scripts, ['D.runFocusedCommand("FX")']);
  assert.equal(mainFixes, 0, 'the menu installer cannot receive the floating Fix');
  url = 'file:///app/index.html?type=prf'; api.D.runFocusedCommand('FX');
  assert.equal(scripts.length, 1, 'preferences receive no editor command');
  url = 'file:///app/about.html'; api.D.runFocusedCommand('SI');
  assert.equal(api.sent.length, 0, 'About cannot interrupt the owning session');
});

test('Preferences Reset removes aliased overrides and Apply refreshes defaults freed by a custom mapping', () => {
  const reset = load(true, { FX: ['Meta+S'] }); const ui = reset.preferencesUI();
  ui.reset('FX'); assert.deepEqual(plain(ui.save()), {}, 'Reset removes the original saved override');
  const collision = load(true, { AC: ['Cmd+S'] }); const other = collision.preferencesUI();
  other.set('AC', []); assert.deepEqual(plain(other.save()), {});
  assert.deepEqual(plain(other.get('FX')), ['Cmd+S'], 'Apply displays the newly available default');
});

test('busy Session typeahead excludes the effective Strong Interrupt binding without dropping text or PF keys', () => {
  const api = load(); const pane = api.pane(0, { isReadOnly: true }); api.D.ide.promptType = 0;
  api.remap({});
  const se = { taBuffer: [] }; let capture;
  const text = source('src/se.js');
  const start = text.indexOf('      se.taCb = se.taCb || me.onKeyDown');
  const end = text.indexOf('    } else {', start);
  vm.runInNewContext(text.slice(start, end), {
    se, D: api.D, monaco: api.monaco, window: api.context.window,
    me: { onKeyDown(callback) { capture = callback; return { dispose() {} }; } },
  });
  const key = (code, value, modifiers = {}) => ({ keyCode: api.monaco.KeyCode[code],
    browserEvent: { key: value, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...modifiers } });
  const interrupt = key('KeyC', 'c', { ctrlKey: true });
  api.D.runFocusedCommand('SI'); capture(interrupt);
  assert.equal(se.taBuffer.length, 0, 'the executed interrupt cannot be replayed when the prompt returns');
  assert.equal(api.sent.length, 1);
  api.remap({ SI: ['Ctrl+Option+I'] });
  capture(key('KeyI', 'i', { ctrlKey: true, altKey: true }));
  assert.equal(se.taBuffer.length, 0, 'custom interrupt chords use the same effective map');
  capture(interrupt);
  capture(key('KeyA', 'a'));
  capture(key('F8', 'F8'));
  assert.deepEqual(plain(se.taBuffer), [interrupt.browserEvent, 'a', key('F8', 'F8').browserEvent],
    'an unbound old chord, printable input, and PF key retain normal typeahead behavior');
  pane.focus(false);
});
