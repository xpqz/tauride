const test = require('ava');
const { tfw } = require('./_utils');

const nativeTest = process.platform === 'darwin' ? test : test.skip;
tfw.init({ src: 'se', interpreter: true });

async function focus(c) {
  await c.waitUntil(() => c.execute(async () => {
    const win = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
    await win.setFocus();
    return (await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label: win.label })).focused;
  }), { timeout: 10000, timeoutMsg: 'Session did not receive native focus' });
}

async function item(c, command, checked, dispatch = false) {
  await c.waitUntil(async () => {
    const result = await c.execute(async (code, state) => {
      try {
        return { id: await window.__TAURI_INTERNALS__.invoke('ui_test_menu_command',
          { command: code, expectedEnabled: true, expectedChecked: state, dispatch: false }) };
      } catch (error) { return { failure: String(error) }; }
    }, command, checked);
    if (result.failure) {
      if (!/No application menu|checked state|enabled state/.test(result.failure)) throw new Error(result.failure);
      return false;
    }
    return result.id.startsWith('app:main:');
  }, { timeout: 10000, timeoutMsg: `${command} did not reach checked=${checked}` });
  if (dispatch) {
    const id = await c.execute((code, state) => window.__TAURI_INTERNALS__.invoke(
      'ui_test_menu_command', { command: code, expectedEnabled: true, expectedChecked: state }), command, checked);
    if (!id.startsWith('app:main:')) throw new Error(`${command} came from ${id}`);
  }
}

nativeTest('installed View commands update visible bars and Session wrapping', async (t) => {
  const c = t.context.app.client;
  await c.execute(() => {
    D.prf.lbar(0); D.prf.sbar(0); D.prf.wrap(0);
    D.ide.wins[0].focus();
    D.installMenu(D.parseMenuDSL(D.prf.menu()));
  });
  await focus(c);
  for (const command of ['LBR', 'SBR', 'WRP']) {
    await item(c, command, false);
    await item(c, command, false, true);
    await item(c, command, true);
  }
  await c.waitUntil(() => c.execute(() => !I.lb.hidden && !I.sb.hidden
    && D.ide.wins[0].me.getRawOptions().wordWrap === 'on'), { timeout: 10000 });
  t.true(await c.execute(() => D.ide.wins[0].me.hasTextFocus()));
  for (const command of ['LBR', 'SBR', 'WRP']) {
    await item(c, command, true, true);
    await item(c, command, false);
  }
  t.deepEqual(await c.execute(() => [I.lb.hidden, I.sb.hidden,
    D.ide.wins[0].me.getRawOptions().wordWrap]), [true, true, 'off']);
});

nativeTest('installed Preferences command opens a helper that Cancel closes', async (t) => {
  const c = t.context.app.client;
  const session = await c.getWindowHandle();
  await focus(c);
  let installed;
  try {
    await c.waitUntil(async () => {
      const result = await c.execute(async () => {
        try {
          return { id: await window.__TAURI_INTERNALS__.invoke('ui_test_menu_command',
            { command: 'PRF', expectedEnabled: true, dispatch: false }) };
        } catch (error) { return { failure: String(error) }; }
      });
      installed = result.failure || result.id;
      if (result.failure) {
        if (!/No application menu(?: item)?/.test(result.failure)) throw new Error(result.failure);
        return false;
      }
      return result.id.startsWith('app:main:');
    }, { timeout: 10000, timeoutMsg: 'Preferences was not installed in the Session menu' });
  } catch (error) {
    throw new Error(`${error.message}; last lookup: ${installed}`);
  }
  await c.execute(() => window.__TAURI_INTERNALS__.invoke('ui_test_menu_command',
    { command: 'PRF', expectedEnabled: true }));
  await c.waitUntil(() => c.execute(() => !!(D.prf_bw && D.prf_bw.socket)), { timeout: 10000 });
  const helper = await c.execute(() => D.prf_bw.win.label);
  await c.switchToWindow(helper);
  await c.waitUntil(() => c.execute(() => !I.prf_dlg.hidden), { timeout: 10000 });
  t.true(await c.execute(() => !!I.prf_dlg.querySelector('input, textarea, select')));
  await c.execute(() => I.prf_dlg_cancel.click());
  await c.switchToWindow(session);
  await c.waitUntil(() => c.execute(async (label) => {
    const win = await window.__TAURI__.webviewWindow.WebviewWindow.getByLabel(label);
    return !!win && !(await win.isVisible());
  }, helper), { timeout: 10000, timeoutMsg: 'Cancel did not hide Preferences' });
  t.true(await c.execute(() => !!D.ide.wins[0].me.getModel()));
});
