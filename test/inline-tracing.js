const test = require('ava');
const { Key } = require('webdriverio');
const { tfw, keys } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });
const nativeTest = process.platform === 'darwin' ? test : test.skip;
const views = [
  ['ITL', 16], ['ITF', 19], ['ITR', 17], ['ITA', 18], ['ITRES', 22],
  ['ITPL', 20], ['ITPF', 24], ['ITPR', 21], ['ITPA', 23],
];
const wait = (c, predicate, ...args) => c.waitUntil(() => c.execute(predicate, ...args),
  { timeout: 15000 });

async function focus(c) {
  await wait(c, async () => {
    const current = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
    await current.setFocus();
    return (await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label: current.label })).focused;
  });
}

async function ready(c) {
  await wait(c, () => !!(D.ide && D.ide.promptReceived && D.ide.promptType === 1
    && !D.ide.inputOperation && D.ide.quiescent() && D.ide.wins[0].me.getModel()));
}

async function beginInline(c, floating = false) {
  await ready(c);
  await c.execute((float) => {
    D.prf.floating(+float); D.prf.floatSingle(0);
    D.prf.indentOnOpen(1); D.prf.ilf(0); D.prf.showEditorToolbar(1);
    D.ide.wins[0].focus();
  }, floating);
  await focus(c);
  await keys(c, '10+2×3', Key.Control, Key.Alt, Key.Enter);
  await wait(c, () => Object.values(D.ide.wins).some(w => w.tc));
  if (!floating) await wait(c, () => D.ide.canInspectInline());
  return c.execute(() => Object.values(D.ide.wins).find(w => w.tc).id);
}

async function aspectToolbar(c, id) {
  await c.execute(token => D.ide.wins[token].focus(), id);
  await wait(c, (token) => {
    const w = D.ide.wins[token];
    return w.dom.getBoundingClientRect().height > 0
      && w.me.getDomNode().parentElement.getBoundingClientRect().height > 0;
  }, id);
  return c.execute((token) => {
    const w = D.ide.wins[token];
    const toolbar = w.dom.querySelector('.toolbar');
    const content = w.me.getDomNode().parentElement;
    return { hidden: getComputedStyle(toolbar).display === 'none',
      top: parseFloat(getComputedStyle(content).top),
      fillsPane: Math.abs(content.getBoundingClientRect().height - w.dom.getBoundingClientRect().height) < 1 };
  }, id);
}

async function inspect(c, command, special, expected) {
  await wait(c, () => D.ide.canInspectInline());
  await c.execute(code => D.commands[code](D.ide.focusedWin.me), command);
  await wait(c, (kind, text) => {
    const w = Object.values(D.ide.wins).find(x => x.specialWindow === kind);
    return !!(w && w.me && !w.firstOpen && D.ide.canInspectInline()
      && (text == null || w.me.getValue().trim() === text));
  }, special, expected == null ? null : expected);
  return c.execute(kind => Object.values(D.ide.wins).find(w => w.specialWindow === kind).id, special);
}

