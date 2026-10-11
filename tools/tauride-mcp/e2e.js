#!/usr/bin/env node
// Release check for the agent socket ("Testing" in tauri/agent-pairing.md): launches a
// built Tauride with a private config directory and a spawned interpreter, then runs
// every request over the socket, not through the GUI. Each check prints PASS or FAIL
// with what it saw; the exit status is the number of failures.
//
//   TAURIDE_BIN=src-tauri/target/debug/tauride node tools/tauride-mcp/e2e.js
//
// TAURIDE_BIN   the binary to launch
// RIDE_SPAWN    the interpreter it spawns (default /usr/local/bin/dyalog)
// E2E_DIR       its config directory (default a fresh short directory under /tmp:
//               macOS caps a socket path at 104 bytes, so not the usual temp dir)
// E2E_SOCKET    with no TAURIDE_BIN: run only the socket checks against an app that
//               already serves this socket (test.js does this with its fake); nothing
//               is launched or killed
//
// A Tauride that is already running is left alone. The binary under test must then carry
// its own identifier (TAURI_CONFIG='{"identifier":"..."}' at build time), or the running
// app's single-instance plugin takes the launch as a new window and the launch check
// fails at once, saying so.
//
// Unix only: it finds and ends the interpreter with ps and signals.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const {
  connect, AppError, events, windows, waited, tipText,
} = require('./tauride-mcp.js');

const BIN = process.env.TAURIDE_BIN;
const SPAWN = process.env.RIDE_SPAWN || '/usr/local/bin/dyalog';
const SOCKET_ONLY = !BIN && process.env.E2E_SOCKET;
const CLI = path.join(__dirname, 'tauride-mcp.js');
const ATTACH_MS = 90000; // the interpreter has to start and connect before the socket exists

let failures = 0;
const show = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? 'undefined' : s.replace(/\s+/g, ' ').slice(0, 300);
};
const report = (verdict, name, seen) => console.log(`${verdict} ${name}: ${show(seen)}`);
const skip = (name, why) => report('SKIP', name, why);
const describe = (e) => (e instanceof AppError ? `err ${e.err.code}: ${e.message}` : e.message);
// fn returns [passed, observed]; a throw is a failure with the error as the observation.
const check = async (name, fn) => {
  try {
    const [pass, seen] = await fn();
    report(pass ? 'PASS' : 'FAIL', name, seen);
    if (!pass) failures += 1;
  } catch (e) {
    report('FAIL', name, describe(e));
    failures += 1;
  }
};
// For a request that must fail with one error code.
const expectErr = async (p, code) => {
  try {
    return [false, await p];
  } catch (e) {
    return [e instanceof AppError && e.err.code === code, describe(e)];
  }
};

const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
const outText = (r) => ((r && r.lines) || []).map((l) => l.text || '').join('');
const until = async (what, ms, poll) => {
  const t0 = Date.now();
  for (;;) {
    const v = await poll();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`${what}: not within ${ms} ms`);
    await sleep(250);
  }
};

// --- processes -----------------------------------------------------------------------

// Every process, from one ps call: pid, parent and command.
const processes = () => execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
  .split('\n')
  .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
  .filter(Boolean)
  .map((m) => ({ pid: +m[1], ppid: +m[2], comm: m[3].trim() }));
const descendants = (pid) => {
  const all = processes();
  const out = [];
  const walk = (p) => all.filter((x) => x.ppid === p).forEach((x) => { out.push(x); walk(x.pid); });
  walk(pid);
  return out;
};
// Every Tauride process. The single-instance plugin hands a launch to a running app with
// the same identifier as a new session window, and the launched process exits at once;
// a binary built with its own identifier (TAURI_CONFIG) runs alongside. Which case a
// launch is cannot be told from ps, so the launch goes ahead and an exit is diagnosed.
const otherTauride = () => processes().filter((p) => /(^|\/)tauride$/i.test(p.comm));

