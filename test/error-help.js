const test = require('ava');
const { tfw } = require('./_utils');
tfw.init({ src: 'se', interpreter: true });

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { connect } = require('../tools/tauride-mcp/tauride-mcp');
const fixtureTest = process.platform === 'win32' ? test.skip : test;
const wait = (c, predicate, ...args) => c.waitUntil(() => c.execute(predicate, ...args), { timeout: 15000 });

async function fixture(t, { observe = true, account = 'ready' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tauride error help '));
  const executable = path.join(dir, 'fake codex');
  let script = fs.readFileSync(path.join(__dirname, '../src-tauri/tests/fixtures/fake-codex-app-server.py'), 'utf8');
  script = script.replace("thread_number = 0", "with open(__file__ + '.pids', 'a') as log:\n    log.write(str(os.getpid()) + '\\n')\nthread_number = 0");
  script = script.replace("prompt = params['input'][0]['text']", "prompt = params['input'][0]['text']\n        with open(__file__ + '.contexts', 'a') as log:\n            log.write(json.dumps(prompt) + '\\n')\n        if os.path.exists(__file__ + '.wait'):\n            os.unlink(__file__ + '.wait')\n            time.sleep(60)");
  const firstDelta = '<img src=x onerror=window.errorHelpInjected=true> Check `⍴⍵` with\n``';
  const secondDelta = '`apl\n⍳3\n<img src=x onerror=window.errorHelpInjected=true>\n```\nCheck the operands.';
  // JSON string literals are valid Python strings for this fixture payload.
  script = script.replace("delta='The array ranks differ. '", `delta=${JSON.stringify(firstDelta)}`);
  script = script.replace("delta='Check the operands.'", `delta=${JSON.stringify(secondDelta)}`);
  script = script.replace("'text': 'The array ranks differ. Check the operands.'", `'text': ${JSON.stringify(firstDelta + secondDelta)}`);
  fs.writeFileSync(executable, script, { mode: 0o700 });
  fs.writeFileSync(`${executable}.account`, account);
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const c = t.context.app.client;
  await c.execute((exe, enabled) => { D.prf.sqp(0); D.prf.agentExecutable(exe); D.prf.agentModel(''); D.prf.agentControl(0); D.prf.agent(enabled ? 1 : 0); }, executable, observe);
  await wait(c, enabled => D.agent && (enabled ? D.agent.level() === 'observe' : !D.agent.level()), observe);
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

fixtureTest('Explain Last Error opens an accessible observation-gated panel without inference', async (t) => {
  const c = t.context.app.client;
  const fake = await fixture(t, { observe: false });
  await c.execute(() => D.commands.AGE());
  await c.waitUntil(() => c.execute(() => !!document.querySelector('#error-help:not([hidden])')), { timeout: 5000 });
  t.true(await c.execute(() => {
    const panel = document.querySelector('#error-help');
    return panel.getAttribute('aria-labelledby') === 'error-help-title'
      && /observ/i.test(panel.textContent)
      && !!panel.querySelector('button[data-action="close"]');
  }));
  t.is(fake.contexts().length, 0, 'setup probing never starts inference');
  await (await c.$('#error-help button[data-action="close"]')).click();
  t.true(await c.execute(() => document.querySelector('#error-help').hidden));
});

fixtureTest('first-use guidance enables observation without granting control or starting inference', async (t) => {
  const c = t.context.app.client;
  const fake = await fixture(t, { observe: false });
  await menuExplain(c);
  await wait(c, () => !document.querySelector('#error-help').hidden
    && !document.querySelector('#error-help button[data-action="observe"]').hidden);
  const setup = await c.execute(() => {
    const panel = document.querySelector('#error-help');
    return { text: panel.textContent, title: panel.querySelector('h2').textContent,
      preferences: !!panel.querySelector('button[data-action="preferences"]'),
      guide: !!panel.querySelector('a[href^="https://"]') };
  });
  t.regex(setup.title, /Codex/);
  t.regex(setup.text, /context|sent|send|shar/i, 'setup discloses context sharing');
  t.true(setup.preferences);
  t.true(setup.guide);
  t.is(fake.contexts().length, 0);
  const owner = await c.getWindowHandle();
  await (await c.$('#error-help button[data-action="preferences"]')).click();
  await wait(c, () => !!(D.prf_bw && D.prf_bw.socket));
  const preferences = await c.execute(() => D.prf_bw.win.label);
  await c.switchToWindow(preferences);
  await wait(c, () => !I.prf_dlg.hidden && !document.querySelector('#code').hidden);
  t.true(await c.execute(() => {
    const advanced = document.querySelector('#code_agexe').closest('details');
    return !!advanced && /Advanced/.test(advanced.querySelector('summary').textContent)
      && advanced.contains(document.querySelector('#code_agmodel'));
  }), 'Preferences keeps executable and model overrides under Advanced');
  await (await c.$('#code_agent details summary')).click();
  t.true(await (await c.$('#code_agexe')).isDisplayed());
  t.true(await (await c.$('#code_agmodel')).isDisplayed());
  await (await c.$('#prf_dlg_cancel')).click();
  await c.switchToWindow(owner);
  await (await c.$('#error-help button[data-action="observe"]')).click();
  await wait(c, () => D.agent.level() === 'observe'
    && /reproduce/i.test(document.querySelector('#error-help [role=status]').textContent));
  t.deepEqual(await c.execute(() => [!!D.prf.agent(), !!D.prf.agentControl()]), [true, false]);
  t.is(fake.contexts().length, 0, 'enabling observation never requests an explanation');
  await failure(c, 'missingErrorHelpOnboarding');
  await menuExplain(c); await complete(c);
  t.is(fake.contexts().length, 1, 'a reproduced error can be explicitly explained');
});

fixtureTest('missing Codex and signed-out Codex show actionable setup without inference', async (t) => {
  const c = t.context.app.client;
  const fake = await fixture(t, { account: 'signin' });
  await failure(c, 'missingErrorHelpSetup');
  await c.execute(executable => D.prf.agentExecutable(executable), `${fake.executable}-missing`);
  await menuExplain(c);
  await wait(c, () => /install|not found|could not find/i.test(document.querySelector('#error-help [role=status]').textContent));
  t.true(await c.execute(() => !!document.querySelector('#error-help a[href^="https://"]')));
  t.is(fake.contexts().length, 0);
  await c.execute(executable => D.prf.agentExecutable(executable), fake.executable);
  await (await c.$('#error-help button[data-action="check"]')).click();
  await wait(c, () => /sign.?in|log.?in/i.test(document.querySelector('#error-help [role=status]').textContent));
  t.regex(await c.execute(() => document.querySelector('#error-help').textContent), /codex login/i);
  t.is(fake.contexts().length, 0, 'setup checks never submit error context');
  fs.writeFileSync(`${fake.executable}.account`, 'ready');
  await (await c.$('#error-help button[data-action="check"]')).click();
  await wait(c, () => /ready/i.test(document.querySelector('#error-help [role=status]').textContent));
  t.is(fake.contexts().length, 0, 'a successful recheck still requires an explicit explanation');
  await (await c.$('#error-help button[data-action="retry"]')).click();
  await complete(c);
  t.is(fake.contexts().length, 1);
});

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
      const item = items.find(x => x.label === 'Explain this error with Codex…');
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
  const codeRendering = await c.execute(async () => {
    const text = document.querySelector('#error-help .error-help-text');
    const inline = text.querySelector('code');
    const block = text.querySelector('pre code');
    const loaded = await document.fonts.load('16px apl', '⍴⍵⍳');
    return {
      inline: inline && inline.textContent,
      block: block && block.textContent,
      fonts: [inline, block].map(node => node && getComputedStyle(node).fontFamily),
      loaded: loaded.length > 0 && document.fonts.check('16px apl', '⍴⍵⍳'),
    };
  });
  t.is(codeRendering.inline, '⍴⍵');
  t.is(codeRendering.block, '⍳3\n<img src=x onerror=window.errorHelpInjected=true>\n');
  codeRendering.fonts.forEach(font => t.regex(font, /\bapl\b/i));
  t.true(codeRendering.loaded, 'the APL font loads for explanation code');
  if (process.env.TAURIDE_ERROR_HELP_SCREENSHOT === '/tmp/tauride-error-code-render.png') {
    fs.writeFileSync(process.env.TAURIDE_ERROR_HELP_SCREENSHOT, await c.takeScreenshot(), 'base64');
  }
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
