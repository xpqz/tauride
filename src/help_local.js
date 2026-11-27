// Maps help URLs onto an installed offline documentation bundle.
//
// A bundle for version X.Y holds <root>/X.Y/index.html and one <path>.html
// per topic. The interpreter builds topic URLs as <prefix>/<path>/ (the
// online site's directory form), so a file: topic URL needs its trailing
// slash turned into .html. With DYALOGHELPDIR unset, online topic URLs are
// redirected to the first installed bundle: per-user root, then machine-wide.
(() => {
  const ONLINE = /^https:\/\/docs\.dyalog\.com\/(\d+\.\d+)(\/[^#]*)?(#.*)?$/;
  const DOCS = ['Dyalog', 'docs'];

  const decode = (url) => { try { return decodeURI(url); } catch (e) { return url; } };
  const encode = (url) => encodeURI(decode(url));
  const getenv = (env, name) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : env[key];
  };

  // Candidate bundle directories for a version, per-user first. On Windows
  // the machine-wide copy sits beside dyalog.chm in the per-version install
  // directory, known only once Ride has spawned that interpreter.
  const candidates = (env, platform, home, installDir, version) => {
    if (platform === 'win32') {
      const local = getenv(env, 'LOCALAPPDATA');
      return [
        local && [local, ...DOCS, version].join('\\'),
        installDir && [installDir, 'help', 'docs'].join('\\'),
      ].filter(Boolean);
    }
    if (platform === 'darwin') {
      return [`${home}/Library/Application Support/Dyalog/docs/${version}`, `/Library/Application Support/Dyalog/docs/${version}`];
    }
    const xdg = getenv(env, 'XDG_DATA_HOME') || `${home}/.local/share`;
    return [`${xdg}/dyalog/docs/${version}`, `/usr/local/share/dyalog/docs/${version}`];
  };

  const fileURL = (dir, platform) => (platform === 'win32' ? `file:///${dir.replace(/\\/g, '/')}` : `file://${dir}`);

  // <base>/<path>/ -> <base>/<path>.html; <base> or <base>/ -> <base>/index.html
  const topicFile = (base, rest, hash) => {
    const path = (rest || '').replace(/^\/+/, '').replace(/\/+$/, '');
    return `${base}/${path ? `${path}.html` : 'index.html'}${hash || ''}`;
  };

  const create = ({
    env, platform, home, exists, installDir: initialInstallDir,
  }) => {
    let installDir = initialInstallDir;
    const helpDir = getenv(env, 'DYALOGHELPDIR') || '';
    const filePrefix = /^file:\/\//i.test(helpDir) ? decode(helpDir).replace(/\/+$/, '') : null;
    const sep = platform === 'win32' ? '\\' : '/';

    const installed = (version) => {
      if (helpDir || !exists) return null;
      const dir = candidates(env, platform, home, installDir, version).find((d) => exists(`${d}${sep}index.html`));
      return dir ? fileURL(dir, platform) : null;
    };

    const target = (url) => {
      const raw = decode(url);
      if (filePrefix && (raw === filePrefix || raw.startsWith(`${filePrefix}/`))) {
        const [, rest = '', hash = ''] = /^[^#]*?(\/[^#]*)?(#.*)?$/.exec(raw.slice(filePrefix.length));
        if (rest && !rest.endsWith('/')) return url;
        return encode(topicFile(filePrefix, rest, hash));
      }
      const m = ONLINE.exec(raw);
      if (!m || (m[2] && !m[2].endsWith('/'))) return url;
      const base = installed(m[1]);
      return base ? encode(topicFile(base, m[2], m[3])) : url;
    };

    const helpUri = (version) => (filePrefix ? `${filePrefix}/` : `https://docs.dyalog.com/${version}/`);

    // Takes the interpreter executable; both separators, as Windows paths reach here unconverted.
    const setInterpreter = (exe) => { installDir = exe.replace(/[\\/][^\\/]*$/, ''); };

    return { target, helpUri, setInterpreter };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else D.helpLocal = create;
})();
