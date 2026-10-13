const test = require('ava');
const { tfw } = require('./_utils');

const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
tfw.init({ src: 'se', interpreter: true });

async function labels(c) {
  return c.execute(async () => (await window.__TAURI__.webviewWindow.getAllWebviewWindows())
    .map(win => win.label).sort());
}

async function helper(c, name) {
  await c.waitUntil(() => c.execute(kind => {
    const entry = D[kind];
    return !!(entry && entry.win && entry.socket);
  }, name), { timeout: 10000, timeoutMsg: `${name} did not connect on first use` });
  return c.execute(kind => D[kind].win.label, name);
}

async function visible(c, label) {
  return c.execute(async name => {
    const win = await window.__TAURI__.webviewWindow.WebviewWindow.getByLabel(name);
    return !!win && win.isVisible();
  }, label);
}

async function ready(c, message = 'Interpreter did not become ready') {
  await c.waitUntil(() => c.execute(() => !!(D.ide && D.ide.connected && D.ide.promptReceived
    && D.ide.promptType === 1 && !D.ide.inputOperation && D.ide.quiescent()
    && D.ide.wins[0] && D.ide.wins[0].me.getModel())),
  { timeout: 30000, timeoutMsg: message });
}

nativeTest('automatic session starts without a splash or unused helper webviews', async t => {
  const c = t.context.app.client;
  t.deepEqual(await labels(c), ['main']);
  t.true(await c.execute(() => D.ide.connected && D.ide.promptType === 1
    && !!D.ide.wins[0].me.getModel()));
  t.false(await c.execute(() => !!document.getElementById('splash')));
});

nativeTest('Preferences opens once on demand, survives rapid requests and reuses its webview', async t => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  t.deepEqual(await labels(c), [main]);
  await c.execute(() => { D.commands.PRF(); D.commands.PRF(); D.prf_ui('title'); });
  const preference = await helper(c, 'prf_bw');
  await c.switchToWindow(preference);
  await (await c.$('#prf_dlg')).waitForDisplayed();
  await c.waitUntil(() => c.execute(() => !document.getElementById('title').hidden),
    { timeout: 10000, timeoutMsg: 'The latest rapid Preferences tab request was lost' });
  t.is(await c.execute(() => document.querySelectorAll('#prf_dlg:not([hidden])').length), 1);
  await c.execute(() => I.prf_dlg_cancel.click());
  await c.switchToWindow(main);
  await c.waitUntil(() => visible(c, preference).then(x => !x),
    { timeout: 10000, timeoutMsg: 'Preferences did not hide' });
  await c.execute(() => D.commands.PRF());
  await c.waitUntil(() => visible(c, preference),
    { timeout: 10000, timeoutMsg: 'Preferences did not reopen' });
  t.deepEqual(await labels(c), [main, preference].sort());
  await c.switchToWindow(preference);
  await (await c.$('#prf_dlg')).waitForDisplayed();
});

nativeTest('Status opens on demand, retains output and theme, and reuses its webview', async t => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  t.deepEqual(await labels(c), [main]);
  await c.execute(() => {
    D.prf.statusWindow(1);
    D.prf.statusWindow(1);
  });
  const status = await helper(c, 'stw_bw');
  await c.waitUntil(() => visible(c, status), { timeout: 10000 });
  await c.execute(() => D.ide.handlers.StatusOutput({ text: 'lazy status marker', flags: 0 }));
  await c.switchToWindow(status);
  await c.waitUntil(() => c.execute(() => document.getElementById('status').textContent.includes('lazy status marker')),
    { timeout: 10000, timeoutMsg: 'Status output did not reach the first-use window' });
  const theme = await c.execute(() => ({
    dark: document.getElementById('theme_dark').disabled,
    light: document.getElementById('theme_light').disabled,
  }));
  await c.switchToWindow(main);
  t.is(await c.execute(() => D.theme === 'dark'), !theme.dark);
  t.is(await c.execute(() => D.theme === 'light'), !theme.light);
  await c.execute(() => D.prf.statusWindow(0));
  await c.waitUntil(() => visible(c, status).then(x => !x), { timeout: 10000 });
  await c.execute(() => D.prf.statusWindow(1));
  await c.waitUntil(() => visible(c, status), { timeout: 10000 });
  t.deepEqual(await labels(c), [main, status].sort());
  await c.switchToWindow(status);
  t.true(await c.execute(() => document.getElementById('status').textContent.includes('lazy status marker')));
});

