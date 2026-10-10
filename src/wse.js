// workspace explorer
{
  class WSE {
    constructor() {
      const wse = this;
      const pending = {};
      this.pending = pending;
      const pendingValueTip = {};
      let valueTipToken = 0;
      this.pendingValueTip = pendingValueTip;
      this.dom = I.wse;
      this.dom.hidden = 0;
      this.VT_MAX_HEIGHT = 30;
      this.VT_MAX_WIDTH = 100;
      this.bt = new D.Bonsai(this.dom, {
        children(id, callback) {
          // TreeList replies identify only the node, so keep one request per node in flight.
          const requests = pending[id] || (pending[id] = []);
          requests.push(callback.bind(this));
          requests.length === 1 && D.send('TreeList', { nodeId: id });
        },
        click(path) {
          D.send('Edit', { win: 0, pos: 0, text: path });
        },
        valueTip(node, callback) {
          const token = valueTipToken;
          valueTipToken += 1;
          const valueTipRequest = {
            handler: callback.bind(this),
            timeoutId: setTimeout(() => {
              wse.valueTip(token, { tip: [''] });
            }, 1000),
          };
          pendingValueTip[token] = valueTipRequest;
          D.ide.getValueTip('wse', token, { // ask interpreter
            win: 0,
            line: node.path,
            pos: 0,
            maxWidth: wse.VT_MAX_WIDTH,
            maxHeight: wse.VT_MAX_HEIGHT,
          });
        },
      });
    }

    focus() {
      this.bt.focus();
    }

    replyTreeList(x) { // handle response from interpreter
      const requests = this.pending[x.nodeId];
      if (!requests) return;
      const f = requests.shift();
      if (requests.length) D.send('TreeList', { nodeId: x.nodeId });
      else delete this.pending[x.nodeId];
      f((x.nodeIds || []).map((c, i) => ({
        // x.classes uses constants from http://help.dyalog.com/17.0/Content/Language/System%20Functions/nc.htm
        id: c || `leaf_${x.nodeId}_${i}`,
        text: x.names[i],
        expandable: !!c,
        icon: `${x.classes[i] < 0 ? 9.1 : Math.abs(x.classes[i])}`.replace('.', '_'),
      })));
    }

    refresh() {
      this.bt.refresh();
    }

    valueTip(token, x) { // handle response from interpreter
      const valueTipRequest = this.pendingValueTip[token];
      if (!valueTipRequest) return;
      delete this.pendingValueTip[token];
      if (valueTipRequest.timeoutId) {
        clearTimeout(valueTipRequest.timeoutId);
      }
      if (x.tip.length === this.VT_MAX_HEIGHT) {
        x.tip[this.VT_MAX_HEIGHT - 1] = '...';
      }
      x.tip = x.tip.map((line) => D.util.esc(line.length < this.VT_MAX_WIDTH ? line : `${line.substring(0, this.VT_MAX_WIDTH - 3)}...`));
      valueTipRequest.handler(x);
    }

    autoRefresh(ms) {
      if (ms && !this.refreshTimer) {
        this.refreshTimer = setInterval(this.bt.refresh, ms);
      } else if (!ms && this.refreshTimer) {
        clearInterval(this.refreshTimer); delete this.refreshTimer;
      }
    }
  }
  D.WSE = WSE;
}
