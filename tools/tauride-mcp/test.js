// Runs the CLI and the MCP server against a fake Tauride that answers with the frames of
// "Phase 1: wire format" (tauri/agent-pairing.md), so the adapter is known to work before
// the app's side exists.  node --test test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BIN = path.join(__dirname, 'tauride-mcp.js');
// Unix socket paths are limited to about 100 bytes, so the fake lives in the system tmp dir.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmcp-'));
const SOCK = path.join(DIR, 'app.sock');

const ok = (echo, lines, error, prompt) => ({
  echo, lines, error, prompt, truncated: false, seq: [4, 4 + lines.length],
});
const EVENTS = [
  {
    seq: 1, t: '2026-10-09T10:00:00.000Z', kind: 'input', origin: 'human', prompt: 1, text: '⍳3',
  },
  {
    seq: 2, t: '2026-10-09T10:00:00.010Z', kind: 'output', origin: 'human', type: 1, text: '1 2 3',
  },
  {
    seq: 3, t: '2026-10-09T10:00:00.020Z', kind: 'prompt', prompt: 1,
  },
];
const STATUS = {
  caption: 'CLEAR WS', prompt: 1, level: 'control', version: '21.0', transcript: path.join(DIR, 'main-1.jsonl'), seq: 3,
};
const DMX = { EM: 'DOMAIN ERROR', Message: 'Divide by zero', EN: 11 };

const reply = (f) => {
  switch (f.req) {
    case 'status': return { ok: STATUS };
    case 'execute':
    case 'answer':
      if (f.text === '⍳5') return { ok: ok('      ⍳5', [{ kind: 'output', type: 1, text: '1 2 3 4 5' }], null, 1) };
      if (f.text === '1÷0') {
        // Shaped as Dyalog 21.0 produces it: HadError carries no text, and the message
        // follows as output lines that keep their line ends.
        return {
          ok: ok('      1÷0', [
            { kind: 'error', error: 11, dmx: 1 },
            { kind: 'output', type: 5, text: 'DOMAIN ERROR: Divide by zero\n' },
            { kind: 'output', type: 5, text: '      1÷0\n' },
            { kind: 'output', type: 5, text: '       ∧\n' },
          ], DMX, 1),
        };
      }
      if (f.text === 'slow') {
        return {
          err: {
            code: 'timeout',
            message: `no prompt within ${f.timeout || 30000} ms`,
            partial: ok('      slow', [{ kind: 'output', type: 1, text: 'working' }], null, 0),
          },
        };
      }
      if (f.text === 'input') return { err: { code: 'prompt', message: 'prompt type is 2', prompt: 2 } };
      return { err: { code: 'bad_request', message: `fake app does not know ${f.text}` } };
    case 'interrupt': return { ok: { prompt: 1 } };
    case 'tail': return { ok: { events: EVENTS.slice(-(f.n || 100)) } };
    case 'since': return { ok: { events: EVENTS.filter((e) => e.seq > f.seq) } };
    default: return { err: { code: 'bad_request', message: `unknown request ${f.req}` } };
  }
};

let current; // the one connection the fake app serves, like the real one
const server = net.createServer((sock) => {
  if (current) {
    // end(), as the app does: the write half closes but the client's request is still
    // read, so the client's write cannot fail before it has seen the frame.
    sock.end('{"err":{"code":"busy"}}\n');
    return;
  }
  current = sock;
  sock.on('close', () => { current = null; });
  sock.on('error', () => {});
  // An unsolicited event soon after connecting: watch must print it, the others ignore it.
  setTimeout(() => { if (!sock.destroyed) sock.write(`${JSON.stringify({ ev: EVENTS[2] })}\n`); }, 30);
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.filter(Boolean).forEach((l) => {
      const f = JSON.parse(l);
      sock.write(`${JSON.stringify({ id: f.id, ...reply(f) })}\n`);
    });
  });
});

before(() => new Promise((res) => { server.listen(SOCK, res); }));
after(() => {
  server.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// Runs the CLI to completion; stdin is the text fed to it, if any.
const run = (args, { env = {}, stdin } = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, TAURIDE_SOCKET: SOCK, ...env },
  });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => resolve({ code, out, err }));
  if (stdin !== undefined) p.stdin.end(stdin);
});

test('status prints the status object', async () => {
  const r = await run(['status']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), STATUS);
});

test('exec prints the echo and the lines', async () => {
  const r = await run(['exec', '⍳5']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '      ⍳5\n1 2 3 4 5\n');
  assert.equal(r.err, '');
});

test('exec exits 1 on an APL error, with the error on stderr', async () => {
  const r = await run(['exec', '1÷0']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '      1÷0\nDOMAIN ERROR: Divide by zero\n      1÷0\n       ∧\n');
  assert.equal(r.err, 'tauride-mcp: DOMAIN ERROR: Divide by zero\n');
});

test('exec prints the partial result on a timeout and exits 2', async () => {
  const r = await run(['--timeout', '500', 'exec', 'slow']);
  assert.equal(r.code, 2);
  assert.equal(r.out, '      slow\nworking\n');
  assert.equal(r.err, 'tauride-mcp: no prompt within 500 ms\n');
});

