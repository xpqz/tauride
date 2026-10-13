import * as monaco from 'monaco-editor';
const base = new URL('.', document.currentScript.src);
self.MonacoEnvironment = {
  getWorker(_id, label) {
    const name = label === 'json' ? 'json' :
      ['css', 'scss', 'less'].includes(label) ? 'css' :
        ['html', 'handlebars', 'razor'].includes(label) ? 'html' :
          ['typescript', 'javascript'].includes(label) ? 'typescript' : 'editor';
    return new Worker(new URL(`${name}.worker.js`, base));
  },
};
// Model defaults can be reapplied when editor preferences change.
monaco.editor.onDidCreateModel((model) => {
  const preserveSyntaxColours = () => {
    if (model.getOptions().bracketPairColorizationOptions.enabled) {
      model.updateOptions({
        bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false },
      });
    }
  };
  const listener = model.onDidChangeOptions(preserveSyntaxColours);
  model.onWillDispose(() => listener.dispose());
  preserveSyntaxColours();
});
window.monaco = monaco;
