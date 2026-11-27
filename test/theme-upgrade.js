const test = require('ava');
const { tfw } = require('./_utils');

// prefs.json from before follow-system existed. The harness's own profile
// ({ sqp: '0' }) is one on Default, which prefs.json stores as no
// colourScheme.
tfw.init((t) => ({
  src: 'se',
  interpreter: true,
  ...(/Nord/.test(t.title) ? { prefs: { sqp: '0', colourScheme: 'Nord' } } : {}),
}));

async function themeState(c) {
  return c.execute(() => ({
    follow: D.prf.colourSchemeFollowSystem(),
    scheme: D.prf.colourScheme(),
    theme: D.theme,
    source: D.el.nativeTheme.themeSource,
  }));
}

test('a profile on Default keeps Default rather than following the system', async t => {
  t.deepEqual(await themeState(t.context.app.client),
    { follow: 0, scheme: 'Default', theme: 'light', source: 'light' });
});

test('a profile that chose Nord keeps it', async t => {
  t.deepEqual(await themeState(t.context.app.client),
    { follow: 0, scheme: 'Nord', theme: 'dark', source: 'dark' });
});
