const test = require('ava');
const { tfw } = require('./_utils');
tfw.init({ src: 'se', interpreter: true });

test('Explain Last Error opens an accessible observation-gated panel without invoking Codex', async (t) => {
  const c = t.context.app.client;
  await c.execute(() => { D.prf.agentControl(0); D.prf.agent(0); D.commands.AGE(); });
  await c.waitUntil(() => c.execute(() => !!document.querySelector('#error-help:not([hidden])')), { timeout: 5000 });
  t.true(await c.execute(() => {
    const panel = document.querySelector('#error-help');
    return panel.getAttribute('aria-labelledby') === 'error-help-title'
      && /observ/i.test(panel.textContent)
      && !!panel.querySelector('button[data-action="close"]');
  }));
  await (await c.$('#error-help button[data-action="close"]')).click();
  t.true(await c.execute(() => document.querySelector('#error-help').hidden));
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { connect } = require('../tools/tauride-mcp/tauride-mcp');
const fixtureTest = process.platform === 'win32' ? test.skip : test;
const wait = (c, predicate, ...args) => c.waitUntil(() => c.execute(predicate, ...args), { timeout: 15000 });

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride error help '));
  const executable = path.join(dir, 'fake codex');
  let script = fs.readFileSync(path.join(__dirname, '../src-tauri/tests/fixtures/fake-codex-app-server.py'), 'utf8');
  script = script.replace("thread_number = 0", "with open(__file__ + '.pids', 'a') as log:\n    log.write(str(os.getpid()) + '\\n')\nthread_number = 0");
  script = script.replace("prompt = params['input'][0]['text']", "prompt = params['input'][0]['text']\n        with open(__file__ + '.contexts', 'a') as log:\n            log.write(json.dumps(prompt) + '\\n')\n        if os.path.exists(__file__ + '.wait'):\n            os.unlink(__file__ + '.wait')\n            time.sleep(60)");
  script = script.replaceAll('The array ranks differ. ', '<img src=x onerror=window.errorHelpInjected=true> ');
  fs.writeFileSync(executable, script, { mode: 0o700 });
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const c = t.context.app.client;
  await c.execute((exe) => { D.prf.sqp(0); D.prf.agentExecutable(exe); D.prf.agentModel(''); D.prf.agentControl(0); D.prf.agent(1); }, executable);
  await wait(c, () => D.agent && D.agent.level() === 'observe');
  return { executable, contexts: () => fs.existsSync(`${executable}.contexts`) ? fs.readFileSync(`${executable}.contexts`, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

async function failure(c, expression) {
  const before = await c.execute(() => D.agent.errorInfo()?.id);
  await wait(c, () => D.ide.connected && !D.ide.pending.length && D.ide.quiescent());
  await c.execute(text => D.ide.exec([text], 0), expression);
  await wait(c, id => !!D.agent.errorInfo() && D.agent.errorInfo().id !== id, before);
  return c.execute(() => D.agent.errorInfo());
}

async function menuExplain(c) {
  if (process.platform === 'darwin') {
    await c.execute(async () => {
      const current = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
      await current.setFocus(); D.installMenu(D.parseMenuDSL(D.prf.menu()));
    });
    let lastError;
    try {
      await c.waitUntil(async () => {
        try {
          const id = await c.execute(() => window.__TAURI_INTERNALS__.invoke('ui_test_menu_command',
            { command: 'AGE', expectedEnabled: true, dispatch: false }));
          return id.startsWith('app:main:');
        } catch (error) { lastError = error.message; return false; }
      }, { timeout: 10000 });
    } catch (error) { throw new Error(`Native AGE menu did not install: ${lastError || error.message}`); }
    await c.execute(() => window.__TAURI_INTERNALS__.invoke('ui_test_menu_command',
      { command: 'AGE', expectedEnabled: true, dispatch: true }));
  } else {
    await c.execute(() => {
      const find = items => items.reduce((found, item) => found || (item.cmd === 'AGE' ? item : item.items && find(item.items)), null);
      find(D.parseMenuDSL(D.prf.menu())).action();
    });
  }
}
const complete = c => wait(c, () => /Complete/.test(document.querySelector('#error-help [role=status]')?.textContent || ''));
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

fixtureTest('native explanation preserves historical target, streams inert text, and coexists with attached MCP', async (t) => {
  const c = t.context.app.client;
  const fake = await fixture(t);
  const socket = path.join(t.context.userData, 'Ride-4.8', 'agent', process.platform === 'win32' ? 'main.port' : 'main.sock');
  await c.waitUntil(() => fs.existsSync(socket), { timeout: 10000 });
  const client = await connect(socket); t.teardown(() => client.close());
  await client.request('status');
  const old = await failure(c, 'missingErrorHelpHistorical');
  const latest = await failure(c, '1÷0');
  t.not(old.id, latest.id);
  const target = await c.execute((id) => {
    const model = D.ide.wins[0].me.getModel();
    for (let line = 1; line <= model.getLineCount(); line += 1) {
      if (D.agent.errorAt(0, line) === id) return { line, text: model.getLineContent(line) };
    }
    return null;
  }, old.id);
  t.truthy(target, 'the first error retains its own session target');
  t.regex(target.text, /VALUE ERROR/);
  await c.execute((line) => {
    const win = D.ide.wins[0];
    const original = D.el.Menu.buildFromTemplate;
    D.el.Menu.buildFromTemplate = (items) => {
      D.el.Menu.buildFromTemplate = original;
      const item = items.find(x => x.label === 'Explain this error');
      if (!item) throw new Error('Historical error context menu missing');
      return { popup() { item.click(); } };
    };
    const model = win.me.getModel();
    win.me.revealLineInCenter(line);
    const position = win.me.getScrolledVisiblePosition({ lineNumber: line, column: model.getLineFirstNonWhitespaceColumn(line) || 1 });
    const bounds = win.me.getDomNode().getBoundingClientRect();
    win.me.getDomNode().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: bounds.left + position.left + 3, clientY: bounds.top + position.top + 3 }));
  }, target.line);
  await complete(c);
  t.true(fake.contexts().at(-1).includes(old.id));
  t.false(fake.contexts().at(-1).includes(`"id":"${latest.id}"`));
  t.true(await c.execute(() => {
    const panel = document.querySelector('#error-help');
    return panel.querySelector('.error-help-text').textContent.includes('<img src=x')
      && !panel.querySelector('img,script') && !window.errorHelpInjected;
  }));
  await menuExplain(c); await complete(c);
  t.true(fake.contexts().at(-1).includes(latest.id), 'native Agent menu chooses the latest error');
  t.true((await client.request('status')).connected, 'companion leaves the existing MCP connection working');
});

fixtureTest('cancel then immediate Retry starts successfully and disabling observation reaps Codex', async (t) => {
  const c = t.context.app.client;
  const fake = await fixture(t);
  await failure(c, 'missingErrorHelpCancellation');
  fs.writeFileSync(`${fake.executable}.wait`, '');
  await menuExplain(c);
  await c.waitUntil(() => fake.contexts().length === 1, { timeout: 10000 });
  await (await c.$('#error-help button[data-action="cancel"]')).click();
  await (await c.$('#error-help button[data-action="retry"]')).click();
  await complete(c);
  t.is(fake.contexts().length, 2, 'Retry reaches a fresh turn after cancellation');
  fs.writeFileSync(`${fake.executable}.wait`, '');
  await (await c.$('#error-help button[data-action="retry"]')).click();
  await c.waitUntil(() => fake.contexts().length === 3, { timeout: 10000 });
  await c.execute(() => D.prf.agent(0));
  await wait(c, () => document.querySelector('#error-help').hidden && !D.agent.errorInfo());
  const pids = fs.readFileSync(`${fake.executable}.pids`, 'utf8').trim().split('\n').map(Number);
  await c.waitUntil(() => pids.every(pid => !processAlive(pid)), { timeout: 10000, timeoutMsg: 'Disabling observation left a companion child running' });
});

fixtureTest('a real suspended function contributes source, current line and bounded local values', async (t) => {
  const c = t.context.app.client;
  const fake = await fixture(t);
  await c.execute(() => {
    D.prf.floating(0);
    D.ide.exec(["⎕FX 'r←ErrorHelpProbe x;local' 'local←42' 'r←local+missingErrorHelpSource'"], 0);
  });
  await wait(c, () => D.ide.wins[0].me.getValue().includes('ErrorHelpProbe') && D.ide.quiescent());
  const info = await failure(c, 'ErrorHelpProbe 7');
  await wait(c, () => Object.values(D.ide.wins).some(w => w.tc && w.HIGHLIGHT));
  await menuExplain(c); await complete(c);
  const sent = fake.contexts().at(-1);
  const context = JSON.parse(sent.slice(sent.indexOf('\n') + 1));
  const source = context.windows.find(w => w.name.endsWith('ErrorHelpProbe'));
  t.truthy(source, 'actual error source is captured from the suspended tracer');
  t.true(source.text.some(line => line.includes('missingErrorHelpSource')));
  t.true(source.executableText.some(line => line.includes('local←42')));
  t.true(Number.isInteger(source.currentLine));
  t.true(context.values.some(value => value.name === 'local' && JSON.stringify(value.tip).includes('42')), 'local preview comes from the suspended frame');
  t.true(context.values.length <= 6);
  t.true(!!context.stack && JSON.stringify(context.stack).includes('ErrorHelpProbe'), 'stack names the suspended error frame');
  t.is(context.id, info.id);
  t.true(sent.includes('missingErrorHelpSource'));
  t.true(sent.includes('local'));
  t.true(sent.includes('42'));
});

fixtureTest('floating tracer target resolves in its owner and explains in the session panel', async (t) => {
  const c = t.context.app.client;
  const fake = await fixture(t);
  const owner = await c.getWindowHandle();
  await c.execute(() => {
    D.prf.floating(1); D.prf.floatSingle(0);
    D.ide.exec(["⎕FX 'r←ErrorHelpFloating x;local' 'local←21' 'r←local+missingErrorHelpFloating'"], 0);
  });
  await wait(c, () => D.ide.wins[0].me.getValue().includes('ErrorHelpFloating') && D.ide.quiescent());
  const info = await failure(c, 'ErrorHelpFloating 7');
  let floating; let token; let line;
  await c.waitUntil(async () => {
    for (const handle of await c.getWindowHandles()) {
      if (handle === owner) continue;
      await c.switchToWindow(handle);
      const tracer = await c.execute(() => {
        const w = D.ide && Object.values(D.ide.wins).find(x => x.tc && x.HIGHLIGHT && x.me);
        return w && { token: w.id, line: w.HIGHLIGHT.lineStart };
      });
      if (tracer) { floating = handle; token = tracer.token; line = tracer.line; return true; }
    }
    await c.switchToWindow(owner); return false;
  }, { timeout: 15000 });
  t.truthy(floating);
  t.is(await c.execute((id, row) => D.errorHelpTarget(id, row), token, line), info.id,
    'floating context menu resolves the exact highlighted error in its owner');
  t.is(await c.execute((id, row) => D.errorHelpTarget(id, row), token, line + 1000), null,
    'unrelated helper rows never fall back to the latest error');
  const explainFromHelper = async () => {
    await c.switchToWindow(floating);
    await wait(c, async () => {
      const current = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
      await current.setFocus();
      return (await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label: current.label })).focused;
    });
    await c.execute((id, row) => D.errorHelpTarget(id, row).then(error => {
      D.ide.ipc.emit('explainError', { id: error });
    }), token, line);
    await wait(c, async (label) => (await window.__TAURI_INTERNALS__.invoke('ui_test_window_state', { label })).focused, owner);
    await c.switchToWindow(owner); await complete(c);
    await wait(c, () => document.querySelector('#error-help').contains(document.activeElement));
  };
  await explainFromHelper();
  await c.execute(() => D.ide.wins[0].focus());
  await explainFromHelper();
  t.is(fake.contexts().length, 2, 'explaining again raises an already-open session panel');
  t.true(fake.contexts().at(-1).includes(info.id));
  t.true(fake.contexts().at(-1).includes('missingErrorHelpFloating'), 'owner request includes floating source');
  await c.switchToWindow(floating);
  t.false(await c.execute(() => !!document.querySelector('#error-help:not([hidden])')),
    'helper does not launch a separate companion');
  await c.switchToWindow(owner);
});
