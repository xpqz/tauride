const test = require('ava');
const { tfw } = require('./_utils');

const nativeTest = process.platform === 'darwin' ? test : test.skip;
tfw.init({ src: 'se', interpreter: true });

const preferences = {
  AGC: 'agentControl',
  AGO: 'agent',
  TTB: 'showEditorToolbar',
};

async function readySession(c) {
  await c.waitUntil(async () => c.execute(() => !!(D.ide && D.ide.wins[0]
    && D.ide.wins[0].promptType === 1 && D.ide.wins[0].me.getModel())),
  { timeout: 30000, timeoutMsg: 'Session did not become ready' });
}

async function focusNativeWindow(c) {
  const label = await c.execute(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label);
  await c.waitUntil(async () => c.execute(async (name) => {
    const target = new window.__TAURI__.webviewWindow.WebviewWindow(name, { skip: true });
    await target.setFocus();
    const state = await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label: name });
    return state.focused;
  }, label), { timeout: 10000, timeoutMsg: `${label} did not receive native focus` });
}

async function setPreferences(c, values) {
  await c.execute((state) => {
    for (const [command, value] of Object.entries(state)) D.prf[{
      AGC: 'agentControl', AGO: 'agent', TTB: 'showEditorToolbar',
    }[command]](+value);
  }, values);
}

async function preferenceState(c) {
  return c.execute(() => ({
    AGC: !!D.prf.agentControl(),
    AGO: !!D.prf.agent(),
    TTB: !!D.prf.showEditorToolbar(),
  }));
}

async function installedItem(c, command, owner, checked) {
  let id;
  await c.waitUntil(async () => {
    try {
      id = await c.execute((name, expected) => window.__TAURI_INTERNALS__.invoke(
        'ui_test_menu_command', { command: name, dispatch: false, expectedChecked: expected }),
      command, checked);
      return id.startsWith(`app:${owner}:`);
    } catch (_) { return false; }
  }, { timeout: 10000, timeoutMsg: `${owner} did not install ${command} with checked=${checked}` });
  return id;
}

async function clickInstalledItem(c, command, owner, checked) {
  const id = await c.execute((name, expected) => window.__TAURI_INTERNALS__.invoke(
    'ui_test_menu_command', { command: name, expectedChecked: expected }), command, checked);
  if (!id.startsWith(`app:${owner}:`)) throw new Error(`${command} came from ${id}, expected ${owner}`);
}

async function openSecondSession(c) {
  const id = await c.execute(() => D.wm.newSession({ RIDE_SPAWN: D.lastSpawnedExe }));
  if (!id) throw new Error('Second session did not open');
  const label = `w${id}`;
  await c.switchToWindow(label);
  await readySession(c);
  return label;
}

async function listenForMenuBarrier(c) {
  await c.execute(async () => {
    window.nativeMenuBarrier = null;
    await window.__TAURI__.event.listen('ui-test-menu-barrier', ({ payload }) => {
      window.nativeMenuBarrier = payload;
    });
  });
}

async function dispatchFromHelper(c, helper, installer, marker) {
  await c.switchToWindow(installer);
  await c.execute(() => D.installMenu(D.parseMenuDSL(D.prf.menu())));
  await installedItem(c, 'AGC', installer, true);
  await c.switchToWindow(helper);
  await focusNativeWindow(c);
  for (const command of Object.keys(preferences)) {
    await clickInstalledItem(c, command, installer, true);
  }
  await c.execute(async (value) => window.__TAURI__.event.emit('ui-test-menu-barrier', value), marker);
}

async function reachedMenuBarrier(c, marker) {
  await c.waitUntil(async () => c.execute(value => window.nativeMenuBarrier === value, marker),
    { timeout: 10000, timeoutMsg: `Menu event barrier ${marker} did not arrive` });
}

nativeTest('native checkbox menu commands change the focused first session, not the last installer', async (t) => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  await setPreferences(c, { AGC: false, AGO: false, TTB: false });
  const second = await openSecondSession(c);
  await setPreferences(c, { AGC: true, AGO: true, TTB: true });

  for (const command of Object.keys(preferences)) {
    await c.execute(() => D.installMenu(D.parseMenuDSL(D.prf.menu())));
    await installedItem(c, command, second, true);
    await c.switchToWindow(first);
    await focusNativeWindow(c);
    await clickInstalledItem(c, command, second, true);
    await c.waitUntil(async () => (await preferenceState(c))[command],
      { timeout: 10000, timeoutMsg: `${command} did not turn on in the focused first session` });
    await installedItem(c, command, 'main', true);
    await c.switchToWindow(second);
    t.true((await preferenceState(c))[command], `${command} stays on in the last installer`);
  }
});

nativeTest('native checkbox command follows the focused second session when the first installed the menu', async (t) => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  await setPreferences(c, { AGC: true });
  const second = await openSecondSession(c);
  await setPreferences(c, { AGC: false });
  await c.switchToWindow(first);
  await c.execute(() => D.installMenu(D.parseMenuDSL(D.prf.menu())));
  await installedItem(c, 'AGC', 'main', true);
  await c.switchToWindow(second);
  await focusNativeWindow(c);
  await clickInstalledItem(c, 'AGC', 'main', true);
  await c.waitUntil(async () => (await preferenceState(c)).AGC,
    { timeout: 10000, timeoutMsg: 'Allow Control did not turn on in the focused second session' });
  await installedItem(c, 'AGC', second, true);
  await c.switchToWindow(first);
  t.true((await preferenceState(c)).AGC, 'first session remains enabled');
});

