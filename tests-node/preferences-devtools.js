const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function preferences(desktop) {
  const calls = [];
  const title = { innerText: 'Preferences' };
  const dialog = { id: 'prf_dlg', hidden: true, className: 'dlg', querySelector: () => title };
  const I = { prf_dlg: dialog, prf_dlg_ok: {}, prf_dlg_apply: {}, prf_dlg_cancel: {},
    prf_nav: { getElementsByTagName: () => [] } };
  const $ = () => ({ attr() {}, mousedown() {} });
  const context = vm.createContext({ I, $, document: {},
    window: desktop ? { __RIDE__: { platform: 'macos' }, __TAURI__: {
      webviewWindow: { WebviewWindow: class {} }, dpi: { LogicalSize: class {}, LogicalPosition: class {} },
      event: { listen() {} },
    }, __TAURI_INTERNALS__: { metadata: { currentWindow: { label: 'w42' } },
      invoke(command, args) { calls.push([command, args]); return Promise.resolve(); } } } : {},
    D: { ...(desktop ? { el: {} } : {}), util: { fmtKey: event => event.key,
      dlg(element) { element.hidden = false; } } },
  });
  for (const name of ['wm', 'prf_ui']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../src/${name}.js`), 'utf8'), context);
  context.D.prf_ui();
  return { context, dialog, calls };
}

test('Preferences F12 toggles DevTools for the current helper through the Tauri window adapter', async () => {
  const { dialog, calls } = preferences(true);
  assert.equal(dialog.onkeydown({ key: 'F12' }), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['win_op', { label: 'w42', op: 'toggleDevTools' }]]);
  assert.equal(Boolean(dialog.hidden), false);
});

test('browser Preferences leave F12 available to the browser without desktop calls', () => {
  const { context, dialog, calls } = preferences(false);
  assert.equal(context.D.wm, undefined);
  assert.equal(dialog.onkeydown({ key: 'F12' }), true);
  assert.deepEqual(calls, []);
  assert.equal(Boolean(dialog.hidden), false);
});
