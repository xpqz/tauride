const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { validateProviders } = require('../src/prf_code');
const providers = [{ id: 'codex', name: 'Codex', supports_model: true }, { id: 'other', name: 'Other', supports_model: false }];
test('whole settings map rejects unknown providers, keys, malformed values and unsupported models', () => {
  assert.equal(validateProviders(providers, 'codex', { codex: { executable: '', model: '' }, other: { model: '' } }), null);
  for (const map of [null, [], { unknown: {} }, { other: { command: '' } }, { other: { executable: 3 } }, { other: { model: 'unsupported' } }]) {
    assert.ok(validateProviders(providers, 'codex', map));
  }
  assert.ok(validateProviders(providers, 'unknown', {}));
});
test('preferences discover providers, retain separate drafts, and save the whole map', async () => {
  const values = { agentProvider: 'codex', agentProviderSettings: { codex: { executable: '/codex', model: 'first' }, other: { executable: '/other', model: '' } } };
  const nodes = {};
  const q = new Proxy(nodes, { get(target, key) { if (!target[key]) target[key] = { value: '', checked: false, children: [], appendChild(n) { this.children.push(n); }, select() {} }; return target[key]; } });
  const prf = new Proxy({}, { get(_, key) { return (...args) => { if (args.length) values[key] = args[0]; return values[key] === undefined ? '' : values[key]; }; } });
  const D = { prf_tabs: {}, prf };
  const window = { __RIDE__: true, __TAURI_INTERNALS__: { invoke: async cmd => { assert.equal(cmd, 'companion_providers'); return providers; } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/prf_code'), 'utf8'), { D, J: { code: q }, window, document: { createElement: () => ({}) } });
  D.prf_tabs.code.init(); D.prf_tabs.code.load(); await new Promise(r => setImmediate(r));
  assert.deepEqual(nodes.provider.children.map(n => n.value), ['codex', 'other']);
  assert.equal(nodes.provider_executable.value, '/codex'); nodes.provider_model.value = 'second';
  nodes.provider.value = 'other'; nodes.provider.onchange();
  assert.equal(nodes.provider_executable.value, '/other'); assert.equal(nodes.provider_modelrow.hidden, true);
  nodes.provider_executable.value = '/changed'; nodes.provider.value = 'codex'; nodes.provider.onchange();
  assert.equal(nodes.provider_model.value, 'second'); assert.equal(nodes.provider_modelrow.hidden, false);
  nodes.ac.value = 'off'; nodes.ph.checked = false;
  assert.equal(D.prf_tabs.code.validate(), null); D.prf_tabs.code.save();
  assert.equal(values.agentProvider, 'codex');
  assert.equal(values.agentProviderSettings.codex.model, 'second');
  assert.equal(values.agentProviderSettings.other.executable, '/changed');
});
test('loading preferences preserves invalid stored types for validation', async () => {
  for (const config of [null, false, 0, 'invalid', [], { executable: 42 }, { model: false }, { executable: 'x\0y' }, { model: 'x'.repeat(257) }, { executable: 'x'.repeat(4097) }, { model: '⍴'.repeat(86) }]) {
    const values = { agentProvider: 'codex', agentProviderSettings: { codex: config } };
    const nodes = {};
    const q = new Proxy(nodes, { get(target, key) { if (!target[key]) target[key] = { value: '', children: [], appendChild(n) { this.children.push(n); }, select() {} }; return target[key]; } });
    const prf = new Proxy({}, { get(_, key) { return (...args) => { if (args.length) values[key] = args[0]; return values[key] === undefined ? '' : values[key]; }; } });
    const D = { prf_tabs: {}, prf };
    const window = { __RIDE__: true, __TAURI_INTERNALS__: { invoke: async () => providers } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/prf_code'), 'utf8'), { D, J: { code: q }, window, document: { createElement: () => ({}) } });
    D.prf_tabs.code.init(); D.prf_tabs.code.load(); await new Promise(r => setImmediate(r));
    // Native input elements coerce assigned values to strings. Validation must retain the raw map.
    nodes.provider_executable.value = String(nodes.provider_executable.value);
    nodes.provider_model.value = String(nodes.provider_model.value);
    assert.match(D.prf_tabs.code.validate().msg, /Invalid settings/);
    assert.deepEqual(values.agentProviderSettings.codex, config);
  }
});
