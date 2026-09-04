/* global suite, test, teardown */
'use strict';

// Follow-the-reading scroll (featrues/07-eye-strain-2/spec.md §7) under
// jsdom: the player with fake <audio> elements, a controllable
// requestAnimationFrame, a fake layout for the spoken word's rect and a
// window whose scrollTo is observed. The pure `followStep` is covered in
// page-typography.test.js; this suite drives the loop, the suspension, the
// chip and the re-engagement, and the help sheet's own container.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const core = require('../../media/read-aloud-core.js');

const CORE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud-core.js'),
  'utf8',
);
const APP = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud.js'),
  'utf8',
);

const FIXTURE =
  '<h2 id="h">Heading one</h2>' +
  '<p id="p1">First, hooks. Claude Code has them too, and they are broader than before.</p>' +
  '<p id="p2">Second, permission modes. The documented modes are default and plan.</p>' +
  '<p id="p3">Third, managed settings. These outrank everything else.</p>';

const PREVIEW =
  '<!doctype html><html><body class="preview-container">' +
  '<div id="crossnote-data" data-config=\'{"sourceUri":"file:///doc.md"}\'></div>' +
  '<div class="crossnote markdown-preview" data-for="preview">' +
  FIXTURE +
  '</div></body></html>';

const ANSWER_HTML =
  '<h3>What it says</h3>' +
  '<p>The change goes through the same gates as anyone else.</p>' +
  '<h3>Terms</h3>' +
  '<ul><li><strong>Maintainer</strong>: the person who reviews.</li></ul>';

const VIEWPORT = 768;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whitespace words of `text` as host word spans, 0.5 s each. */
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

