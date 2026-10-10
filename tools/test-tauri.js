const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const buildOnly = args.includes('--build-only');
const testArgs = args.filter(arg => arg !== '--build-only');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status);
}

if (!process.env.RIDE_TEST_BINARY) {
  run(process.execPath, [require.resolve('grunt/bin/grunt'), 'less']);
  run(process.execPath, [path.join(root, 'tauri/stage.js')]);
  run('cargo', ['build', '--locked', '--features', 'ui-tests'], {
    cwd: path.join(root, 'src-tauri'),
    env: {
      ...process.env,
      CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR
        ? path.resolve(root, process.env.CARGO_TARGET_DIR)
        : path.join(root, 'src-tauri/target/ui-tests'),
      TAURI_CONFIG: fs.readFileSync(path.join(root, 'tauri/ui-tests.conf.json'), 'utf8'),
    },
  });
}

if (!buildOnly) {
  run(process.execPath, [path.join(path.dirname(require.resolve('ava')), 'cli.mjs'), '--serial', '--concurrency=1', '--no-worker-threads', '--timeout=60s',
    ...(testArgs.length ? testArgs : ['test/*.js'])]);
}
