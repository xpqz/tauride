// This is the list of command-to-keystroke mappings that are configurable in Preferences>Keys.
// The list does not necessarily contain all commands and all keystrokes in Ride,
// only those in Preferences>Keys.
// Some of the codes are inherited from Dyalog's old IDE
// (see ../docs/cmd-codes.txt and near the end of km.js)
// Others were made up for Ride's purposes - those use no fewer than three letters.
D.inlineTracingViews = [
  ['ITL', 'Left Argument', 'Left'],
  ['ITF', 'Current Function', 'Function'],
  ['ITR', 'Right Argument', 'Right'],
  ['ITA', 'Axis Specification', 'Axis'],
  ['ITRES', 'Previous Result', 'Result'],
  ['ITPL', 'Previous Left Argument', 'PLeft'],
  ['ITPF', 'Previous Function', 'PFunction'],
  ['ITPR', 'Previous Right Argument', 'PRight'],
  ['ITPA', 'Previous Axis', 'PAxis'],
];
D.outputCommands = {
  BXO: ']box off',
  BXN: ']box on -style=non',
  BXMIN: ']box on -style=min',
  BXMID: ']box on -style=mid',
  BXMAX: ']box on -style=max',
  BXQ: ']box ?',
  BXH: ']box -??',
  RWO: ']rows off',
  RWL: ']rows on -style=long',
  RWC: ']rows on -style=cut',
  RWW: ']rows on -style=wrap',
  RWFO: ']rows on -fold=off',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`RWF${n}`, `]rows on -fold=${n}`])),
  RWQ: ']rows ?',
  RWH: ']rows -??',
};
D.cmds = [
  /* eslint-disable */
  //code description                default keys
  ['ABT','About Ride',              ['Shift+F1']],
  ['AC', 'Align comments',          []],
  // The agent pairing port (tauri/agent-pairing.md) exists in Tauride only.
  ...(typeof window !== 'undefined' && window.__RIDE__ ? [
  ['AGC','Agent: allow control',    []],
  ['AGE', 'Agent: explain last error', []],
  ['AGO','Agent: observe session',  []],
  ] : []),
  ['AO', 'Comment out lines',       []],
  ['ASW', 'Auto Status',            []],
  ['BH', 'Run to exit (in tracer)', []],
  ['BK', 'Backward or Undo',        ['Ctrl+Shift+Backspace']],
  ['BP', 'Toggle breakpoint',       []],
  ['BXO','Boxing: Off',             []],
  ['BXN','Boxing: No Borders',      []],
  ['BXMIN','Boxing: Minimal',       []],
  ['BXMID','Boxing: Medium',        []],
  ['BXMAX','Boxing: Maximum',       []],
  ['BXQ','Boxing: Current Settings',[]],
  ['BXH','Boxing: Help',            []],
  ['BT', 'Back Tab between windows',['Ctrl+Shift+Tab']],
  ['CAM','Clear all trace/stop/monitor',[]],
  ['CAW','Close All Windows',[]],
  ['CBP','Clear stops for active object',[]],
  ['CLS','Close window',            D.mac?['Cmd+W']:[]],
  ['CNC','Connect',                 []],
  ['CVH','Clear Visible History',   []],
  ['DK', 'Delete lines',            []],
  ['DHI','Dyalog Help Index',       []],
  ['DMN','Next line in demo',       []],
  ['DMP','Previous line in demo',   []],
  ['DMR','Load demo file',          []],
  ['DOX','Documentation Centre',    []],
  ['DO', 'Uncomment lines',         []],
  ['EMI','Exit multiline input',    []],
  ['ED', 'Edit',                    ['Shift+Enter']],
  ['EP', 'Exit (and save changes)', ['Escape']],
  ['ER', 'Execute line',            ['Enter']],
  ['EXP','Expand selection',        [D.mac?'Shift+Option+Up':'Shift+Alt+Up']],
  ['FD', 'Forward or Redo',         ['Ctrl+Shift+Enter']],
  ['FX', 'Fix the current function',D.mac?['Cmd+S']:[]],
  ['HLP','Help',                    ['F1']],
  ['IT', 'Inline Tracing',          ['Ctrl+Alt+Enter']],
  ...D.inlineTracingViews.map(([code, label]) => [code, `Inline Tracing: ${label}`, []]),
  ['JBK','Jump back',               ['Ctrl+Shift+J']],
  ['JSC','Show JavaScript console', ['Shift+F12']],
  ['LBR','Toggle language bar',     []],
  ['LL', 'Left Limit',              ['Home']],
  ['LN', 'Toggle line numbers',     []],
  ['LOG','Show Ride protocol log',  ['Ctrl+F12']],
  ['MA', 'Continue execution of all threads',[]],
  ['NEW','New session',             [D.mac?'Cmd+N':'Ctrl+N']],
  ['NX' ,'Next match',              []],
  ['OWS','Open Workspace',          [D.mac?'Cmd+O':'Ctrl+O']],
  ['PAT','Pause all Threads',       []],
  ['POE','Pause on Error',          []],
  ['PRF','Show preferences',        D.mac?['Cmd+,']:[]],
  ['PV' ,'Previous match',          []], 
  ['QCP','Quick Command Palette',   D.mac?['Cmd+Shift+P']:[]],
  ['QIT','Quit',                    [D.mac?'Cmd+Q':'Ctrl+Q']],
  ['QT', 'Close window (and lose changes)',['Shift+Escape']],
  ['RD', 'Reformat',                D.mac?['Shift+Option+F','NumPad_Divide']:['NumPad_Divide']],
  ['RDO', 'Redo',                   [D.mac?'Shift+Cmd+Z':'Ctrl+Y']],
  ['RP', 'Replace',                 D.mac?['Cmd+Option+F']:[]],
  ['RL', 'Right Limit',             ['End']],
  ['RWO','Rows: Off',               []],
  ['RWL','Rows: Extend',            []],
  ['RWC','Rows: Cut',               []],
  ['RWW','Rows: Wrap',              []],
  ['RWFO','Rows: Folding Off',      []],
  ...Array.from({ length: 10 }, (_, n) => [`RWF${n}`, `Rows: Folding: Keep ${n} trailing row${n === 1 ? '' : 's'}`, []]),
  ['RWQ','Rows: Current Settings',  []],
  ['RWH','Rows: Help',              []],
  ['RM', 'Continue execution of this thread', []],
  ['UAT','Unpause all paused threads',[]],
  ['SA', 'Select All',              [D.mac?'Cmd+A':'Ctrl+A']],
  ['SC', 'Search',                  [D.mac?'Cmd+F':'Ctrl+F']],
  ['SI', 'Strong interrupt',        D.mac?['Ctrl+C']:[]],
  ['SBR','Toggle status bar',       []],
  ['SSW','Toggle status window',    []],
  ['STL','Skip to line',            []],
  ['TB', 'Tab between windows',     ['Ctrl+Tab']],
  ['TC', 'Trace line',              ['Ctrl+Enter']],
  ['TGC','Toggle comment',          D.mac?['Cmd+/']:[]],
  ['TIP','Show value tip',          []],
  ['TL', 'Toggle localisation',     ['Ctrl+Up']],
  ['TO', 'Toggle fold',             []],
  ['TTB','Toggle Trace/Edit toolbar',[]],
  ['TVB','Toggle view stops',       []],
  ['TVO','Toggle view outline',     []],
  ['TFR', 'Refresh threads',        []],
  ['UND', 'Undo',                   [D.mac?'Cmd+Z':'Ctrl+Z']],
  ['VAL','Evaluate selection or name under cursor',[]],
  ['WI', 'Weak interrupt',          D.mac?[]:['Ctrl+PauseBreak']],
  ['WSE','Toggle workspace explorer',[]],
  ['ZM', 'Toggle maximise editor',  []],
  ['ZMI','Increase font size',      D.mac?['Cmd+=','Cmd+Shift+=']:['Ctrl+=','Ctrl+Shift+=']],
  ['ZMO','Decrease font size',      [D.mac?'Cmd+-':'Ctrl+-']],
  ['ZMR','Reset font size',         [D.mac?'Cmd+0':'Ctrl+0']],
  ['PF1' ,'',                       []],
  ['PF2' ,'',                       ['F2']],
  ['PF3' ,'',                       ['F3']],
  ['PF4' ,'',                       ['F4']],
  ['PF5' ,'',                       ['F5']],
  ['PF6' ,'',                       ['F6']],
  ['PF7' ,'',                       ['F7']],
  ['PF8' ,'',                       ['F8']],
  ['PF9' ,'',                       ['F9']],
  ['PF10','',                       ['F10']],
  ['PF11','',                       []],
  ['PF12','',                       []],
  ['PF13','',                       []],
  ['PF14','',                       ['Shift+F2']],
  ['PF15','',                       ['Shift+F3']],
  ['PF16','',                       ['Shift+F4']],
  ['PF17','',                       ['Shift+F5']],
  ['PF18','',                       ['Shift+F6']],
  ['PF19','',                       ['Shift+F7']],
  ['PF20','',                       ['Shift+F8']],
  ['PF21','',                       ['Shift+F9']],
  ['PF22','',                       ['Shift+F10']],
  ['PF23','',                       ['Shift+F11']],
  ['PF24','',                       []],
  ['PF25','',                       ['Ctrl+F1']],
  ['PF26','',                       ['Ctrl+F2']],
  ['PF27','',                       ['Ctrl+F3']],
  ['PF28','',                       ['Ctrl+F4']],
  ['PF29','',                       ['Ctrl+F5']],
  ['PF30','',                       ['Ctrl+F6']],
  ['PF31','',                       ['Ctrl+F7']],
  ['PF32','',                       ['Ctrl+F8']],
  ['PF33','',                       ['Ctrl+F9']],
  ['PF34','',                       ['Ctrl+F10']],
  ['PF35','',                       ['Ctrl+F11']],
  ['PF36','',                       []],
  ['PF37','',                       ['Ctrl+Shift+F1']],
  ['PF38','',                       ['Ctrl+Shift+F2']],
  ['PF39','',                       ['Ctrl+Shift+F3']],
  ['PF40','',                       ['Ctrl+Shift+F4']],
  ['PF41','',                       ['Ctrl+Shift+F5']],
  ['PF42','',                       ['Ctrl+Shift+F6']],
  ['PF43','',                       ['Ctrl+Shift+F7']],
  ['PF44','',                       ['Ctrl+Shift+F8']],
  ['PF45','',                       ['Ctrl+Shift+F9']],
  ['PF46','',                       ['Ctrl+Shift+F10']],
  ['PF47','',                       ['Ctrl+Shift+F11']],
  ['PF48','',                       ['Ctrl+Shift+F12']],
  /* eslint-enable */
];

