const captureEl = document.getElementById('capture');
const statusEl = document.getElementById('status');
const DEFAULT_SETTINGS = {
  theme: 'dark',
  widthPreset: 'standard',
  fontScale: 100,
  showMetadata: true,
  showWatermark: false
};
const WIDTH_PRESETS = {
  compact: 640,
  standard: 760,
  wide: 960
};
const EXPORT_BACKGROUNDS = {
  dark: '#0b1020',
  light: '#f8fafc'
};
let latestThread = null;
let showAdditional = false;
let captureSettings = { ...DEFAULT_SETTINGS };
const hiddenTweetKeys = new Set();

init();

document.getElementById('download').addEventListener('click', downloadPng);
document.getElementById('copyImage').addEventListener('click', copyThreadImage);
document.getElementById('copyText').addEventListener('click', copyThreadText);
document.getElementById('copyMarkdown').addEventListener('click', copyThreadMarkdown);
document.getElementById('openSource').addEventListener('click', openSourceUrl);
document.getElementById('resetHidden').addEventListener('click', resetHiddenTweets);
const toggleAdditionalButton = document.getElementById('toggleAdditional');
if (toggleAdditionalButton) toggleAdditionalButton.addEventListener('click', toggleAdditionalThread);
const settingInputs = {
  theme: document.getElementById('theme'),
  widthPreset: document.getElementById('widthPreset'),
  fontScale: document.getElementById('fontScale'),
  showMetadata: document.getElementById('showMetadata'),
  showWatermark: document.getElementById('showWatermark')
};
Object.values(settingInputs).forEach((input) => input.addEventListener('change', updateCaptureSettings));

async function init() {
  await loadSettings();
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

async function loadSettings() {
  try {
    const response = await browser.runtime.sendMessage({ type: 'X_THREAD_CAPTURE_GET_SETTINGS' });
    captureSettings = normalizeSettings(response?.settings);
  } catch {
    captureSettings = { ...DEFAULT_SETTINGS };
  }
  syncSettingsControls();
  applyCaptureSettings();
}

function normalizeSettings(settings) {
  const next = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (!WIDTH_PRESETS[next.widthPreset]) next.widthPreset = DEFAULT_SETTINGS.widthPreset;
  if (!EXPORT_BACKGROUNDS[next.theme]) next.theme = DEFAULT_SETTINGS.theme;
  next.fontScale = Math.min(120, Math.max(90, Number(next.fontScale) || DEFAULT_SETTINGS.fontScale));
  next.showMetadata = Boolean(next.showMetadata);
  next.showWatermark = Boolean(next.showWatermark);
  return next;
}

function syncSettingsControls() {
  settingInputs.theme.value = captureSettings.theme;
  settingInputs.widthPreset.value = captureSettings.widthPreset;
  settingInputs.fontScale.value = String(captureSettings.fontScale);
  settingInputs.showMetadata.checked = captureSettings.showMetadata;
  settingInputs.showWatermark.checked = captureSettings.showWatermark;
}

async function updateCaptureSettings() {
  captureSettings = normalizeSettings({
    theme: settingInputs.theme.value,
    widthPreset: settingInputs.widthPreset.value,
    fontScale: settingInputs.fontScale.value,
    showMetadata: settingInputs.showMetadata.checked,
    showWatermark: settingInputs.showWatermark.checked
  });
  applyCaptureSettings();
  renderThread(latestThread);
  updateStatus(getVisibleMediaCount());
  await browser.runtime.sendMessage({ type: 'X_THREAD_CAPTURE_SAVE_SETTINGS', settings: captureSettings });
}

function applyCaptureSettings() {
  captureEl.classList.toggle('themeLight', captureSettings.theme === 'light');
  captureEl.classList.toggle('hideMetadata', !captureSettings.showMetadata);
  captureEl.style.setProperty('--capture-width', `${WIDTH_PRESETS[captureSettings.widthPreset]}px`);
  captureEl.style.setProperty('--capture-font-scale', `${captureSettings.fontScale}%`);
}

async function hydrateTweetMedia(thread) {
  const items = getAllMedia(thread);
  if (!items.length) return;

  statusEl.textContent = `Loading ${items.length} image(s)...`;
  let failures = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    try {
      const response = await browser.runtime.sendMessage({ type: 'X_THREAD_CAPTURE_FETCH_IMAGE', url: item.url });
      if (!response?.ok || !response.dataUrl) throw new Error(response?.error || 'Image fetch failed');
      item.dataUrl = response.dataUrl;
      statusEl.textContent = `Loaded ${i + 1}/${items.length} image(s)...`;
    } catch (error) {
      item.error = error.message;
      failures += 1;
    }
  }
  if (thread.collectionMeta) thread.collectionMeta.mediaFetchFailures = failures;
}

