const assert = require('node:assert/strict');
const test = require('node:test');

function loadBackgroundWithBrowser(browser) {
  delete require.cache[require.resolve('../background')];
  global.browser = browser;
  global.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
  return require('../background');
}

test('ensureContentScript injects extractor when ping succeeds without extractor global', async () => {
  const injected = [];
  const background = loadBackgroundWithBrowser({
    browserAction: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    tabs: {
      sendMessage: async () => ({ ok: true, extractorLoaded: false }),
      executeScript: async (_tabId, details) => injected.push(details.file)
    }
  });

  await background.ensureContentScript(7);

  assert.deepEqual(injected, ['thread-extractor.js']);
});

test('ensureContentScript injects extractor before content script when ping fails', async () => {
  const injected = [];
  const background = loadBackgroundWithBrowser({
    browserAction: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    tabs: {
      sendMessage: async () => {
        throw new Error('missing content script');
      },
      executeScript: async (_tabId, details) => injected.push(details.file)
    }
  });

  await background.ensureContentScript(7);

  assert.deepEqual(injected, ['thread-extractor.js', 'content.js']);
});

test('tryInjectExtractor reports optional extractor injection failures', async () => {
  const background = loadBackgroundWithBrowser({
    browserAction: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    tabs: {
      sendMessage: async () => ({ ok: true, extractorLoaded: false }),
      executeScript: async () => {
        throw new Error('inject failed');
      }
    }
  });

  assert.equal(await background.tryInjectExtractor(7), false);
});

test('ensureContentScript continues when optional extractor pre-injection fails before content injection', async () => {
  const injected = [];
  const background = loadBackgroundWithBrowser({
    browserAction: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    tabs: {
      sendMessage: async () => {
        throw new Error('missing content script');
      },
      executeScript: async (_tabId, details) => {
        injected.push(details.file);
        if (details.file === 'thread-extractor.js') throw new Error('inject failed');
      }
    }
  });

  await background.ensureContentScript(7);

  assert.deepEqual(injected, ['thread-extractor.js', 'content.js']);
});

test('describeError preserves Firefox extension api error details', () => {
  const background = loadBackgroundWithBrowser({
    browserAction: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    tabs: {}
  });
  const error = { message: 'An unexpected error occurred', fileName: 'ExtensionParent.sys.mjs', lineNumber: 42 };

  assert.equal(background.describeError(error), 'An unexpected error occurred (ExtensionParent.sys.mjs:42)');
});

test('describeError includes enumerable firefox error fields when location is absent', () => {
  const background = loadBackgroundWithBrowser({
    browserAction: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    tabs: {}
  });
  const error = { message: 'An unexpected error occurred', code: 'ERR_X', result: undefined };

  assert.equal(background.describeError(error), 'An unexpected error occurred {"message":"An unexpected error occurred","code":"ERR_X"}');
});

test('describeError treats literal undefined filename as absent', () => {
  const background = loadBackgroundWithBrowser({
    browserAction: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    tabs: {}
  });
  const error = { message: 'An unexpected error occurred', fileName: 'undefined', stage: 'ensureContentScript' };

  assert.equal(background.describeError(error), 'An unexpected error occurred {"message":"An unexpected error occurred","fileName":"undefined","stage":"ensureContentScript"}');
});

test('runStage preserves an inner stage label', async () => {
  const background = loadBackgroundWithBrowser({
    browserAction: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    tabs: {}
  });

  await assert.rejects(
    () => background.runStage('outer', () => background.runStage('inner', () => Promise.reject(new Error('failed')))),
    (error) => background.describeError(error).includes('"stage":"inner"')
  );
});

test('isXStatusUrl rejects status subpages', () => {
  const background = loadBackgroundWithBrowser({
    browserAction: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    tabs: {}
  });

  assert.equal(background.isXStatusUrl('https://x.com/zzzcokr/status/2063186008187994616/quotes'), false);
  assert.equal(background.isXStatusUrl('https://x.com/zzzcokr/status/2063264472018604125/analytics'), false);
  assert.equal(background.isXStatusUrl('https://x.com/zzzcokr/status/2063264472018604125'), true);
});
