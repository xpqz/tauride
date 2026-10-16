(() => {
  // Only code delimiters are interpreted; every other character stays inert text.
  const renderExplanation = (element, value) => {
    const doc = element.ownerDocument;
    element.textContent = '';
    const append = (parent, tag, text) => {
      const node = tag ? doc.createElement(tag) : doc.createTextNode(text);
      if (tag) node.textContent = text;
      parent.appendChild(node);
      return node;
    };
    const inline = (text) => {
      let start = 0;
      const ticks = /`+/g;
      let opening = null; let match;
      while ((match = ticks.exec(text))) {
        if (match[0].length !== 1) opening = null;
        else if (opening && !/[\r\n]/.test(text.slice(opening.index + 1, match.index))) {
          append(element, null, text.slice(start, opening.index));
          append(element, 'code', text.slice(opening.index + 1, match.index));
          start = ticks.lastIndex; opening = null;
        } else opening = match;
      }
      append(element, null, text.slice(start));
    };
    // Wait for a closing fence while streaming so unfinished delimiters remain visible.
    const fences = /^```[^`\r\n]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm;
    let start = 0; let match;
    while ((match = fences.exec(value))) {
      inline(value.slice(start, match.index));
      const pre = append(element, 'pre', '');
      append(pre, 'code', match[1]);
      start = fences.lastIndex;
    }
    const tail = value.slice(start);
    const unfinished = /^```[^`\r\n]*(?:\r?\n|$)/m.exec(tail);
    if (unfinished) {
      inline(tail.slice(0, unfinished.index));
      append(element, null, tail.slice(unfinished.index));
    } else inline(tail);
  };
  const create = (io) => {
    let sequence = 0; let active = null; let unlisten = null; let selected; let barrier = null;
    let view = {
      open: false, busy: false, status: '', text: '', context: null,
    };
    const render = (change) => { view = { ...view, ...change }; io.render(view); };
    const invokeQuiet = (cmd, args) => Promise.resolve(io.invoke(cmd, args)).catch(() => {});
    const cancel = async () => {
      sequence += 1;
      const id = active; active = null;
      if (unlisten) { unlisten(); unlisten = null; }
      render({ busy: false, status: 'Cancelled' });
      if (id) {
        const stop = () => invokeQuiet('companion_cancel', { requestId: id });
        barrier = barrier ? barrier.then(stop) : stop();
      }
      return barrier;
    };
    const explain = async (id) => {
      if (active || view.busy) cancel();
      selected = id;
      sequence += 1;
      const ticket = sequence;
      render({
        open: true, busy: false, status: '', text: '', context: null,
      });
      if (!io.level()) { render({ status: 'Enable Observe session in Agent or Preferences > Code to explain errors.' }); return; }
      render({ busy: true, status: 'Collecting error context…' });
      try {
        if (barrier) await barrier;
        if (ticket !== sequence) return;
        const context = await io.context(id);
        if (ticket !== sequence) return;
        if (!context) throw new Error('Error context is unavailable or expired.');
        selected = context.id || id;
        render({ context, status: 'Starting Codex…' });
        const requestId = `error-help-${Date.now()}-${ticket}`;
        const stop = await io.listen((p) => {
          if (ticket !== sequence || p.requestId !== active) return;
          if (p.event === 'delta') render({ text: view.text + (p.text || '') });
          else if (p.event === 'status') render({ status: p.text || p.status || 'Working…' });
          else if (p.event === 'done' || p.event === 'error') {
            active = null;
            render({ busy: false, status: p.event === 'done' ? 'Complete — review suggestions before using them.' : p.text || 'Codex could not explain this error.' });
            if (unlisten) { unlisten(); unlisten = null; }
          }
        });
        if (ticket !== sequence) { stop(); return; }
        unlisten = stop; active = requestId;
        await io.invoke('companion_explain', { requestId, context, ...io.settings() });
      } catch (e) {
        if (ticket !== sequence) return;
        active = null;
        if (unlisten) { unlisten(); unlisten = null; }
        render({ busy: false, status: String(e.message || e) });
      }
    };
    const close = async () => {
      const cancellation = cancel();
      const ticket = sequence;
      render({ open: false });
      const closing = cancellation.then(() => {
        if (ticket === sequence) return invokeQuiet('companion_close', {});
        return undefined;
      });
      barrier = closing;
      await closing;
    };
    return {
      explain, cancel, close, retry: () => explain(selected), state: () => view,
    };
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create, renderExplanation };
  if (typeof window === 'undefined' || !window.__RIDE__) return;
  let controller; let panel; let previousFocus;
  const install = () => {
    if (controller) return controller;
    panel = document.createElement('section');
    panel.id = 'error-help'; panel.hidden = true; panel.tabIndex = -1;
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-labelledby', 'error-help-title');
    const title = document.createElement('h2'); title.id = 'error-help-title'; title.textContent = 'Explain this error'; panel.appendChild(title);
    const error = document.createElement('pre'); error.className = 'error-help-context'; panel.appendChild(error);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); panel.appendChild(status);
    const text = document.createElement('div'); text.className = 'error-help-text'; text.setAttribute('aria-label', 'Explanation and suggested correction'); panel.appendChild(text);
    const buttons = {};
    const action = (name, label, fn) => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.action = name; b.textContent = label;
      b.onclick = fn; buttons[name] = b; panel.appendChild(b);
    };
    const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
    controller = create({
      level: () => D.agent && D.agent.level(),
      context: (id) => D.agent.errorContext(id),
      settings: () => ({ executable: D.prf.agentExecutable(), model: D.prf.agentModel() }),
      listen: (f) => window.__TAURI__.event.listen(
        'ride-companion',
        ({ payload }) => f(payload),
        { target: { kind: 'WebviewWindow', label: window.__TAURI_INTERNALS__.metadata.currentWindow.label } },
      ),
      invoke,
      render(v) {
        const opening = panel.hidden && v.open;
        panel.hidden = !v.open; status.textContent = v.status;
        renderExplanation(text, v.text);
        const message = v.context && (v.context.message || (v.context.error && v.context.error.message));
        error.textContent = v.context ? `${message || 'Selected error'}${v.context.stale ? '\nEarlier error — session state has changed.' : ''}` : '';
        panel.setAttribute('aria-busy', String(v.busy));
        if (buttons.cancel) buttons.cancel.disabled = !v.busy;
        if (buttons.retry) buttons.retry.disabled = v.busy;
        if (buttons.copy) buttons.copy.disabled = !v.context;
        if (opening) { previousFocus = document.activeElement; panel.focus(); }
        if (!v.open && previousFocus) { previousFocus.focus(); previousFocus = null; }
      },
    });
    action('cancel', 'Cancel', () => controller.cancel());
    action('retry', 'Retry', () => controller.retry());
    action('copy', 'Copy error context', () => navigator.clipboard.writeText(JSON.stringify(controller.state().context, null, 2)).catch((e) => { status.textContent = `Could not copy: ${e}`; }));
    action('close', 'Close', () => controller.close());
    panel.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); controller.close(); } });
    document.body.appendChild(panel);
    if (D.agent && D.agent.onErrorChange) D.agent.onErrorChange((info) => { if (!info) controller.close(); });
    window.addEventListener('pagehide', () => controller.close());
    return controller;
  };
  D.errorHelp = {
    explain(id) {
      D.wm.main().focus();
      const request = install().explain(id);
      panel.focus();
      return request;
    },
    close() { return controller ? controller.close() : Promise.resolve(); },
    at(win, line) {
      const id = D.agent && D.agent.errorAt(win, line);
      if (id != null) return D.errorHelp.explain(id);
      return undefined;
    },
  };
})();
