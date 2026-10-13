const test = require('ava');
const { Key } = require('webdriverio');
const { keys } = require('./_utils');
const { TauriApplication } = require('./_tauri');
const processes = require('./_processes');

const nativeTest = process.platform === 'darwin' ? test : test.skip;
test.beforeEach(async t => {
  t.context.owned = [];
  t.context.app = new TauriApplication({ src: 'se', interpreter: true });
  await t.context.app.start();
  const pid = await t.context.app.client.execute(() => {
    if (!D.spawned) throw new Error('Native dialog test requires an owned interpreter');
    return Number(D.remoteIdentification.pid);
  });
  t.context.owned.push(await processes.track(pid));
});
test.afterEach.always(async t => {
  try { if (t.context.app) await t.context.app.stop(); }
  finally { await Promise.all((t.context.owned || []).map(processes.cleanup)); }
});

async function shown(t, marker, offset, owner) {
  const c = t.context.app.client;
  await c.waitUntil(() => t.context.app.output.slice(offset).includes(marker), { timeout: 10000 });
  await c.waitUntil(() => c.execute(async target => {
    const label = target || window.__TAURI_INTERNALS__.metadata.currentWindow.label;
    return (await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label })).sheetFocused;
  }, owner), { timeout: 10000, timeoutMsg: 'The owning native sheet did not become visible and focused' });
}

nativeTest('plain native OK alert leaves JavaScript responsive until Enter', async t => {
  const { app } = t.context; const c = app.client; const offset = app.output.length;
  await c.execute(() => {
    window.nativeServiceAnswer = null;
    D.el.dialog.showMessageBox(D.wm.main().native, {
      title: 'Native alert QA', message: 'Dismiss this alert', buttons: ['OK'],
    }).then(answer => { window.nativeServiceAnswer = answer; });
  });
  await shown(t, '[ui-test-dialog]', offset);
  t.is(await c.execute(() => window.nativeServiceAnswer), null);
  await keys(c, Key.Enter);
  await c.waitUntil(() => c.execute(() => window.nativeServiceAnswer !== null), { timeout: 10000 });
  t.is(await c.execute(() => window.nativeServiceAnswer.response), 0);
});

nativeTest('simple native confirmation leaves JavaScript responsive until Escape', async t => {
  const { app } = t.context; const c = app.client; const offset = app.output.length;
  await c.execute(() => {
    window.nativeServiceAnswer = null;
    D.el.dialog.showMessageBox(D.wm.main().native, {
      title: 'Native service QA', message: 'Cancel this confirmation', buttons: ['Yes', 'No'], cancelId: 1,
    }).then(answer => { window.nativeServiceAnswer = answer; });
  });
  await shown(t, '[ui-test-dialog]', offset);
  t.is(await c.execute(() => { window.nativeServiceHeartbeat = 136; return window.nativeServiceAnswer; }), null);
  await keys(c, Key.Escape);
  await c.waitUntil(() => c.execute(() => window.nativeServiceAnswer !== null), { timeout: 10000 });
  t.is(await c.execute(() => window.nativeServiceAnswer.response), 1);
});

nativeTest('native file picker stays responsive and native Cancel returns no paths', async t => {
  const { app } = t.context; const c = app.client; const offset = app.output.length;
  await c.execute(() => {
    window.nativeServiceAnswer = null;
    D.el.dialog.showOpenDialog(D.wm.main().native, { title: 'Native picker QA', properties: ['openFile'] })
      .then(answer => { window.nativeServiceAnswer = answer; });
  });
  await shown(t, '[ui-test-file]', offset);
  t.is(await c.execute(() => window.nativeServiceAnswer), null);
  await c.execute(() => window.__TAURI_INTERNALS__.invoke('ui_test_cancel_file_dialog'));
  await c.waitUntil(() => c.execute(() => window.nativeServiceAnswer !== null), { timeout: 10000 });
  t.deepEqual(await c.execute(() => window.nativeServiceAnswer), { canceled: true, filePaths: [] });
});

for (const [key, expected] of [[Key.Enter, 'save'], [Key.Escape, 'cancel']]) {
  nativeTest(`dirty editor native close stays responsive and chooses ${expected}`, async t => {
    const { app } = t.context; const c = app.client;
    await c.waitUntil(() => c.execute(() => D.ide.promptType === 1 && D.ide.quiescent()), { timeout: 10000 });
    await c.execute(() => {
      D.prf.floating(0); D.prf.indentOnOpen(0);
      D.ide.exec(["⎕FX 'r←nativeClose136' 'r←1' ⋄ ⎕←'#native136ready'"], 0);
    });
    await c.waitUntil(() => c.execute(() => D.ide.wins[0].me.getValue().includes('#native136ready')
      && D.ide.promptType === 1 && D.ide.quiescent()), { timeout: 10000 });
    await c.execute(() => D.ide.exec([')ed nativeClose136'], 0));
    let token;
    await c.waitUntil(async () => {
      token = await c.execute(() => Object.values(D.ide.wins).find(ed => ed.name === 'nativeClose136'
        && ed.me?.getModel() && !ed.firstOpen)?.id);
      return !!token;
    }, { timeout: 10000 });
    const offset = app.output.length;
    await c.execute(id => {
      const ed = D.ide.wins[id]; ed.focus(); ed.me.setValue('r←nativeClose136\nr←2');
      ed.onClose(); ed.onClose();
    }, token);
    await shown(t, '[ui-test-dialog]', offset);
    t.is(await c.execute(id => D.ide.wins[id].me.getValue(), token), 'r←nativeClose136\nr←2');
    await keys(c, key);
    await c.waitUntil(() => c.execute(id => !D.ide.wins[id]?.closePromptPending, token), { timeout: 10000 });
    t.is(app.output.slice(offset).split('[ui-test-dialog]').length - 1, 1);
    if (expected === 'cancel') t.is(await c.execute(id => D.ide.wins[id].me.getValue(), token), 'r←nativeClose136\nr←2');
    else await c.waitUntil(() => c.execute(id => !D.ide.wins[id], token), { timeout: 10000 });
    await c.waitUntil(() => c.execute(() => D.ide.promptType === 1 && D.ide.quiescent()), { timeout: 10000 });
    await c.execute(() => D.ide.exec(["⎕←'#native136result=',⍕nativeClose136"], 0));
    await c.waitUntil(() => c.execute(value => D.ide.wins[0].me.getModel().getLinesContent().includes(`#native136result=${value}`),
      expected === 'save' ? 2 : 1), { timeout: 10000 });
  });
}


