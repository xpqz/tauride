const { Key } = require('webdriverio');
const test = require('ava');
const { tfw, keys } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

async function state(c, ids) {
  return c.execute((tokens) => {
    const rect = node => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    return {
      width: innerWidth, height: innerHeight, ide: rect(D.ide.dom),
      editors: tokens.map(id => {
        const w = D.ide.wins[id];
        const node = w.me.getDomNode();
        const selection = w.me.getSelection();
        const info = w.me.getLayoutInfo();
        return { id, text: w.me.getModel().getValue(),
          selection: [selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn],
          parent: rect(node.parentElement), node: rect(node),
          width: info.width, height: info.height };
      }),
    };
  }, ids);
}

async function settled(c, read) {
  let previous;
  let since;
  let result;
  await c.waitUntil(async () => {
    result = await read();
    const serialized = JSON.stringify(result);
    if (serialized !== previous) { previous = serialized; since = Date.now(); }
    return Date.now() - since >= 400;
  }, { timeout: 10000, interval: 100, timeoutMsg: 'Window geometry did not settle after native resize' });
  return result;
}

function fits(t, current) {
  t.true(Math.abs(current.ide.width - current.width) <= 2, 'IDE fills viewport width');
  t.true(current.ide.bottom <= current.height + 2, 'IDE stays inside viewport');
  t.true(current.ide.height > current.height * 0.7, 'IDE uses available viewport height');
  t.true(Math.abs(Math.max(...current.editors.map(e => e.parent.right)) - current.ide.right) <= 5,
    'Editor panes reach the right edge of the IDE without a stale empty column');
  for (const editor of current.editors) {
    t.true(editor.parent.width > 100 && editor.parent.height > 100, `Editor ${editor.id} has usable space`);
    for (const dimension of ['width', 'height']) {
      t.true(Math.abs(editor[dimension] - editor.parent[dimension]) <= 2,
        `Monaco ${editor.id} ${dimension} fits its actual parent`);
      t.true(Math.abs(editor.node[dimension] - editor.parent[dimension]) <= 2,
        `Rendered editor ${editor.id} ${dimension} fills its parent`);
    }
    t.true(editor.parent.x >= -2 && editor.parent.y >= -2
      && editor.parent.right <= current.width + 2 && editor.parent.bottom <= current.height + 2,
    `Editor ${editor.id} stays inside the native viewport`);
  }
}

async function resizeEditors(t, c, ids) {
  const original = await c.getWindowRect();
  const before = await settled(c, () => state(c, ids));
  const preserved = s => s.editors.map(e => ({ id: e.id, text: e.text, selection: e.selection }));
  const sizes = [[640, 480], [1000, 720], [original.width, original.height]];
  const layouts = [];
  for (const [width, height] of sizes) {
    await c.setWindowRect(null, null, width, height);
    const current = await settled(c, () => state(c, ids));
    fits(t, current);
    t.deepEqual(preserved(current), preserved(before), 'Resize preserves model text and selection');
    layouts.push(current);
  }
  t.true(layouts[1].width > layouts[0].width + 150, 'Native viewport grows');
  t.true(layouts[1].height > layouts[0].height + 100, 'Native viewport grows vertically');
  for (let i = 0; i < ids.length; i += 1) {
    t.true(layouts[1].editors[i].width > layouts[0].editors[i].width + 50, 'Editor follows native width growth');
    t.true(layouts[1].editors[i].height > layouts[0].editors[i].height + 100, 'Editor follows native height growth');
  }
  t.is(layouts[2].width, before.width, 'Restored viewport width');
  t.is(layouts[2].height, before.height, 'Restored viewport height');
}

async function openEditor(c, name, floating) {
  const main = await c.getWindowHandle();
  await c.execute((value) => { D.prf.floating(value); D.prf.indentOnOpen(0); }, +floating);
  await keys(c, `)ED ${name}`, Key.Enter);
  let id;
  await c.waitUntil(async () => {
    const handles = floating ? (await c.getWindowHandles()).filter(h => h !== main) : [main];
    for (const handle of handles) {
      await c.switchToWindow(handle);
      id = await c.execute((entity) => {
        const w = D.ide && Object.values(D.ide.wins).find(e => e.name === entity && e.me && !e.firstOpen);
        return w && w.me.getModel() && w.me.hasTextFocus() ? w.id : null;
      }, name);
      if (id != null) return true;
    }
    return false;
  }, { timeout: 10000, timeoutMsg: `${name} editor did not open` });
  await keys(c, Key.Enter, 'resize marker');
  await c.execute((token) => D.ide.wins[token].me.setSelection(new monaco.Selection(2, 1, 2, 5)), id);
  return { main, id };
}

