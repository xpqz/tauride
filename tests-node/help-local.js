const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/help_local');

const present = (...dirs) => p => dirs.some(d => p === `${d}/index.html` || p === `${d}\\index.html`);
const mac = (over = {}) => create({ env: {}, platform: 'darwin', home: '/Users/a', exists: () => false, ...over });
const MAC_USER = '/Users/a/Library/Application Support/Dyalog/docs/21.0';
const MAC_MACHINE = '/Library/Application Support/Dyalog/docs/21.0';
const RHO = 'language-reference-guide/symbols/rho';

test('file: topic URLs from the interpreter become .html files', () => {
  const h = mac({ env: { DYALOGHELPDIR: 'file:///r/21.0' } });
  assert.equal(h.target(`file:///r/21.0/${RHO}/`), `file:///r/21.0/${RHO}.html`);
  assert.equal(h.target(`file:///r/21.0/${RHO}/#examples`), `file:///r/21.0/${RHO}.html#examples`);
});

test('the bare file: prefix opens the bundle index', () => {
  const h = mac({ env: { DYALOGHELPDIR: 'file:///r/21.0' } });
  assert.equal(h.target('file:///r/21.0'), 'file:///r/21.0/index.html');
  assert.equal(h.target('file:///r/21.0/'), 'file:///r/21.0/index.html');
});

test('file: URLs are percent-encoded once, whether or not the caller encoded them', () => {
  const h = mac({ env: { DYALOGHELPDIR: `file://${MAC_USER}` } });
  const raw = `file://${MAC_USER}/${RHO}/`;
  const want = `file:///Users/a/Library/Application%20Support/Dyalog/docs/21.0/${RHO}.html`;
  assert.equal(h.target(raw), want);
  assert.equal(h.target(encodeURI(raw)), want);
});

test('non-ASCII user names are encoded as UTF-8', () => {
  const h = create({ env: { LOCALAPPDATA: 'C:\\Users\\Jürgen Smith\\AppData\\Local' },
    platform: 'win32', home: 'C:\\Users\\Jürgen Smith', exists: present('C:\\Users\\Jürgen Smith\\AppData\\Local\\Dyalog\\docs\\21.0') });
  assert.equal(h.target(`https://docs.dyalog.com/21.0/${RHO}/`),
    `file:///C:/Users/J%C3%BCrgen%20Smith/AppData/Local/Dyalog/docs/21.0/${RHO}.html`);
});

test('online URLs map to the per-user bundle first', () => {
  const h = mac({ exists: present(MAC_USER, MAC_MACHINE) });
  assert.equal(h.target(`https://docs.dyalog.com/21.0/${RHO}/`),
    `file:///Users/a/Library/Application%20Support/Dyalog/docs/21.0/${RHO}.html`);
});

test('online URLs fall back to the machine-wide bundle', () => {
  const h = mac({ exists: present(MAC_MACHINE) });
  assert.equal(h.target(`https://docs.dyalog.com/21.0/${RHO}/`),
    `file:///Library/Application%20Support/Dyalog/docs/21.0/${RHO}.html`);
  assert.equal(h.target('https://docs.dyalog.com/21.0/'), 'file:///Library/Application%20Support/Dyalog/docs/21.0/index.html');
});

test('online URLs stay online when no bundle for that version is installed', () => {
  const h = mac({ exists: present('/Users/a/Library/Application Support/Dyalog/docs/20.0') });
  const url = `https://docs.dyalog.com/21.0/${RHO}/`;
  assert.equal(h.target(url), url);
});

test('a set DYALOGHELPDIR disables the lookup', () => {
  const h = mac({ env: { DYALOGHELPDIR: 'https://docs.dyalog.com/21.0' }, exists: present(MAC_USER) });
  const url = `https://docs.dyalog.com/21.0/${RHO}/`;
  assert.equal(h.target(url), url);
});

test('Windows: per-user copy under LOCALAPPDATA (any case) first', () => {
  const h = create({ env: { localappdata: 'C:\\Users\\x\\AppData\\Local' }, platform: 'win32', home: 'C:\\Users\\x',
    installDir: 'C:\\Program Files\\Dyalog\\Dyalog APL-64 21.0 Unicode',
    exists: present('C:\\Users\\x\\AppData\\Local\\Dyalog\\docs\\21.0', 'C:\\Program Files\\Dyalog\\Dyalog APL-64 21.0 Unicode\\help\\docs') });
  assert.equal(h.target(`https://docs.dyalog.com/21.0/${RHO}/`), `file:///C:/Users/x/AppData/Local/Dyalog/docs/21.0/${RHO}.html`);
});

test('Windows: machine-wide copy beside dyalog.chm in the spawned interpreter\'s install directory', () => {
  const dir = 'C:\\Program Files\\Dyalog\\Dyalog APL-64 21.0 Unicode';
  const h = create({ env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, platform: 'win32', home: 'C:\\Users\\x',
    exists: present(`${dir}\\help\\docs`) });
  const url = `https://docs.dyalog.com/21.0/${RHO}/`;
  assert.equal(h.target(url), url);
  h.setInterpreter(`${dir}\\dyalog.exe`);
  assert.equal(h.target(url), `file:///C:/Program%20Files/Dyalog/Dyalog%20APL-64%2021.0%20Unicode/help/docs/${RHO}.html`);
});

test('Linux roots honour XDG_DATA_HOME', () => {
  const h = create({ env: { XDG_DATA_HOME: '/data' }, platform: 'linux', home: '/home/a', exists: present('/data/dyalog/docs/21.0') });
  assert.equal(h.target(`https://docs.dyalog.com/21.0/${RHO}/`), `file:///data/dyalog/docs/21.0/${RHO}.html`);
});

test('unrelated URLs pass through untouched', () => {
  const h = mac({ exists: () => true });
  for (const url of ['https://dyalog.com/', 'mailto:support@dyalog.com?subject=a b', 'https://docs.dyalog.com/files/x.pdf', 'file:///tmp/a%20b.txt']) {
    assert.equal(h.target(url), url);
  }
});

test('helpUri is the file: prefix when DYALOGHELPDIR is one, else online', () => {
  assert.equal(mac({ env: { DYALOGHELPDIR: 'file:///r/21.0' } }).helpUri('21.0'), 'file:///r/21.0/');
  assert.equal(mac({ env: { DYALOGHELPDIR: 'file:///r/21.0/' } }).helpUri('21.0'), 'file:///r/21.0/');
  assert.equal(mac().helpUri('21.0'), 'https://docs.dyalog.com/21.0/');
});

test('the welcome topic\'s empty path ("<prefix>//") opens the index', () => {
  const h = mac({ env: { DYALOGHELPDIR: 'file:///r/21.0' } });
  assert.equal(h.target('file:///r/21.0//'), 'file:///r/21.0/index.html');
  const g = mac({ exists: present(MAC_MACHINE) });
  assert.equal(g.target('https://docs.dyalog.com/21.0//'), 'file:///Library/Application%20Support/Dyalog/docs/21.0/index.html');
});
