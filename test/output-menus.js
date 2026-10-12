const test = require('ava');
const { tfw } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });
const nativeTest = process.platform === 'darwin' ? test : test.skip;
const wait = (c, predicate, ...args) => c.waitUntil(() => c.execute(predicate, ...args),
  { timeout: 15000 });
const ready = c => wait(c, () => !!(D.ide && D.ide.promptReceived && D.ide.promptType === 1
  && !D.ide.inputOperation && !D.ide.pending.length && D.ide.quiescent()));

async function execute(c, line) {
  await ready(c);
  const start = await c.execute((text) => {
    const count = D.ide.wins[0].lines.length;
    D.ide.exec([text], 0);
    return count;
  }, line);
  await ready(c);
  return c.execute(index => D.ide.wins[0].lines.slice(index)
    .filter(item => item.type !== 14).map(item => item.text).join(''), start);
}

async function command(c, code) {
  await ready(c);
  await c.execute((name) => {
    const find = items => items.reduce((found, item) => found || (item.cmd === name ? item
      : item.items && find(item.items)), null);
    const item = find(D.parseMenuDSL(D.prf.menu()));
    if (!item) throw new Error(`Missing output menu command ${name}`);
    item.action();
  }, code);
  await ready(c);
}

async function focus(c) {
  await wait(c, async () => {
    const current = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
    await current.setFocus();
    return (await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label: current.label })).focused;
  });
}

async function nativeItem(c, commandName, enabled, dispatch = false) {
  let id;
  await c.waitUntil(async () => {
    try {
      id = await c.execute((code, state, click) => window.__TAURI_INTERNALS__.invoke('ui_test_menu_command',
        { command: code, expectedEnabled: state, dispatch: click }), commandName, enabled, dispatch);
      return true;
    } catch (_) { return false; }
  }, { timeout: 10000, timeoutMsg: `${commandName} did not reach enabled=${enabled}` });
  return id;
}

test('Boxing and Rows choices change live interpreter settings without resetting other options', async (t) => {
  const c = t.context.app.client;
  await execute(c, ']rows off');
  await execute(c, ']box off -view=max -trains=tree -fns=on');
  for (const [code, style] of [['BXN', 'non'], ['BXMIN', 'min'], ['BXMID', 'mid'], ['BXMAX', 'max']]) {
    await command(c, code);
    t.regex(await execute(c, ']box ?'), new RegExp(`Box ON -style=${style} -view=max -trains=tree -fns=on`));
    const output = await execute(c, "'abc' (1 2 3)");
    t.is(/[┌┐└┘]/.test(output), style !== 'non', `${style} has the expected visible borders`);
  }
  await command(c, 'BXO');
  t.regex(await execute(c, ']box ?'), /Box OFF -style=max -view=max -trains=tree -fns=on/);
  await execute(c, ']rows off -style=long -fold=off -fns=on -dots=:');
  for (const [code, style] of [['RWL', 'long'], ['RWC', 'cut'], ['RWW', 'wrap']]) {
    await command(c, code);
    t.regex(await execute(c, ']rows ?'), new RegExp(`Rows ON -style=${style} -fold=off -fns=on -dots=:`));
  }
  await command(c, 'RWC');
  for (let n = 0; n <= 9; n += 1) {
    await command(c, 'RWO');
    await command(c, `RWF${n}`);
    t.regex(await execute(c, ']rows ?'), new RegExp(`Rows ON -style=cut -fold=${n} -fns=on -dots=:`));
  }
  await command(c, 'RWFO');
  t.regex(await execute(c, ']rows ?'), /Rows ON -style=cut -fold=off -fns=on -dots=:/);
  await command(c, 'RWO');
  t.regex(await execute(c, ']rows ?'), /Rows OFF -style=cut -fold=off -fns=on -dots=:/);
});

test('Rows modes visibly extend, cut, wrap and fold output', async (t) => {
  const c = t.context.app.client;
  await execute(c, ']box off');
  await execute(c, ']rows off -fold=off -fns=off -dots=:');
  const expression = "(512⍴'x'),'END'";
  const lines = text => text.split('\n').filter(line => line.length);
  await command(c, 'RWL');
  const long = lines(await execute(c, expression));
  t.true(long.some(line => line.length >= 515 && line.endsWith('END')));
  await command(c, 'RWC');
  const cut = lines(await execute(c, expression));
  t.true(cut.some(line => line.endsWith(':::')));
  t.false(cut.some(line => line.includes('END')));
  await command(c, 'RWW');
  const wrapped = lines(await execute(c, expression));
  t.true(wrapped.length > 1);
  t.true(wrapped.some(line => line.endsWith('END')));
  t.true(Math.max(...wrapped.map(line => line.length)) < 515);
  await command(c, 'RWF3');
  t.deepEqual(lines(await execute(c, expression)), wrapped, 'Wrap ignores the folding option');
  await command(c, 'RWL');
  const folded = lines(await execute(c, "1000 1⍴'x'"));
  t.true(folded.length < 1000);
  t.true(folded.some(line => /^:+$/.test(line)), 'tall output contains a fold marker');
  t.deepEqual(folded.slice(-3), ['x', 'x', 'x'], 'three trailing rows remain visible');
});

