const test = require('ava');
const { tfw } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

const token = 10301;
const expected = [[1, 10], [2, 7], [3, 6], [4, 6], [8, 10]];

async function foldingState(client) {
  return client.execute(async (id) => {
    const editor = D.ide.wins[id]?.me;
    const controller = editor?.getContribution('editor.contrib.folding');
    const model = await controller?.getFoldingModel();
    if (!model) return [];
    const { regions } = model;
    return Array.from({ length: regions.length }, (_, i) => [
      regions.getStartLineNumber(i), regions.getEndLineNumber(i), regions.isCollapsed(i),
    ]);
  }, token);
}

for (const tracer of [false, true]) test(`Monaco folds nested Select blocks in ${tracer ? 'tracer' : 'editor'}`, async (t) => {
  const c = t.context.app.client;
  await c.execute((id, isTracer) => {
    D.prf.floating(0);
    D.prf.indentOnOpen(0);
    D.prf.fold(1);
    D.ide.handlers.OpenWindow({ token: id, debugger: isTracer, name: 'selectFolding',
      text: [':Select x', ':Case 1', '  :Select y', '  :Case 2', '    a←2',
        '  :EndSelect', '  a←1', ':Else', 'a←0', ':EndSelect'], entityType: 1,
      currentRow: 0, stop: [], trace: [], monitor: [] });
  }, token, tracer);
  await c.waitUntil(async () => c.execute((id) => !!D.ide.wins[id]?.me, token),
    { timeout: 10000, timeoutMsg: 'Select editor did not initialize' });
  await c.execute((id) => D.ide.wins[id].me.layout({ width: 700, height: 400 }), token);
  t.is(await c.execute((id) => !!D.ide.wins[id].tc, token), tracer);
  await c.waitUntil(async () => {
    const ranges = await foldingState(c);
    return JSON.stringify(ranges.map(r => r.slice(0, 2))) === JSON.stringify(expected);
  }, { timeout: 10000, timeoutMsg: 'Monaco did not retain outer and branch Select ranges' });
  t.deepEqual((await foldingState(c)).map(r => r.slice(0, 2)), expected);

  await c.execute(async (id) => {
    const editor = D.ide.wins[id].me;
    editor.setPosition({ lineNumber: 3, column: 1 });
    await editor.getAction('editor.fold').run();
  }, token);
  await c.waitUntil(async () => (await foldingState(c)).find(r => r[0] === 3)?.[2] === true);
  await c.execute(async (id) => {
    const editor = D.ide.wins[id].me;
    editor.setPosition({ lineNumber: 1, column: 1 });
    await editor.getAction('editor.fold').run();
  }, token);
  await c.waitUntil(async () => (await foldingState(c)).find(r => r[0] === 1)?.[2] === true);
  await c.execute(async (id) => {
    const editor = D.ide.wins[id].me;
    editor.setPosition({ lineNumber: 1, column: 1 });
    await editor.getAction('editor.unfold').run();
  }, token);
  await c.waitUntil(async () => {
    const ranges = await foldingState(c);
    return ranges.find(r => r[0] === 1)?.[2] === false && ranges.find(r => r[0] === 3)?.[2] === true;
  }, { timeout: 10000, timeoutMsg: 'Unfolding outer Select lost the inner collapsed state' });

  await c.execute(async (id) => D.ide.wins[id].me.getAction('editor.foldAll').run(), token);
  await c.waitUntil(async () => {
    const ranges = await foldingState(c);
    return ranges.length === expected.length && ranges.every(r => r[2] === true);
  });
  await c.execute(async (id) => D.ide.wins[id].me.getAction('editor.unfoldAll').run(), token);
  await c.waitUntil(async () => {
    const ranges = await foldingState(c);
    return ranges.length === expected.length && ranges.every(r => r[2] === false);
  });

  if (tracer) {
    await c.execute(async (id) => D.ide.wins[id].me.getAction('editor.foldAll').run(), token);
    await c.waitUntil(async () => {
      const ranges = await foldingState(c);
      return ranges.length === expected.length && ranges.every(r => r[2] === true);
    });
    await c.execute((id) => D.ide.handlers.SetHighlightLine({
      win: id, line: 4, end_line: 4, start_col: 0, end_col: 0,
    }), token);
    await c.waitUntil(async () => {
      const ranges = await foldingState(c);
      return [1, 2, 3, 4].every(line => ranges.find(r => r[0] === line)?.[2] === false);
    }, { timeout: 10000, timeoutMsg: 'Trace highlight did not reveal its folded Select ancestors' });
    t.is(await c.execute((id) => D.ide.wins[id].hlDecorations[0].range.startLineNumber, token), 5);
  }
});
