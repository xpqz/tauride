#!/usr/bin/env node
// CLI and MCP stdio adapter for the Tauride agent socket: the client side of
// "Phase 1: wire format" in tauri/agent-pairing.md. One file, no dependencies.
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { version } = require('./package.json');

// stdout is the JSON-RPC stream in mcp mode, so every diagnostic goes to stderr.
const log = (s) => process.stderr.write(`${s}\n`);

const USAGE = `usage: tauride-mcp [--session <label>] [--socket <path>] [--timeout <ms>] <command> [args]

  status                   print the session's status as JSON
  exec <text>              run a line in the session and print what it produced
  answer <text>            answer a ⎕ or ⍞ input prompt
  interrupt [weak|strong]  interrupt the interpreter (default weak)
  tail [n]                 the last n transcript events (default 100), one JSON object per line
  watch                    print transcript events as they arrive, until Ctrl-C
  mcp                      serve MCP over stdio

The socket is --socket, else $TAURIDE_SOCKET, else
$XDG_CONFIG_HOME/Ride-4.8/agent/<session>.sock (~/.config when XDG_CONFIG_HOME is unset),
where <session> is --session (default main).
Exit status: 0 ok, 1 the line ended in an APL error, 2 anything else (message on stderr).`;

// Error frames need not carry a message (the busy frame sent to a second connection has none).
const ERR_MSG = {
  refused: 'the session does not allow control (needs RIDE_AGENT=control)',
  prompt: 'wrong prompt type for this request',
  busy: 'a request is in flight or another client is connected',
  timeout: 'no result within the timeout',
  closed: 'the session is not connected to an interpreter',
  bad_request: 'bad request',
};

class AppError extends Error {
  constructor(err) {
    super(err.message || ERR_MSG[err.code] || err.code || 'unknown error');
    this.err = err;
  }
}

// Thrown for a bad command line; main() prints the usage after the message.
const usage = (m) => Object.assign(new Error(m), { usage: true });

// Same resolution as user_data_dir() in src-tauri/src/lib.rs.
const defaultSocket = (session) => {
  const base = process.platform === 'win32'
    ? process.env.APPDATA
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base || os.tmpdir(), 'Ride-4.8', 'agent', `${session}.sock`);
};

const connectFailure = (e, sockPath) => {
  const why = {
    ENOENT: 'no such socket; is Tauride running with RIDE_AGENT set?',
    ECONNREFUSED: 'connection refused; a stale socket file?',
  }[e.code] || e.message;
  return new Error(`cannot connect to ${sockPath}: ${why}`);
};

// Connects to the agent socket and returns a client whose request() resolves with the
// frame's ok or rejects with an AppError carrying its err. Unsolicited {"ev":...} frames
// go to onEvent. An err frame without an id (busy, on a second connection) and a lost
// connection fail every pending and future request, so nothing waits on a dead socket.
const connect = (sockPath, onEvent) => new Promise((resolve, reject) => {
  const pending = new Map();
  let nextId = 1;
  let buf = '';
  let fatal;
  let connected = false;
  const sock = net.createConnection(sockPath);
  // Decoded before splitting on \n, so a chunk boundary inside a multibyte APL char is harmless.
  sock.setEncoding('utf8');
  const fail = (e) => {
    fatal = fatal || e;
    pending.forEach((p) => p.reject(fatal));
    pending.clear();
  };
  const frame = (line) => {
    let f;
    try {
      f = JSON.parse(line);
    } catch (e) {
      log(`tauride-mcp: ignoring unparseable frame: ${line}`);
      return;
    }
    if (f.ev) {
      if (onEvent) onEvent(f.ev);
      return;
    }
    const p = pending.get(f.id);
    if (p) {
      pending.delete(f.id);
      if (f.err) p.reject(new AppError(f.err)); else p.resolve(f.ok);
    } else if (f.err) {
      fail(new AppError(f.err));
      sock.destroy();
    }
  };
  sock.on('data', (chunk) => {
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) frame(line);
      i = buf.indexOf('\n');
    }
  });
  sock.on('error', (e) => {
    if (connected) fail(e); else reject(connectFailure(e, sockPath));
  });
  sock.on('close', () => fail(new Error('connection closed')));
  const client = {
    request(req, fields) {
      return new Promise((res, rej) => {
        if (fatal) { rej(fatal); return; }
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve: res, reject: rej });
        sock.write(`${JSON.stringify({ id, req, ...fields })}\n`);
      });
    },
    // Resolves when the connection is gone, with the reason.
    closed: new Promise((res) => { sock.on('close', () => res(fatal)); }),
    get isClosed() { return !!fatal; },
    close() { sock.destroy(); },
  };
  sock.on('connect', () => {
    connected = true;
    resolve(client);
  });
});