function renderThread(thread) {
  if (!thread) return;
  applyCaptureSettings();
  const root = document.createElement('div');
  const header = document.createElement('header');
  header.className = 'header';
  const identityMeta = document.createElement('div');
  identityMeta.className = 'meta';
  identityMeta.textContent = `${formatIdentity(thread.authorHandle || '', thread.authorName || '')} · ${thread.sourceUrl || ''}`;
  const capturedMeta = document.createElement('div');
  capturedMeta.className = 'meta';
  capturedMeta.textContent = `Captured ${new Date(thread.capturedAt).toLocaleString()}`;
  header.replaceChildren(identityMeta, capturedMeta);
  root.append(header);

  renderTweetList(root, thread.tweets || [], thread.tweets?.length || 0, 'main');

  const additionalTweets = thread.additionalTweets || [];
  if (additionalTweets.length) {
    const section = document.createElement('section');
    section.className = `additionalThread${showAdditional ? '' : ' hidden'}`;
    const sectionLabel = document.createElement('div');
    sectionLabel.className = 'sectionLabel';
    sectionLabel.textContent = 'Additional thread / replies';
    section.append(sectionLabel);
    renderTweetList(section, additionalTweets, additionalTweets.length, 'additional');
    root.append(section);
  }

  if (captureSettings.showWatermark) {
    const watermark = document.createElement('div');
    watermark.className = 'watermark';
    watermark.textContent = 'Captured with X Thread Clean Capture';
    root.append(watermark);
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
    article.replaceChildren(...htmlFragment(`
      <div class="tweetTop">
        ${renderAuthorIdentity(tweet.handle || '', tweet.authorName || '')}
        <div class="tweetControls">
          <span class="index">${tweet.index}/${total}</span>
          <button class="tweetVisibility" type="button" data-tweet-key="${escapeHtml(key)}">${hiddenTweetKeys.has(key) ? '노출' : '비노출'}</button>
        </div>
      </div>
      <div class="text">${escapeHtml(tweet.text || '')}</div>
      ${renderLinks(tweet.links || [], tweet.quotedTweet ? 'QUOTE TWEET LINK' : 'TWEET LINK')}
      ${renderMedia(tweet.media || [], tweet.quotedTweet ? 'quote' : 'tweet')}
      ${renderQuotedTweet(tweet.quotedTweet)}
      ${tweet.time ? `<div class="meta">${escapeHtml(new Date(tweet.time).toLocaleString())}</div>` : ''}
    `));
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
  const meta = latestThread?.collectionMeta;
  const stop = meta ? ` · collected ${meta.collectedTweetCount} in ${meta.scrollPasses} pass(es)` : '';
  statusEl.textContent = `${visibleCount} tweet(s), ${mediaCount} image(s) ready${hiddenCount ? ` · ${hiddenCount} hidden` : ''}${stop}`;
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
  if (handle && name) return `${name} ${handle}`;
  return name || handle || 'Unknown author';
}

function renderAuthorIdentity(handle, name) {
  const separator = name && handle ? ' ' : '';
  return `<div class="tweetAuthor">${name ? `<span class="authorName">${escapeHtml(name)}</span>` : ''}${separator}${handle ? `<span class="handle">${escapeHtml(handle)}</span>` : ''}</div>`;
}

function renderQuotedTweet(quotedTweet) {
  if (!quotedTweet) return '';
  return `
    <div class="quoteDivider"><span>아래는 인용된 ORIGINAL TWEET</span></div>
    <aside class="quotedTweet" aria-label="인용된 original tweet">
      <div class="quoteBadge">ORIGINAL TWEET · 인용 원문</div>
      <div class="quoteTop">${renderAuthorIdentity(quotedTweet.handle || '', quotedTweet.authorName || '')}</div>
      <div class="quoteText">${escapeHtml(quotedTweet.text || '')}</div>
      ${renderLinks(quotedTweet.links || [], 'ORIGINAL TWEET LINK')}
      ${quotedTweet.url ? `<div class="sourceLink"><span>ORIGINAL TWEET URL</span><a href="${escapeHtml(quotedTweet.url)}">${escapeHtml(quotedTweet.url)}</a></div>` : ''}
      ${renderMedia(quotedTweet.media || [], 'original')}
    </aside>
  `;
}

function renderLinks(links, label = 'LINK') {
  if (!links?.length) return '';
  return `
    <div class="linkBlock">
      <div class="linkBadge">${escapeHtml(label)}</div>
      ${links.map((link) => `
        <div class="tweetLink">
          <span class="linkText">${escapeHtml(link.text || link.url)}</span>
          <a href="${escapeHtml(link.url)}">${escapeHtml(link.url)}</a>
          ${link.shortUrl ? `<span class="shortLink">t.co: ${escapeHtml(link.shortUrl)}</span>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function renderMedia(media, owner = 'tweet') {
  const images = media.filter((item) => item.type === 'image');
  if (!images.length) return '';
  const label = owner === 'original' ? 'ORIGINAL TWEET IMAGE' : owner === 'quote' ? 'QUOTE TWEET IMAGE' : 'TWEET IMAGE';
  const className = owner === 'original' ? 'originalMedia' : owner === 'quote' ? 'quoteMedia' : 'tweetMedia';
  return `
    <div class="mediaBlock ${className}">
      <div class="mediaStack">
        ${images.map((item) => item.dataUrl
          ? `<figure class="mediaFigure"><img class="tweetImage" src="${escapeHtml(item.dataUrl)}" alt="${escapeHtml(item.alt || 'tweet image')}" /></figure>`
          : `<div class="mediaError">${escapeHtml(label)} unavailable${item.error ? `: ${escapeHtml(item.error)}` : ''}</div>`).join('')}
      </div>
    </div>
  `;
}

function renderError(message) {
  const error = document.createElement('p');
  error.className = 'error';
  error.textContent = message;
  captureEl.replaceChildren(error);
  statusEl.textContent = 'Error';
}

function htmlFragment(markup) {
  const parsed = new DOMParser().parseFromString(markup, 'text/html');
  return [...parsed.body.childNodes].map((node) => document.importNode(node, true));
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

async function copyThreadImage() {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      throw new Error('Image clipboard is unavailable in this Firefox context. Use Download PNG.');
    }
    statusEl.textContent = 'Rendering image for clipboard...';
    await waitForImages(captureEl);
    const blob = await elementToPngBlob(captureEl);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    statusEl.textContent = 'Thread image copied';
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

async function copyThreadText() {
  if (!latestThread?.tweets?.length) return;
  const visibleTweets = getVisibleTweets();
  const text = visibleTweets.map((tweet, index) => {
    const linksText = formatLinksForCopy(tweet.links || [], 'QUOTE TWEET LINK');
    const quoteText = tweet.quotedTweet
      ? `\n\n[인용 원 트윗] ${formatIdentity(tweet.quotedTweet.handle || '', tweet.quotedTweet.authorName || '')}\n${tweet.quotedTweet.text || ''}${formatLinksForCopy(tweet.quotedTweet.links || [], 'ORIGINAL TWEET LINK')}${tweet.quotedTweet.url ? `\nORIGINAL TWEET URL: ${tweet.quotedTweet.url}` : ''}`
      : '';
    return `${index + 1}/${visibleTweets.length} ${formatIdentity(tweet.handle || '', tweet.authorName || '')}\n${tweet.text}${linksText}${quoteText}`;
  }).join('\n\n---\n\n');
  await navigator.clipboard.writeText(text);
  statusEl.textContent = 'Thread text copied';
}

async function copyThreadMarkdown() {
  if (!latestThread?.tweets?.length) return;
  const visibleTweets = getVisibleTweets();
  const markdown = visibleTweets.map((tweet, index) => {
    const links = markdownLinks(tweet.links || []);
    const media = markdownMedia(tweet.media || []);
    const quote = tweet.quotedTweet ? markdownQuotedTweet(tweet.quotedTweet) : '';
    return `### ${index + 1}/${visibleTweets.length} ${formatIdentity(tweet.handle || '', tweet.authorName || '')}\n\n${tweet.text || ''}${links}${media}${quote}`;
  }).join('\n\n---\n\n');
  await navigator.clipboard.writeText(markdown);
  statusEl.textContent = 'Thread markdown copied';
}

