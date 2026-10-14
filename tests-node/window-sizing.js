const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/wm.js'), 'utf8');
const drain = () => new Promise(resolve => setImmediate(resolve));

function load({ visible = true, fullscreen = false, maximized = false } = {}) {
  const calls = [];
  const state = { visible, fullscreen, maximized };
  class Size {
    constructor(width, height) { this.width = width; this.height = height; }
  }
  const dimensions = size => size && [size.width, size.height];
  class Window {
    async isVisible() { return state.visible; }
    async isFullscreen() { return state.fullscreen; }
    async isMaximized() { return state.maximized; }
    async setMinSize(size) { calls.push(['min', dimensions(size)]); }
    async setMaxSize(size) { calls.push(['max', dimensions(size)]); }
    async setSize(size) { calls.push(['size', dimensions(size)]); }
    async show() { state.visible = true; calls.push(['show']); }
    async hide() { state.visible = false; calls.push(['hide']); }
    async setFocus() { calls.push(['focus']); }
  }
  const D = {};
  vm.runInNewContext(source, {
    D,
    window: {
      __RIDE__: { platform: 'macos' },
      __TAURI__: {
        webviewWindow: { WebviewWindow: Window },
        dpi: { LogicalSize: Size, LogicalPosition: Size },
        event: { listen() {} },
      },
      __TAURI_INTERNALS__: { metadata: { currentWindow: { label: 'main' } } },
    },
    setTimeout(callback) { callback(); },
  });
  return { win: D.wm.main(), calls, state };
}

for (const mode of ['fullscreen', 'maximized']) {
  test(`content size changes preserve a ${mode} window`, async () => {
    const { win, calls } = load({ [mode]: true });
    win.setContentSize(900, 1000);
    win.setContentSize(400, 1000);
    await drain();
    assert.deepEqual(calls, []);
  });

  test(`a hidden size request does not resize a ${mode} window when shown`, async () => {
    const { win, calls, state } = load({ visible: false });
    win.setContentSize(900, 400);
    await drain();
    assert.deepEqual(calls, []);
    state[mode] = true;
    win.show();
    await drain();
    assert.deepEqual(calls, [['show'], ['focus']]);
    state[mode] = false;
    win.setContentSize(400, 400);
    await drain();
    assert.deepEqual(calls.slice(2), [
      ['min', [400, 400]], ['max', [400, 400]], ['size', [400, 400]],
      ['max', null], ['min', null],
    ]);
  });
}

test('normal content sizes remain queued and restore the configured minimum', async () => {
  const { win, calls } = load();
  win.setMinSize(400, 400);
  win.setContentSize(900, 500);
  win.setContentSize(400, 500);
  await drain();
  assert.deepEqual(calls, [
    ['min', [400, 400]],
    ['min', [900, 500]], ['max', [900, 500]], ['size', [900, 500]],
    ['max', null], ['min', [400, 400]],
    ['min', [400, 500]], ['max', [400, 500]], ['size', [400, 500]],
    ['max', null], ['min', [400, 400]],
  ]);
});

test('hidden content size requests apply the latest size after showing', async () => {
  const { win, calls } = load({ visible: false });
  win.setMinSize(400, 400);
  win.setContentSize(900, 500);
  win.setContentSize(1000, 600);
  await drain();
  assert.deepEqual(calls, [['min', [400, 400]]]);
  win.show();
  await drain();
  assert.deepEqual(calls.slice(1), [
    ['show'], ['focus'],
    ['min', [1000, 600]], ['max', [1000, 600]], ['size', [1000, 600]],
    ['max', null], ['min', [400, 400]],
  ]);
  win.hide();
  await drain();
  assert.deepEqual(calls.slice(-3), [['max', null], ['min', [400, 400]], ['hide']]);
});

test('connection cog uses content minima without legacy frame offsets', async () => {
  const text = fs.readFileSync(path.join(__dirname, '../src/cn.js'), 'utf8');
  const start = text.indexOf('    const toggleConfig =');
  const end = text.indexOf('    toggleConfig(winstate.launchWin.expanded);', start);
  assert.ok(start >= 0 && end > start);
  const { win, calls } = load();
  win.contentBounds = async () => ({ height: 700 });
  const winstate = { launchWin: { width: 400, expandedWidth: 900, expanded: false } };
  const toggle = vm.runInNewContext(`(() => {${text.slice(start, end)}; return toggleConfig;})()`, {
    winstate, q: { rhs: {} }, $: () => ({ is: () => false }),
    D: { wm: { main: () => win, saveLaunchState() {} } },
    I: { cn: { toggleMaximize() {} } }, setTimeout(callback) { callback(); },
  });
  for (const expanded of [false, true, false]) {
    calls.length = 0;
    toggle(expanded);
    await drain();
    assert.deepEqual(calls[0], ['min', [expanded ? 885 : 400, 400]]);
    assert.deepEqual(calls.at(-1), ['min', [expanded ? 885 : 400, 400]]);
  }
});

test('launch/session geometry reports use the native window adapter with the exact saved state', async () => {
  const calls = [];
  const D = {};
  vm.runInNewContext(source, {
    D,
    window: { __RIDE__: { platform: 'macos' }, __TAURI__: {
      webviewWindow: { WebviewWindow: class {} }, dpi: { LogicalSize: class {}, LogicalPosition: class {} },
      event: { listen() {} },
    }, __TAURI_INTERNALS__: { metadata: { currentWindow: { label: 'main' } },
      invoke(command, args) { calls.push([command, args]); return Promise.resolve(); } } },
  });
  await D.wm.saveLaunchState(false);
  await D.wm.saveLaunchState(true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['save_win', { onLaunch: false }], ['save_win', { onLaunch: true }],
  ]);
});
