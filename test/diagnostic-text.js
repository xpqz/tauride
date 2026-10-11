const { Key } = require('webdriverio');
const test = require('ava');
const { tfw, readClipboard, setFieldValue } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

async function openWindow(c, command) {
  const handles = await c.getWindowHandles();
  await c.execute((name) => D.commands[name](), command);
  await c.waitUntil(async () => (await c.getWindowHandles()).length > handles.length,
    { timeout: 10000, timeoutMsg: `${command} window did not open` });
  const handle = (await c.getWindowHandles()).find(item => !handles.includes(item));
  await c.switchToWindow(handle);
  await (await c.$('textarea[readonly]')).waitForExist();
  await c.waitUntil(async () => c.execute((name) => {
    const field = document.querySelector('textarea[readonly]');
    return !!(window.diagnosticText && field && (name !== 'ABT' || field.value.includes('Git commit:')));
  }, command), { timeout: 10000, timeoutMsg: `${command} diagnostic text did not initialize` });
  return handle;
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

async function changedMatchPixels(c, beforePng, afterPng, wanted) {
  return c.execute(async (beforeBase64, afterBase64, text) => {
    const decode = (base64) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = `data:image/png;base64,${base64}`;
    });
    const [before, after] = await Promise.all([decode(beforeBase64), decode(afterBase64)]);
    const field = document.querySelector('#abt_ta');
    const style = getComputedStyle(field);
    const start = field.value.indexOf(text);
    if (start < 0) throw new Error(`About text does not contain ${text}`);
    const preceding = field.value.slice(0, start);
    const line = preceding.split('\n').length - 1;
    const column = preceding.slice(preceding.lastIndexOf('\n') + 1);
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = style.font;
    const rect = field.getBoundingClientRect();
    const x = rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
      + measure.measureText(column).width - field.scrollLeft;
    const y = rect.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)
      + line * parseFloat(style.lineHeight) - field.scrollTop;
    const scaleX = before.width / window.innerWidth;
    const scaleY = scaleX;
    const left = Math.max(0, Math.floor((x - 2) * scaleX));
    const top = Math.max(0, Math.floor((y - 2) * scaleY));
    const width = Math.min(before.width - left, Math.ceil((measure.measureText(text).width + 4) * scaleX));
    const height = Math.min(before.height - top, Math.ceil((parseFloat(style.lineHeight) + 4) * scaleY));
    const pixels = (image) => {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return context.getImageData(left, top, width, height).data;
    };
    const oldPixels = pixels(before);
    const newPixels = pixels(after);
    let changed = 0;
    for (let i = 0; i < oldPixels.length; i += 4) {
      if (Math.max(...[0, 1, 2].map(channel => Math.abs(oldPixels[i + channel] - newPixels[i + channel]))) >= 20) {
        changed++;
      }
    }
    return { changed, width, height };
  }, beforePng, afterPng, wanted);
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

async function focusNativeWindow(c) {
  const label = await c.execute(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label);
  await c.waitUntil(async () => c.execute(async (name) => {
    const target = new window.__TAURI__.webviewWindow.WebviewWindow(name, { skip: true });
    await target.setFocus();
    const state = await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label: name });
    return state.focused;
  }, label), { timeout: 10000, timeoutMsg: `${label} did not receive native focus` });
}

async function keydown(c, selector, key, shiftKey = false) {
  await c.execute((target, name, shift) => {
    const element = document.querySelector(target);
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey: shift, bubbles: true, cancelable: true }));
  }, selector, key, shiftKey);
}

async function escapeAbout(c, main) {
  const label = await c.execute(() => {
    document.querySelector('textarea[readonly]').focus();
    return window.__TAURI_INTERNALS__.metadata.currentWindow.label;
  });
  await c.switchToWindow(main);
  await c.execute((targetLabel, escape) => window.__TAURI_INTERNALS__.invoke('ui_test_keys', {
    keys: [escape], targetLabel,
  }), label, Key.Escape);
}

