// Build this optional extension with sample-extensions/build-vim.js, then set
// RIDE_JS to the resulting vim.bundle.js file.
import { initVimMode } from 'monaco-vim';

let vimMode;
$.extend(D.commands, {
  VIM(me) {
    const status = document.getElementById('sb_vim') || document.getElementById('sb_left').appendChild(
      Object.assign(document.createElement('div'), { id: 'sb_vim' }),
    );
    status.replaceChildren();
    vimMode = initVimMode(me, status);
    me.updateOptions({
      lineNumbers: 'relative',
      autoClosingQuotes: 'always',
      autoClosingBrackets: 'always',
    });
    return vimMode;
  },
  MIV() { if (vimMode) vimMode.dispose(); },
});
const remDefaultMap = D.remDefaultMap;
D.remDefaultMap = (me) => {
  remDefaultMap(me);
  D.commands.VIM(me);
};
$.extend(D.Ed.prototype, {
  setLN(x) {
    this.me.updateOptions({ lineNumbers: 'relative' });
    this.dom.querySelector('.tb_LN').classList.toggle('pressed', !!x);
  },
});
