const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function buildThread() {
  return {
    authorHandle: '@alice',
    authorName: 'Alice',
    sourceUrl: 'https://x.com/alice/status/100',
    capturedAt: '2026-06-01T00:00:00.000Z',
    tweets: [{
      index: 1,
      statusId: '100',
      handle: '@alice',
      authorName: 'Alice',
      text: 'Two attached images',
      time: '2026-06-01T00:00:00.000Z',
      links: [],
      media: [
        { type: 'image', dataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', alt: 'first image' },
        { type: 'image', dataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', alt: 'second image' }
      ]
    }],
    additionalTweets: []
  };
}

async function loadCapturePage(thread) {
  const html = fs.readFileSync('capture.html', 'utf8').replace('<script src="capture.js"></script>', '');
  const dom = new JSDOM(html, {
    url: 'https://example.test/capture.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  dom.window.browser = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === 'X_THREAD_CAPTURE_GET_SETTINGS') return { ok: true, settings: null };
        if (message.type === 'X_THREAD_CAPTURE_GET') return { ok: true, thread };
        return { ok: true };
      }
    }
  };
  dom.window.eval(fs.readFileSync('capture.js', 'utf8'));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  return dom;
}

test('capture page renders multiple attached images sequentially instead of as a grid', async () => {
  const dom = await loadCapturePage(buildThread());

  const mediaContainer = dom.window.document.querySelector('.mediaStack');
  const figures = [...dom.window.document.querySelectorAll('.mediaFigure')];
  const tweetAuthor = dom.window.document.querySelector('.tweetAuthor');

  assert.ok(mediaContainer, 'expected multi-image media to use the sequential mediaStack container');
  assert.equal(dom.window.document.querySelector('.mediaGrid'), null);
  assert.equal(dom.window.document.querySelector('.mediaOwnerBadge'), null);
  assert.equal(dom.window.document.querySelector('figcaption'), null);
  assert.equal(tweetAuthor.textContent.trim(), 'Alice @alice');
  assert.deepEqual(figures.map((figure) => figure.querySelector('img').alt), ['first image', 'second image']);
});
