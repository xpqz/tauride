const test = require('ava');
const { tfw } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

async function nativeTitle(app, label) {
  const window = (await app.getWindowState()).find(w => w.label === label);
  if (!window) throw new Error(`Missing native window ${label}`);
  return window.title;
}

test('thread-caption-real-status-reaches-hidden-bar-title-and-native-window', async (t) => {
  const { app } = t.context;
  const c = app.client;
  await c.execute(() => {
    window.threadCaptionStatuses = [];
    window.threadCaptionSubscriptions = [];
    const onStatus = D.ide.handlers.InterpreterStatus;
    D.ide.handlers.InterpreterStatus = (status) => {
      window.threadCaptionStatuses.push(status);
      return onStatus(status);
    };
    const send = D.send;
    D.send = (name, payload) => {
      if (name === 'Subscribe') window.threadCaptionSubscriptions.push(payload);
      return send(name, payload);
    };
    D.prf.title('thread {TiD}');
    D.prf.sbar(0);
  });
  await c.waitUntil(async () => c.execute(() =>
    window.threadCaptionSubscriptions.some(x => x.status.includes('statusfields'))),
  { timeout: 10000, timeoutMsg: 'Caption-only status subscription was not sent' });
  await c.execute(() => D.ide.exec(["⎕FX'R←FOO' 'R←10' ⋄ 1 ⎕STOP 'FOO' ⋄ {FOO}&0"], 0));
  await c.waitUntil(async () => c.execute(() =>
    window.threadCaptionStatuses.some(x => x.TID === 1)),
  { timeout: 10000, timeoutMsg: 'Stopped worker did not report real thread 1' });
  const expected = 'thread 1';
  await c.waitUntil(async () => c.execute(title => I.sb.hidden && document.title === title, expected),
    { timeout: 10000, timeoutMsg: 'Hidden status bar caption did not show the live thread' });
  await c.waitUntil(async () => (await nativeTitle(app, 'main')) === expected,
    { timeout: 10000, timeoutMsg: 'Native main-window title did not show the live thread' });
  t.is(await nativeTitle(app, 'main'), expected);

  await c.execute(() => D.prf.title('plain title'));
  await c.waitUntil(async () => c.execute(() =>
    window.threadCaptionSubscriptions.at(-1)?.status.includes('statusfields') === false),
  { timeout: 10000, timeoutMsg: 'Caption-only status subscription was not released' });
  t.is(await c.execute(() => document.title), 'plain title');
  t.is(await c.execute(() => {
    D.ide.handlers.InterpreterStatus({ TID: 99 }); // late status from the old subscription
    D.prf.title('thread {TID}');
    return document.title;
  }), 'thread ?');
});

test('title status subscription reaches the interpreter while a command is busy', async (t) => {
  const { app } = t.context;
  const c = app.client;
  await c.execute(() => {
    window.threadCaptionWire = () => nodeRequire(`${__dirname}/src/cn`).getLog().flatMap((line) => {
      const sent = / send (\[.*\])$/.exec(line || '');
      if (!sent) return [];
      try {
        const [name, payload] = JSON.parse(sent[1]);
        return name === 'Subscribe' ? [payload.status] : [];
      } catch (_) { return []; }
    });
    window.threadCaptionEmptyBefore = window.threadCaptionWire().filter(x => x.length === 0).length;
    D.prf.title('plain title');
    D.prf.sbar(0);
  });
  await c.waitUntil(async () => c.execute(() => D.ide.threadId === undefined
    && window.threadCaptionWire().filter(x => x.length === 0).length > window.threadCaptionEmptyBefore),
  { timeout: 10000, timeoutMsg: 'Hiding the bar did not unsubscribe statusfields' });

  await c.execute(() => D.ide.exec(['⎕DL 8'], 0));
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 0),
    { timeout: 10000, timeoutMsg: 'Interpreter did not enter busy state' });
  await c.execute(() => {
    window.threadCaptionFieldsBefore = window.threadCaptionWire().filter(x => x.includes('statusfields')).length;
    D.prf.title('TID={TID}');
  });
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 0
    && window.threadCaptionWire().filter(x => x.includes('statusfields')).length > window.threadCaptionFieldsBefore),
  { timeout: 5000, timeoutMsg: 'Busy interpreter did not receive title status subscription' });

  await c.execute(() => {
    window.threadCaptionEmptyBefore = window.threadCaptionWire().filter(x => x.length === 0).length;
    D.prf.title('plain title');
  });
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 0
    && window.threadCaptionWire().filter(x => x.length === 0).length > window.threadCaptionEmptyBefore),
  { timeout: 5000, timeoutMsg: 'Busy interpreter did not receive title status unsubscribe' });
  await c.execute(() => D.prf.title('TID={TID}'));
  await c.waitUntil(async () => c.execute(() => D.ide.promptType === 1),
    { timeout: 10000, timeoutMsg: 'Interpreter did not become ready again' });
  await c.execute(() => D.ide.exec(["⎕FX'R←FOO' 'R←10' ⋄ 1 ⎕STOP 'FOO' ⋄ {FOO}&0"], 0));
  await c.waitUntil(async () => c.execute(() => document.title === 'TID=1'),
    { timeout: 10000, timeoutMsg: 'Busy title subscription did not receive the next real thread status' });
  await c.waitUntil(async () => (await nativeTitle(app, 'main')) === 'TID=1',
    { timeout: 10000, timeoutMsg: 'Native title did not update after busy subscription' });
  t.is(await nativeTitle(app, 'main'), 'TID=1');
});

