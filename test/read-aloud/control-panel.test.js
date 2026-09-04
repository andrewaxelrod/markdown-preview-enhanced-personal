/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// The control panel of media/read-aloud.js (F3) under jsdom with fake <audio>
// elements: the seven controls and their states, the play button starting a
// read of its own, the ±10 s skips bounded to the block being read, the two
// popovers, and the × that closes the panel until the next read.

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

const FIXTURE =
  '<p id="p1">First, hooks. Claude Code has them too, and they are broader than before.</p>' +
  '<p id="p2">Second, permission modes. The documented modes are default and plan.</p>';

const PREVIEW =
  '<!doctype html><html><body class="preview-container">' +
  '<div id="crossnote-data" data-config=\'{"sourceUri":"file:///doc.md"}\'></div>' +
  '<div class="crossnote markdown-preview" data-for="preview">' +
  FIXTURE +
  '</div></body></html>';

/** Every chunk is 30 s long, so a ±10 s skip has room inside one block. */
const CHUNK_SECONDS = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whitespace words of `text` as host word spans, spread over the chunk. */
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
      end: t + 1,
    });
    t += 1;
    match = re.exec(text);
  }
  return out;
}

suite('read-aloud control panel (F3)', function () {
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
    for (const level of ['debug', 'log', 'warn', 'error']) {
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
    class FakeAudio extends win.EventTarget {
      constructor() {
        super();
        this._src = '';
        this.currentTime = 0;
        this.duration = CHUNK_SECONDS;
        this.playbackRate = 1;
        this.preservesPitch = true;
        this.volume = 1;
        this.paused = true;
        this.calls = [];
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
        this.calls.push('play');
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

  function bar() {
    return doc.querySelector('.mpe-ra-bar');
  }

  function button(name) {
    const found = doc.querySelector('.mpe-ra-bar-' + name);
    assert.ok(found, 'the panel has a ' + name + ' button');
    return found;
  }

  function click(element) {
    element.dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  }

  function lastSynthesize() {
    return posted.filter((m) => m.command === 'readAloudSynthesize').pop();
  }

  /** The element that is playing a chunk (never the silent unlock wav). */
  function playingAudio() {
    return audios.filter((a) => !a.paused && /^blob:/.test(a.src)).pop();
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
      durationHint: CHUNK_SECONDS,
    });
  }

  /** A read of #p1 in two 30 s chunks, playing the first. */
  async function startTwoChunkRead() {
    click(doc.querySelector('#p1 .mpe-ra-btn'));
    const request = lastSynthesize();
    assert.ok(request, 'a read was requested; logs: ' + logs.join('\n'));
    sendChunk(request, 0, 2, 0, 'First, hooks.');
    await sleep(30);
    sendChunk(
      request,
      1,
      2,
      0,
      'Claude Code has them too, and they are broader than before.',
    );
    await sleep(30);
    return request;
  }

  suiteSetup(async function () {
    boot();
    await sleep(60);
  });

  suiteTeardown(function () {
    if (dom) {
      dom.window.close();
    }
  });

  test('the panel is on screen from the start with the eight controls in order', function () {
    assert.ok(bar(), 'the panel exists; logs: ' + logs.join('\n'));
    assert.strictEqual(bar().hidden, false, 'and is visible while idle');
    // The panel's own row; the popovers, the theme settings sheet and the
    // help sheet carry buttons of their own, and the _Back to the reading_
    // chip of 07 §7.5 sits in the status slot above the row, not in it.
    const order = Array.from(
      bar().querySelectorAll(':scope > button:not(.mpe-ra-bar-chip)'),
    ).map((el) => el.getAttribute('data-mpe-ra-action'));
    const chip = bar().querySelector('.mpe-ra-bar-chip');
    assert.ok(chip, 'the chip is built with the panel');
    assert.strictEqual(chip.hidden, true, 'and hidden while nothing plays');
    // The idle progress strip (07 §10) lives beside the panel, hidden too.
    const strip = doc.querySelector('.mpe-ra-strip');
    assert.ok(strip && strip.parentElement === doc.body);
    assert.strictEqual(strip.hidden, true);
    // 04-help-module §2: help sits between the speed and the ×, so the × is
    // still the last control.
    assert.deepStrictEqual(order, [
      'volume',
      'theme',
      'back10',
      'play',
      'forward10',
      'speed',
      'help',
      'close',
    ]);
    // With no `helpAvailable` in the config — the web build, and this fixture
    // — the button is not on screen at all.
    assert.strictEqual(button('help').hidden, true);
    assert.strictEqual(button('speed').textContent, '1×');
    assert.strictEqual(button('back10').disabled, true, 'nothing to skip yet');
    assert.strictEqual(button('forward10').disabled, true);
    // The canvas classes carry the reading rhythm and the room for the panel.
    const root = doc.querySelector('.markdown-preview');
    assert.ok(root.classList.contains('mpe-ra-canvas'));
    assert.ok(root.classList.contains('mpe-ra-panel'));
  });

  test('the theme button opens the theme settings sheet, and closes it again', function () {
    const sheet = bar().querySelector('.mpe-ra-sheet');
    assert.ok(sheet, 'the sheet is built with the panel');
    assert.strictEqual(sheet.hidden, true, 'and starts closed');
    click(button('theme'));
    assert.strictEqual(sheet.hidden, false);
    assert.strictEqual(button('theme').getAttribute('aria-expanded'), 'true');
    click(button('theme'));
    assert.strictEqual(sheet.hidden, true);
    assert.strictEqual(button('theme').getAttribute('aria-expanded'), 'false');
  });

  test('the speed popover moves the rate, and the volume popover the volume', async function () {
    click(button('speed'));
    const speedPop = bar().querySelector('.mpe-ra-pop-speed');
    assert.strictEqual(speedPop.hidden, false, 'the popover opened');
    assert.strictEqual(
      speedPop.querySelector('.mpe-ra-pop-label').textContent,
      'Reading speed',
    );
    const speedRange = speedPop.querySelector('.mpe-ra-pop-range');
    speedRange.value = '1.5';
    speedRange.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.strictEqual(button('speed').textContent, '1.5×');
    assert.strictEqual(
      speedPop.querySelector('.mpe-ra-pop-value').textContent,
      '1.5',
    );

    // Opening the other popover closes this one.
    click(button('volume'));
    assert.strictEqual(speedPop.hidden, true);
    const volumePop = bar().querySelector('.mpe-ra-pop-volume');
    assert.strictEqual(volumePop.hidden, false);
    const volumeRange = volumePop.querySelector('.mpe-ra-pop-range');
    volumeRange.value = '0.4';
    volumeRange.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.strictEqual(
      volumePop.querySelector('.mpe-ra-pop-value').textContent,
      '40%',
    );

    // Both are persisted through the host, after the debounce.
    await sleep(400);
    const speed = posted.filter((m) => m.command === 'readAloudSetSpeed').pop();
    const volume = posted
      .filter((m) => m.command === 'readAloudSetVolume')
      .pop();
    assert.deepStrictEqual(Array.from(speed.args), [1.5]);
    assert.deepStrictEqual(Array.from(volume.args), [0.4]);

    // A click in the document closes the popover again.
    click(doc.getElementById('p2'));
    assert.strictEqual(volumePop.hidden, true);
    // Put the defaults back for the rest of the suite.
    speedRange.value = '1';
    speedRange.dispatchEvent(new win.Event('input', { bubbles: true }));
  });

  test('the speed label keeps its width, so the centred panel does not jitter', function () {
    // The panel is centred with a transform, so a label that grew with the
    // value would shift the whole pill on every tick of the slider.
    const speed = button('speed');
    const speedPop = bar().querySelector('.mpe-ra-pop-speed');
    const range = speedPop.querySelector('.mpe-ra-pop-range');
    const labels = [];
    for (const value of ['0.25', '1', '1.15', '1.75', '4']) {
      range.value = value;
      range.dispatchEvent(new win.Event('input', { bubbles: true }));
      labels.push(speed.textContent);
      assert.strictEqual(
        range.value,
        value,
        'the value is not written back into the slider being dragged',
      );
    }
    assert.deepStrictEqual(labels, ['0.25×', '1×', '1.15×', '1.75×', '4×']);
    // jsdom does not lay out, so the fixed width itself is asserted in the
    // stylesheet: a width, not a min-width, on the speed button and the value.
    const css = fs.readFileSync(
      path.join(__dirname, '..', '..', 'media', 'read-aloud.css'),
      'utf8',
    );
    assert.match(css, /\.mpe-ra-bar-speed \{[^}]*\n\s*width: \d+px;/);
    assert.match(css, /\.mpe-ra-pop-value \{[^}]*\n\s*width: [\d.]+em;/);
    // And the slider carries no focus box of its own.
    assert.match(
      css,
      /\.mpe-ra-pop-range:focus,\n\.mpe-ra-pop-range:focus-visible \{\n\s*outline: none;/,
    );
    range.value = '1';
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
    click(button('speed'));
  });

  test('play with nothing loaded reads from the first block in view', async function () {
    click(button('play'));
    const request = lastSynthesize();
    assert.ok(request, 'a read was requested; logs: ' + logs.join('\n'));
    assert.strictEqual(request.args[3].kind, 'block');
    assert.ok(
      request.args[2].startsWith('First, hooks.'),
      'from the first block: ' + request.args[2].slice(0, 40),
    );
    assert.strictEqual(button('play').getAttribute('data-state'), 'loading');
    // Give the job up again, so the next test starts from idle.
    click(button('close'));
    await sleep(20);
  });

  test('the volume reaches the audio element the chunk plays on', async function () {
    const volumePop = bar().querySelector('.mpe-ra-pop-volume');
    click(button('volume'));
    const volumeRange = volumePop.querySelector('.mpe-ra-pop-range');
    volumeRange.value = '0.5';
    volumeRange.dispatchEvent(new win.Event('input', { bubbles: true }));
    click(button('volume'));

    await startTwoChunkRead();
    const audio = playingAudio();
    assert.ok(audio, 'a chunk is playing; logs: ' + logs.join('\n'));
    assert.strictEqual(audio.volume, 0.5);
    // A change during playback applies to the element straight away.
    volumeRange.value = '0.25';
    volumeRange.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.strictEqual(audio.volume, 0.25);
    assert.strictEqual(
      button('volume').getAttribute('data-icon'),
      'volumeLow',
      'the glyph follows the level',
    );
  });

  test('−10 s moves back inside the chunk, and both skips report themselves enabled', function () {
    const audio = playingAudio();
    assert.strictEqual(button('back10').disabled, false);
    assert.strictEqual(button('forward10').disabled, false);
    audio.currentTime = 25;
    click(button('back10'));
    assert.strictEqual(playingAudio().currentTime, 15);
  });

  test('−10 s before the first word of the block restarts the block', function () {
    const audio = playingAudio();
    audio.currentTime = 3;
    click(button('back10'));
    assert.strictEqual(
      playingAudio().currentTime,
      0,
      'clamped to the top of the block, never into the previous one',
    );
  });

  test('+10 s crosses into the next chunk of the same block', function () {
    playingAudio().currentTime = 25;
    click(button('forward10'));
    const audio = playingAudio();
    assert.strictEqual(audio.src, 'blob:fake-2', 'now on the second chunk');
    assert.strictEqual(audio.currentTime, 5, '35 s in, 30 s into the chunk');
  });

  test('+10 s past the end of the block does nothing', function () {
    const audio = playingAudio();
    audio.currentTime = 25; // 55 s of a 60 s block
    click(button('forward10'));
    assert.strictEqual(playingAudio(), audio, 'still the same chunk');
    assert.strictEqual(playingAudio().currentTime, 25, 'and the same position');
    assert.strictEqual(
      button('forward10').disabled,
      true,
      'the button says so as well',
    );
  });

  test('the panel shows the progress of the read along its top edge', function () {
    const width = bar().querySelector('.mpe-ra-bar-progress > i').style.width;
    assert.ok(/%$/.test(width), 'a percentage: ' + width);
    assert.ok(parseFloat(width) > 0, 'the read has advanced: ' + width);
  });

  test('the × stops the read and closes the panel; the next read brings it back', async function () {
    click(button('close'));
    await sleep(20);
    assert.strictEqual(bar().hidden, true, 'the panel is gone');
    assert.strictEqual(
      doc.querySelectorAll('.mpe-ra-reading').length,
      0,
      'and the read stopped with it',
    );
    assert.ok(
      !doc
        .querySelector('.markdown-preview')
        .classList.contains('mpe-ra-panel'),
      'the canvas takes its bottom padding back',
    );

    click(doc.querySelector('#p2 .mpe-ra-btn'));
    await sleep(20);
    assert.strictEqual(bar().hidden, false, 'a new read reopens the panel');
    assert.ok(
      !logs.some((line) => line.startsWith('jsdomError')),
      logs.join('\n'),
    );
  });
});