const launch = (dir, level) => {
  const log = fs.openSync(path.join(dir, 'app.log'), 'a');
  const env = {
    ...process.env, XDG_CONFIG_HOME: dir, RIDE_AGENT: level, RIDE_SPAWN: SPAWN,
  };
  // Nothing from the caller's environment may redirect the launch.
  ['RIDE_CONNECT', 'RIDE_LISTEN', 'RIDE_JS', 'DYALOG_SPAWN', 'TAURIDE_SOCKET'].forEach((k) => { delete env[k]; });
  const app = spawn(BIN, [], { env, stdio: ['ignore', 'ignore', log] });
  fs.closeSync(log);
  app.exited = new Promise((res) => { app.once('exit', (code, sig) => { app.gone = true; res(code === null ? sig : code); }); });
  app.on('error', (e) => { app.gone = true; app.spawnError = e; });
  return app;
};

// Connects once the app serves the socket, then waits for the interpreter's prompt. The
// tap starts with the first message from the interpreter, so the socket appears only
// after Dyalog has connected; a socket file left by an earlier run refuses until then.
const attach = async (sock, app) => {
  const t0 = Date.now();
  let client = null;
  while (!client) {
    if (app && app.gone) {
      const why = app.spawnError ? app.spawnError.message : await app.exited;
      const others = otherTauride().map((p) => p.pid);
      const taken = others.length ? `; another Tauride is running (pid ${others.join(', ')}): a binary with its identifier hands the launch to it as a window` : '';
      throw new Error(`the app exited: ${why}${taken}`);
    }
    if (Date.now() - t0 > ATTACH_MS) throw new Error(`no socket at ${sock} within ${ATTACH_MS} ms`);
    client = await connect(sock).catch(() => null);
    if (!client) await sleep(250);
  }
  const status = await until('prompt 1', ATTACH_MS - (Date.now() - t0), async () => {
    const s = await client.request('status');
    return s.prompt === 1 ? s : null;
  });
  return { client, status };
};

// Ends the app, then whatever it spawned that outlived it. The tree is collected first:
// once the app has gone its children are reparented and cannot be found by parent. Dyalog
// serving RIDE ignores SIGTERM, so what is left after a moment gets SIGKILL. Nothing
// outside that tree is ever signalled.
const shutdown = async (app) => {
  if (!app) return;
  const kids = descendants(app.pid);
  if (!app.gone) {
    app.kill('SIGTERM');
    await Promise.race([app.exited, sleep(5000)]);
  }
  if (!app.gone) {
    app.kill('SIGKILL');
    await Promise.race([app.exited, sleep(2000)]);
  }
  // Still the same process (pid and command), not a later one with a reused pid.
  const still = () => {
    const now = processes();
    return kids.filter((k) => now.some((p) => p.pid === k.pid && p.comm === k.comm));
  };
  const signal = (sig) => still().forEach((k) => { try { process.kill(k.pid, sig); } catch (e) { /* already gone */ } });
  signal('SIGTERM');
  await sleep(1000);
  signal('SIGKILL');
};

// --- the checks over the socket -------------------------------------------------------

const FN = 'e2efn';
const FN_TEXT = `r←${FN} n\nr←2×n\nr←r+0`;

// A window by name and kind, polled until it has arrived: OpenWindow follows the prompt.
const findWindow = (client, name, kind) => until(`${kind} ${name}`, 5000, async () => windows(await client.request('windows'))
  .find((w) => w.name === name && w.kind === kind) || null);
// Loops on wait for prompt events until the prompt is p.
const untilPrompt = async (client, p, since, ms) => {
  const t0 = Date.now();
  let s = since;
  for (;;) {
    const left = ms - (Date.now() - t0);
    if (left <= 0) throw new Error(`prompt ${p}: not within ${ms} ms`);
    const ev = waited(await client.request('wait', { since: s, kinds: ['prompt'], timeout: left }));
    if (ev.prompt === p) return ev;
    s = ev.seq;
  }
};

