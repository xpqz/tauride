const test = require('ava');
const { tfw, readClipboard, setFieldValue } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

async function openWindow(c, command) {
  const handles = await c.getWindowHandles();
  await c.execute((name) => D.commands[name](), command);
  await c.waitUntil(async () => (await c.getWindowHandles()).length > handles.length,
    { timeout: 10000, timeoutMsg: `${command} window did not open` });
  await c.switchToWindow((await c.getWindowHandles()).find(handle => !handles.includes(handle)));
  await (await c.$('textarea[readonly]')).waitForExist();
}

async function button(c, label) {
  for (const item of await c.$$('button')) {
    if ((await item.getText()).trim() === label) return item;
  }
  throw new Error(`Missing ${label} button`);
}

async function selection(c) {
  return c.execute(() => {
    const field = document.querySelector('textarea[readonly]');
    return { text: field.value.slice(field.selectionStart, field.selectionEnd),
      start: field.selectionStart, end: field.selectionEnd };
  });
}

async function selectText(c, value) {
  await c.execute((wanted) => {
    const field = document.querySelector('textarea[readonly]');
    const start = field.value.indexOf(wanted);
    if (start < 0) throw new Error(`Diagnostic text does not contain ${wanted}`);
    field.focus();
    field.setSelectionRange(start, start + wanted.length);
    field.dispatchEvent(new Event('select', { bubbles: true }));
  }, value);
}

async function expectClipboard(c, expected) {
  await c.waitUntil(async () => (await readClipboard()) === expected,
    { timeout: 10000, timeoutMsg: `Clipboard did not contain ${JSON.stringify(expected)}` });
}

async function appMenu(c, command) {
  await c.execute((name) => window.__TAURI_INTERNALS__.invoke('ui_test_menu_command', { command: name }), command);
}

async function keydown(c, selector, key, shiftKey = false) {
  await c.execute((target, name, shift) => {
    const element = document.querySelector(target);
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey: shift, bubbles: true, cancelable: true }));
  }, selector, key, shiftKey);
}

async function mainEditorState(c) {
  return c.execute(() => {
    const editor = D.ide.wins[0].me;
    const range = editor.getSelection();
    return { selection: [range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn],
      findOpen: !!document.querySelector('.find-widget.visible') };
  });
}

