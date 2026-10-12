const test = require('ava');
const { Key } = require('webdriverio');
const { tfw, keys } = require('./_utils');

const nativeTest = process.platform === 'darwin' ? test : test.skip;
tfw.init({ src: 'se', interpreter: true });
const wait = (c, predicate, ...args) => c.waitUntil(() => c.execute(predicate, ...args),
  { timeout: 10000 });

async function focus(c, id = 0) {
  await wait(c, async (token) => {
    await window.__TAURI__.webviewWindow.getCurrentWebviewWindow().setFocus();
    D.ide.wins[token].focus();
    const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
    return (await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label })).focused
      && D.ide.wins[token].me.hasTextFocus();
  }, id);
}

async function ready(c) {
  await wait(c, () => !!(D.ide && D.ide.promptReceived && D.ide.promptType === 1
    && !D.ide.inputOperation && D.ide.quiescent() && D.ide.wins[0].me.getModel()));
}

async function editor(c, floating = false) {
  await ready(c);
  await c.execute((float) => {
    D.prf.floating(+float); D.prf.floatSingle(0); D.prf.indentOnOpen(0); D.prf.ilf(0);
    D.ide.exec(["⎕FX 'r←macKeys121' 'r←1' ⋄ ⎕←'#defined121'"], 0);
  }, floating);
  await wait(c, () => D.ide.wins[0].me.getModel().getLinesContent().includes('#defined121'));
  await ready(c);
  await c.execute(() => D.ide.exec([')ed macKeys121'], 0));
  let token;
  await c.waitUntil(async () => {
    for (const handle of await c.getWindowHandles()) {
      await c.switchToWindow(handle);
      token = await c.execute(() => typeof D !== 'undefined' && D.ide
        && Object.values(D.ide.wins).find(w => w.name === 'macKeys121' && w.me
          && w.me.getModel() && !w.firstOpen)?.id);
      if (token) return true;
    }
    return false;
  }, { timeout: 10000 });
  await focus(c, token);
  return token;
}

async function captureSends(c) {
  await c.execute(() => {
    window.shortcutSends = [];
    const send = D.send;
    D.send = (name, args) => { window.shortcutSends.push(name); return send(name, args); };
  });
}

