const test = require('ava');
const { tfw } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

async function rendered(c, text, colour, id = 13101) {
  try {
    await c.waitUntil(() => c.execute((value, expected, token) => {
      const spans = [...D.ide.wins[token].me.getDomNode().querySelectorAll('.view-line span')];
      return spans.some(span => span.textContent.replace(/\u00a0/g, ' ') === value && span.getBoundingClientRect().width
        && getComputedStyle(span).color === expected);
    }, text, colour, id), { timeout: 10000, timeoutMsg: `${text} did not render in ${colour}` });
  } catch (error) {
    const state = await c.execute(token => {
      const me = D.ide.wins[token].me;
      return { lines: me.getModel().getLinesContent(),
        tokens: monaco.editor.tokenize(me.getValue(), me.getModel().getLanguageId()),
        rendered: [...me.getDomNode().querySelectorAll('.view-line span')]
          .map(span => [span.textContent, span.className, getComputedStyle(span).color, span.getBoundingClientRect().width]) };
    }, id);
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
}

for (const [language, name] of [['apl', 'multilineSyntax'], ['aplan', 'multilineSyntax.aplf']]) {
  test(`${language} repaints downstream tokens when a multiline delimiter is edited`, async (t) => {
    const c = t.context.app.client;
    await c.execute((editorName) => {
      D.prf.floating(0);
      D.prf.indentOnOpen(0);
      monaco.editor.defineTheme('multilineSyntaxTest', { base: 'vs', inherit: false,
        rules: [
          { token: 'delimiter.aplan', foreground: '2040D0' },
          { token: 'invalid.parenthesis', foreground: 'D02030' },
          { token: 'comment', foreground: '208030' },
          { token: 'string', foreground: '9030A0' },
        ], colors: {} });
      monaco.editor.setTheme('multilineSyntaxTest');
      D.ide.handlers.OpenWindow({ token: 13101, debugger: false, name: editorName,
        text: ['∇ f', 'data←(', 'key:42', ')', "'literal'", '⍝ comment', '∇'], entityType: 1,
        currentRow: 0, stop: [], trace: [], monitor: [] });
    }, name);
    await c.waitUntil(() => c.execute(() => !!D.ide.wins[13101]?.me?.getModel()
      && !D.ide.wins[13101].firstOpen), { timeout: 10000 });
    await c.execute((lang) => {
      monaco.editor.setModelLanguage(D.ide.wins[13101].me.getModel(), lang);
      D.ide.wins[13101].focus();
      D.ide.wins[13101].me.layout({ width: 700, height: 300 });
    }, language);
    t.deepEqual(await c.execute(() => [D.ide.wins[0], D.ide.wins[13101]]
      .map(win => win.me.getModel().getOptions().bracketPairColorizationOptions.enabled)), [false, false]);
    await rendered(c, ')', 'rgb(32, 64, 208)');
    await rendered(c, "'literal'", 'rgb(144, 48, 160)');
    await rendered(c, '⍝ comment', 'rgb(32, 128, 48)');
    await c.execute(() => D.ide.wins[13101].me.executeEdits('test', [
      { range: new monaco.Range(2, 6, 2, 7), text: '[' },
    ]));
    await rendered(c, ')', 'rgb(208, 32, 48)');
    await c.execute(() => D.ide.wins[13101].me.trigger('keyboard', 'undo'));
    await rendered(c, ')', 'rgb(32, 64, 208)');
    t.is(await c.execute(() => D.ide.wins[13101].me.getModel().getLineContent(2)), 'data←(');
  });
}

test('embedded LF and CR remain visible source markers and refuse typing without adding rows', async (t) => {
  const c = t.context.app.client;
  await c.execute(() => { D.prf.floating(0); D.prf.ilf(0); D.prf.indentOnOpen(0); });
  const cases = [
    { token: 13102, text: ['first', 'a\n\nb\r\rc\r\nd', '', 'last'],
      expected: ['first', 'a␤␤b␍␍c␍␤d', '', 'last'], readonly: true },
    { token: 13103, text: ['r←ordinary', 'r←1', '', '⍝ ordinary'],
      expected: ['Zr←ordinary', 'r←1', '', '⍝ ordinary'], readonly: false },
  ];
  for (const fixture of cases) {
    await c.execute(x => D.ide.handlers.OpenWindow({ token: x.token, debugger: false,
      name: `sourceMarkers${x.token}`, text: x.text, entityType: 1,
      currentRow: 0, stop: [], trace: [], monitor: [] }), fixture);
    await c.waitUntil(() => c.execute(id => !!D.ide.wins[id]?.me?.getModel()
      && !D.ide.wins[id].firstOpen, fixture.token), { timeout: 10000 });
    const state = await c.execute(id => {
      const ed = D.ide.wins[id]; const me = ed.me; const model = me.getModel();
      ed.focus(); me.setPosition({ lineNumber: 1, column: 1 });
      let rejected = 0;
      const listener = me.onDidAttemptReadOnlyEdit(() => { rejected += 1; });
      const before = model.getValue();
      me.trigger('keyboard', 'type', { text: 'Z' });
      listener.dispose();
      return { lines: model.getLinesContent(), lineCount: model.getLineCount(),
        readonly: me.getOption(monaco.editor.EditorOption.readOnly), embedded: ed.hasEmbeddedBreaks,
        rejected, unchanged: before === model.getValue() };
    }, fixture.token);
    t.deepEqual(state, { lines: fixture.expected, lineCount: fixture.text.length,
      readonly: fixture.readonly, embedded: fixture.readonly,
      rejected: +fixture.readonly, unchanged: fixture.readonly });
  }
});

test('tradfn locals and dfn arguments repaint when the active theme changes', async (t) => {
  const c = t.context.app.client;
  await c.execute(() => {
    D.prf.floating(0); D.prf.indentOnOpen(0);
    D.ide.handlers.OpenWindow({ token: 13101, debugger: false, name: 'syntaxScopes',
      text: ['r←colourFn x;local', 'local←x', 'r←{⍵+local}x'], entityType: 1,
      currentRow: 0, stop: [], trace: [], monitor: [] });
  });
  await c.waitUntil(() => c.execute(() => !!D.ide.wins[13101]?.me?.getModel()
    && !D.ide.wins[13101].firstOpen), { timeout: 10000 });
  for (const [name, local, dfn] of [['scopeLight', '208030', '9030A0'], ['scopeChanged', 'D02030', '2040D0']]) {
    await c.execute((theme, localColour, dfnColour) => {
      monaco.editor.defineTheme(theme, { base: 'vs', inherit: false, rules: [
        { token: 'identifier.local', foreground: localColour },
        { token: 'identifier.dfn.1', foreground: dfnColour },
      ], colors: {} });
      monaco.editor.setTheme(theme);
      D.ide.wins[13101].focus();
      D.ide.wins[13101].me.layout({ width: 700, height: 300 });
    }, name, local, dfn);
    const rgb = hex => `rgb(${hex.match(/../g).map(value => parseInt(value, 16)).join(', ')})`;
    await rendered(c, 'local', rgb(local));
    await c.waitUntil(() => c.execute(expected => [...D.ide.wins[13101].me.getDomNode()
      .querySelectorAll('.view-line span')].some(span => span.textContent.includes('⍵')
        && span.getBoundingClientRect().width && getComputedStyle(span).color === expected), rgb(dfn)),
    { timeout: 10000, timeoutMsg: `Dfn argument did not repaint in ${name}` });
  }
  t.is(await c.execute(() => D.ide.wins[13101].me.getModel().getLineContent(3)), 'r←{⍵+local}x');
});

test('indentation preferences preserve syntax colours in Session and normal and file editors', async (t) => {
  const c = t.context.app.client;
  await c.execute(() => {
    D.prf.floating(0); D.prf.indentOnOpen(0); D.prf.indent(4);
  });
  for (const [token, name] of [[13101, 'indentSyntax'], [13104, 'indentSyntax.aplf']]) {
    await c.execute((id, editorName) => D.ide.handlers.OpenWindow({ token: id, debugger: false, name: editorName,
      text: ['r←f', 'r←(1)'], entityType: 1,
      currentRow: 0, stop: [], trace: [], monitor: [] }), token, name);
    await c.waitUntil(() => c.execute(id => !!D.ide.wins[id]?.me?.getModel()
      && !D.ide.wins[id].firstOpen, token), { timeout: 10000 });
  }
  await c.execute(() => {
    D.ide.wins[0].focus();
    D.ide.wins[0].me.trigger('keyboard', 'type', { text: '(1)' });
    monaco.editor.defineTheme('indentSyntaxTest', { base: 'vs', inherit: false,
      rules: [{ token: 'delimiter.parenthesis', foreground: '2040D0' }], colors: {} });
    monaco.editor.setTheme('indentSyntaxTest');
  });
  for (const indent of [4, 2, 6]) {
    await c.execute(value => D.prf.indent(value), indent);
    t.deepEqual(await c.execute(() => [0, 13101, 13104].map(id =>
      D.ide.wins[id].me.getModel().getOptions().bracketPairColorizationOptions.enabled)),
    [false, false, false], `indent ${indent} retains model configuration`);
    for (const id of [0, 13101, 13104]) {
      await c.execute(token => {
        D.ide.wins[token].focus();
        D.ide.wins[token].me.layout({ width: 700, height: 300 });
      }, id);
      await rendered(c, ')', 'rgb(32, 64, 208)', id);
    }
  }
});
