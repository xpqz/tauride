const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { TauriApplication, isolatedEnv, waitForStatus, binaryPath } = require('../test/_tauri');

test('test app environment isolates preferences and interpreter logs without changing HOME', () => {
  for (const inheritedLog of [undefined, '/home/user/.dyalog/default.dlf']) {
    const env = isolatedEnv('/tmp/test-profile', 4567, {}, {
      PATH: '/usr/bin', HOME: '/home/user', RIDE_CONNECT: 'production:4502',
      RIDE_JS: '/home/user/start.js', RIDE_PREFS: '/home/user/prefs.json', RIDE_SPAWN: 'old',
      ...(inheritedLog ? { LOG_FILE: inheritedLog } : {}),
    });
    assert.deepEqual(env, {
      PATH: '/usr/bin', HOME: '/home/user', XDG_CONFIG_HOME: '/tmp/test-profile',
      APPDATA: '/tmp/test-profile', LOG_FILE: path.join('/tmp/test-profile', 'dyalog*.dlf'),
      TAURI_WEBDRIVER_PORT: '4567', TAURI_UI_TEST_STDIN: '1',
    });
  }
});

test('binary selection honors explicit and Cargo target paths', () => {
  const binary = path.join(os.tmpdir(), 'custom-app');
  const target = path.join(os.tmpdir(), 'cargo');
  assert.equal(binaryPath({ RIDE_TEST_BINARY: binary }), binary);
  assert.equal(binaryPath({ CARGO_TARGET_DIR: target }),
    path.join(target, 'debug', process.platform === 'win32' ? 'tauride.exe' : 'tauride'));
});