function openSourceUrl() {
  if (!latestThread?.sourceUrl) return;
  window.open(latestThread.sourceUrl, '_blank', 'noopener');
}

function resetHiddenTweets() {
  hiddenTweetKeys.clear();
  renderThread(latestThread);
  updateStatus(getVisibleMediaCount());
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
  clone.style.background = EXPORT_BACKGROUNDS[captureSettings.theme];

  const css = [...document.styleSheets]
    .map((sheet) => {
      try { return [...sheet.cssRules].map((rule) => rule.cssText).join('\n'); }
      catch { return ''; }
    })
    .join('\n');

  const xhtml = new XMLSerializer().serializeToString(clone);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="${EXPORT_BACKGROUNDS[captureSettings.theme]}" />
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px; min-height:${height}px; background:${EXPORT_BACKGROUNDS[captureSettings.theme]};">
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
    ctx.fillStyle = EXPORT_BACKGROUNDS[captureSettings.theme];
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

function formatLinksForCopy(links, label) {
  if (!links?.length) return '';
  return `
${label}:
${links.map((link) => `- ${link.text || link.url}: ${link.url}${link.shortUrl ? ` (t.co: ${link.shortUrl})` : ''}`).join('\n')}`;
}

function markdownLinks(links) {
  if (!links?.length) return '';
  return `\n\n${links.map((link) => `- [${escapeMarkdown(link.text || link.url)}](${link.url})`).join('\n')}`;
}

function markdownMedia(media) {
  const images = media.filter((item) => item.type === 'image');
  if (!images.length) return '';
  return `\n\n${images.map((item) => `![${escapeMarkdown(item.alt || 'tweet image')}](${item.url})`).join('\n')}`;
}

function markdownQuotedTweet(quotedTweet) {
  const links = markdownLinks(quotedTweet.links || []);
  const media = markdownMedia(quotedTweet.media || []);
  const source = quotedTweet.url ? `\n\nOriginal: ${quotedTweet.url}` : '';
  return `\n\n> ${formatIdentity(quotedTweet.handle || '', quotedTweet.authorName || '')}\n>\n> ${(quotedTweet.text || '').replace(/\n/g, '\n> ')}${links}${media}${source}`;
}

function escapeMarkdown(value) {
  return String(value).replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function buildFilename(thread) {
  const id = thread?.rootStatusId || 'thread';
  const handle = (thread?.authorHandle || 'x').replace(/[^a-zA-Z0-9_-]/g, '');
  const date = new Date(thread?.capturedAt || Date.now()).toISOString().slice(0, 10).replaceAll('-', '');
  return `x-thread-${handle}-${id}-${date}.png`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
