#!/usr/bin/env node
// Load smoke for the zero-footprint bundle (node mk zf): serves a directory
// over http, loads its index.html in headless Chrome and fails on any
// uncaught exception or error-level console message. In browser mode the
// page builds its IDE before its WebSocket connects, so no interpreter is
// needed; the session tab and the html menu in the dumped DOM show that the
// scripts ran. A request for a file the directory lacks fails the run, so
// this also checks that the bundle is complete.
//
//   node tools/zf-smoke.js [dir]     dir defaults to _/zf
//   CHROME=/path/to/chrome           the browser binary; otherwise Google
//                                    Chrome's macOS path, or google-chrome
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', '_', 'zf'));
const chrome = process.env.CHROME
  || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');

// Chrome refuses a stylesheet or font served with the wrong type.
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

const notServed = [];
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const f = path.join(dir, p === '/' ? 'index.html' : p);
  if (!f.startsWith(dir + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    notServed.push(p);
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  if (p === '/') {
    const html = fs.readFileSync(f, 'utf8').replace('</body>', `
<script>
  D.mop.then(async () => {
    const worker = monaco.editor.createWebWorker({ worker: MonacoEnvironment.getWorker('', 'editor') });
    try {
      await worker.getProxy();
      document.body.setAttribute('data-monaco-worker', 'ready');
    } finally { worker.dispose(); }
  });
</script>
</body>`);
    res.end(html);
  } else fs.createReadStream(f).pipe(res);
});

// Chrome logs every console level as INFO, so an uncaught exception is
// recognised by its text; :ERROR:CONSOLE covers builds that log the level.
const isError = (l) => /Uncaught|:ERROR:CONSOLE/.test(l);

// Signs that the scripts ran: golden layout fills the session tab's title and
// menu.js prepends the html menu to the body.
const checks = {
  'session caption': /<span class="lm_title">Session<\/span>/,
  'html menu': /<div class="menu"/,
  'Monaco worker': /data-monaco-worker="ready"/,
};

// Chrome prints the DOM once the virtual time budget is spent but then stays
// up for a long time (background services, the page's open connections), so
// the complete dump is the end of the run: a short grace period collects
// console lines that follow it, then Chrome is ended.
const graceMs = 3000;
const limitMs = 120000;

server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-smoke-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
    '--enable-logging=stderr', '--v=0', '--virtual-time-budget=10000', '--dump-dom', url,
  ];
  console.log(`serving ${dir} at ${url}`);
  const cp = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let dom = '';
  let log = '';
  let timer = setTimeout(() => {
    console.error(`no DOM dump within ${limitMs / 1000}s`);
    cp.kill('SIGKILL');
  }, limitMs);
  cp.stdout.on('data', (x) => {
    dom += x;
    if (/<\/html>\s*$/.test(dom)) {
      clearTimeout(timer);
      timer = setTimeout(() => { cp.kill(); }, graceMs);
    }
  });
  cp.stderr.on('data', (x) => { log += x; });
  cp.on('error', (e) => {
    console.error(`cannot run ${chrome}: ${e.message}`);
    process.exit(1);
  });
  cp.on('close', (code, signal) => {
    clearTimeout(timer);
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
    const lines = log.split('\n').filter((l) => l.includes('CONSOLE'));
    lines.forEach((l) => { console.log(l); });
    const errors = lines.filter(isError);
    notServed.forEach((p) => { console.error(`not served: ${p}`); });
    const missing = Object.keys(checks).filter((k) => !checks[k].test(dom));
    missing.forEach((k) => { console.error(`not in DOM: ${k}`); });
    const failed = !dom || errors.length || notServed.length || missing.length;
    console.log(`${lines.length} console message(s), ${errors.length} error(s), ${notServed.length} not served, ${dom.length} bytes of DOM, chrome ${signal || `exit ${code}`}: ${failed ? 'FAIL' : 'ok'}`);
    process.exit(failed ? 1 : 0);
  });
});
