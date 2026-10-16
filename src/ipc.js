{
  const pm = ('clearAllStops die execCommand focus insert open processAutocompleteReply prompt saved setTC stateChanged' +
    ' update zoom ReplyFormatCode SetHighlightLine ValueTip').split(' ');
  D.IPC_Client = function IPCClient(winId) {
    // start IPC client
    D.ipc.config.id = `editor${winId}`;
    D.ipc.config.retry = 1500;
    D.ipc.config.silent = true;
    D.send = (type, payload) => D.ipc.of.ride_master.emit('RIDE', [type, payload]);
    D.ipc.connectTo('ride_master', () => {
      const rm = D.ipc.of.ride_master;
      const ide = new D.IDE({ floating: 1, ipc: rm });
      let errorHelpSequence = 0;
      const errorHelpQueries = new Map();
      D.errorHelpTarget = (token, line) => new Promise((resolve) => {
        const request = ++errorHelpSequence;
        const timer = setTimeout(() => { errorHelpQueries.delete(request); resolve(null); }, 1500);
        errorHelpQueries.set(request, (id) => { clearTimeout(timer); resolve(id); });
        rm.emit('errorHelpTarget', { request, token, line });
      });
      rm.on('errorHelpTargetReply', ({ request, id }) => {
        const resolve = errorHelpQueries.get(request);
        errorHelpQueries.delete(request);
        if (resolve) resolve(id);
      });
      rm.on('connect', () => {
        D.ipc.log('## connected to ride_master ##'.rainbow, D.ipc.config.delay);
        rm.emit('browserCreated', winId);
        window.onbeforeunload = (e) => { ide.onbeforeunload(e); };
      });
      rm.on('disconnect', () => {
        D.ipc.log('disconnected from ride_master'.notice);
        D.ide.connected = 0;
        window.close();
      });
      // An editor may have closed by the time a message for it arrives.
      pm.forEach(k => rm.on(k, ([id, ...x]) => { const w = D.ide.wins[id]; w && w[k](...x); }));
      rm.on('countUnsavedStops', ([id, request]) => {
        const w = D.ide.wins[id];
        rm.emit('clearAllStopsReply', [id, request, w ? w.countUnsavedStops() : 0]);
      });
      rm.on('caption', (c) => {
        const ide = D.ide;
        ide.caption = c;
        const focused = ide.focusedWin;
        const w = focused && ide.wins[focused.id] === focused && focused.container
          ? focused : ide.getMRUWin();
        w && w.container && w.updateTitle();
      });
      rm.on('close', ([id]) => {
        D.ide.wins[id].close();
        rm.emit('unblock', 0);
      });
      rm.on('getUnsaved', () => {
        rm.emit('getUnsavedReply', D.ide.getUnsaved());
      });
      rm.on('prf', ([k, x]) => { D.prf[k](x, 1); });
      rm.on('ED', id => D.ide.wins[id].ED(D.ide.wins[id].me));
      rm.on('pendingEditor', (pe) => {
        D.ipc.log('got pendingEditor from ride_master : '.debug);
        const { editorOpts, ee } = pe;
        const ed = new D.Ed(D.ide, editorOpts);
        D.ide.wins[ed.id] = ed;
        ed.me_ready.then(() => {
          ed.open(ee);
          ed.updSize();
          ed.refresh();
          rm.emit('unblock', ed.id);
          ed.meIsReady = true;
        });
        setTimeout(() => {
          const glr = D.ide.gl.root;
          const ci = glr.contentItems;
          if (!ci.length) glr.addChild({ type: 'stack' });
          ci[0].type === 'stack' && ci[0].header.position(ci[0].contentItems.length ? 'top' : false);
          glr.contentItems[0].addChild({
            type: 'component',
            componentName: 'win',
            componentState: { id: ed.id },
            title: ee.name,
          });
        }, 100);
      });
      rm.on('outputCommandState', (available) => {
        ide.outputCommandAvailable = available;
        ide.refreshOutputCommandState();
      });
      rm.on('inlineInspectionState', (available) => {
        ide.inlineInspectionAvailable = available;
        ide.refreshInlineInspectionState();
      });
      rm.on('syntax', (x) => {
        Object.assign(D.syntax, x);
        D.defineSyntaxRegex();
      });
    });
  };

  D.IPC_Prf = function IPCPrf() {
    // start IPC client - preferences
    D.ipc.config.id = 'prf';
    D.ipc.config.retry = 1500;
    D.ipc.config.silent = true;
    D.ipc.connectTo('ride_master', () => {
      const rm = D.ipc.of.ride_master;
      rm.on('connect', () => {
        D.ipc.log('## connected to ride_master ##'.rainbow, D.ipc.config.delay);
        window.onbeforeunload = (e) => {
          e.returnValue = false;
          rm.emit('prfClose');
        };
        rm.emit('prfCreated');
      });
      rm.on('disconnect', () => {
        D.ipc.log('disconnected from ride_master'.notice);
        D.onbeforeunload = null;
        window.close();
      });
      rm.on('caption', (c) => { document.title = `Preferences - ${c}`; });
      rm.on('show', x => D.prf_ui(x));
      rm.on('prf', ([k, x]) => D.prf[k](x, 1));
      rm.on('nudge', () => rm.emit('nudge'));
    });
  };

  function WindowRect(id, prf) {
    let {
      x, y, width, height,
    } = prf;
    x += prf.ox * (id - 1);
    y += prf.oy * (id - 1);
    return D.wm.displayBounds({
      x, y, width, height,
    }).then((b) => {
      const vw = Math.max(0, Math.min(x + width, b.x + b.width) - Math.max(x, b.x));
      const vh = Math.max(0, Math.min(y + height, b.y + b.height) - Math.max(y, b.y));
      if (width * height > 2 * vw * vh) {
        // saved window position is now mostly off screen
        x = null; y = null;
        width = Math.min(width, b.width);
        height = Math.min(height, b.height);
      }
      return {
        x, y, width, height,
      };
    });
  }
  D.IPC_CreateWindow = function IPCCreateWindow(seq) {
    const opts = {
      show: false,
      fullscreen: false,
      fullscreenable: false,
      parent: D.wm.main(),
      alwaysOnTop: false,
      webPreferences: {
        contextIsolation: false,
        enableRemoteModule: true,
        nodeIntegration: true,
        enableDeprecatedPaste: true,
      },
    };
    WindowRect(seq, D.prf.editWins()).then((r) => {
      D.wm.create({ ...opts, ...r }, (id) => `${window.location}?type=editor&winId=${id}&appid=${D.ipc.config.appspace}`);
    });
  };

  D.IPC_Server = function IPCServer(factories) {
    // start IPC server
    const helpers = { prf: 'prf_bw', dialog: 'dlg_bw', status: 'stw_bw' };
    const pending = {};
    D.ensureHelper = (kind) => {
      if (!factories || !factories[kind]) return Promise.reject(new Error(`Unknown helper: ${kind}`));
      if (pending[kind]) return pending[kind].promise;
      const state = {};
      state.promise = new Promise((resolve, reject) => {
        state.resolve = resolve;
        state.reject = reject;
      });
      pending[kind] = state;
      const fail = (error) => {
        if (pending[kind] !== state) return;
        delete pending[kind];
        if (D[helpers[kind]] === state.helper) delete D[helpers[kind]];
        clearTimeout(state.timer);
        state.reject(error instanceof Error ? error : new Error(String(error)));
        state.helper && state.helper.win.destroy();
      };
      try {
        state.helper = factories[kind](fail);
        D[helpers[kind]] = state.helper;
        state.helper.win.ready.catch(fail);
        state.helper.win.onClosed(() => {
          if (pending[kind] === state && !state.connected) fail(new Error(`${kind} helper closed before connecting`));
          else if (pending[kind] === state) {
            delete pending[kind];
            if (D[helpers[kind]] === state.helper) delete D[helpers[kind]];
          }
        });
        state.timer = setTimeout(() => fail(new Error(`${kind} helper did not connect`)), 15000);
      } catch (error) { fail(error); }
      return state.promise;
    };
    const connected = (kind, socket) => {
      const state = pending[kind];
      if (!state || state.connected || !socket || socket.label !== state.helper.win.label) return false;
      state.helper.socket = socket;
      state.connected = true;
      clearTimeout(state.timer);
      state.resolve(state.helper);
      return true;
    };
    const matches = (kind, socket) => {
      const state = pending[kind];
      return !!(state && socket && socket.label === state.helper.win.label);
    };
    D.pwins = [];
    D.pendingEditors = [];
    D.ipc.config.id = 'ride_master';
    D.ipc.config.appspace = `ride_${+new Date()}`;
    D.ipc.config.retry = 1500;
    D.ipc.config.silent = true;
    D.ipc.serve(() => {
      const srv = D.ipc.server;
      srv.on('prfCreated', (data, socket) => {
        if (!matches('prf', socket)) return;
        Object.keys(D.prf).forEach(k => srv.emit(socket, 'prf', [k, D.prf[k]()]));
        connected('prf', socket);
      });
      srv.on('prfShow', x => D.prf_ui(x));
      srv.on('prfClose', (data, socket) => {
        if (!matches('prf', socket)) return;
        D.prf_bw.win.hide();
        D.ide && D.ide.focusMRUWin();
      });
      srv.on('statCreated', (data, socket) => {
        if (!matches('status', socket)) return;
        srv.emit(socket, 'setTheme', D.theme);
        D.ide && srv.emit(socket, 'caption', D.ide.caption);
        connected('status', socket);
      });
      srv.on('statClose', (data, socket) => {
        if (!matches('status', socket)) return;
        D.prf.statusWindow(0);
      });
      srv.on('dialogCreated', (data, socket) => {
        if (!matches('dialog', socket)) return;
        srv.emit(socket, 'setTheme', D.theme);
        connected('dialog', socket);
      });
      srv.on('dialogClose', ([t, r], socket) => {
        if (!matches('dialog', socket) || !D.util.isCurrentDialog(t)) return;
        D.dlg_bw.win.hide();
        D.util.replyDialog(t, r);
        D.ide && D.ide.focusMRUWin();
      });
      srv.on('browserCreated', (bwId, socket) => {
        const wp = new D.IPC_WindowProxy(bwId, socket);
        srv.emit(socket, 'caption', D.ide.caption);
        srv.emit(socket, 'inlineInspectionState', D.ide.canInspectInline());
        srv.emit(socket, 'outputCommandState', D.ide.canRunOutputCommand());
        D.pwins.push(wp);
        D.IPC_LinkEditor();
      });
      srv.on('clearAllStopsReply', ([id, request, count]) => {
        const w = D.ide.wins[id];
        w && w.finishClearStops && w.finishClearStops(request, count);
      });
      srv.on('socket.disconnected', (socket) => {
        Object.keys(helpers).forEach((kind) => {
          if (!matches(kind, socket)) return;
          const state = pending[kind];
          delete pending[kind];
          clearTimeout(state.timer);
          if (D[helpers[kind]] === state.helper) delete D[helpers[kind]];
          state.helper.win.destroy();
          if (!state.connected) state.reject(new Error(`${kind} helper disconnected`));
        });
        [...D.pwins, ...Object.values(D.ide ? D.ide.wins : {})]
          .filter((w) => w.socket === socket).forEach((w) => w.cancelClearStops());
      });
      srv.on('Edit', data => D.ide.Edit(data));
      srv.on('focusedWin', (id) => {
        const w = D.ide.wins[id];
        D.ide.focusedWin = w;
        w && (w.focusTS = +new Date());
      });
      srv.on('runOutputCommand', ([code, id]) => {
        const w = D.ide.wins[id];
        w && D.ide.runOutputCommand(code, w.me);
      });
      srv.on('openInlineInspection', ([aspect, id]) => {
        const w = D.ide.wins[id];
        w && D.ide.openInlineInspection(aspect, w.me);
      });
      srv.on('stepInline', (id) => {
        const w = D.ide.wins[id];
        w && D.ide.stepInline(w.me);
      });
      srv.on('pfKey', x => D.ide.pfKey(x));
      srv.on('getStats', () => D.ide.getStats());
      srv.on('getSyntax', (data, socket) => {
        srv.emit(socket, 'syntax', D.syntax);
      });
      srv.on('getUnsavedReply', (data) => {
        if (!D.pendingEdit) return;
        Object.keys(data).forEach((k) => {
          if (data[k] && D.pendingEdit.unsaved[k] === -1) D.pendingEdit.unsaved[k] = data[k];
          else delete D.pendingEdit.unsaved[k];
        });

        if (!Object.values(D.pendingEdit.unsaved).includes(-1)) {
          D.send('Edit', D.pendingEdit);
          delete D.pendingEdit;
        }
      });
      srv.on('getValueTip', (data) => D.ide.getValueTip(...data));
      srv.on('prf', ([k, x]) => { D.prf[k](x); });
      srv.on('switchWin', data => D.ide.switchWin(data));
      srv.on('updPW', data => D.ide.updPW(data));
      srv.on('unblock', (id) => {
        !!id && D.ide.wins[id].me_resolve(true);
        D.ide.unblock();
      });
      srv.on('mounted', (id) => {
        D.ide.hadErr > 0 && (D.ide.hadErr -= 1);
        D.ide.focusWin(D.ide.wins[id]);
      });
      srv.on('zoom', (z) => D.ide.zoom(z));
      srv.on('errorHelpTarget', ({ request, token, line }, socket) => {
        const id = D.agent && D.agent.errorAt(token, line);
        srv.emit(socket, 'errorHelpTargetReply', { request, id: id == null ? null : id });
      });
      srv.on('explainError', ({ id }) => D.errorHelp && D.errorHelp.explain(id));
      srv.on('ABT', () => D.commands.ABT());
      srv.on('CVH', () => D.ide.CVH());
      srv.on('LOG', () => D.commands.LOG());
      srv.on('NEW', () => D.commands.NEW());
      srv.on('OWS', () => D.commands.OWS());
      srv.on('RIDE', ([type, payload]) => D.send(type, payload));
    });
    return D.ipc.server.start();
  };
  D.IPC_LinkEditor = function IPCLinkEditor(pe) {
    pe && D.pendingEditors.push(pe);
    if (!D.pendingEditors.length) return;
    let wp = D.prf.floatSingle() ? D.pwins[0] : D.pwins.find(w => w.id < 0);
    if (!wp) {
      D.IPC_CreateWindow(pe.editorOpts.id);
      return;
    }
    if (wp.id > 0) wp = Object.assign(new D.IPC_WindowProxy(), wp, { pendingClearStops: null });
    const w = D.wm.get(wp.bwId);
    // Size and place the window before showing it, so the editor is laid out once.
    if (D.prf.editWinsRememberPos()) w.show();
    else {
      WindowRect(1 + (wp.bwId - D.pwins[0].bwId), D.prf.editWins()).then((o) => {
        if (o.x == null) w.setContentSize(o.width, o.height);
        else w.setContentBounds(o);
        w.show();
      });
    }
    const ped = D.pendingEditors.shift();
    wp.id = ped.editorOpts.id;
    wp.tc = ped.editorOpts.tc;
    wp.entityType = ped.editorOpts.entityType;
    wp.specialWindow = ped.editorOpts.specialWindow;
    wp.focusTS =  +new Date();
    D.wins[wp.id] = wp;
    D.ipc.server.emit(wp.socket, 'pendingEditor', ped);
    D.ide.refreshInlineInspectionState();
  };

  D.IPC_WindowProxy = function IPCWindowProxy(bwId, socket) {
    const ed = this;
    ed.bwId = bwId;
    ed.socket = socket;
    ed.id = -1;
    ed.me = { dyalogCmds: ed };
    ed.me_ready = new Promise((r) => { ed.me_resolve = r; });
    ed.tc = 0;
    ed.focusTS = +new Date();
  };
  D.IPC_WindowProxy.prototype = {
    emit(f, ...x) { D.ipc.server.emit(this.socket, f, [this.id, ...x]); },
    countUnsavedStops() {
      D.clearStopsSequence = (D.clearStopsSequence || 0) + 1;
      const request = D.clearStopsSequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingClearStops = null;
          reject(new Error('An editor did not respond to the clear request'));
        }, 5000);
        this.pendingClearStops = { request, resolve, timer };
        this.emit('countUnsavedStops', request);
      });
    },
    finishClearStops(request, count) {
      const pending = this.pendingClearStops;
      if (!pending || pending.request !== request) return;
      clearTimeout(pending.timer);
      this.pendingClearStops = null;
      pending.resolve(count);
    },
    cancelClearStops() {
      const pending = this.pendingClearStops;
      if (pending) this.finishClearStops(pending.request, 0);
    },
    hasFocus() { return this === D.ide.focusedWin; },
    close() {
      this.cancelClearStops();
      if (this === D.pwins[0] && D.prf.editWinsRememberPos()) {
        D.wm.get(this.bwId).contentBounds()
          .then((b) => D.prf.editWins(Object.assign(D.prf.editWins(), b)));
      }
      this.emit('close');
    },
    setTC(x) { this.emit('setTC', x); this.tc = x; },
    ED() { this.emit('ED'); },
    LN() { D.prf.lineNums.toggle(); },
    TVO() { D.prf.fold.toggle(); },
    TVB() { D.prf.breakPts.toggle(); },
  };
  function handlerFor(k) {
    return function handler(...x) { this.emit(k, ...x); };
  }
  pm.forEach((k) => {
    D.IPC_WindowProxy.prototype[k] || (D.IPC_WindowProxy.prototype[k] = handlerFor(k));
  });
}