async function mainEditorState(c) {
  return c.execute(() => {
    const editor = D.ide.wins[0].me;
    const range = editor.getSelection();
    return { selection: [range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn],
      findOpen: !!document.querySelector('.find-widget.visible') };
  });
}

test('About Find count is readable in both themes', async (t) => {
  const c = t.context.app.client;
  await openWindow(c, 'ABT');
  await (await button(c, 'Find')).click();
  await setFieldValue(c, await c.$('input[type=search]'), 'Version:');
  await c.waitUntil(async () => /1\s*(?:of|\/)\s*2/i.test(await c.execute(() => document.body.innerText)),
    { timeout: 10000, timeoutMsg: 'About Find did not report its match count' });
  const countContrast = await c.execute(() => {
    const count = document.querySelector('[data-diagnostic=count]');
    const channels = (color) => (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const luminance = (color) => {
      const rgb = channels(color).map(value => value / 255)
        .map(value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const contrast = () => {
      let background = count;
      while (background && getComputedStyle(background).backgroundColor.match(/rgba?\(0, 0, 0, 0\)/)) {
        background = background.parentElement;
      }
      const foreground = luminance(getComputedStyle(count).color);
      const behind = luminance(background ? getComputedStyle(background).backgroundColor : 'rgb(255, 255, 255)');
      return (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05);
    };
    document.getElementById('theme_dark').disabled = true;
    document.getElementById('theme_light').disabled = false;
    const light = contrast();
    document.getElementById('theme_dark').disabled = false;
    document.getElementById('theme_light').disabled = true;
    return { light, dark: contrast() };
  });
  t.true(countContrast.light >= 4.5, 'the match count is readable in the light theme');
  t.true(countContrast.dark >= 4.5, 'the match count is readable in the dark theme');
});

test('About distinguishes Copy from Copy All and supports Find', async (t) => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  const baseline = await c.getWindowHandles();
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
  const unmarkedText = await c.takeScreenshot();
  await setFieldValue(c, query, 'vErSiOn:');
  t.true(await c.execute(() => document.activeElement === document.querySelector('input[type=search]')),
    'typing a query keeps focus in Find');
  await c.waitUntil(async () => (await selection(c)).text.toLowerCase() === 'version:',
    { timeout: 10000, timeoutMsg: 'Find did not select a case-insensitive match' });
  t.regex(await c.execute(() => document.body.innerText), /1\s*(?:of|\/)\s*2/i);
  t.is(await c.execute(() => document.querySelector('#abt_ta').scrollTop), 0,
    'the first About match stays at the top of the text viewport');
  const visibleChange = await changedMatchPixels(c, unmarkedText, await c.takeScreenshot(), 'Version:');
  t.true(visibleChange.changed >= 20,
    `Find must paint the current match while the query has focus; ${JSON.stringify(visibleChange)}`);
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
  t.is((await c.getWindowHandles()).length, baseline.length + 1, 'About remains open after closing Find');
  await escapeAbout(c, main);
  await c.waitUntil(async () => (await c.getWindowHandles()).length === baseline.length,
    { timeout: 10000, timeoutMsg: 'second Escape did not close About' });
});

test('Log retains an active match and selection as protocol messages arrive', async (t) => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  const log = await openWindow(c, 'LOG');
  await c.switchToWindow(main);
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 1));
  await c.execute(() => D.ide.exec(['43+43'], 0));
  await c.switchToWindow(log);
  await c.waitUntil(async () => c.execute(() =>
    document.querySelector('textarea[readonly]').value.includes('43+43')),
  { timeout: 10000, timeoutMsg: 'Protocol message did not reach Log' });
  await c.switchToWindow(main);
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 1));
  await c.execute(() => D.ide.exec(Array.from({ length: 20 }, (_, i) => `100+${i}`), 0));
  await c.switchToWindow(log);
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
  await c.execute(() => { document.querySelector('textarea[readonly]').scrollTop = 0; });
  const logQuery = await c.$('input[type=search]');
  await setFieldValue(c, logQuery, '100+19');
  await c.waitUntil(async () => c.execute(() => {
    const field = document.querySelector('textarea[readonly]');
    return field.value.slice(field.selectionStart, field.selectionEnd) === '100+19'
      && field.scrollTop > 0 && document.activeElement === document.querySelector('input[type=search]');
  }), { timeout: 10000, timeoutMsg: 'Find did not reveal a distant Log match while retaining query focus' });
  await setFieldValue(c, logQuery, '43+43');
  t.true(await c.execute(() => document.activeElement === document.querySelector('input[type=search]')),
    'typing a Log query keeps focus in Find');
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
  await c.switchToWindow(log);
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
  await c.switchToWindow(log);
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
  await c.switchToWindow(log);
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
  await c.switchToWindow(log);
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
  await c.switchToWindow(log);
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
  const baseline = await c.getWindowHandles();
  const initialMain = await mainEditorState(c);
  t.false(initialMain.findOpen);
  await openWindow(c, 'ABT');
  await focusNativeWindow(c);
  await c.execute(() => document.querySelector('textarea[readonly]').focus());
  await appMenu(c, 'SA');
  await c.waitUntil(async () => c.execute(() => {
    const field = document.querySelector('textarea[readonly]');
    return field.selectionStart === 0 && field.selectionEnd === field.value.length;
  }), { timeout: 10000, timeoutMsg: 'Select All did not reach About' });
  await appMenu(c, 'SC');
  await (await c.$('input[type=search]')).waitForDisplayed();
  await keydown(c, 'input[type=search]', 'Escape');
  await c.waitUntil(async () => !await (await c.$('input[type=search]')).isDisplayed());
  await escapeAbout(c, main);
  await c.waitUntil(async () => (await c.getWindowHandles()).length === baseline.length);

  await c.switchToWindow(main);
  t.deepEqual(await mainEditorState(c), initialMain, 'About menu commands do not change the session editor');
  const backgroundLog = await openWindow(c, 'LOG');
  const backgroundSelection = await selection(c);
  t.true(await c.execute(() => document.querySelector('[data-diagnostic=find-bar]').hidden));
  await c.switchToWindow(main);
  await openWindow(c, 'LOG');
  const activeLabel = await c.execute(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label);
  await focusNativeWindow(c);
  await c.execute(() => document.querySelector('textarea[readonly]').focus());
  await appMenu(c, 'SA');
  await c.waitUntil(async () => c.execute(() => {
    const field = document.querySelector('textarea[readonly]');
    return field.value.length > 0 && field.selectionStart === 0 && field.selectionEnd === field.value.length;
  }), { timeout: 10000, timeoutMsg: 'Select All did not reach the active Log' });
  await appMenu(c, 'SC');
  await (await c.$('input[type=search]')).waitForDisplayed();
  await c.switchToWindow(backgroundLog);
  t.deepEqual(await selection(c), backgroundSelection, 'Edit Select All leaves the background Log selection alone');
  t.true(await c.execute(() => document.querySelector('[data-diagnostic=find-bar]').hidden),
    'Edit Find leaves the background Log closed');
  const backgroundLabel = await c.execute(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label);
  await c.switchToWindow(main);
  await c.execute(async (label) => {
    const target = new window.__TAURI__.webviewWindow.WebviewWindow(label, { skip: true });
    await target.close();
  }, backgroundLabel);
  await c.waitUntil(async () => (await c.getWindowHandles()).length === baseline.length + 1);
  await c.execute(async (label) => {
    const target = new window.__TAURI__.webviewWindow.WebviewWindow(label, { skip: true });
    await target.close();
  }, activeLabel);
  await c.waitUntil(async () => (await c.getWindowHandles()).length === baseline.length);

  await c.switchToWindow(main);
  await focusNativeWindow(c);
  t.deepEqual(await mainEditorState(c), initialMain, 'Log menu commands do not change the session editor');
  await appMenu(c, 'SC');
  await c.waitUntil(async () => c.execute(() =>
    !!document.querySelector('.find-widget.visible')),
  { timeout: 10000, timeoutMsg: 'Main editor Find was not invoked after closing diagnostics' });
});