nativeTest('status arriving before its first handshake is kept in order while auto show is off', async t => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  await c.execute(() => {
    D.prf.autoStatus(0);
    D.ide.handlers.StatusOutput({ text: 'first lazy status', flags: 0 });
    D.ide.handlers.StatusOutput({ text: 'second lazy status', flags: 0 });
  });
  const status = await helper(c, 'stw_bw');
  t.false(await visible(c, status), 'autoStatus=false keeps the first-use helper hidden');
  await c.execute(() => D.prf.statusWindow(1));
  await c.waitUntil(() => visible(c, status), { timeout: 10000 });
  await c.switchToWindow(status);
  await c.waitUntil(() => c.execute(() => document.getElementById('status').textContent.includes('second lazy status')),
    { timeout: 10000, timeoutMsg: 'Queued StatusOutput was not replayed' });
  t.deepEqual(await c.execute(() => [...document.querySelectorAll('#status > div')]
    .filter(el => el.textContent.includes('lazy status')).map(el => el.textContent)),
  ['first lazy status', 'second lazy status']);
  await c.switchToWindow(main);
});

nativeTest('hiding Status during first creation remains hidden after handshake', async t => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  await c.execute(() => {
    D.ide.handlers.StatusOutput({ text: 'pending status', flags: 0 });
    D.prf.statusWindow(1);
    D.prf.statusWindow(0);
  });
  const status = await helper(c, 'stw_bw');
  await c.execute(() => new Promise(resolve => D.stw_bw.win.queued('test visibility barrier', resolve)));
  t.false(await visible(c, status), 'the pending Show must not override the later Hide');
  await c.execute(() => D.prf.statusWindow(1));
  await c.waitUntil(() => visible(c, status), { timeout: 10000 });
  await c.switchToWindow(status);
  await c.waitUntil(() => c.execute(() => document.getElementById('status').textContent.includes('pending status')),
    { timeout: 10000 });
  await c.switchToWindow(main);
});

nativeTest('first interpreter string dialog is delivered and reused without a duplicate window', async t => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  t.deepEqual(await labels(c), [main]);
  await c.execute(() => {
    window.lazyDialogReplies = [];
    const send = D.send;
    D.send = (name, data) => {
      if (name === 'ReplyStringDialog') { window.lazyDialogReplies.push(data); return; }
      return send(name, data);
    };
    D.ide.handlers.StringDialog({ title: 'First request', text: 'Enter first value',
      initialValue: 'first', defaultValue: null, token: 14101 });
  });
  const dialog = await helper(c, 'dlg_bw');
  await c.switchToWindow(dialog);
  await c.waitUntil(() => c.execute(() => document.getElementById('gd_content').textContent.includes('Enter first value')),
    { timeout: 10000, timeoutMsg: 'First string dialog did not render' });
  await c.execute(() => document.querySelector('#gd_btns button').click());
  await c.switchToWindow(main);
  await c.waitUntil(() => c.execute(() => window.lazyDialogReplies.length === 1), { timeout: 10000 });
  t.deepEqual(await c.execute(() => window.lazyDialogReplies[0]), { token: 14101, value: 'first' });
  await c.execute(() => D.ide.handlers.StringDialog({ title: 'Second request', text: 'Enter second value',
    initialValue: 'second', defaultValue: null, token: 14102 }));
  await c.switchToWindow(dialog);
  await c.waitUntil(() => c.execute(() => document.getElementById('gd_content').textContent.includes('Enter second value')),
    { timeout: 10000, timeoutMsg: 'Reused string dialog did not render' });
  await c.execute(() => document.querySelector('#gd_btns button').click());
  await c.switchToWindow(main);
  await c.waitUntil(() => c.execute(() => window.lazyDialogReplies.length === 2), { timeout: 10000 });
  t.deepEqual(await labels(c), [main, dialog].sort());
});