test('inline views reuse live values, preserve drafts and retain tracer focus after function formatting', async (t) => {
  const c = t.context.app.client;
  const tracer = await beginInline(c);
  await c.execute(() => {
    window.inlineFormats = 0;
    const format = D.ide.handlers.ReplyFormatCode;
    D.ide.handlers.ReplyFormatCode = x => { window.inlineFormats += 1; return format(x); };
    const se = D.ide.wins[0];
    const model = se.me.getModel();
    se.me.executeEdits('test', [
      { range: new monaco.Range(1, 1, 1, model.getLineMaxColumn(1)), text: '      ⍝ edited history' },
      { range: new monaco.Range(model.getLineCount(), 1, model.getLineCount(), model.getLineMaxColumn(model.getLineCount())), text: '      ⍝ unsent draft' },
    ]);
    const last = model.getLineCount();
    se.me.setSelection(new monaco.Selection(last, 19, last, 10));
  });
  const draft = await c.execute(() => ({ dirty: D.ide.wins[0].dirty[1],
    selection: D.ide.wins[0].me.getSelection() }));
  const initial = { 16: '2', 19: '×', 17: '3', 18: '<no value>', 22: '<no value>' };
  const ids = {};
  for (const [command, kind] of views) {
    ids[kind] = await inspect(c, command, kind, initial[kind]);
    t.deepEqual(await aspectToolbar(c, ids[kind]), { hidden: true, top: 0, fillsPane: true },
      `aspect ${kind} hides its toolbar and reclaims the space`);
  }
  await c.execute(() => { D.prf.showEditorToolbar(0); D.prf.showEditorToolbar(1); });
  for (const [, kind] of views) t.true((await aspectToolbar(c, ids[kind])).hidden,
    'global toolbar changes keep inspection panes hidden');
  t.false((await aspectToolbar(c, tracer)).hidden, 'the tracer toolbar follows the global setting');
  t.is(await inspect(c, 'ITL', 16, '2'), ids[16], 'reopening reuses the interpreter window');
  await c.execute(() => D.ide.exec([']IT.Left'], 0));
  await wait(c, token => D.ide.canInspectInline() && D.ide.quiescent()
    && D.ide.focusedWin.id === token && D.ide.wins[token].me.hasTextFocus(), ids[16]);
  t.is(await c.execute(() => Object.values(D.ide.wins).filter(w => w.specialWindow === 16).length), 1,
    'direct Execute refocuses the existing Left view');
  const preserved = await c.execute(() => {
    const se = D.ide.wins[0]; const selection = se.me.getSelection();
    return { first: se.me.getModel().getLineContent(1), last: se.me.getModel().getLinesContent().at(-1),
      dirty: se.dirty[1], anchor: selection.selectionStartColumn, cursor: selection.positionColumn };
  });
  t.deepEqual(preserved, { first: '      ⍝ edited history', last: '      ⍝ unsent draft', dirty: draft.dirty,
    anchor: draft.selection.selectionStartColumn, cursor: draft.selection.positionColumn });
  const formats = await c.execute(() => window.inlineFormats);
  await c.execute(id => { D.ide.wins[id].focus(); D.commands.IT(D.ide.wins[id].me); }, ids[16]);
  await wait(c, count => {
    const right = Object.values(D.ide.wins).find(w => w.specialWindow === 17);
    const fn = Object.values(D.ide.wins).find(w => w.specialWindow === 19);
    return right.me.getValue().trim() === '6'
      && fn.me.getValue().trim() === '+' && D.ide.canInspectInline() && D.ide.quiescent();
  }, formats);
  await c.execute(token => D.send('FormatCode', { win: token, text: ['+'] }), ids[19]);
  await wait(c, count => window.inlineFormats > count && D.ide.quiescent(), formats);
  t.true(await c.execute(id => D.ide.focusedWin.id === id && D.ide.wins[id].me.hasTextFocus(), tracer),
    'Next Primitive from an aspect focuses the tracer after all background updates');
  for (const [, kind] of views) t.deepEqual(await aspectToolbar(c, ids[kind]),
    { hidden: true, top: 0, fillsPane: true }, 'aspect updates preserve the hidden toolbar layout');
  const values = await c.execute(() => Object.fromEntries(Object.values(D.ide.wins)
    .filter(w => w.specialWindow >= 16 && w.specialWindow <= 24).map(w => [w.specialWindow, w.me.getValue().trim()])));
  t.deepEqual(values, { 16: '10', 17: '6', 18: '<no value>', 19: '+', 20: '2', 21: '3', 22: '6', 23: '<no value>', 24: '×' });
  await c.execute(id => D.commands.IT(D.ide.wins[id].me), tracer);
  await wait(c, () => D.ide.wins[0].me.getValue().split('\n').some(line => line.trim() === '16')
    && D.ide.promptType === 1 && D.ide.quiescent());
});

test('Next Primitive enters inline mode in a named function', async (t) => {
  const c = t.context.app.client;
  await ready(c);
  await focus(c);
  await keys(c, "⎕FX 'r←inline119' 'r←10+2×3'", Key.Enter);
  await wait(c, () => D.ide.wins[0].lines.some(line => line.text.includes("⎕FX 'r←inline119'")));
  await ready(c);
  await keys(c, 'inline119', Key.Control, Key.Enter);
  await wait(c, () => Object.values(D.ide.wins).some(w => w.tc && w.HIGHLIGHT));
  t.false(await c.execute(() => D.ide.canInspectInline()), 'ordinary tracing is not inline tracing');
  await c.execute(() => { const w = Object.values(D.ide.wins).find(x => x.tc); D.commands.IT(w.me); });
  await wait(c, () => D.ide.canInspectInline());
  t.is(await c.execute(() => Object.values(D.ide.wins).find(w => w.tc).entityType), 1,
    'named inline tracer remains a defined function');
  await inspect(c, 'ITR', 17, '3');
});

test('missing monadic operands remain valid inline views', async (t) => {
  const c = t.context.app.client;
  await ready(c);
  await focus(c);
  await c.execute(() => D.ide.wins[0].focus());
  await keys(c, '-3', Key.Control, Key.Alt, Key.Enter);
  await wait(c, () => D.ide.canInspectInline());
  await inspect(c, 'ITL', 16, '<no value>');
  await inspect(c, 'ITA', 18, '<no value>');
  t.true(await c.execute(() => D.ide.canInspectInline()), 'no operand is not unsupported inline tracing');
});

async function nativeItem(c, command, enabled, dispatch = false) {
  let id;
  await c.waitUntil(async () => {
    try {
      id = await c.execute((code, state, click) => window.__TAURI_INTERNALS__.invoke('ui_test_menu_command',
        { command: code, expectedEnabled: state, dispatch: click }), command, enabled, dispatch);
      return true;
    } catch (_) { return false; }
  }, { timeout: 10000, timeoutMsg: `${command} did not reach enabled=${enabled}` });
  return id;
}

async function secondSession(c) {
  const id = await c.execute(() => D.wm.newSession({ RIDE_SPAWN: D.lastSpawnedExe }));
  const handle = `w${id}`;
  await c.switchToWindow(handle); await ready(c);
  return handle;
}

