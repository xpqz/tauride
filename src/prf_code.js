(() => {
  const byteLength = value => Array.from(value).reduce((size, c) => {
    const point = c.codePointAt(0);
    return size + (point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4);
  }, 0);
  const validateProviders = (providers, selected, settings) => {
    if (!providers.some(p => p.id === selected)) return 'Choose a known error explanation provider.';
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'Provider settings must be a map.';
    for (const id of Object.keys(settings)) {
      const provider = providers.find(p => p.id === id);
      if (!provider) return `Unknown provider: ${id}`;
      const config = settings[id];
      if (!config || typeof config !== 'object' || Array.isArray(config)
        || Object.keys(config).some(k => !['executable', 'model', 'args'].includes(k) || typeof config[k] !== 'string')) return `Invalid settings for ${provider.name}.`;
      if (Object.entries(config).some(([k, value]) => value.includes('\0') || byteLength(value) > (k === 'model' ? 256 : 4096))) return `Invalid settings for ${provider.name}.`;
      if (!provider.supports_model && config.model) return `${provider.name} does not support a model setting.`;
      if (!provider.supports_args && 'args' in config) return `${provider.name} does not take arguments.`;
    }
    return null;
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = { validateProviders };
  if (typeof D === 'undefined') return;
  // Preferences > Code
  // Is this now Preferences > General?

  let providers = null; let providerError = ''; let drafts = {}; let selected; let loading = 0;
  const capture = () => {
    if (selected && drafts && typeof drafts === 'object' && !Array.isArray(drafts)) {
      const previous = drafts[selected];
      if (previous === undefined || (previous && typeof previous === 'object' && !Array.isArray(previous)
        && Object.keys(previous).every(k => typeof previous[k] === 'string'))) {
        const provider = providers && providers.find(p => p.id === selected);
        drafts[selected] = { ...previous, executable: q.provider_executable.value.trim(), model: q.provider_model.value.trim() };
        if (provider && provider.supports_args) drafts[selected].args = q.provider_args.value;
      }
    }
  };
  const display = () => {
    const provider = providers && providers.find(p => p.id === selected);
    const config = drafts && drafts[selected] || {};
    q.provider_executable.value = config.executable || ''; q.provider_model.value = config.model || '';
    q.provider_args.value = config.args || '';
    q.provider_modelrow.hidden = !!provider && !provider.supports_model;
    q.provider_argsrow.hidden = !provider || !provider.supports_args;
  };
  let q; // DOM elements whose ids start with "code_", keyed by the rest of the id
  D.prf_tabs.code = {
    name: 'Code',
    init() {
      q = J.code;
      q.ac.onchange = () => {
        q.acd.disabled = q.ac.value !== 'classic';
        q.acl.disabled = q.ac.value !== 'classic';
        q.ac.value === 'classic' && q.acd.select();
      };
      q.mme.onchange = () => {
        q.mmrc.disabled = !q.mme.checked;
        q.mmss.disabled = !q.mme.checked;
      };
      q.ph.onchange = () => {
        q.phs.disabled = !q.ph.checked;
        q.ph.checked && q.phs.select();
      };
      // The agent pairing port (tauri/agent-pairing.md) exists in Tauride only.
      q.agent.hidden = !window.__RIDE__;
      q.provider.onchange = () => { capture(); selected = q.provider.value; display(); };
    },
    load() {
      const p = D.prf;
      q.ast.checked = !!p.autoStart();
      q.mb.checked = !!p.matchBrackets();
      q.mme.checked = !!p.minimapEnabled();
      q.mmrc.checked = !!p.minimapRenderCharacters();
      q.mmss.value = p.minimapShowSlider();
      q.acbr.checked = !!p.autoCloseBrackets();
      q.ac.value = p.autocompletion();
      q.acd.value = p.autocompletionDelay();
      q.acl.value = p.autoCompleteCharacterLimit();
      q.bc.checked = !!p.blockCursor();
      q.cb.value = p.cursorBlinking();
      q.coq.checked = !!p.connectOnQuit();
      q.rlh.value = p.renderLineHighlight();
      q.apw.checked = !!p.autoPW();
      q.ph.checked = !!p.persistentHistory();
      q.phs.value = p.persistentHistorySize();
      q.vt.checked = !!p.valueTips();
      q.sh.checked = !!p.selectionHighlight();
      q.sqt.checked = !!p.squiggleTips();
      q.sls.value = p.sessionLogSize();
      q.ssm.checked = !!p.showSessionMargin();
      q.sqp.checked = !!p.sqp();
      q.ss.checked = !!p.snippetSuggestions();
      q.ago.checked = !!p.agent();
      q.agc.checked = !!p.agentControl();
      q.agk.checked = !!p.agentConfirm();
      selected = p.agentProvider();
      drafts = JSON.parse(JSON.stringify(p.agentProviderSettings()));
      providers = null; providerError = '';
      display();
      if (window.__RIDE__) {
        const ticket = ++loading;
        q.provider.disabled = true; q.provider_status.textContent = 'Loading providers…';
        window.__TAURI_INTERNALS__.invoke('companion_providers', {}).then((result) => {
          if (ticket !== loading) return;
          providers = result; q.provider.textContent = '';
          providers.forEach((provider) => {
            const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.name;
            q.provider.appendChild(option);
          });
          q.provider.value = selected; q.provider.disabled = false; q.provider_status.textContent = ''; display();
        }).catch((e) => {
          if (ticket !== loading) return;
          providerError = String(e.message || e); q.provider_status.textContent = providerError;
        });
      }
      q.ac.onchange();
      q.mme.onchange();
    },
    activate() { q.mb.focus(); },
    save() {
      const p = D.prf;
      p.autoStart          (q.ast.checked);
      p.blockCursor        (q.bc.checked);
      p.cursorBlinking     (q.cb.value);
      p.matchBrackets      (q.mb.checked);
      p.minimapEnabled     (q.mme.checked);
      p.minimapRenderCharacters(q.mmrc.checked);
      p.minimapShowSlider  (q.mmss.value);
      p.autoCloseBrackets  (q.acbr.checked);
      p.autocompletion     (q.ac.value);
      p.autoPW             (q.apw.checked);
      p.autocompletionDelay(q.acd.value);
      p.autoCompleteCharacterLimit (q.acl.value);
      p.connectOnQuit      (q.coq.checked);
      p.renderLineHighlight(q.rlh.value);
      p.persistentHistory  (q.ph.checked);
      p.persistentHistorySize(q.phs.value);
      p.valueTips          (q.vt.checked);
      p.selectionHighlight (q.sh.checked);
      p.sessionLogSize     (q.sls.value);
      p.showSessionMargin  (q.ssm.checked);
      p.squiggleTips       (q.sqt.checked);
      p.sqp                (q.sqp.checked);
      p.snippetSuggestions (q.ss.checked);
      p.agent              (q.ago.checked);
      p.agentControl       (q.agc.checked);
      p.agentConfirm       (q.agk.checked);
      if (window.__RIDE__) {
        capture(); p.agentProvider(selected); p.agentProviderSettings(drafts);
      }
    },
    validate() {
      if (window.__RIDE__) {
        if (!providers) return { msg: providerError || 'Wait for providers to load.', el: q.provider };
        capture();
        const message = validateProviders(providers, selected, drafts);
        if (message) return { msg: message, el: q.provider };
      }
      const isInt = (x, minX) => +x === (+x | 0) && +x >= minX;
      if (q.ac.value === 'classic' && !isInt(q.acd.value, 0)) return { msg: 'Autocompletion delay must be a non-negative integer.', el: q.acd };
      if (q.ac.value === 'classic' && !isInt(q.acl.value, 0)) return { msg: 'Autocompletion after N characters must be a non-negative integer.', el: q.acl };
      if (q.ph.checked && !isInt(q.phs.value, 1)) return { msg: 'Persistent history size must be a positive integer.', el: q.phs };
      return null;
    },
  };
})();
