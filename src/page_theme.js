// A page in a window of its own (About, the protocol log, a dialog, status
// output) opens in the theme its session last applied; the session sends
// later changes, which call setPageTheme.
window.setPageTheme = (t) => {
  document.getElementById('theme_dark').disabled = t !== 'dark';
  document.getElementById('theme_light').disabled = t !== 'light';
};
window.setPageTheme(require('@electron/remote').getGlobal('winstate').theme);
