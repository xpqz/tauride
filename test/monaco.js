const test = require('ava');
const { tfw, sessionLastLines } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

test('monaco worker completes a real RPC in the native webview', async (t) => {
  const c = t.context.app.client;
  t.true(await c.execute(async () => {
    const worker = monaco.editor.createWebWorker({ worker: MonacoEnvironment.getWorker('', 'editor') });
    try { return !!await worker.getProxy(); } finally { worker.dispose(); }
  }));
});

test('monaco session executes input and expands APL prefix characters', async (t) => {
  const c = t.context.app.client;
  await c.execute(() => {
    const se = D.ide.wins[0];
    se.me.trigger('keyboard', 'type', { text: '1 2 3+4 5 6' });
    se.ER();
  });
  await c.waitUntil(async () => JSON.stringify(await c.execute(sessionLastLines, 3))
    === JSON.stringify(['      1 2 3+4 5 6', '5 7 9', '      ']));
  await c.execute(() => {
    D.prf.prefixKey('<');
    const me = D.ide.wins[0].me;
    me.trigger('keyboard', 'type', { text: '<' });
    me.trigger('keyboard', 'type', { text: 'a' });
  });
  await c.waitUntil(async () => (await c.execute(sessionLastLines, 1))[0] === '      ⍺');
  t.true(await c.execute(() => D.ide.wins[0].me.getOption(monaco.editor.EditorOption.readOnly) === false));
});

test('monaco colours compact APLAN keys consistently in editors and Session', async (t) => {
  const c = t.context.app.client;
  const expressions = ['x←(a:input ⋄ b:2)', 'x←(a: input ⋄ b:2)'];
  await c.execute((lines) => {
    D.prf.floating(0);
    D.prf.indentOnOpen(0);
    D.prf.autocompletionDelay(10000);
    monaco.editor.defineTheme('aplanKeyTest', { base: 'vs', inherit: false,
      rules: [
        { token: 'identifier.local.aplan', foreground: 'D02030' },
        { token: 'identifier.global', foreground: '2040D0' },
        { token: 'delimiter.aplan', foreground: '707070' },
      ], colors: {} });
    monaco.editor.setTheme('aplanKeyTest');
    D.ide.handlers.OpenWindow({ token: 12901, debugger: false, name: 'aplanKeys',
      text: ['∇ f', ...lines, '∇'], entityType: 1,
      currentRow: 0, stop: [], trace: [], monitor: [] });
  }, expressions);
  await c.waitUntil(async () => c.execute(() => !!D.ide.wins[12901]?.me?.getModel()));
  for (const language of ['apl', 'aplan', 'apl-session']) {
    const id = language === 'apl-session' ? 0 : 12901;
    await c.execute((win, lang, lines) => {
      const w = D.ide.wins[win];
      if (win === 0) w.me.trigger('keyboard', 'type', { text: lines.join(' ⋄ ') });
      else monaco.editor.setModelLanguage(w.me.getModel(), lang);
      w.focus();
      w.me.layout({ width: 700, height: 300 });
    }, id, language, expressions);
    const scopes = await c.execute((win) => {
      const model = D.ide.wins[win].me.getModel();
      const tokens = monaco.editor.tokenize(model.getValue(), model.getLanguageId());
      return model.getLinesContent().flatMap((line, i) =>
        [...line.matchAll(/a: ?input/g)].map((match) => {
          const scopeAt = offset => tokens[i].filter(token => token.offset <= offset).at(-1)?.type;
          return [scopeAt(match.index), scopeAt(match.index + 1), scopeAt(line.indexOf('input', match.index))];
        }));
    }, id);
    t.deepEqual(scopes, Array(2).fill([
      'identifier.local.aplan.apl', 'delimiter.aplan.apl', 'identifier.global.apl',
    ]), language);
    await c.waitUntil(async () => c.execute((win) => {
      const spans = [...D.ide.wins[win].me.getDomNode().querySelectorAll('.view-line span')];
      const keys = spans.filter(span => span.textContent === 'a' && span.getBoundingClientRect().width);
      return keys.length === 2 && keys.every(span => getComputedStyle(span).color === 'rgb(208, 32, 48)');
    }, id), { timeout: 10000, timeoutMsg: `${language} did not render both APLAN keys in the key colour` });
  }
});

