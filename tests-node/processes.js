const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const processes = require('../test/_processes');

const posix = ['darwin', 'linux'].includes(process.platform);

async function childProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await once(child, 'spawn');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  return child;
}

test('tracked process reports a leak before cleanup and disappears after cleanup', { skip: !posix }, async t => {
  const child = await childProcess(t);
  const owned = await processes.track(child.pid);
  assert.equal(owned.pid, child.pid);
  assert.equal(await processes.alive(owned), true);
  await assert.rejects(processes.waitForExit(owned, 20), /survived session close/);
  await processes.cleanup(owned);
  assert.equal(await processes.alive(owned), false);
  await processes.waitForExit(owned, 20);
  await processes.cleanup(owned);
});

test('cleanup leaves a live PID alone when its recorded process identity differs', { skip: !posix }, async t => {
  const child = await childProcess(t);
  const owned = await processes.track(child.pid);
  const stale = { ...owned, started: `${owned.started} stale identity` };
  assert.equal(await processes.alive(stale), false);
  await processes.waitForExit(stale, 20);
  await processes.cleanup(stale);
  assert.equal(await processes.alive(owned), true);
});

test('naturally exited process needs no cleanup and cannot be newly tracked', { skip: !posix }, async t => {
  const child = await childProcess(t);
  const owned = await processes.track(child.pid);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  await processes.waitForExit(owned);
  await processes.cleanup(owned);
  await assert.rejects(processes.track(child.pid), /exited before it could be tracked/);
});

test('process ownership rejects the test runner and invalid PIDs', async () => {
  for (const pid of [process.pid, 0, 1, -1, NaN, '123', 1.5]) {
    await assert.rejects(processes.track(pid), /Invalid interpreter PID/);
  }
});
