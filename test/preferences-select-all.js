const { Key } = require('webdriverio');
const test = require('ava');
const { tfw, keys } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

async function mainEditorState(c) {
  return c.execute(() => {
    const editor = D.ide.wins[0].me;
    const range = editor.getSelection();
    return { text: editor.getModel().getValue(),
      selection: [range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn] };
  });
}

async function openPreferences(c) {
  const main = await c.getWindowHandle();
  await c.waitUntil(async () => c.execute(() => !!D.prf_bw?.socket),
    { timeout: 10000, timeoutMsg: 'Preferences window did not connect' });
  const label = await c.execute(() => D.prf_bw.win.label);
  await c.execute(() => D.commands.PRF());
  await c.switchToWindow(label);
  await c.waitUntil(async () => c.execute(() => !I.prf_dlg.hidden),
    { timeout: 10000, timeoutMsg: 'Preferences did not open' });
  return { main, label };
}

async function showTab(c, name) {
  await c.execute((tab) => {
    const link = document.querySelector(`#prf_nav a[href="#${tab}"]`);
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  }, name);
  await c.waitUntil(async () => c.execute(tab => !document.getElementById(tab).hidden, name),
    { timeout: 10000, timeoutMsg: `Preferences ${name} tab did not open` });
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

async function selectedField(c, selector) {
  return c.execute((target) => {
    const field = document.querySelector(target);
    return { value: field.value, start: field.selectionStart, end: field.selectionEnd,
      focused: document.activeElement === field };
  }, selector);
}

async function invokeSelectAll(c) {
  await c.execute(() => window.__TAURI_INTERNALS__.invoke('ui_test_menu_command', { command: 'SA' }));
}

async function assertFieldSelected(t, c, selector) {
  await c.waitUntil(async () => {
    const field = await selectedField(c, selector);
    return field.value.length > 0 && field.start === 0 && field.end === field.value.length;
  }, { timeout: 10000, timeoutMsg: `${selector} did not receive Select All` });
  t.true((await selectedField(c, selector)).focused, `${selector} keeps focus`);
}

if (process.platform === 'darwin') {
  test('Edit Select All targets focused Preferences fields without changing the session', async (t) => {
    const c = t.context.app.client;
    const originalMain = await mainEditorState(c);
    const { main, label } = await openPreferences(c);
    for (const { tab, selector, seed } of [
      { tab: 'title', selector: '#title_inp' },
      { tab: 'pmenu', selector: '#pmenu_ta' },
      { tab: 'shc', selector: '#shc_sc', seed: 'select' },
    ]) {
      await showTab(c, tab);
      await focusNativeWindow(c);
      await c.execute((target, value) => {
        const field = document.querySelector(target);
        if (value) field.value = value;
        field.focus();
        field.setSelectionRange(2, 2);
      }, selector, seed);
      await invokeSelectAll(c);
      await assertFieldSelected(t, c, selector);
      await c.switchToWindow(main);
      t.deepEqual(await mainEditorState(c), originalMain, `${selector} leaves the session alone`);
      await c.switchToWindow(label);
    }

    await c.switchToWindow(main);
    await focusNativeWindow(c);
    await c.execute(() => D.ide.wins[0].me.focus());
    await invokeSelectAll(c);
    await c.waitUntil(async () => c.execute(() => {
      const editor = D.ide.wins[0].me;
      const selected = editor.getSelection();
      const full = editor.getModel().getFullModelRange();
      return selected.equalsRange(full);
    }), { timeout: 10000, timeoutMsg: 'Main editor Select All stopped working' });
  });

  test('physical Cmd+A replaces the focused Preferences Title text', async (t) => {
    const c = t.context.app.client;
    const originalMain = await mainEditorState(c);
    const { main } = await openPreferences(c);
    await showTab(c, 'title');
    await focusNativeWindow(c);
    t.is((await selectedField(c, '#title_inp')).value, '{CAPTION}');
    await c.execute(() => {
      const field = document.querySelector('#title_inp');
      field.focus();
      field.setSelectionRange(2, 2);
    });
    await keys(c, Key.Command, 'a');
    await assertFieldSelected(t, c, '#title_inp');
    await keys(c, 'thread ');
    await c.waitUntil(async () => (await selectedField(c, '#title_inp')).value === 'thread ',
      { timeout: 10000, timeoutMsg: 'Typing did not replace the selected Title text' });
    await c.switchToWindow(main);
    t.deepEqual(await mainEditorState(c), originalMain, 'Cmd+A leaves the session alone');
  });
}
