const captureEl = document.getElementById('capture');
const statusEl = document.getElementById('status');
const EXPORT_BACKGROUND = '#0b1020';
let latestThread = null;
let showAdditional = false;
const hiddenTweetKeys = new Set();

init();

document.getElementById('download').addEventListener('click', downloadPng);
document.getElementById('copyText').addEventListener('click', copyThreadText);
const toggleAdditionalButton = document.getElementById('toggleAdditional');
if (toggleAdditionalButton) toggleAdditionalButton.addEventListener('click', toggleAdditionalThread);

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

  updateAdditionalButton();
  updateStatus(getVisibleMediaCount());
}

async function hydrateTweetMedia(thread) {
  const items = getAllMedia(thread);
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
    <div class="meta">${escapeHtml(formatIdentity(thread.authorHandle || '', thread.authorName || ''))} · ${escapeHtml(thread.sourceUrl || '')}</div>
    <div class="meta">Captured ${escapeHtml(new Date(thread.capturedAt).toLocaleString())}</div>
  `;
  root.append(header);

  renderTweetList(root, thread.tweets || [], thread.tweets?.length || 0, 'main');

  const additionalTweets = thread.additionalTweets || [];
  if (additionalTweets.length) {
    const section = document.createElement('section');
    section.className = `additionalThread${showAdditional ? '' : ' hidden'}`;
    section.innerHTML = `<div class="sectionLabel">Additional thread / replies</div>`;
    renderTweetList(section, additionalTweets, additionalTweets.length, 'additional');
    root.append(section);
  }

  captureEl.replaceChildren(root);
  updateAdditionalButton();
}

function renderTweetList(root, tweets, total, group) {
  for (const tweet of tweets) {
    const key = getTweetKey(tweet, group);
    const article = document.createElement('article');
    article.className = `tweet${tweet.quotedTweet ? ' hasQuotedTweet' : ''}${hiddenTweetKeys.has(key) ? ' hiddenTweet' : ''}`;
    article.dataset.tweetKey = key;
    article.innerHTML = `
      <div class="tweetTop">
        <div><span class="handle">${escapeHtml(tweet.handle || '')}</span>${tweet.authorName ? `<span class="authorName">${escapeHtml(tweet.authorName)}</span>` : ''}</div>
        <div class="tweetControls">
          <span class="index">${tweet.index}/${total}</span>
          <button class="tweetVisibility" type="button" data-tweet-key="${escapeHtml(key)}">${hiddenTweetKeys.has(key) ? '노출' : '비노출'}</button>
        </div>
      </div>
      <div class="text">${escapeHtml(tweet.text || '')}</div>
      ${renderMedia(tweet.media || [], tweet.quotedTweet ? 'quote' : 'tweet')}
      ${renderQuotedTweet(tweet.quotedTweet)}
      ${tweet.time ? `<div class="meta">${escapeHtml(new Date(tweet.time).toLocaleString())}</div>` : ''}
    `;
    root.append(article);
  }
}

captureEl.addEventListener('click', (event) => {
  const button = event.target.closest('.tweetVisibility');
  if (!button) return;
  const key = button.dataset.tweetKey;
  if (!key) return;
  if (hiddenTweetKeys.has(key)) hiddenTweetKeys.delete(key);
  else hiddenTweetKeys.add(key);
  renderThread(latestThread);
  updateStatus(getVisibleMediaCount());
});

function toggleAdditionalThread() {
  showAdditional = !showAdditional;
  renderThread(latestThread);
  updateStatus(getVisibleMediaCount());
}

function updateAdditionalButton() {
  if (!toggleAdditionalButton) return;
  const count = latestThread?.additionalTweets?.length || 0;
  toggleAdditionalButton.hidden = count === 0;
  toggleAdditionalButton.textContent = showAdditional ? `추가 thread 숨기기 (${count})` : `추가 thread 보이기 (${count})`;
}

function getVisibleMediaCount() {
  return getVisibleTweets().reduce((count, tweet) => count + (tweet.media?.length || 0) + (tweet.quotedTweet?.media?.length || 0), 0);
}

function updateStatus(mediaCount) {
  const visibleCount = getVisibleTweets().length;
  const hiddenCount = hiddenTweetKeys.size;
  statusEl.textContent = `${visibleCount} tweet(s), ${mediaCount} image(s) ready${hiddenCount ? ` · ${hiddenCount} hidden` : ''}`;
}

function getAllTweets(thread) {
  return [...(thread?.tweets || []), ...(thread?.additionalTweets || [])];
}

function getAllMedia(thread) {
  return getAllTweets(thread).flatMap((tweet) => [
    ...(tweet.media || []),
    ...(tweet.quotedTweet?.media || [])
  ]);
}

function getVisibleTweets() {
  if (!latestThread) return [];
  const main = (latestThread.tweets || []).map((tweet) => ({ tweet, group: 'main' }));
  const extra = showAdditional ? (latestThread.additionalTweets || []).map((tweet) => ({ tweet, group: 'additional' })) : [];
  return [...main, ...extra]
    .filter(({ tweet, group }) => !hiddenTweetKeys.has(getTweetKey(tweet, group)))
    .map(({ tweet }) => tweet);
}

function getTweetKey(tweet, group) {
  return `${group}:${tweet.statusId || tweet.url || `${tweet.handle}:${tweet.time}:${(tweet.text || '').slice(0, 80)}`}`;
}

function formatIdentity(handle, name) {
  if (handle && name) return `${handle} (${name})`;
  return handle || name || 'Unknown author';
}

function renderQuotedTweet(quotedTweet) {
  if (!quotedTweet) return '';
  return `
    <div class="quoteDivider"><span>아래는 인용된 ORIGINAL TWEET</span></div>
    <aside class="quotedTweet" aria-label="인용된 original tweet">
      <div class="quoteBadge">ORIGINAL TWEET · 인용 원문</div>
      <div class="quoteTop"><span class="handle">${escapeHtml(quotedTweet.handle || '')}</span>${quotedTweet.authorName ? `<span class="authorName">${escapeHtml(quotedTweet.authorName)}</span>` : ''}</div>
      <div class="quoteText">${escapeHtml(quotedTweet.text || '')}</div>
      ${renderMedia(quotedTweet.media || [], 'original')}
    </aside>
  `;
}

function renderMedia(media, owner = 'tweet') {
  const images = media.filter((item) => item.type === 'image');
  if (!images.length) return '';
  const label = owner === 'original' ? 'ORIGINAL TWEET IMAGE' : owner === 'quote' ? 'QUOTE TWEET IMAGE' : 'TWEET IMAGE';
  const className = owner === 'original' ? 'originalMedia' : owner === 'quote' ? 'quoteMedia' : 'tweetMedia';
  return `
    <div class="mediaBlock ${className}">
      <div class="mediaOwnerBadge">${escapeHtml(label)}</div>
      <div class="mediaGrid mediaCount${Math.min(images.length, 4)}">
        ${images.map((item) => item.dataUrl
          ? `<figure class="mediaFigure"><img class="tweetImage" src="${escapeHtml(item.dataUrl)}" alt="${escapeHtml(item.alt || 'tweet image')}" /><figcaption>${escapeHtml(label)}</figcaption></figure>`
          : `<div class="mediaError">${escapeHtml(label)} unavailable${item.error ? `: ${escapeHtml(item.error)}` : ''}</div>`).join('')}
      </div>
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
  const visibleTweets = getVisibleTweets();
  const text = visibleTweets.map((tweet, index) => {
    const quoteText = tweet.quotedTweet
      ? `\n\n[인용 원 트윗] ${formatIdentity(tweet.quotedTweet.handle || '', tweet.quotedTweet.authorName || '')}\n${tweet.quotedTweet.text || ''}`
      : '';
    return `${index + 1}/${visibleTweets.length} ${formatIdentity(tweet.handle || '', tweet.authorName || '')}\n${tweet.text}${quoteText}`;
  }).join('\n\n---\n\n');
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
  clone.querySelectorAll('.hiddenTweet').forEach((node) => node.remove());
  clone.querySelectorAll('.additionalThread.hidden').forEach((node) => node.remove());
  clone.querySelectorAll('button').forEach((node) => node.remove());
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