nativeTest('rich native dialog preserves custom indices, default button and checked checkbox', async t => {
  const { app } = t.context; const c = app.client; const offset = app.output.length;
  await c.execute(() => {
    window.nativeServiceAnswer = null;
    D.el.dialog.showMessageBox(D.wm.main().native, {
      title: 'Rich native QA', message: 'Choose the third action', buttons: ['First', 'Second', 'Third', 'Cancel'],
      defaultId: 2, cancelId: 3, checkboxLabel: 'Remember this choice', checkboxChecked: true,
    }).then(answer => { window.nativeServiceAnswer = answer; });
  });
  await shown(t, '[ui-test-dialog]', offset);
  t.is(await c.execute(() => window.nativeServiceAnswer), null);
  await keys(c, Key.Enter);
  await c.waitUntil(() => c.execute(() => window.nativeServiceAnswer !== null), { timeout: 10000 });
  t.deepEqual(await c.execute(() => window.nativeServiceAnswer), { response: 2, checkboxChecked: true });
});

nativeTest('Session consent cancels safely then closes only its owning interpreter', async t => {
  const { app } = t.context; const c = app.client;
  const owner = await c.getWindowHandle(); const ownerProcess = t.context.owned[0];
  const siblingId = await c.execute(() => D.wm.newSession({ RIDE_SPAWN: D.lastSpawnedExe }));
  const observer = `w${siblingId}`;
  await c.switchToWindow(observer);
  await c.waitUntil(() => c.execute(() => D.ide?.connected && D.ide.promptReceived && D.ide.promptType === 1
    && !D.ide.inputOperation && D.ide.quiescent()), { timeout: 10000 });
  const observerProcess = await processes.track(await c.execute(() => Number(D.remoteIdentification.pid)));
  t.context.owned.push(observerProcess);
  t.not(ownerProcess.pid, observerProcess.pid);
  await c.switchToWindow(owner);
  await c.execute(() => { D.prf.sqp(1); process.env.NODE_ENV = 'native-consent-qa'; });
  const closeOwner = () => c.execute(async label => {
    const target = await window.__TAURI__.webviewWindow.WebviewWindow.getByLabel(label);
    await target.close();
  }, owner);
  const answerOwner = key => c.execute((label, chord) => window.__TAURI_INTERNALS__.invoke('ui_test_keys',
    { keys: chord, targetLabel: label }), owner, [key]);

  let offset = app.output.length;
  await c.switchToWindow(observer); await closeOwner();
  await shown(t, '[ui-test-dialog]', offset, owner);
  await c.switchToWindow(owner);
  t.true(await c.execute(() => !!D.ide.closePromptPending), 'owner JavaScript remains responsive during consent');
  await c.switchToWindow(observer); await closeOwner();
  t.true((await c.getWindowHandles()).includes(owner), 'repeated native close cannot bypass pending consent');
  t.true(await processes.alive(ownerProcess));
  await c.switchToWindow(owner);
  t.true(await c.execute(() => !!D.ide.closePromptPending));
  t.is(app.output.slice(offset).split('[ui-test-dialog]').length - 1, 1, 'pending close requests share one confirmation');
  await c.switchToWindow(observer); await answerOwner(Key.Escape);
  await c.switchToWindow(owner);
  await c.waitUntil(() => c.execute(() => !D.ide.closePromptPending), { timeout: 10000 });
  t.true(await processes.alive(ownerProcess)); t.true(await processes.alive(observerProcess));
  t.true((await c.getWindowHandles()).includes(owner));

  offset = app.output.length;
  await c.switchToWindow(observer); await closeOwner();
  await shown(t, '[ui-test-dialog]', offset, owner);
  await answerOwner(Key.Enter);
  await c.waitUntil(async () => !(await c.getWindowHandles()).includes(owner), { timeout: 10000 });
  await processes.waitForExit(ownerProcess);
  t.true(await processes.alive(observerProcess), 'the sibling interpreter survives accepted owner close');
  await c.execute(() => D.ide.exec(["⎕←'#consent136=',⍕2+2"], 0));
  await c.waitUntil(() => c.execute(() => D.ide.wins[0].me.getModel().getLinesContent().includes('#consent136=4')),
    { timeout: 10000 });
});
