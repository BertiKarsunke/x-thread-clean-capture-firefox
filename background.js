const CAPTURE_KEY = 'latestThreadCapture';
const ALLOWED_IMAGE_HOSTS = new Set(['pbs.twimg.com']);

browser.browserAction.onClicked.addListener(async (tab) => {
  if (!tab?.id || !isXStatusUrl(tab.url || '')) {
    await openErrorPage('Open a specific X/Twitter tweet URL first, e.g. https://x.com/user/status/123.');
    return;
  }

  try {
    await ensureContentScript(tab.id);
    const response = await browser.tabs.sendMessage(tab.id, { type: 'X_THREAD_CAPTURE_COLLECT' });
    if (!response?.ok) throw new Error(response?.error || 'Could not collect the thread.');

    await browser.storage.local.set({ [CAPTURE_KEY]: response.thread });
    await browser.tabs.create({ url: browser.runtime.getURL('capture.html') });
  } catch (error) {
    await openErrorPage(error.message);
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

  return false;
});

function isXStatusUrl(url) {
  try {
    const u = new URL(url);
    return ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(u.hostname) && /\/status\/\d+/.test(u.pathname);
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, { type: 'X_THREAD_CAPTURE_PING' });
  } catch {
    await browser.tabs.executeScript(tabId, { file: 'content.js' });
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