D.focusedShortcutCommands = ['FX', 'SI', 'SC', 'RP', 'QCP', 'TGC', 'RD'];
D.canonicalShortcut = (stroke) => {
  if (!D.mac) return stroke;
  const parts = stroke.replace(/\+(.)/g, '\n$1').split('\n');
  const key = parts.pop();
  const aliases = { Meta: 'Cmd', Alt: 'Option', Win: 'Ctrl' };
  const modifiers = parts.map(part => aliases[part] || part);
  return ['Ctrl', 'Cmd', 'Shift', 'Option'].filter(part => modifiers.includes(part))
    .concat(key).join('+');
};
D.effectiveKeys = (preferences = D.prf.keys()) => {
  const keys = {};
  if (!D.mac) {
    D.cmds.forEach(([command, , defaults]) => { keys[command] = preferences[command] || defaults; });
    return keys;
  }
  const owners = {};
  const own = command => Object.prototype.hasOwnProperty.call(preferences, command);
  D.cmds.forEach(([command, , defaults]) => {
    keys[command] = (own(command) ? preferences[command] : defaults).map(D.canonicalShortcut);
    if (!own(command)) keys[command].forEach(stroke => { owners[stroke] = command; });
  });
  D.cmds.forEach(([command]) => {
    if (own(command)) keys[command].forEach(stroke => { owners[stroke] = command; });
  });
  Object.keys(keys).forEach(command => {
    keys[command] = keys[command].filter(stroke => owners[stroke] === command);
  });
  return keys;
};
