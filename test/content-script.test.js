const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

function loadContentScript() {
  let listener = null;
  const context = {
    XThreadCaptureExtractor: { getStatusId() {} },
    browser: {
      runtime: {
        onMessage: {
          addListener(callback) {
            listener = callback;
          }
        }
      }
    },
    document: {},
    location: { href: 'https://x.com/alice/status/100' },
    setTimeout,
    window: {}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('content.js', 'utf8'), context);
  return listener;
}

test('ping reports extractor loaded from the Firefox content script global', async () => {
  const listener = loadContentScript();

  const response = await listener({ type: 'X_THREAD_CAPTURE_PING' });

  assert.equal(response.ok, true);
  assert.equal(response.extractorLoaded, true);
});
