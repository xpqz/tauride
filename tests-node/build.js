const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { generateLicenses } = require('../generate-licenses');

const root = path.resolve(__dirname, '..');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (file, text) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  write('package.json', JSON.stringify({ name: 'test-ride', version: '4.8.3' }));
  write('licence', 'Ride project attribution');
  for (const name of ['jquery', 'toastr', 'monaco-editor', 'buffer', 'base64-js', 'ieee754']) {
    write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', license: 'MIT' }));
    write(`node_modules/${name}/LICENSE.md`, `${name} copyright and permission`);
  }
  return { directory, write };
}

test('notices include shipped package license texts and are replaced on rebuild', t => {
  const { directory } = fixture(t);
  const output = path.join(directory, 'ThirdPartyNotices.txt');
  generateLicenses(output, { root: directory, packages: ['jquery', 'buffer'] });
  const original = fs.readFileSync(output, 'utf8');
  assert.match(original, /jquery@1\.0\.0/);
  assert.match(original, /jquery copyright and permission/);
  assert.match(original, /buffer copyright and permission/);
  assert.doesNotMatch(original, /toastr copyright/);
  generateLicenses(output, { root: directory, packages: ['jquery', 'buffer'] });
  assert.equal(fs.readFileSync(output, 'utf8'), original);
});

test('missing attribution fails the build rather than silently omitting a shipped package', t => {
  const { directory } = fixture(t);
  fs.rmSync(path.join(directory, 'node_modules/jquery/LICENSE.md'));
  assert.throws(() => generateLicenses(path.join(directory, 'notices.txt'),
    { root: directory, packages: ['jquery'] }), /license.*jquery|jquery.*license/i);
});

test('Toastr attribution preserves its published source copyright and complete MIT terms', t => {
  const { directory, write } = fixture(t);
  fs.rmSync(path.join(directory, 'node_modules/toastr/LICENSE.md'));
  write('node_modules/toastr/package.json', JSON.stringify({ name: 'toastr', version: '2.1.4', licenses: [{ type: 'MIT' }] }));
  write('node_modules/toastr/toastr.js', '/* Toastr copyright: authors */\nfrontend implementation');
  fs.copyFileSync(path.join(root, 'licence'), path.join(directory, 'licence'));
  const output = path.join(directory, 'notices.txt');
  generateLicenses(output, { root: directory, packages: ['toastr'] });
  const text = fs.readFileSync(output, 'utf8');
  assert.match(text, /Toastr copyright: authors/);
  assert.match(text, /Permission is hereby granted/);
  assert.match(text, /THE SOFTWARE IS PROVIDED/);
  assert.doesNotMatch(text, /frontend implementation/);
});

test('shared and browser builds work without Electron and retain attribution through clean', { skip: process.platform === 'win32' }, t => {
  const { directory, write } = fixture(t);
  for (const file of ['mk', 'generate-licenses.js']) fs.copyFileSync(path.join(root, file), path.join(directory, file));
  write('tools/build-monaco.js', "module.exports = () => { const fs = require('node:fs'); fs.mkdirSync('_/monaco', {recursive:true}); fs.writeFileSync('_/monaco/monaco.js', 'frontend bundle'); };\n");
  write('index.html', '<script src="node_modules/jquery/dist/jquery.min.js"></script>');
  write('src/fixture.js', 'frontend source');
  write('lib/fixture.js', 'library attribution');
  write('style/theme.css', 'body{}');
  write('style/less/theme.less', 'do not ship');
  write('node_modules/jquery/dist/jquery.min.js', 'jquery');
  write('node_modules/toastr/build/toastr.min.js', 'toastr');
  const run = (command, args) => execFileSync(command, args, { cwd: directory, stdio: 'pipe' });
  run('git', ['init', '-q']);
  run('git', ['-c', 'user.name=Build Test', '-c', 'user.email=build@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture']);
  run(process.execPath, ['mk', 'b']);
  assert.match(fs.readFileSync(path.join(directory, '_/version.js'), 'utf8'), /4\.8\.3\.1/);
  assert.match(fs.readFileSync(path.join(directory, '_/ThirdPartyNotices.txt'), 'utf8'), /buffer copyright/);
  run(process.execPath, ['mk', 'zf']);
  for (const file of ['index.html', '_/monaco/monaco.js', 'node_modules/jquery/dist/jquery.min.js',
    'node_modules/toastr/build/toastr.min.js', 'licence', 'ThirdPartyNotices.txt']) {
    assert.ok(fs.existsSync(path.join(directory, '_/zf', file)), file);
  }
  assert.equal(fs.existsSync(path.join(directory, '_/zf/style/less/theme.less')), false);
  assert.equal(fs.existsSync(path.join(directory, '_/zf/package.json')), false);
  assert.equal(fs.existsSync(path.join(directory, '_/zf/main.js')), false);
  assert.match(fs.readFileSync(path.join(directory, '_/zf/ThirdPartyNotices.txt'), 'utf8'), /monaco-editor copyright/);
  assert.doesNotMatch(fs.readFileSync(path.join(directory, '_/zf/ThirdPartyNotices.txt'), 'utf8'), /buffer copyright/);
  assert.ok(fs.existsSync(path.join(directory, '_/tauride-zf-4.8.3.1.zip')));
  run(process.execPath, ['mk', 'c']);
  assert.equal(fs.existsSync(path.join(directory, '_')), false);
  assert.ok(fs.existsSync(path.join(directory, 'licence')));
  run(process.execPath, ['mk', 'b', 'c', 'b']);
  assert.ok(fs.existsSync(path.join(directory, '_/monaco/monaco.js')), 'Clean invalidates the shared build cache');
});
