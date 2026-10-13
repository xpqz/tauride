const test = require('ava');
const { Key } = require('webdriverio');
const { keys } = require('./_utils');
const { TauriApplication } = require('./_tauri');
const processes = require('./_processes');

const nativeTest = process.platform === 'darwin' ? test : test.skip;
test.beforeEach(async t => {
  t.context.app = new TauriApplication({ src: 'se', interpreter: true });
  await t.context.app.start();
  const pid = await t.context.app.client.execute(() => {
    if (!D.spawned) throw new Error('Native dialog test requires an owned interpreter');
    return Number(D.remoteIdentification.pid);
  });
  t.context.owned = await processes.track(pid);
});
test.afterEach.always(async t => {
  try { if (t.context.app) await t.context.app.stop(); }
  finally { if (t.context.owned) await processes.cleanup(t.context.owned); }
});

async function shown(t, marker, offset) {
  await t.context.app.client.waitUntil(() => t.context.app.output.slice(offset).includes(marker), { timeout: 10000 });
}

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

nativeTest('native file picker leaves JavaScript responsive and cancels without paths', async t => {
  const { app } = t.context; const c = app.client; const offset = app.output.length;
  await c.execute(() => {
    window.nativeServiceAnswer = null;
    D.el.dialog.showOpenDialog(D.wm.main().native, { title: 'Native picker QA', properties: ['openFile'] })
      .then(answer => { window.nativeServiceAnswer = answer; });
  });
  await shown(t, '[ui-test-file]', offset);
  t.is(await c.execute(() => window.nativeServiceAnswer), null);
  await keys(c, Key.Escape);
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
