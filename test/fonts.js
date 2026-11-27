const test = require('ava');
const { tfw } = require('./_utils');

tfw.init({ src: 'se', interpreter: true });

async function openStyleTab(c) {
  await c.execute(() => D.commands.PRF());
  await c.waitUntil(async () => c.execute(() => !!(D.prf_bw && D.prf_bw.socket)),
    { timeout: 10000, timeoutMsg: 'Preferences window did not connect' });
  await c.switchToWindow(await c.execute(() => D.prf_bw.win.label));
  await c.waitUntil(async () => c.execute(() => !I.prf_dlg.hidden),
    { timeout: 10000, timeoutMsg: 'Preferences did not open' });
  await c.execute(() => {
    const link = document.querySelector('#prf_nav a[href="#col"]');
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
  await c.waitUntil(async () => c.execute(() => !I.col_fnt_sel.hidden),
    { timeout: 20000, timeoutMsg: 'The APL font list did not appear' });
}

test('the APL font list offers installed fonts and stores the names local() matches', async t => {
  const c = t.context.app.client;
  const fonts = await c.execute(() => window.__TAURI_INTERNALS__.invoke('list_apl_fonts',
    { glyphs: D.lb.order.replace(/[\x00-\x7f]/g, '') }));
  t.true(Array.isArray(fonts));
  fonts.forEach((f) => t.truthy(f.family && f.fullName && f.postscript));
  await openStyleTab(c);
  const options = await c.execute(() => [...I.col_fnt_sel.options].map((o) => o.textContent));
  t.deepEqual(options, ['APL385 Unicode (bundled)', ...fonts.map((f) => f.family), 'Other…']);
  t.true(await c.execute(() => I.col_fnt_sel.value === '' && I.col_fnt.hidden));

  if (fonts.length) {
    const stored = await c.execute(() => {
      I.col_fnt_sel.value = '0';
      I.col_fnt_sel.onchange();
      return I.col_fnt.value;
    });
    t.is(stored, `${fonts[0].fullName},${fonts[0].postscript}`);
    // A family name saved by hand selects its font and is stored as above.
    t.deepEqual(await c.execute((family) => {
      I.col_fnt.value = family;
      I.col_fnt.onchange();
      return [I.col_fnt_sel.value, I.col_fnt.value];
    }, fonts[0].family), ['0', stored]);
  }

  const unknown = await c.execute(() => {
    I.col_fnt.value = 'No Such APL Font';
    I.col_fnt.onchange();
    return { sel: I.col_fnt_sel.value, shown: !I.col_fnt.hidden, missing: I.col_fnt.classList.contains('missing') };
  });
  t.deepEqual(unknown, { sel: 'other', shown: true, missing: true });
  await c.execute(() => I.prf_dlg_ok.click());
  await c.waitUntil(async () => c.execute(() => D.prf.customAplFont() === 'No Such APL Font'),
    { timeout: 10000, timeoutMsg: 'The typed font name was not saved' });
});