async function settle(c) {
  await c.execute(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

nativeTest('Mac defaults fix the object and expose editing actions through real keystrokes', async (t) => {
  const c = t.context.app.client;
  const id = await editor(c);
  await c.execute(token => D.ide.wins[token].me.getModel().setValue('r←macKeys121\nr←42'), id);
  await captureSends(c);
  await keys(c, Key.Command, 's');
  await wait(c, token => window.shortcutSends.includes('SaveChanges') && !D.ide.wins[token].isModified, id);
  t.truthy(await c.execute(token => !!D.ide.wins[token], id), 'Fix leaves the editor open');
  await c.execute(() => D.ide.exec(["⎕←'#121=',⍕macKeys121"], 0));
  await ready(c);
  await wait(c, () => D.ide.wins[0].me.getModel().getLinesContent().includes('#121=42'));
  await focus(c, id);
  await c.execute(token => D.ide.wins[token].me.setPosition({ lineNumber: 2, column: 1 }), id);
  await keys(c, Key.Command, '/');
  await settle(c);
  await wait(c, token => D.ide.wins[token].me.getModel().getLineContent(2).includes('⍝'), id);
  await keys(c, Key.Command, '/');
  await wait(c, token => !D.ide.wins[token].me.getModel().getLineContent(2).includes('⍝'), id);
  await c.execute(token => {
    const me = D.ide.wins[token].me;
    me.getModel().setValue('r←macKeys121\n:If 1\nr←42\n:EndIf');
    me.setPosition({ lineNumber: 3, column: 1 });
  }, id);
  await keys(c, Key.Shift, Key.Alt, 'f');
  await wait(c, token => /^\s+r←42$/.test(D.ide.wins[token].me.getModel().getLineContent(3)), id);
  await keys(c, Key.Command, 'f');
  await (await c.$('.find-widget.visible textarea[aria-label="Find"]')).waitForDisplayed();
  await keys(c, Key.Escape);
  await focus(c, id);
  await keys(c, Key.Command, Key.Alt, 'f');
  await (await c.$('.find-widget.visible textarea[aria-label="Replace"]')).waitForDisplayed();
  await keys(c, Key.Escape);
  await focus(c, id);
  await keys(c, Key.Command, Key.Shift, 'p');
  await (await c.$('.quick-input-widget')).waitForDisplayed();
  t.true(await c.execute(() => document.activeElement.closest('.quick-input-widget') !== null));
});

nativeTest('Mac shortcuts can be removed, rebound and reset without inherited or stale actions', async (t) => {
  const c = t.context.app.client;
  const id = await editor(c);
  await c.execute(() => D.prf.keys({ SC: [], RP: [], TGC: [], FX: [] }));
  await c.execute(token => D.ide.wins[token].me.setPosition({ lineNumber: 2, column: 1 }), id);
  const text = await c.execute(token => D.ide.wins[token].me.getValue(), id);
  await captureSends(c);
  for (const chord of [[Key.Command, 'f'], [Key.Command, Key.Alt, 'f'], [Key.Command, '/'], [Key.Command, 's']]) {
    await keys(c, ...chord);
  }
  await settle(c);
  t.false(await c.execute(() => !!document.querySelector('.find-widget.visible')));
  t.is(await c.execute(token => D.ide.wins[token].me.getValue(), id), text);
  t.false(await c.execute(() => window.shortcutSends.includes('SaveChanges')));
  await c.execute(() => D.prf.keys({ SC: ['Cmd+Shift+Y'], RP: [], TGC: [], FX: [] }));
  await keys(c, Key.Command, Key.Shift, 'y');
  await (await c.$('.find-widget.visible')).waitForDisplayed();
  await keys(c, Key.Escape);
  await focus(c, id);
  await c.execute(() => D.prf.keys({ SC: ['Cmd+Shift+U'], RP: [], TGC: [], FX: [] }));
  await keys(c, Key.Command, Key.Shift, 'y');
  await settle(c);
  t.false(await c.execute(() => !!document.querySelector('.find-widget.visible')), 'the old custom binding is gone');
  await keys(c, Key.Command, Key.Shift, 'u');
  await (await c.$('.find-widget.visible')).waitForDisplayed();
  await keys(c, Key.Escape);
  await focus(c, id);
  await c.execute(() => D.prf.keys({}));
  await keys(c, Key.Command, 'f');
  await (await c.$('.find-widget.visible')).waitForDisplayed();
  t.pass();
});

nativeTest('Mac Control-C interrupts the focused busy session and respects removal and helper focus', async (t) => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  await ready(c);
  await captureSends(c);
  const second = await c.execute(() => D.wm.newSession({ RIDE_SPAWN: D.lastSpawnedExe }));
  await c.switchToWindow(`w${second}`);
  await ready(c);
  await captureSends(c);
  await c.switchToWindow(first);
  await focus(c);
  await c.execute(() => D.ide.exec(['⎕DL 30'], 0));
  await wait(c, () => D.ide.promptType === 0);
  await keys(c, '2+3');
  await c.switchToWindow(`w${second}`);
  await c.execute(() => D.installMenu(D.parseMenuDSL(D.prf.menu())));
  await c.switchToWindow(first);
  await keys(c, Key.Control, 'c');
  await ready(c);
  t.is(await c.execute(() => window.shortcutSends.filter(x => x === 'StrongInterrupt').length), 1);
  await wait(c, () => !D.ide.wins[0].taBuffer.length
    && D.ide.wins[0].me.getValue().trimEnd().endsWith('2+3'));
  t.true(await c.execute(() => D.ide.wins[0].me.getValue().trimEnd().endsWith('2+3')),
    'ordinary input typed while busy is replayed at the prompt');
  await c.switchToWindow(`w${second}`);
  t.false(await c.execute(() => window.shortcutSends.includes('StrongInterrupt')), 'the menu installer was not interrupted');
  await c.switchToWindow(first);
  await c.execute(() => D.prf.keys({ SI: [] }));
  await focus(c);
  await keys(c, Key.Control, 'c');
  await settle(c);
  t.is(await c.execute(() => window.shortcutSends.filter(x => x === 'StrongInterrupt').length), 1);
  await c.execute(() => D.prf.keys({}));
  await keys(c, Key.Command, 'f');
  await (await c.$('.find-widget.visible textarea[aria-label="Find"]')).waitForDisplayed();
  await keys(c, Key.Control, 'c');
  await settle(c);
  t.is(await c.execute(() => window.shortcutSends.filter(x => x === 'StrongInterrupt').length), 1,
    'Find input does not interrupt');
  await keys(c, Key.Escape);
  await wait(c, () => !!(D.prf_bw && D.prf_bw.socket));
  await keys(c, Key.Command, ',');
  const helper = await c.execute(() => D.prf_bw.win.label);
  await c.switchToWindow(helper);
  await wait(c, () => !I.prf_dlg.hidden);
  await c.execute(async () => window.__TAURI__.webviewWindow.getCurrentWebviewWindow().setFocus());
  await keys(c, Key.Control, 'c');
  await c.switchToWindow(first);
  await settle(c);
  t.is(await c.execute(() => window.shortcutSends.filter(x => x === 'StrongInterrupt').length), 1,
    'Preferences does not interrupt');
});

nativeTest('Preferences can rebind Fix for a floating editor and reset it to the Mac default', async (t) => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  const id = await editor(c, true);
  const floating = await c.getWindowHandle();
  await captureSends(c);
  await c.execute(token => D.ide.wins[token].me.getModel().setValue('r←macKeys121\nr←84'), id);
  await c.switchToWindow(main);
  await wait(c, () => !!(D.prf_bw && D.prf_bw.socket));
  await c.execute(() => D.prf_ui('shc'));
  const helper = await c.execute(() => D.prf_bw.win.label);
  await c.switchToWindow(helper);
  await wait(c, () => !I.prf_dlg.hidden && !document.getElementById('shc').hidden);
  await c.execute(async () => window.__TAURI__.webviewWindow.getCurrentWebviewWindow().setFocus());
  await (await c.$('#shc_itm_FX .shc_del')).click();
  await (await c.$('#shc_itm_FX .shc_add')).click();
  await keys(c, Key.Command, 's');
  await wait(c, () => !!document.querySelector('#shc_itm_FX .shc_text[title="Cmd+S"]'));
  t.true(await c.execute(() => !document.querySelector('#shc_itm_FX .shc_editor')),
    'Preferences records an existing native menu shortcut without running it');
  await (await c.$('#shc_itm_FX .shc_del')).click();
  await (await c.$('#shc_itm_FX .shc_add')).click();
  await keys(c, Key.Command, Key.Shift, 'y');
  await wait(c, () => !!document.querySelector('#shc_itm_FX .shc_text[title$="Y"]'));
  await (await c.$('#prf_dlg_ok')).click();
  await c.switchToWindow(floating);
  await wait(c, () => D.prf.keys().FX?.some(key => key.endsWith('Y')));
  await focus(c, id);
  await keys(c, Key.Command, 's');
  await settle(c);
  t.false(await c.execute(() => window.shortcutSends.includes('SaveChanges')), 'old Cmd+S is removed');
  await keys(c, Key.Command, Key.Shift, 'y');
  await wait(c, token => window.shortcutSends.includes('SaveChanges') && !D.ide.wins[token].isModified, id);
  t.truthy(await c.execute(token => !!D.ide.wins[token], id));
  await keys(c, Key.Control, 'c');
  await wait(c, () => window.shortcutSends.includes('StrongInterrupt'));
  t.is(await c.execute(() => window.shortcutSends.filter(name => name === 'StrongInterrupt').length), 1,
    'a floating editor sends one interrupt to its owner');
  await c.switchToWindow(main);
  await c.execute(() => D.prf_ui('shc'));
  await c.switchToWindow(helper);
  await wait(c, () => !I.prf_dlg.hidden);
  await (await c.$('tr[data-code="FX"] .shc_rst')).click();
  await (await c.$('#prf_dlg_ok')).click();
  await c.switchToWindow(floating);
  await wait(c, () => !Object.hasOwn(D.prf.keys(), 'FX'));
  await focus(c, id);
  await c.execute(token => D.ide.wins[token].me.getModel().setValue('r←macKeys121\nr←168'), id);
  await keys(c, Key.Command, 's');
  await wait(c, token => D.ide.wins[token].oText.includes('168') && !D.ide.wins[token].isModified, id);
  t.is(await c.execute(() => window.shortcutSends.filter(name => name === 'SaveChanges').length), 2);
});