test('floating editor title tracks the session thread and retains its own identity', async (t) => {
  const { app } = t.context;
  const c = app.client;
  const main = await c.getWindowHandle();
  await c.execute(() => {
    D.prf.indentOnOpen(0);
    D.prf.title('TID={TID}');
    D.prf.floating(1);
    D.prf.floatSingle(0);
    D.ide.handlers.OpenWindow({ token: 46001, debugger: false,
      name: 'threadSource', filename: 'threadSource.apl',
      text: ['r←threadSource', 'r←1'], entityType: 1, currentRow: 0,
      stop: [], trace: [], monitor: [] });
  });
  let floating;
  await c.waitUntil(async () => {
    for (const handle of await c.getWindowHandles()) {
      if (handle === main) continue;
      await c.switchToWindow(handle);
      const ready = await c.execute(() => {
        const ed = typeof D !== 'undefined' && D.ide && D.ide.wins[46001];
        return !!(ed && ed.container && !ed.firstOpen && ed.me && ed.me.getModel()
          && ed.me.getModel().getLineCount() === 2);
      });
      if (ready) { floating = handle; return true; }
    }
    return false;
  }, { timeout: 10000, timeoutMsg: 'Floating editor did not initialize' });
  const label = await c.execute(() => window.__TAURI__.webviewWindow.getCurrentWebviewWindow().label);
  await c.waitUntil(async () => c.execute(() =>
    document.title.includes('threadSource') && document.title.includes('threadSource.apl')
      && document.title.endsWith('TID=0')),
  { timeout: 10000, timeoutMsg: 'New floating editor did not inherit the session thread' });
  await c.execute(() => D.ide.wins[46001].me.getModel().setValue('r←threadSource\nr←2'));
  await c.waitUntil(async () => c.execute(() => document.title.startsWith('⬤ ')),
    { timeout: 10000, timeoutMsg: 'Modified editor marker did not appear' });
  const before = await c.execute(() => document.title);
  await c.switchToWindow(main);
  await c.execute(() => D.ide.exec(["⎕FX'R←FOO' 'R←10' ⋄ 1 ⎕STOP 'FOO' ⋄ {FOO}&0"], 0));
  await c.waitUntil(async () => c.execute(() => D.ide.threadId === 1),
    { timeout: 10000, timeoutMsg: 'Stopped worker did not become the session thread' });
  await c.switchToWindow(floating);
  await c.waitUntil(async () => c.execute(() => document.title.endsWith('TID=1')),
    { timeout: 10000, timeoutMsg: 'Floating editor title did not follow the session thread' });
  const after = await c.execute(() => document.title);
  t.is(after, before.replace(/TID=0$/, 'TID=1'));
  await c.waitUntil(async () => (await nativeTitle(app, label)) === after,
    { timeout: 10000, timeoutMsg: 'Native floating-window title did not update' });
  t.is(await nativeTitle(app, label), after);
});
