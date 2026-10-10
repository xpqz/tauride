const test = require('ava');
const { tfw, resolveDyalog } = require('./_utils');

tfw.init({ src: 'cn' });

async function selectValue(c, selector, value) {
  await c.execute((select, choice) => {
    if (!Array.from(select.options).some(option => option.value === choice)) throw new Error(`Missing connection option: ${choice}`);
    select.value = choice;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, await c.$(selector), value);
}


test(
  'cn-app-starts-ok',
  async (t) => {
    const { app } = t.context;
    const windows = await app.getWindowState();
    const win = windows.find(w => w.label === 'main');
    t.truthy(win);
    t.false(win.minimized);
    t.false(win.devtoolsOpen);
    t.true(win.visible);
    const { width, height } = await app.client.getWindowRect();
    t.true(width > 0);
    t.true(height > 0);
  },
);


test(
  'cn-fav-new',
  async (t) => {
    t.plan(3);
    const { app } = t.context;
    const c = app.client;
    await (await c.$('#cn_neu')).click();

    const fav_name = await c.$('#cn_fav_name');
    const favs = await c.$('#cn_favs .list_sel .name');

    t.is(await fav_name.getValue(), '');
    await favs.waitForExist();
    t.is(await favs.getText(), 'unnamed');
    await fav_name.setValue('myFav');
    t.is(await favs.getText(), 'myFav');
  },
);

test(
  'cn-fav-clone',
  async (t) => {
    t.plan(5);
    const { app } = t.context;
    const c = app.client;

    await (await c.$('#cn_neu')).click();
    await (await c.$('#cn_fav_name')).setValue('myFav');
    const cln = await c.$('#cn_cln');
    await cln.click();

    const fav_name = await c.$('#cn_fav_name');
    let favs = await c.$('#cn_favs .list_sel .name');

    t.is(await fav_name.getValue(), 'myFav (copy)');
    await favs.waitForExist();
    t.is(await favs.getText(), 'myFav (copy)');
    await fav_name.setValue('myCopy');
    t.is(await favs.getText(), 'myCopy');

    await cln.click();
    t.is(await fav_name.getValue(), 'myCopy (copy)');
    favs = await c.$('#cn_favs .list_sel .name');
    await favs.waitForExist();
    t.is(await favs.getText(), 'myCopy (copy)');
  },
);

test(
  'cn-start-raw',
  async (t) => {
    t.plan(3);
    const { app } = t.context;
    const c = app.client;

    const cn_neu = await c.$('#cn_neu');
    await cn_neu.click();

    const cn_type = await c.$('#cn_type');
    await selectValue(c, '#cn_type', 'start');
    t.is(await cn_type.getValue(), 'start');

    const cn_subtype = await c.$('#cn_subtype');
    await selectValue(c, '#cn_subtype', 'raw');
    t.is(await cn_subtype.getValue(), 'raw');

    const executable = resolveDyalog();
    await selectValue(c, '#cn_exes', '');
    await (await c.$('#cn_exe')).setValue(executable);

    const cn_go = await c.$('#cn_go');
    await cn_go.click();

    const ide = await c.$('#ide .lm_tab.lm_active');
    await ide.waitForExist();
    t.is(await ide.getAttribute('title'), 'Session');
  },
);
