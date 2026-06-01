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
      links: mergeLinks(previous.links || [], tweet.links || []),
      top: Math.min(previous.top ?? tweet.top, tweet.top ?? previous.top),
      media: mergedMedia,
      quotedTweet: mergeQuotedTweet(previous.quotedTweet, tweet.quotedTweet)
    });
  }
}

function mergeQuotedTweet(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return {
    ...left,
    ...right,
    text: (right.text || '').length > (left.text || '').length ? right.text : left.text,
    authorName: left.authorName || right.authorName,
    handle: left.handle || right.handle,
    url: left.url || right.url,
    links: mergeLinks(left.links || [], right.links || []),
    media: mergeMedia(left.media || [], right.media || [])
  };
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

function mergeLinks(left = [], right = []) {
  const byUrl = new Map();
  for (const item of [...left, ...right]) {
    if (!item?.url) continue;
    const previous = byUrl.get(item.url);
    byUrl.set(item.url, previous ? { ...previous, ...item, text: previous.text || item.text, display: previous.display || item.display } : item);
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
      links: mergeLinks(previous.links || [], tweet.links || []),
      media: mergeMedia(previous.media || [], tweet.media || []),
      quotedTweet: mergeQuotedTweet(previous.quotedTweet, tweet.quotedTweet),
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
  const allTextNodes = [...article.querySelectorAll('[data-testid="tweetText"]')];
  const quoteRoot = findQuotedTweetRoot(article, allTextNodes);
  const timeLink = article.querySelector('time')?.closest('a[href*="/status/"]');
  const link = timeLink?.getAttribute('href') || [...article.querySelectorAll('a[href*="/status/"]')]
    .filter((a) => !quoteRoot?.contains(a))
    .map((a) => a.getAttribute('href'))
    .find((href) => /\/status\/\d+/.test(href || ''));
  const statusId = link ? getStatusId(link) : null;

  const handle = extractHandle(article, quoteRoot);
  const authorName = extractAuthorName(article, handle, quoteRoot);
  const time = article.querySelector('time')?.getAttribute('datetime') || '';
  const textNodes = allTextNodes.filter((node) => !quoteRoot?.contains(node));
  const text = textNodes.map(normalizeTweetText).filter(Boolean).join('\n\n');
  const links = extractTextLinks(textNodes);
  const mediaSplit = splitTweetMedia(article, quoteRoot, allTextNodes, textNodes);
  let quotedTweet = extractQuotedTweetFromArticle(article, quoteRoot, allTextNodes, textNodes);
  if (quotedTweet && mediaSplit.original.length) {
    quotedTweet = {
      ...quotedTweet,
      media: cleanMediaItems(mergeMedia(mediaSplit.original, quotedTweet.media || [])).map((item) => ({ ...item, owner: 'original' }))
    };
  }
  const quoteMediaUrls = new Set((quotedTweet?.media || []).map((item) => item.url));
  const mainMedia = cleanMediaItems(quoteMediaUrls.size ? mediaSplit.main.filter((item) => !quoteMediaUrls.has(item.url)) : mediaSplit.main);
  if (!text && !statusId && !mainMedia.length && !quotedTweet) return null;

  const rect = article.getBoundingClientRect();
  return {
    statusId,
    url: link ? new URL(link, location.origin).toString() : '',
    authorName,
    handle,
    time,
    text: text || '[text unavailable]',
    links,
    media: mainMedia.map((item) => ({ ...item, owner: quotedTweet ? 'quote' : 'tweet' })),
    quotedTweet,
    top: rect.top + window.scrollY
  };
}

function extractTweetMedia(article, excludeRoot = null) {
  const nodes = [
    ...article.querySelectorAll('[data-testid="tweetPhoto"] img, a[href*="/photo/"] img, img[src*="pbs.twimg.com/media/"], img[srcset*="pbs.twimg.com/media/"]')
  ];
  const seen = new Set();
  return nodes
    .filter((img) => !excludeRoot?.contains(img))
    .map((img) => imageToMediaItem(img, seen))
    .filter(Boolean);
}

function extractAllTweetMedia(article) {
  const nodes = [
    ...article.querySelectorAll('[data-testid="tweetPhoto"] img, a[href*="/photo/"] img, img[src*="pbs.twimg.com/media/"], img[srcset*="pbs.twimg.com/media/"]')
  ];
  const seen = new Set();
  return nodes.map((img) => imageToMediaItem(img, seen)).filter(Boolean);
}

function imageToMediaItem(img, seen) {
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
    height: Math.round(rect.height || img.naturalHeight || 0),
    _top: rect.top,
    _bottom: rect.bottom,
    _node: img
  };
}

function splitTweetMedia(article, quoteRoot, allTextNodes, mainTextNodes = []) {
  const allMedia = extractAllTweetMedia(article);
  if (!quoteRoot && allTextNodes.length <= 1) return { main: allMedia, original: [] };

  const mainTexts = mainTextNodes.length ? mainTextNodes : (quoteRoot ? allTextNodes.filter((node) => !quoteRoot.contains(node)) : allTextNodes.slice(0, 1));
  const originalTexts = quoteRoot
    ? allTextNodes.filter((node) => quoteRoot.contains(node))
    : allTextNodes.slice(mainTexts.length || 1);
  const quoteRect = quoteRoot?.getBoundingClientRect?.() || null;
  const originalTop = minNodeTop(originalTexts) ?? quoteRect?.top ?? null;
  const mainBottom = maxNodeBottom(mainTexts);

  const original = [];
  const main = [];
  for (const item of allMedia) {
    const img = item._node;
    let owner = 'main';

    // Strongest signal: DOM containment inside the quoted/original tweet card.
    if (quoteRoot?.contains(img)) {
      owner = 'original';
    } else {
      const mediaContainer = getMediaContainer(img, article);
      const containsOriginalText = originalTexts.some((node) => mediaContainer?.contains(node));
      const containsMainText = mainTexts.some((node) => mediaContainer?.contains(node));

      if (containsOriginalText && !containsMainText) owner = 'original';
      else if (quoteRect && item._top >= quoteRect.top - 4 && item._bottom <= quoteRect.bottom + 4) owner = 'original';
      else if (originalTop != null && mainBottom != null && item._top >= originalTop - 4 && item._top > mainBottom + 4) owner = 'original';
      else owner = 'main';
    }

    if (owner === 'original') original.push(item);
    else main.push(item);
  }

  const originalUrls = new Set(original.map((item) => item.url));
  return {
    main: main.filter((item) => !originalUrls.has(item.url)),
    original
  };
}

function getMediaContainer(img, article) {
  return img.closest('[data-testid="tweetPhoto"], a[href*="/photo/"], div[aria-label], div[role="group"], div') || article;
}

function minNodeTop(nodes) {
  const values = nodes.map((node) => node.getBoundingClientRect?.().top).filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function maxNodeBottom(nodes) {
  const values = nodes.map((node) => node.getBoundingClientRect?.().bottom).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function cleanMediaItems(items) {
  return items.map(({ _top, _bottom, _node, ...item }) => item);
}
function findQuotedTweetRoot(article, allTextNodes = [...article.querySelectorAll('[data-testid="tweetText"]')]) {
  const textRoot = findTextAnchoredQuotedTweetRoot(article, allTextNodes);
  if (textRoot) return textRoot;

  const mainTime = article.querySelector(':scope time');
  const mainStatusLink = mainTime?.closest('a[href*="/status/"]')?.getAttribute('href') || '';
  const quoteStatusLinks = [...article.querySelectorAll('a[href*="/status/"]')]
    .filter((link) => !mainTime || !link.contains(mainTime))
    .filter((link) => link.getAttribute('href') !== mainStatusLink)
    .filter((link) => !/\/photo\//.test(link.getAttribute('href') || ''));

  const candidates = new Set();
  for (const link of quoteStatusLinks) {
    const root = shrinkToQuotedRoot(article, link);
    if (root) candidates.add(root);
  }

  const ranked = [...candidates]
    .filter((node) => node.getBoundingClientRect().height > 24)
    .sort((a, b) => scoreQuotedRoot(b) - scoreQuotedRoot(a) || a.getBoundingClientRect().height - b.getBoundingClientRect().height);
  return ranked[0] || null;
}

function findTextAnchoredQuotedTweetRoot(article, allTextNodes) {
  if (allTextNodes.length <= 1) return null;
  const mainText = allTextNodes[0];
  const quoteText = allTextNodes[1];
  let best = null;
  let node = quoteText;

  while (node && node !== article) {
    const parent = node.parentElement;
    if (!parent || parent === article || parent.contains(mainText)) break;

    const rect = parent.getBoundingClientRect?.();
    const hasQuoteSignals = parent.querySelector?.('a[href*="/status/"], time, [data-testid="tweetPhoto"], img[src*="pbs.twimg.com/media/"]');
    if (rect && rect.height >= 24 && hasQuoteSignals) best = parent;
    node = parent;
  }

  if (!best) return findFallbackQuotedTweetRoot(article, allTextNodes);
  const clickable = best.closest('div[role="link"], div[tabindex="0"], a[role="link"]');
  if (clickable && article.contains(clickable) && !clickable.contains(mainText)) return clickable;
  return best;
}

function shrinkToQuotedRoot(article, anchor) {
  const mainText = article.querySelector('[data-testid="tweetText"]');
  let best = null;
  let node = anchor;
  while (node && node !== article) {
    const parent = node.parentElement;
    if (!parent || parent === article || parent.contains(mainText)) break;
    const hasSignals = parent.querySelector?.('[data-testid="tweetText"], time, a[href*="/status/"], [data-testid="tweetPhoto"], img[src*="pbs.twimg.com/media/"]');
    if (hasSignals) best = parent;
    node = parent;
  }
  return best;
}

function scoreQuotedRoot(node) {
  let score = 0;
  if (node.querySelector('a[href*="/status/"], time')) score += 4;
  if (node.querySelector('[data-testid="tweetText"]')) score += 3;
  if ((node.textContent || '').includes('@')) score += 1;
  const style = getComputedStyle(node);
  if (style.borderTopWidth !== '0px' || style.borderLeftWidth !== '0px') score += 1;
  return score;
}

function extractQuotedTweet(root) {
  const linkNode = root.matches('a[href*="/status/"]') ? root : root.querySelector('a[href*="/status/"]');
  const link = linkNode?.getAttribute('href') || '';
  const handle = extractHandle(root);
  const authorName = extractAuthorName(root, handle);
  const textNodes = [...root.querySelectorAll('[data-testid="tweetText"]')];
  const text = textNodes.map(normalizeTweetText).filter(Boolean).join('\n\n');
  const links = extractTextLinks(textNodes);
  const media = extractTweetMedia(root);
  if (!text && !handle && !media.length && !link) return null;
  return {
    statusId: link ? getStatusId(link) : null,
    url: link ? new URL(link, location.origin).toString() : '',
    authorName,
    handle,
    text: text || '[text unavailable]',
    links,
    media: cleanMediaItems(media).map((item) => ({ ...item, owner: 'original' }))
  };
}

function findFallbackQuotedTweetRoot(article, allTextNodes) {
  if (allTextNodes.length <= 1) return null;
  const mainText = allTextNodes[0];
  const quoteText = allTextNodes[1];
  let node = quoteText;
  let best = quoteText;

  while (node && node !== article) {
    const parent = node.parentElement;
    if (!parent || parent === article || parent.contains(mainText)) break;
    best = parent;
    node = parent;
  }

  const clickable = best.closest('div[role="link"], div[tabindex="0"], a[role="link"]');
  if (clickable && article.contains(clickable) && !clickable.contains(mainText)) return clickable;
  return best === quoteText ? null : best;
}

function extractQuotedTweetFromArticle(article, quoteRoot, allTextNodes, mainTextNodes) {
  if (quoteRoot) return extractQuotedTweet(quoteRoot);

  const mainSet = new Set(mainTextNodes);
  const quoteTextNodes = allTextNodes.filter((node) => !mainSet.has(node));
  if (!quoteTextNodes.length && allTextNodes.length <= 1) return null;

  const fallbackTextNodes = quoteTextNodes.length ? quoteTextNodes : allTextNodes.slice(1);
  const text = fallbackTextNodes.map(normalizeTweetText).filter(Boolean).join('\n\n');
  const links = extractTextLinks(fallbackTextNodes);
  if (!text && !links.length) return null;

  const firstQuoteText = fallbackTextNodes[0];
  const quoteContainer = firstQuoteText?.closest('div[role="link"], div[tabindex="0"], a[role="link"], div');
  const linkNode = quoteContainer?.querySelector?.('a[href*="/status/"]') || null;
  const link = linkNode?.getAttribute('href') || '';
  const handle = quoteContainer ? extractHandle(quoteContainer) : '';
  const authorName = quoteContainer ? extractAuthorName(quoteContainer, handle) : '';
  const media = quoteContainer ? extractTweetMedia(quoteContainer) : [];

  return {
    statusId: link ? getStatusId(link) : null,
    url: link ? new URL(link, location.origin).toString() : '',
    authorName,
    handle,
    text: text || '[text unavailable]',
    links,
    media: cleanMediaItems(media).map((item) => ({ ...item, owner: 'original' })),
    fallback: true
  };
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

function extractHandle(article, excludeRoot = null) {
  const handleNode = [...article.querySelectorAll('a[role="link"] span, span')]
    .filter((span) => !excludeRoot?.contains(span))
    .find((span) => /^@\w+/.test((span.textContent || '').trim()));
  return handleNode ? handleNode.textContent.trim() : '';
}

function extractAuthorName(article, handle, excludeRoot = null) {
  const userLink = [...article.querySelectorAll('a[role="link"], div[role="link"]')]
    .filter((a) => !excludeRoot?.contains(a))
    .find((a) => handle && (a.textContent || '').includes(handle));
  if (!userLink) return '';
  const first = [...userLink.querySelectorAll('span')]
    .map((span) => span.textContent.trim())
    .find((text) => text && text !== handle && !text.startsWith('@'));
  return first || '';
}

function extractTextLinks(textNodes) {
  const seen = new Set();
  const links = [];
  for (const node of textNodes || []) {
    for (const anchor of node.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href') || '';
      const visible = anchor.getAttribute('title') || anchor.getAttribute('aria-label') || anchor.dataset?.expandedUrl || anchor.textContent || '';
      const link = normalizeTweetLink(href, visible);
      if (!link || seen.has(link.url)) continue;
      seen.add(link.url);
      links.push(link);
    }
  }
  return links;
}

function normalizeTweetLink(href, visibleText) {
  try {
    const hrefUrl = new URL(href, location.origin);
    if (hrefUrl.pathname.includes('/photo/') || hrefUrl.pathname.includes('/video/')) return null;
    const text = String(visibleText || '').replace(/\s+/g, ' ').trim();
    const isStatus = /\/status\/\d+/.test(hrefUrl.pathname);
    if (hrefUrl.hostname.endsWith('twitter.com') || hrefUrl.hostname.endsWith('x.com')) {
      if (isStatus) return null;
      if (hrefUrl.pathname === '/' || /^\/[^/]+$/.test(hrefUrl.pathname)) return null;
    }

    let finalUrl = hrefUrl;
    if (/^https?:\/\//i.test(text)) {
      try { finalUrl = new URL(text); } catch { finalUrl = hrefUrl; }
    }

    const shortUrl = hrefUrl.hostname === 't.co' && finalUrl.toString() !== hrefUrl.toString() ? hrefUrl.toString() : '';
    const label = text && !/^https?:\/\//i.test(text) ? text : finalUrl.toString();
    return {
      url: finalUrl.toString(),
      shortUrl,
      text: label,
      display: label !== finalUrl.toString() ? `${label} → ${finalUrl.toString()}` : finalUrl.toString()
    };
  } catch {
    return null;
  }
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
