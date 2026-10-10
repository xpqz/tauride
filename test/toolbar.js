const test = require('ava');
const { tfw } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

async function openWindow(c, id, tracer, floating = false) {
  const previous = floating ? await c.getWindowHandles() : [];
  await c.execute((token, debuggerWindow) => {
    D.ide.handlers.OpenWindow({ token, debugger: debuggerWindow, name: `toolbar${token}`,
      text: [`r←toolbar${token}`, 'r←1'], entityType: 1, currentRow: 0,
      stop: [], trace: [], monitor: [] });
  }, id, tracer);
  let handle;
  if (floating) {
    await c.waitUntil(async () => (await c.getWindowHandles()).some(h => !previous.includes(h)),
      { timeout: 10000, timeoutMsg: 'Floating toolbar test window did not open' });
    handle = (await c.getWindowHandles()).find(h => !previous.includes(h));
    await c.switchToWindow(handle);
  }
  await c.waitUntil(async () => c.execute((token) => {
    const ed = D.ide.wins[token];
    if (!ed || !ed.me) return false;
    // Explicit layout also lets this test run while the macOS screen is locked.
    ed.me.layout({ width: 700, height: 300 });
    return ed.me.getModel().getLineCount() === 2;
  }, id), { timeout: 10000, timeoutMsg: 'Toolbar test editor did not initialize' });
  return handle;
}

async function state(c) {
  return c.execute(() => ({
    visible: Object.values(D.ide.wins).filter(w => w.id)
      .map(w => ({ id: w.id, tracer: !!w.tc, visible: !w.$e.hasClass('no-toolbar') })),
    checked: window.toolbarMenuChecked,
    installs: window.toolbarMenuInstalls,
  }));
}

test('toolbar-menu-command-and-preferences-update-existing-and-new-editors-and-tracers', async (t) => {
  const c = t.context.app.client;
  await c.execute(() => {
    D.prf.floating(0);
    D.prf.indentOnOpen(0);
    D.prf.showEditorToolbar(1);
    const install = D.installMenu;
    window.toolbarMenuInstalls = 0;
    D.installMenu = function (menu) {
      window.toolbarMenuInstalls += 1;
      const view = menu.find(item => item[''] === '&View');
      const item = view.items.find(entry => entry.cmd === 'TTB');
      window.toolbarMenuChecked = !!item.checkBoxPref();
      return install.apply(this, arguments);
    };
  });
  await openWindow(c, 45001, false);
  await openWindow(c, 45002, true);
  t.true((await state(c)).visible.every(w => w.visible));
  await c.execute(() => {
    const view = D.parseMenuDSL(D.prf.menu()).find(item => item[''] === '&View');
    view.items.find(item => item.cmd === 'TTB').action();
  });
  let current = await state(c);
  t.true(current.visible.every(w => !w.visible));
  t.false(current.checked);
  t.true(current.installs > 0, 'preference change must reinstall the native checked menu');
  await openWindow(c, 45003, false);
  await openWindow(c, 45004, true);
  current = await state(c);
  t.is(current.visible.length, 4);
  t.true(current.visible.every(w => !w.visible));
  const before = current.installs;
  await c.execute(() => D.prf.showEditorToolbar(1));
  current = await state(c);
  t.true(current.visible.every(w => w.visible));
  t.true(current.checked);
  t.true(current.installs > before);
  await c.execute(() => D.commands.TTB());
  current = await state(c);
  t.true(current.visible.every(w => !w.visible));
  t.false(current.checked);
});


test('toolbar-preference-propagates-between-main-and-floating-editors-and-tracers', async (t) => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  await c.execute(() => {
    D.prf.floating(0);
    D.prf.indentOnOpen(0);
    D.prf.showEditorToolbar(1);
  });
  await openWindow(c, 45101, false);
  await c.execute(() => { D.prf.floating(1); D.prf.floatSingle(0); });
  const editor = await openWindow(c, 45102, false, true);
  await c.switchToWindow(main);
  const tracer = await openWindow(c, 45103, true, true);

  async function expectVisible(handle, visible) {
    await c.switchToWindow(handle);
    await c.waitUntil(async () => c.execute((show) =>
      D.prf.showEditorToolbar() === +show
      && Object.values(D.ide.wins).filter(w => w.id && !w.bwId)
        .every(w => !w.$e.hasClass('no-toolbar') === show), visible),
    { timeout: 10000, timeoutMsg: 'Toolbar visibility did not propagate over IPC' });
    const windows = await c.execute(() => Object.values(D.ide.wins)
      .filter(w => w.id && !w.bwId).map(w => ({ tracer: !!w.tc, visible: !w.$e.hasClass('no-toolbar') })));
    t.true(windows.length > 0);
    t.true(windows.every(w => w.visible === visible));
  }

  await c.switchToWindow(main);
  await c.execute(() => D.commands.TTB());
  for (const handle of [main, editor, tracer]) await expectVisible(handle, false);
  await c.switchToWindow(main);
  const newlyOpened = await openWindow(c, 45104, false, true);
  await expectVisible(newlyOpened, false);
  await c.switchToWindow(tracer);
  await c.execute(() => D.prf.showEditorToolbar(1));
  for (const handle of [main, editor, tracer, newlyOpened]) await expectVisible(handle, true);
  await c.switchToWindow(editor);
  await c.execute(() => D.commands.TTB());
  for (const handle of [main, editor, tracer, newlyOpened]) await expectVisible(handle, false);
});
