const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { StringDecoder } = require('node:string_decoder');

const root = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const active = new Set();

function resolveDyalog(env = process.env) {
  const name = env.RIDE_TEST_DYALOG || 'dyalog';
  const candidates = path.isAbsolute(name) || name.includes(path.sep)
    ? [path.resolve(root, name)]
    : (env.PATH || '').split(path.delimiter).flatMap((dir) =>
      process.platform === 'win32' ? [path.join(dir, name), path.join(dir, `${name}.exe`)] : [path.join(dir, name)]);
  const executable = candidates.find((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch (_) { return false; }
  });
  if (!executable) throw new Error(`Dyalog executable not found: ${name}; set RIDE_TEST_DYALOG`);
  return executable;
}

function binaryPath(env = process.env) {
  if (env.RIDE_TEST_BINARY) return path.resolve(root, env.RIDE_TEST_BINARY);
  const target = env.CARGO_TARGET_DIR
    ? path.resolve(root, env.CARGO_TARGET_DIR) : path.join(root, 'src-tauri', 'target', 'ui-tests');
  return path.join(target, 'debug', process.platform === 'win32' ? 'tauride.exe' : 'tauride');
}

function isolatedEnv(userData, port, options = {}, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith('RIDE_')));
  Object.assign(env, {
    XDG_CONFIG_HOME: userData,
    APPDATA: userData,
    ENABLE_CEF: inherited.ENABLE_CEF === undefined ? '0' : inherited.ENABLE_CEF,
    LOG_FILE: path.join(userData, 'dyalog*.dlf'),
    TAURI_WEBDRIVER_PORT: String(port),
    TAURI_UI_TEST_STDIN: '1',
  });
  if (options.interpreter || options.RIDE_SPAWN) env.RIDE_SPAWN = resolveDyalog(inherited);
  return env;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForStatus(port, child, timeout = 30000, checkFailure = () => {}) {
  const deadline = Date.now() + timeout;
  let lastStatus = 'no status response';
  while (Date.now() < deadline) {
    checkFailure();
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Tauride exited before WebDriver became ready');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1000) });
      const body = await response.text();
      lastStatus = `HTTP ${response.status}: ${body.slice(0, 500)}`;
      if (response.ok && JSON.parse(body).value.ready) { checkFailure(); return; }
    } catch (error) {
      const cause = error.cause || error;
      lastStatus = `${error.message}${cause.code ? ` (${cause.code})` : ''}`;
    }
    checkFailure();
    await delay(100);
  }
  checkFailure();
  throw new Error(`Tauride WebDriver did not become ready on port ${port}; build with --features ui-tests; last status: ${lastStatus}`);
}

async function sampleNativeProcess(child, directory, { platform = process.platform, run = promisify(execFile) } = {}) {
  if (platform !== 'darwin') return { status: 'skipped', reason: 'native sampling requires macOS' };
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 1 || child.pid === process.pid
    || child.exitCode !== null || child.signalCode !== null) {
    return { status: 'skipped', reason: 'owned app process is not running' };
  }
  const file = path.join(directory, 'native-sample.txt');
  let result;
  try {
    await run('/usr/bin/sample', [String(child.pid), '1', '1', '-file', file],
      { timeout: 4000, maxBuffer: 131072, encoding: 'utf8' });
    result = { status: 'captured', file: path.basename(file) };
  } catch (error) {
    result = { status: 'failed', error: String(error.message).slice(0, 2000) };
  }
  if (fs.existsSync(file)) {
    const fd = fs.openSync(file, 'r');
    const text = Buffer.alloc(131072);
    let length;
    try { length = fs.readSync(fd, text, 0, text.length, 0); } finally { fs.closeSync(fd); }
    fs.writeFileSync(file, text.subarray(0, length));
    result.file = path.basename(file);
  }
  return result;
}

