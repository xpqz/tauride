#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const destination = process.argv[2];
if (!destination) {
  console.error('Usage: node sample-extensions/build-vim.js <Ride userData directory>');
  process.exit(1);
}
const root = path.resolve(__dirname, '..');
const target = path.resolve(destination);
const vim = path.join(target, 'node_modules/monaco-vim/lib/index.js');
if (!fs.existsSync(vim)) {
  console.error(`Install monaco-vim in ${target} first.`);
  process.exit(1);
}
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'vim.js')],
  outfile: path.join(target, 'vim.bundle.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  minify: true,
  alias: {
    'monaco-vim': vim,
    'monaco-editor/esm/vs/editor/editor.api': path.join(__dirname, 'monaco-global.cjs'),
    'monaco-editor/esm/vs/editor/common/commands/shiftCommand':
      path.join(root, 'node_modules/monaco-editor/esm/vs/editor/common/commands/shiftCommand.js'),
  },
});
console.log(path.join(target, 'vim.bundle.js'));