nativeTest('dialog replies stay with their session when two owners request one concurrently', async t => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  await c.execute(() => {
    window.firstDialogReplies = [];
    const send = D.send;
    D.send = (name, data) => {
      if (name === 'ReplyStringDialog') { window.firstDialogReplies.push(data); return; }
      return send(name, data);
    };
    D.ide.handlers.StringDialog({ title: 'First owner', text: 'First session request',
      initialValue: 'owner one', token: 14111 });
  });
  const firstDialog = await helper(c, 'dlg_bw');
  const secondId = await c.execute(() => {
    if (!D.lastSpawnedExe) throw new Error('First session did not retain its interpreter executable');
    return D.wm.newSession({ RIDE_SPAWN: D.lastSpawnedExe });
  });
  const second = `w${secondId}`;
  await c.switchToWindow(second);
  await ready(c, 'Second interpreter did not become ready');
  await c.execute(() => {
    window.secondDialogReplies = [];
    const send = D.send;
    D.send = (name, data) => {
      if (name === 'ReplyStringDialog') { window.secondDialogReplies.push(data); return; }
      return send(name, data);
    };
    D.ide.handlers.StringDialog({ title: 'Second owner', text: 'Second session request',
      initialValue: 'owner two', token: 14112 });
  });
  const secondDialog = await helper(c, 'dlg_bw');
  t.not(secondDialog, firstDialog);
  await c.switchToWindow(secondDialog);
  await c.waitUntil(() => c.execute(() => document.getElementById('gd_content').textContent.includes('Second session request')),
    { timeout: 10000 });
  await c.execute(() => document.querySelector('#gd_btns button').click());
  await c.switchToWindow(second);
  await c.waitUntil(() => c.execute(() => window.secondDialogReplies.length === 1), { timeout: 10000 });
  t.deepEqual(await c.execute(() => window.secondDialogReplies[0]), { token: 14112, value: 'owner two' });
  await c.switchToWindow(first);
  t.deepEqual(await c.execute(() => window.firstDialogReplies), []);
  await c.switchToWindow(firstDialog);
  await c.waitUntil(() => c.execute(() => document.getElementById('gd_content').textContent.includes('First session request')),
    { timeout: 10000 });
  await c.execute(() => document.querySelector('#gd_btns button').click());
  await c.switchToWindow(first);
  await c.waitUntil(() => c.execute(() => window.firstDialogReplies.length === 1), { timeout: 10000 });
  t.deepEqual(await c.execute(() => window.firstDialogReplies[0]), { token: 14111, value: 'owner one' });
});

nativeTest('closing a dialog owner during first creation removes its helper and preserves the sibling', async t => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  const secondId = await c.execute(() => {
    if (!D.lastSpawnedExe) throw new Error('First session did not retain its interpreter executable');
    return D.wm.newSession({ RIDE_SPAWN: D.lastSpawnedExe });
  });
  const second = `w${secondId}`;
  await c.switchToWindow(second);
  await ready(c, 'Sibling interpreter did not become ready');
  await c.switchToWindow(first);
  const dialog = await c.execute(() => {
    D.ide.handlers.StringDialog({ title: 'Closing owner', text: 'Do not deliver after owner close',
      initialValue: 'discard', token: 14121 });
    const label = D.dlg_bw.win.label;
    D.wm.main().close();
    return label;
  });
  await c.switchToWindow(second);
  await c.waitUntil(async () => {
    const windows = await labels(c);
    return !windows.includes(first) && !windows.includes(dialog);
  }, { timeout: 10000, timeoutMsg: 'Closed owner left its first-use dialog behind' });
  t.false((await labels(c)).includes(dialog), 'the closed owner has no orphaned dialog webview');
  await ready(c, 'Sibling interpreter lost its prompt after dialog-owner close');
  await c.execute(() => D.ide.exec(["⎕←'lazy-owner-survived=',⍕2+2"], 0));
  try {
    await c.waitUntil(() => c.execute(() => D.ide.wins[0].me.getValue().includes('lazy-owner-survived=4')),
      { timeout: 10000, timeoutMsg: 'Sibling interpreter stopped responding after dialog-owner close' });
    t.true(await c.execute(() => D.ide.wins[0].me.getValue().includes('lazy-owner-survived=4')),
      'the sibling interpreter computed the command after its peer closed');
  } catch (error) {
    const sibling = await c.execute(() => {
      const ide = D.ide;
      const session = ide && ide.wins[0];
      return { connected: ide && ide.connected, dead: ide && ide.dead,
        promptReceived: ide && ide.promptReceived, promptType: ide && ide.promptType,
        inputOperation: ide && !!ide.inputOperation, quiescent: ide && ide.quiescent(),
        tail: session && session.me && session.me.getModel().getLinesContent().slice(-8) };
    }).catch(failure => ({ diagnosticError: String(failure) }));
    error.message += `; sibling=${JSON.stringify(sibling)}; appOutputTail=${t.context.app.output.slice(-3000)}`;
    throw error;
  }
});