function frontendSnapshot() {
  const visible = element => !!element && !element.hidden && getComputedStyle(element).display !== 'none'
    && getComputedStyle(element).visibility !== 'hidden' && !!element.getClientRects().length;
  const ide = window.D && window.D.ide;
  const session = ide && ide.wins && ide.wins[0];
  const model = session && session.me && typeof session.me.getModel === 'function' && session.me.getModel();
  const layout = session && session.me && typeof session.me.getLayoutInfo === 'function' && session.me.getLayoutInfo();
  return {
    documentReady: document.readyState,
    ride: !!window.__RIDE__, windowManager: !!(window.D && window.D.wm),
    splashVisible: visible(document.getElementById('splash')),
    connectionVisible: visible(document.getElementById('cn')),
    visibleDialogs: [...document.querySelectorAll('.dlg')].filter(visible).slice(0, 20).map(element => element.id || null),
    activeTabs: document.querySelectorAll('#ide .lm_tab.lm_active').length,
    session: session ? { promptType: session.promptType, model: !!model,
      connected: !!ide.connected, dead: !!ide.dead, layout: layout && { width: layout.width, height: layout.height } } : null,
  };
}

async function directEval(port, script, scriptTimeoutMs, requestTimeoutMs) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('No owned driver port');
  const response = await fetch(`http://127.0.0.1:${port}/wdio/eval`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(requestTimeoutMs),
    body: JSON.stringify({ script, window_label: 'main', timeout_ms: scriptTimeoutMs }),
  });
  const text = await response.text();
  if (text.length > 16384) throw new Error('DirectEval response exceeded 16 KiB');
  const result = JSON.parse(text);
  if (!response.ok || result.error) throw new Error(`DirectEval HTTP ${response.status}: ${String(result.error || 'no snapshot').slice(0, 1000)}`);
  return result.value;
}

function snapshotScript() {
  return `const done = arguments[arguments.length - 1];
    try { done({ ok: true, value: { ...(${frontendSnapshot.toString()})() } }); }
    catch (error) { done({ ok: false, error: error.message || String(error) }); }`;
}

function validateStartupSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.documentReady !== 'string' || typeof snapshot.ride !== 'boolean'
    || typeof snapshot.windowManager !== 'boolean' || typeof snapshot.splashVisible !== 'boolean'
    || !Number.isSafeInteger(snapshot.activeTabs) || snapshot.activeTabs < 0
    || !(snapshot.session === null || snapshot.session && typeof snapshot.session.promptType === 'number'
      && typeof snapshot.session.model === 'boolean')) {
    throw new Error('Invalid startup snapshot from WebDriver');
  }
  return snapshot;
}

async function readStartupProbe(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { status: 'skipped', reason: 'no owned driver port' };
  try {
    const snapshot = await directEval(port, snapshotScript(), 1500, 2000);
    if (!snapshot) throw new Error('DirectEval returned no diagnostic snapshot');
    return { status: 'captured', snapshot };
  } catch (error) { return { status: 'failed', error: String(error.message).slice(0, 1000) }; }
}

class TauriApplication {
  constructor(options = {}) {
    this.options = options;
    this.output = '';
    this.client = null;
    this.child = null;
    this.startupStartedAt = Date.now();
    this.startupStderr = '';
    this.startupStderrDecoder = new StringDecoder('utf8');
    this.nativeDialogSignal = new Promise(resolve => { this.reportNativeDialog = resolve; });
    this.markStartupPhase('not started');
  }

  isRunning() { return !!this.child && !!this.child.pid && this.child.exitCode === null && this.child.signalCode === null; }

  markStartupPhase(phase) {
    this.startupPhase = phase;
    this.startupPhaseAt = Date.now();
  }

  startupState() {
    return { phase: this.startupPhase, elapsedMs: Date.now() - this.startupStartedAt,
      phaseElapsedMs: Date.now() - this.startupPhaseAt,
      pid: this.child && this.child.pid || null, running: this.isRunning(),
      exitCode: this.child && this.child.exitCode, signalCode: this.child && this.child.signalCode,
      nativeDialog: this.nativeDialog || null,
      lastFrontendAtMs: this.lastFrontendAtMs ?? null, lastFrontend: this.lastFrontend || null };
  }