test('exec at an input prompt is refused', async () => {
  const r = await run(['exec', 'input']);
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /prompt type is 2/);
});

test('interrupt says which strength it sent', async () => {
  assert.deepEqual(JSON.parse((await run(['interrupt'])).out), { strength: 'weak', prompt: 1 });
  assert.deepEqual(JSON.parse((await run(['interrupt', 'strong'])).out), { strength: 'strong', prompt: 1 });
  assert.equal((await run(['interrupt', 'medium'])).code, 2);
});

test('tail prints one event per line', async () => {
  const r = await run(['tail', '2']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trim().split('\n').map(JSON.parse), EVENTS.slice(1));
});

test('usage errors exit 2 without connecting', async () => {
  const r = await run(['exec'], { env: { TAURIDE_SOCKET: '/nonexistent/x.sock' } });
  assert.equal(r.code, 2);
  assert.match(r.err, /exec needs <text>/);
  assert.match(r.err, /usage:/);
});

test('a missing socket is reported with its path', async () => {
  const r = await run(['status'], { env: { TAURIDE_SOCKET: '/nonexistent/x.sock' } });
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot connect to \/nonexistent\/x\.sock: no such socket/);
});

test('watch prints events as they arrive; a second connection is busy', async () => {
  const w = spawn(process.execPath, [BIN, 'watch'], { env: { ...process.env, TAURIDE_SOCKET: SOCK } });
  let out = '';
  await new Promise((res) => { w.stdout.on('data', (d) => { out += d; if (out.includes('\n')) res(); }); });
  assert.deepEqual(JSON.parse(out.trim()), EVENTS[2]);
  const r = await run(['status']);
  assert.equal(r.code, 2);
  assert.match(r.err, /another client is connected/);
  w.kill('SIGINT');
  await new Promise((res) => { w.on('close', res); });
});

// Sends JSON-RPC messages to the MCP server and returns its replies once there are n.
const rpc = async (msgs, n, env) => {
  const p = spawn(process.execPath, [BIN, 'mcp'], { env: { ...process.env, TAURIDE_SOCKET: SOCK, ...env } });
  let out = '';
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const replies = new Promise((res) => {
    p.stdout.on('data', (d) => {
      out += d;
      const lines = out.split('\n').filter(Boolean);
      if (lines.length >= n) res(lines.map(JSON.parse));
    });
  });
  p.stdin.write(`${msgs.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('\n')}\n`);
  const got = await replies;
  p.stdin.end();
  const code = await new Promise((res) => { p.on('close', res); });
  assert.equal(code, 0, err);
  assert.equal(err, '');
  return got;
};

test('mcp answers initialize, ping and tools/list; notifications get no reply', async () => {
  const [init, ping, list] = await rpc([
    {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'p', method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ], 3);
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, 'tauride');
  assert.deepEqual(ping, { jsonrpc: '2.0', id: 'p', result: {} });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['execute', 'answer', 'interrupt', 'tail', 'status']);
  list.result.tools.forEach((t) => assert.equal(t.inputSchema.type, 'object'));
});

test('mcp tools/call returns text content, isError on APL and app errors', async () => {
  const call = (id, name, args) => ({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  });
  const [a, b, c, d, e, f] = await rpc([
    call(1, 'execute', { text: '⍳5' }),
    call(2, 'execute', { text: '1÷0' }),
    call(3, 'execute', { text: 'slow', timeout: 100 }),
    call(4, 'status', {}),
    call(5, 'tail', { n: 1 }),
    call(6, 'interrupt', {}),
  ], 6);
  assert.equal(a.result.isError, false);
  assert.equal(JSON.parse(a.result.content[0].text).lines[0].text, '1 2 3 4 5');
  assert.equal(b.result.isError, true);
  assert.deepEqual(JSON.parse(b.result.content[0].text).error, DMX);
  assert.equal(c.result.isError, true);
  const t = JSON.parse(c.result.content[0].text);
  assert.equal(t.code, 'timeout');
  assert.equal(t.partial.lines[0].text, 'working');
  assert.deepEqual(JSON.parse(d.result.content[0].text), STATUS);
  assert.deepEqual(JSON.parse(e.result.content[0].text), EVENTS[2]);
  assert.deepEqual(JSON.parse(f.result.content[0].text), { strength: 'weak', prompt: 1 });
});

test('mcp protocol errors: unknown method, unknown tool, parse error', async () => {
  // Replies may come back in any order (the parse error needs no await), so match by id.
  const got = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'resources/list' },
    {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'windows', arguments: {} },
    },
    '{not json', // sent as the raw line
  ], 3);
  const by = (id) => got.find((m) => m.id === id);
  assert.equal(by(1).error.code, -32601);
  assert.equal(by(2).error.code, -32602);
  assert.equal(by(null).error.code, -32700);
});

test('mcp without the app: tools/list works, tools/call is an isError result', async () => {
  const [list, call] = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} },
    },
  ], 2, { TAURIDE_SOCKET: '/nonexistent/x.sock' });
  assert.equal(list.result.tools.length, 5);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /cannot connect to \/nonexistent\/x\.sock/);
});
