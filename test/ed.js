const { Key } = require('webdriverio');
const test = require('ava');
const { sessionLastLines, tfw, keys, readClipboard } = require('./_utils');

tfw.init({ src: 'ed', interpreter: true });

async function waitForEditor(c) {
  await c.waitUntil(async () => c.execute(() => Object.values(D.ide.wins).some(w => w !== D.ide.wins[0] && !w.firstOpen && w.me && w.me.getModel() && w.me.getLayoutInfo().width > 0 && w.me.hasTextFocus() && w.dom.contains(document.activeElement) && D.ide.focusedWin === w)), {
    timeout: 10000, timeoutMsg: 'Editor did not become ready',
  });
}

async function waitForPrompt(c) {
  await c.waitUntil(async () => c.execute(() => D.ide.wins[0].promptType === 1 && D.ide.wins[0].me.hasTextFocus() && D.ide.wins[0].dom.contains(document.activeElement)), { timeout: 10000 });
}

async function executeExpression(c, expression) {
  await keys(c, expression);
  await c.waitUntil(async () => (await c.execute(sessionLastLines, 1))[0] === `      ${expression}`, { timeout: 10000 });
  const lines = await c.execute(() => D.ide.wins[0].me.getModel().getLineCount());
  await keys(c, Key.Enter);
  await c.waitUntil(async () => c.execute((before) => {
    const session = D.ide.wins[0];
    return session.promptType === 1 && session.me.getModel().getLineCount() > before;
  }, lines), { timeout: 10000, timeoutMsg: 'Interpreter did not finish the expression' });
}

async function copiedText(c, expected, suffix = false) {
  let text;
  try {
    await c.waitUntil(async () => {
      text = await readClipboard();
      return suffix ? text.endsWith(expected) : text === expected;
    }, { timeout: 10000, timeoutMsg: 'Native clipboard did not receive the copied text' });
  } catch (error) {
    error.message += `; expected${suffix ? ' suffix' : ''} ${JSON.stringify(expected)}, actual ${JSON.stringify(text)}`;
    throw error;
  }
  return text;
}


test(
  'ed-uses-os-eol',
  async (t) => {
    const { app } = t.context;
    const c = app.client;
    let text;

    await c.execute(() => {
      D.prf.prefixKey('<');
      D.prf.ilf(0);
      D.prf.ime(0);
      D.prf.indent(-1);
      D.prf.indentOnOpen(0);
    });
    const [mac, win] = (await c.execute(() => [D.mac, D.win]));
    const eol = win ? '\r\n' : '\n';
    const cc = mac ? Key.Command : Key.Control;

    await keys(c, ')ED <]');
    await keys(c, ' ls', Key.Enter);

    const edit_trace = await c.$('#ide .ride_win.edit_trace');
    await edit_trace.waitForExist();
    await waitForEditor(c);

    await keys(c, 'A', Key.Enter, 'A');
    await keys(c, cc, 'a');
    await keys(c, cc, 'c');
    await keys(c, Key.Escape);
    text = await copiedText(c, `A${eol}A`);
    t.is(text, `A${eol}A`);

    await edit_trace.waitForExist({ reverse: true });
    await waitForPrompt(c);

    const ride_win = await c.$('#ide .ride_win');
    await ride_win.waitForExist();

    await keys(c, ')ED f', Key.Enter);
    await edit_trace.waitForExist();
    await waitForEditor(c);

    await keys(c, Key.Enter, '2');
    await keys(c, cc, 'a');
    await keys(c, cc, 'c');
    await keys(c, Key.Escape);
    text = await copiedText(c, `f${eol}2`);
    t.is(text, `f${eol}2`);

    await edit_trace.waitForExist({ reverse: true });
    await waitForPrompt(c);

    await keys(c, ')ED f', Key.Enter);

    await edit_trace.waitForExist();
    await waitForEditor(c);
    const reopenedLines = await c.execute(() => Object.values(D.ide.wins)
      .find(w => w.name === 'f' && w.me).me.getModel().getLinesContent());
    t.deepEqual(reopenedLines.map(line => line.trimStart()), ['f', '2']);
    const reopenedText = reopenedLines.join(eol);
    const clipboardSentinel = 'before reopened f copy';
    await c.execute(value => navigator.clipboard.writeText(value), clipboardSentinel);
    await copiedText(c, clipboardSentinel);

    await keys(c, cc, 'a');
    await keys(c, cc, 'c');
    await keys(c, Key.Escape);
    text = await copiedText(c, reopenedText);
    t.is(text, reopenedText);
  },
);