test('About distinguishes Copy from Copy All and supports Find', async (t) => {
  const c = t.context.app.client;
  await openWindow(c, 'ABT');
  const all = await c.execute(() => document.querySelector('textarea[readonly]').value);
  t.true(all.includes('Git commit:'));
  t.false(await (await button(c, 'Copy')).isEnabled());

  await (await button(c, 'Copy All')).click();
  await expectClipboard(c, all);
  await selectText(c, 'Git commit:');
  t.true(await (await button(c, 'Copy')).isEnabled());
  await (await button(c, 'Copy')).click();
  await expectClipboard(c, 'Git commit:');

  await c.execute(() => {
    const field = document.querySelector('textarea[readonly]');
    field.setSelectionRange(0, 0);
    field.dispatchEvent(new Event('select', { bubbles: true }));
  });
  t.false(await (await button(c, 'Copy')).isEnabled());
  await c.execute(() => {
    document.querySelector('textarea[readonly]').focus();
    document.execCommand('copy');
  });
  t.is(await readClipboard(), 'Git commit:');

  await (await button(c, 'Find')).click();
  const query = await c.$('input[type=search]');
  await query.waitForDisplayed();
  t.is(await query.getValue(), '', 'Find starts with an empty query');
  t.false(/no matches/i.test(await c.execute(() => document.body.innerText)),
    'an empty query is not reported as a failed search');
  await setFieldValue(c, query, 'vErSiOn:');
  await c.waitUntil(async () => (await selection(c)).text.toLowerCase() === 'version:',
    { timeout: 10000, timeoutMsg: 'Find did not select a case-insensitive match' });
  t.regex(await c.execute(() => document.body.innerText), /1\s*(?:of|\/)\s*2/i);
  const first = (await selection(c)).start;
  await (await button(c, 'Next')).click();
  const second = (await selection(c)).start;
  t.not(second, first);
  t.regex(await c.execute(() => document.body.innerText), /2\s*(?:of|\/)\s*2/i);
  await (await button(c, 'Next')).click();
  t.is((await selection(c)).start, first, 'next wraps after the final match');
  await (await button(c, 'Previous')).click();
  t.is((await selection(c)).start, second, 'previous wraps before the first match');
  await keydown(c, 'input[type=search]', 'Enter');
  t.is((await selection(c)).start, first, 'Enter advances Find');
  await keydown(c, 'input[type=search]', 'Enter', true);
  t.is((await selection(c)).start, second, 'Shift+Enter reverses Find');

  await setFieldValue(c, query, 'unlikely diagnostic text 43');
  await c.waitUntil(async () => /no matches|0 matches|0 of 0|0\/0/i.test(
    await c.execute(() => document.body.innerText)),
  { timeout: 10000, timeoutMsg: 'Find did not report no matches' });
  t.is((await selection(c)).text, '', 'a failed search clears the old match selection');
  await c.execute(() => {
    const field = document.querySelector('input[type=search]');
    field.focus();
    field.select();
  });
  await c.execute(() => document.execCommand('copy'));
  await expectClipboard(c, 'unlikely diagnostic text 43');
  await setFieldValue(c, query, '');
  t.is((await selection(c)).text, '', 'clearing a failed query does not select text');
  t.false(/no matches|\b\d+\s*(?:of|\/)\s*\d+\b/i.test(await c.execute(() => document.body.innerText)),
    'clearing a failed query clears its stale result status');
  await keydown(c, 'input[type=search]', 'Escape');
  t.false(await query.isDisplayed(), 'first Escape closes Find');
  t.true((await c.getWindowHandles()).length > 1, 'About remains open after closing Find');
  await keydown(c, 'textarea[readonly]', 'Escape');
  await c.waitUntil(async () => (await c.getWindowHandles()).length === 1,
    { timeout: 10000, timeoutMsg: 'second Escape did not close About' });
});

