const { Key } = require('webdriverio');
const test = require('ava');
const { tfw, keys } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

async function devToolsOpen(c) {
  return c.execute(async () => {
    const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
    const state = await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label });
    return state.devtoolsOpen;
  });
}

test('physical F12 opens Preferences DevTools without opening Session DevTools', async t => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  await c.execute(() => D.commands.PRF());
  await c.waitUntil(async () => c.execute(() => !!(D.prf_bw && D.prf_bw.socket)), { timeout: 10000 });
  const preferences = await c.execute(() => D.prf_bw.win.label);
  await c.switchToWindow(preferences);
  await (await c.$('#prf_dlg')).waitForDisplayed();
  t.false(await devToolsOpen(c));
  await c.execute(async () => {
    await window.__TAURI__.window.getCurrentWindow().setFocus();
    document.querySelector('#prf_dlg_cancel').focus();
  });
  await keys(c, Key.F12);
  await c.waitUntil(() => devToolsOpen(c), { timeout: 10000, timeoutMsg: 'Preferences F12 did not open native DevTools' });
  await c.switchToWindow(main);
  t.false(await devToolsOpen(c), 'F12 targets Preferences rather than its parent Session');
  await c.switchToWindow(preferences);
  await c.execute(() => D.wm.current().toggleDevTools());
  await c.waitUntil(async () => !(await devToolsOpen(c)), { timeout: 10000 });
  await c.execute(async () => {
    await window.__TAURI__.window.getCurrentWindow().setFocus();
    document.querySelector('#prf_dlg_cancel').focus();
  });
  await c.waitUntil(() => c.execute(() => document.hasFocus()),
    { timeout: 10000, timeoutMsg: 'Closing Preferences DevTools did not restore webview keyboard focus' });
  await keys(c, Key.Escape);
  await c.waitUntil(async () => c.execute(async () => !(await window.__TAURI__.window.getCurrentWindow().isVisible())),
    { timeout: 10000, timeoutMsg: 'Escape could not close Preferences after F12' });
});