test(
  'ed-commands-via-pfkeys',
  async (t) => {
    const { app } = t.context;
    const c = app.client;
    const mac = (await c.execute(() => {
      const pf = D.prf.pfkeys();
      pf[2] = '<AO>';
      D.prf.pfkeys(pf);
      return D.mac;
    }));
    const cc = mac ? Key.Command : Key.Control;
    let text;

    await keys(c, ')ED f', Key.Enter);

    const edit_trace = await c.$('#ide .ride_win.edit_trace');
    await edit_trace.waitForExist();
    await waitForEditor(c);
    await keys(c, Key.Enter, 'ab');
    await keys(c, Key.F2);
    await keys(c, cc, 'a');
    await keys(c, cc, 'c');
    await keys(c, Key.Escape);
    text = await copiedText(c, '⍝  ab', true);
    t.is(text.slice(-5), '⍝  ab');

    await edit_trace.waitForExist({ reverse: true });
    await waitForPrompt(c);
    await c.execute(() => { D.prf.floating(1) });
    const main = await c.getWindowHandle();
    await keys(c, ')ED g', Key.Enter);
    // Find g in the reused pool webview; the newest handle is its empty replacement.
    await c.waitUntil(async () => {
      for (const handle of await c.getWindowHandles()) {
        if (handle === main) continue;
        await c.switchToWindow(handle);
        const ready = await c.execute(() => typeof D !== 'undefined' && D.ide
          && Object.values(D.ide.wins).some(w => w !== D.ide.wins[0]
            && w.name === 'g' && w.me && w.me.getModel()
            && w.me.getModel().getLineContent(1).trim() === 'g'));
        if (ready) return true;
      }
      return false;
    }, { timeout: 10000, timeoutMsg: 'Floating g editor did not initialize' });
    await waitForEditor(c);
    await keys(c, Key.Enter, 'cd', Key.F2);
    await keys(c, cc, 'a');
    await keys(c, cc, 'c');
    await keys(c, Key.Escape);
    text = await copiedText(c, '⍝  cd', true);
    t.is(text.slice(-5), '⍝  cd');
  },
);

test(
  'ed-set-stops-in-traced-script',
  async (t) => {
    const { app } = t.context;
    const c = app.client;

    await c.execute(() => {
      D.prf.ilf(0);
      D.prf.indentOnOpen(0);
      const pf = D.prf.pfkeys();
      pf[2] = '<BP>';
      D.prf.pfkeys(pf);
      return D.mac;
    });

    await executeExpression(c, "⎕FIX ':Namespace Sol' '∇ foo' '⍝' '⍝' '⍝' '⍝' '∇' ':EndNamespace'");
    await waitForPrompt(c);
    await keys(c, 'Sol.foo');
    await keys(c, Key.Control, Key.Enter);

    const edit_trace = await c.$('#ide .ride_win.edit_trace');
    await edit_trace.waitForExist();
    await waitForEditor(c);

    await keys(c, Key.F2);
    await c.waitUntil(async () => c.execute(() => Object.values(D.ide.wins).some(w => w.me && w.me.getModel().getAllDecorations().some(d => d.options.glyphMarginClassName === 'breakpoint'))), { timeout: 10000, timeoutMsg: 'Breakpoint decoration did not appear' });
    await keys(c, Key.Escape);

    const ride_win = await c.$('#ide .ride_win');
    await ride_win.waitForExist();

    await edit_trace.waitForExist({ reverse: true });
    await waitForPrompt(c);
    await keys(c, "⎕STOP 'Sol.foo'", Key.Enter);
    await c.waitUntil(async () => (await c.execute(sessionLastLines, 2))[0] === '1', { timeout: 10000 });
    const r = await c.execute(sessionLastLines, 2);
    t.is(r[0], '1');
  },
);

test(
  'ed-set-stops-in-traced-script-with-ilf',
  async (t) => {
    const { app } = t.context;
    const c = app.client;

    await c.execute(() => {
      D.prf.ilf(1);
      D.prf.indentOnOpen(1);
      const pf = D.prf.pfkeys();
      pf[2] = '<BP>';
      D.prf.pfkeys(pf);
      return D.mac;
    });

    await executeExpression(c, "⎕FIX ':Namespace Sol' '∇ foo' '⍝' '⍝' '⍝' '⍝' '∇' ':EndNamespace'");
    await waitForPrompt(c);
    await keys(c, 'Sol.foo');
    await keys(c, Key.Control, Key.Enter);

    const edit_trace = await c.$('#ide .ride_win.edit_trace');
    await edit_trace.waitForExist();
    await waitForEditor(c);

    await keys(c, Key.F2);
    await c.waitUntil(async () => c.execute(() => Object.values(D.ide.wins).some(w => w.me && w.me.getModel().getAllDecorations().some(d => d.options.glyphMarginClassName === 'breakpoint'))), { timeout: 10000, timeoutMsg: 'Breakpoint decoration did not appear' });
    await keys(c, Key.Escape);

    const ride_win = await c.$('#ide .ride_win');
    await ride_win.waitForExist();

    await edit_trace.waitForExist({ reverse: true });
    await waitForPrompt(c);
    await keys(c, "⎕STOP 'Sol.foo'", Key.Enter);
    await c.waitUntil(async () => (await c.execute(sessionLastLines, 2))[0] === '1', { timeout: 10000 });
    const r = await c.execute(sessionLastLines, 2);
    t.is(r[0], '1');
  },
);
