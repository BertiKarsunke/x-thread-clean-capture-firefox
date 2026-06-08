const CAPTURE_KEY = 'latestThreadCapture';
const SETTINGS_KEY = 'captureSettings';
const ALLOWED_IMAGE_HOSTS = new Set(['pbs.twimg.com']);

browser.browserAction.onClicked.addListener(async (tab) => {
  if (!tab?.id || !isXStatusUrl(tab.url || '')) {
    await openErrorPage('Open a specific X/Twitter tweet URL first, e.g. https://x.com/user/status/123.');
    return;
  }

  try {
    await runStage('ensureContentScript', () => ensureContentScript(tab.id));
    const response = await runStage('collectThread', () => browser.tabs.sendMessage(tab.id, { type: 'X_THREAD_CAPTURE_COLLECT' }));
    if (!response?.ok) throw new Error(response?.error || 'Could not collect the thread.');

    await runStage('storeCapture', () => browser.storage.local.set({ [CAPTURE_KEY]: response.thread }));
    await runStage('openCapturePage', () => browser.tabs.create({ url: browser.runtime.getURL('capture.html') }));
  } catch (error) {
    await openErrorPage(describeError(error));
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'X_THREAD_CAPTURE_GET') {
    return browser.storage.local.get(CAPTURE_KEY)
      .then((data) => ({ ok: true, thread: data[CAPTURE_KEY] || null }))
      .catch((error) => ({ ok: false, error: error.message }));
  }

  if (message?.type === 'X_THREAD_CAPTURE_FETCH_IMAGE') {
    return fetchImageAsDataUrl(message.url)
      .then((dataUrl) => ({ ok: true, dataUrl }))
      .catch((error) => ({ ok: false, error: error.message }));
  }

  if (message?.type === 'X_THREAD_CAPTURE_GET_SETTINGS') {
    return browser.storage.local.get(SETTINGS_KEY)
      .then((data) => ({ ok: true, settings: data[SETTINGS_KEY] || null }))
      .catch((error) => ({ ok: false, error: error.message }));
  }

  if (message?.type === 'X_THREAD_CAPTURE_SAVE_SETTINGS') {
    return browser.storage.local.set({ [SETTINGS_KEY]: message.settings || {} })
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error: error.message }));
  }

  return false;
});

function isXStatusUrl(url) {
  try {
    const u = new URL(url);
    return ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(u.hostname) && /^\/[^/]+\/status\/\d+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

function describeError(error) {
  const message = error?.message || String(error);
  const hasLocation = error?.fileName && error.fileName !== 'undefined';
  const location = hasLocation ? ` (${error.fileName}${error.lineNumber ? `:${error.lineNumber}` : ''})` : '';
  if (location) return `${message}${location}`;
  const details = serializeErrorDetails(error);
  return details ? `${message} ${details}` : message;
}

async function runStage(stage, task) {
  try {
    return await task();
  } catch (error) {
    if (!error.stage) error.stage = stage;
    throw error;
  }
}

function serializeErrorDetails(error) {
  if (!error || typeof error !== 'object') return '';
  const details = {};
  for (const key of Object.keys(error)) {
    if (error[key] !== undefined) details[key] = error[key];
  }
  return Object.keys(details).length ? JSON.stringify(details) : '';
}

async function ensureContentScript(tabId) {
  let response;
  try {
    response = await runStage('pingContentScript', () => browser.tabs.sendMessage(tabId, { type: 'X_THREAD_CAPTURE_PING' }));
  } catch {
    await tryInjectExtractor(tabId);
    await runStage('injectContentScript', () => browser.tabs.executeScript(tabId, { file: 'content.js' }));
    return;
  }

  if (!response?.extractorLoaded) {
    await tryInjectExtractor(tabId);
  }
}

async function tryInjectExtractor(tabId) {
  try {
    await runStage('injectExtractor', () => browser.tabs.executeScript(tabId, { file: 'thread-extractor.js' }));
    return true;
  } catch {
    return false;
  }
}

async function openErrorPage(message) {
  await browser.storage.local.set({ [CAPTURE_KEY]: { error: message, tweets: [], capturedAt: new Date().toISOString() } });
  await browser.tabs.create({ url: browser.runtime.getURL('capture.html') });
}

async function fetchImageAsDataUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(url.hostname)) {
    throw new Error(`Blocked unsupported image host: ${url.hostname}`);
  }

  const response = await fetch(url.toString(), { credentials: 'omit', cache: 'force-cache' });
  if (!response.ok) throw new Error(`Image fetch failed: HTTP ${response.status}`);

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new Error(`Unsupported image type: ${contentType}`);

  const buffer = await response.arrayBuffer();
  return `data:${contentType};base64,${arrayBufferToBase64(buffer)}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

if (typeof module !== 'undefined') {
  module.exports = {
    ensureContentScript,
    describeError,
    isXStatusUrl,
    runStage,
    tryInjectExtractor
  };
}
