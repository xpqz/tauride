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
      APPDATA: '/tmp/test-profile', ENABLE_CEF: '0', LOG_FILE: path.join('/tmp/test-profile', 'dyalog*.dlf'),
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
    if (app.diagnosticDirectory) fs.rmSync(app.diagnosticDirectory, { recursive: true, force: true });
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
    if (app.diagnosticDirectory) fs.rmSync(app.diagnosticDirectory, { recursive: true, force: true });
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
  const ordering = [];
  app.sampleNativeProcess = async () => {
    ordering.push(['sample', app.isRunning()]);
    return { status: 'skipped', reason: 'unit fixture' };
  };
  const stop = app.stop.bind(app);
  app.stop = async () => { ordering.push(['cleanup', app.isRunning()]); return stop(); };
  try {
    await assert.rejects(app.start(), /WebDriver did not become ready/);
    assert.deepEqual(ordering, [['sample', true], ['cleanup', true]]);
    const evidence = JSON.parse(fs.readFileSync(path.join(app.diagnosticDirectory, 'startup.json'), 'utf8'));
    assert.equal(evidence.phase, 'WebDriver status readiness');
    assert.equal(evidence.running, true);
    assert.equal(evidence.pid, app.child.pid);
    assert.equal(app.isRunning(), false);
    assert.equal(fs.existsSync(app.userData), false);
  } finally {
    if (app.diagnosticDirectory) fs.rmSync(app.diagnosticDirectory, { recursive: true, force: true });
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

test('startup diagnostics cache the last successful frontend snapshot when the next command stalls', async () => {
  const app = new TauriApplication({ src: 'cn' });
  const snapshot = { documentReady: 'complete', ride: true, windowManager: true,
    splashVisible: false, activeTabs: 1, session: { promptType: 1, model: true } };
  app.client = { execute: async () => snapshot };
  app.markStartupPhase('frontend readiness');
  assert.deepEqual(await app.readFrontendSnapshot(), snapshot);
  app.markStartupPhase('splash readiness');
  app.client.execute = async () => { throw new Error('execute callback timed out'); };
  await assert.rejects(app.readFrontendSnapshot(), /execute callback timed out/);
  const state = app.startupState();
  assert.equal(state.phase, 'splash readiness');
  assert.deepEqual(state.lastFrontend, snapshot);
  assert.equal(state.pid, null);
  assert.equal(state.running, false);
  assert.ok(state.elapsedMs >= 0);
  assert.ok(state.lastFrontendAtMs >= 0);
});

test('startup diagnostics retain bounded evidence and sample only the live owned child before cleanup', async () => {
  const app = new TauriApplication({ src: 'cn' });
  app.child = { pid: 12345, exitCode: null, signalCode: null };
  app.markStartupPhase('session prompt readiness');
  app.lastFrontend = { session: { promptType: 0, model: true } };
  app.output = 'app output';
  const failure = new Error('execute request 119 timed out');
  const events = [];
  app.sampleNativeProcess = async directory => {
    events.push(['sample', app.isRunning(), app.child.pid]);
    fs.writeFileSync(path.join(directory, 'native-sample.txt'), 'owned process thread sample');
    return { status: 'captured', file: 'native-sample.txt' };
  };
  try {
    await app.captureStartupFailure(failure);
    assert.deepEqual(events, [['sample', true, 12345]]);
    assert.match(failure.message, /^execute request 119 timed out/);
    assert.match(failure.message, /session prompt readiness/);
    assert.match(failure.message, /PID 12345.*running=true/);
    assert.match(failure.message, /diagnostics:/);
    const evidence = JSON.parse(fs.readFileSync(path.join(app.diagnosticDirectory, 'startup.json'), 'utf8'));
    assert.equal(evidence.phase, 'session prompt readiness');
    assert.equal(evidence.running, true);
    assert.deepEqual(evidence.lastFrontend, app.lastFrontend);
    assert.equal(evidence.sample.status, 'captured');
    assert.equal(fs.readFileSync(path.join(app.diagnosticDirectory, 'native-sample.txt'), 'utf8'), 'owned process thread sample');
    assert.equal(fs.readFileSync(path.join(app.diagnosticDirectory, 'app-output.txt'), 'utf8'), 'app output');
  } finally { fs.rmSync(app.diagnosticDirectory, { recursive: true, force: true }); }
});

test('sampling errors annotate startup failure without replacing its original message', async () => {
  const app = new TauriApplication({ src: 'cn' });
  app.child = { pid: 12345, exitCode: null, signalCode: null };
  app.markStartupPhase('splash readiness');
  app.output = 'x'.repeat(30000);
  app.sampleNativeProcess = async () => { throw new Error('sample permission denied'); };
  const failure = new Error('element request 118 timed out');
  try {
    await app.captureStartupFailure(failure);
    assert.match(failure.message, /^element request 118 timed out/);
    const evidence = JSON.parse(fs.readFileSync(path.join(app.diagnosticDirectory, 'startup.json'), 'utf8'));
    assert.match(evidence.sample.error, /sample permission denied/);
    assert.ok(fs.statSync(path.join(app.diagnosticDirectory, 'app-output.txt')).size <= 24000);
  } finally { fs.rmSync(app.diagnosticDirectory, { recursive: true, force: true }); }
});

test('native sampling validates ownership and bounds its macOS command and retained text', async () => {
  const { sampleNativeProcess } = require('../test/_tauri');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride-sample-fixture-'));
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    fs.writeFileSync(path.join(directory, 'native-sample.txt'), 's'.repeat(200000));
    return { stdout: '', stderr: '' };
  };
  try {
    for (const child of [null, { pid: process.pid, exitCode: null, signalCode: null },
      { pid: 1, exitCode: null, signalCode: null }, { pid: 12345, exitCode: 0, signalCode: null }]) {
      const result = await sampleNativeProcess(child, directory, { platform: 'darwin', run });
      assert.equal(result.status, 'skipped');
    }
    assert.equal(calls.length, 0);
    const result = await sampleNativeProcess({ pid: 12345, exitCode: null, signalCode: null }, directory,
      { platform: 'darwin', run });
    assert.equal(result.status, 'captured');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/usr/bin/sample');
    assert.deepEqual(calls[0].args, ['12345', '1', '1', '-file', path.join(directory, 'native-sample.txt')]);
    assert.equal(calls[0].options.timeout, 4000);
    assert.ok(calls[0].options.maxBuffer <= 131072);
    assert.ok(fs.statSync(path.join(directory, 'native-sample.txt')).size <= 131072);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('frontend snapshot contains readiness and geometry without source text or environment', () => {
  const vm = require('node:vm');
  const { frontendSnapshot } = require('../test/_tauri');
  const model = { getValue() { throw new Error('must not read frontend source'); } };
  const snapshot = vm.runInNewContext(`(${frontendSnapshot.toString()})()`, {
    window: { __RIDE__: {}, D: { wm: {}, ide: { connected: true, dead: false, wins: {
      0: { promptType: 1, me: { getModel: () => model,
        getLayoutInfo: () => ({ width: 800, height: 500, extra: 'private' }) } },
    } } } },
    document: { readyState: 'complete', getElementById: () => ({ hidden: true,
      getClientRects: () => [] }), querySelectorAll: selector => selector === '.dlg' ? [] : [{}] },
    getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    documentReady: 'complete', ride: true, windowManager: true, splashVisible: false, connectionVisible: false, visibleDialogs: [], activeTabs: 1,
    session: { promptType: 1, model: true, connected: true, dead: false, layout: { width: 800, height: 500 } },
  });
});

test('failure-only direct probe uses a bounded callback request to the owned main webview', async () => {
  const { readStartupProbe } = require('../test/_tauri');
  const server = http.createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/wdio/eval');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.window_label, 'main');
    assert.equal(body.timeout_ms, 1500);
    assert.match(body.script, /arguments\[arguments.length - 1\]/);
    assert.doesNotMatch(body.script, /__wd_temp_|__wdio_exec_/);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ value: { documentReady: 'complete', activeTabs: 1,
      splashVisible: false } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await readStartupProbe(server.address().port);
    assert.equal(result.status, 'captured');
    assert.equal(result.snapshot.documentReady, 'complete');
    assert.equal(result.snapshot.splashVisible, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('failure-only direct probe HTTP abort bounds a stalled diagnostic endpoint', async () => {
  const { readStartupProbe } = require('../test/_tauri');
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const started = Date.now();
  try {
    const result = await readStartupProbe(server.address().port);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /timeout|aborted/i);
    assert.ok(Date.now() - started < 3000, 'Diagnostic request must not hold up cleanup');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

async function withStartupFixture(scenario, action) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride-startup-fixture-'));
  const binary = path.join(fixture, 'fixture-app');
  const events = path.join(fixture, 'requests.jsonl');
  fs.writeFileSync(binary, `#!${process.execPath}
    const http = require('node:http');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const scenario = ${JSON.stringify(scenario)};
    let reads = 0;
    const record = value => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify(value) + '\\n');
    const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      record({ path: req.url, method: req.method, timeout: body.timeout_ms, quit: String(body.script).includes('quit_all') });
      if (req.url === '/status') return send(res, 200, { value: { ready: true } });
      if (req.url === '/session') return send(res, 200, { value: { sessionId: 'fixture', capabilities: { browserName: 'wry' } } });
      if (req.method === 'GET' && req.url === '/session/fixture/window') return send(res, 200, { value: 'main' });
      if (req.url === '/wdio/eval' || req.url.endsWith('/execute/sync') && !String(body.script).includes('quit_all')) {
        const direct = req.url === '/wdio/eval';
        if (scenario.nativeDialog && !direct) {
          const line = '[ui-test-dialog] ' + JSON.stringify(scenario.nativeDialog) + '\\n';
          process.stderr.write(line.slice(0, 17));
          setTimeout(() => process.stderr.write(line.slice(17)), 10);
          return;
        }
        const index = reads++;
        if (scenario.stall && !direct) return;
        if (scenario.error && !direct) return send(res, 500, { value: { error: 'javascript error', message: scenario.error } });
        if (scenario.malformed && !direct) return send(res, 200, { value: scenario.malformed });
        const state = (scenario.states || [])[index] || { documentReady: 'complete', ride: true,
          windowManager: true, splashVisible: false, activeTabs: 1, promptType: 1, model: true };
        const session = { promptType: state.promptType, me: { getModel: () => { if (scenario.scriptError) throw new Error(scenario.scriptError); return state.model ? {} : null; },
          getLayoutInfo: () => ({ width: 800, height: 500 }) } };
        const context = { window: { __RIDE__: state.ride ? {} : null, D: {
          wm: state.windowManager ? {} : null, ide: scenario.connection ? null : { connected: true, wins: { 0: session } } } },
          document: { readyState: state.documentReady,
            getElementById: id => id === 'splash' ? ({ hidden: !state.splashVisible, getClientRects: () => state.splashVisible ? [{}] : [] }) : null,
            querySelectorAll: selector => selector === '.dlg' ? [] : Array(scenario.connection ? 0 : state.activeTabs).fill({}) },
          getComputedStyle: () => ({ display: state.splashVisible ? 'block' : 'none', visibility: 'visible' }) };
        try {
          const fn = vm.runInNewContext('(function(){' + body.script + '})', context);
          record({ snapshot: state, direct });
          if (direct) fn(result => send(res, result.ok ? 200 : 500, result.ok ? { value: result.value } : { error: result.error }));
          else send(res, 200, { value: fn(...(body.args || [])) });
        } catch (error) { send(res, 500, direct ? { error: error.message } : { value: { error: 'javascript error', message: error.message } }); }
        return;
      }
      if (req.url.endsWith('/execute/sync') && String(body.script).includes('quit_all')) {
        send(res, 200, { value: null });
        setTimeout(() => process.exit(0), 20);
        return;
      }
      if (req.url.includes('/execute/') || req.url.includes('/element')) {
        record({ ordinaryReadHeld: true });
        return;
      }
      if (req.method === 'DELETE' && req.url === '/session/fixture') return send(res, 200, { value: null });
      send(res, 404, { value: { error: 'unknown command', message: 'Unexpected fixture route: ' + req.url } });
    });
    server.listen(Number(process.env.TAURI_WEBDRIVER_PORT), '127.0.0.1');
    process.stdin.resume();
    process.stdin.on('end', () => { record({ ownershipEOF: true }); process.exit(0); });
  `, { mode: 0o755 });
  const previous = process.env.RIDE_TEST_BINARY;
  process.env.RIDE_TEST_BINARY = binary;
  const app = new TauriApplication({ src: scenario.connection ? 'cn' : 'se' });
  app.sampleNativeProcess = async () => ({ status: 'skipped', reason: 'unit fixture' });
  const readEvents = () => fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse) : [];
  try { await action(app, readEvents); } finally {
    try { await app.stop(); } finally {
      if (app.diagnosticDirectory) fs.rmSync(app.diagnosticDirectory, { recursive: true, force: true });
      if (previous === undefined) delete process.env.RIDE_TEST_BINARY;
      else process.env.RIDE_TEST_BINARY = previous;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }
}

test('startup uses ordinary WebDriver snapshots and quit with no DirectEval readiness workaround', { skip: process.platform === 'win32' }, async () => {
  await withStartupFixture({}, async (app, events) => {
    await app.start();
    assert.equal(app.startupPhase, 'ready');
    assert.equal(app.isRunning(), true);
    assert.equal(events().filter(e => e.snapshot && !e.direct).length, 4);
    assert.equal(events().filter(e => e.path === '/wdio/eval').length, 0);
    assert.equal(events().some(e => e.ordinaryReadHeld), false);
    await app.stop();
    assert.equal(app.isRunning(), false);
    assert.equal(fs.existsSync(app.userData), false);
    assert.ok(events().some(e => e.path && e.path.endsWith('/execute/sync') && e.quit), 'Quit stays on ordinary WebDriver');
  });
});

test('startup polls only false readiness and preserves all four readiness gates', { skip: process.platform === 'win32' }, async () => {
  const ready = { documentReady: 'complete', ride: true, windowManager: true,
    splashVisible: false, activeTabs: 1, promptType: 1, model: true };
  const states = [
    { ...ready, ride: false }, { ...ready, windowManager: false }, { ...ready, documentReady: 'loading' }, ready,
    { ...ready, splashVisible: true }, ready,
    { ...ready, activeTabs: 0 }, ready,
    { ...ready, promptType: 0 }, { ...ready, model: false }, ready,
  ];
  await withStartupFixture({ states }, async (app, events) => {
    await app.start();
    assert.equal(events().filter(e => e.snapshot).length, states.length);
    assert.equal(events().some(e => e.ordinaryReadHeld), false);
    assert.equal(app.lastFrontend.session.promptType, 1);
    assert.equal(app.lastFrontend.session.model, true);
  });
});

for (const scenario of [{ error: 'fixture HTTP execution failed' }, { scriptError: 'fixture model getter failed' },
  { malformed: { documentReady: 'complete' } }]) {
  test(`startup ${scenario.error ? 'HTTP failure' : scenario.scriptError ? 'script failure' : 'malformed snapshot'} fails without readiness retries and cleans up`, { skip: process.platform === 'win32' }, async () => {
    await withStartupFixture(scenario, async (app, events) => {
      await assert.rejects(app.start(), scenario.error ? /fixture HTTP execution failed/ : scenario.scriptError ? /fixture model getter failed/ : /Invalid startup snapshot/);
      assert.equal(app.isRunning(), false);
      assert.equal(fs.existsSync(app.userData), false);
      const reads = events().filter(e => e.path === '/wdio/eval');
      assert.equal(reads.length, 1, 'Only the failure-only diagnostic probe uses DirectEval');
      assert.equal(reads[0].timeout, 1500);
      assert.equal(events().filter(e => e.path && e.path.endsWith('/execute/sync') && !e.quit).length, 1);
      assert.equal(events().some(e => e.ordinaryReadHeld), false);
    });
  });
}

test('startup phase deadline rejects false readiness instead of weakening its guard', async () => {
  const app = new TauriApplication({ src: 'se' });
  let reads = 0;
  app.readFrontendSnapshot = async () => { reads += 1; return { activeTabs: 0 }; };
  const started = Date.now();
  await assert.rejects(app.waitForFrontend(state => state.activeTabs > 0, 'IDE did not become ready', 60), /IDE did not become ready/);
  assert.ok(reads > 0);
  assert.ok(Date.now() - started < 500);
});

test('connection startup uses only document and splash gates without a Session', { skip: process.platform === 'win32' }, async () => {
  await withStartupFixture({ connection: true }, async (app, events) => {
    await app.start();
    assert.equal(app.startupPhase, 'ready');
    assert.equal(app.lastFrontend.session, null);
    assert.equal(app.lastFrontend.activeTabs, 0);
    assert.equal(events().filter(e => e.snapshot && !e.direct).length, 2);
    assert.equal(events().filter(e => e.path === '/wdio/eval').length, 0);
    assert.equal(events().some(e => e.ordinaryReadHeld), false);
  });
});


test('native startup dialog preempts a held ordinary read and exits through its ownership pipe', { skip: process.platform === 'win32' }, async () => {
  const nativeDialog = { title: 'Error', message: 'Interpreter exited with code 23', detail: 'fixture failure', buttons: ['OK'] };
  await withStartupFixture({ nativeDialog }, async (app, events) => {
    const started = Date.now();
    await assert.rejects(app.start(), error => {
      assert.match(error.message, /Interpreter exited with code 23/);
      assert.match(error.message, /Startup phase: frontend readiness/);
      assert.match(error.message, /Startup diagnostics:/);
      const evidence = JSON.parse(fs.readFileSync(path.join(error.startupDiagnosticsDirectory, 'startup.json'), 'utf8'));
      assert.deepEqual(evidence.nativeDialog, nativeDialog);
      assert.equal(evidence.running, true);
      return true;
    });
    assert.ok(Date.now() - started < 4000, 'Alert failure does not wait for a blocked 10-second WebDriver request');
    assert.equal(app.isRunning(), false);
    assert.equal(fs.existsSync(app.userData), false);
    assert.equal(events().filter(e => e.path && e.path.endsWith('/execute/sync') && !e.quit).length, 1);
    assert.equal(events().some(e => e.quit), false, 'Modal cleanup does not dispatch blocked JavaScript');
    assert.equal(events().some(e => e.ownershipEOF), true);
  });
});

test('startup dialog parsing preserves split UTF-8 and ignores alerts after ready', async () => {
  const app = new TauriApplication();
  app.markStartupPhase('session prompt readiness');
  const dialog = { title: '⍺', message: 'Interpreter exited with code 23', detail: '⍳ failure', buttons: ['OK'] };
  const line = Buffer.from('[ui-test-dialog] ' + JSON.stringify(dialog) + '\n');
  const split = line.indexOf(Buffer.from('⍺')) + 1;
  app.observeStartupStderr(line.subarray(0, split));
  assert.equal(app.nativeDialog, undefined);
  app.observeStartupStderr(line.subarray(split));
  assert.deepEqual(app.nativeDialog, dialog);
  const ready = new TauriApplication();
  ready.markStartupPhase('ready');
  ready.observeStartupStderr(line);
  assert.equal(ready.nativeDialog, undefined);
});

test('CEF defaults off in test children and preserves explicit interpreter overrides', () => {
  assert.equal(isolatedEnv('/tmp/profile', 4567, {}, {}).ENABLE_CEF, '0');
  assert.equal(isolatedEnv('/tmp/profile', 4567, {}, { ENABLE_CEF: '1' }).ENABLE_CEF, '1');
  assert.equal(isolatedEnv('/tmp/profile', 4567, {}, { ENABLE_CEF: '0' }).ENABLE_CEF, '0');
});

test('startup alert survives coalesced large stderr chunks while unfinished lines stay bounded', () => {
  const app = new TauriApplication();
  app.markStartupPhase('IDE tab readiness');
  const dialog = { title: '\u0001'.repeat(256), message: '\u0001'.repeat(1024),
    detail: '\u0001'.repeat(1024), buttons: Array(8).fill('\u0001'.repeat(64)), type: '\u0001'.repeat(32) };
  const line = '[ui-test-dialog] ' + JSON.stringify(dialog) + '\n';
  assert.ok(Buffer.byteLength(line) > 17000 && Buffer.byteLength(line) < 20000);
  app.observeStartupStderr(Buffer.from('earlier log\n' + line + 'later unrelated log'.repeat(4000) + '\n'));
  assert.deepEqual(app.nativeDialog, dialog);
  const unfinished = new TauriApplication();
  unfinished.markStartupPhase('frontend readiness');
  unfinished.observeStartupStderr(Buffer.from('unrelated'.repeat(10000)));
  assert.ok(unfinished.startupStderr.length <= 20000);
  unfinished.observeStartupStderr(Buffer.from('\n' + line));
  assert.deepEqual(unfinished.nativeDialog, dialog);
});