const socketChecks = async (client, sock, status0) => {
  const exec = (text, timeout) => client.request('execute', { text, timeout });
  const seqNow = async () => (await client.request('status')).seq;

  await check('status', async () => [
    status0.level === 'control' && status0.prompt === 1 && typeof status0.transcript === 'string' && status0.seq >= 0,
    { level: status0.level, prompt: status0.prompt, version: status0.version, transcript: status0.transcript },
  ]);
  await check('execute ⍳5', async () => {
    const r = await exec('⍳5');
    return [outText(r).includes('1 2 3 4 5') && r.error === null && r.prompt === 1, { lines: outText(r), prompt: r.prompt }];
  });
  await check('execute: APL error', async () => {
    const r = await exec('1÷0');
    return [!!r.error && r.prompt === 1, { error: r.error, text: outText(r) }];
  });
  await check('execute: 300 lines are truncated', async () => {
    // 300 lines of 300 chars trips the 64 KB cap even if the interpreter joins lines in one message.
    const r = await exec("300 300⍴'x'");
    return [r.truncated === true && r.lines.length <= 200, { truncated: r.truncated, lines: r.lines.length, seq: r.seq }];
  });
  await check('execute: ⎕ prompt opens', async () => {
    const r = await exec('x←⎕');
    return [r.prompt === 2, { prompt: r.prompt }];
  });
  await check('execute at a ⎕ prompt is refused', () => expectErr(exec('1'), 'prompt'));
  await check('answer', async () => {
    const r = await client.request('answer', { text: '42' });
    return [r.prompt === 1, { prompt: r.prompt, text: outText(r) }];
  });
  await check('execute: the answer took', async () => {
    const r = await exec('x');
    return [outText(r).includes('42'), outText(r)];
  });
  await check('value of a global', async () => {
    const t = tipText(await client.request('value', { name: 'x' }));
    return [t.includes('42'), t];
  });
  await check('value of an expression is bad_request', () => expectErr(client.request('value', { name: '1+1' }), 'bad_request'));

  await check('execute: timeout carries the partial result', async () => {
    try {
      return [false, await exec("⎕←'tick' ⋄ ⎕DL 30", 1500)];
    } catch (e) {
      if (!(e instanceof AppError) || e.err.code !== 'timeout') throw e;
      const partial = outText(e.err.partial);
      return [partial.includes('tick'), { message: e.message, partial }];
    }
  });
  await check('interrupt brings the prompt back', async () => {
    let since = await seqNow();
    const r = await client.request('interrupt', { strength: 'weak' });
    let how = 'weak';
    const ev = await untilPrompt(client, 1, since, 10000).catch(async () => {
      // A weak interrupt can be ignored by a quiet interpreter; the strong one is not.
      since = await seqNow();
      await client.request('interrupt', { strength: 'strong' });
      how = 'weak, then strong';
      return untilPrompt(client, 1, since, 10000);
    });
    return [ev.prompt === 1, { sent: how, promptAfterRequest: r.prompt, promptNow: ev.prompt }];
  });

  await check('tail', async () => {
    const seq = await seqNow();
    const evs = events(await client.request('tail', { n: 5 }));
    const mono = evs.every((e, i) => i === 0 || e.seq > evs[i - 1].seq);
    return [evs.length === 5 && mono && evs[4].seq >= seq, evs.map((e) => `${e.seq}:${e.kind}`)];
  });
  await check('since', async () => {
    const seq = await seqNow();
    const evs = events(await client.request('since', { seq: seq - 3 }));
    return [evs.length >= 3 && evs.every((e) => e.seq > seq - 3), evs.map((e) => e.seq)];
  });
  await check('second connection is busy', async () => {
    const other = await connect(sock);
    try {
      return await expectErr(other.request('status'), 'busy');
    } finally {
      other.close();
    }
  });

  let editor;
  await check(`windows shows the editor after )ed ${FN}`, async () => {
    const r = await exec(`)ed ${FN}`);
    editor = await findWindow(client, FN, 'editor');
    return [r.prompt === 1 && Number.isInteger(editor.token), { token: editor.token, text: editor.text, saved: editor.saved }];
  });
  await check('window_text', async () => {
    const w = await client.request('window_text', { token: editor.token });
    return [w.name === FN && w.kind === 'editor', { token: w.token, name: w.name, kind: w.kind }];
  });
  await check('window_text of a stale token is not_found', () => expectErr(client.request('window_text', { token: 987654 }), 'not_found'));
  await check('save a function', async () => {
    const r = await client.request('save', { token: editor.token, text: FN_TEXT });
    return [r.saved === true, r];
  });
  await check('execute the saved function', async () => {
    const r = await exec(`${FN} 21`);
    return [outText(r).includes('42'), outText(r)];
  });

  // The save may have closed the editor, as Escape does; then edit opens one again.
  await check('stops on the editor', async () => {
    let how = 'the open editor';
    const open = windows(await client.request('windows')).find((w) => w.name === FN && w.kind === 'editor');
    if (open) editor = open;
    else {
      how = 'edit';
      editor = await client.request('edit', { name: FN });
    }
    const r = await client.request('stops', { token: editor.token, lines: [1] });
    return [JSON.stringify(r.stops) === '[1]', { via: how, token: editor.token, stops: r.stops }];
  });
  await check('save with stops', async () => {
    const r = await client.request('save', { token: editor.token, text: FN_TEXT, stops: [1] });
    return [r.saved === true, r];
  });
  let tracer;
  await check('execute suspends at the stop; windows shows the tracer', async () => {
    const r = await exec(`${FN} 21`);
    tracer = await findWindow(client, FN, 'tracer');
    return [r.prompt === 1 && !outText(r).includes('42'), { prompt: r.prompt, token: tracer.token, currentLine: tracer.currentLine, stops: tracer.stops }];
  });
  await check('stack', async () => {
    const r = await client.request('stack');
    const s = JSON.stringify(r);
    return [Array.isArray(r.stack) && r.stack.length >= 1 && s.includes(FN), s];
  });
  await check('value in the suspended frame', async () => {
    const t = tipText(await client.request('value', { name: 'n' }));
    return [t.includes('21'), t];
  });
  await check('trace step_over', async () => {
    const r = await client.request('trace', { token: tracer.token, action: 'step_over', timeout: 10000 });
    return [r.highlight !== undefined, r];
  });
  await check('trace continue closes the tracer', async () => {
    const since = await seqNow();
    const r = await client.request('trace', { token: tracer.token, action: 'continue', timeout: 10000 });
    await untilPrompt(client, 1, since, 10000);
    const out = events(await client.request('since', { seq: since })).filter((e) => e.kind === 'output').map((e) => e.text).join('');
    const left = windows(await client.request('windows')).filter((w) => w.kind === 'tracer');
    return [(r.closed === true || r.prompt !== undefined) && out.includes('42') && left.length === 0, { result: r, output: out.trim(), tracers: left.length }];
  });

  await check('edit opens an editor', async () => {
    const r = await client.request('edit', { name: `${FN}2` });
    const w = await client.request('window_text', { token: r.token });
    return [Number.isInteger(r.token) && w.name === `${FN}2` && w.kind === 'editor', { token: r.token, name: w.name, kind: w.kind }];
  });

  await check('wait resolves on the next event', async () => {
    const since = await seqNow();
    const pending = client.request('wait', { since, kinds: ['input'], timeout: 10000 });
    // If the execute throws, the wait is left outstanding and is rejected when the
    // connection closes; that rejection is this check's, not the process's.
    pending.catch(() => {});
    await exec('1+1');
    const ev = waited(await pending);
    // The input text is the echo, which carries the session's indent.
    return [ev.kind === 'input' && ev.seq > since && ev.text.trim() === '1+1', ev];
  });
  await check('wait times out', () => expectErr(client.request('wait', { prefix: '⍝ nobody:', timeout: 300 }), 'timeout'));

  await check('transcript parses with monotonic seqs', async () => {
    const s = await client.request('status');
    await sleep(500); // the tap writes the file in batches, a little behind the socket
    const lines = fs.readFileSync(s.transcript, 'utf8').split('\n').filter(Boolean);
    let bad = null;
    let prev = 0;
    lines.forEach((l, i) => {
      if (bad) return;
      let e;
      try { e = JSON.parse(l); } catch (x) { bad = `line ${i + 1} is not JSON`; return; }
      if (!(e.seq > prev)) bad = `line ${i + 1}: seq ${e.seq} after ${prev}`;
      prev = e.seq;
    });
    return [!bad && lines.length > 0 && prev <= s.seq, bad || {
      events: lines.length, lastSeq: prev, statusSeq: s.seq, size: s.size,
    }];
  });
};

