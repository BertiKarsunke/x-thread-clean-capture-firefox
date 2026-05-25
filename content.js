const MAX_SCROLL_PASSES = 48;
const SCROLL_DELAY_MS = 750;

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'X_THREAD_CAPTURE_PING') {
    return Promise.resolve({ ok: true });
  }

  if (message?.type === 'X_THREAD_CAPTURE_COLLECT') {
    return collectThread()
      .then((thread) => ({ ok: true, thread }))
      .catch((error) => ({ ok: false, error: error.message }));
  }

  return false;
});

async function collectThread() {
  const statusId = getStatusId(location.href);
  if (!statusId) throw new Error('This is not a specific tweet/status page.');

  await settlePage();
  const accumulated = new Map();
  mergeTweets(accumulated, extractVisibleTweets());

  const firstPass = [...accumulated.values()];
  const target = firstPass.find((tweet) => tweet.statusId === statusId) || firstPass[0];
  if (!target) throw new Error('Could not find tweet articles on this page. Try reloading the X page first.');

  const authorHandle = target.handle;
  const seenMarkers = new Set();
  let stablePasses = 0;
  let lastTop = -1;

  for (let i = 0; i < MAX_SCROLL_PASSES; i += 1) {
    mergeTweets(accumulated, extractVisibleTweets());

    const scroller = document.scrollingElement;
    const beforeTop = scroller.scrollTop;
    const beforeHeight = scroller.scrollHeight;
    const nextTop = Math.min(beforeTop + Math.max(500, Math.floor(window.innerHeight * 0.85)), beforeHeight);

    window.scrollTo({ top: nextTop, behavior: 'auto' });
    await delay(SCROLL_DELAY_MS);
    await waitForVisibleTweetImages();
    mergeTweets(accumulated, extractVisibleTweets());

    const afterTop = scroller.scrollTop;
    const afterHeight = scroller.scrollHeight;
    const visibleCount = document.querySelectorAll('article[data-testid="tweet"]').length;
    const marker = `${Math.round(afterTop)}:${afterHeight}:${visibleCount}:${accumulated.size}`;

    if (seenMarkers.has(marker) || (Math.abs(afterTop - lastTop) < 4 && afterHeight === beforeHeight)) stablePasses += 1;
    else stablePasses = 0;

    seenMarkers.add(marker);
    lastTop = afterTop;
    if (stablePasses >= 4) break;
  }

  mergeTweets(accumulated, extractVisibleTweets());

  window.scrollTo({ top: 0, behavior: 'auto' });
  await delay(150);

  const all = [...accumulated.values()];
  const threadData = pickThreadData(all, statusId, authorHandle);
  if (!threadData.tweets.length) throw new Error('Found tweets, but could not isolate the thread.');

  return {
    sourceUrl: location.href,
    rootStatusId: statusId,
    authorHandle,
    authorName: target.authorName || '',
    capturedAt: new Date().toISOString(),
    tweets: threadData.tweets,
    additionalTweets: threadData.additionalTweets
  };
}

function mergeTweets(targetMap, tweets) {
  for (const tweet of tweets) {
    const key = tweet.statusId || `${tweet.handle}:${tweet.time}:${tweet.text.slice(0, 120)}`;
    const previous = targetMap.get(key);
    if (!previous) {
      targetMap.set(key, tweet);
      continue;
    }

    const mergedMedia = mergeMedia(previous.media || [], tweet.media || []);
    const betterText = tweet.text && tweet.text !== '[text unavailable]' && tweet.text.length > (previous.text || '').length;
    targetMap.set(key, {
      ...previous,
      ...tweet,
      text: betterText ? tweet.text : previous.text,
      authorName: previous.authorName || tweet.authorName,
      handle: previous.handle || tweet.handle,
      time: previous.time || tweet.time,
      url: previous.url || tweet.url,
      top: Math.min(previous.top ?? tweet.top, tweet.top ?? previous.top),
      media: mergedMedia
    });
  }
}

function mergeMedia(left, right) {
  const byUrl = new Map();
  for (const item of [...left, ...right]) {
    if (!item?.url) continue;
    const previous = byUrl.get(item.url);
    byUrl.set(item.url, previous ? { ...previous, ...item } : item);
  }
  return [...byUrl.values()];
}

function pickThreadData(tweets, rootStatusId, authorHandle) {
  const byId = new Map();
  for (const tweet of tweets) {
    const key = tweet.statusId || `${tweet.handle}:${tweet.text.slice(0, 80)}`;
    const previous = byId.get(key);
    if (!previous) byId.set(key, tweet);
    else byId.set(key, {
      ...previous,
      ...tweet,
      text: tweet.text.length > previous.text.length ? tweet.text : previous.text,
      media: mergeMedia(previous.media || [], tweet.media || []),
      top: Math.min(previous.top ?? tweet.top, tweet.top ?? previous.top)
    });
  }

  const ordered = [...byId.values()].sort((a, b) => a.top - b.top);
  const rootIndex = ordered.findIndex((tweet) => tweet.statusId === rootStatusId);
  const start = rootIndex >= 0 ? rootIndex : 0;
  const afterRoot = ordered.slice(start);

  const sameAuthor = [];
  for (const tweet of afterRoot) {
    if (tweet.handle === authorHandle) sameAuthor.push(tweet);
    else if (sameAuthor.length > 0 && tweet.top - sameAuthor[sameAuthor.length - 1].top > 1400) break;
  }

  const primary = sameAuthor.length ? sameAuthor : afterRoot.slice(0, 1);
  const primaryKeys = new Set(primary.map(tweetKey));
  const additionalTweets = afterRoot
    .filter((tweet) => !primaryKeys.has(tweetKey(tweet)))
    .map((tweet, index) => ({ ...tweet, index: index + 1 }));

  return {
    tweets: primary.map((tweet, index) => ({ ...tweet, index: index + 1 })),
    additionalTweets
  };
}