test('monaco formats and folds fresh APL models and refreshes live preferences', async (t) => {
  const c = t.context.app.client;
  await c.execute(() => {
    D.prf.floating(0);
    D.prf.indentOnOpen(0);
    D.prf.indent(3);
    D.prf.indentMethods(-1);
    D.prf.fold(1);
    D.ide.handlers.OpenWindow({ token: 57001, debugger: false, name: 'monacoAudit',
      text: [':Class C', '∇ r←f', 'r←1', '∇', ':EndClass'], entityType: 1,
      currentRow: 0, stop: [], trace: [], monitor: [] });
  });
  await c.waitUntil(async () => c.execute(() => !!D.ide.wins[57001]?.me?.getModel()));
  await c.execute(async () => {
    const me = D.ide.wins[57001].me;
    me.layout({ width: 700, height: 300 });
    await me.getAction('editor.action.formatDocument').run();
  });
  t.deepEqual(await c.execute(() => D.ide.wins[57001].me.getModel().getLinesContent()),
    [':Class C', '   ∇ r←f', '      r←1', '   ∇', ':EndClass']);
  await c.execute(async () => {
    D.prf.indentMethods(0);
    await D.ide.wins[57001].me.getAction('editor.action.formatDocument').run();
  });
  t.is(await c.execute(() => D.ide.wins[57001].me.getModel().getLineContent(3)), '   r←1');
  await c.execute(async () => D.ide.wins[57001].me.getAction('editor.foldAll').run());
  await c.waitUntil(async () => c.execute(() =>
    !!D.ide.wins[57001].dom.querySelector('.codicon-folding-collapsed')),
  { timeout: 10000, timeoutMsg: 'Fresh APL model did not produce folding ranges' });
  await c.execute(async () => {
    const ed = D.ide.wins[57001];
    await ed.me.getAction('editor.unfoldAll').run();
    ed.me.getModel().setValue('r←f\nx←1\nr←x');
    ed.me.setPosition({ lineNumber: 2, column: 1 });
    ed.TL(ed.me);
  });
  t.is(await c.execute(() => D.ide.wins[57001].me.getModel().getLineContent(1)), 'r←f;x');
  await c.execute(() => {
    D.prf.autoCloseBrackets(0);
    D.prf.matchBrackets(0);
    D.prf.indent(-1);
  });
  t.deepEqual(await c.execute(() => [D.ide.wins[0], D.ide.wins[57001]].map((win) => {
    const options = win.me.getRawOptions();
    return [options.autoClosingBrackets, options.matchBrackets, options.autoIndent];
  })), [['never', 'never', 'none'], ['never', 'never', 'none']]);
});

test('monaco Find and Replace accept prefix and language-bar glyphs', async (t) => {
  const c = t.context.app.client;
  await c.execute(() => {
    D.prf.prefixKey('<');
    const me = D.ide.wins[0].me;
    me.trigger('keyboard', 'type', { text: '⍺⍵' });
    D.commands.RP(me);
  });
  await (await c.$('.find-widget textarea[aria-label="Find"]')).waitForDisplayed();
  await c.execute(() => {
    const field = document.querySelector('.find-widget textarea[aria-label="Find"]');
    field.focus();
    field.value = '<';
    field.setSelectionRange(1, 1);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a', code: 'KeyA', keyCode: 65, bubbles: true, cancelable: true,
    }));
  });
  await c.waitUntil(async () => c.execute(() => {
    const me = D.ide.wins[0].me;
    return me.getModel().getValueInRange(me.getSelection()) === '⍺';
  }), { timeout: 10000, timeoutMsg: 'APL prefix input did not update Find matches' });
  await c.execute(() => {
    const field = document.querySelector('.find-widget textarea[aria-label="Find"]');
    field.focus();
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    [...I.lb.querySelectorAll('b')].find(item => item.textContent === '⍵').click();
  });
  await c.waitUntil(async () => c.execute(() => {
    const me = D.ide.wins[0].me;
    return me.getModel().getValueInRange(me.getSelection()) === '⍵';
  }), { timeout: 10000, timeoutMsg: 'Language-bar glyph did not update Find matches' });
  await c.execute(() => {
    const field = document.querySelector('.find-widget textarea[aria-label="Replace"]');
    field.focus();
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    [...I.lb.querySelectorAll('b')].find(item => item.textContent === '⍺').click();
    document.querySelector('.find-widget .codicon-find-replace').click();
  });
  await c.waitUntil(async () => (await c.execute(sessionLastLines, 1))[0] === '      ⍺⍺');
  t.is((await c.execute(sessionLastLines, 1))[0], '      ⍺⍺');
});

test('monaco accepts interpreter autocomplete suggestions', async (t) => {
  const c = t.context.app.client;
  await c.execute(() => D.ide.exec(['monacoAlpha←1', 'monacoAlps←2'], 0));
  await c.waitUntil(async () => c.execute(() => D.ide.wins[0].promptType === 1
    && D.ide.wins[0].me.getValue().includes('monacoAlps←2')));
  await c.execute(() => {
    D.prf.autocompletion('classic');
    D.prf.autocompletionDelay(10000);
    const se = D.ide.wins[0];
    se.me.trigger('keyboard', 'type', { text: 'monacoAl' });
    se.indentOrComplete(se.me);
  });
  await c.waitUntil(async () => c.execute(() => [...document.querySelectorAll('.suggest-widget .monaco-list-row')]
    .some(row => /monacoAlpha|monacoAlps/.test(row.textContent))),
  { timeout: 10000, timeoutMsg: 'Interpreter completions did not populate Monaco suggestions' });
  await c.execute(() => D.ide.wins[0].me.trigger('keyboard', 'acceptSelectedSuggestion'));
  await c.waitUntil(async () => ['      monacoAlpha', '      monacoAlps'].includes(
    (await c.execute(sessionLastLines, 1))[0]));
  t.true(['      monacoAlpha', '      monacoAlps'].includes((await c.execute(sessionLastLines, 1))[0]));
});