suite('read-aloud follow-the-reading scroll (07 §7)', function () {
  this.timeout(20000);

  let dom;
  let win;
  let doc;
  let posted;
  let logs;
  let rafQueue;
  let scrollIntoViewCalls;
  /** Document position of the spoken word's top, in px. */
  let wordDocTop;
  let reduced;
  let helpBodyEl;

  function boot(options) {
    options = options || {};
    posted = [];
    logs = [];
    rafQueue = [];
    scrollIntoViewCalls = 0;
    wordDocTop = 700;
    reduced = !!options.reduced;
    helpBodyEl = null;
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => {
      logs.push('jsdomError: ' + (error.stack || error.message));
    });
    for (const level of ['debug', 'log', 'warn', 'error']) {
      virtualConsole.on(level, (...args) =>
        logs.push(level + ': ' + args.join(' ')),
      );
    }
    if (dom) {
      dom.window.close();
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
    win.Element.prototype.scrollIntoView = function () {
      scrollIntoViewCalls++;
    };
    // The window scrolls: the position is kept and a `scroll` event fires,
    // synchronously here where an engine would fire it a frame later.
    win.scrollY = 0;
    win.scrollTo = function (x, y) {
      win.scrollY = y;
      win.dispatchEvent(new win.Event('scroll'));
    };
    // The loop's frames are run by the tests.
    let rafId = 0;
    win.requestAnimationFrame = function (callback) {
      rafQueue.push({ id: ++rafId, callback });
      return rafId;
    };
    win.cancelAnimationFrame = function (id) {
      rafQueue = rafQueue.filter((entry) => entry.id !== id);
    };
    // The fake layout: the spoken word sits at `wordDocTop` in its scroll
    // container's content, everything else has no box.
    win.Element.prototype.getBoundingClientRect = function () {
      if (this.classList && this.classList.contains('mpe-ra-word')) {
        const inSheet = helpBodyEl && helpBodyEl.contains(this);
        const top = wordDocTop - (inSheet ? helpBodyEl.scrollTop : win.scrollY);
        return {
          top,
          bottom: top + 20,
          left: 10,
          right: 60,
          width: 50,
          height: 20,
        };
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    };
    win.matchMedia = (query) => ({
      media: query,
      get matches() {
        return /reduced-motion/.test(query) ? reduced : false;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
    class FakeAudio extends win.EventTarget {
      constructor() {
        super();
        this._src = '';
        this.currentTime = 0;
        this.duration = 30;
        this.playbackRate = 1;
        this.preservesPitch = true;
        this.volume = 1;
        this.paused = true;
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

  /** Run every frame callback queued so far, once. */
  function frame() {
    const pending = rafQueue;
    rafQueue = [];
    for (const entry of pending) {
      entry.callback(Date.now());
    }
  }

  function frames(n) {
    for (let i = 0; i < n; i++) {
      frame();
    }
  }

  function host(message) {
    win.dispatchEvent(new win.MessageEvent('message', { data: message }));
  }

  function click(element) {
    element.dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  }

  function lastSynthesize() {
    return posted.filter((m) => m.command === 'readAloudSynthesize').pop();
  }

  function sendChunk(request, index, count, blockIndex, chunkText) {
    const text = request.args[2];
    const block = request.args[3].blocks[blockIndex];
    const base = text.indexOf(chunkText, block.start);
    assert.ok(base >= 0, 'chunk text is in its block');
    host({
      command: 'readAloudAudio',
      requestId: request.args[1],
      chunkIndex: index,
      chunkCount: count,
      blockIndex,
      audioBase64: 'QUJD',
      mimeType: 'audio/mpeg',
      spans: spansOf(chunkText, base),
      durationHint: 30,
    });
  }

  function chip() {
    return doc.querySelector('.mpe-ra-bar-chip');
  }

  function playButton() {
    return doc.querySelector('.mpe-ra-bar-play');
  }

  /**
   * A read of p1 with its first chunk playing; the first frame the test runs
   * paints the first word and takes the first follow step.
   */
  async function startReadOnP1() {
    click(doc.querySelector('#p1 .mpe-ra-btn'));
    const request = lastSynthesize();
    assert.ok(request, 'a read was requested; logs: ' + logs.join('\n'));
    sendChunk(request, 0, 1, 0, 'First, hooks.');
    await sleep(20);
    return request;
  }

  const TARGET = 700 - core.FOLLOW_ANCHOR * VIEWPORT;

  teardown(function () {
    if (dom) {
      dom.window.close();
      dom = null;
    }
  });

  test('while playing, the loop eases the page so the word’s top sits at the anchor, in small steps, with no scrollIntoView', async function () {
    boot();
    await sleep(60);
    // crossnote's preview root computes `overflow-y: auto` without ever
    // scrolling; the container is still the window (07 §7.6).
    doc.querySelector('.markdown-preview').style.overflowY = 'auto';
    await startReadOnP1();
    assert.strictEqual(win.scrollY, 0);
    const positions = [];
    for (let i = 0; i < 70; i++) {
      frame();
      if (i === 0) {
        assert.ok(doc.querySelector('.mpe-ra-word'), 'a word is painted');
      }
      positions.push(win.scrollY);
    }
    // The first step is 12 % of the way; every step is smaller than the
    // last and none is more than 0.3 of the viewport; the page settles on
    // the target within about a second of frames.
    assert.ok(
      Math.abs(positions[0] - TARGET * 0.12) < 1e-6,
      String(positions[0]),
    );
    for (let i = 1; i < positions.length; i++) {
      const step = positions[i] - positions[i - 1];
      assert.ok(step >= 0, 'never back');
      assert.ok(step <= 0.3 * VIEWPORT, 'no lurch');
      if (i >= 2) {
        // Each step is smaller than the last, except the settle: once the
        // next step would leave under FOLLOW_SETTLE_PX the loop lands on the
        // target, a step of at most settlePx / (1 − ease).
        const previous = positions[i - 1] - positions[i - 2];
        assert.ok(
          step <= previous + 1e-9 ||
            step <= core.FOLLOW_SETTLE_PX / (1 - core.FOLLOW_EASE) + 1e-9,
          `step ${i}: ${step} > ${previous}`,
        );
      }
    }
    assert.ok(Math.abs(win.scrollY - TARGET) < 1e-6, String(win.scrollY));
    assert.strictEqual(scrollIntoViewCalls, 0);
    // Settled: the word is in the band and nothing more is written.
    const settled = win.scrollY;
    frames(5);
    assert.strictEqual(win.scrollY, settled);
    assert.strictEqual(chip().hidden, true, 'no chip while following');
  });

  test('the loop writes only while playing: a pause stops it, and resume re-engages', async function () {
    boot();
    await sleep(60);
    await startReadOnP1();
    frames(3);
    const before = win.scrollY;
    assert.ok(before > 0);
    click(playButton());
    assert.strictEqual(playButton().getAttribute('data-state'), 'paused');
    frames(10);
    assert.strictEqual(win.scrollY, before, 'paused: no scrolling');
    // A wheel while paused suspends; play from paused re-engages (07 §7.4).
    win.dispatchEvent(new win.Event('wheel'));
    click(playButton());
    assert.strictEqual(playButton().getAttribute('data-state'), 'playing');
    assert.strictEqual(chip().hidden, true, 'resume re-engaged the following');
    frames(3);
    assert.ok(win.scrollY > before, 'and the ease resumed');
  });

  test('a wheel suspends the following for good; the chip shows and its click re-engages', async function () {
    boot();
    await sleep(60);
    await startReadOnP1();
    frames(3);
    const before = win.scrollY;
    win.dispatchEvent(new win.Event('wheel'));
    frames(20);
    assert.strictEqual(win.scrollY, before, 'no further writes');
    assert.strictEqual(chip().hidden, false, 'the chip is in the status slot');
    assert.strictEqual(chip().textContent, 'Back to the reading');
    assert.strictEqual(chip().getAttribute('data-mpe-ra-action'), 'follow');
    await sleep(50);
    assert.strictEqual(win.scrollY, before, 'and no 3 s auto-resume');
    click(chip());
    assert.strictEqual(chip().hidden, true);
    frames(3);
    assert.ok(win.scrollY > before, 'the ease resumed from the chip');
  });

  test('a scrolling key outside a form control suspends; one in the panel or an input does not', async function () {
    boot();
    await sleep(60);
    await startReadOnP1();
    frames(2);
    const bar = doc.querySelector('.mpe-ra-bar');
    // Space on the panel plays/pauses; it is not a scroll.
    bar.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    assert.strictEqual(chip().hidden, true);
    // A key in the help question box is typing.
    const input = doc.querySelector('.mpe-ra-help-input');
    input.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: ' ', bubbles: true }),
    );
    assert.strictEqual(chip().hidden, true);
    // PageDown on the document scrolls it.
    doc.body.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }),
    );
    assert.strictEqual(chip().hidden, false, 'suspended');
  });

  test('a scroll that brings the word back inside the band re-engages silently; one at the loop’s own position never suspends', async function () {
    boot();
    await sleep(60);
    await startReadOnP1();
    frames(3);
    win.dispatchEvent(new win.Event('wheel'));
    assert.strictEqual(chip().hidden, false);
    // The reader scrolls somewhere else: still suspended.
    win.scrollY = 100;
    win.dispatchEvent(new win.Event('scroll'));
    assert.strictEqual(chip().hidden, false);
    // Then to where the word sits inside the band (0.34–0.42 of 768).
    win.scrollY = 700 - 0.38 * VIEWPORT;
    win.dispatchEvent(new win.Event('scroll'));
    assert.strictEqual(chip().hidden, true, 're-engaged');
    // Following again: the loop's own writes fire `scroll` events (the
    // fake fires them synchronously) and none of them suspends it.
    wordDocTop = 1200;
    frames(10);
    assert.strictEqual(chip().hidden, true);
    assert.ok(win.scrollY > 700 - 0.38 * VIEWPORT);
    // A late `scroll` at the position the loop wrote is its own too.
    win.dispatchEvent(new win.Event('scroll'));
    assert.strictEqual(chip().hidden, true);
    // A scroll 3 px away is somebody else's.
    win.scrollY += 3;
    win.dispatchEvent(new win.Event('scroll'));
    assert.strictEqual(chip().hidden, false);
  });

  test('under prefers-reduced-motion the page jumps to the anchor in one frame', async function () {
    boot({ reduced: true });
    await sleep(60);
    await startReadOnP1();
    frame();
    assert.strictEqual(win.scrollY, TARGET);
    frames(3);
    assert.strictEqual(win.scrollY, TARGET);
  });

  test('a new read from a click on a word re-engages, and a skip too', async function () {
    boot();
    await sleep(60);
    const request = await startReadOnP1();
    frames(2);
    win.dispatchEvent(new win.Event('wheel'));
    assert.strictEqual(chip().hidden, false);
    // +10 s inside the 30 s chunk.
    const forward = doc.querySelector('.mpe-ra-bar-forward10');
    assert.strictEqual(forward.disabled, false);
    click(forward);
    assert.strictEqual(chip().hidden, true, 'a skip re-engages');
    win.dispatchEvent(new win.Event('wheel'));
    assert.strictEqual(chip().hidden, false);
    // A new read (Alt+Space with nothing loaded would be the same path).
    click(doc.querySelector('#p2 .mpe-ra-btn'));
    assert.notStrictEqual(lastSynthesize(), request);
    assert.strictEqual(chip().hidden, true, 'a new read re-engages');
  });

  test('a help read follows inside the sheet body, and a wheel over the sheet suspends it there', async function () {
    boot();
    await sleep(60);
    host({
      command: 'readAloudConfig',
      helpAvailable: true,
      helpEngine: 'claude',
      helpModel: 'sonnet',
      helpEffort: 'low',
      helpAutoPlay: true,
      helpContextMode: 'section',
    });
    // Select p1 and ask for help.
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById('p1'));
    win.getSelection().removeAllRanges();
    win.getSelection().addRange(range);
    doc.dispatchEvent(new win.Event('selectionchange'));
    await sleep(220);
    click(doc.querySelector('.mpe-ra-bar-help'));
    const help = posted.filter((m) => m.command === 'readAloudHelp').pop();
    assert.ok(help, 'a help request; logs: ' + logs.join('\n'));
    host({
      command: 'readAloudHelpResult',
      requestId: help.args[1],
      html: ANSWER_HTML,
      markdown: '### What it says',
      engine: 'claude',
      model: 'sonnet',
      effort: 'low',
      cached: false,
      durationMs: 10,
    });
    helpBodyEl = doc.querySelector('.mpe-ra-help-body');
    Object.defineProperty(helpBodyEl, 'clientHeight', { value: 400 });
    const read = lastSynthesize();
    assert.strictEqual(read.args[3].kind, 'help');
    sendChunk(read, 0, 1, 0, 'What it says');
    await sleep(20);
    wordDocTop = 380;
    frame();
    assert.ok(
      helpBodyEl.querySelector('.mpe-ra-word'),
      'the word is in the sheet',
    );
    frames(70);
    // The sheet body scrolled to 380 − 0.38 × 400; the document did not.
    assert.ok(
      Math.abs(helpBodyEl.scrollTop - (380 - 0.38 * 400)) < 1e-6,
      String(helpBodyEl.scrollTop),
    );
    assert.strictEqual(win.scrollY, 0);
    // A wheel over the document does not touch the sheet's following.
    doc
      .getElementById('p3')
      .dispatchEvent(new win.Event('wheel', { bubbles: true }));
    assert.strictEqual(chip().hidden, true);
    // One over the sheet does.
    helpBodyEl.dispatchEvent(new win.Event('wheel', { bubbles: true }));
    assert.strictEqual(chip().hidden, false);
    const held = helpBodyEl.scrollTop;
    wordDocTop = 900;
    frames(10);
    assert.strictEqual(helpBodyEl.scrollTop, held, 'the sheet stays put');
  });
});
