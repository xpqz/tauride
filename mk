#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { generateLicenses, browserPackages } = require('./generate-licenses');

process.chdir(__dirname);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const rm = file => fs.rmSync(file, { recursive: true, force: true });
let version;

function build() {
  if (version) return;
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  version = `${pkg.version.replace(/\.0$/, '')}.${git('rev-list', '--count', 'HEAD')}`;
  fs.mkdirSync('_', { recursive: true });
  fs.writeFileSync('_/version', version);
  require('./tools/build-monaco')();
  fs.writeFileSync('_/version.js', `D=${JSON.stringify({ versionInfo: {
    version, date: git('show', '-s', 'HEAD', '--pretty=format:%ci'), rev: git('rev-parse', 'HEAD'),
  } })}`);
  generateLicenses('_/ThirdPartyNotices.txt');
  console.info(`v${version}`);
}

const include = /^$|^\/(D\.png|favicon[^/]*|[^/]*\.html|licence)$|^\/(src|lib)(\/|$)|^\/_$|^\/_\/version\.js$|^\/_\/monaco(\/|$)|^\/style($|\/(fonts|img)|.*\.css$)|^\/node_modules$|^\/node_modules\/(jquery|toastr)(\/|$)/;
const exclude = file => /toastr\/(?!build($|\/toastr.min))/.test(file)
  || /jquery\/(?!dist($|\/jquery\.min\.js))/.test(file) || /\.map$/.test(file);

function zerofootprint() {
  build();
  const out = '_/zf';
  rm(out);
  const copy = file => {
    if (!include.test(file) || exclude(file)) return;
    if (fs.statSync(`.${file}`).isDirectory()) {
      fs.readdirSync(`.${file}`).forEach(name => copy(`${file}/${name}`));
    } else {
      const destination = `${out}${file}`;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(`.${file}`, destination);
    }
  };
  copy('');
  generateLicenses(`${out}/ThirdPartyNotices.txt`, { packages: browserPackages });
  const zip = `tauride-zf-${version}.zip`;
  rm(`_/${zip}`);
  fs.symlinkSync('zf', '_/RIDEapp');
  try { execFileSync('zip', ['-qr', zip, 'RIDEapp'], { cwd: '_' }); }
  finally { fs.unlinkSync('_/RIDEapp'); }
  console.info(`_/${zip}`);
}

function clean() {
  rm('_');
  version = undefined;
}

const tasks = { b: build, build, zf: zerofootprint, zerofootprint, c: clean, clean };
for (const task of process.argv.length > 2 ? process.argv.slice(2) : ['build']) {
  if (!Object.prototype.hasOwnProperty.call(tasks, task)) throw new Error(`No task named ${JSON.stringify(task)}`);
  tasks[task]();
}
