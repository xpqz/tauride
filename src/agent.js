// Agent pairing (tauri/agent-pairing.md) in the session window of the Tauri
// build: the glue around src/agent_core.js. The tap sees the protocol at
// D.recv and D.send through accessors on D, so it wraps whatever is assigned
// to them, including the functions assigned on connect. This file moves
// frames between the core and the socket Rust serves (src-tauri/src/agent.rs),
// hands transcript batches to Rust, and carries out the IDE actions the core
// asks for. D.agent is the surface the menu, the status bar and the confirm
// toast drive.
if (window.__RIDE__) {
  (() => {
    // Helper windows load this page too; their traffic reaches the session
    // window through the IPC server, so only the session window taps.
    if (/[?&]type=/.test(window.location.search)) return;
    const { label } = window.__TAURI_INTERNALS__.metadata.currentWindow;
    const fs = nodeRequire('fs');
    const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
    const loadScript = (name, exported) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = document.currentScript.src.replace(/agent\.js(\?.*)?$/, name);
      s.onload = () => resolve(window[exported]);
      s.onerror = () => reject(new Error(`${name} did not load`));
      document.head.appendChild(s);
    });

    const coreLoaded = Promise.all([loadScript('agent_core.js', 'agentCore'), loadScript('error_context.js', 'errorContext')]);

    // Preferences are read through here because the booleans the UI task adds
    // (agent, agentControl, agentConfirm) may not exist yet, and the phase 1
    // `agent` was the string '0' | '1' | 'control'.
    const pref = (name) => {
      try { return D.prf[name] ? D.prf[name]() : undefined; } catch (e) { return undefined; }
    };
    const on = (v) => v === true || v === 1 || v === '1' || v === 'control';
    const env = process.env.RIDE_AGENT;
    // The environment sets the level at startup; from then on the menu drives it.
    let want;
    if (env) want = { 1: 'observe', control: 'control' }[env] || null;
    else if (on(pref('agentControl')) || pref('agent') === 'control') want = 'control';
    else want = on(pref('agent')) ? 'observe' : null;

    let core = null;
    let started = false; // the transcript path exists and the core follows `want`
    let listening = false; // the port is open
    let path = '';

    const status = () => {
      I.sb_agent.hidden = !want;
      I.sb_agent.innerText = `agent: ${want === 'control' ? 'control' : 'observing'}${D.agent.connected() ? ' (connected)' : ''}`;
    };

    // The wire shape of an editor or tracer. The session (id 0) and floating
    // editors, which are proxies without an editor in this window, have none.
    const describe = (w) => {
      // A window that is closing has lost its model already.
      const model = w && w.id && w.me && typeof w.me.getModel === 'function' && w.me.getModel();
      if (!model) return null;
      w.updStops();
      const stops = w.getStops();
      const byLine = (a, b) => a - b;
      return {
        token: w.id,
        name: w.name,
        kind: w.tc ? 'tracer' : 'editor',
        text: model.getLinesContent(),
        // 0-based, as the protocol's currentRow and SetHighlightLine.line are.
        currentLine: w.tc && w.HIGHLIGHT ? w.HIGHLIGHT.lineStart - 1 : w.me.getPosition().lineNumber - 1,
        stops,
        trace: [...w.trace].sort(byLine),
        monitor: [...w.monitor].sort(byLine),
        saved: w.me.getValue() === w.oText && `${stops}` === `${w.oStop}`,
      };
    };
    const io = {
      send: (frame) => invoke('agent_send', { label, line: JSON.stringify(frame) }).catch(() => {}),
      append: (lines) => invoke('transcript_append', { path, lines }).catch((e) => console.error('agent transcript:', e)),
      transcript: () => path,
      transcriptStatus: () => invoke('transcript_status', { path }).catch(() => null),
      ide: () => {
        const i = D.ide;
        return i ? {
          connected: !!i.connected,
          prompt: i.promptType,
          quiescent: i.quiescent(),
          pending: (i.pending || []).length,
          caption: i.caption,
          version: (D.remoteIdentification || {}).version || null,
        } : null;
      },
      exec: (text) => D.ide.exec([text], 0),
      interrupt: (strength) => D.commands[strength === 'strong' ? 'SI' : 'WI'](),
      windows: () => Object.keys(D.ide.wins).map((k) => describe(D.ide.wins[k])).filter(Boolean),
      window: (token) => describe(D.ide.wins[token]),
      // As the session's ED does for the name under the cursor.
      edit: (name) => D.ide.Edit({ win: 0, pos: 0, text: name }),
      // The editor's own save: FX compares the text and stops with what the
      // interpreter has and sends SaveChanges only when they differ. The
      // stops are read before setValue, which drops the model's decorations,
      // and put back after it, as ReplyFormatCode does.
      save: (token, lines, stops) => {
        const w = D.ide.wins[token];
        const { me } = w;
        const text = lines.join(me.getModel().getEOL());
        w.updStops();
        if (stops) w.stop = new Set(stops);
        if (text !== me.getValue()) me.setValue(text);
        w.setStop();
        const changed = text !== w.oText || `${w.getStops()}` !== `${w.oStop}`;
        w.FX(me);
        return changed;
      },
      // As a margin click does: the tracer tells the interpreter at once, the
      // editor keeps the stops for its save.
      stops: (token, lines) => {
        const w = D.ide.wins[token];
        w.updStops();
        w.stop = new Set(lines);
        w.setStop();
        w.setLineAttributes();
        return w.getStops();
      },
      trace: (token, action) => {
        const w = D.ide.wins[token];
        switch (action) {
          case 'step_into': w.TC(); break;
          case 'step_over': w.ER(w.me); break;
          case 'continue': w.RM(); break;
          case 'continue_trace': w.BH(); break;
          case 'back': w.BK(w.me); break;
          case 'forward': w.FD(w.me); break;
          // No window command sends Cutback; the message itself is the only path.
          case 'cutback': D.send('Cutback', { win: token }); break;
          case 'restart': w.MA(); break;
          // A click in the tracer's empty space: the window becomes an editor.
          case 'edit': w.ED(w.me, true); break;
          default:
        }
      },
      stack: () => D.send('GetSIStack', {}),
      // A token from the IDE's counter, so it cannot collide with a hover's; the
      // request is not registered with the IDE, whose ValueTip handler ignores
      // tokens it does not know, and the core matches the reply itself.
      value: (name) => {
        const { ide } = D;
        const { valueTipToken: token } = ide;
        ide.valueTipToken += 1;
        D.send('GetValueTip', {
          win: 0, line: name, pos: 0, maxWidth: 200, maxHeight: 100, token,
        });
        return token;
      },
      confirmNeeded: () => on(pref('agentConfirm')),
      confirm: (request, signal) => D.agent.confirm(request, signal),
      onAgentEcho: (seq, text) => D.agent.onAgentEcho && D.agent.onAgentEcho(seq, text),
    };

    let errorCapture;
    let settleTimer;
    const errorMarks = new Map();
    const errorTracers = new Map();
    const protocolWindows = new Map();
    const pendingMarks = [];
    let renderedModel;
    const renderedLines = new Set();
    const watchErrorOutput = () => {
      const se = D.ide && D.ide.wins[0];
      const model = se && se.me.getModel();
      if (!model || model === renderedModel) return;
      renderedModel = model;
      renderedLines.clear();
      model.onDidChangeContent((ev) => {
        if (!want) return;
        ev.changes.forEach((change) => {
          const end = change.range.startLineNumber + change.text.split('\n').length - 1;
          for (let line = change.range.startLineNumber; line <= end; line++) renderedLines.add(line);
        });
      });
    };
    const previewReplies = new Map();
    const errorListeners = new Set();
    const clearMarks = () => {
      errorMarks.forEach(({ model, decoration }) => {
        if (!model.isDisposed()) model.deltaDecorations([decoration], []);
      });
      errorMarks.clear();
      errorTracers.clear();
      protocolWindows.clear();
      pendingMarks.length = 0;
      renderedLines.clear();
    };
    const markErrors = () => {
      const se = D.ide && D.ide.wins[0];
      const model = se && se.me.getModel();
      if (!model) return;
      pendingMarks.splice(0).reverse().forEach(({ id, output }) => {
        const summary = errorCapture.info();
        const text = summary && summary.id === id ? summary.message : output.map((o) => o.text).join('').split('\n').find((line) => /ERROR|INTERRUPT|WS FULL/.test(line));
        if (!text) return;
        for (let line = model.getLineCount(); line > 0; line--) {
          if (!renderedLines.has(line)) continue;
          if (model.getLineContent(line).trim() !== text.trim()) continue;
          const occupied = [...errorMarks.values()].some((m) => m.model === model && model.getDecorationRange(m.decoration)?.startLineNumber === line);
          if (occupied) continue;
          const [decoration] = model.deltaDecorations([], [{
            range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
            options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
          }]);
          errorMarks.set(id, { model, decoration, text: model.getLineContent(line).trim() });
          while (errorMarks.size > 8) {
            const first = errorMarks.keys().next().value;
            const old = errorMarks.get(first);
            if (!old.model.isDisposed()) old.model.deltaDecorations([old.decoration], []);
            errorMarks.delete(first);
          }
          break;
        }
      });
    };
    const scheduleCapture = () => {
      if (settleTimer) return;
      const poll = () => {
        settleTimer = null;
        if (!errorCapture || !want || !D.ide || !D.ide.connected) return;
        if (!D.ide.quiescent()) { settleTimer = setTimeout(poll, 10); return; }
        errorCapture.settle().then(async () => {
          const summary = errorCapture.info();
          const bundle = summary && await errorCapture.context(summary.id);
          if (bundle) errorTracers.set(bundle.id, bundle.frameToken === undefined ? [] : [bundle.frameToken]);
          markErrors();
        });
      };
      settleTimer = setTimeout(poll, 10);
    };

    const onSocket = (p) => {
      if (p === true || p === null) { core.socket(p === true); status(); return; }
      if (typeof p === 'string') core.frame(p);
    };
    // Protocol traffic that arrives before the core script has loaded is
    // kept and replayed, so the transcript starts with the first message.
    let early = [];
    const relay = (f, x, y) => { core ? f(x, y) : early.push([f, x, y]); };
    const ready = Promise.all([
      coreLoaded.then(([ac, ec]) => {
        core = ac.create(io);
        errorCapture = ec.create({
          snapshot: (frameToken) => {
            const tracers = Object.values(D.ide.wins).filter((w) => w.tc)
              .sort((a, b) => Number(b.id === frameToken) - Number(a.id === frameToken));
            const windows = tracers.slice(0, 4).map((w) => {
              const description = describe(w);
              const cached = protocolWindows.get(w.id);
              if (description) {
                const line = description.currentLine;
                const startLine = Math.max(0, line - 2);
                return {
                  sourceSnippet: {
                    origin: 'executable', startLine,
                    lines: (w.oText || '').split('\n').slice(startLine, line + 3),
                  },
                  ...description,
                  executableText: (w.oText || '').slice(0, 24000).split('\n'),
                };
              }
              return cached && { ...cached, bufferUnavailable: 'Floating editor buffer unavailable; source is last received executable definition' };
            }).filter(Boolean);
            const summary = pendingMarks.length ? pendingMarks[pendingMarks.length - 1] : errorCapture.info();
            if (summary) {
              errorTracers.set(summary.id, windows.filter((w) => w.kind === 'tracer').map((w) => w.token));
              while (errorTracers.size > 8) errorTracers.delete(errorTracers.keys().next().value);
            }
            return { interpreter: io.ide(), windows };
          },
          onError: (id, output) => pendingMarks.push({ id, output }),
          requestStack: () => D.send('GetSIStack', {}),
          preview: (names, token) => Promise.all(names.map((name) => new Promise((resolve) => {
            const tipToken = D.ide.valueTipToken++;
            const timer = setTimeout(() => { previewReplies.delete(tipToken); resolve(null); }, 180);
            previewReplies.set(tipToken, (y) => { clearTimeout(timer); resolve({ name, tip: y.tip, class: y.class }); });
            D.send('GetValueTip', { win: token, line: name, pos: 0, maxWidth: 80, maxHeight: 6, token: tipToken });
          }))).then((values) => values.filter(Boolean)),
        });
        errorCapture.setEnabled(!!want);
        errorCapture.onChange((summary) => {
          if (!summary) clearMarks();
          errorListeners.forEach((listener) => listener(summary));
        });
        early.forEach(([f, x, y]) => relay(f, x, y));
        early = null;
      }),
      window.__TAURI__.event.listen('ride-agent', ({ payload }) => core && onSocket(payload), { target: { kind: 'WebviewWindow', label } }),
    ]);
    // The port follows the level: open while observing or controlling.
    const apply = () => {
      const l = core.level();
      if (l && !listening) {
        listening = true;
        invoke('agent_listen', { label }).catch((e) => { listening = false; console.error('agent socket:', e); });
      } else if (!l && listening) {
        listening = false;
        invoke('agent_close', { label }).catch(() => {});
      }
      status();
    };
    const start = () => {
      started = true;
      const dir = `${D.el.app.getPath('userData')}/sessions`;
      fs.mkdirSync(dir, { recursive: true });
      path = `${dir}/${label}-${D.ipc.config.appspace}.jsonl`;
      core.setLevel(want);
      ready.then(apply).catch((e) => console.error('agent:', e));
      window.addEventListener('pagehide', () => {
        core.flush();
        invoke('agent_close', { label }).catch(() => {});
      });
    };

    // The confirm toast. The request's fields are shown as text, never as
    // HTML, since the agent chose them. The toast is sticky and its own timer
    // ends it with a deny, in step with the core's deadline, so a toast never
    // outlives the request it asks about.
    const confirm = (m, signal) => new Promise((resolve) => {
      if (!on(pref('agentConfirm'))) { resolve(true); return; }
      if (signal.aborted) { resolve(false); return; }
      let done = false;
      let $toast;
      let timer;
      const answer = (yes) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        resolve(yes);
        if ($toast) {
          $toast.off('mouseenter mouseleave').stop(true, true);
          toastr.clear($toast, { force: true });
        }
      };
      const cancel = () => answer(false);
      signal.addEventListener('abort', cancel, { once: true });
      const fields = Object.keys(m).filter((k) => !['id', 'req', 'timeout'].includes(k))
        .map((k) => `${k}: ${typeof m[k] === 'string' ? m[k] : JSON.stringify(m[k])}`).join('\n');
      const $msg = $('<div class=agent-confirm>')
        .append($('<pre>').text(fields.length > 400 ? `${fields.slice(0, 400)}…` : fields))
        .append($('<button>').text('Run').on('click', () => answer(true)))
        .append($('<button>').text('Deny').on('click', () => answer(false)));
      $toast = toastr.info($msg, `Agent: ${m.req}`, {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        preventDuplicates: false, // the same line asked for twice is two questions
        onHidden: () => answer(false),
      });
      timer = setTimeout(() => answer(false), window.agentCore.CONFIRM_MS);
    });

    // Marking the agent's input lines. The echo reaches the tap before the
    // session renders it (ide.js queues protocol messages), so the text waits
    // until the session model changes; an edit whose inserted text holds the
    // line is the rendering, and the line is then found among the lines that
    // edit appended. Entries nothing renders (an echo rewritten by \b, say)
    // are dropped after a while.
    const echoes = [];
    let watched = null; // the session model listened to; a reconnect makes a new one
    const same = (a, b) => a === b || a.trim() === b.trim();
    const markEchoes = (me, ev) => {
      const now = Date.now();
      for (let i = echoes.length - 1; i >= 0; i--) if (now - echoes[i].at > 5000) echoes.splice(i, 1);
      if (!echoes.length) return;
      const model = me.getModel();
      ev.changes.forEach((c) => {
        const lines = c.text.split('\n');
        const last = model.getLineCount();
        echoes.slice().forEach((e) => {
          if (!lines.some((s) => same(s, e.text))) return;
          for (let l = last; l > Math.max(0, last - lines.length); l--) {
            if (same(model.getLineContent(l), e.text)) {
              echoes.splice(echoes.indexOf(e), 1);
              me.deltaDecorations([], [{
                range: new monaco.Range(l, 1, l, 1),
                options: {
                  isWholeLine: true,
                  className: 'agent-line',
                  glyphMarginClassName: 'agent-line-glyph',
                  stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                },
              }]);
              break;
            }
          }
        });
      });
    };
    const onAgentEcho = (seq, text) => {
      const se = D.ide && D.ide.wins[0];
      // A blank line would match any empty line; it gets no mark.
      if (!se || !text.trim()) return;
      const model = se.me.getModel();
      if (model !== watched) {
        watched = model;
        model.onDidChangeContent((ev) => markEchoes(se.me, ev));
      }
      echoes.push({ text, at: Date.now() });
    };

    D.agent = {
      // observe opens the port; control also allows the control requests.
      // Refusals follow at once; the port opens or closes with the level.
      setLevel(observe, control) {
        if (control) want = 'control';
        else want = observe ? 'observe' : null;
        if (started) {
          core.setLevel(want);
          errorCapture.setEnabled(!!want);
          ready.then(apply).catch((e) => console.error('agent:', e));
        } else status();
      },
      clearErrorContext: () => errorCapture && errorCapture.clear(),
      errorInfo: () => errorCapture ? errorCapture.info() : null,
      errorContext: (id) => errorCapture ? errorCapture.context(id) : Promise.resolve(null),
      errorAt(win, lineNumber) {
        if (!errorCapture || !want) return null;
        const w = typeof win === 'object' ? win : D.ide && D.ide.wins[win];
        if (!w || !w.me) return null;
        if (typeof w.me.getModel !== 'function') {
          const summary = errorCapture.info();
          const cached = protocolWindows.get(w.id);
          return summary && !summary.stale && cached && cached.kind === 'tracer' && lineNumber === cached.currentLine + 1 && (errorTracers.get(summary.id) || []).includes(w.id) ? summary.id : null;
        }
        const model = w.me.getModel();
        for (const [id, mark] of errorMarks) {
          const range = mark.model === model && model.getDecorationRange(mark.decoration);
          if (range && range.endColumn > range.startColumn && model.getLineContent(range.startLineNumber).trim() === mark.text && lineNumber >= range.startLineNumber && lineNumber <= range.endLineNumber) return id;
        }
        const summary = errorCapture.info();
        if (w.tc && summary && !summary.stale && (errorTracers.get(summary.id) || []).includes(w.id) && w.HIGHLIGHT && lineNumber === w.HIGHLIGHT.lineStart) return summary.id;
        return null;
      },
      onErrorChange(listener) { errorListeners.add(listener); return () => errorListeners.delete(listener); },
      level: () => want,
      connected: () => !!(core && core.connected()),
      // Asked before every control request except interrupt while agentConfirm
      // is on: Run or Deny; no answer within CONFIRM_MS is a deny.
      confirm,
      // An agent-originated input echo has arrived, ahead of the session
      // rendering it; the line gets the agent-line decoration once it has.
      onAgentEcho,
    };
    status();

    // D.recv is assigned when the IDE is created, D.send when the connect
    // page's module runs; both after this script. The accessor wraps each
    // assignment. The tap starts with the first message from an interpreter.
    const hook = (name, tap) => {
      let f = D[name];
      Object.defineProperty(D, name, {
        configurable: true,
        enumerable: true,
        get() { return f; },
        set(g) {
          f = typeof g !== 'function' ? g : (x, y) => {
            try { tap(x, y); } catch (e) { console.error(`agent ${name}:`, e); }
            return g(x, y);
          };
        },
      });
      if (f !== undefined) D[name] = f;
    };
    const tapRecv = (x, y) => {
      if (!started && D.ide) start();
      if (want && (x === 'OpenWindow' || x === 'UpdateWindow')) {
        const old = protocolWindows.get(y.token) || {};
        const line = y.currentRow || 0;
        const startLine = Math.max(0, line - 2);
        protocolWindows.set(y.token, {
          ...old, token: y.token, name: y.name || old.name,
          kind: (y.debugger === undefined ? old.kind === 'tracer' : y.debugger) ? 'tracer' : 'editor',
          currentLine: y.currentRow === undefined ? old.currentLine : y.currentRow,
          sourceSnippet: y.text ? {
            origin: 'executable', startLine,
            lines: y.text.slice(startLine, line + 3).map((text) => text.slice(0, 2000)),
          } : old.sourceSnippet,
          executableText: y.text ? y.text.join('\n').slice(0, 24000).split('\n').slice(0, 120) : old.executableText,
        });
        while (protocolWindows.size > 32) protocolWindows.delete(protocolWindows.keys().next().value);
      }
      if (x === 'SetHighlightLine' && protocolWindows.has(y.win)) {
        const cached = protocolWindows.get(y.win);
        cached.currentLine = y.line;
        const snippet = cached.sourceSnippet;
        if (!snippet || y.line < snippet.startLine || y.line >= snippet.startLine + snippet.lines.length) {
          const start = Math.max(0, y.line - 2);
          cached.sourceSnippet = cached.executableText && y.line < cached.executableText.length
            ? { origin: 'executable', startLine: start, lines: cached.executableText.slice(start, y.line + 3) }
            : { origin: 'executable', startLine: y.line, lines: [], unavailable: 'Highlighted source beyond retained protocol source' };
        }
      }
      if (x === 'CloseWindow') protocolWindows.delete(y.win);
      if (x === 'WindowTypeChanged' && protocolWindows.has(y.win)) protocolWindows.get(y.win).kind = y.tracer ? 'tracer' : 'editor';
      watchErrorOutput();
      core.recv(x, y);
      errorCapture.recv(x, y);
      if (x === 'ValueTip' && previewReplies.has(y.token)) {
        const reply = previewReplies.get(y.token); previewReplies.delete(y.token); reply(y);
      }
      if (x === 'HadError' || x === 'SetPromptType' || x === 'SetHighlightLine' || x === 'OpenWindow') scheduleCapture();
    };
    const tapSend = (x, y) => { if (x === 'Execute') renderedLines.clear(); core.sent(x, y); errorCapture.sent(x, y); };
    hook('recv', (x, y) => relay(tapRecv, x, y));
    hook('send', (x, y) => relay(tapSend, x, y));
  })();
}
