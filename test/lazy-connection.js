const test = require('ava');
const { TauriApplication } = require('./_tauri');

const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;

nativeTest('connection screen opens Preferences on first use without startup helper webviews', async t => {
  const app = new TauriApplication({ src: 'cn' });
  t.teardown(() => app.stop());
  await app.start();
  const c = app.client;
  t.true(await c.execute(() => {
    const node = document.getElementById('cn');
    return !!node && !node.hidden && !!node.getClientRects().length;
  }));
  t.false(await c.execute(() => !!document.getElementById('splash')));
  t.deepEqual(await c.execute(async () => (await window.__TAURI__.webviewWindow.getAllWebviewWindows())
    .map(win => win.label)), ['main']);
  await c.execute(() => D.commands.PRF());
  await c.waitUntil(() => c.execute(() => !!(D.prf_bw && D.prf_bw.socket)),
    { timeout: 10000, timeoutMsg: 'Connection Preferences did not connect on first use' });
  const label = await c.execute(() => D.prf_bw.win.label);
  await c.switchToWindow(label);
  await (await c.$('#prf_dlg')).waitForDisplayed();
  await c.execute(() => I.prf_dlg_cancel.click());
});
