const test = require('ava');
const { sessionLastLines, inWin, tfw, moveTo } = require('./_utils');

tfw.init({ src: 'lb', interpreter: true });

test(
  'lb-show-hide',
  async (t) => {
    const { app } = t.context;
    const c = app.client;
    
    const lb = await c.$('#lb');
    await lb.waitForExist();
    
    const lbarVisible = await lb.isDisplayed({ withinViewport: true });
    await c.execute(inWin, 0, '<LBR>');
    t.is(await lb.isDisplayed({ withinViewport: true }), !lbarVisible);
    await c.execute(inWin, 0, '<LBR>');
    t.is(await lb.isDisplayed({ withinViewport: true }), lbarVisible);
  },
);

test(
  'lb-hover',
  async (t) => {
    const { app } = t.context;
    const c = app.client;

    const lb = await c.$('#lb');
    await lb.waitForExist();
    
    let lbarVisible = await lb.isDisplayed({ withinViewport: true });
    if (!lbarVisible) {
      await c.execute(inWin, 0, '<LBR>');
      lbarVisible = await lb.isDisplayed({ withinViewport: true });
    }
    const lb_paw = await c.$('b=⍤');
    await moveTo(c, lb_paw);
    const lb_tip_body = await c.$('#lb_tip_body');
    const lb_tip_desc = await c.$('#lb_tip_desc');
    await lb_tip_body.waitForDisplayed();
    t.true(await lb_tip_body.isDisplayed({ withinViewport: true }));
    await c.waitUntil(async () => (await lb_tip_desc.getText()).toUpperCase() === 'JOT DIAERESIS (⍤)',
      { timeout: 10000, timeoutMsg: 'Jot Diaeresis tooltip did not appear' });
    t.is((await lb_tip_desc.getText()).toUpperCase(), 'JOT DIAERESIS (⍤)');
    
    const lb_tip = await c.$('#lb_tip');
    await moveTo(c, lb_tip);
    await lb_tip.waitForDisplayed();
    t.true(await lb_tip.isDisplayed({ withinViewport: true }));
    const lb_nbs = await c.$('b=\xA0');
    await moveTo(c, lb_nbs);
    await lb_tip.waitForDisplayed({ reverse: true });
    t.false(await lb_tip.isDisplayed({ withinViewport: true }));
  },
);

test(
  'lb-click',
  async (t) => {
    const { app } = t.context;
    const c = app.client;

    const lb = await c.$('#lb');
    await lb.waitForExist();
    const lb_power = await c.$('b=⍣');
    await lb_power.click();
    await c.waitUntil(async () => (await c.execute(sessionLastLines, 1))[0].endsWith('⍣'), { timeout: 10000 });
    const r = await c.execute(sessionLastLines, 1);
    t.is(r[0].slice(-1), '⍣');
  },
);
