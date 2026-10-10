const test = require('ava');
const fs = require('node:fs');
const path = require('node:path');
const { tfw, keys, typeText } = require('./_utils');

tfw.init({ src: 'cn' });

async function assertSaved(t, name) {
  const { app } = t.context;
  const file = path.join(app.userData, 'Ride-4.8', 'connections.json');
  await app.client.waitUntil(() => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).some(connection => connection.name === name); }
    catch (_) { return false; }
  }, { timeout: 5000, timeoutMsg: 'Probe connection name was not saved' });
  t.is(await (await app.client.$('#cn_favs .list_sel .name')).getText(), name);
}

test('ci-input-native', async (t) => {
  const c = t.context.app.client;
  await (await c.$('#cn_neu')).click();
  await c.execute(() => document.getElementById('cn_fav_name').focus());
  await typeText(c, 'nativeProbe');
  await keys(c, '\ue004');
  await assertSaved(t, 'nativeProbe');
});

test('ci-input-deferred-events', async (t) => {
  const c = t.context.app.client;
  await (await c.$('#cn_neu')).click();
  await c.execute(() => {
    setTimeout(() => {
      const field = document.getElementById('cn_fav_name');
      field.value = 'deferredProbe';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }, 0);
  });
  await assertSaved(t, 'deferredProbe');
});
