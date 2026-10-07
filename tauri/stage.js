#!/usr/bin/env node
// Stages the files the Tauri webview loads into _/tauri-dist: the same set
// mk's `incl` filter ships with Electron, minus node_modules other than the
// three trees the pages load from script/link tags.
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
    const dst = path.join(out, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

// mk's build step writes _/version.js (version, date, git revision).
require('child_process').execFileSync(process.execPath, ['mk', 'b'], { cwd: root, stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
entries.forEach(copy);
console.log(`stage: ${out}`);
