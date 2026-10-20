const test = require('ava');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { Key } = require('webdriverio');
const { TauriApplication } = require('./_tauri');
const processes = require('./_processes');

const macTest = process.platform === 'darwin' ? test : test.skip;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

async function listening(port, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
    })) return;
    await delay(200);
  }
  throw new Error(`No interpreter is serving RIDE on port ${port}`);
}

macTest('quitting Tauride leaves running an interpreter it connected to but did not start', async t => {
  const port = await freePort();
  const wrapper = spawn(process.env.RIDE_TEST_DYALOG || 'dyalog', ['+s', '-q', '-nokbd'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, RIDE_INIT: `SERVE:127.0.0.1:${port}`, ENABLE_CEF: '0' },
  });
  const owned = [await processes.track(wrapper.pid)];
  t.teardown(() => Promise.all(owned.map(processes.cleanup)));
  await listening(port);
  const interpreter = Number(execFileSync('pgrep', ['-P', String(wrapper.pid)]).toString().trim().split(/\s+/)[0]);
  owned.push(await processes.track(interpreter));

  const app = new TauriApplication({ src: 'se', RIDE_CONNECT: `127.0.0.1:${port}` });
  t.teardown(() => app.stop());
  await app.start();
  const c = app.client;
  await c.waitUntil(() => c.execute(() => D.ide && D.ide.connected && D.ide.promptType === 1), { timeout: 15000 });
  t.false(await c.execute(() => !!D.spawned), 'Tauride connected to the interpreter rather than starting it');
  t.is(await c.execute(() => Number(D.remoteIdentification.pid)), interpreter, 'Tauride is connected to the external interpreter');
  await c.execute(() => D.prf.sqp(0));
  await c.waitUntil(async () => c.execute(async () => {
    const win = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
    await win.setFocus();
    return (await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label: win.label })).focused;
  }), { timeout: 10000 });
  try {
    await c.execute(chord => window.__TAURI_INTERNALS__.invoke('ui_test_keys', { keys: chord }), [Key.Command, 'q']);
  } catch (_) { /* App quit can end the RPC. */ }
  await c.waitUntil(() => !app.isRunning(), { timeout: 15000, timeoutMsg: 'Tauride did not exit after Quit' });
  t.is(app.child.exitCode, 0, 'Cmd-Q exits Tauride successfully');
  await delay(3000);
  t.true(await processes.alive(owned[1]), 'the interpreter Tauride did not start is still running');
  t.true(await processes.alive(owned[0]), 'its launcher is still running');
  await listening(port, 3000);
  t.pass('the interpreter still serves RIDE');
});