// --- main -----------------------------------------------------------------------------

const main = async () => {
  if (SOCKET_ONLY) {
    const sock = process.env.E2E_SOCKET;
    let client;
    try {
      let status;
      ({ client, status } = await attach(sock, null));
      await socketChecks(client, sock, status);
    } catch (e) {
      report('FAIL', 'attach', describe(e));
      failures += 1;
    } finally {
      if (client) client.close();
    }
    skip('cli', 'E2E_SOCKET mode');
    skip('second launch with RIDE_AGENT=1', 'E2E_SOCKET mode');
    return failures;
  }
  // What stops the launch is a failed check like any other, so the exit status stays the
  // failure count.
  const cannot = (why) => { report('FAIL', 'launch', why); failures += 1; return failures; };
  if (!BIN) return cannot('TAURIDE_BIN is not set; usage: TAURIDE_BIN=<binary> [RIDE_SPAWN=<interpreter>] [E2E_DIR=<dir>] node e2e.js');
  if (!fs.existsSync(BIN)) return cannot(`no such binary: ${BIN}`);
  // Without an interpreter the app shows a dialog and never serves the socket; say so now
  // rather than after the attach timeout. A bare command name is left to PATH.
  if (SPAWN.includes('/') && !fs.existsSync(SPAWN)) return cannot(`no such interpreter: ${SPAWN} (set RIDE_SPAWN)`);
  const given = process.env.E2E_DIR;
  const dir = given || fs.mkdtempSync('/tmp/tauride-e2e-');
  fs.mkdirSync(dir, { recursive: true });
  const sock = path.join(dir, 'Ride-4.8', 'agent', 'main.sock');
  console.log(`e2e: ${BIN} with RIDE_SPAWN=${SPAWN} in ${dir}`);

  let app = null;
  let client = null;
  const cleanup = async () => {
    if (client) { client.close(); client = null; }
    await shutdown(app);
    app = null;
  };
  process.on('SIGINT', () => { cleanup().then(() => process.exit(130)); });
  try {
    app = launch(dir, 'control');
    let status;
    try {
      ({ client, status } = await attach(sock, app));
      report('PASS', 'launch', { pid: app.pid, socket: sock });
    } catch (e) {
      const tail = fs.existsSync(path.join(dir, 'app.log')) ? fs.readFileSync(path.join(dir, 'app.log'), 'utf8').split('\n').slice(-5).join(' | ') : '';
      report('FAIL', 'launch', `${describe(e)}; app.log: ${tail}`);
      failures += 1;
    }
    if (client) {
      await socketChecks(client, sock, status);
      client.close();
      client = null;
      // The CLI finds the socket from XDG_CONFIG_HOME, as a person's shell would.
      await check('cli: status via XDG_CONFIG_HOME', () => new Promise((res) => {
        const env = { ...process.env, XDG_CONFIG_HOME: dir };
        delete env.TAURIDE_SOCKET;
        const p = spawn(process.execPath, [CLI, 'status'], { env });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => {
          let s = null;
          try { s = JSON.parse(out); } catch (e) { /* reported below */ }
          res([code === 0 && s && s.level === 'control', code === 0 ? { level: s && s.level } : err.trim()]);
        });
      }));
    }
    await shutdown(app);
    app = null;

    // Observation only: the same app, started again with RIDE_AGENT=1, refuses control.
    app = launch(dir, '1');
    try {
      let status;
      ({ client, status } = await attach(sock, app));
      await check('second launch with RIDE_AGENT=1 observes', async () => [status.level === 'observe', { level: status.level }]);
      await check('execute is refused at observe', () => expectErr(client.request('execute', { text: '⍳5' }), 'refused'));
      await check('interrupt is refused at observe', () => expectErr(client.request('interrupt', { strength: 'weak' }), 'refused'));
      await check('tail works at observe', async () => {
        const evs = await client.request('tail', { n: 3 }).then((ok) => (Array.isArray(ok) ? ok : ok.events));
        return [Array.isArray(evs), evs.length];
      });
    } catch (e) {
      report('FAIL', 'second launch with RIDE_AGENT=1', describe(e));
      failures += 1;
    }
  } finally {
    await cleanup();
  }
  if (failures === 0 && !given) fs.rmSync(dir, { recursive: true, force: true });
  else console.log(`e2e: kept ${dir} (app.log and the transcript)`);
  return failures;
};

main().then((code) => {
  console.log(`e2e: ${failures} failure${failures === 1 ? '' : 's'}`);
  process.exitCode = code;
}, (e) => {
  console.error(`e2e: ${e.stack || e.message}`);
  process.exitCode = failures + 1;
});