test('readiness waits for the embedded W3C status endpoint to report ready', async () => {
  let polls = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/status');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ value: { ready: ++polls >= 2 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await waitForStatus(server.address().port, { exitCode: null, signalCode: null }, 2000);
    assert.ok(polls >= 2);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('readiness timeout distinguishes an initializing webview from an unreachable server', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ value: { ready: false, message: 'waiting for webview initialization' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const child = { exitCode: null, signalCode: null };
  try {
    await assert.rejects(waitForStatus(port, child, 150), /last status: HTTP 200:.*waiting for webview initialization/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
  await assert.rejects(waitForStatus(port, child, 150), /last status:.*ECONNREFUSED/);
});

test('startup failure stops its child and removes its temporary profile', { skip: process.platform === 'win32' }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride-fixture-'));
  const binary = path.join(fixture, 'exit-app');
  fs.writeFileSync(binary, `#!${process.execPath}\nprocess.stderr.write('fixture startup failure'); process.exit(7);\n`, { mode: 0o755 });
  const previous = process.env.RIDE_TEST_BINARY;
  process.env.RIDE_TEST_BINARY = binary;
  const app = new TauriApplication({ src: 'cn', timeout: 2000 });
  try {
    await assert.rejects(app.start(), /fixture startup failure/);
    assert.equal(app.isRunning(), false);
    assert.equal(fs.existsSync(app.userData), false);
    await app.stop();
  } finally {
    if (previous === undefined) delete process.env.RIDE_TEST_BINARY;
    else process.env.RIDE_TEST_BINARY = previous;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('missing app binary also removes the profile', async () => {
  const previous = process.env.RIDE_TEST_BINARY;
  process.env.RIDE_TEST_BINARY = path.join(os.tmpdir(), `missing-tauride-${process.pid}`);
  const app = new TauriApplication({ src: 'cn' });
  try {
    await assert.rejects(app.start(), /ENOENT/);
    assert.equal(app.isRunning(), false);
    assert.equal(fs.existsSync(app.userData), false);
  } finally {
    if (previous === undefined) delete process.env.RIDE_TEST_BINARY;
    else process.env.RIDE_TEST_BINARY = previous;
  }
});

test('readiness timeout terminates the owned startup process', { skip: process.platform === 'win32' }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride-fixture-'));
  const binary = path.join(fixture, 'waiting-app');
  fs.writeFileSync(binary, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const previous = process.env.RIDE_TEST_BINARY;
  process.env.RIDE_TEST_BINARY = binary;
  const app = new TauriApplication({ src: 'cn', timeout: 150 });
  try {
    await assert.rejects(app.start(), /WebDriver did not become ready/);
    assert.equal(app.isRunning(), false);
    assert.equal(fs.existsSync(app.userData), false);
  } finally {
    if (previous === undefined) delete process.env.RIDE_TEST_BINARY;
    else process.env.RIDE_TEST_BINARY = previous;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});


test('AVA timeout runs process cleanup before its test worker exits', { skip: process.platform === 'win32' }, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride-ava-fixture-'));
  const binary = path.join(fixture, 'waiting-app');
  const marker = path.join(fixture, 'owned-pid');
  const profile = path.join(fixture, 'profile');
  fs.writeFileSync(binary, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ ava: { files: ['test.js'] } }));
  fs.writeFileSync(path.join(fixture, 'test.js'), `
    const test = require(${JSON.stringify(require.resolve('ava'))});
    const fs = require('node:fs');
    const { TauriApplication } = require(${JSON.stringify(require.resolve('../test/_tauri'))});
    test('hung native startup', async () => {
      const app = new TauriApplication({ src: 'cn' });
      const starting = app.start();
      fs.writeFileSync(${JSON.stringify(profile)}, app.userData);
      await starting;
    });
  `);
  let pid;
  try {
    const result = spawnSync(process.execPath, [path.join(path.dirname(require.resolve('ava')), 'cli.mjs'),
      '--no-worker-threads', '--timeout=3s'], {
      cwd: fixture, env: { ...process.env, RIDE_TEST_BINARY: binary }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /timeout|Timed out/i);
    pid = Number(fs.readFileSync(marker, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(fs.existsSync(fs.readFileSync(profile, 'utf8')), false);
  } finally {
    if (!pid && fs.existsSync(marker)) pid = Number(fs.readFileSync(marker, 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* Already cleaned up. */ } }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});


test('abrupt worker termination closes its app ownership pipe', { skip: process.platform === 'win32' }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride-pipe-fixture-'));
  const binary = path.join(fixture, 'pipe-app');
  const marker = path.join(fixture, 'owned-pid');
  const ended = path.join(fixture, 'stdin-ended');
  const profile = path.join(fixture, 'profile');
  fs.writeFileSync(binary, `#!${process.execPath}\nconst fs = require('fs'); fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.stdin.resume(); process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(ended)}, 'EOF'); process.exit(0); });\n`, { mode: 0o755 });
  const worker = spawn(process.execPath, ['-e', `
    const { TauriApplication } = require(${JSON.stringify(require.resolve('../test/_tauri'))});
    const app = new TauriApplication({ src: 'cn' });
    app.start().catch(() => process.exit(1));
    require('fs').writeFileSync(${JSON.stringify(profile)}, app.userData);
  `], { env: { ...process.env, RIDE_TEST_BINARY: binary }, stdio: 'ignore' });
  const waitUntil = async (condition) => {
    const deadline = Date.now() + 5000;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(condition(), 'ownership fixture did not settle');
  };
  let pid;
  try {
    await waitUntil(() => fs.existsSync(marker));
    pid = Number(fs.readFileSync(marker, 'utf8'));
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill('SIGKILL');
    await exited;
    await waitUntil(() => fs.existsSync(ended));
    await waitUntil(() => {
      try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
    });
    assert.equal(fs.readFileSync(ended, 'utf8'), 'EOF');
  } finally {
    worker.kill('SIGKILL');
    if (!pid && fs.existsSync(marker)) pid = Number(fs.readFileSync(marker, 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* Already exited. */ } }
    if (fs.existsSync(profile)) fs.rmSync(fs.readFileSync(profile, 'utf8'), { recursive: true, force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