test('Log retains an active match and selection as protocol messages arrive', async (t) => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  await openWindow(c, 'LOG');
  await c.switchToWindow(main);
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 1));
  await c.execute(() => D.ide.exec(['43+43'], 0));
  await c.switchToWindow((await c.getWindowHandles()).find(handle => handle !== main));
  await c.waitUntil(async () => c.execute(() =>
    document.querySelector('textarea[readonly]').value.includes('43+43')),
  { timeout: 10000, timeoutMsg: 'Protocol message did not reach Log' });
  await c.switchToWindow(main);
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 1));
  await c.execute(() => D.ide.exec(Array.from({ length: 20 }, (_, i) => `100+${i}`), 0));
  await c.switchToWindow((await c.getWindowHandles()).find(handle => handle !== main));
  await c.waitUntil(async () => c.execute(() =>
    document.querySelector('textarea[readonly]').value.includes('100+19')),
  { timeout: 20000, timeoutMsg: 'Log fixture did not fill the view' });
  t.true(await c.execute(() => {
    const field = document.querySelector('textarea[readonly]');
    return field.scrollHeight > field.clientHeight;
  }), 'log fixture must overflow to exercise scrolling');
  const all = await c.execute(() => document.querySelector('textarea[readonly]').value);
  await (await button(c, 'Copy All')).click();
  await expectClipboard(c, all);

  await (await button(c, 'Find')).click();
  await setFieldValue(c, await c.$('input[type=search]'), '43+43');
  await c.waitUntil(async () => (await selection(c)).text === '43+43',
    { timeout: 10000, timeoutMsg: 'Log Find did not select the protocol expression' });
  const first = (await selection(c)).start;
  await (await button(c, 'Next')).click();
  t.true((await selection(c)).start > first, 'Find can navigate to a later log occurrence');
  await c.execute(() => {
    const field = document.querySelector('textarea[readonly]');
    field.scrollTop = field.scrollHeight;
  });
  const before = await selection(c);
  const beforeScroll = await c.execute(() => document.querySelector('textarea[readonly]').scrollTop);
  const beforeText = await c.execute(() => document.querySelector('textarea[readonly]').value);
  const beforeCount = await c.execute(() => {
    const match = document.body.innerText.match(/\b\d+\s*(?:of|\/)\s*(\d+)\b/i);
    return match && Number(match[1]);
  });
  t.true(beforeCount > 1, 'the log has multiple matches to navigate');
  await c.switchToWindow(main);
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 1));
  await c.execute(() => D.ide.exec(['43+43'], 0));
  await c.switchToWindow((await c.getWindowHandles()).find(handle => handle !== main));
  await c.waitUntil(async () => c.execute((length) =>
    document.querySelector('textarea[readonly]').value.length > length, beforeText.length),
  { timeout: 10000, timeoutMsg: 'Matching protocol message did not reach Log' });
  t.deepEqual(await selection(c), before, 'append preserves the selected match');
  t.is(await (await c.$('input[type=search]')).getValue(), '43+43');
  await c.waitUntil(async () => c.execute((count) => {
    const match = document.body.innerText.match(/\b\d+\s*(?:of|\/)\s*(\d+)\b/i);
    return match && Number(match[1]) > count;
  }, beforeCount), { timeout: 10000, timeoutMsg: 'Find count did not include appended match' });
  t.is(await c.execute(() => document.querySelector('textarea[readonly]').scrollTop), beforeScroll,
    'active Find suppresses follow-tail scrolling even when at the bottom');
  await c.execute(() => document.querySelector('textarea[readonly]').focus());
  await (await button(c, 'Copy')).click();
  await expectClipboard(c, '43+43');

  await setFieldValue(c, await c.$('input[type=search]'), 'no log match 43');
  t.is((await selection(c)).text, '', 'a failed Log query has no selected match');
  await c.execute(() => {
    const field = document.querySelector('textarea[readonly]');
    field.scrollTop = field.scrollHeight;
  });
  const searchingScroll = await c.execute(() => document.querySelector('textarea[readonly]').scrollTop);
  await c.switchToWindow(main);
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 1));
  await c.execute(() => D.ide.exec(['47+47'], 0));
  await c.switchToWindow((await c.getWindowHandles()).find(handle => handle !== main));
  await c.waitUntil(async () => c.execute(() =>
    document.querySelector('textarea[readonly]').value.includes('47+47')),
  { timeout: 10000, timeoutMsg: 'No-match-search protocol message did not reach Log' });
  t.is(await c.execute(() => document.querySelector('textarea[readonly]').scrollTop), searchingScroll,
    'open Find suppresses follow-tail without a text selection');

  await keydown(c, 'input[type=search]', 'Escape');
  await selectText(c, '43+43');
  await c.execute(() => {
    const field = document.querySelector('textarea[readonly]');
    field.scrollTop = field.scrollHeight;
  });
  const manual = await selection(c);
  const manualScroll = await c.execute(() => document.querySelector('textarea[readonly]').scrollTop);
  await c.switchToWindow(main);
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 1));
  await c.execute(() => D.ide.exec(['44+44'], 0));
  await c.switchToWindow((await c.getWindowHandles()).find(handle => handle !== main));
  await c.waitUntil(async () => c.execute(() =>
    document.querySelector('textarea[readonly]').value.includes('44+44')),
  { timeout: 10000, timeoutMsg: 'Manual-selection protocol message did not reach Log' });
  t.deepEqual(await selection(c), manual, 'append preserves a manual selection with Find closed');
  t.is(await c.execute(() => document.querySelector('textarea[readonly]').scrollTop), manualScroll,
    'selection suppresses follow-tail scrolling even when at the bottom');
  await (await button(c, 'Copy All')).click();
  const copiedAll = await readClipboard();
  t.is(copiedAll, await c.execute(() => document.querySelector('textarea[readonly]').value),
    'Copy All uses the current complete log after appends');
  await c.execute(() => {
    const field = document.querySelector('textarea[readonly]');
    field.setSelectionRange(0, 0);
    field.dispatchEvent(new Event('select', { bubbles: true }));
    field.scrollTop = field.scrollHeight;
    field.focus();
  });
  t.false(await (await button(c, 'Copy')).isEnabled());
  await c.execute(() => document.execCommand('copy'));
  t.is(await readClipboard(), copiedAll, 'empty Copy does not replace the clipboard');
  await c.execute(() => { document.querySelector('textarea[readonly]').scrollTop = 0; });
  await c.switchToWindow(main);
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 1));
  await c.execute(() => D.ide.exec(['46+46'], 0));
  await c.switchToWindow((await c.getWindowHandles()).find(handle => handle !== main));
  await c.waitUntil(async () => c.execute(() =>
    document.querySelector('textarea[readonly]').value.includes('46+46')),
  { timeout: 10000, timeoutMsg: 'Browsing-position protocol message did not reach Log' });
  t.is(await c.execute(() => document.querySelector('textarea[readonly]').scrollTop), 0,
    'browsing earlier log text without a selection does not jump');
  await c.execute(() => {
    const field = document.querySelector('textarea[readonly]');
    field.scrollTop = field.scrollHeight;
  });
  await c.switchToWindow(main);
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 1));
  await c.execute(() => D.ide.exec(['45+45'], 0));
  await c.switchToWindow((await c.getWindowHandles()).find(handle => handle !== main));
  await c.waitUntil(async () => c.execute(() =>
    document.querySelector('textarea[readonly]').value.includes('45+45')),
  { timeout: 10000, timeoutMsg: 'Tail-follow protocol message did not reach Log' });
  t.true(await c.execute(() => {
    const field = document.querySelector('textarea[readonly]');
    return field.scrollHeight - field.clientHeight - field.scrollTop < 3;
  }), 'Log follows new output while already at the bottom');
});

