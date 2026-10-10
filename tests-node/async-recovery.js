const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = process.env.TAURIDE_TEST_ROOT || path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

function queue() {
  const timers = new Map(); const received = []; const batches = []; const sent = [];
  let nextId = 0; let now = 1000;
  const ide = {
    wins: { 0: { add: x => batches.push(Array.from(x, value => ({ ...value }))) } },
    handlers: { Seen: x => received.push(x) },
  };
  const D = { ide, send: (...x) => sent.push(x), prf: { floating: () => false } };
  class Clock extends Date { constructor() { super(now); } }
  const text = source('src/ide.js');
  const start = text.indexOf('  const mq =');
  const end = text.indexOf('  ide.tracer =', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(text.slice(start, end), {
    ide, D, Date: Clock,
    setTimeout: (callback, delay) => { nextId += 1; timers.set(nextId, { callback, delay }); return nextId; },
    clearTimeout: id => timers.delete(id),
  });
  const run = () => {
    assert.ok(timers.size, 'a queue continuation is scheduled');
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); now += timer.delay; timer.callback();
  };
  return { ide, D, timers, received, batches, sent, run };
}

test('scheduled handler failure exposes the original error and future messages resume', () => {
  const q = queue(); const error = new Error('scheduled failure'); let calls = 0;
  q.ide.handlers.Fail = () => { calls += 1; throw error; };
  q.D.recv('Seen', 'first');
  q.D.recv('Fail', {});
  assert.equal(calls, 0, 'failure must take the timer path');
  assert.equal(q.timers.size, 1);
  assert.throws(q.run, value => value === error);
  q.D.recv('Seen', 'later');
  if (q.timers.size) q.run();
  assert.deepEqual(q.received, ['first', 'later']);
  assert.equal(calls, 1);
  assert.equal(q.timers.size, 0);
});

test('messages already behind a scheduled failure resume without another receive', () => {
  const q = queue(); const error = new Error('queued failure'); let calls = 0;
  q.ide.handlers.Fail = () => { calls += 1; throw error; };
  q.D.recv('Seen', 'first'); q.D.recv('Fail', {});
  q.D.recv('Seen', 'second'); q.D.recv('Seen', 'third');
  assert.throws(q.run, value => value === error);
  assert.equal(q.timers.size, 1);
  q.run();
  assert.deepEqual(q.received, ['first', 'second', 'third']);
  assert.equal(calls, 1);
  assert.equal(q.timers.size, 0);
});

test('a failure while blocked waits for unblock without scheduling retries', () => {
  const q = queue(); const error = new Error('blocked failure');
  q.ide.handlers.Fail = () => { q.ide.block(); throw error; };
  q.D.recv('Seen', 'first'); q.D.recv('Fail', {}); q.D.recv('Seen', 'second');
  assert.throws(q.run, value => value === error);
  assert.equal(q.timers.size, 0);
  assert.deepEqual(q.received, ['first']);
  q.ide.unblock();
  if (q.timers.size) q.run();
  assert.deepEqual(q.received, ['first', 'second']);
  assert.equal(q.timers.size, 0);
});