  observeStartupStderr(data) {
    if (this.startupPhase === 'ready' || this.nativeDialog) return;
    this.startupStderr = (this.startupStderr + this.startupStderrDecoder.write(data));
    let newline;
    while ((newline = this.startupStderr.indexOf('\n')) >= 0) {
      const line = this.startupStderr.slice(0, newline);
      this.startupStderr = this.startupStderr.slice(newline + 1);
      if (line.length > 20000 || !line.startsWith('[ui-test-dialog] ')) continue;
      let dialog;
      try { dialog = JSON.parse(line.slice('[ui-test-dialog] '.length)); } catch (_) { continue; }
      if (!dialog || typeof dialog.message !== 'string') continue;
      this.nativeDialog = dialog;
      this.nativeDialogError = new Error(`Unexpected native dialog during startup: ${dialog.message}`
        + (dialog.detail ? `\n${dialog.detail}` : ''));
      this.reportNativeDialog(this.nativeDialogError);
      this.startupStderr = '';
      return;
    }
    this.startupStderr = this.startupStderr.slice(-20000);
  }

  checkStartupDialog() {
    if (this.nativeDialogError) throw this.nativeDialogError;
  }

  async startupRead(read) {
    this.checkStartupDialog();
    return Promise.race([Promise.resolve().then(read), this.nativeDialogSignal.then(error => { throw error; })]);
  }

  async readFrontendSnapshot() {
    const snapshot = validateStartupSnapshot(await this.startupRead(() => this.client.execute(frontendSnapshot)));
    this.lastFrontend = snapshot;
    this.lastFrontendAtMs = Date.now() - this.startupStartedAt;
    return snapshot;
  }

