// Window management: create, find and drive Ride's windows.
// Electron's BrowserWindow under Electron; Tauri's window API under Tauri,
// where windows are addressed by label and queries are asynchronous.
// D.wm.create takes Electron's BrowserWindow options and a URL, or a function
// from the new window's id to its URL; a window handle has
// show, hide, focus, close, setTitle, setContentBounds, setContentSize,
// setMinSize, navigate, print, toggleDevTools, onClosed(f), and the promises
// contentBounds(), isFocused(), exists() and eval(js). handle.native is what
// Electron's dialog calls take as their parent window.
// D.wm.main() is this session's window. D.wm.newSession(env) starts a new
// session: under Electron another RIDE process with that environment, as
// before; under Tauri another window in this process, taking env as its
// environment overrides.
{
  const opt = (o, ks) => {
    const r = {};
    ks.forEach((k) => { if (o[k] != null) r[k] = o[k]; });
    return r;
  };

  if (window.__RIDE__) {
    const T = window.__TAURI__;
    const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
    const report = (what) => (e) => window.__rideLog && window.__rideLog('warn', `window ${what}:`, e);
    const WebviewWindow = () => T.webviewWindow.WebviewWindow;
    const { LogicalSize, LogicalPosition } = T.dpi;
    const labelOf = (id) => (id === 1 ? 'main' : `w${id}`);
    const idOf = (label) => (label === 'main' ? 1 : +label.slice(1));
    const currentLabel = () => window.__TAURI_INTERNALS__.metadata.currentWindow.label;

    // Ride's own pages load from the app; any other file:// URL (3500⌶ writes
    // its HTML to a temp file) goes through the ridefile:// scheme, which
    // WebView2 serves as http://ridefile.localhost.
    const fileScheme = window.__RIDE__.platform === 'windows' ? 'http://ridefile.localhost' : 'ridefile://localhost';
    const appPage = /^\/?(index|dialog|status|about|empty)\.html([?#].*)?$/;
    const appUrl = (u) => {
      const str = String(u);
      if (/^file:\/\//.test(str)) {
        const p = str.replace(/^file:\/\//, '');
        if (!appPage.test(p)) return `${fileScheme}${encodeURI(p.startsWith('/') ? p : `/${p}`)}`;
      }
      // The main window's location is "tauri://localhost" with no path, so
      // the host match stops at ? and # as well as /.
      const s = str.replace(/^file:\/\//, '').replace(/^[a-z]+:\/\/[^/?#]*/i, '').replace(/^\/+/, '');
      return s === '' || s.startsWith('?') ? `index.html${s}` : s;
    };

    // A script meant for a new window waits for its page to load, as
    // Electron's executeJavaScript does.
    const pageLoads = new Map();
    const pageLoad = (label) => {
      if (!pageLoads.has(label)) {
        let resolve;
        const p = new Promise((r) => { resolve = r; });
        pageLoads.set(label, { p, resolve });
      }
      return pageLoads.get(label);
    };
    T.event.listen('ride-page-load', ({ payload: { label } }) => pageLoad(label).resolve());

    // Calls on a window wait until Tauri has created it (D.wm.create
    // returns at once), as Electron's BrowserWindow is usable as soon as it
    // is constructed.
    const creating = new Map();

    // A Wayland compositor sets the size of a window it shows and ignores
    // the window's own resize requests, but keeps a window within its size
    // limits. So a shown window is resized by pinning it (minimum = maximum
    // = the new size) and then freeing it again. This works only while the
    // window is shown, so a size set while it is hidden waits for the next
    // show; hiding frees the window first, so that it is never shown pinned.
    // Per label: { min, pending, queue }; the queue keeps one window's size
    // changes and visibility in order.
    const sizing = new Map();
    const sizingOf = (label) => {
      if (!sizing.has(label)) sizing.set(label, { min: null, pending: null, queue: Promise.resolve() });
      return sizing.get(label);
    };
    const settle = () => new Promise((r) => { setTimeout(r, 300); });

    class Win {
      constructor(id, ww) {
        this.id = id;
        this.label = labelOf(id);
        this.ww = ww || new (WebviewWindow())(this.label, { skip: true });
        this.native = { id, rideWindow: true };
        this.ready = creating.get(this.label) || Promise.resolve();
        this.loaded = ww ? pageLoad(this.label).p : Promise.resolve();
      }

      do(what, f) { return this.ready.then(f).catch(report(what)); }

      queued(what, f) {
        const sz = sizingOf(this.label);
        sz.queue = sz.queue.then(() => this.do(what, () => f(sz)));
      }

      async resizeShown(sz, size) {
        await this.ww.setMinSize(size);
        await this.ww.setMaxSize(size);
        await this.ww.setSize(size);
        await settle();
        await this.ww.setMaxSize(null);
        await this.ww.setMinSize(sz.min);
      }

      // Electron's show() also focuses the window.
      show() {
        this.queued('show', async (sz) => {
          await this.ww.show();
          await this.ww.setFocus();
          if (!sz.pending) return;
          const size = sz.pending;
          sz.pending = null;
          await settle();
          await this.resizeShown(sz, size);
        });
      }

      hide() {
        this.queued('hide', async (sz) => {
          await this.ww.setMaxSize(null);
          await this.ww.setMinSize(sz.min);
          await this.ww.hide();
        });
      }

      focus() { this.do('focus', () => this.ww.setFocus()); }

      // Goes to the page first (src-tauri/src/win.rs), as Electron runs
      // beforeunload.
      close() { this.do('close', () => this.ww.close()); }

      setTitle(t) { this.do('setTitle', () => this.ww.setTitle(t)); }

      setContentBounds({ x, y, width, height }) {
        if (x != null && y != null) this.do('setPosition', () => this.ww.setPosition(new LogicalPosition(x, y)));
        if (width && height) this.setContentSize(width, height);
      }

      setContentSize(w, h) {
        const size = new LogicalSize(w, h);
        this.queued('setSize', async (sz) => {
          if (await this.ww.isVisible()) await this.resizeShown(sz, size);
          else sz.pending = size;
        });
      }

      setMinSize(w, h) {
        this.queued('setMinSize', (sz) => {
          sz.min = new LogicalSize(w, h);
          return this.ww.setMinSize(sz.min);
        });
      }

      contentBounds() {
        return this.ready
          .then(() => Promise.all([this.ww.innerPosition(), this.ww.innerSize(), this.ww.scaleFactor()]))
          .then(([p, s, f]) => {
            const lp = p.toLogical(f);
            const ls = s.toLogical(f);
            return { x: lp.x, y: lp.y, width: ls.width, height: ls.height };
          });
      }

      isFocused() { return this.ready.then(() => this.ww.isFocused()); }

      exists() { return WebviewWindow().getByLabel(this.label).then((w) => !!w); }

      onClosed(f) { this.ww.once('tauri://destroyed', () => f()); }

      eval(js) {
        return this.loaded.then(() => invoke('win_op', { label: this.label, op: 'eval', arg: js }));
      }

      navigate(url) {
        pageLoads.delete(this.label);
        this.loaded = pageLoad(this.label).p;
        this.do('navigate', () => invoke('win_op', { label: this.label, op: 'navigate', arg: appUrl(url) }));
      }

      print() { this.do('print', () => invoke('win_op', { label: this.label, op: 'print' })); }

      toggleDevTools() { this.do('devtools', () => invoke('win_op', { label: this.label, op: 'toggleDevTools' })); }
    }

    // A session's windows have ids in its range (src-tauri/src/win.rs):
    // session k's window is k * 1e6 + 1. Ids follow one another, as
    // Electron's do (floating editor windows are cascaded by id); the start
    // differs per page load so that ids stay unique if a page reloads.
    const SESSION_SPAN = 1e6;
    const sessionBase = Math.floor(idOf(currentLabel()) / SESSION_SPAN) * SESSION_SPAN;
    let nextId = sessionBase + 2 + (Date.now() % 9000) * 100;
    let main;
    D.wm = {
      main: () => { main = main || new Win(sessionBase + 1); return main; },
      newSession: (env) => invoke('session_new', { env: env || {} }).catch(report('new session')),
      current: () => new Win(idOf(currentLabel())),
      get: (id) => new Win(id),
      create(o, url) {
        const id = nextId;
        nextId += 1;
        const label = labelOf(id);
        const show = o.show !== false;
        sizingOf(label).min = o.minWidth && o.minHeight ? new LogicalSize(o.minWidth, o.minHeight) : null;
        pageLoad(label);
        const ww = new (WebviewWindow())(label, {
          url: appUrl(typeof url === 'function' ? url(id) : url),
          title: o.title || 'Tauride',
          visible: show,
          focus: show,
          // Every window is resizable, so that it can be resized at all (see
          // sizing above); Ride's one fixed-size window, the dialog, pins
          // its own size.
          resizable: true,
          parent: o.parent ? o.parent.label : undefined,
          ...opt(o, ['width', 'height', 'x', 'y', 'minWidth', 'minHeight']),
        });
        creating.set(label, new Promise((resolve) => {
          ww.once('tauri://created', () => { creating.delete(label); resolve(); });
          ww.once('tauri://error', ({ payload }) => { report(`${label} create`)(payload); creating.delete(label); resolve(); });
        }));
        // macOS orders a child window in front when it is attached to its
        // parent, even if it was created invisible.
        if (!show && D.mac) ww.once('tauri://created', () => ww.hide().catch(report('hide')));
        return new Win(id, ww);
      },
      // The bounds (logical pixels) of the display that holds most of r.
      displayBounds(r) {
        const W = T.window;
        return W.monitorFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          .then((m) => m || W.currentMonitor())
          .then((m) => {
            if (!m) return { x: 0, y: 0, width: window.screen.availWidth, height: window.screen.availHeight };
            const f = m.scaleFactor;
            return {
              x: m.position.x / f, y: m.position.y / f, width: m.size.width / f, height: m.size.height / f,
            };
          });
      },
    };
  } else if (D.el) {
    class Win {
      constructor(bw) { this.bw = bw; this.id = bw.id; this.native = bw; }

      show() { this.bw.show(); }

      hide() { this.bw.hide(); }

      focus() { this.bw.focus(); }

      close() { this.bw.close(); }

      setTitle(t) { this.bw.setTitle(t); }

      setContentBounds(b) { this.bw.setContentBounds(b); }

      setContentSize(w, h) { this.bw.setContentSize(w, h); }

      setMinSize(w, h) { this.bw.setMinimumSize(w, h); }

      contentBounds() { return Promise.resolve(this.bw.getContentBounds()); }

      isFocused() { return Promise.resolve(this.bw.isFocused()); }

      exists() { return Promise.resolve(!this.bw.isDestroyed()); }

      onClosed(f) { this.bw.on('closed', f); }

      eval(js) { return this.bw.webContents.executeJavaScript(js); }

      navigate(url) { this.bw.loadURL(url); }

      print() { this.bw.webContents.print({ printBackground: true }); }

      toggleDevTools() { this.bw.webContents.toggleDevTools(); }
    }
    let main;
    D.wm = {
      main: () => { main = main || new Win(D.el.getGlobal('elw')); return main; },
      current: () => new Win(D.el.getCurrentWindow()),
      get: (id) => new Win(D.el.BrowserWindow.fromId(id)),
      create(o, url) {
        const bw = new D.el.BrowserWindow({ ...o, parent: o.parent && o.parent.native });
        D.elm.enable(bw.webContents);
        if (o.title) bw.setTitle(o.title);
        bw.loadURL(typeof url === 'function' ? url(bw.id) : url);
        return new Win(bw);
      },
      displayBounds: (r) => Promise.resolve(D.el.screen.getDisplayMatching(r).bounds),
      newSession(env) {
        const p = D.el.process.argv;
        nodeRequire('child_process').spawn(p[0], p.slice(1), {
          detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ...env },
        });
      },
    };
  }
}
