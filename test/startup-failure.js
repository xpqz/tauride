const test = require('ava');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TauriApplication } = require('./_tauri');

const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;

nativeTest('interpreter startup exit reports the actual native alert and cleans up the owned app', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride-exit-interpreter-'));
  const executable = path.join(directory, 'exit-interpreter');
  const marker = path.join(directory, 'interpreter-pid');
  fs.writeFileSync(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.exit(23);\n`, { mode: 0o755 });
  const previous = process.env.RIDE_TEST_DYALOG;
  process.env.RIDE_TEST_DYALOG = executable;
  const app = new TauriApplication({ interpreter: true });
  let error;
  try {
    error = await t.throwsAsync(app.start(), { message: /Interpreter exited with code 23/ });
    t.truthy(error);
    t.regex(error.message, /Startup phase:/);
    t.regex(error.message, /PID \d+; running=true/);
    t.truthy(error.startupDiagnosticsDirectory);
    const state = JSON.parse(fs.readFileSync(path.join(error.startupDiagnosticsDirectory, 'startup.json'), 'utf8'));
    t.is(state.nativeDialog.message, 'Interpreter exited with code 23');
    t.is(state.pid, app.child.pid);
    t.true(state.running);
    t.not(state.phase, 'ready');
    t.regex(fs.readFileSync(path.join(error.startupDiagnosticsDirectory, 'app-output.txt'), 'utf8'), /\[ui-test-dialog\].*Interpreter exited with code 23/);
    t.false(app.isRunning());
    t.false(fs.existsSync(app.userData));
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    t.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    try { await app.stop(); } finally {
      if (previous === undefined) delete process.env.RIDE_TEST_DYALOG;
      else process.env.RIDE_TEST_DYALOG = previous;
      if (error && error.startupDiagnosticsDirectory) fs.rmSync(error.startupDiagnosticsDirectory, { recursive: true, force: true });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