  async waitForFrontend(predicate, message, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      this.checkStartupDialog();
      const snapshot = await this.readFrontendSnapshot();
      if (Date.now() < deadline && predicate(snapshot)) return;
      await delay(Math.max(0, Math.min(100, deadline - Date.now())));
    }
    throw new Error(message);
  }

  sampleNativeProcess(directory) { return sampleNativeProcess(this.child, directory); }

  async captureStartupFailure(error) {
    const state = this.startupState();
    this.diagnosticDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride-startup-diagnostics-'));
    state.directProbe = this.isRunning() ? await readStartupProbe(this.driverPort)
      : { status: 'skipped', reason: 'owned app process is not running' };
    try { state.sample = await this.sampleNativeProcess(this.diagnosticDirectory); } catch (failure) {
      state.sample = { status: 'failed', error: String(failure.message).slice(0, 2000) };
    }
    fs.writeFileSync(path.join(this.diagnosticDirectory, 'startup.json'), JSON.stringify(state, null, 2));
    fs.writeFileSync(path.join(this.diagnosticDirectory, 'app-output.txt'), Buffer.from(this.output).subarray(-24000));
    error.startupDiagnosticsDirectory = this.diagnosticDirectory;
    error.message += `\nStartup phase: ${state.phase}; elapsed=${state.elapsedMs}ms; phase elapsed=${state.phaseElapsedMs}ms; PID ${state.pid}; running=${state.running}`
      + `\nLast successful frontend snapshot: ${JSON.stringify(state.lastFrontend)}`
      + `\nFailure-only direct probe: ${JSON.stringify(state.directProbe)}`
      + `\nStartup diagnostics: ${this.diagnosticDirectory}`;
  }

  async start() {
    this.startupStartedAt = Date.now();
    this.markStartupPhase('profile setup');
    this.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride-test-'));
    const prefs = path.join(this.userData, 'Ride-4.8');
    fs.mkdirSync(prefs);
    fs.writeFileSync(path.join(prefs, 'prefs.json'), JSON.stringify({ sqp: '0' }));
    active.add(this);
    try {
      this.markStartupPhase('spawn app');
      const port = await freePort();
      this.driverPort = port;
      this.child = spawn(binaryPath(), [], {
        cwd: root,
        env: isolatedEnv(this.userData, port, this.options),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let spawnError;
      this.child.once('error', (error) => { spawnError = error; });
      for (const stream of [this.child.stdout, this.child.stderr]) {
        stream.on('data', (data) => {
          this.output = (this.output + data).slice(-24000);
          if (stream === this.child.stderr) this.observeStartupStderr(data);
        });
      }
      await delay(0);
      if (spawnError) throw spawnError;
      this.markStartupPhase('WebDriver status readiness');
      await waitForStatus(port, this.child, this.options.timeout, () => this.checkStartupDialog());
      const { remote } = require('webdriverio');
      this.markStartupPhase('WebDriver session creation');
      this.client = await this.startupRead(() => remote({
        hostname: '127.0.0.1', port, path: '/',
        capabilities: { browserName: 'wry', 'wdio:tauriServiceOptions': { windowLabel: 'main' } },
        connectionRetryCount: 0, connectionRetryTimeout: 10000,
        waitforTimeout: 10000, logLevel: 'silent',
      }));
      this.markStartupPhase('frontend readiness');
      await this.waitForFrontend(state => state.ride && state.windowManager && state.documentReady === 'complete',
        'Tauride main webview did not load');
      this.markStartupPhase('splash readiness');
      await this.waitForFrontend(state => !state.splashVisible, 'Tauride splash did not close');
      if (this.options.src !== 'cn') {
        this.markStartupPhase('IDE tab readiness');
        await this.waitForFrontend(state => state.activeTabs > 0, 'Tauride IDE tab did not appear');
        this.markStartupPhase('session prompt readiness');
        await this.waitForFrontend(state => !!state.session && state.session.promptType === 1 && state.session.model,
          'Dyalog session did not become ready for input');
      }
      this.markStartupPhase('ready');
      return this;
    } catch (cause) {
      const originalMessage = String(cause.message || cause);
      const error = new Error(originalMessage, { cause });
      error.name = cause.name || 'Error';
      if (cause.stack) error.stack = cause.stack;
      try { await this.captureStartupFailure(error); } catch (failure) {
        error.message += `\nStartup diagnostics failed: ${String(failure.message).slice(0, 2000)}`;
      }
      try { await this.stop(); } catch (failure) {
        error.message += `\nStartup cleanup failed: ${String(failure.message).slice(0, 2000)}`;
      }
      error.message += `\n${this.output}`;
      error.stack += error.message.slice(originalMessage.length);
      throw error;
    }
  }

  async getWindowState() {
    return this.client.execute(async () => {
      const windows = await window.__TAURI__.webviewWindow.getAllWebviewWindows();
      return Promise.all(windows.map((w) =>
        window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label: w.label })));
    });
  }

  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this.cleanup();
    return this.stopping;
  }

  async cleanup() {
    if (this.isRunning() && this.nativeDialog && this.child.stdin) this.child.stdin.end();
    if (this.isRunning() && this.client && !this.nativeDialog) {
      try { await this.client.execute(() => window.__TAURI_INTERNALS__.invoke('quit_all')); } catch (_) { /* Closing the webview can end the command. */ }
    }
    const wait = async (ms) => {
      const deadline = Date.now() + ms;
      while (this.isRunning() && Date.now() < deadline) await delay(50);
    };
    if (this.client) await wait(this.nativeDialog ? 2000 : 5000);
    if (this.isRunning() && this.child.stdin) {
      this.child.stdin.end();
      await wait(2000);
    }
    if (this.isRunning()) {
      if (process.platform === 'win32') {
        try { await promisify(execFile)('taskkill', ['/PID', String(this.child.pid), '/T', '/F']); } catch (_) { /* The app may have exited during taskkill. */ }
      } else this.child.kill('SIGTERM');
      await wait(3000);
    }
    if (this.isRunning()) { this.child.kill('SIGKILL'); await wait(2000); }
    if (this.isRunning()) throw new Error(`Tauride test process ${this.child.pid} did not stop`);
    if (this.client) {
      try { await this.client.deleteSession(); } catch (_) { /* The app owns the server. */ }
    }
    if (this.userData) fs.rmSync(this.userData, { recursive: true, force: true });
    active.delete(this);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await Promise.all([...active].map((app) => app.stop()));
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

async function readClipboard() {
  const run = promisify(execFile);
  if (process.platform === 'darwin') return (await run('pbpaste')).stdout;
  if (process.platform === 'win32') return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Console]::Write((Get-Clipboard -Raw))'])).stdout;
  return (await run(process.env.WAYLAND_DISPLAY ? 'wl-paste' : 'xclip', process.env.WAYLAND_DISPLAY ? ['--no-newline'] : ['-selection', 'clipboard', '-o'])).stdout;
}
TauriApplication.prototype.readClipboard = readClipboard;

module.exports = { TauriApplication, resolveDyalog, binaryPath, isolatedEnv, waitForStatus, readClipboard, sampleNativeProcess, frontendSnapshot, readStartupProbe };
