/* global suite, test, teardown */
'use strict';

// The chunk timeline (featrues/14-bug-placement/bug.md): the word spans of
// every chunk are timed on the chunk's own clock and the word cursor stays
// inside the chunk being played, so a burst of cached chunks — which used
// to arrive with no length at all — followed by a click into a later block
// and any re-render keeps the spoken word in the block that carries the
// pills. The screenshot in the report: pills on the numbered list, the
// word painted in the bullet list above it.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const CORE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud-core.js'),
  'utf8',
);
const APP = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud.js'),
  'utf8',
);

const UL_A =
  'Preload everything. Root instruction file links to every spec, plan, and ADR.';
const UL_B = 'Remove the docs. The agent sees only code and misses intent.';
const P1 = 'The fix is neither. It is deferral.';
const H1 = '1. Principles';
const OL_1 =
  'The root instruction file is a router, not a library. Target under 200 lines.';
const OL_2 = 'Nothing bulky loads at launch. Imports expand in full.';

const FIXTURE =
  '<h2 id="h0">0. The problem</h2>' +
  '<ul id="ul">\n<li id="li-a"><strong>Preload everything.</strong> Root instruction file links to every spec, plan, and ADR.</li>\n' +
  '<li id="li-b"><strong>Remove the docs.</strong> The agent sees only code and misses intent.</li>\n</ul>' +
  '<p id="p1">The fix is neither. It is <strong>deferral</strong>.</p>' +
  '<h2 id="h1">1. Principles</h2>' +
  '<ol id="ol">\n<li id="li-1"><strong>The root instruction file is a router, not a library.</strong> Target under 200 lines.</li>\n' +
  '<li id="li-2"><strong>Nothing bulky loads at launch.</strong> Imports expand in full.</li>\n</ol>';

const PREVIEW =
  '<!doctype html><html><body class="preview-container">' +
  '<div id="crossnote-data" data-config=\'{"sourceUri":"file:///doc.md"}\'></div>' +
  '<div class="crossnote markdown-preview" data-for="preview">' +
  FIXTURE +
  '</div></body></html>';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whitespace words of `text` as host spans on the chunk's own clock. */
function spansOf(text, base) {
  const out = [];
  const re = /\S+/g;
  let match = re.exec(text);
  let t = 0;
  while (match) {
    out.push({
      text: match[0],
      charStart: base + match.index,
      charEnd: base + match.index + match[0].length,
      start: t,
      end: t + 0.5,
    });
    t += 0.5;
    match = re.exec(text);
  }
  return out;
}

