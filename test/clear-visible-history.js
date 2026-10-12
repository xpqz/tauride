const test = require('ava');
const { tfw } = require('./_utils');
const nativeTest = process.platform === 'darwin' ? test : test.skip;

tfw.init({ src: 'se', interpreter: true });

async function session(c) {
  return c.execute(() => {
    const se = D.ide.wins[0];
    const selection = se.me.getSelection();
    return {
      text: se.me.getModel().getValue(),
      selection: [selection.startLineNumber, selection.startColumn,
        selection.endLineNumber, selection.endColumn],
      prompt: se.promptType,
      readOnly: se.me.getOption(monaco.editor.EditorOption.readOnly),
      history: se.hist.slice(),
      historyIndex: se.histIdx,
      dirty: { ...se.dirty },
    };
  });
}

async function waitPrompt(c, type = 1) {
  await c.waitUntil(async () => c.execute(expected => D.ide.wins[0].promptType === expected, type),
    { timeout: 10000, timeoutMsg: `Interpreter did not reach prompt ${type}` });
}

async function runLine(c, expression, output) {
  await c.execute((line) => {
    const ide = D.ide;
    const original = ide.handlers.SetPromptType;
    let busy = false;
    window.cvhPromptCycle = { ready: false, firstNewLine: D.ide.wins[0].lines.length };
    ide.handlers.SetPromptType = function capturePrompt(x) {
      const result = original.call(this, x);
      if (x.type === 0) busy = true;
      if (busy && x.type === 1) {
        window.cvhPromptCycle.ready = true;
        ide.handlers.SetPromptType = original;
      }
      return result;
    };
    const se = D.ide.wins[0];
    se.loadLine(`      ${line}`);
    se.exec(0);
  }, expression);
  await c.waitUntil(async () => c.execute(expected => {
    const se = D.ide.wins[0];
    return window.cvhPromptCycle.ready
      && se.lines.slice(window.cvhPromptCycle.firstNewLine).some(line => line.text.trim() === expected);
  }, output), { timeout: 10000, timeoutMsg: `Interpreter did not print ${output}` });
}

async function clearHistory(c) {
  await c.execute(() => D.commands.CVH());
}

