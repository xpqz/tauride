const test = require('ava');
const { tfw } = require('./_utils');

tfw.init({ src: 'cn' });

async function layout(c) {
  return c.execute(async () => {
    const w = window.__TAURI__.window.getCurrentWindow();
    const size = await w.innerSize();
    return {
      width: size.width, height: size.height,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      fullscreen: await w.isFullscreen(), maximized: await w.isMaximized(),
      expanded: $('#cn_rhs').is(':visible'),
    };
  });
}

async function settledLayout(c, matches = () => true) {
  let previous;
  let stableSince;
  let result;
  await c.waitUntil(async () => {
    result = await layout(c);
    const current = JSON.stringify(result);
    if (current !== previous) {
      previous = current;
      stableSince = Date.now();
    }
    return matches(result) && Date.now() - stableSince >= 400;
  }, { timeout: 10000, interval: 100, timeoutMsg: 'Connection window layout did not settle' });
  return result;
}

async function toggle(c, expanded) {
  await (await c.$('#cn_favs .list_sel .cog')).click();
  return settledLayout(c, result => result.expanded === expanded);
}

test('cn-normal-height-resizes-after-cog-toggles', async t => {
  const c = t.context.app.client;
  await (await c.$('#cn_neu')).click();
  await settledLayout(c);
  for (const expanded of [false, true, false]) {
    const current = await layout(c);
    if (current.expanded !== expanded) await toggle(c, expanded);
    if (process.platform === 'darwin') {
      const main = (await t.context.app.getWindowState()).find(w => w.label === 'main');
      const minimum = main.nativeConstraints.contentMinSize;
      t.is(minimum.height, 400, 'Cog leaves the native minimum content height at 400');
      t.is(minimum.width, expanded ? 885 : 400, 'Cog sets the native minimum content width');
    }
    const rect = await c.getWindowRect();
    await c.setWindowRect(null, null, rect.width, 500);
    const shorter = await settledLayout(c);
    await c.setWindowRect(null, null, rect.width, 650);
    const taller = await settledLayout(c);
    t.true(taller.height > shorter.height + 100, 'Native connection window grows vertically');
    t.true(taller.viewportHeight > shorter.viewportHeight + 100, 'Connection viewport grows vertically');
    await c.setWindowRect(null, null, rect.width, 500);
    const shrunk = await settledLayout(c);
    t.is(shrunk.height, shorter.height, 'Native connection window shrinks back');
    t.is(shrunk.viewportHeight, shorter.viewportHeight, 'Connection viewport shrinks back');
    t.is(shrunk.expanded, expanded);
  }
});

for (const mode of ['fullscreen', 'maximized']) {
  test(`cn-cog-preserves-${mode}-size`, async t => {
    const c = t.context.app.client;
    await (await c.$('#cn_neu')).click();
    const initial = await settledLayout(c);
    if (initial.expanded) await toggle(c, false);
    const normal = await settledLayout(c);
    const expandedNormal = await toggle(c, true);
    t.true(expandedNormal.width > normal.width);
    t.true(expandedNormal.viewportWidth > normal.viewportWidth);
    t.is(expandedNormal.height, normal.height);
    t.is(expandedNormal.viewportHeight, normal.viewportHeight);
    const collapsedNormal = await toggle(c, false);
    for (const dimension of ['width', 'height', 'viewportWidth', 'viewportHeight']) {
      t.is(collapsedNormal[dimension], normal[dimension], `Normal ${dimension} did not restore after collapse`);
    }
    if (mode === 'fullscreen') await c.fullscreenWindow();
    else await c.maximizeWindow();
    const before = await settledLayout(c, result => result[mode]);
    t.true(before[mode]);
    for (const expanded of [true, false, true, false]) {
      const after = await toggle(c, expanded);
      t.is(after.expanded, expanded);
      t.true(after[mode]);
      for (const dimension of ['width', 'height', 'viewportWidth', 'viewportHeight']) {
        t.is(after[dimension], before[dimension], `${mode} ${dimension} changed after the cog toggle`);
      }
    }
    await c.setWindowRect(null, null, 900, 500);
    const restored = await settledLayout(c, result => !result.fullscreen && !result.maximized);
    t.false(restored.fullscreen);
    t.false(restored.maximized);
    t.true((await toggle(c, true)).expanded);
    t.false((await toggle(c, false)).expanded);
  });
}