suite('read-aloud chunk timeline (14)', function () {
  this.timeout(20000);

  let dom;
  let win;
  let doc;
  let posted;
  let audios;
  let logs;

  function boot() {
    posted = [];
    audios = [];
    logs = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => {
      logs.push('jsdomError: ' + (error.stack || error.message));
    });
    for (const level of ['warn', 'error']) {
      virtualConsole.on(level, (...args) =>
        logs.push(level + ': ' + args.join(' ')),
      );
    }
    dom = new JSDOM(PREVIEW, {
      pretendToBeVisual: true,
      runScripts: 'outside-only',
      virtualConsole,
    });
    win = dom.window;
    doc = win.document;
    win.acquireVsCodeApi = function () {
      return { postMessage: (message) => posted.push(message) };
    };
    let blobs = 0;
    win.URL.createObjectURL = () => 'blob:fake-' + ++blobs;
    win.URL.revokeObjectURL = () => {};
    win.Element.prototype.scrollIntoView = function () {};
    win.scrollTo = function () {};
    // The pool elements: a duration only once `loadedmetadata` is fired by
    // a test, as in the browser; cached chunks arrive before that.
    class FakeAudio extends win.EventTarget {
      constructor() {
        super();
        this._src = '';
        this.currentTime = 0;
        this.duration = NaN;
        this.volume = 1;
        this.paused = true;
        audios.push(this);
      }
      get src() {
        return this._src;
      }
      set src(value) {
        this._src = value;
        this.paused = true;
        this.currentTime = 0;
      }
      play() {
        this.paused = false;
        return Promise.resolve();
      }
      pause() {
        this.paused = true;
      }
      load() {
        this.paused = true;
      }
      removeAttribute(name) {
        if (name === 'src') {
          this._src = '';
        }
      }
    }
    win.Audio = FakeAudio;
    win.eval(CORE);
    win.eval(APP);
  }

  function host(message) {
    win.dispatchEvent(new win.MessageEvent('message', { data: message }));
  }

  function lastRequest() {
    return posted.filter((m) => m.command === 'readAloudSynthesize').pop();
  }

  /** A cached chunk: the host's message for a hit carried no durationHint. */
  function sendChunk(request, index, count, blockIndex, chunkText, hint) {
    const text = request.args[2];
    const block = request.args[3].blocks[blockIndex];
    const base = text.indexOf(chunkText, block.start);
    assert.ok(base >= 0 && base < block.end, 'chunk text in its block');
    host({
      command: 'readAloudAudio',
      requestId: request.args[1],
      chunkIndex: index,
      chunkCount: count,
      blockIndex,
      audioBase64: 'QUJD',
      mimeType: 'audio/mpeg',
      spans: spansOf(chunkText, base),
      ...(hint === undefined ? {} : { durationHint: hint }),
    });
  }

  function clickWord(el, node, offset) {
    doc.caretRangeFromPoint = function () {
      const range = doc.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      return range;
    };
    const init = { bubbles: true, cancelable: true, button: 0 };
    el.dispatchEvent(new win.MouseEvent('mousedown', init));
    el.dispatchEvent(new win.MouseEvent('click', init));
  }

  function playingAudio() {
    return audios.filter((a) => !a.paused && /^blob:/.test(a.src)).pop();
  }

  function wordIn() {
    return Array.from(doc.querySelectorAll('.mpe-ra-word')).map(
      (s) => s.closest('li').id + ':' + s.textContent,
    );
  }

  function readingIds() {
    return Array.from(doc.querySelectorAll('.mpe-ra-reading')).map(
      (el) => el.id,
    );
  }

  function timeTitle() {
    return doc.querySelector('.mpe-ra-bar-progress').getAttribute('title');
  }

  /**
   * The report's sequence with every chunk cached: click the first bullet,
   * the whole read arrives at once with no lengths, pause, click the first
   * numbered item — a seek into a chunk that is already there.
   */
  async function burstAndSeek() {
    const strongA = doc.querySelector('#li-a strong');
    clickWord(strongA, strongA.firstChild, 0);
    await sleep(320);
    const request = lastRequest();
    assert.ok(request, 'the click started a read');
    const N = 6;
    sendChunk(request, 0, N, 0, UL_A);
    sendChunk(request, 1, N, 0, UL_B);
    sendChunk(request, 2, N, 1, P1);
    sendChunk(request, 3, N, 2, H1);
    sendChunk(request, 4, N, 3, OL_1);
    sendChunk(request, 5, N, 3, OL_2);
    await sleep(40);
    const first = playingAudio();
    assert.ok(first, 'chunk 0 plays');
    first.currentTime = 1.2;
    await sleep(60);
    assert.deepStrictEqual(wordIn(), ['li-a:Root']);
    doc
      .querySelector('.mpe-ra-bar [data-mpe-ra-action="play"]')
      .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const strong1 = doc.querySelector('#li-1 strong');
    clickWord(strong1, strong1.firstChild, 4);
    await sleep(320);
    assert.strictEqual(
      posted.filter((m) => m.command === 'readAloudSynthesize').length,
      1,
      'a seek, not a new read',
    );
    assert.deepStrictEqual(readingIds(), ['ol']);
    return request;
  }

  teardown(function () {
    if (dom) {
      dom.window.close();
      dom = null;
    }
  });

  test('a seek into a cached later chunk paints in that block, and keeps doing so through a re-decorate', async function () {
    boot();
    await sleep(60);
    await burstAndSeek();
    const audio = playingAudio();
    assert.ok(audio, 'the list chunk plays');
    assert.deepStrictEqual(wordIn(), ['li-1:root']);
    audio.currentTime = 4.4;
    await sleep(60);
    assert.deepStrictEqual(wordIn(), ['li-1:a']);

    // Something else touches the document — the sidebar TOC's highlight, a
    // crossnote re-render — and the player re-decorates and rebinds.
    const stray = doc.createElement('span');
    stray.textContent = ' (toc highlight)';
    doc.getElementById('h0').appendChild(stray);
    await sleep(120);
    assert.deepStrictEqual(readingIds(), ['ol'], 'the pills stay');
    assert.deepStrictEqual(wordIn(), ['li-1:a'], 'the word stays with them');
    audio.currentTime = 4.6;
    await sleep(60);
    assert.deepStrictEqual(wordIn(), ['li-1:library.']);

    // A full re-render with the same content: the same.
    doc.querySelector('.markdown-preview').innerHTML = FIXTURE;
    await sleep(120);
    audio.currentTime = 5.1;
    await sleep(60);
    assert.deepStrictEqual(readingIds(), ['ol']);
    assert.deepStrictEqual(wordIn(), ['li-1:Target']);
    assert.deepStrictEqual(logs, []);
  });

  test('a paused skip lands in the right chunk, and a chunk hand-off starts at the next chunk’s first word', async function () {
    boot();
    await sleep(60);
    await burstAndSeek();
    const audio = playingAudio();
    // The lengths arrive as the audio loads, in any order.
    audio.duration = 10;
    audio.dispatchEvent(new win.Event('loadedmetadata'));
    audio.currentTime = 6;
    await sleep(60);
    doc
      .querySelector('.mpe-ra-bar [data-mpe-ra-action="play"]')
      .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    // −10 s from 6 s into the list's first chunk: back to its top, still
    // inside the numbered list.
    doc
      .querySelector('.mpe-ra-bar [data-mpe-ra-action="back10"]')
      .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert.deepStrictEqual(wordIn(), ['li-1:The']);
    // Resume, and let the chunk end: the next chunk's own clock starts at 0.
    doc
      .querySelector('.mpe-ra-bar [data-mpe-ra-action="play"]')
      .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const current = playingAudio();
    current.paused = true;
    current.dispatchEvent(new win.Event('ended'));
    await sleep(60);
    const next = playingAudio();
    assert.ok(next && next !== current, 'the next chunk plays');
    next.currentTime = 0.1;
    await sleep(60);
    assert.deepStrictEqual(wordIn(), ['li-2:Nothing']);
    assert.deepStrictEqual(logs, []);
  });

  test('the time display sums the lengths that are known', async function () {
    boot();
    await sleep(60);
    const strongA = doc.querySelector('#li-a strong');
    clickWord(strongA, strongA.firstChild, 0);
    await sleep(320);
    const request = lastRequest();
    sendChunk(request, 0, 3, 0, UL_A, 7);
    sendChunk(request, 1, 3, 0, UL_B);
    sendChunk(request, 2, 3, 1, P1, 4);
    await sleep(40);
    const first = playingAudio();
    first.currentTime = 2;
    await sleep(60);
    assert.strictEqual(
      timeTitle(),
      '0:02 / 0:11',
      'hints count, a missing one does not',
    );
    // The second chunk's audio loads: its length joins the total at once.
    const second = audios.find((a) => a !== first && /^blob:/.test(a.src));
    second.duration = 5;
    second.dispatchEvent(new win.Event('loadedmetadata'));
    await sleep(40);
    assert.strictEqual(timeTitle(), '0:02 / 0:16');
  });
});
