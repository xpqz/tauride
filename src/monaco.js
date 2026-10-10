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
window.monaco = monaco;