nativeTest('native inspections follow ready and busy session focus and reject helper windows', async (t) => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  await beginInline(c);
  const second = await secondSession(c);
  await beginInline(c);
  await c.execute(() => D.installMenu(D.parseMenuDSL(D.prf.menu())));
  await focus(c);
  t.true((await nativeItem(c, 'ITL', true)).startsWith(`app:${second}:`));
  await c.execute(() => D.ide.exec(['⎕DL 20'], 0));
  await wait(c, () => D.ide.promptType === 0);
  await nativeItem(c, 'ITL', false);
  await c.switchToWindow(first); await focus(c);
  const installed = await nativeItem(c, 'ITL', true, true);
  t.true(installed.startsWith(`app:${second}:`), 'focus refresh preserves the installed global menu');
  await wait(c, () => Object.values(D.ide.wins).some(w => w.specialWindow === 16));
  await c.switchToWindow(second);
  await focus(c);
  await nativeItem(c, 'ITL', false);
  t.false(await c.execute(() => Object.values(D.ide.wins).some(w => w.specialWindow === 16)),
    'busy last installer never receives the first session command');
  await c.switchToWindow(first);
  const handles = await c.getWindowHandles();
  await c.execute(async () => {
    window.inlineMenuBarrier = false;
    await window.__TAURI__.event.listen('ui-test-inline-menu-barrier', () => { window.inlineMenuBarrier = true; });
  });
  await c.execute(() => D.commands.ABT());
  await c.waitUntil(async () => (await c.getWindowHandles()).length > handles.length, { timeout: 10000 });
  const helper = (await c.getWindowHandles()).find(handle => !handles.includes(handle));
  await c.switchToWindow(helper); await focus(c);
  await nativeItem(c, 'ITR', false, true);
  await c.execute(() => window.__TAURI__.event.emit('ui-test-inline-menu-barrier'));
  await c.switchToWindow(first);
  await wait(c, () => window.inlineMenuBarrier);
  t.false(await c.execute(() => Object.values(D.ide.wins).some(w => w.specialWindow === 17)),
    'helper native focus cannot dispatch an inspection');
});

nativeTest('native inspection from a floating tracer reaches its owning interpreter', async (t) => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  const id = await beginInline(c, true);
  let floating;
  await c.waitUntil(async () => {
    for (const handle of await c.getWindowHandles()) {
      if (handle === first) continue;
      await c.switchToWindow(handle);
      if (await c.execute(token => !!(D.ide && D.ide.wins[token] && D.ide.wins[token].HIGHLIGHT), id)) {
        floating = handle; return true;
      }
    }
    return false;
  }, { timeout: 15000 });
  await c.switchToWindow(first);
  const second = await secondSession(c);
  await c.execute(() => D.installMenu(D.parseMenuDSL(D.prf.menu())));
  await c.switchToWindow(floating); await focus(c);
  await c.execute(token => D.ide.wins[token].focus(), id);
  t.true((await nativeItem(c, 'ITR', true, true)).startsWith(`app:${second}:`));
  await c.switchToWindow(first);
  await wait(c, () => Object.values(D.ide.wins).some(w => w.specialWindow === 17));
  const aspectId = await c.execute(() => Object.values(D.ide.wins).find(w => w.specialWindow === 17).id);
  let aspectHandle;
  await c.waitUntil(async () => {
    for (const handle of await c.getWindowHandles()) {
      if (handle === first || handle === second || handle === floating) continue;
      await c.switchToWindow(handle);
      if (await c.execute(token => !!(D.ide && D.ide.wins[token] && D.ide.wins[token].me.getValue().trim() === '3'), aspectId)) {
        aspectHandle = handle; return true;
      }
    }
    return false;
  }, { timeout: 15000 });
  await c.switchToWindow(aspectHandle); await focus(c);
  t.deepEqual(await aspectToolbar(c, aspectId), { hidden: true, top: 0, fillsPane: true },
    'the floating aspect reclaims its toolbar space');
  await c.execute(() => { D.prf.showEditorToolbar(0); D.prf.showEditorToolbar(1); });
  t.deepEqual(await aspectToolbar(c, aspectId), { hidden: true, top: 0, fillsPane: true },
    'floating preference changes keep its aspect toolbar hidden');
  await c.execute(token => D.ide.wins[token].focus(), aspectId);
  await nativeItem(c, 'IT', true, true);
  await c.switchToWindow(floating);
  await wait(c, token => D.ide.wins[token].HIGHLIGHT.colStart === 4 && D.ide.wins[token].me.hasTextFocus(), id);
  t.true(await c.execute(async () => {
    const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
    return (await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label })).focused;
  }), 'stepping from the floating aspect focuses its owning tracer');
  await c.switchToWindow(aspectHandle);
  t.deepEqual(await aspectToolbar(c, aspectId), { hidden: true, top: 0, fillsPane: true },
    'floating aspect updates retain the reclaimed toolbar space');
  await c.switchToWindow(second);
  t.false(await c.execute(() => Object.values(D.ide.wins).some(w => w.specialWindow === 17)),
    'other session does not receive floating inspection');
});