if (process.platform === 'darwin') test('native Edit menu targets the active diagnostic window and still reaches the main editor', async (t) => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  const initialMain = await mainEditorState(c);
  t.false(initialMain.findOpen);
  await openWindow(c, 'ABT');
  await c.execute(() => document.querySelector('textarea[readonly]').focus());
  await appMenu(c, 'SA');
  t.is((await selection(c)).text, await c.execute(() => document.querySelector('textarea[readonly]').value));
  await appMenu(c, 'SC');
  await (await c.$('input[type=search]')).waitForDisplayed();
  await keydown(c, 'input[type=search]', 'Escape');
  await c.waitUntil(async () => !(await c.$('input[type=search]')).isDisplayed());
  await keydown(c, 'textarea[readonly]', 'Escape');
  await c.waitUntil(async () => (await c.getWindowHandles()).length === 1);

  await c.switchToWindow(main);
  t.deepEqual(await mainEditorState(c), initialMain, 'About menu commands do not change the session editor');
  await openWindow(c, 'LOG');
  await c.execute(() => document.querySelector('textarea[readonly]').focus());
  await appMenu(c, 'SA');
  t.is((await selection(c)).text, await c.execute(() => document.querySelector('textarea[readonly]').value));
  await appMenu(c, 'SC');
  await (await c.$('input[type=search]')).waitForDisplayed();
  await c.execute(() => window.close());
  await c.waitUntil(async () => (await c.getWindowHandles()).length === 1);

  await c.switchToWindow(main);
  t.deepEqual(await mainEditorState(c), initialMain, 'Log menu commands do not change the session editor');
  await appMenu(c, 'SC');
  await c.waitUntil(async () => c.execute(() =>
    !!document.querySelector('.find-widget.visible')),
  { timeout: 10000, timeoutMsg: 'Main editor Find was not invoked after closing diagnostics' });
});
