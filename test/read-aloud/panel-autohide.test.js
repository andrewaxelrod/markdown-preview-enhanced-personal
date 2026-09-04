/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// Panel auto-hide (featrues/07-eye-strain-2/spec.md §10) under jsdom with
// real timers: the panel fades after PANEL_IDLE_MS of playback with no
// activity and the progress strip stands in for it; any activity, a pause,
// an open sheet, focus in the panel, the setting and a status message keep
// it, or bring it back.

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

const PREVIEW =
  '<!doctype html><html><body class="preview-container">' +
  '<div id="crossnote-data" data-config=\'{"sourceUri":"file:///doc.md"}\'></div>' +
  '<div class="crossnote markdown-preview" data-for="preview">' +
  '<p id="p1">First, hooks. Claude Code has them too, and they are broader than before.</p>' +
  '<p id="p2">Second, permission modes. The documented modes are default and plan.</p>' +
  '</div></body></html>';

// The player's PANEL_IDLE_MS is 3000; every wait here is a little over it.
const IDLE_WAIT_MS = 3150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

suite('read-aloud panel auto-hide (07 §10)', function () {
  this.timeout(60000);

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
    win.scrollTo = function () {};
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

  function click(element) {
    element.dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  }

  function bar() {
    return doc.querySelector('.mpe-ra-bar');
  }

  function strip() {
    return doc.querySelector('.mpe-ra-strip');
  }

  function idle() {
    return bar().classList.contains('mpe-ra-bar-idle');
  }

  function playButton() {
    return doc.querySelector('.mpe-ra-bar-play');
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

  function endCurrent() {
    const current = audios
      .filter((audio) => !audio.paused && /^blob:/.test(audio.src))
      .pop();
    assert.ok(current, 'an element plays a chunk; logs: ' + logs.join('\n'));
    current.paused = true;
    current.dispatchEvent(new win.Event('ended'));
  }

  let request;

  suiteSetup(async function () {
    boot();
    await sleep(60);
    click(doc.querySelector('#p1 .mpe-ra-btn'));
    request = posted.filter((m) => m.command === 'readAloudSynthesize').pop();
    assert.ok(request, 'a read was requested; logs: ' + logs.join('\n'));
    sendChunk(request, 0, 3, 0, 'First, hooks.');
    await sleep(40);
    assert.strictEqual(playButton().getAttribute('data-state'), 'playing');
  });

  suiteTeardown(function () {
    if (dom) {
      dom.window.close();
    }
  });

  test('playing with no activity: the panel goes idle after PANEL_IDLE_MS and the strip shows the progress', async function () {
    assert.strictEqual(idle(), false);
    assert.strictEqual(strip().hidden, true);
    await sleep(IDLE_WAIT_MS);
    assert.strictEqual(idle(), true, 'logs: ' + logs.join('\n'));
    assert.strictEqual(strip().hidden, false);
    assert.strictEqual(strip().getAttribute('aria-hidden'), 'true');
    assert.ok(strip().classList.contains('fixed'), 'un-zoomed like the panel');
    const width = strip().querySelector('i').style.width;
    assert.ok(/^\d+(\.\d+)?%$/.test(width) && parseFloat(width) > 0, width);
    assert.strictEqual(
      width,
      bar().querySelector('.mpe-ra-bar-progress > i').style.width,
      'the same percentage as the panel’s edge',
    );
    // The chip and the status are children of the panel and fade with it.
    assert.ok(bar().contains(doc.querySelector('.mpe-ra-bar-chip')));
  });

  test('a pointer move brings it back at once and restarts the countdown', async function () {
    win.dispatchEvent(new win.Event('pointermove'));
    assert.strictEqual(idle(), false);
    assert.strictEqual(strip().hidden, true);
    await sleep(IDLE_WAIT_MS);
    assert.strictEqual(idle(), true, 'idle again after the restart');
    // So do a key, a wheel and a touch.
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Shift' }));
    assert.strictEqual(idle(), false);
  });

  test('paused, it never goes idle', async function () {
    click(playButton());
    assert.strictEqual(playButton().getAttribute('data-state'), 'paused');
    assert.strictEqual(idle(), false);
    await sleep(IDLE_WAIT_MS);
    assert.strictEqual(idle(), false);
    click(playButton());
    assert.strictEqual(playButton().getAttribute('data-state'), 'playing');
  });

  test('with the sheet open it never goes idle; a mouse-focused button does not keep it', async function () {
    click(doc.querySelector('.mpe-ra-bar-theme'));
    assert.strictEqual(bar().querySelector('.mpe-ra-sheet').hidden, false);
    await sleep(IDLE_WAIT_MS);
    assert.strictEqual(idle(), false, 'the sheet keeps it');
    click(doc.querySelector('.mpe-ra-bar-theme'));
    // Only *keyboard* focus (`:focus-visible`) pins the panel (07 §10.1):
    // the button the mouse clicked to start the read keeps focus for the
    // whole read and must not stop the fade. jsdom reports no
    // `:focus-visible` for a programmatic focus, the way Chromium reports
    // none for a click; the Tab case is a Chrome check (07 §18, H7).
    playButton().focus();
    assert.strictEqual(doc.activeElement, playButton());
    await sleep(IDLE_WAIT_MS);
    assert.strictEqual(idle(), true, 'a mouse focus does not keep it');
    playButton().blur();
    doc.body.focus();
    win.dispatchEvent(new win.Event('pointermove'));
    assert.strictEqual(idle(), false);
  });

  test('`panelAutoHide: false` never hides; `true` starts the countdown again', async function () {
    host({ command: 'readAloudConfig', panelAutoHide: false });
    await sleep(IDLE_WAIT_MS);
    assert.strictEqual(idle(), false);
    assert.strictEqual(strip().hidden, true);
    host({ command: 'readAloudConfig', panelAutoHide: true });
    await sleep(IDLE_WAIT_MS);
    assert.strictEqual(idle(), true);
  });

  test('a status message — Loading… between chunks — clears idle', async function () {
    assert.strictEqual(idle(), true);
    // The chunk ends with the next one not yet synthesised.
    endCurrent();
    await sleep(30);
    assert.strictEqual(playButton().getAttribute('data-state'), 'loading');
    assert.strictEqual(
      bar().querySelector('.mpe-ra-bar-status').textContent,
      'Loading…',
    );
    assert.strictEqual(idle(), false);
    assert.strictEqual(strip().hidden, true);
    // A chunk of the same block arrives: playing again, the countdown runs
    // from here without popping the panel.
    sendChunk(
      request,
      1,
      3,
      0,
      'Claude Code has them too, and they are broader than before.',
    );
    await sleep(40);
    assert.strictEqual(playButton().getAttribute('data-state'), 'playing');
    assert.strictEqual(idle(), false);
    assert.ok(
      !logs.some((line) => line.startsWith('jsdomError')),
      logs.join('\n'),
    );
  });
});