test('queue recovery preserves adjacent output batches and command order', () => {
  const q = queue(); const error = new Error('output failure');
  q.ide.handlers.Fail = () => { throw error; };
  q.ide.handlers.Seen = x => q.received.push([x, q.batches.length]);
  q.D.recv('Seen', 'first'); q.D.recv('Fail', {});
  q.D.recv('AppendSessionOutput', { result: 'one', group: 3, type: 4 });
  q.D.recv('AppendSessionOutput', { result: 'two' });
  q.D.recv('Seen', 'middle');
  q.D.recv('AppendSessionOutput', { result: 'three' });
  q.D.recv('Unrecognised', {});
  assert.throws(q.run, value => value === error);
  q.run();
  assert.deepEqual(q.batches, [
    [{ text: 'one', group: 3, type: 4 }, { text: 'two', group: 0, type: 0 }],
    [{ text: 'three', group: 0, type: 0 }],
  ]);
  assert.deepEqual(q.received, [['first', 0], ['middle', 1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(q.sent)), [['UnknownCommand', { name: 'Unrecognised' }]]);
  assert.equal(q.timers.size, 0);
});

function tree() {
  const children = []; const tips = []; const D = {};
  const dom = {
    innerHTML: '', getElementsByClassName: () => [], getElementsByTagName: () => [],
    getBoundingClientRect: () => ({ bottom: 100 }),
  };
  const $ = () => ({ find: () => ({ length: 0 }) });
  $.debounce = (delay, callback) => callback;
  vm.runInNewContext(source('src/bonsai.js'), { D, $, setTimeout, clearTimeout });
  const bt = new D.Bonsai(dom, {
    children: (id, callback) => children.push({ id, callback }),
    valueTip: (node, callback) => tips.push({ node, callback }),
  });
  const finish = nodes => children.shift().callback(nodes);
  const expand = id => {
    const button = {
      matches: selector => selector === '.bt_node_expand',
      parentNode: { parentNode: { dataset: { id } } },
      nextSibling: { classList: { contains: () => false } },
    };
    dom.ondblclick({ target: { previousSibling: button, matches: () => false } });
  };
  return { bt, dom, children, tips, finish, expand };
}
const node = (id, text, expandable = false) => ({ id, text, expandable, icon: '2_1' });

test('old value tip cannot complete a new refresh and current values still display', () => {
  const t = tree(); t.finish([node(2, 'old')]);
  const oldNodes = t.bt.nodes; const oldNode = oldNodes[2];
  t.bt.requestValueTip(oldNode);
  t.bt.refresh();
  assert.doesNotThrow(() => t.tips.shift().callback({ tip: ['stale'] }));
  assert.equal(t.bt.nodes, oldNodes);
  assert.equal(oldNode.value, undefined);
  assert.equal(t.bt.pendingCalls, 1);
  assert.ok(t.bt.newNodes);
  t.finish([node(2, 'current')]);
  assert.ok(t.dom.innerHTML.includes('current'));
  assert.equal(t.bt.pendingCalls, 0);
  t.bt.requestValueTip(t.bt.nodes[2]);
  t.tips.shift().callback({ tip: ['fresh'] });
  assert.ok(t.dom.innerHTML.includes('fresh'));
  assert.equal(t.bt.pendingCalls, 0);
});

test('scrolling during refresh cannot start value tips on the outgoing tree', () => {
  const t = tree(); t.finish([node(2, 'old')]);
  t.bt.refresh(); t.bt.requestValueTip(t.bt.nodes[2]);
  assert.equal(t.tips.length, 0);
  assert.equal(t.bt.pendingCalls, 1);
  t.finish([node(3, 'current')]);
  assert.equal(t.bt.pendingCalls, 0);
  t.bt.requestValueTip(t.bt.nodes[3]);
  t.tips.shift().callback({ tip: ['fresh'] });
  assert.ok(t.dom.innerHTML.includes('fresh'));
});

test('an old expansion reply cannot replace an incomplete refresh', () => {
  const t = tree(); t.finish([node(2, 'namespace', true)]);
  t.expand(2);
  const oldReply = t.children.shift();
  t.bt.refresh(); t.bt.refresh();
  assert.equal(t.children.length, 1, 'overlapping refresh calls share the current request');
  assert.doesNotThrow(() => oldReply.callback([node(4, 'stale')]));
  assert.equal(t.bt.pendingCalls, 1);
  assert.ok(t.bt.newNodes);
  assert.equal(t.bt.nodes[4], undefined);
  t.finish([node(3, 'replacement')]);
  assert.ok(t.dom.innerHTML.includes('replacement'));
  assert.equal(t.bt.pendingCalls, 0);
});

test('an expansion reply for a removed node cannot add children to the current tree', () => {
  const t = tree(); t.finish([node(2, 'namespace', true)]);
  t.expand(2);
  const oldReply = t.children.shift();
  t.bt.refresh(); t.finish([node(3, 'replacement')]);
  const rendered = t.dom.innerHTML;
  oldReply.callback([node(4, 'stale')]);
  assert.equal(t.bt.nodes[2], undefined);
  assert.equal(t.bt.nodes[4], undefined);
  assert.equal(t.dom.innerHTML, rendered);
  assert.equal(t.bt.pendingCalls, 0);
  t.bt.refresh(); t.finish([node(5, 'next')]);
  assert.ok(t.dom.innerHTML.includes('next'));
});

test('expanded descendants wait for their current children before publishing the refresh', () => {
  const t = tree(); t.finish([node(2, 'namespace', true)]);
  t.expand(2); t.finish([node(4, 'value')]);
  t.bt.requestValueTip(t.bt.nodes[4]);
  const oldTip = t.tips.shift();
  const rendered = t.dom.innerHTML;
  t.bt.refresh(); t.finish([node(2, 'namespace', true)]);
  assert.equal(t.bt.pendingCalls, 1);
  assert.equal(t.children[0].id, 2);
  assert.doesNotThrow(() => oldTip.callback({ tip: ['stale'] }));
  assert.equal(t.bt.pendingCalls, 1);
  assert.equal(t.dom.innerHTML, rendered);
  t.finish([node(5, 'newValue')]);
  assert.equal(t.bt.pendingCalls, 0);
  assert.ok(t.dom.innerHTML.includes('newValue'));
  t.bt.requestValueTip(t.bt.nodes[5]);
  t.tips.shift().callback({ tip: ['current value'] });
  assert.ok(t.dom.innerHTML.includes('current value'));
});

function explorer() {
  const timers = new Map(); const sent = []; let nextId = 0;
  const dom = {
    innerHTML: '', getElementsByClassName: () => [], getElementsByTagName: () => [],
    getBoundingClientRect: () => ({ bottom: 100 }),
  };
  const $ = () => ({ find: () => ({ length: 0 }) });
  $.debounce = (delay, callback) => callback;
  const ide = { valueTipRequests: {}, valueTipToken: 0 };
  const D = { ide, util: { esc: x => x }, send: (name, payload) => sent.push([name, { ...payload }]) };
  const context = vm.createContext({
    D, ide, $, I: { wse: dom }, console,
    setTimeout: (callback, delay, ...args) => { nextId += 1; timers.set(nextId, () => callback(...args)); return nextId; },
    clearTimeout: id => timers.delete(id),
  });
  ['src/bonsai.js', 'src/wse.js'].forEach(file => vm.runInContext(source(file), context));
  const text = source('src/ide.js');
  const method = (start, end) => vm.runInContext(`({${text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)))}})`, context);
  ide.getValueTip = method('  getValueTip(source,', '  setConnInfo(').getValueTip;
  ide.ValueTip = method('    ValueTip(x)', '    SetHighlightLine(').ValueTip;
  const mountWSE = vm.runInContext(`${text.slice(text.indexOf('  function WSE(c)'), text.indexOf('  function DBG(c)'))}; WSE`, context);
  let mounted;
  const mount = () => {
    const container = { on() {}, getElement: () => ({ append() {} }), close: () => { mounted = null; } };
    mounted = { container };
    return mountWSE(container);
  };
  const row = { type: 'row', contentItems: [], addChild: () => mount() };
  context.gl = { root: { contentItems: [row], getComponentsByName: () => (mounted ? [mounted] : []) } };
  context.updMenu = () => {};
  ide.focusMRUWin = () => {};
  const toggle = vm.runInContext(`${text.slice(text.indexOf('  const togglePanel ='), text.indexOf('  const toggleDBG ='))}; toggleWSE`, context);
  mount();
  const reply = (id, nodes) => ide.wse.replyTreeList({
    nodeId: id, nodeIds: nodes.map(x => x.id), names: nodes.map(x => x.text), classes: nodes.map(() => 2),
  });
  const expire = id => { const callback = timers.get(id); timers.delete(id); callback(); };
  return { ide, wse: ide.wse, sent, timers, reply, expire, dom, toggle };
}

test('actual WSE and IDE routing cannot deliver an old value tip to a new same-id request', () => {
  const e = explorer(); e.reply(0, [node(2, 'old')]);
  e.wse.bt.requestValueTip(e.wse.bt.nodes[2]);
  const oldToken = e.sent.at(-1)[1].token;
  e.wse.refresh(); e.reply(0, [node(2, 'current')]);
  const currentNode = e.wse.bt.nodes[2];
  e.wse.bt.requestValueTip(currentNode);
  const currentToken = e.sent.at(-1)[1].token;
  assert.notEqual(oldToken, currentToken);
  e.ide.ValueTip({ token: oldToken, tip: ['stale'] });
  assert.equal(currentNode.value, undefined);
  assert.equal(e.wse.bt.pendingCalls, 1);
  e.ide.ValueTip({ token: currentToken, tip: ['fresh'] });
  assert.ok(e.dom.innerHTML.includes('fresh'));
  assert.equal(e.wse.bt.pendingCalls, 0);
  assert.equal(e.timers.size, 0);
});

test('an old WSE value-tip timeout cannot consume a new same-id request', () => {
  const e = explorer(); e.reply(0, [node(2, 'old')]);
  e.wse.bt.requestValueTip(e.wse.bt.nodes[2]);
  const oldTimeout = e.timers.keys().next().value;
  e.wse.refresh(); e.reply(0, [node(2, 'current')]);
  const currentNode = e.wse.bt.nodes[2];
  e.wse.bt.requestValueTip(currentNode);
  const currentToken = e.sent.at(-1)[1].token;
  e.expire(oldTimeout);
  assert.equal(currentNode.value, undefined);
  assert.equal(e.wse.bt.pendingCalls, 1);
  e.ide.ValueTip({ token: currentToken, tip: ['fresh'] });
  assert.ok(e.dom.innerHTML.includes('fresh'));
  assert.equal(e.wse.bt.pendingCalls, 0);
});

test('same-node TreeList replies retain the callback that owns each request', () => {
  const e = explorer(); e.reply(0, [node(2, 'namespace')]);
  const bt = e.wse.bt;
  bt.nodes[2].expanded = 1;
  bt.childrenCb(2, children => { bt.nodes[2].children = children; });
  const oldNodes = bt.nodes;
  e.wse.refresh(); e.reply(0, [node(2, 'namespace')]);
  assert.equal(bt.pendingCalls, 1);
  assert.equal(e.sent.filter(([name, payload]) => name === 'TreeList' && payload.nodeId === 2).length, 1);
  e.reply(2, [node(4, 'stale')]);
  assert.equal(e.sent.filter(([name, payload]) => name === 'TreeList' && payload.nodeId === 2).length, 2);
  assert.equal(bt.nodes, oldNodes);
  assert.equal(bt.pendingCalls, 1);
  assert.equal(bt.newNodes[4], undefined);
  e.reply(2, [node(5, 'current')]);
  assert.equal(bt.pendingCalls, 0);
  assert.ok(e.dom.innerHTML.includes('current'));
  assert.ok(!e.dom.innerHTML.includes('stale'));
});

test('a TreeList callback can request the same node again without losing its reply', () => {
  const e = explorer(); e.reply(0, []);
  const seen = [];
  e.wse.bt.childrenCb(2, () => {
    seen.push('first');
    e.wse.bt.childrenCb(2, () => seen.push('second'));
  });
  e.reply(2, []); e.reply(2, []);
  assert.deepEqual(seen, ['first', 'second']);
});

test('a failed output batch is consumed and later output and commands resume', () => {
  const q = queue(); const error = new Error('session append failed'); let calls = 0;
  q.ide.wins[0].add = batch => {
    calls += 1;
    if (calls === 1) throw error;
    q.batches.push(Array.from(batch, value => ({ ...value })));
  };
  q.D.recv('Seen', 'first');
  q.D.recv('AppendSessionOutput', { result: 'failed one' });
  q.D.recv('AppendSessionOutput', { result: 'failed two' });
  q.D.recv('Seen', 'middle');
  q.D.recv('AppendSessionOutput', { result: 'later' });
  assert.throws(q.run, value => value === error);
  q.run();
  assert.equal(calls, 2);
  assert.deepEqual(q.received, ['first', 'middle']);
  assert.deepEqual(q.batches, [[{ text: 'later', group: 0, type: 0 }]]);
  assert.equal(q.timers.size, 0);
});

test('a synchronous first-message failure preserves the error and future dispatch', () => {
  const q = queue(); const error = new Error('synchronous failure'); let calls = 0;
  q.ide.handlers.Fail = () => { calls += 1; throw error; };
  assert.throws(() => q.D.recv('Fail', {}), value => value === error);
  q.D.recv('Seen', 'later');
  if (q.timers.size) q.run();
  assert.equal(calls, 1);
  assert.deepEqual(q.received, ['later']);
  assert.equal(q.timers.size, 0);
});


test('panel close and reopen retain reply ownership and ignore the outgoing tip', () => {
  const e = explorer(); e.reply(0, [node(2, 'old')]);
  const original = e.ide.wse; const oldContainer = original.container;
  original.bt.requestValueTip(original.bt.nodes[2]);
  const oldToken = e.sent.at(-1)[1].token;
  e.toggle(false); e.toggle(true);
  assert.equal(e.ide.wse, original);
  assert.notEqual(original.container, oldContainer);
  e.reply(0, [node(2, 'current')]);
  const current = e.ide.wse.bt.nodes[2];
  e.ide.wse.bt.requestValueTip(current);
  const currentToken = e.sent.at(-1)[1].token;
  e.ide.ValueTip({ token: oldToken, tip: ['stale closed panel'] });
  assert.equal(current.value, undefined);
  assert.equal(e.ide.wse.bt.pendingCalls, 1);
  e.ide.ValueTip({ token: currentToken, tip: ['fresh reopened panel'] });
  assert.ok(e.dom.innerHTML.includes('fresh reopened panel'));
  assert.equal(e.timers.size, 0);
});

test('panel reopen keeps old timeouts and TreeList replies with their original requests', () => {
  const e = explorer(); e.reply(0, [node(2, 'namespace')]);
  const original = e.ide.wse;
  original.bt.requestValueTip(original.bt.nodes[2]);
  const oldTimeout = e.timers.keys().next().value;
  const button = {
    matches: selector => selector === '.bt_node_expand',
    parentNode: { parentNode: { dataset: { id: 2 } } },
    nextSibling: { classList: { contains: () => false } },
  };
  e.dom.ondblclick({ target: { previousSibling: button, matches: () => false } });
  e.toggle(false); e.toggle(true);
  e.reply(0, [node(2, 'namespace')]);
  assert.equal(e.ide.wse.bt.pendingCalls, 1);
  e.expire(oldTimeout);
  assert.equal(e.ide.wse.bt.pendingCalls, 1);
  e.reply(2, [node(4, 'stale closed child')]);
  assert.ok(e.ide.wse.bt.newNodes);
  assert.equal(e.ide.wse.bt.pendingCalls, 1);
  e.reply(2, [node(5, 'fresh reopened child')]);
  assert.equal(e.ide.wse.bt.pendingCalls, 0);
  assert.ok(e.dom.innerHTML.includes('fresh reopened child'));
  assert.ok(!e.dom.innerHTML.includes('stale closed child'));
});