function tweetKey(tweet) {
  return tweet.statusId || `${tweet.handle}:${tweet.time}:${(tweet.text || '').slice(0, 80)}`;
}

function extractVisibleTweets() {
  return [...document.querySelectorAll('article[data-testid="tweet"]')]
    .map(articleToTweet)
    .filter(Boolean);
}

function articleToTweet(article) {
  const link = [...article.querySelectorAll('a[href*="/status/"]')]
    .map((a) => a.getAttribute('href'))
    .find((href) => /\/status\/\d+/.test(href || ''));
  const statusId = link ? getStatusId(link) : null;

  const handle = extractHandle(article);
  const authorName = extractAuthorName(article, handle);
  const time = article.querySelector('time')?.getAttribute('datetime') || '';
  const textNodes = [...article.querySelectorAll('[data-testid="tweetText"]')];
  const text = textNodes.map(normalizeTweetText).filter(Boolean).join('\n\n');
  const media = extractTweetMedia(article);
  if (!text && !statusId && !media.length) return null;

  const rect = article.getBoundingClientRect();
  return {
    statusId,
    url: link ? new URL(link, location.origin).toString() : '',
    authorName,
    handle,
    time,
    text: text || '[text unavailable]',
    media,
    top: rect.top + window.scrollY
  };
}

function extractTweetMedia(article) {
  const nodes = [
    ...article.querySelectorAll('[data-testid="tweetPhoto"] img, a[href*="/photo/"] img, img[src*="pbs.twimg.com/media/"], img[srcset*="pbs.twimg.com/media/"]')
  ];
  const seen = new Set();
  return nodes
    .map((img) => {
      const src = img.currentSrc || img.src || img.getAttribute('src') || firstSrcFromSrcset(img.getAttribute('srcset')) || '';
      const url = normalizeMediaUrl(src);
      if (!url || seen.has(url)) return null;
      seen.add(url);
      const rect = img.getBoundingClientRect();
      return {
        type: 'image',
        url,
        alt: img.getAttribute('alt') || '',
        width: Math.round(rect.width || img.naturalWidth || 0),
        height: Math.round(rect.height || img.naturalHeight || 0)
      };
    })
    .filter(Boolean);
}

function firstSrcFromSrcset(srcset) {
  if (!srcset) return '';
  return srcset.split(',').map((part) => part.trim().split(/\s+/)[0]).find(Boolean) || '';
}

function normalizeMediaUrl(src) {
  try {
    const url = new URL(src, location.href);
    if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' || !url.pathname.startsWith('/media/')) return '';
    url.searchParams.set('name', 'large');
    return url.toString();
  } catch {
    return '';
  }
}

function extractHandle(article) {
  const handleNode = [...article.querySelectorAll('a[role="link"] span')]
    .find((span) => /^@\w+/.test((span.textContent || '').trim()));
  return handleNode ? handleNode.textContent.trim() : '';
}

function extractAuthorName(article, handle) {
  const userLink = [...article.querySelectorAll('a[role="link"]')]
    .find((a) => handle && (a.textContent || '').includes(handle));
  if (!userLink) return '';
  const first = [...userLink.querySelectorAll('span')]
    .map((span) => span.textContent.trim())
    .find((text) => text && text !== handle && !text.startsWith('@'));
  return first || '';
}

function normalizeTweetText(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('img[alt]').forEach((img) => {
    const alt = img.getAttribute('alt');
    img.replaceWith(document.createTextNode(alt || ''));
  });
  return clone.textContent.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

function getStatusId(rawUrl) {
  try {
    const url = new URL(rawUrl, location.origin);
    return url.pathname.match(/\/status\/(\d+)/)?.[1] || null;
  } catch {
    return String(rawUrl).match(/\/status\/(\d+)/)?.[1] || null;
  }
}

async function settlePage() {
  await delay(800);
  const root = document.querySelector('article[data-testid="tweet"]');
  if (!root) await delay(1200);
  await waitForVisibleTweetImages();
}

async function waitForVisibleTweetImages() {
  const images = [...document.querySelectorAll('article[data-testid="tweet"] img[src*="pbs.twimg.com/media/"], article[data-testid="tweet"] img[srcset*="pbs.twimg.com/media/"]')];
  await Promise.all(images.map((img) => {
    if (img.complete && (img.currentSrc || img.src || img.getAttribute('srcset'))) return Promise.resolve();
    return new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 1200);
    });
  }));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
