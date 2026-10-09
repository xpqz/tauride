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
    // The core is loaded from here rather than from index.html so the
    // Electron build, which shares the page, never fetches a script it does
    // not use. The pages' CSP allows same-origin scripts, not eval.
    const coreLoaded = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = document.currentScript.src.replace(/agent\.js(\?.*)?$/, 'agent_core.js');
      s.onload = () => resolve(window.agentCore);
      s.onerror = () => reject(new Error('agent_core.js did not load'));
      document.head.appendChild(s);
    });

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
      const model = w && w.id && w.me && w.me.getModel();
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
      confirm: (request) => D.agent.confirm(request),
      onAgentEcho: (seq, text) => D.agent.onAgentEcho && D.agent.onAgentEcho(seq, text),
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
      coreLoaded.then((ac) => {
        core = ac.create(io);
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

    D.agent = {
      // observe opens the port; control also allows the control requests.
      // Refusals follow at once; the port opens or closes with the level.
      setLevel(observe, control) {
        if (control) want = 'control';
        else want = observe ? 'observe' : null;
        if (started) {
          core.setLevel(want);
          ready.then(apply).catch((e) => console.error('agent:', e));
        } else status();
      },
      level: () => want,
      connected: () => !!(core && core.connected()),
      // Asked before every control request except interrupt while agentConfirm
      // is on; the UI task replaces it with a Run / Deny toast.
      confirm: async () => true,
      // onAgentEcho(seq, text), set by the UI task: an agent-originated input
      // echo has arrived, ahead of the session rendering it.
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
      core.recv(x, y);
    };
    const tapSend = (x, y) => core.sent(x, y);
    hook('recv', (x, y) => relay(tapRecv, x, y));
    hook('send', (x, y) => relay(tapSend, x, y));
  })();
}
