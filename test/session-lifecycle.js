const test = require('ava');
const { Key } = require('webdriverio');
const { TauriApplication } = require('./_tauri');
const processes = require('./_processes');

const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
const macTest = process.platform === 'darwin' ? test : test.skip;
const wait = (c, predicate, ...args) => c.waitUntil(() => c.execute(predicate, ...args), { timeout: 10000 });

async function ready(c) {
  await wait(c, () => D.ide && D.ide.connected && D.ide.promptReceived && D.ide.promptType === 1
    && !D.ide.inputOperation && D.ide.quiescent());
}

async function track(t) {
  const c = t.context.app.client;
  const pid = await c.execute(() => {
    if (!D.spawned) throw new Error('Lifecycle test requires a locally spawned interpreter');
    return Number(D.remoteIdentification.pid);
  });
  const owned = await processes.track(pid);
  t.false(t.context.owned.some(p => p.pid === pid), 'each Session owns a distinct interpreter');
  t.context.owned.push(owned);
  return { label: await c.getWindowHandle(), owned };
}

async function sibling(t) {
  const c = t.context.app.client;
  const id = await c.execute(() => D.wm.newSession({ RIDE_SPAWN: D.lastSpawnedExe }));
  await c.switchToWindow(`w${id}`);
  await ready(c);
  return track(t);
}

async function survivor(t, session, marker) {
  const c = t.context.app.client;
  await c.switchToWindow(session.label);
  t.true(await processes.alive(session.owned), 'surviving Session interpreter is still running');
  await c.execute(tag => D.ide.exec([`⎕←'${tag}=',⍕2+2`], 0), marker);
  await wait(c, tag => D.ide.wins[0].me.getValue().includes(`${tag}=4`), marker);
  await ready(c);
}

async function close(t, observer, target, command = false) {
  const c = t.context.app.client;
  await c.switchToWindow(observer.label);
  if (command) {
    await c.execute(async label => {
      const win = await window.__TAURI__.webviewWindow.WebviewWindow.getByLabel(label);
      await win.setFocus();
    }, target.label);
    await c.execute((label, chord) => window.__TAURI_INTERNALS__.invoke('ui_test_keys',
      { keys: chord, targetLabel: label }), target.label, [Key.Command, 'w']);
  } else {
    // Native close() uses the same CloseRequested path as the title bar close button.
    await c.execute(async label => {
      const win = await window.__TAURI__.webviewWindow.WebviewWindow.getByLabel(label);
      await win.close();
    }, target.label);
  }
  await c.waitUntil(async () => !(await c.getWindowHandles()).includes(target.label),
    { timeout: 10000, timeoutMsg: `Session ${target.label} did not close` });
  await processes.waitForExit(target.owned);
  t.pass(`interpreter ${target.owned.pid} exited before harness teardown`);
}

test.beforeEach(async t => {
  t.context.owned = [];
  if (!['darwin', 'linux'].includes(process.platform)) return;
  t.context.app = new TauriApplication({ src: 'se', interpreter: true });
  await t.context.app.start();
});

test.afterEach.always(async t => {
  try {
    if (t.context.app) await t.context.app.stop();
  } finally {
    await Promise.all(t.context.owned.map(processes.cleanup));
  }
});

nativeTest('repeated native Session closes reap their interpreters and preserve the sibling', async t => {
  const first = await track(t);
  const keeper = await sibling(t);
  await close(t, keeper, first);
  await survivor(t, keeper, '#lifecycle131a');
  for (let i = 0; i < 3; i += 1) {
    const fresh = await sibling(t);
    await close(t, keeper, fresh);
    await survivor(t, keeper, `#lifecycle131b${i}`);
  }
});

macTest('Cmd-W reaps only the focused local Session interpreter', async t => {
  const first = await track(t);
  const keeper = await sibling(t);
  const c = t.context.app.client;
  await c.switchToWindow(first.label);
  await c.execute(() => D.ide.wins[0].focus());
  await close(t, keeper, first, true);
  await survivor(t, keeper, '#lifecycle131cmd');
});

macTest('Mac Cmd-Q reaps multiple local interpreters including a busy Session', async t => {
  await track(t);
  await sibling(t);
  await sibling(t);
  const { app } = t.context;
  const c = app.client;
  await wait(c, async () => {
    const win = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
    await win.setFocus();
    D.ide.wins[0].focus();
    return (await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label: win.label })).focused;
  });
  await c.execute(() => D.ide.exec(["⎕←'#busy131' ⋄ ⎕DL 30"], 0));
  await wait(c, () => D.ide.wins[0].me.getValue().includes('#busy131') && D.ide.promptType === 0);
  try {
    await c.execute(chord => window.__TAURI_INTERNALS__.invoke('ui_test_keys', { keys: chord }), [Key.Command, 'q']);
  } catch (_) { /* App quit can end the RPC; bounded exit checks below must still pass. */ }
  await Promise.all(t.context.owned.map(p => processes.waitForExit(p, 15000)));
  await c.waitUntil(() => !app.isRunning(), { timeout: 15000, timeoutMsg: 'Tauride did not exit after Quit' });
  t.is(app.child.exitCode, 0, 'Cmd-Q exits Tauride successfully');
  t.is(app.child.signalCode, null, 'Cmd-Q does not terminate Tauride by a signal');
  t.pass('app and all recorded interpreters exited before harness teardown');
});

nativeTest('closing a busy local Session reaps its interpreter and preserves the sibling', async t => {
  const first = await track(t);
  const keeper = await sibling(t);
  const c = t.context.app.client;
  await c.switchToWindow(first.label);
  await c.execute(() => D.ide.exec(["⎕←'#busyclose131' ⋄ ⎕DL 30"], 0));
  await wait(c, () => D.ide.wins[0].me.getValue().includes('#busyclose131') && D.ide.promptType === 0);
  await close(t, keeper, first);
  await survivor(t, keeper, '#lifecycle131busy');
});
