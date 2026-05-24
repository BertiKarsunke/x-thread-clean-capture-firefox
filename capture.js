const captureEl = document.getElementById('capture');
const statusEl = document.getElementById('status');
const EXPORT_BACKGROUND = '#0b1020';
let latestThread = null;

init();

document.getElementById('download').addEventListener('click', downloadPng);
document.getElementById('copyText').addEventListener('click', copyThreadText);

async function init() {
  const response = await browser.runtime.sendMessage({ type: 'X_THREAD_CAPTURE_GET' });
  if (!response?.ok || !response.thread) {
    renderError('No captured thread found. Go to an X/Twitter status page and click the extension icon.');
    return;
  }
  latestThread = response.thread;
  if (latestThread.error) {
    renderError(latestThread.error);
    return;
  }

  await hydrateTweetMedia(latestThread);
  renderThread(latestThread);

  const mediaCount = latestThread.tweets.reduce((count, tweet) => count + (tweet.media?.length || 0), 0);
  statusEl.textContent = `${latestThread.tweets.length} tweet(s), ${mediaCount} image(s) ready`;
}

async function hydrateTweetMedia(thread) {
  const items = thread.tweets.flatMap((tweet) => tweet.media || []);
  if (!items.length) return;

  statusEl.textContent = `Loading ${items.length} image(s)...`;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    try {
      const response = await browser.runtime.sendMessage({ type: 'X_THREAD_CAPTURE_FETCH_IMAGE', url: item.url });
      if (!response?.ok || !response.dataUrl) throw new Error(response?.error || 'Image fetch failed');
      item.dataUrl = response.dataUrl;
      statusEl.textContent = `Loaded ${i + 1}/${items.length} image(s)...`;
    } catch (error) {
      item.error = error.message;
    }
  }
}

function renderThread(thread) {
  const root = document.createElement('div');
  const header = document.createElement('header');
  header.className = 'header';
  header.innerHTML = `
    <h1 class="title">Clean X Thread Capture</h1>
    <div class="meta">${escapeHtml(thread.authorHandle || 'Unknown author')} · ${escapeHtml(thread.sourceUrl || '')}</div>
    <div class="meta">Captured ${escapeHtml(new Date(thread.capturedAt).toLocaleString())}</div>
  `;
  root.append(header);

  for (const tweet of thread.tweets) {
    const article = document.createElement('article');
    article.className = 'tweet';
    article.innerHTML = `
      <div class="tweetTop">
        <div><span class="author">${escapeHtml(tweet.authorName || tweet.handle || 'Unknown')}</span><span class="handle">${escapeHtml(tweet.handle || '')}</span></div>
        <div class="index">${tweet.index}/${thread.tweets.length}</div>
      </div>
      <div class="text">${escapeHtml(tweet.text || '')}</div>
      ${renderMedia(tweet.media || [])}
      ${tweet.time ? `<div class="meta">${escapeHtml(new Date(tweet.time).toLocaleString())}</div>` : ''}
    `;
    root.append(article);
  }

  captureEl.replaceChildren(root);
}

function renderMedia(media) {
  const images = media.filter((item) => item.type === 'image');
  if (!images.length) return '';
  return `
    <div class="mediaGrid mediaCount${Math.min(images.length, 4)}">
      ${images.map((item) => item.dataUrl
        ? `<img class="tweetImage" src="${escapeHtml(item.dataUrl)}" alt="${escapeHtml(item.alt || 'tweet image')}" />`
        : `<div class="mediaError">Image unavailable${item.error ? `: ${escapeHtml(item.error)}` : ''}</div>`).join('')}
    </div>
  `;
}

function renderError(message) {
  captureEl.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
  statusEl.textContent = 'Error';
}

async function downloadPng() {
  try {
    statusEl.textContent = 'Rendering PNG...';
    await waitForImages(captureEl);
    const blob = await elementToPngBlob(captureEl);
    const name = buildFilename(latestThread);
    saveBlob(blob, name);
    statusEl.textContent = 'Download started';
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

async function copyThreadText() {
  if (!latestThread?.tweets?.length) return;
  const text = latestThread.tweets.map((tweet) => `${tweet.index}/${latestThread.tweets.length} ${tweet.handle}\n${tweet.text}`).join('\n\n---\n\n');
  await navigator.clipboard.writeText(text);
  statusEl.textContent = 'Thread text copied';
}

async function elementToPngBlob(element) {
  await document.fonts.ready;
  await waitForImages(element);
  const rect = element.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(element.scrollHeight);
  const clone = element.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  clone.style.width = `${width}px`;
  clone.style.margin = '0';
  clone.style.boxShadow = 'none';
  clone.style.borderRadius = '14px';
  clone.style.background = EXPORT_BACKGROUND;

  const css = [...document.styleSheets]
    .map((sheet) => {
      try { return [...sheet.cssRules].map((rule) => rule.cssText).join('\n'); }
      catch { return ''; }
    })
    .join('\n');

  const xhtml = new XMLSerializer().serializeToString(clone);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="${EXPORT_BACKGROUND}" />
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px; min-height:${height}px; background:${EXPORT_BACKGROUND};">
          <style>${css}</style>${xhtml}
        </div>
      </foreignObject>
    </svg>`;

  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'sync';
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    const scale = Math.min(2, window.devicePixelRatio || 1.5);
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = EXPORT_BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not render PNG blob.'));
    }, 'image/png');
  });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function waitForImages(root) {
  const images = [...root.querySelectorAll('img')];
  await Promise.all(images.map((img) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 3000);
    });
  }));
}

function buildFilename(thread) {
  const id = thread?.rootStatusId || 'thread';
  const handle = (thread?.authorHandle || 'x').replace(/[^a-zA-Z0-9_-]/g, '');
  return `x-thread-${handle}-${id}.png`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
