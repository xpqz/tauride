// Node.js and Electron compatibility layer for RIDE under Tauri.
//
// Injected (after window.__RIDE__, the startup payload from Rust) into every
// RIDE window before its own scripts run. RIDE's frontend was written for
// Electron with nodeIntegration: it calls require(), process, Buffer and
// @electron/remote directly. This file provides the subset RIDE uses, backed
// by the Rust side through two channels:
//   - sync(): synchronous XHR to the ridesync:// scheme, for APIs RIDE calls
//     synchronously (fs.*Sync, window getters, dialogs);
//   - Tauri invoke/events, for asynchronous work (sockets, processes).
(function () {
  if (window.__RIDE_SHIM__) return;
  window.__RIDE_SHIM__ = true;
  const R = window.__RIDE__;

  // ---------------------------------------------------------------- logging
  const fmt = (x) => {
    if (x instanceof Error) return `${x.name}: ${x.message}${x.stack ? `\n${x.stack}` : ''}`;
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch (e) { return String(x); }
  };
  const rlog = (level, ...a) => {
    try {
      const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
      window.__TAURI_INTERNALS__.invoke('log', { level, msg: `${label} ${location.pathname}${location.search} ${a.map(fmt).join(' ')}` });
    } catch (e) { /* the IPC is not up yet */ }
  };
  window.addEventListener('error', (e) => rlog('error', `${e.message} at ${e.filename}:${e.lineno}:${e.colno}`, e.error || ''));
  window.addEventListener('unhandledrejection', (e) => rlog('error', 'unhandled rejection:', e.reason));
  ['error', 'warn'].forEach((k) => {
    const orig = console[k];
    console[k] = (...a) => { rlog(`console.${k}`, ...a); orig.apply(console, a); };
  });
  window.__rideLog = rlog;

  // ------------------------------------------------------------ sync bridge
  // POST bodies reach custom schemes on current WebKitGTK; the query form is
  // the fallback for engines that drop them.
  let useQuery = false;
  const syncRaw = (op, args) => {
    const x = new XMLHttpRequest();
    const json = JSON.stringify(args || {});
    if (useQuery) {
      x.open('GET', `ridesync://localhost/${op}?a=${encodeURIComponent(json)}`, false);
      x.send();
    } else {
      x.open('POST', `ridesync://localhost/${op}`, false);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(json);
    }
    return JSON.parse(x.responseText);
  };
  try {
    const probe = syncRaw('fs/exists', { path: '/' });
    if (probe.err && probe.err.code === 'EINVAL') useQuery = true;
  } catch (e) { rlog('error', 'sync bridge probe failed', e); }
  // WebKit reports exceptions thrown from injected scripts as an opaque
  // "Script error.", so failures are logged here before they propagate.
  const sync = (op, args) => {
    const r = syncRaw(op, args);
    if (r.err) {
      const e = new Error(r.err.message);
      e.code = r.err.code;
      if (!/^fs\/(exists|stat|readFile)$/.test(op) || e.code !== 'ENOENT') rlog('warn', `sync ${op} failed:`, r.err);
      throw e;
    }
    return r.ok;
  };
  window.__rideSync = sync;

  // ----------------------------------------------------------- EventEmitter
  class EventEmitter {
    constructor() { this._ev = {}; }
    on(n, f) { (this._ev[n] = this._ev[n] || []).push(f); return this; }
    addListener(n, f) { return this.on(n, f); }
    once(n, f) { const g = (...a) => { this.off(n, g); f.apply(this, a); }; g.orig = f; return this.on(n, g); }
    off(n, f) { const l = this._ev[n]; if (l) this._ev[n] = l.filter((g) => g !== f && g.orig !== f); return this; }
    removeListener(n, f) { return this.off(n, f); }
    removeAllListeners(n) { if (n) delete this._ev[n]; else this._ev = {}; return this; }
    listeners(n) { return (this._ev[n] || []).slice(); }
    listenerCount(n) { return (this._ev[n] || []).length; }
    emit(n, ...a) {
      const l = this._ev[n];
      if (!l || !l.length) { if (n === 'error') throw a[0]; return false; }
      l.slice().forEach((f) => f.apply(this, a));
      return true;
    }
  }
  window.__rideEventEmitter = EventEmitter;

  // ------------------------------------------------------------------- path
  const path = {
    sep: '/',
    delimiter: ':',
    isAbsolute: (p) => p.startsWith('/'),
    normalize(p) {
      const abs = p.startsWith('/');
      const out = [];
      p.split('/').forEach((s) => {
        if (!s || s === '.') return;
        if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(s);
      });
      const r = (abs ? '/' : '') + out.join('/');
      return r || (abs ? '/' : '.');
    },
    join: (...a) => path.normalize(a.filter((s) => s !== '').join('/')),
    resolve: (...a) => {
      let r = '';
      for (let i = a.length - 1; i >= 0 && !r.startsWith('/'); i -= 1) r = a[i] + (r ? `/${r}` : '');
      return path.normalize(r.startsWith('/') ? r : `${R.cwd}/${r}`);
    },
    dirname(p) { const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i < 0 ? '.' : (i === 0 ? '/' : p.slice(0, i)); },
    basename(p, ext) { let b = p.replace(/\/+$/, '').split('/').pop(); if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; },
    extname(p) { const b = path.basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
    relative(from, to) {
      const f = path.resolve(from).split('/').filter(Boolean);
      const t = path.resolve(to).split('/').filter(Boolean);
      let i = 0;
      while (i < f.length && i < t.length && f[i] === t[i]) i += 1;
      return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/');
    },
  };
  path.posix = path;

  // ---------------------------------------------------------------- process
  const proc = new EventEmitter();
  Object.assign(proc, {
    env: R.env,
    argv: R.argv,
    pid: R.pid,
    execPath: R.paths.exe,
    platform: R.platform,
    arch: R.arch,
    // No `electron` key and no process.type: Monaco's loader treats a page
    // with both as an Electron renderer and loads its modules through Node.
    versions: { tauri: R.versions.tauri, webkit: navigator.userAgent },
    cwd: () => R.cwd,
    nextTick: (f, ...a) => queueMicrotask(() => f(...a)),
    exit: () => window.close(),
  });
  window.process = proc;
  window.__dirname = '';
  window.global = window;

  // ------------------------------------------------------- module loading
  // CommonJS modules come from the registry tauri/stage.js writes into
  // tauri-modules.js (window.__rideModules, keyed by absolute path, plus
  // window.__ridePackages mapping package names to their main file): the
  // pages' CSP forbids evaluating fetched source.
  const builtins = {};
  const cache = {};
  const registry = () => window.__rideModules || {};
  function loadModule(url) {
    if (cache[url]) return cache[url].exports;
    const module = { exports: {} };
    cache[url] = module;
    const dir = path.dirname(url);
    registry()[url](module, module.exports, (id) => requireFrom(id, dir), dir, url);
    return module.exports;
  }
  function resolveFile(base) {
    for (const c of [base, `${base}.js`, `${base}/index.js`]) if (registry()[c]) return c;
    return null;
  }
  function requireFrom(id, dir) {
    if (Object.prototype.hasOwnProperty.call(builtins, id)) {
      const b = builtins[id];
      return typeof b === 'function' && b.lazy ? (builtins[id] = b()) : b;
    }
    const url = /^(\.{1,2})?\//.test(id)
      ? resolveFile(path.normalize(id.startsWith('/') ? id : `${dir}/${id}`))
      : (window.__ridePackages || {})[id] || null;
    if (!url) throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' });
    return loadModule(url);
  }
  const lazy = (f) => Object.assign(f, { lazy: true });
  window.require = (id) => {
    try { return requireFrom(id, '/'); } catch (e) { rlog('error', `require('${id}') failed:`, e); throw e; }
  };

  builtins.buffer = lazy(() => requireFrom('/node_modules/buffer/index.js', '/'));
  Object.defineProperty(window, 'Buffer', {
    configurable: true,
    get() { const { Buffer } = window.require('buffer'); Object.defineProperty(window, 'Buffer', { value: Buffer, writable: true }); return Buffer; },
  });

  // --------------------------------------------------------------------- fs
  const toText = (d) => (typeof d === 'string' ? d : String(d));
  const encOf = (o) => (typeof o === 'string' ? o : o && o.encoding);
  const stat = (p) => {
    const s = sync('fs/stat', { path: p });
    return {
      size: s.size,
      mtimeMs: s.mtimeMs,
      mtime: new Date(s.mtimeMs),
      ctime: new Date(s.ctimeMs),
      isFile: () => s.isFile,
      isDirectory: () => s.isDirectory,
    };
  };
  const fs = {
    readFileSync(p, o) { const s = sync('fs/readFile', { path: p }); return encOf(o) ? s : Buffer.from(s); },
    writeFileSync(p, d, o) { sync('fs/writeFile', { path: p, data: toText(d), mode: o && typeof o === 'object' ? o.mode : undefined }); },
    appendFileSync(p, d, o) { sync('fs/appendFile', { path: p, data: toText(d), mode: o && typeof o === 'object' ? o.mode : undefined }); },
    existsSync: (p) => sync('fs/exists', { path: p }),
    statSync: stat,
    lstatSync: stat,
    readdirSync: (p) => sync('fs/readdir', { path: p }),
    // o: a mode number, or {recursive, mode}.
    mkdirSync(p, o) {
      const mode = typeof o === 'number' ? o : o && o.mode;
      sync('fs/mkdir', { path: p, recursive: !!(o && o.recursive), mode });
    },
    unlinkSync(p) { sync('fs/unlink', { path: p }); },
    rmdirSync(p) { sync('fs/rmdir', { path: p }); },
    rmSync(p, o) { try { sync('fs/unlink', { path: p }); } catch (e) { if (!(o && o.force && e.code === 'ENOENT')) throw e; } },
    renameSync(p, to) { sync('fs/rename', { path: p, to }); },
  };
  const later = (cb, f) => setTimeout(() => { let r; try { r = f(); } catch (e) { cb(e); return; } cb(null, r); });
  fs.readFile = (p, o, cb) => { if (typeof o === 'function') { cb = o; o = undefined; } later(cb, () => fs.readFileSync(p, o)); };
  fs.writeFile = (p, d, o, cb) => { if (typeof o === 'function') cb = o; later(cb || (() => {}), () => fs.writeFileSync(p, d)); };
  fs.appendFile = (p, d, o, cb) => { if (typeof o === 'function') cb = o; later(cb || (() => {}), () => fs.appendFileSync(p, d)); };
  builtins.fs = fs;

  // --------------------------------------------- os, querystring, os-locale
  builtins.path = path;
  builtins.os = {
    homedir: () => R.paths.home,
    tmpdir: () => R.paths.temp,
    networkInterfaces: () => R.networkInterfaces,
    platform: () => R.platform,
    arch: () => R.arch,
    hostname: () => R.env.HOSTNAME || 'localhost',
    EOL: '\n',
  };
  builtins.querystring = {
    parse(s) {
      const o = {};
      (s || '').split('&').filter(Boolean).forEach((kv) => {
        const i = kv.indexOf('=');
        const k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, ' '));
        const v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
        o[k] = k in o ? [].concat(o[k], v) : v;
      });
      return o;
    },
    stringify: (o) => Object.keys(o).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(o[k])}`).join('&'),
  };
  // "en_GB.UTF-8" -> "en-GB", as os-locale reports it.
  builtins['os-locale'] = { sync: () => R.locale.split('.')[0].replace('_', '-') };
  builtins['@electron/remote/main'] = { enable() {}, initialize() {} };

  // ------------------------------------------------------- Tauri plumbing
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const tev = () => window.__TAURI__.event;
  const currentId = () => {
    const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
    return label === 'main' ? 1 : +label.slice(1);
  };

  // --------------------------------------------------------------- node-ipc
  // node-ipc over Tauri's cross-window events. Channels are scoped by
  // config.appspace: ipc_<appspace>_srv carries client-to-server messages,
  // ipc_<appspace>_cli_<id> server-to-client ones, ipc_<appspace>_all
  // broadcasts. Clients repeat a handshake every config.retry ms until the
  // server acknowledges it, as node-ipc retries a socket that is not up yet.
  const ipc = {
    config: { appspace: '', id: '', retry: 1500, silent: true, logInColor: false },
    of: {},
    server: null,
    log() {},
  };
  const chan = (...parts) => ['ipc', ipc.config.appspace, ...parts].join('_').replace(/[^\w:/-]/g, '-');
  class IpcServer extends EventEmitter {
    start() {
      this._un = tev().listen(chan('srv'), ({ payload: { from, event, data } }) => {
        const socket = { id: from };
        if (event === '__connect') this.emit(socket, '__connected');
        else this._dispatch(event, data, socket);
      });
    }
    _dispatch(event, ...a) { EventEmitter.prototype.emit.call(this, event, ...a); }
    emit(socket, event, data) { tev().emit(chan('cli', socket.id), { event, data }); }
    broadcast(event, data) { tev().emit(chan('all'), { event, data }); }
    stop() { if (this._un) this._un.then((f) => f()); }
  }
  class IpcClient extends EventEmitter {
    constructor(serverId) { super(); this.serverId = serverId; this.me = ipc.config.id; }
    _start() {
      const recv = ({ payload: { event, data } }) => {
        if (event === '__connected') {
          if (!this.connected) { this.connected = true; clearInterval(this._retry); this._dispatch('connect'); }
        } else this._dispatch(event, data);
      };
      this._uns = [tev().listen(chan('cli', this.me), recv), tev().listen(chan('all'), recv)];
      Promise.all(this._uns).then(() => {
        const hello = () => tev().emit(chan('srv'), { from: this.me, event: '__connect' });
        hello();
        this._retry = setInterval(hello, ipc.config.retry || 1500);
      });
    }
    _dispatch(event, ...a) { EventEmitter.prototype.emit.call(this, event, ...a); }
    emit(event, data) { tev().emit(chan('srv'), { from: this.me, event, data }); }
    _stop() { clearInterval(this._retry); (this._uns || []).forEach((u) => u.then((f) => f())); }
  }
  ipc.serve = (cb) => { ipc.server = new IpcServer(); if (cb) cb(); };
  ipc.connectTo = (id, cb) => {
    const c = new IpcClient(id);
    ipc.of[id] = c;
    if (cb) cb();
    c._start();
  };
  ipc.disconnect = (id) => { if (ipc.of[id]) { ipc.of[id]._stop(); delete ipc.of[id]; } };
  ipc.default = ipc;
  builtins['node-ipc'] = ipc;

  // -------------------------------------------------------------------- net
  // Sockets and servers live in Rust (src-tauri/src/net.rs) under ids this
  // side chooses, so listeners attach before the async work completes. Data
  // received before a 'data' listener exists is held back, as Node's paused
  // streams do; RIDE attaches its listener only once connected.
  let seq = 0;
  const newId = (kind) => `${window.__TAURI_INTERNALS__.metadata.currentWindow.label}:${kind}${seq += 1}`;
  const nodeErr = (e) => {
    const x = new Error((e && e.message) || String(e));
    if (e && e.code) x.code = e.code;
    return x;
  };
  const sockets = new Map();
  const servers = new Map();
  let netEvents = null;
  const netReady = () => {
    if (!netEvents) {
      netEvents = tev().listen('ride-net', ({ payload: p }) => {
        const t = sockets.get(p.id) || servers.get(p.id);
        if (t) t._event(p);
      });
    }
    return netEvents;
  };
  class Socket extends EventEmitter {
    constructor(id) {
      super();
      this._id = id || newId('s');
      this._held = [];
      this.destroyed = false;
      this.connecting = false;
      sockets.set(this._id, this);
    }
    on(n, f) {
      super.on(n, f);
      if (n === 'data' && this._held.length) {
        const held = this._held;
        this._held = [];
        queueMicrotask(() => held.forEach((p) => this._event(p)));
      }
      return this;
    }
    _event(p) {
      if ((p.event === 'data' || p.event === 'end') && (!this.listenerCount('data') || this._held.length)) {
        this._held.push(p);
        return;
      }
      if (p.event === 'data') this.emit('data', Buffer.from(p.data, 'base64'));
      else if (p.event === 'end') this.emit('end');
      else if (p.event === 'error') this.emit('error', nodeErr(p.error));
      else if (p.event === 'close') {
        this.destroyed = true;
        sockets.delete(this._id);
        this.emit('close', false);
      }
    }
    write(d, enc, cb) {
      const done = typeof enc === 'function' ? enc : cb;
      const buf = typeof d === 'string' ? Buffer.from(d, typeof enc === 'string' ? enc : 'utf8') : Buffer.from(d);
      invoke('net_write', { id: this._id, data: buf.toString('base64') }).then(
        () => done && done(),
        (e) => this.emit('error', nodeErr({ code: 'EPIPE', message: String(e) })),
      );
      return true;
    }
    end(d) { if (d) this.write(d); invoke('net_end', { id: this._id, destroy: false }); return this; }
    destroy() { this.destroyed = true; invoke('net_end', { id: this._id, destroy: true }); return this; }
    address() { return { address: this.localAddress, port: this.localPort }; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    setTimeout() { return this; }
    setEncoding() { return this; }
    ref() { return this; }
    unref() { return this; }
  }
  const connect = (...a) => {
    let o;
    if (a[0] && typeof a[0] === 'object') o = a[0];
    else o = { port: a[0], host: typeof a[1] === 'string' ? a[1] : undefined };
    const cb = a.find((f) => typeof f === 'function');
    const s = new Socket();
    s.connecting = true;
    if (cb) s.once('connect', cb);
    netReady()
      .then(() => invoke('net_connect', { id: s._id, host: o.host || 'localhost', port: +o.port }))
      .then((info) => {
        Object.assign(s, info);
        s.connecting = false;
        s.emit('connect');
        s.emit('ready');
      }, (e) => {
        s.connecting = false;
        sockets.delete(s._id);
        s.emit('error', nodeErr(e));
        s.emit('close', true);
      });
    return s;
  };
  class Server extends EventEmitter {
    constructor(cb) {
      super();
      this._id = newId('l');
      this.listening = false;
      if (cb) this.on('connection', cb);
      servers.set(this._id, this);
    }
    _event(p) {
      if (p.event === 'connection') {
        const c = new Socket(p.conn);
        c.remoteAddress = p.remoteAddress;
        c.remotePort = p.remotePort;
        this.emit('connection', c);
      } else if (p.event === 'error') this.emit('error', nodeErr(p.error));
      else if (p.event === 'close') { servers.delete(this._id); this.emit('close'); }
    }
    listen(...a) {
      let port = a[0];
      let host = typeof a[1] === 'string' ? a[1] : '';
      if (port && typeof port === 'object') { host = port.host || ''; port = port.port; }
      const cb = a.find((f) => typeof f === 'function');
      if (cb) this.once('listening', cb);
      netReady()
        .then(() => invoke('net_listen', { id: this._id, host, port: +port || 0 }))
        .then((addr) => { this._addr = addr; this.listening = true; this.emit('listening'); }, (e) => this.emit('error', nodeErr(e)));
      return this;
    }
    address() { return this._addr || null; }
    close(cb) {
      if (cb) this.once('close', cb);
      this.listening = false;
      invoke('net_close_server', { id: this._id });
      return this;
    }
    ref() { return this; }
    unref() { return this; }
  }
  builtins.net = {
    Socket,
    Server,
    connect,
    createConnection: connect,
    createServer: (o, cb) => new Server(typeof o === 'function' ? o : cb),
    isIP: (s) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : (/:/.test(s) ? 6 : 0)),
  };

  // ---------------------------------------------------------- child_process
  const procs = new Map();
  let procEvents = null;
  const procReady = () => {
    if (!procEvents) {
      procEvents = tev().listen('ride-proc', ({ payload: p }) => {
        const c = procs.get(p.id);
        if (c && p.event === 'exit') {
          procs.delete(p.id);
          c.exitCode = p.code;
          c.signalCode = p.signal;
          c.emit('exit', p.code, p.signal);
          c.emit('close', p.code, p.signal);
        }
      });
    }
    return procEvents;
  };
  class ChildProcess extends EventEmitter {
    constructor() {
      super();
      this._id = newId('p');
      this.pid = undefined;
      this.exitCode = null;
      this.stdin = { write() { return true; }, end() {} };
      this.stdout = null;
      this.stderr = null;
      procs.set(this._id, this);
    }
    kill(signal) { invoke('proc_kill', { id: this._id, signal: signal || null }).catch(() => {}); return true; }
    unref() {}
    ref() {}
  }
  const spawn = (exe, args, opts) => {
    const o = opts || {};
    let stdio = o.stdio || 'pipe';
    if (typeof stdio === 'string') stdio = [stdio, stdio, stdio];
    const env = o.env ? Object.fromEntries(Object.entries(o.env).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])) : null;
    const c = new ChildProcess();
    procReady()
      .then(() => invoke('proc_spawn', {
        id: c._id,
        exe,
        args: (args || []).map(String),
        opts: { cwd: o.cwd || null, env, stdio, detached: !!o.detached },
      }))
      .then((pid) => { c.pid = pid; c.emit('spawn'); }, (e) => { procs.delete(c._id); c.emit('error', nodeErr(e)); });
    return c;
  };
  builtins.child_process = {
    spawn,
    ChildProcess,
    execSync() { throw Object.assign(new Error('execSync is not available in Ride under Tauri'), { code: 'ENOSYS' }); },
    exec(cmd, o, cb) { (typeof o === 'function' ? o : cb)(Object.assign(new Error('exec is not available'), { code: 'ENOSYS' })); },
  };
  builtins.tls = {
    connect() { throw Object.assign(new Error('TLS connections are not available yet in Ride under Tauri'), { code: 'ENOSYS' }); },
  };

  // ---------------------------------------------------------- BrowserWindow
  // Window ids come from Rust (main = 1). A window is created when its URL is
  // loaded; calls made before then are queued behind the creation.
  // RIDE's own pages load from the app; any other file:// URL (3500⌶ writes
  // its HTML to a temp file) goes through the ridefile:// scheme.
  const appPage = /^\/?(index|dialog|status|about|empty)\.html([?#].*)?$/;
  const appUrl = (u) => {
    const str = String(u);
    if (/^file:\/\//.test(str)) {
      const p = str.replace(/^file:\/\//, '');
      if (!appPage.test(p)) return `ridefile://localhost${encodeURI(p.startsWith('/') ? p : `/${p}`)}`;
    }
    // The main window's location is "tauri://localhost" with no path, so the
    // host match stops at ? and # as well as /.
    let s = str.replace(/^file:\/\//, '').replace(/^[a-z]+:\/\/[^/?#]*/i, '');
    s = s.replace(/^\/+/, '');
    return s === '' || s.startsWith('?') ? `index.html${s}` : s;
  };
  const windows = new Map();
  let winEvents = null;
  const ensureWinEvents = () => {
    if (winEvents) return;
    winEvents = tev().listen('ride-win', ({ payload: { id, event } }) => {
      const w = windows.get(id);
      if (!w) return;
      if (event === 'closed') w._closed = true;
      if (event === 'did-finish-load') {
        w._markLoaded();
        EventEmitter.prototype.emit.call(w, 'ready-to-show', { sender: w });
        (w.webContents._ev['did-finish-load'] || []).slice().forEach((f) => f());
        return;
      }
      EventEmitter.prototype.emit.call(w, event, { sender: w, preventDefault() {} });
    });
  };
  class BrowserWindow extends EventEmitter {
    constructor(opts, existingId) {
      super();
      this.id = existingId || sync('win/alloc');
      this._opts = opts || {};
      // Calls made before loadURL (RIDE sets titles first) wait for the
      // window to be created.
      this._started = !!existingId;
      this._q = existingId ? Promise.resolve() : new Promise((r) => { this._markCreated = r; });
      // Scripts run once the page has loaded, as Electron's
      // executeJavaScript waits for it; existing windows already have.
      this._loaded = existingId ? Promise.resolve() : new Promise((r) => { this._markLoaded = r; });
      if (existingId) this._markLoaded = () => {};
      windows.set(this.id, this);
      ensureWinEvents();
      const call = (m, a) => this._call(m, a);
      this.webContents = {
        id: this.id,
        _ev: {},
        executeJavaScript: (js) => this._loaded.then(() => call('eval', { js })).then(() => undefined),
        print: () => call('print'),
        toggleDevTools: () => call('toggleDevTools'),
        openDevTools: () => { if (!this.webContents.isDevToolsOpened()) call('toggleDevTools'); },
        isDevToolsOpened: () => false,
        on(n, f) { (this._ev[n] = this._ev[n] || []).push(f); return this; },
        once(n, f) { return this.on(n, f); },
        send() {},
        focus: () => call('focus'),
        setZoomFactor() {},
        getURL: () => location.href,
      };
    }
    loadURL(url) {
      // A window that exists already navigates (3500⌶ reuses its window).
      if (this._started) {
        this._loaded = new Promise((r) => { this._markLoaded = r; });
        return this._call('navigate', { url: appUrl(url) });
      }
      this._started = true;
      const o = this._opts;
      const opts = {
        width: o.width, height: o.height, x: o.x, y: o.y,
        minWidth: o.minWidth, minHeight: o.minHeight,
        show: o.show !== false, resizable: o.resizable !== false, title: o.title,
        parent: o.parent ? o.parent.id : undefined,
      };
      const created = invoke('win_create', { id: this.id, url: appUrl(url), opts });
      created.then(() => this._markCreated(), (e) => { rlog('error', `window ${this.id} create failed:`, e); this._markCreated(); });
      return created;
    }
    loadFile(f) { return this.loadURL(f); }
    _call(method, args) {
      const p = (this._q || Promise.resolve()).then(() => invoke('win_call', { id: this.id, method, args: args || {} }));
      this._q = p.catch(() => {});
      return p.catch((e) => rlog('warn', `window ${this.id} ${method}:`, e));
    }
    _get(prop) {
      if (this._closed) return undefined;
      try { return sync('win/get', { id: this.id, prop }); } catch (e) { return undefined; }
    }
    show() { this._call('show'); }
    showInactive() { this._call('showInactive'); }
    hide() { this._call('hide'); }
    focus() { this._call('focus'); }
    blur() {}
    close() { this._call('close'); }
    destroy() { this._call('destroy'); }
    minimize() { this._call('minimize'); }
    maximize() { this._call('maximize'); }
    unmaximize() { this._call('unmaximize'); }
    restore() { this._call('unmaximize'); this._call('show'); }
    center() { this._call('center'); }
    setTitle(title) { this._call('setTitle', { title }); }
    setAlwaysOnTop(flag) { this._call('setAlwaysOnTop', { flag }); }
    setResizable(flag) { this._call('setResizable', { flag }); }
    setFullScreen(flag) { this._call('setFullScreen', { flag }); }
    setBounds(b) { this._call('setBounds', b); }
    setContentBounds(b) { this._call('setContentBounds', b); }
    setSize(width, height) { this._call('setSize', { width, height }); }
    setContentSize(width, height) { this._call('setContentSize', { width, height }); }
    setMinimumSize(width, height) { this._call('setMinimumSize', { width, height }); }
    setPosition(x, y) { this._call('setPosition', { x, y }); }
    setMenu() {}
    removeMenu() {}
    setMenuBarVisibility() {}
    setAutoHideMenuBar() {}
    isDestroyed() { return this._closed || (this._started && this._get('exists') === false); }
    isFocused() { return !!this._get('focused'); }
    isVisible() { return !!this._get('visible'); }
    isMaximized() { return !!this._get('maximized'); }
    isMinimized() { return !!this._get('minimized'); }
    isFullScreen() { return !!this._get('fullScreen'); }
    getTitle() { return this._get('title') || ''; }
    getBounds() { return this._get('bounds') || { x: 0, y: 0, width: 0, height: 0 }; }
    getContentBounds() { return this._get('contentBounds') || { x: 0, y: 0, width: 0, height: 0 }; }
    getSize() { const b = this.getBounds(); return [b.width, b.height]; }
    getContentSize() { const b = this.getContentBounds(); return [b.width, b.height]; }
    getPosition() { const b = this.getBounds(); return [b.x, b.y]; }
    static fromId(id) { return windows.get(id) || new BrowserWindow(null, id); }
    static getFocusedWindow() {
      const id = sync('win/get', { id: currentId(), prop: 'focusedId' });
      return id ? BrowserWindow.fromId(id) : null;
    }
    static getAllWindows() { return sync('win/get', { id: currentId(), prop: 'allIds' }).map(BrowserWindow.fromId); }
  }

  // ------------------------------------------------------ @electron/remote
  const winstate = new Proxy({}, {
    get: (t, k) => (typeof k === 'string' ? sync('winstate/get')[k] : undefined),
    set: (t, k, v) => { sync('winstate/set', { key: k, value: v }); return true; },
    has: (t, k) => k in sync('winstate/get'),
    ownKeys: () => Object.keys(sync('winstate/get')),
    getOwnPropertyDescriptor: (t, k) => {
      const s = sync('winstate/get');
      return k in s ? { value: s[k], enumerable: true, configurable: true, writable: true } : undefined;
    },
  });
  const workArea = () => ({ x: 0, y: 0, width: window.screen.availWidth, height: window.screen.availHeight });
  const display = () => ({ id: 0, bounds: workArea(), workArea: workArea(), scaleFactor: window.devicePixelRatio });
  const messageText = (o) => [o.title, o.message, o.detail].filter(Boolean).join('\n\n');
  // Electron's dialog calls take an optional parent window first.
  const dialogArgs = (w, o) => (w instanceof BrowserWindow ? [w, o || {}] : [null, w || {}]);
  // Native dialogs (src-tauri/src/dialog.rs) run synchronously, as Electron's
  // *Sync calls do; where they are unavailable, the webview's alert, confirm
  // and prompt stand in.
  const nativeMessageBox = (w, o) => {
    const [win, opts] = dialogArgs(w, o);
    try {
      return sync('dialog/message', { ...opts, window: (win || BrowserWindow.fromId(currentId())).id });
    } catch (e) {
      return { response: fallbackMessageBox(opts), checkboxChecked: false };
    }
  };
  const showMessageBoxSync = (w, o) => nativeMessageBox(w, o).response;
  const nativeFileDialog = (w, o, save) => {
    const [win, opts] = dialogArgs(w, o);
    try {
      return sync('dialog/file', { ...opts, save, window: (win || BrowserWindow.fromId(currentId())).id }) || undefined;
    } catch (e) {
      return pickPath(opts, save ? 'Save' : 'Open');
    }
  };
  const fallbackMessageBox = (o) => {
    const buttons = o.buttons && o.buttons.length ? o.buttons : ['OK'];
    const text = messageText(o);
    if (buttons.length === 1) { window.alert(text); return 0; }
    if (buttons.length === 2) return window.confirm(`${text}\n\n[OK: ${buttons[0]}, Cancel: ${buttons[1]}]`) ? 0 : 1;
    const answer = window.prompt(`${text}\n\n${buttons.map((b, i) => `${i + 1}: ${b}`).join('\n')}`, String((o.defaultId || 0) + 1));
    const n = parseInt(answer, 10) - 1;
    if (Number.isNaN(n) || n < 0 || n >= buttons.length) return o.cancelId != null ? o.cancelId : buttons.length - 1;
    return n;
  };
  const pickPath = (o, what) => {
    const p = window.prompt(`${(o && o.title) || what}\n\nPath:`, (o && o.defaultPath) || '');
    return p ? [p] : undefined;
  };
  // Popup menus are native (src-tauri/src/menu.rs); a click comes back as a
  // ride-menu event with the item's id. Electron's roles map to Monaco's
  // actions when an editor has focus, else to document.execCommand.
  const menuClicks = new Map();
  let menuSeq = 0;
  let menuEvents = null;
  const menuReady = () => {
    if (!menuEvents) {
      menuEvents = tev().listen('ride-menu', ({ payload: id }) => {
        const f = menuClicks.get(id);
        if (R.env.RIDE_TAURI_DEBUG) rlog('debug', `menu event ${JSON.stringify(id)}: ${f ? 'handled' : `no handler (have ${[...menuClicks.keys()]})`}`);
        if (f) f();
      });
    }
    return menuEvents;
  };
  const monacoAction = {
    cut: 'editor.action.clipboardCutAction',
    copy: 'editor.action.clipboardCopyAction',
    paste: 'editor.action.clipboardPasteAction',
    undo: 'undo',
    redo: 'redo',
    selectAll: 'editor.action.selectAll',
    selectall: 'editor.action.selectAll',
  };
  const runRole = (role) => {
    const eds = window.monaco ? window.monaco.editor.getEditors() : [];
    const ed = eds.find((e) => e.hasTextFocus()) || eds.find((e) => e.hasWidgetFocus());
    if (ed && monacoAction[role]) {
      ed.focus();
      ed.trigger('ride-menu', monacoAction[role], null);
    } else {
      document.execCommand(role === 'selectall' ? 'selectAll' : role);
    }
  };
  const menuItems = (items, prefix) => items
    .filter((it) => it.visible !== false)
    .map((it, i) => {
      const id = `${prefix}:${i}`;
      const sub = it.submenu && (Array.isArray(it.submenu) ? it.submenu : it.submenu.items);
      if (!sub && it.type !== 'separator') {
        menuClicks.set(id, () => {
          if (typeof it.click === 'function') it.click(it, BrowserWindow.fromId(currentId()), {});
          else if (it.role) runRole(it.role);
        });
      }
      return {
        id,
        label: it.label || (it.role ? it.role[0].toUpperCase() + it.role.slice(1) : ''),
        kind: it.type === 'separator' ? 'separator' : (it.type === 'checkbox' || it.type === 'radio' ? 'checkbox' : 'normal'),
        checked: !!it.checked,
        enabled: it.enabled !== false,
        submenu: sub ? menuItems(sub, id) : undefined,
      };
    });
  class MenuItem { constructor(o) { Object.assign(this, o); } }
  class Menu {
    constructor() { this.items = []; }
    append(i) { this.items.push(i); }
    insert(n, i) { this.items.splice(n, 0, i); }
    popup() {
      menuClicks.clear();
      menuSeq += 1;
      const items = menuItems(this.items, `ctx:${menuSeq}`);
      menuReady().then(() => invoke('popup_menu', { items })).catch((e) => rlog('error', 'popup menu failed:', e));
    }
    closePopup() {}
    static buildFromTemplate(t) { const m = new Menu(); t.forEach((o) => m.append(new MenuItem(o))); return m; }
    static setApplicationMenu() {}
    static getApplicationMenu() { return null; }
  }
  const shell = {
    openExternal: (url) => invoke('open_url', { url }),
    openPath: (p) => invoke('open_url', { url: p }).then(() => ''),
    showItemInFolder: (p) => invoke('open_url', { url: path.dirname(p) }),
  };
  const clipboard = {
    writeText: (t) => navigator.clipboard.writeText(t),
    readText: () => '',
  };
  const remote = {
    BrowserWindow,
    Menu,
    MenuItem,
    process: proc,
    shell,
    clipboard,
    screen: { getDisplayMatching: display, getDisplayNearestPoint: display, getPrimaryDisplay: display, getAllDisplays: () => [display()] },
    dialog: {
      showMessageBoxSync,
      showMessageBox: (w, o) => Promise.resolve(nativeMessageBox(w, o)),
      showErrorBox: (title, content) => nativeMessageBox({ type: 'error', title, message: title, detail: content }),
      showOpenDialogSync: (w, o) => nativeFileDialog(w, o, false),
      showOpenDialog: (w, o) => {
        const filePaths = nativeFileDialog(w, o, false);
        return Promise.resolve({ canceled: !filePaths, filePaths: filePaths || [] });
      },
      showSaveDialogSync: (w, o) => (nativeFileDialog(w, o, true) || [])[0],
      showSaveDialog: (w, o) => {
        const filePath = (nativeFileDialog(w, o, true) || [])[0];
        return Promise.resolve({ canceled: !filePath, filePath });
      },
    },
    app: {
      getPath: (n) => ({
        userData: R.paths.userData,
        appData: path.dirname(R.paths.userData),
        temp: R.paths.temp,
        home: R.paths.home,
        exe: R.paths.exe,
      }[n] || R.paths.userData),
      getAppPath: () => path.dirname(R.paths.exe),
      getName: () => 'Ride-4.8',
      getVersion: () => ((window.D && window.D.versionInfo) || {}).version || '',
      getLocale: () => builtins['os-locale'].sync(),
      quit: () => invoke('win_call', { id: 1, method: 'close', args: {} }),
      exit: () => invoke('win_call', { id: 1, method: 'destroy', args: {} }),
      relaunch() {},
    },
    getGlobal(name) {
      if (name === 'D') return { win: R.platform === 'win32', mac: R.platform === 'darwin' };
      if (name === 'elw') return BrowserWindow.fromId(1);
      if (name === 'winstate') return winstate;
      return undefined;
    },
    getCurrentWindow: () => BrowserWindow.fromId(currentId()),
    getCurrentWebContents: () => BrowserWindow.fromId(currentId()).webContents,
    require: (id) => window.require(id),
  };
  builtins['@electron/remote'] = remote;
  builtins.electron = {
    remote,
    shell,
    clipboard,
    ipcRenderer: {
      // main.js's only channel: the renderer reports whether the launch page
      // or a session is showing, for window geometry.
      send(channel, onLaunch) { if (channel === 'save-win') invoke('save_win', { onLaunch: !!onLaunch }); },
      on() {},
      once() {},
      invoke: () => Promise.resolve(),
    },
  };

  // ----------------------------------------------------------- drag & drop
  // Electron gives dropped files a .path, which webview File objects lack.
  // Tauri reports native drops with real paths; they reach RIDE's
  // window.ondrop as an Electron-style drop event.
  window.addEventListener('DOMContentLoaded', () => {
    const wv = window.__TAURI__ && window.__TAURI__.webview;
    if (!wv) return;
    wv.getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type !== 'drop' || typeof window.ondrop !== 'function') return;
      const files = payload.paths.map((p) => ({ path: p, name: path.basename(p) }));
      window.ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files } });
    });
  });

  // Exceptions thrown inside this injected script reach the page as an
  // opaque "Script error.", so every exported function logs what it throws.
  const traced = (obj, name, seen = new Set()) => {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function') || seen.has(obj)) return;
    seen.add(obj);
    Object.getOwnPropertyNames(obj).forEach((k) => {
      const d = Object.getOwnPropertyDescriptor(obj, k);
      if (!d || !d.configurable && !d.writable) return;
      if (typeof d.value === 'function' && !/^[A-Z]/.test(k)) {
        const f = d.value;
        obj[k] = function tracedFn(...a) {
          try { return f.apply(this, a); } catch (e) { rlog('error', `${name}.${k} threw:`, e); throw e; }
        };
      } else if (d.value && typeof d.value === 'object') traced(d.value, `${name}.${k}`, seen);
    });
  };
  Object.keys(builtins).forEach((k) => { if (typeof builtins[k] !== 'function') traced(builtins[k], k); });
  [BrowserWindow.prototype, IpcClient.prototype, IpcServer.prototype, EventEmitter.prototype].forEach((p) => traced(p, p.constructor.name));

  window.__rideBuiltins = builtins;
  if (R.env.RIDE_TAURI_DEBUG) rlog('debug', 'shim ready');
}());