nativeTest('native checkbox command from a floating tracer changes its owning session', async (t) => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  await setPreferences(c, { AGC: false, AGO: false, TTB: false });
  await c.execute(() => {
    D.prf.floating(1);
    D.prf.floatSingle(0);
    D.prf.indentOnOpen(0);
    D.ide.handlers.OpenWindow({ token: 87001, debugger: true, name: 'nativeMenuTracer',
      text: ['r←nativeMenuTracer', 'r←87'], entityType: 1, currentRow: 0,
      stop: [], trace: [], monitor: [] });
  });
  let tracer;
  await c.waitUntil(async () => {
    for (const handle of await c.getWindowHandles()) {
      if (handle === first) continue;
      await c.switchToWindow(handle);
      if (await c.execute(() => !!(D.ide && D.ide.wins[87001] && D.ide.wins[87001].me
        && D.ide.wins[87001].me.getModel()
        && D.ide.wins[87001].me.getModel().getLineCount() === 2
        && D.ide.wins[87001].container && !D.ide.wins[87001].firstOpen))) {
        tracer = handle;
        return true;
      }
    }
    return false;
  }, { timeout: 10000, timeoutMsg: 'Floating tracer did not open' });
  t.false(await c.execute(() => !D.ide.wins[87001].$e.hasClass('no-toolbar')),
    'tracer starts with its toolbar hidden');
  await c.switchToWindow(first);
  const second = await openSecondSession(c);
  await setPreferences(c, { AGC: true, AGO: true, TTB: true });
  for (const command of Object.keys(preferences)) {
    await c.execute(() => D.installMenu(D.parseMenuDSL(D.prf.menu())));
    await installedItem(c, command, second, true);
    await c.switchToWindow(tracer);
    await focusNativeWindow(c);
    await c.execute(() => D.ide.wins[87001].focus());
    await c.waitUntil(async () => c.execute(async () => {
      const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
      const state = await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label });
      return state.focused && D.ide.wins[87001].me.hasTextFocus();
    }), { timeout: 10000, timeoutMsg: 'Floating tracer did not receive native text focus' });
    await clickInstalledItem(c, command, second, true);
    t.true(await c.execute(async () => {
      const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
      const state = await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label });
      return state.focused && D.ide.wins[87001].me.hasTextFocus();
    }), `${command} keeps native tracer text focus`);
    await c.switchToWindow(first);
    await c.waitUntil(async () => (await preferenceState(c))[command],
      { timeout: 10000, timeoutMsg: `${command} did not change in the tracer’s owning session` });
    await installedItem(c, command, 'main', true);
    await c.switchToWindow(second);
    t.true((await preferenceState(c))[command], `${command} stays on in the other session`);
  }
  await c.switchToWindow(tracer);
  await c.waitUntil(async () => c.execute(() => !!D.ide.wins[87001]
    && !D.ide.wins[87001].$e.hasClass('no-toolbar')),
  { timeout: 10000, timeoutMsg: 'Show Trace/Edit Toolbar did not show the floating tracer toolbar' });
  t.true(await c.execute(async () => {
    const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
    const state = await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label });
    return state.focused && D.ide.wins[87001].me.hasTextFocus();
  }), 'tracer retains native focus');
});

nativeTest('native checkbox commands do nothing while a helper window has focus', async (t) => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  await setPreferences(c, { AGC: false, AGO: false, TTB: false });
  await listenForMenuBarrier(c);
  const second = await openSecondSession(c);
  await setPreferences(c, { AGC: true, AGO: true, TTB: true });
  await listenForMenuBarrier(c);
  await c.switchToWindow(first);
  await c.waitUntil(async () => c.execute(() => !!(D.prf_bw && D.prf_bw.socket)),
    { timeout: 10000, timeoutMsg: 'Preferences did not connect' });
  await c.execute(() => D.commands.PRF());
  const helper = await c.execute(() => D.prf_bw.win.label);
  await c.switchToWindow(helper);
  await c.waitUntil(async () => c.execute(() => !I.prf_dlg.hidden),
    { timeout: 10000, timeoutMsg: 'Preferences did not open' });
  await dispatchFromHelper(c, helper, second, 'preferences');
  await c.switchToWindow(first);
  await reachedMenuBarrier(c, 'preferences');
  t.deepEqual(await preferenceState(c), { AGC: false, AGO: false, TTB: false });
  await c.switchToWindow(second);
  await reachedMenuBarrier(c, 'preferences');
  t.deepEqual(await preferenceState(c), { AGC: true, AGO: true, TTB: true });
  for (const command of Object.keys(preferences)) await installedItem(c, command, second, true);

  await c.switchToWindow(first);
  const handles = await c.getWindowHandles();
  await c.execute(() => D.commands.ABT());
  await c.waitUntil(async () => (await c.getWindowHandles()).length > handles.length,
    { timeout: 10000, timeoutMsg: 'About did not open' });
  const about = (await c.getWindowHandles()).find(handle => !handles.includes(handle));
  await c.switchToWindow(about);
  await (await c.$('textarea[readonly]')).waitForExist();
  await dispatchFromHelper(c, about, second, 'about');
  await c.switchToWindow(first);
  await reachedMenuBarrier(c, 'about');
  t.deepEqual(await preferenceState(c), { AGC: false, AGO: false, TTB: false });
  await c.switchToWindow(second);
  await reachedMenuBarrier(c, 'about');
  t.deepEqual(await preferenceState(c), { AGC: true, AGO: true, TTB: true });
  for (const command of Object.keys(preferences)) await installedItem(c, command, second, true);
});
