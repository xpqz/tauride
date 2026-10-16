(function errorContextModule(root) {
  const errorLine = (output) => output.flatMap((o) => o.text.split('\n')).find((line) => /(?:^|\b)(?:[A-Z][A-Z ]* ERROR|DOMAIN ERROR|SYNTAX ERROR|INTERRUPT|WS FULL|LIMIT ERROR)(?::|$)/.test(line.trim()));
  const freeze = (x) => {
    if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); }
    return x;
  };
  const resume = new Set(['Execute', 'RunCurrentLine', 'StepInto', 'TracePrimitive', 'TraceBackward', 'TraceForward', 'Continue', 'ContinueTrace', 'RestartThreads', 'Cutback', 'SetThread', 'SetSIStack']);
  const create = (io) => {
    const maxErrors = io.maxErrors || 8;
    const maxChars = io.maxChars || 24000;
    const maxLines = io.maxLines || 120;
    let enabled = false;
    let serial = 0;
    let epoch = 0;
    let input = [];
    let output = [];
    let stack;
    let frameToken;
    let latest = null;
    let outputTruncated = false;
    const entries = new Map();
    const stackRequests = [];
    const listeners = new Set();
    const info = () => latest ? freeze({ id: latest.id, message: latest.message, stale: latest.stale }) : null;
    const notify = () => { const x = info(); listeners.forEach((f) => { try { f(x); } catch (e) { /* A subscriber cannot stop capture. */ } }); };
    const bounded = (value, truncated, field) => {
      let chars = 0;
      let lines = 0;
      const copy = (x) => {
        if (typeof x === 'string') {
          const result = x.slice(0, Math.max(0, maxChars - chars));
          chars += result.length;
          if (result.length !== x.length) truncated.add(field);
          return result;
        }
        if (Array.isArray(x)) {
          const a = [];
          for (const item of x) {
            if (lines >= maxLines || chars >= maxChars) { truncated.add(field); break; }
            lines += 1;
            a.push(copy(item));
          }
          return a;
        }
        if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, copy(v)]));
        return x;
      };
      return copy(value);
    };
    const finish = (e) => {
      const bundle = { id: e.id, message: e.message, stale: e.stale, error: e.error, input: e.input, output: e.output, interpreter: e.interpreter, windows: e.windows, stack: e.stack, frameToken: e.frameToken, values: e.values, unavailable: e.unavailable, truncated: [...e.truncated] };
      const compact = JSON.parse(JSON.stringify(bundle));
      while (new TextEncoder().encode(JSON.stringify(compact)).length > 60000) {
        let longest = null;
        const visit = (x) => {
          if (!x || typeof x !== 'object') return;
          Object.keys(x).forEach((k) => {
            if (x === compact && ['id', 'message'].includes(k)) return;
            if (typeof x[k] === 'string' && x[k].length > 100 && (!longest || x[k].length > longest.object[longest.key].length)) longest = { object: x, key: k };
            else visit(x[k]);
          });
        };
        visit(compact);
        if (!longest) {
          const field = ['windows', 'stack', 'values', 'input', 'output', 'interpreter', 'error'].filter((k) => compact[k] !== undefined).sort((a, b) => JSON.stringify(compact[b]).length - JSON.stringify(compact[a]).length)[0];
          if (!field) break;
          delete compact[field];
          compact.truncated.push(field, 'bundle');
          continue;
        }
        longest.object[longest.key] = longest.object[longest.key].slice(0, Math.floor(longest.object[longest.key].length / 2));
        if (!compact.truncated.includes('bundle')) compact.truncated.push('bundle');
      }
      e.frozen = freeze(compact);
    };
    const stale = () => {
      epoch += 1;
      stack = undefined;
      frameToken = undefined;
      if (latest && !latest.stale) {
        latest.stale = true;
        if (latest.pending) {
          latest.pending = false;
          latest.unavailable.push('Source and stack unavailable: session state changed before capture');
          finish(latest);
        }
        notify();
      }
    };
    const clear = (preserveRequests = false) => {
      epoch += 1;
      frameToken = undefined;
      if (!preserveRequests) stackRequests.length = 0;
      input = []; output = []; outputTruncated = false; stack = undefined; latest = null; entries.clear(); notify();
    };
    const recv = (x, y) => {
      if (['Disconnect', 'SysError', 'Identify', 'ReplyIdentify'].includes(x)) { clear(); return; }
      if (x === 'ReplyGetSIStack') {
        const requested = stackRequests.shift();
        if (enabled && requested === epoch) stack = { epoch, value: y.stack };
        return;
      }
      if (!enabled) return;
      if (x === 'SetHighlightLine') frameToken = y.win;
      if (x === 'OpenWindow' && y.debugger) frameToken = y.token;
      if (x === 'SetPromptType' && latest && latest.pending && y.type !== 0) latest.ready = true;
      if (x === 'EchoInput' || (x === 'AppendSessionOutput' && y.type === 14)) {
        input.push({ text: (y.input || y.result || '').slice(0, maxChars) });
        input = input.slice(-8);
      } else if (x === 'AppendSessionOutput') {
        if ((y.result || '').length > maxChars || output.length >= maxLines) outputTruncated = true;
        output.push({ type: y.type || 0, text: (y.result || '').slice(0, maxChars) });
        output = output.slice(-maxLines);
        if (latest && latest.pending && !latest.stale) {
          latest.output = bounded([...latest.output, output[output.length - 1]], latest.truncated, 'output');
          latest.message = (errorLine(latest.output) || latest.message).slice(0, 500);
        }
      } else if (x === 'HadError') {
        const code = typeof y.error === 'number' ? y.error : y.dmx;
        if (code === 1001) { output = []; return; }
        if (latest) { const currentFrame = frameToken; stale(); frameToken = currentFrame; }
        const truncated = new Set(outputTruncated ? ['output'] : []);
        outputTruncated = false;
        const capturedOutput = bounded(output, truncated, 'output');
        const message = (errorLine(capturedOutput) || `Interpreter error ${code || ''}`).slice(0, 500);
        const e = { id: `error-${++serial}`, message, stale: false, epoch, pending: true, error: bounded(y, truncated, 'error'), input: bounded(input, truncated, 'input'), output: capturedOutput, windows: [], values: [], unavailable: [], truncated };
        latest = e; entries.set(e.id, e);
        while (entries.size > maxErrors) entries.delete(entries.keys().next().value);
        output = [];
        if (io.onError) io.onError(e.id, capturedOutput);
      }
    };
    const settle = async () => {
      const e = latest;
      if (!e || !e.pending || !e.ready) return;
      if (e.capturing) return;
      e.capturing = true;
      if (e.stale || e.epoch !== epoch) e.unavailable.push('Source and stack unavailable: session state changed before capture');
      else {
        const snapshot = io.snapshot(frameToken) || {};
        if (io.requestStack && !(stack && stack.epoch === epoch) && !stackRequests.includes(epoch)) io.requestStack();
        const stackDeadline = Date.now() + (io.stackTimeout === undefined ? 150 : io.stackTimeout);
        const stackReady = new Promise((resolve) => {
          const poll = () => {
            if (e.epoch !== epoch || !enabled || (stack && stack.epoch === epoch) || Date.now() >= stackDeadline) { resolve(); return; }
            setTimeout(poll, 10);
          };
          poll();
        });
        e.interpreter = bounded(snapshot.interpreter || {}, e.truncated, 'interpreter');
        const orderedWindows = (snapshot.windows || []).slice().sort((a, b) => Number(b.token === frameToken) - Number(a.token === frameToken)).slice(0, 4).map((w) => {
          const lines = w.executableText || w.text || [];
          const line = Math.max(0, w.currentLine || 0);
          const start = Math.max(0, line - 2);
          const sourceSnippet = w.sourceSnippet || { origin: w.executableText ? 'executable' : 'buffer', startLine: start, lines: lines.slice(start, line + 3) };
          return { sourceSnippet, ...w };
        });
        e.windows = bounded(orderedWindows, e.truncated, 'windows');
        const tracers = e.windows.filter((w) => w.kind === 'tracer');
        const tracer = tracers.find((w) => w.token === frameToken) || (tracers.length === 1 ? tracers[0] : null);
        e.frameToken = tracer && tracer.token;
        const header = tracer && ((tracer.executableText || tracer.text || [])[0]);
        let names = [];
        if (header) {
          const valid = (n) => /^[\p{L}_∆⍙][\p{L}\p{N}_∆⍙¯]*$/u.test(n);
          const parts = header.split(';');
          const formal = parts[0].split('←').pop().trim().split(/\s+/);
          const functionName = tracer.name && tracer.name.split('.').pop();
          const functionIndex = functionName ? formal.indexOf(functionName) : formal.length === 3 ? 1 : 0;
          names = [...new Set([...formal.filter((n, i) => i !== functionIndex), ...parts.slice(1).map((n) => n.trim())].filter(valid))].slice(0, io.maxNames || 6);
        }
        if (io.preview && names.length) {
          let timer;
          const result = await Promise.race([
            Promise.resolve().then(() => e.epoch === epoch && !e.stale && enabled ? io.preview(names, tracer.token) : null).catch(() => null),
            new Promise((r) => { timer = setTimeout(() => r(null), io.previewTimeout || 200); }),
          ]);
          clearTimeout(timer);
          if (result && e.epoch === epoch && !e.stale && enabled) e.values = bounded(result, e.truncated, 'values');
          else e.unavailable.push('Value previews unavailable: deadline or session state changed');
        } else e.unavailable.push('Value previews unavailable');
        await stackReady;
        if (stack && stack.epoch === e.epoch && e.epoch === epoch && !e.stale) e.stack = bounded(stack.value, e.truncated, 'stack');
        else e.unavailable.push('Stack unavailable: no current execution stack reply before deadline');
      }
      e.pending = false;
      if (entries.has(e.id)) { finish(e); if (latest === e) notify(); }
    };
    return {
      recv,
      sent(x) {
        if (x === 'GetSIStack') { stackRequests.push(epoch); if (stackRequests.length > 32) stackRequests.shift(); }
        if (!enabled) return;
        if (!resume.has(x)) return;
        stale(); output = []; outputTruncated = false;
      },
      setEnabled(x) { if (enabled === !!x) return; enabled = !!x; if (!enabled) clear(true); },
      clear,
      settle,
      info: () => latest && !latest.pending ? info() : null,
      async context(id) {
        const e = id ? entries.get(id) : latest;
        if (!e || !e.frozen) return null;
        return e.stale === e.frozen.stale ? e.frozen : freeze({ ...e.frozen, stale: e.stale });
      },
      onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    };
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.errorContext = { create };
}(typeof window === 'undefined' ? globalThis : window));
