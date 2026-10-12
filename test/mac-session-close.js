const test = require('ava');
const { Key } = require('webdriverio');
const { tfw, keys } = require('./_utils');

const nativeTest = process.platform === 'darwin' ? test : test.skip;
tfw.init({ src: 'se', interpreter: true });
const wait = (c, predicate, ...args) => c.waitUntil(() => c.execute(predicate, ...args),
  { timeout: 10000 });

async function ready(c) {
  await wait(c, () => D.ide.promptReceived && D.ide.promptType === 1
    && !D.ide.inputOperation && D.ide.quiescent());
}

async function focus(c, id = 0) {
  await wait(c, async (token) => {
    const current = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
    await current.setFocus();
    D.ide.wins[token].focus();
    return (await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label: current.label })).focused
      && D.ide.wins[token].me.hasTextFocus();
  }, id);
}

async function sibling(c) {
  const id = await c.execute(() => D.wm.newSession({ RIDE_SPAWN: D.lastSpawnedExe }));
  const label = `w${id}`;
  await c.switchToWindow(label);
  await ready(c);
  return label;
}

async function closeFrom(c, observer, target, chord) {
  await c.switchToWindow(observer);
  await c.execute((targetLabel, chordKeys) => window.__TAURI_INTERNALS__.invoke('ui_test_keys',
    { keys: chordKeys, targetLabel }), target, chord);
  await c.waitUntil(async () => !(await c.getWindowHandles()).includes(target),
    { timeout: 10000, timeoutMsg: 'Cmd-W did not close the focused Session window' });
}

async function checkSurvivor(t, c) {
  await focus(c);
  await c.execute(() => D.ide.exec(["⎕←'#session127=',⍕2+2"], 0));
  await ready(c);
  await wait(c, () => D.ide.wins[0].me.getValue().includes('#session127=4'));
  t.true(await c.execute(() => !!D.ide.connected), 'the other Session remains usable');
}

nativeTest('Mac Session Close respects text focus and live shortcut removal and rebinding, closing only its Session', async (t) => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  const other = await sibling(c);
  await c.execute(() => D.installMenu(D.parseMenuDSL(D.prf.menu())));
  await c.switchToWindow(first);
  await focus(c);
  await keys(c, Key.Command, 'f');
  await (await c.$('.find-widget.visible textarea[aria-label="Find"]')).waitForDisplayed();
  await keys(c, Key.Command, 'w');
  t.true((await c.getWindowHandles()).includes(first), 'Find input cannot close the Session');
  await keys(c, Key.Escape);
  await c.execute(() => D.prf.keys({ CLS: [] }));
  await focus(c);
  await keys(c, Key.Command, 'w');
  t.true((await c.getWindowHandles()).includes(first), 'removing Close disables Cmd-W');
  await c.execute(() => D.prf.keys({ CLS: ['Cmd+Shift+Y'] }));
  await keys(c, Key.Command, 'w');
  t.true((await c.getWindowHandles()).includes(first), 'rebinding removes the old Cmd-W');
  await closeFrom(c, other, first, [Key.Command, Key.Shift, 'y']);
  await checkSurvivor(t, c);
  const fresh = await sibling(c);
  await c.execute(() => D.prf.keys({}));
  await focus(c);
  await closeFrom(c, other, fresh, [Key.Command, 'w']);
  await checkSurvivor(t, c);
});

nativeTest('Mac Cmd-W preserves editor and tracer Close and closes a disconnected Session', async (t) => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  const other = await sibling(c);
  await c.switchToWindow(first);
  await c.execute(() => {
    D.prf.floating(0); D.prf.indentOnOpen(0); D.prf.ilf(0);
    D.ide.exec(["⎕FX 'r←close127' 'r←1' ⋄ ⎕←'#defined127'"], 0);
  });
  await wait(c, () => D.ide.wins[0].me.getValue().includes('#defined127'));
  await ready(c);
  await c.execute(() => D.ide.exec([')ed close127'], 0));
  await wait(c, () => Object.values(D.ide.wins).some(w => w.name === 'close127' && !w.firstOpen));
  const editor = await c.execute(() => Object.values(D.ide.wins).find(w => w.name === 'close127').id);
  await focus(c, editor);
  await keys(c, Key.Command, 'w');
  await wait(c, token => !D.ide.wins[token], editor);
  t.true((await c.getWindowHandles()).includes(first), 'closing an editor leaves its Session open');
  await ready(c); await focus(c);
  await keys(c, '10+2×3', Key.Control, Key.Alt, Key.Enter);
  await wait(c, () => Object.values(D.ide.wins).some(w => w.tc && !w.firstOpen));
  const tracer = await c.execute(() => Object.values(D.ide.wins).find(w => w.tc).id);
  await focus(c, tracer);
  await keys(c, Key.Command, 'w');
  await wait(c, token => !D.ide.wins[token], tracer);
  t.true((await c.getWindowHandles()).includes(first), 'closing a tracer leaves its Session open');
  await c.execute(() => D.ide.die());
  await focus(c);
  await closeFrom(c, other, first, [Key.Command, 'w']);
  await checkSurvivor(t, c);
});