// The design leaves the ok shape of tail/since as "the events"; {"events": [...]} is the
// plain reading of "ok is an object", and a bare array is accepted in case the core
// chose the other.
const events = (ok) => (Array.isArray(ok) ? ok : (ok && ok.events) || []);

const fmtDmx = (d) => ((d && (d.EM || d.Message))
  ? [d.EM, d.Message].filter(Boolean).join(': ')
  : JSON.stringify(d));

// Prints an execute/answer result (or the partial one a timeout carries) as the session shows it.
const printResult = (r) => {
  if (!r) return;
  if (r.echo != null) console.log(r.echo);
  // Output text keeps the interpreter's own line end, and the error line (HadError) has no text.
  (r.lines || []).forEach((l) => { if (l.text != null) console.log(l.text.replace(/\n$/, '')); });
  if (r.truncated) log('tauride-mcp: output truncated; the rest is in the transcript');
};

const cli = async (opts, cmd, args) => {
  // Arguments are checked before connecting, so a usage error never reads as "cannot connect".
  if (!['status', 'exec', 'answer', 'interrupt', 'tail', 'watch'].includes(cmd)) throw usage(`unknown command: ${cmd}`);
  if ((cmd === 'exec' || cmd === 'answer') && !args.length) throw usage(`${cmd} needs <text>`);
  const strength = args[0] || 'weak';
  if (cmd === 'interrupt' && !['weak', 'strong'].includes(strength)) throw usage(`interrupt takes weak or strong, not ${strength}`);
  const n = args.length ? Number(args[0]) : undefined;
  if (cmd === 'tail' && n !== undefined && !(n > 0)) throw usage(`tail takes a count, not ${args[0]}`);
  const client = await connect(opts.socket, cmd === 'watch' ? (ev) => console.log(JSON.stringify(ev)) : null);
  try {
    switch (cmd) {
      case 'status':
        console.log(JSON.stringify(await client.request('status'), null, 2));
        return 0;
      case 'exec':
      case 'answer': {
        const req = cmd === 'exec' ? 'execute' : 'answer';
        const r = await client.request(req, { text: args.join(' '), timeout: opts.timeout });
        printResult(r);
        if (r && r.error) {
          log(`tauride-mcp: ${fmtDmx(r.error)}`);
          return 1;
        }
        return 0;
      }
      case 'interrupt': {
        // The result names the strength sent, as the design asks: weak can end the interpreter.
        const r = await client.request('interrupt', { strength });
        console.log(JSON.stringify({ strength, ...r }));
        return 0;
      }
      case 'tail':
        events(await client.request('tail', { n })).forEach((ev) => console.log(JSON.stringify(ev)));
        return 0;
      default: // watch: events print as they arrive until Ctrl-C or the session goes away
        process.on('SIGINT', () => process.exit(0));
        throw await client.closed;
    }
  } catch (e) {
    // A timeout still reports what arrived before it, so a slow line is not lost.
    if (e instanceof AppError && e.err.code === 'timeout') printResult(e.err.partial);
    throw e;
  } finally {
    client.close();
  }
};

