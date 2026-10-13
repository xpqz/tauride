const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error(`Invalid interpreter PID: ${pid}`);
  }
  try {
    const { stdout } = await run('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm=']);
    return stdout.trim() || null;
  } catch (error) {
    if (error.code === 1 && !String(error.stdout || '').trim()) return null;
    throw error;
  }
}

async function track(pid) {
  const started = await identity(pid);
  if (!started) throw new Error(`Interpreter ${pid} exited before it could be tracked`);
  return { pid, started };
}

async function alive(owned) {
  return await identity(owned.pid) === owned.started;
}

async function waitForExit(owned, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (await alive(owned)) {
    if (Date.now() >= deadline) throw new Error(`Interpreter ${owned.pid} survived session close (${owned.started})`);
    await delay(100);
  }
}

async function cleanup(owned) {
  if (!await alive(owned)) return;
  // Dyalog serving RIDE ignores SIGTERM. Only the recorded test process is killed.
  try { process.kill(owned.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await waitForExit(owned, 3000);
}

module.exports = { track, alive, waitForExit, cleanup };