test('output menu commands and help preserve modified history, unfinished input and selection', async (t) => {
  const c = t.context.app.client;
  await execute(c, ']box off');
  await execute(c, ']rows off');
  await execute(c, '1+1');
  await c.execute(() => {
    const se = D.ide.wins[0];
    const model = se.me.getModel();
    const last = model.getLineCount();
    se.me.executeEdits('test', [
      { range: new monaco.Range(1, 1, 1, model.getLineMaxColumn(1)), text: '      ⍝ modified history' },
      { range: new monaco.Range(last, 1, last, model.getLineMaxColumn(last)), text: '      unsubmitted←42' },
    ]);
    se.me.setSelection(new monaco.Selection(last, 21, last, 9));
  });
  for (const code of ['BXMID', 'RWL', 'BXQ', 'RWQ', 'BXH', 'RWH']) {
    await command(c, code);
    const state = await c.execute(() => {
      const se = D.ide.wins[0]; const model = se.me.getModel(); const sel = se.me.getSelection();
      return { first: model.getLineContent(1), last: model.getLineContent(model.getLineCount()),
        selected: model.getValueInRange(sel), reversed: sel.selectionStartColumn > sel.positionColumn,
        atTail: sel.positionLineNumber === model.getLineCount(), preserving: !!se.preserveDraft };
    });
    t.deepEqual(state, { first: '      ⍝ modified history', last: '      unsubmitted←42',
      selected: 'submitted←42', reversed: true, atTail: true, preserving: false }, code);
  }
});

test('output actions retain an empty prompt and selections in clean history', async (t) => {
  const c = t.context.app.client;
  await execute(c, '2+2');
  for (const code of ['BXMID', 'RWL', 'BXQ', 'RWQ', 'BXH', 'RWH']) {
    await command(c, code);
    t.deepEqual(await c.execute(() => {
      const se = D.ide.wins[0]; const model = se.me.getModel(); const pos = se.me.getPosition();
      return { tail: model.getLineContent(model.getLineCount()), column: pos.column,
        atTail: pos.lineNumber === model.getLineCount(), dirty: Object.keys(se.dirty) };
    }), { tail: '      ', column: 7, atTail: true, dirty: [] }, code);
  }
  const selection = await c.execute(() => {
    const me = D.ide.wins[0].me;
    const lines = me.getModel().getLinesContent();
    const line = lines.findIndex(text => text.trim() === '2+2') + 1;
    const column = lines[line - 1].indexOf('2+2') + 1;
    me.setSelection(new monaco.Selection(line, column + 3, line, column));
    return { line, text: me.getModel().getValueInRange(me.getSelection()) };
  });
  t.is(selection.text, '2+2');
  await command(c, 'BXQ');
  t.deepEqual(await c.execute(() => {
    const me = D.ide.wins[0].me; const model = me.getModel(); const sel = me.getSelection();
    return { line: sel.positionLineNumber, text: model.getValueInRange(sel),
      reversed: sel.selectionStartColumn > sel.positionColumn,
      tail: model.getLineContent(model.getLineCount()) };
  }), { ...selection, reversed: true, tail: '      ' });
});

test('output choices refuse busy, quad and quote-quad prompts without queuing commands', async (t) => {
  const c = t.context.app.client;
  await ready(c);
  await c.execute(() => {
    window.outputExecutes = [];
    const send = D.send;
    D.send = (name, payload) => {
      if (name === 'Execute') window.outputExecutes.push(payload.text);
      return send(name, payload);
    };
    D.ide.exec(['⎕DL 3'], 0);
  });
  await wait(c, () => D.ide.promptType === 0);
  for (const type of [0, 2, 4]) {
    if (type) {
      await ready(c);
      await c.execute(prompt => D.ide.exec([prompt === 2 ? '⎕←⎕' : '⍞'], 0), type);
      await wait(c, prompt => D.ide.promptType === prompt, type);
    }
    const before = await c.execute(() => window.outputExecutes.length);
    await c.execute(() => { D.commands.BXMAX(); D.commands.RWW(); });
    t.deepEqual(await c.execute(() => ({ count: window.outputExecutes.length,
      pending: D.ide.pending.length, preserving: !!D.ide.wins[0].preserveDraft })),
    { count: before, pending: 0, preserving: false }, `prompt ${type}`);
    if (type) await c.execute(() => D.ide.exec(['42'], 0));
    await ready(c);
  }
});

