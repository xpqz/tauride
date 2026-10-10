const test = require('ava');
const { TauriApplication, resolveDyalog, readClipboard } = require('./_tauri');

exports.resolveDyalog = resolveDyalog;
exports.readClipboard = readClipboard;
async function nativeInput(client, command, args) {
  try {
    await client.execute((name, options) => window.__TAURI_INTERNALS__.invoke(name, options), command, args);
  } catch (error) { throw new Error(error.message); }
}
exports.keys = async (client, ...keys) => nativeInput(client, 'ui_test_keys', { keys });
exports.typeText = async (client, text) => exports.keys(client, text);
exports.moveTo = async (client, element) => {
  const position = await client.execute((target) => {
    const rect = target.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, element);
  await nativeInput(client, 'ui_test_move_to', position);
};

exports.inWin = function (id, s) {
  const w = D.ide.wins[id];
  s.replace(/<(.+?)>|(.)/g, (_, x, y) => {
    y ? w.insert(y) : D.commands[x] && D.commands[x](w.me);
  });
}

exports.sessionLastLines = function(n) {
  return D.ide.wins[0].me.getModel().getLinesContent().slice(-n);
}

class TFW {
  init(options = {}) {
    test.beforeEach(async (t) => {
      t.context.app = new TauriApplication(options);
      await t.context.app.start();
      t.context.userData = t.context.app.userData;
    });
    test.afterEach.always(async (t) => {
      if (t.context.app) await t.context.app.stop();
    });
  }
}
exports.tfw = new TFW();
