const MAX_SCROLL_PASSES = 48;
const SCROLL_DELAY_MS = 750;

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'X_THREAD_CAPTURE_PING') {
    return Promise.resolve({ ok: true, extractorLoaded: Boolean(findThreadExtractor()) });
  }

  if (message?.type === 'X_THREAD_CAPTURE_COLLECT') {
    return collectThread()
      .then((thread) => ({ ok: true, thread }))
      .catch((error) => ({ ok: false, error: error.message }));
  }

  return false;
});

async function collectThread() {
  const extractor = findThreadExtractor();
  if (!extractor) throw new Error('Thread extractor is not loaded.');

  const statusId = extractor.getStatusId(location.href);
  if (!statusId) throw new Error('This is not a specific tweet/status page.');

  await settlePage();
  const accumulated = new Map();
  extractor.mergeTweets(accumulated, extractor.extractVisibleTweets());

  const firstPass = [...accumulated.values()];
  const target = firstPass.find((tweet) => tweet.statusId === statusId) || firstPass[0];
  if (!target) throw new Error('Could not find tweet articles on this page. Try reloading the X page first.');

  const authorHandle = target.handle;
  const seenMarkers = new Set();
  let stablePasses = 0;
  let lastTop = -1;
  let stoppedReason = 'max-scroll-passes';
  let passes = 0;

  for (let i = 0; i < MAX_SCROLL_PASSES; i += 1) {
    passes = i + 1;
    extractor.mergeTweets(accumulated, extractor.extractVisibleTweets());

    const scroller = document.scrollingElement;
    const beforeTop = scroller.scrollTop;
    const beforeHeight = scroller.scrollHeight;
    const nextTop = Math.min(beforeTop + Math.max(500, Math.floor(window.innerHeight * 0.85)), beforeHeight);

    window.scrollTo({ top: nextTop, behavior: 'auto' });
    await delay(SCROLL_DELAY_MS);
    await waitForVisibleTweetImages();
    extractor.mergeTweets(accumulated, extractor.extractVisibleTweets());

    const afterTop = scroller.scrollTop;
    const afterHeight = scroller.scrollHeight;
    const visibleCount = document.querySelectorAll('article[data-testid="tweet"]').length;
    const marker = `${Math.round(afterTop)}:${afterHeight}:${visibleCount}:${accumulated.size}`;

    if (seenMarkers.has(marker) || (Math.abs(afterTop - lastTop) < 4 && afterHeight === beforeHeight)) stablePasses += 1;
    else stablePasses = 0;

    seenMarkers.add(marker);
    lastTop = afterTop;
    if (stablePasses >= 4) {
      stoppedReason = 'stable-scroll-position';
      break;
    }
  }

  extractor.mergeTweets(accumulated, extractor.extractVisibleTweets());

  window.scrollTo({ top: 0, behavior: 'auto' });
  await delay(150);

  const all = [...accumulated.values()];
  const threadData = extractor.pickThreadData(all, statusId, authorHandle);
  if (!threadData.tweets.length) throw new Error('Found tweets, but could not isolate the thread.');

  return {
    sourceUrl: location.href,
    rootStatusId: statusId,
    authorHandle,
    authorName: target.authorName || '',
    capturedAt: new Date().toISOString(),
    collectionMeta: {
      scrollPasses: passes,
      visibleArticleCount: document.querySelectorAll('article[data-testid="tweet"]').length,
      collectedTweetCount: all.length,
      stoppedReason,
      mediaFetchFailures: 0
    },
    tweets: threadData.tweets,
    additionalTweets: threadData.additionalTweets
  };
}

function findThreadExtractor() {
  return globalThis.XThreadCaptureExtractor || window.XThreadCaptureExtractor || null;
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
