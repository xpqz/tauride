const path = require('node:path');
const test = require('ava');
const { tfw } = require('./_utils');
const { connect, events } = require('../tools/tauride-mcp/tauride-mcp');

tfw.init({ src: 'se', interpreter: true });

const toast = '.agent-confirm';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitToast(c, text) {
  await c.waitUntil(async () => c.execute((line) => {
    const node = document.querySelector('.agent-confirm');
    return !!node && node.textContent.includes(line);
  }, text), { timeout: 10000, timeoutMsg: `Confirmation for ${text} did not appear` });
}

async function arm(c) {
  await c.execute(() => {
    D.prf.agent(1);
    D.prf.agentConfirm(1);
    D.prf.agentControl(1);
  });
  await c.waitUntil(async () => c.execute(() => D.agent.level() === 'control'),
    { timeout: 10000, timeoutMsg: 'Agent control did not start' });
}

for (const transition of ['socket reconnect', 'control revoke and restore']) {
  test(`obsolete Run toast is cancelled after ${transition}; a fresh request still runs`, async (t) => {
    const c = t.context.app.client;
    await arm(c);
    const socketPath = path.join(t.context.userData, 'Ride-4.8', 'agent',
      process.platform === 'win32' ? 'main.port' : 'main.sock');
    if (process.platform !== 'win32') {
      t.true(socketPath.length < 100, 'run with TMPDIR=/private/tmp to keep the Unix socket path short');
    }
    await c.waitUntil(async () => require('node:fs').existsSync(socketPath),
      { timeout: 10000, timeoutMsg: 'Agent socket did not open' });
    let client = await connect(socketPath);
    t.teardown(() => client.close());
    const oldText = `⎕←'stale-confirm-${Date.now()}'`;
    const old = client.request('execute', { text: oldText }).catch(() => null);
    await waitToast(c, oldText);

    if (transition === 'socket reconnect') {
      client.close();
      await client.closed;
      await c.waitUntil(async () => c.execute(() => !D.agent.connected()),
        { timeout: 10000, timeoutMsg: 'Agent socket cleanup did not reach the session' });
      client = await connect(socketPath);
    } else {
      await c.execute(() => D.prf.agentControl(0));
      await c.waitUntil(async () => c.execute(() => D.agent.level() === 'observe'),
        { timeout: 10000, timeoutMsg: 'Control was not revoked' });
    }
    await c.waitUntil(async () => c.execute(() => !document.querySelector('.agent-confirm')),
      { timeout: 3000, timeoutMsg: 'Obsolete confirmation toast remained visible' });
    if (transition !== 'socket reconnect') await c.execute(() => D.prf.agentControl(1));
    await c.waitUntil(async () => c.execute(() => D.agent.level() === 'control'),
      { timeout: 10000, timeoutMsg: 'Control was not restored' });
    const freshText = `⎕←'fresh-confirm-${Date.now()}'`;
    const fresh = client.request('execute', { text: freshText });
    await waitToast(c, freshText);
    t.false(await c.execute((line) => [...document.querySelectorAll('.agent-confirm')]
      .some((node) => node.textContent.includes(line)), oldText), 'old toast cannot answer the fresh request');
    await (await c.$(`${toast} button:first-of-type`)).click();
    const result = await Promise.race([fresh, sleep(10000).then(() => { throw new Error('Fresh request did not finish'); })]);
    t.true(result.lines.some((line) => line.text.includes('fresh-confirm-')));
    const input = events(await client.request('tail', { n: 1000 }))
      .filter((event) => event.kind === 'input' && event.origin === 'agent');
    t.false(input.some((event) => event.text.includes('stale-confirm-')));
    await Promise.race([old, sleep(3000).then(() => { throw new Error('Obsolete request did not settle'); })]);
  });
}
