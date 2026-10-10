const test = require('ava');
const { tfw } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

async function display(c) {
  return c.execute(() => ({
    text: document.getElementById('sb_input_state')?.textContent || '',
    prompt: D.ide.wins[0].promptType,
    readOnly: D.ide.wins[0].me.getOption(monaco.editor.EditorOption.readOnly),
    iconVisible: !!document.getElementById('sb_busy_icon')
      && getComputedStyle(document.getElementById('sb_busy_icon')).display !== 'none',
  }));
}

async function waitPrompt(c, type) {
  await c.waitUntil(async () => c.execute(expected => D.ide.wins[0].promptType === expected, type),
    { timeout: 10000, timeoutMsg: `Interpreter did not enter prompt mode ${type}` });
}

async function execute(c, text) { await c.execute(expression => D.ide.exec([expression], 0), text); }

test('input-state-real-interpreter-busy-ready-text-expression-and-multiline', async (t) => {
  const c = t.context.app.client;
  t.is((await display(c)).text, 'Ready');
  t.false((await display(c)).readOnly);
  await execute(c, '⎕DL 1');
  await waitPrompt(c, 0);
  t.deepEqual(await display(c), { text: 'Busy', prompt: 0, readOnly: true, iconVisible: true });
  await waitPrompt(c, 1);
  t.is((await display(c)).text, 'Ready');
  await execute(c, 'auditInputText←⍞');
  await waitPrompt(c, 4);
  t.deepEqual(await display(c), { text: 'Enter text (⍞)', prompt: 4, readOnly: false, iconVisible: false });
  await execute(c, 'hello from input state test');
  await waitPrompt(c, 1);
  await execute(c, 'auditInputValue←⎕');
  await waitPrompt(c, 2);
  t.is((await display(c)).text, 'Enter expression (⎕)');
  t.false((await display(c)).readOnly);
  await execute(c, '2+2');
  await waitPrompt(c, 1);
  await execute(c, '∇ auditInputFunction');
  await waitPrompt(c, 3);
  t.is((await display(c)).text, 'Multiline input');
  t.false((await display(c)).readOnly);
  await c.execute(() => D.commands.EMI(D.ide.wins[0].me));
  await waitPrompt(c, 1);
  t.is((await display(c)).text, 'Ready');
});

test('input-state-accessible-current-while-hidden-narrow-layout-and-disconnection', async (t) => {
  const c = t.context.app.client;
  t.is((await display(c)).text, 'Ready');
  t.deepEqual(await c.execute(() => {
    const state = document.getElementById('sb_busy');
    const icon = document.getElementById('sb_busy_icon');
    return { role: state.getAttribute('role'), live: state.getAttribute('aria-live'),
      atomic: state.getAttribute('aria-atomic'), decorative: icon.getAttribute('aria-hidden') };
  }), { role: 'status', live: 'polite', atomic: 'true', decorative: 'true' });
  await c.execute(() => D.prf.sbar(0));
  await execute(c, 'auditHiddenInput←⎕');
  await waitPrompt(c, 2);
  t.is((await display(c)).text, 'Enter expression (⎕)');
  t.true(await c.execute(() => I.sb.hidden));
  await c.execute(() => D.prf.sbar(1));
  await c.setWindowSize(320, 600);
  await c.execute(() => D.prf.zoom(8));
  await c.waitUntil(async () => c.execute(() => {
    const bar = I.sb.getBoundingClientRect();
    const state = I.sb_busy.getBoundingClientRect();
    const label = document.getElementById('sb_input_state').getBoundingClientRect();
    return bar.width <= 321 && label.left >= bar.left && label.right <= bar.right + 1
      && state.width > 0 && state.left >= bar.left && state.right <= bar.right + 1
      && state.bottom <= bar.bottom + 1 && state.height <= bar.height + 1;
  }), { timeout: 3000, timeoutMsg: 'Input label overflowed the narrow zoomed status bar' });
  t.is((await display(c)).text, 'Enter expression (⎕)');
  t.is(await c.execute(() => I.sb_busy.title), 'Enter expression (⎕)');
  await execute(c, '2+2');
  await waitPrompt(c, 1);
  await c.execute(() => D.ide.handlers.SetPromptType({ type: 5 }));
  t.is((await display(c)).text, 'Awaiting input');
  await c.execute(() => D.ide.handlers.SetPromptType({ type: 99 }));
  t.is((await display(c)).text, 'Input status unknown');
  await c.execute(() => D.ide.handlers.UnknownCommand({ name: 'Subscribe' }));
  t.is((await display(c)).text, 'Input status unknown');
  await c.execute(() => {
    D.ide.die();
    D.ide.handlers.SetPromptType({ type: 1 });
    D.ide.handlers.Identify({ arch: 'U/64', apiVersion: 0, version: '20.0' });
  });
  t.is((await display(c)).text, 'Disconnected');
  t.false((await display(c)).iconVisible);
});