// MCP tools, one per phase 1 request.
const TOOLS = [
  {
    name: 'execute',
    description: 'Run one line of APL in the Tauride session, as if typed at its prompt. '
      + 'Returns the echoed line, the output and error lines that followed it, the DMX of '
      + 'an APL error or null, the prompt type afterwards (1 ready, 2 ⎕ input, 4 ⍞ input), '
      + 'whether the output was truncated, and the transcript seq range. Refused while a ⎕ or '
      + '⍞ prompt is open (use answer) and unless the session allows control.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the line to execute' },
        timeout: { type: 'integer', description: 'milliseconds to wait for the prompt to return (default 30000)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'answer',
    description: 'Answer an open ⎕ or ⍞ input prompt (prompt type 2 or 4) in the session. Same result as execute.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the input to supply' },
        timeout: { type: 'integer', description: 'milliseconds to wait for the prompt to return (default 30000)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'interrupt',
    description: 'Interrupt the interpreter: weak (default) is the ordinary interrupt, strong the hard one. '
      + 'Returns which was sent and the prompt type afterwards.',
    inputSchema: {
      type: 'object',
      properties: { strength: { type: 'string', enum: ['weak', 'strong'] } },
    },
  },
  {
    name: 'tail',
    description: 'The last n transcript events (default 100), one JSON object per line. Kinds: input '
      + '(origin human or agent), output, error, prompt, window, stack; each has seq and t.',
    inputSchema: {
      type: 'object',
      properties: { n: { type: 'integer', minimum: 1 } },
    },
  },
  {
    name: 'status',
    description: 'The session: caption, prompt type, level (observe or control), interpreter version, '
      + 'transcript path and the seq of the latest event.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const rpcError = (code, message) => Object.assign(new Error(message), { rpc: code });

const mcp = (opts) => new Promise((resolve) => {
  let connecting; // the one connect in progress or done, shared by concurrent tool calls
  // Connected on the first call and again after a loss, so the server starts (and
  // initialize/tools/list work) before Tauride does.
  const app = async () => {
    const c = connecting && await connecting.catch(() => null);
    if (c && !c.isClosed) return c;
    connecting = connect(opts.socket, () => {});
    return connecting;
  };
  const callTool = async (name, a) => {
    if (!TOOLS.some((t) => t.name === name)) throw rpcError(-32602, `unknown tool: ${name}`);
    const c = await app();
    switch (name) {
      case 'execute':
      case 'answer': {
        const r = await c.request(name, { text: a.text, timeout: a.timeout });
        return { text: JSON.stringify(r), isError: !!(r && r.error) };
      }
      case 'interrupt': {
        const strength = a.strength || 'weak';
        return { text: JSON.stringify({ strength, ...await c.request('interrupt', { strength }) }) };
      }
      case 'tail':
        return { text: events(await c.request('tail', { n: a.n })).map((ev) => JSON.stringify(ev)).join('\n') };
      default:
        return { text: JSON.stringify(await c.request('status')) };
    }
  };
  const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const handleOne = async (m) => {
    const { id, method, params = {} } = m;
    const notification = id === undefined;
    try {
      let result;
      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: params.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'tauride', version },
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: TOOLS };
          break;
        case 'tools/call': {
          const { text, isError } = await callTool(params.name, params.arguments || {});
          result = { content: [{ type: 'text', text }], isError: !!isError };
          break;
        }
        default:
          if (notification) return; // notifications/initialized and the like
          throw rpcError(-32601, `method not found: ${method}`);
      }
      if (!notification) send({ id, result });
    } catch (e) {
      if (notification) return;
      if (e.rpc) {
        send({ id, error: { code: e.rpc, message: e.message } });
      } else {
        // A failure of the tool, not of the protocol: the app's err frame, or no app.
        const text = e instanceof AppError
          ? JSON.stringify({ message: e.message, ...e.err })
          : e.message;
        send({ id, result: { content: [{ type: 'text', text }], isError: true } });
      }
    }
  };
  // A client may close stdin with a call outstanding; its reply still goes out
  // before the socket is closed.
  let active = 0;
  let stdinClosed = false;
  const finish = () => {
    if (connecting) connecting.then((c) => c.close(), () => {});
    resolve(0);
  };
  const handle = async (m) => {
    active += 1;
    try {
      await handleOne(m);
    } finally {
      active -= 1;
      if (stdinClosed && active === 0) finish();
    }
  };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let m;
    try {
      m = JSON.parse(line);
    } catch (e) {
      send({ id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    (Array.isArray(m) ? m : [m]).forEach((x) => {
      if (x && typeof x === 'object' && ('result' in x || 'error' in x)) return; // a response to a request we never make
      if (!x || typeof x.method !== 'string') {
        if (x && x.id !== undefined) send({ id: x.id, error: { code: -32600, message: 'invalid request' } });
        return;
      }
      handle(x);
    });
  });
  rl.on('close', () => {
    stdinClosed = true;
    if (active === 0) finish();
  });
});

const parseArgs = (argv) => {
  const opts = { session: 'main', socket: process.env.TAURIDE_SOCKET, timeout: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const m = /^--(session|socket|timeout)(?:=(.*))?$/.exec(a);
    if (m) {
      let v = m[2];
      if (v === undefined) {
        i += 1;
        v = argv[i];
      }
      if (v === undefined) throw usage(`--${m[1]} needs a value`);
      if (m[1] === 'timeout') {
        opts.timeout = Number(v);
        if (!(opts.timeout > 0)) throw usage(`--timeout takes milliseconds, not ${v}`);
      } else {
        opts[m[1]] = v;
      }
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      rest.push(a);
    }
  }
  if (!opts.socket) opts.socket = defaultSocket(opts.session);
  return { opts, cmd: rest[0], args: rest.slice(1) };
};

const main = async () => {
  const { opts, cmd, args } = parseArgs(process.argv.slice(2));
  if (opts.help || !cmd) {
    (opts.help ? console.log : log)(USAGE);
    return opts.help ? 0 : 2;
  }
  if (cmd === 'mcp') return mcp(opts);
  return cli(opts, cmd, args);
};

main().then((code) => {
  process.exitCode = code; // not process.exit(): stdout to a pipe is asynchronous on macOS
}, (e) => {
  log(`tauride-mcp: ${e.message}`);
  if (e.usage) log(USAGE);
  process.exitCode = 2;
});
