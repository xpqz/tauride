const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

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

async function waitForStatus(port, child, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastStatus = 'no status response';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Tauride exited before WebDriver became ready');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1000) });
      const body = await response.text();
      lastStatus = `HTTP ${response.status}: ${body.slice(0, 500)}`;
      if (response.ok && JSON.parse(body).value.ready) return;
    } catch (error) {
      const cause = error.cause || error;
      lastStatus = `${error.message}${cause.code ? ` (${cause.code})` : ''}`;
    }
    await delay(100);
  }
  throw new Error(`Tauride WebDriver did not become ready on port ${port}; build with --features ui-tests; last status: ${lastStatus}`);
}

class TauriApplication {
  constructor(options = {}) {
    this.options = options;
    this.output = '';
    this.client = null;
    this.child = null;
  }

  isRunning() { return !!this.child && !!this.child.pid && this.child.exitCode === null && this.child.signalCode === null; }

  async start() {
    this.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride-test-'));
    const prefs = path.join(this.userData, 'Ride-4.8');
    fs.mkdirSync(prefs);
    fs.writeFileSync(path.join(prefs, 'prefs.json'), JSON.stringify({ sqp: '0' }));
    active.add(this);
    try {
      const port = await freePort();
      this.child = spawn(binaryPath(), [], {
        cwd: root,
        env: isolatedEnv(this.userData, port, this.options),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let spawnError;
      this.child.once('error', (error) => { spawnError = error; });
      for (const stream of [this.child.stdout, this.child.stderr]) {
        stream.on('data', (data) => { this.output = (this.output + data).slice(-24000); });
      }
      await delay(0);
      if (spawnError) throw spawnError;
      await waitForStatus(port, this.child, this.options.timeout);
      const { remote } = require('webdriverio');
      this.client = await remote({
        hostname: '127.0.0.1', port, path: '/',
        capabilities: { browserName: 'wry', 'wdio:tauriServiceOptions': { windowLabel: 'main' } },
        connectionRetryCount: 0, connectionRetryTimeout: 10000,
        waitforTimeout: 10000, logLevel: 'silent',
      });
      await this.client.waitUntil(async () => this.client.execute(() =>
        !!window.__RIDE__ && !!window.D && !!D.wm && document.readyState === 'complete'),
      { timeout: 30000, timeoutMsg: 'Tauride main webview did not load' });
      await (await this.client.$('#splash')).waitForDisplayed({ timeout: 30000, reverse: true });
      if (this.options.src !== 'cn') {
        await (await this.client.$('#ide .lm_tab.lm_active')).waitForExist({ timeout: 30000 });
        await this.client.waitUntil(async () => this.client.execute(() => {
          const session = D.ide && D.ide.wins[0];
          return !!session && session.promptType === 1 && !!session.me.getModel();
        }), { timeout: 30000, timeoutMsg: 'Dyalog session did not become ready for input' });
      }
      return this;
    } catch (error) {
      await this.stop();
      error.message += `\n${this.output}`;
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
    if (this.isRunning() && this.client) {
      try { await this.client.execute(() => window.__TAURI_INTERNALS__.invoke('quit_all')); } catch (_) { /* Closing the webview can end the command. */ }
    }
    const wait = async (ms) => {
      const deadline = Date.now() + ms;
      while (this.isRunning() && Date.now() < deadline) await delay(50);
    };
    if (this.client) await wait(5000);
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

module.exports = { TauriApplication, resolveDyalog, binaryPath, isolatedEnv, waitForStatus, readClipboard };
