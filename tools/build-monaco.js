const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

module.exports = function buildMonaco() {
  const root = path.resolve(__dirname, '..');
  const outdir = path.join(root, '_', 'monaco');
  fs.rmSync(outdir, { recursive: true, force: true });
  esbuild.buildSync({
    absWorkingDir: root,
    entryPoints: {
      monaco: 'src/monaco.js',
      'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
      'json.worker': 'node_modules/monaco-editor/esm/vs/language/json/json.worker.js',
      'css.worker': 'node_modules/monaco-editor/esm/vs/language/css/css.worker.js',
      'html.worker': 'node_modules/monaco-editor/esm/vs/language/html/html.worker.js',
      'typescript.worker': 'node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js',
    },
    outdir,
    bundle: true,
    format: 'iife',
    loader: { '.ttf': 'file' },
    assetNames: 'assets/[name]-[hash]',
    entryNames: '[name]',
    minify: true,
    logLevel: 'warning',
  });
};

if (require.main === module) module.exports();
