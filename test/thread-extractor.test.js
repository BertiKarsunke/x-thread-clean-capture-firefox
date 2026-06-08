const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const extractor = require('../thread-extractor');

test('thread extractor exposes the api on window when Firefox provides a separate window object', () => {
  const context = {
    module: { exports: {} },
    window: {},
    document: { createTextNode() {} },
    location: { href: 'https://x.com/alice/status/100', origin: 'https://x.com' },
    scrollY: 0,
    getComputedStyle: () => ({ borderTopWidth: '0px', borderLeftWidth: '0px' })
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('thread-extractor.js', 'utf8'), context);

  assert.equal(typeof context.XThreadCaptureExtractor.articleToTweet, 'function');
  assert.equal(typeof context.window.XThreadCaptureExtractor.articleToTweet, 'function');
});

function mount(html) {
  const dom = new JSDOM(html, { url: 'https://x.com/alice/status/100' });
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.scrollY = 0;
  global.getComputedStyle = () => ({ borderTopWidth: '1px', borderLeftWidth: '1px' });
  dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const top = Number(this.getAttribute('data-top') || 0);
    const height = Number(this.getAttribute('data-height') || 80);
    return { top, bottom: top + height, height, width: 400 };
  };
  return dom.window.document.querySelector('article[data-testid="tweet"]');
}

test('articleToTweet does not create a quoted tweet when extra tweetText has no status link', () => {
  const article = mount(`
    <article data-testid="tweet" data-top="10">
      <a role="link" href="/alice/status/100"><span>Alice</span><span>@alice</span><time datetime="2026-06-01T00:00:00.000Z"></time></a>
      <div data-testid="tweetText">Main point</div>
      <div data-testid="tweetText">Follow-up text inside the same article</div>
    </article>
  `);

  const tweet = extractor.articleToTweet(article);

  assert.equal(tweet.statusId, '100');
  assert.equal(tweet.quotedTweet, null);
  assert.equal(tweet.text, 'Main point\n\nFollow-up text inside the same article');
});

test('articleToTweet does not treat status subpage links as quoted tweets', () => {
  const article = mount(`
    <article data-testid="tweet" data-top="10">
      <a role="link" href="/alice/status/100"><span>Alice</span><span>@alice</span><time datetime="2026-06-01T00:00:00.000Z"></time></a>
      <div data-testid="tweetText">Main point</div>
      <div role="link" tabindex="0" data-top="160" data-height="120">
        <a role="link" href="/alice/status/2063186008187994616/quotes">quotes</a>
        <a role="link" href="/alice/status/2063264472018604125/analytics">analytics</a>
        <div data-testid="tweetText">Metrics and quote controls, not a quoted tweet</div>
      </div>
    </article>
  `);

  const tweet = extractor.articleToTweet(article);

  assert.equal(tweet.quotedTweet, null);
  assert.equal(extractor.getStatusId('/alice/status/2063186008187994616/quotes'), null);
  assert.equal(extractor.getStatusId('/alice/status/2063264472018604125/analytics'), null);
});

test('articleToTweet ignores X hashtag navigation links expanded from t.co', () => {
  const article = mount(`
    <article data-testid="tweet" data-top="10">
      <a role="link" href="/alice/status/100"><span>Alice</span><span>@alice</span><time datetime="2026-06-01T00:00:00.000Z"></time></a>
      <div data-testid="tweetText">
        <span>Main point</span>
        <a role="link" href="https://t.co/abc123" title="https://x.com/hashtag">https://x.com/hashtag</a>
      </div>
    </article>
  `);

  const tweet = extractor.articleToTweet(article);

  assert.deepEqual(tweet.links, []);
  assert.equal(tweet.quotedTweet, null);
});

test('articleToTweet separates main quote media from original tweet media', () => {
  const article = mount(`
    <article data-testid="tweet" data-top="10" data-height="500">
      <a role="link" href="/alice/status/100"><span>Alice</span><span>@alice</span><time datetime="2026-06-01T00:00:00.000Z"></time></a>
      <div data-testid="tweetText">Commentary on a quoted post</div>
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/main.jpg?format=jpg" alt="main image"></div>
      <div role="link" tabindex="0" data-top="160" data-height="220">
        <a role="link" href="/bob/status/200"><span>Bob</span><span>@bob</span><time datetime="2026-06-01T00:01:00.000Z"></time></a>
        <div data-testid="tweetText">Original post</div>
        <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/original.jpg?format=jpg" alt="original image"></div>
      </div>
    </article>
  `);

  const tweet = extractor.articleToTweet(article);

  assert.equal(tweet.quotedTweet.statusId, '200');
  assert.deepEqual(tweet.media.map((item) => item.owner), ['quote']);
  assert.deepEqual(tweet.quotedTweet.media.map((item) => item.owner), ['original']);
  assert.match(tweet.media[0].url, /main\.jpg/);
  assert.match(tweet.quotedTweet.media[0].url, /original\.jpg/);
});

test('pickThreadData keeps same-author tweets primary and separates nearby replies', () => {
  const tweets = [
    { statusId: '100', handle: '@alice', text: 'root', time: '1', top: 10, media: [], links: [] },
    { statusId: '101', handle: '@alice', text: 'second', time: '2', top: 200, media: [], links: [] },
    { statusId: '300', handle: '@bob', text: 'reply', time: '3', top: 320, media: [], links: [] },
    { statusId: '102', handle: '@alice', text: 'third', time: '4', top: 500, media: [], links: [] }
  ];

  const thread = extractor.pickThreadData(tweets, '100', '@alice');

  assert.deepEqual(thread.tweets.map((tweet) => tweet.statusId), ['100', '101', '102']);
  assert.deepEqual(thread.additionalTweets.map((tweet) => tweet.statusId), ['300']);
});
