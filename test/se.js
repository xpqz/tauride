const { Key } = require('webdriverio');
const test = require('ava');
const { sessionLastLines, inWin, tfw, keys } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

async function waitForLines(c, expected) {
  await c.waitUntil(async () => JSON.stringify(await c.execute(sessionLastLines, expected.length)) === JSON.stringify(expected), {
    timeout: 10000, timeoutMsg: `Session did not produce ${JSON.stringify(expected)}`,
  });
}

async function waitForPrompt(c) {
  await c.waitUntil(async () => c.execute(() => D.ide.wins[0].promptType === 1), { timeout: 10000 });
}


test(
  'se-simple-expression',
  async (t) => {
    const { app } = t.context;
    const c = app.client;

    await keys(c, '1 2 3+4 5 6');
    await waitForLines(c, ['      1 2 3+4 5 6']);
    let r = await c.execute(sessionLastLines, 1);
    t.is(r[0], '      1 2 3+4 5 6');
    await keys(c, Key.Enter);
    await waitForLines(c, ['      1 2 3+4 5 6', '5 7 9', '      ']);
    r = await c.execute(sessionLastLines, 3);
    t.deepEqual(r, [
      '      1 2 3+4 5 6',
      '5 7 9',
      '      ',
    ]);
  },
);

test(
  'se-prefix-completion',
  async (t) => {
    const { app } = t.context;
    const c = app.client;
    let r;

    await c.execute(() => { D.prf.prefixKey('<'); });
    await keys(c, '<a');
    await keys(c, '<s');
    await keys(c, '<d');
    await keys(c, '<w');
    await waitForLines(c, ['      ⍺⌈⌊⍵']);
    r = await c.execute(sessionLastLines, 1);
    t.is(r[0], '      ⍺⌈⌊⍵');
    await c.execute(inWin, 0, '<QT>');
    await keys(c, '<');
    await keys(c, Key.Shift, 'p');
    await keys(c, '<');
    await keys(c, Key.Shift, 'o');
    await waitForLines(c, ['      ⍣⍥']);
    r = await c.execute(sessionLastLines, 1);
    t.is(r[0], '      ⍣⍥');
  },
);


test(
  'se-type-ahead',
  async (t) => {
    const { app } = t.context;
    const c = app.client;

    await c.execute(() => { D.prf.prefixKey('<'); });
    await keys(c, '<l');
    await keys(c, 'DL 1', Key.Enter);
    await c.waitUntil(async () => c.execute(() => D.ide.wins[0].promptType === 0), { timeout: 10000, timeoutMsg: 'Interpreter did not enter the delay' });
    await keys(c, '<i');
    await keys(c, '6', Key.Enter);
    await waitForLines(c, ['      ⍳6', '1 2 3 4 5 6', '      ']);
    const r = await c.execute(sessionLastLines, 3);
    t.deepEqual(r, [
      '      ⍳6',
      '1 2 3 4 5 6',
      '      ',
    ]);
  },
);

test(
  'se-quad-output-while-tracing',
  async (t) => {
    const { app } = t.context;
    const c = app.client;
    let r;

    await c.execute(() => { D.prf.prefixKey('<'); });
    await keys(c, '<l');
    await keys(c, "FX 'f' '<l");
    await keys(c, '<[');
    await keys(c, "''hello'''", Key.Enter);
    await waitForPrompt(c);
    await keys(c, 'f', Key.Enter);
    await waitForLines(c, ['      f', 'hello', '      ']);
    r = await c.execute(sessionLastLines, 3);
    t.deepEqual(r, [
      '      f',
      'hello',
      '      ',
    ]);

    await keys(c, 'f');
    await keys(c, Key.Control, Key.Enter);
    const edit_trace = await c.$('#ide .ride_win.edit_trace');
    await edit_trace.waitForExist();
    await keys(c, Key.Control, Key.Enter);
    await keys(c, Key.Enter);
    await edit_trace.waitForExist({ reverse: true });
    await waitForLines(c, ['      f', 'hello', '      ']);
    r = await c.execute(sessionLastLines, 3);
    t.deepEqual(r, [
      '      f',
      'hello',
      '      ',
    ]);
  },
);