async function clearNotices(c) {
  await c.execute(() => {
    const duration = toastr.options.hideDuration;
    toastr.options.hideDuration = 0;
    toastr.clear();
    if (duration === undefined) delete toastr.options.hideDuration;
    else toastr.options.hideDuration = duration;
  });
  await c.waitUntil(async () => c.execute(() => !document.querySelector('#toast-container .toast-message')),
    { timeout: 10000, timeoutMsg: 'Previous notice did not clear' });
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

test('clear preserves an unsent multirow draft, recall, workspace and interpreter log', async (t) => {
  const c = t.context.app.client;
  await runLine(c, "cvhValue←40 ⋄ ⎕←'set-value-86'", 'set-value-86');
  await runLine(c, "⎕←'old-visible-history-86'", 'old-visible-history-86');
  await c.waitUntil(async () => (await session(c)).text.includes('old-visible-history-86'),
    { timeout: 10000, timeoutMsg: 'Interpreter did not print the historical marker' });
  await c.execute(() => {
    const se = D.ide.wins[0];
    const model = se.me.getModel();
    const last = model.getLineCount();
    se.me.executeEdits('test', [{ range: new monaco.Range(last, 1, last, model.getLineMaxColumn(last)),
      text: '      cvhValue+2\n      cvhValue+3' }]);
    se.me.setPosition({ lineNumber: model.getLineCount(), column: model.getLineMaxColumn(model.getLineCount()) });
  });
  const before = await session(c);
  t.true(before.text.includes('old-visible-history-86'));
  t.true(before.text.endsWith('      cvhValue+2\n      cvhValue+3'));
  await clearHistory(c);
  const after = await session(c);
  t.false(after.text.includes('old-visible-history-86'), 'completed visible history is removed');
  t.is(after.text, '      cvhValue+2\n      cvhValue+3', 'only the unsent draft remains');
  t.deepEqual(after.selection, [2, before.selection[1], 2, before.selection[3]],
    'caret stays on the rebased second draft row');
  t.deepEqual(after.history, before.history, 'recall remains available');
  t.is(after.historyIndex, before.historyIndex);
  t.is(after.prompt, 1);
  t.false(after.readOnly);
  await c.execute(() => D.ide.wins[0].me.trigger('test', 'undo'));
  t.is((await session(c)).text, after.text, 'Undo cannot restore cleared history or remove the draft');

  await c.execute(() => D.ide.wins[0].exec(0));
  await c.waitUntil(async () => {
    const s = await session(c);
    return s.prompt === 1 && /\b42\b/.test(s.text) && /\b43\b/.test(s.text);
  }, { timeout: 10000, timeoutMsg: 'Pending draft did not execute after clear' });
  await c.execute(() => D.send('GetLog', { format: 'json' }));
  await c.waitUntil(async () => (await session(c)).text.includes('old-visible-history-86'),
    { timeout: 10000, timeoutMsg: 'Interpreter log did not restore the historical marker' });
  t.true((await session(c)).history.some(line => line.includes('cvhValue←40')),
    'pre-clear input is still in recall');
});

test('historical edits decline clear; capped history can then clear without stale output', async (t) => {
  const c = t.context.app.client;
  await runLine(c, "cvhOld←11 ⋄ ⎕←'set-old-86'", 'set-old-86');
  await runLine(c, 'cvhOld+1', '12');
  await c.execute(() => {
    const se = D.ide.wins[0];
    const model = se.me.getModel();
    const line = model.getLinesContent().findIndex(text => text.includes('cvhOld←11')) + 1;
    se.me.executeEdits('test', [{ range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
      text: "      cvhOld←22 ⋄ ⎕←'set-old-86'" }]);
  });
  const edited = await session(c);
  t.true(Object.keys(edited.dirty).length > 0, 'historical edit is pending');
  await clearNotices(c);
  await clearHistory(c);
  t.deepEqual(await session(c), edited, 'clear declines without losing or rewriting a historical edit');
  t.truthy(await c.execute(() => {
    const message = document.querySelector('#toast-container .toast-message');
    return message && message.textContent.trim();
  }),
    'declined clear explains why history remains');
  await c.execute(() => D.ide.handlers.SetPromptType({ type: 0 }));
  const busyEdit = await session(c);
  await clearNotices(c);
  await clearHistory(c);
  t.deepEqual(await session(c), busyEdit, 'busy clear also declines while an old edit is pending');
  await c.execute(() => D.ide.handlers.SetPromptType({ type: 1 }));
  await c.execute(() => {
    const se = D.ide.wins[0];
    const model = se.me.getModel();
    const line = model.getLinesContent().findIndex(text => text.includes('cvhOld←22')) + 1;
    se.me.setPosition({ lineNumber: line, column: 7 });
    se.QT(se.me);
  });
  t.true((await session(c)).text.includes('cvhOld←11'), 'Quit restores the original historical line');
  await c.execute(() => {
    const se = D.ide.wins[0];
    const model = se.me.getModel();
    const line = model.getLinesContent().findIndex(text => text.includes('cvhOld←11')) + 1;
    se.me.executeEdits('test', [{ range: new monaco.Range(line, model.getLineMaxColumn(line),
      line, model.getLineMaxColumn(line)), text: '\n      inserted-but-unsent-86' }]);
  });
  const inserted = await session(c);
  t.true(Object.values(inserted.dirty).includes(0), 'a new historical input row is pending');
  await clearNotices(c);
  await clearHistory(c);
  t.deepEqual(await session(c), inserted, 'clear declines without orphaning an inserted row');
  await c.execute(() => {
    const se = D.ide.wins[0];
    const line = se.me.getModel().getLinesContent().findIndex(text => text.includes('inserted-but-unsent-86')) + 1;
    se.me.setPosition({ lineNumber: line, column: 7 });
    se.QT(se.me);
  });
  t.false((await session(c)).text.includes('inserted-but-unsent-86'), 'Quit removes the inserted row');

  await c.execute(() => D.prf.sessionLogSize(5));
  await runLine(c, '⎕←¨⍳12', '12');
  const capped = await session(c);
  t.true(capped.text.split('\n').length <= 5, 'session log cap was applied before clear');
  t.true(capped.text.split('\n').some(line => line.trim() === '12'));
  await clearHistory(c);
  t.is((await session(c)).text, '      ', 'capped history clears to the ready prompt');
  await c.execute(() => D.ide.wins[0].me.trigger('test', 'undo'));
  t.is((await session(c)).text, '      ', 'Undo does not restore capped output');
  await runLine(c, '7+7', '14');
  const continued = await session(c);
  t.true(/\b14\b/.test(continued.text), 'new output still appears');
  t.false(continued.text.split('\n').includes('12'), 'stale metadata does not resurrect old output');
});

test('busy output continues after clear and active multiline input is left untouched', async (t) => {
  const c = t.context.app.client;
  await runLine(c, "⎕←'completed-before-busy'", 'completed-before-busy');
  await c.execute(() => D.ide.exec(["⎕DL 2 ⋄ ⎕←'after-busy'"], 0));
  await waitPrompt(c, 0);
  const busy = await session(c);
  await clearHistory(c);
  const cleared = await session(c);
  t.is(cleared.prompt, 0);
  t.true(cleared.readOnly);
  t.false(cleared.text.includes('completed-before-busy'));
  await c.waitUntil(async () => {
    const s = await session(c);
    return s.prompt === 1 && s.text.split('\n').some(line => line.trim() === 'after-busy');
  }, { timeout: 10000, timeoutMsg: 'Output did not resume after busy clear' });
  t.true(busy.history.length > 0);
  await c.execute(() => D.ide.exec(['∇ cvhIncomplete'], 0));
  await waitPrompt(c, 3);
  const multiline = await session(c);
  await clearNotices(c);
  await clearHistory(c);
  t.deepEqual(await session(c), multiline, 'active multiline input is left untouched');
});

test('busy partial output and later backspace continue on the retained row', async (t) => {
  const c = t.context.app.client;
  await runLine(c, "⎕←'discard-this-86'", 'discard-this-86');
  await c.execute(() => {
    D.ide.handlers.SetPromptType({ type: 0 });
    D.ide.wins[0].add([{ text: 'completed-chunk-86\npartial-86', type: 1, group: 8 }]);
  });
  t.true((await session(c)).text.includes('completed-chunk-86'));
  await clearHistory(c);
  const kept = await session(c);
  t.is(kept.text, 'partial-86');
  t.is(kept.prompt, 0);
  t.true(kept.readOnly);
  await c.execute(() => {
    D.ide.wins[0].add([{ text: 'X\bY\n', type: 1, group: 8 }]);
    D.ide.handlers.SetSessionLineGroup({ line_offset: 1, group: 9 });
  });
  const continued = await session(c);
  t.true(continued.text.startsWith('partial-86Y\n'), 'backspace edits the retained partial row');
  t.false(continued.text.includes('completed-chunk-86'));
  t.false(continued.text.includes('discard-this-86'));
  t.is(await c.execute(() => D.ide.wins[0].lines.at(-1).group), 9,
    'a later group offset resolves against retained log lines');
  await c.execute(() => D.ide.handlers.SetSessionLineGroup({ line_offset: 999, group: 10 }));
  t.is(await c.execute(() => D.ide.wins[0].lines.at(-1).group), 9,
    'an offset into discarded history is ignored');
  await c.execute(() => D.ide.wins[0].add([{ text: 'next-output-86\n', type: 1, group: 9 }]));
  t.true((await session(c)).text.includes('next-output-86'), 'output continues after a stale group offset');
});

test('quad, quote-quad, unknown and disconnected input decline without changing drafts', async (t) => {
  const c = t.context.app.client;
  await c.execute(() => D.ide.wins[0].loadLine('      pending-input-86'));
  for (const type of [2, 4, 5]) {
    await c.execute(value => D.ide.handlers.SetPromptType({ type: value }), type);
    const before = await session(c);
    await clearNotices(c);
    await clearHistory(c);
    t.deepEqual(await session(c), before, `prompt ${type} is untouched`);
    t.truthy(await c.execute(() => {
      const message = document.querySelector('#toast-container .toast-message');
      return message && message.textContent.trim();
    }),
      `prompt ${type} explains the declined clear`);
  }
  await c.execute(() => {
    D.ide.handlers.SetPromptType({ type: 1 });
    D.ide.wins[0].loadLine('      disconnected-draft-86');
    D.ide.die();
  });
  const disconnected = await session(c);
  t.is(disconnected.prompt, 1, 'disconnect is tested from an otherwise clearable prompt');
  t.true(disconnected.text.includes('disconnected-draft-86'));
  await clearNotices(c);
  await clearHistory(c);
  t.deepEqual(await session(c), disconnected, 'disconnected session is untouched');
});

test('View menu exposes Clear Visible History without a default shortcut', async (t) => {
  const menu = await t.context.app.client.execute(() => {
    const view = D.parseMenuDSL(D.prf.menu()).find(item => item[''] === '&View');
    return {
      command: D.cmds.find(entry => entry[0] === 'CVH'),
      item: view && view.items.find(entry => entry.cmd === 'CVH'),
    };
  });
  t.deepEqual(menu.command[2], []);
  t.regex(menu.item[''], /Clear Visible History/i);
});

test('clear invoked from a floating tracer leaves that editor and its focus alone', async (t) => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  await runLine(c, "⎕←'session-only-86'", 'session-only-86');
  await c.execute(() => {
    D.prf.floating(1);
    D.prf.floatSingle(0);
    D.prf.indentOnOpen(0);
    D.ide.handlers.OpenWindow({ token: 86001, debugger: true, name: 'cvhTracer',
      text: ['r←cvhTracer', 'r←86'], entityType: 1, currentRow: 0,
      stop: [], trace: [], monitor: [] });
  });
  let tracer;
  await c.waitUntil(async () => {
    for (const handle of await c.getWindowHandles()) {
      if (handle === main) continue;
      await c.switchToWindow(handle);
      if (await c.execute(() => !!(D.ide && D.ide.wins[86001] && D.ide.wins[86001].me))) {
        tracer = handle;
        return true;
      }
    }
    return false;
  }, { timeout: 10000, timeoutMsg: 'Floating tracer did not open' });
  await c.waitUntil(async () => c.execute(() => {
    const ed = D.ide.wins[86001];
    return !!(ed && ed.me && ed.container && !ed.firstOpen);
  }), { timeout: 10000, timeoutMsg: 'Floating tracer did not finish mounting' });
  const editorText = await c.execute(() => {
    const ed = D.ide.wins[86001];
    ed.focus();
    return ed.me.getModel().getValue();
  });
  await c.waitUntil(async () => c.execute(async () => {
    const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
    const windowRef = new window.__TAURI__.webviewWindow.WebviewWindow(label, { skip: true });
    await windowRef.setFocus();
    const state = await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label });
    return state.focused && D.ide.wins[86001].me.hasTextFocus();
  }), { timeout: 10000, timeoutMsg: 'Floating tracer did not receive native text focus' });
  await c.execute((nativeMenu) => nativeMenu
    ? window.__TAURI_INTERNALS__.invoke('ui_test_menu_command', { command: 'CVH' })
    : D.commands.CVH(D.ide.wins[86001].me), process.platform === 'darwin');
  await c.switchToWindow(main);
  await c.waitUntil(async () => (await session(c)).text === '      ',
    { timeout: 10000, timeoutMsg: 'Floating Clear Visible History did not clear the session' });
  await c.switchToWindow(tracer);
  t.deepEqual(await c.execute(async () => {
    const ed = D.ide.wins[86001];
    const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
    const state = await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label });
    return { text: ed.me.getModel().getValue(), focused: D.ide.focusedWin === ed,
      textFocus: ed.me.hasTextFocus(), nativeFocus: state.focused, tracer: !!ed.tc };
  }), { text: editorText, focused: true, textFocus: true, nativeFocus: true, tracer: true });
});

