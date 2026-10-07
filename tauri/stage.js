#!/usr/bin/env node
// Stages the files the Tauri webview loads into _/tauri-dist: the same set
// mk's `incl` filter ships with Electron, minus node_modules other than the
// trees the pages load. Those go to vendor/ (the Tauri CLI refuses a
// frontendDist holding a node_modules folder) and the staged pages' paths
// are rewritten to match.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, '_', 'tauri-dist');

const entries = [
  'index.html', 'about.html', 'dialog.html', 'status.html', 'empty.html',
  'D.png', 'favicon.ico', 'favicon.png',
  'src', 'lib', 'style', '_/version.js',
  'node_modules/jquery/dist',
  'node_modules/toastr/build',
  'node_modules/monaco-editor/min',
  // Buffer for the webview (tauri/shim.js loads it as a CommonJS module).
  'node_modules/buffer',
  'node_modules/base64-js',
  'node_modules/ieee754',
];

// Style sources are compiled by `npm run css`; only the compiled CSS and
// the fonts and images it references ship.
const skip = (rel, isDir) => /\.map$/.test(rel)
  || (/^style\/[^/]+$/.test(rel) && (isDir ? !/^style\/(fonts|img)$/.test(rel) : !/\.css$/.test(rel)));

function copy(rel) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) throw new Error(`stage: missing ${rel}`);
  const st = fs.statSync(src);
  if (skip(rel, st.isDirectory())) return;
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(src)) copy(path.join(rel, name));
  } else {
    const dst = path.join(out, rel.replace(/^node_modules\//, 'vendor/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

// mk's build step writes _/version.js (version, date, git revision).
require('child_process').execFileSync(process.execPath, ['mk', 'b'], { cwd: root, stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
entries.forEach(copy);

// CommonJS modules the pages require(). The pages' CSP forbids eval, so
// instead of evaluating fetched source, tauri/shim.js resolves require()
// against this registry of wrapped module functions, loaded from a script
// tag ahead of each page's own scripts.
const cjs = [
  'src/cn.js',
  'node_modules/buffer/index.js',
  'node_modules/base64-js/index.js',
  'node_modules/ieee754/index.js',
];
const staged = (rel) => `/${rel.replace(/^node_modules\//, 'vendor/')}`;
const packages = { buffer: staged('node_modules/buffer/index.js'), 'base64-js': staged('node_modules/base64-js/index.js'), ieee754: staged('node_modules/ieee754/index.js') };
let reg = 'window.__rideModules = window.__rideModules || {};\n'
  + `window.__ridePackages = ${JSON.stringify(packages)};\n`;
cjs.forEach((rel) => {
  reg += `window.__rideModules[${JSON.stringify(staged(rel))}] = function (module, exports, require, __dirname, __filename) {\n`
    + `${fs.readFileSync(path.join(root, rel), 'utf8')}\n};\n`;
});
fs.writeFileSync(path.join(out, 'tauri-modules.js'), reg);
['index.html', 'dialog.html', 'status.html', 'about.html', 'empty.html'].forEach((page) => {
  const f = path.join(out, page);
  const html = fs.readFileSync(f, 'utf8').replace(/node_modules\//g, 'vendor/');
  const i = html.indexOf('<script');
  if (i < 0) { fs.writeFileSync(f, html); return; }
  fs.writeFileSync(f, `${html.slice(0, i)}<script src="tauri-modules.js"></script>\n${html.slice(i)}`);
});
console.log(`stage: ${out}`);
