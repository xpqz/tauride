const test = require('ava');
const { tfw } = require('./_utils');

// A first run: no prefs.json.
tfw.init({ src: 'se', interpreter: true, prefs: null });

// The theme sheet enabled, the native theme source and the theme recorded
// for helper pages, as the main window sees them.
async function themeState(c) {
  return c.execute(() => ({
    dark: !document.getElementById('theme_dark').disabled,
    light: !document.getElementById('theme_light').disabled,
    theme: D.theme,
    source: D.el.nativeTheme.themeSource,
    winstate: D.el.getGlobal('winstate').theme,
    systemDark: D.el.nativeTheme.shouldUseDarkColors,
    osDark: D.el.nativeTheme.systemUsesDarkColors,
    follow: D.prf.colourSchemeFollowSystem(),
  }));
}

async function openStyleTab(c) {
  await c.execute(() => D.commands.PRF());
  await c.waitUntil(async () => c.execute(() => !!(D.prf_bw && D.prf_bw.socket)),
    { timeout: 10000, timeoutMsg: 'Preferences window did not connect' });
  const label = await c.execute(() => D.prf_bw.win.label);
  await c.switchToWindow(label);
  await c.waitUntil(async () => c.execute(() => !I.prf_dlg.hidden),
    { timeout: 10000, timeoutMsg: 'Preferences did not open' });
  await c.execute(() => {
    const link = document.querySelector('#prf_nav a[href="#col"]');
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
  await c.waitUntil(async () => c.execute(() => !document.getElementById('col').hidden),
    { timeout: 10000, timeoutMsg: 'Style tab did not open' });
}

test('a new profile follows the system theme with the light or dark scheme', async t => {
  const c = t.context.app.client;
  const s = await themeState(c);
  t.is(s.follow, 1);
  t.is(s.source, 'system');
  t.is(s.osDark, s.systemDark);
  t.is(s.theme, s.systemDark ? 'dark' : 'light');
  t.is(s.winstate, s.theme);
  t.true(s.dark !== s.light);
  t.is(s.dark, s.systemDark);
});

test('a chosen scheme sets the native theme until the system is followed again', async t => {
  const c = t.context.app.client;
  await c.execute(() => { D.prf.colourSchemeFollowSystem(0); D.prf.colourScheme('Dracula'); });
  t.like(await themeState(c), { dark: true, light: false, theme: 'dark', source: 'dark', winstate: 'dark' });
  await c.execute(() => D.prf.colourScheme('Albrecht Dürer'));
  t.like(await themeState(c), { dark: false, light: true, theme: 'light', source: 'light', winstate: 'light' });
  await c.execute(() => D.prf.colourSchemeFollowSystem(1));
  const s = await themeState(c);
  t.is(s.source, 'system');
  t.is(s.theme, s.systemDark ? 'dark' : 'light');
});

test('cancelling Preferences after ticking follow-system keeps the chosen theme', async t => {
  const c = t.context.app.client;
  const main = await c.getWindowHandle();
  await c.execute(() => { D.prf.colourSchemeFollowSystem(0); D.prf.colourScheme('Dracula'); });
  t.like(await themeState(c), { theme: 'dark', source: 'dark' });
  await openStyleTab(c);
  // Ticking follow previews the system's scheme, which reads the OS theme.
  await c.execute(() => { I.col_follow.checked = true; I.col_follow.onchange(); });
  await c.execute(() => I.prf_dlg_cancel.click());
  await c.switchToWindow(main);
  t.like(await themeState(c), { theme: 'dark', source: 'dark', winstate: 'dark', follow: 0 });
});

test('the Style tab offers light and dark schemes for following the system', async t => {
  const c = t.context.app.client;
  await openStyleTab(c);
  const lists = await c.execute(() => {
    const names = (sel) => [...sel.options].map((o) => o.textContent);
    return {
      follow: I.col_follow.checked,
      light: names(I.col_lscm),
      dark: names(I.col_dscm),
    };
  });
  t.true(lists.follow);
  t.deepEqual(lists.light, ['Dyalog Light', 'Default', 'Albrecht Dürer']);
  t.deepEqual(lists.dark, ['Dyalog Dark', 'Francisco Goya', 'Dracula', 'New Moon', 'Nord']);

  // Choosing a dark scheme shows it in the sample; OK saves it.
  await c.execute(() => {
    I.col_dscm.value = [...I.col_dscm.options].find((o) => o.textContent === 'Nord').value;
    I.col_dscm.onchange();
  });
  t.is(await c.execute(() => I.col_scm.value), 'Nord');
  await c.execute(() => {
    I.col_follow.checked = false;
    I.col_follow.onchange();
  });
  t.true(await c.execute(() => I.col_lscm.disabled && I.col_dscm.disabled));
  await c.execute(() => I.prf_dlg_ok.click());
  await c.waitUntil(async () => c.execute(() => D.prf.colourSchemeFollowSystem() === 0),
    { timeout: 10000, timeoutMsg: 'Follow system was not saved' });
  t.is(await c.execute(() => D.prf.colourSchemeDark()), 'Nord');
  // Not following, the scheme shown is the one in use.
  t.is(await c.execute(() => D.prf.colourScheme()), 'Nord');
});