nativeTest('native output commands follow session focus and reject helper windows', async (t) => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  await execute(c, ']box off');
  const id = await c.execute(() => D.wm.newSession({ RIDE_SPAWN: D.lastSpawnedExe }));
  const second = `w${id}`;
  await c.switchToWindow(second);
  await execute(c, ']box off');
  await c.execute(() => D.installMenu(D.parseMenuDSL(D.prf.menu())));
  await focus(c);
  await nativeItem(c, 'BXMAX', true);
  await c.switchToWindow(first); await focus(c);
  const before = await c.execute(() => D.ide.wins[0].lines.length);
  await nativeItem(c, 'BXMAX', true, true);
  await wait(c, start => D.ide.wins[0].lines.slice(start).some(line => line.type === 14
    && line.text.includes(']box on -style=max')), before);
  await ready(c);
  t.regex(await execute(c, ']box ?'), /Box ON -style=max/);
  const beforeCut = await c.execute(() => D.ide.wins[0].lines.length);
  await nativeItem(c, 'RWC', true, true);
  await wait(c, start => D.ide.wins[0].lines.slice(start).some(line => line.type === 14
    && line.text.includes(']rows on -style=cut')), beforeCut);
  await ready(c);
  t.regex(await execute(c, ']rows ?'), /Rows ON -style=cut/,
    'native Rows Cut runs the user command rather than the clipboard action');
  await c.switchToWindow(second);
  t.regex(await execute(c, ']box ?'), /Box OFF/);
  await focus(c);
  await c.execute(() => D.ide.exec(['⎕DL 3'], 0));
  await wait(c, () => D.ide.promptType === 0);
  await nativeItem(c, 'BXMAX', false);
  await ready(c);
  const handles = await c.getWindowHandles();
  await c.execute(async () => {
    window.outputMenuBarrier = false;
    await window.__TAURI__.event.listen('ui-test-output-menu-barrier', () => { window.outputMenuBarrier = true; });
    D.commands.ABT();
  });
  await c.waitUntil(async () => (await c.getWindowHandles()).length > handles.length, { timeout: 10000 });
  const helper = (await c.getWindowHandles()).find(handle => !handles.includes(handle));
  await c.switchToWindow(helper); await focus(c);
  await nativeItem(c, 'BXMAX', false, true);
  await c.execute(() => window.__TAURI__.event.emit('ui-test-output-menu-barrier'));
  await c.switchToWindow(second);
  await wait(c, () => window.outputMenuBarrier);
  t.regex(await execute(c, ']box ?'), /Box OFF/, 'helper focus cannot change a background interpreter');
});

nativeTest('native output choices from a floating editor affect only its owning interpreter', async (t) => {
  const c = t.context.app.client;
  const first = await c.getWindowHandle();
  await execute(c, ']box off');
  await c.execute(() => {
    D.prf.floating(1); D.prf.floatSingle(0);
    D.send('Edit', { win: 0, pos: 0, text: 'outputMenuFixture' });
  });
  let floating;
  await c.waitUntil(async () => {
    for (const handle of await c.getWindowHandles()) {
      if (handle === first) continue;
      await c.switchToWindow(handle);
      if (await c.execute(() => !!(D.ide && D.ide.floating && Object.values(D.ide.wins).some(w => w.name === 'outputMenuFixture')))) {
        floating = handle; return true;
      }
    }
    return false;
  }, { timeout: 15000 });
  await c.switchToWindow(first);
  const before = await c.execute(() => D.ide.wins[0].lines.length);
  const id = await c.execute(() => D.wm.newSession({ RIDE_SPAWN: D.lastSpawnedExe }));
  const second = `w${id}`;
  await c.switchToWindow(second); await execute(c, ']box off');
  await c.execute(() => D.installMenu(D.parseMenuDSL(D.prf.menu())));
  await c.switchToWindow(floating); await focus(c);
  await wait(c, () => {
    const editor = Object.values(D.ide.wins).find(w => w.name === 'outputMenuFixture');
    if (!editor || !editor.me || !editor.me.getModel()) return false;
    editor.focus();
    return editor.me.hasTextFocus();
  });
  await nativeItem(c, 'BXMIN', true, true);
  await c.switchToWindow(first);
  await wait(c, start => D.ide.wins[0].lines.slice(start).some(line => line.type === 14
    && line.text.includes(']box on -style=min')), before);
  await ready(c);
  t.regex(await execute(c, ']box ?'), /Box ON -style=min/);
  await c.switchToWindow(second);
  t.regex(await execute(c, ']box ?'), /Box OFF/);
});