nativeTest('native View clear follows the focused session after its menu is refreshed', async (t) => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  await runLine(c, "⎕←'first-history-86'", 'first-history-86');
  await c.execute(() => D.ide.wins[0].loadLine('      first-draft-86'));
  const firstBefore = await session(c);
  const secondId = await c.execute(() => D.wm.newSession({ RIDE_SPAWN: D.lastSpawnedExe }));
  t.truthy(secondId, 'a second session opened');
  const second = `w${secondId}`;
  await c.switchToWindow(second);
  await c.waitUntil(async () => c.execute(() => !!(D.ide && D.ide.wins[0]
    && D.ide.wins[0].promptType === 1 && D.ide.wins[0].me.getModel())),
  { timeout: 30000, timeoutMsg: 'Second Dyalog session did not become ready' });
  await focusNativeWindow(c);
  await runLine(c, "⎕←'second-history-86'", 'second-history-86');
  await c.execute(() => {
    D.ide.wins[0].loadLine('      second-draft-86');
    D.installMenu(D.parseMenuDSL(D.prf.menu()));
  });
  const secondBefore = await session(c);
  await c.waitUntil(async () => {
    try {
      const id = await c.execute(() => window.__TAURI_INTERNALS__.invoke('ui_test_menu_command',
        { command: 'CVH', dispatch: false }));
      return id.startsWith(`app:${second}:`);
    } catch (_) { return false; }
  }, { timeout: 10000, timeoutMsg: 'Second session did not install the View menu' });

  await c.switchToWindow(first);
  await focusNativeWindow(c);
  await c.waitUntil(async () => {
    const id = await c.execute(() => window.__TAURI_INTERNALS__.invoke('ui_test_menu_command',
      { command: 'CVH', dispatch: false }));
    return id.startsWith(`app:${first}:`);
  }, { timeout: 10000, timeoutMsg: 'Focused first session did not refresh the View menu' });
  const dispatchedId = await c.execute(() => window.__TAURI_INTERNALS__.invoke('ui_test_menu_command',
    { command: 'CVH' }));
  t.true(dispatchedId.startsWith(`app:${first}:`), 'the focused first session owns the refreshed menu');
  await c.waitUntil(async () => (await session(c)).text === '      first-draft-86',
    { timeout: 10000, timeoutMsg: 'Native View clear did not target the focused first session' });
  t.true(firstBefore.text.includes('first-history-86'));
  await c.execute(() => {
    const se = D.ide.wins[0];
    se.QT(se.me);
  });
  await runLine(c, "⎕←'first-before-preferences-86'", 'first-before-preferences-86');
  await c.execute(() => D.ide.wins[0].loadLine('      first-draft-86'));
  const beforePreferences = await session(c);
  t.true(beforePreferences.text.includes('first-before-preferences-86'));
  await c.waitUntil(async () => c.execute(() => !!(D.prf_bw && D.prf_bw.socket)),
    { timeout: 10000, timeoutMsg: 'First session Preferences did not connect' });
  await c.execute(() => D.commands.PRF());
  const preferences = await c.execute(() => D.prf_bw.win.label);
  await c.switchToWindow(preferences);
  await c.waitUntil(async () => c.execute(() => !I.prf_dlg.hidden),
    { timeout: 10000, timeoutMsg: 'First session Preferences did not open' });
  await focusNativeWindow(c);
  await c.execute(() => window.__TAURI_INTERNALS__.invoke('ui_test_menu_command', { command: 'CVH' }));
  await c.switchToWindow(first);
  t.deepEqual(await session(c), beforePreferences, 'Preferences focus does not clear the first session');
  await c.switchToWindow(second);
  t.deepEqual(await session(c), secondBefore, 'background session keeps its history and draft');
});