for (const floating of [false, true]) {
  test(`${floating ? 'floating' : 'docked'} editor and session fit native resize and restore`, async t => {
    const c = t.context.app.client;
    const { main, id } = await openEditor(c, 'resizeFixture', floating);
    await resizeEditors(t, c, floating ? [id] : [0, id]);
    await c.execute(token => D.ide.wins[token].focus(), id);
    await keys(c, 'usable');
    t.true(await c.execute(token => D.ide.wins[token].me.getModel().getValue().includes('usable'), id),
      'Native typing still edits the resized editor');
    await keys(c, Key.Escape);
    await c.switchToWindow(main);
    await c.waitUntil(async () => c.execute(() => D.ide.wins[0].promptType === 1 && D.ide.wins[0].me.hasTextFocus()),
      { timeout: 10000, timeoutMsg: 'Session did not regain focus after resized editor closed' });
    await keys(c, '6×7', Key.Enter);
    await c.waitUntil(async () => c.execute(() => D.ide.wins[0].me.getModel().getLinesContent().slice(-4).includes('42')),
      { timeout: 10000, timeoutMsg: 'Resized session did not evaluate input' });
    fits(t, await settled(c, () => state(c, [0])));
  });
}

async function helperState(c, selector, content, buttons) {
  return c.execute((rootSelector, fieldSelector, buttonSelectors) => {
    const rect = node => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const field = document.querySelector(fieldSelector);
    return { width: innerWidth, height: innerHeight, root: rect(document.querySelector(rootSelector)),
      field: rect(field), value: field.value, start: field.selectionStart, end: field.selectionEnd,
      buttons: buttonSelectors.map(s => rect(document.querySelector(s))) };
  }, selector, content, buttons);
}

for (const helper of ['Preferences', 'About']) {
  test(`${helper} content and controls follow native resize`, async t => {
    const c = t.context.app.client;
    const main = await c.getWindowHandle();
    let label;
    if (helper === 'Preferences') {
      await c.execute(() => D.commands.PRF());
      await c.waitUntil(async () => c.execute(() => !!(D.prf_bw && D.prf_bw.socket)), { timeout: 10000 });
      label = await c.execute(() => D.prf_bw.win.label);
    } else {
      const before = await c.getWindowHandles();
      await c.execute(() => D.commands.ABT());
      await c.waitUntil(async () => (await c.getWindowHandles()).length > before.length, { timeout: 10000 });
      label = (await c.getWindowHandles()).find(h => !before.includes(h));
    }
    await c.switchToWindow(label);
    const root = helper === 'Preferences' ? '#prf_dlg' : '#abt';
    const field = helper === 'Preferences' ? '#title_inp' : '#abt_ta';
    const buttons = helper === 'Preferences' ? ['#prf_dlg_ok', '#prf_dlg_cancel'] : ['#abt_copy', '#abt_close'];
    await (await c.$(root)).waitForDisplayed();
    if (helper === 'Preferences') {
      await c.execute(() => document.querySelector('#prf_nav a[href="#title"]')
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
      await (await c.$(field)).waitForDisplayed();
    }
    await c.execute(s => { const f = document.querySelector(s); f.focus(); f.setSelectionRange(1, 4); }, field);
    const read = () => helperState(c, root, field, buttons);
    const original = await c.getWindowRect();
    const before = await settled(c, read);
    const layouts = [];
    const sizes = helper === 'Preferences' ? [[820, 640], [1100, 800]] : [[700, 540], [950, 700]];
    for (const [width, height] of [...sizes, [original.width, original.height]]) {
      await c.setWindowRect(null, null, width, height);
      const current = await settled(c, read);
      t.deepEqual([current.value, current.start, current.end], [before.value, before.start, before.end],
        'Helper retains text and selection');
      t.true(Math.abs(current.root.width - current.width) <= 2 && Math.abs(current.root.height - current.height) <= 2,
        'Helper fills the native viewport');
      for (const r of [current.field, ...current.buttons]) {
        t.true(r.width > 20 && r.height > 10 && r.x >= -2 && r.y >= -2
          && r.right <= current.width + 2 && r.bottom <= current.height + 2,
        'Text and action controls remain usable inside viewport');
      }
      layouts.push(current);
    }
    t.true(layouts[1].width > layouts[0].width + 100 && layouts[1].height > layouts[0].height + 80,
      'Helper native viewport actually resized');
    t.is(layouts[2].width, before.width, 'Helper restores viewport width');
    t.is(layouts[2].height, before.height, 'Helper restores viewport height');
    if (helper === 'About') t.true(layouts[1].field.width > layouts[0].field.width + 100
      && layouts[1].field.height > layouts[0].field.height + 80, 'Diagnostic text expands with viewport');
    await (await c.$(buttons[1])).click();
    if (helper === 'Preferences') await c.waitUntil(async () => c.execute(async () =>
      !(await window.__TAURI__.window.getCurrentWindow().isVisible())), { timeout: 10000 });
    else await c.waitUntil(async () => !(await c.getWindowHandles()).includes(label), { timeout: 10000 });
    await c.switchToWindow(main);
    fits(t, await settled(c, () => state(c, [0])));
  });
}
