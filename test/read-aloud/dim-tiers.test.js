/* global suite, test, teardown */
'use strict';

// Dim the rest while reading (featrues/07-eye-strain-2/spec.md §8) under
// jsdom with the page on: the two tier classes through a multi-block read,
// the hand-off, pause, the end, a re-render, the setting, `off`, and a help
// read that tiers the sheet body alone.

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
  '<h2 id="h">Heading one</h2>' +
  '<p id="p1">First, hooks. Claude Code has them too, and they are broader than before.</p>' +
  '<p id="p2">Second, permission modes. The documented modes are default and plan.</p>' +
  '<pre id="code"><code>const x = 1;</code></pre>' +
  '<p id="p3">Third, managed settings. These outrank everything else.</p>' +
  '<p id="p4">Fourth, the last one.</p>';

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
      end: t + 0.5,
    });
    t += 0.5;
    match = re.exec(text);
  }
  return out;
}

suite('read-aloud dim while reading (07 §8)', function () {
  this.timeout(20000);

  let dom;
  let win;
  let doc;
  let posted;
  let audios;
  let logs;

  function boot(config) {
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
    if (config) {
      Object.defineProperty(doc, 'currentScript', {
        configurable: true,
        get: () => ({ dataset: { config: JSON.stringify(config) } }),
      });
    }
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

  function endCurrent() {
    const current = audios
      .filter((audio) => !audio.paused && /^blob:/.test(audio.src))
      .pop();
    assert.ok(current, 'an element plays a chunk; logs: ' + logs.join('\n'));
    current.paused = true;
    current.dispatchEvent(new win.Event('ended'));
  }

  /** `{ id: 'near' | 'far' | '' }` for every block of the fixture. */
  function tiers() {
    const out = {};
    for (const id of ['h', 'p1', 'p2', 'code', 'p3', 'p4']) {
      const el = doc.getElementById(id);
      out[id] = el.classList.contains('mpe-ra-tier-near')
        ? 'near'
        : el.classList.contains('mpe-ra-tier-far')
          ? 'far'
          : '';
    }
    return out;
  }

  const CHUNKS = [
    [0, 'First, hooks.'],
    [1, 'Second, permission modes.'],
    [2, 'Third, managed settings.'],
    [3, 'Fourth, the last one.'],
  ];

  /** A read from p1: blocks p1 (0), p2 (1), p3 (2), p4 (3); the code fence is skipped. */
  async function startFromP1() {
    click(doc.querySelector('#p1 .mpe-ra-btn'));
    const request = lastSynthesize();
    assert.ok(request, 'a read was requested; logs: ' + logs.join('\n'));
    assert.strictEqual(request.args[3].blocks.length, 4);
    for (let i = 0; i < CHUNKS.length; i++) {
      sendChunk(request, i, CHUNKS.length, CHUNKS[i][0], CHUNKS[i][1]);
    }
    await sleep(30);
    return request;
  }

  teardown(function () {
    if (dom) {
      dom.window.close();
      dom = null;
    }
  });

  test('the active block has no tier, the next is near, the rest far, the code fence untouched; the hand-off moves them; pause keeps them; the end clears them', async function () {
    boot({ globalTheme: 'light' });
    await sleep(60);
    assert.deepStrictEqual(tiers(), {
      h: '',
      p1: '',
      p2: '',
      code: '',
      p3: '',
      p4: '',
    });
    await startFromP1();
    assert.deepStrictEqual(tiers(), {
      h: 'far',
      p1: '',
      p2: 'near',
      code: '',
      p3: 'far',
      p4: 'far',
    });
    // Hand-off to p2, after the block gap.
    endCurrent();
    await sleep(500);
    assert.deepStrictEqual(tiers(), {
      h: 'far',
      p1: 'far',
      p2: '',
      code: '',
      p3: 'near',
      p4: 'far',
    });
    // Pause keeps the tiers: the reader is still at that place.
    const play = doc.querySelector('.mpe-ra-bar-play');
    click(play);
    assert.strictEqual(play.getAttribute('data-state'), 'paused');
    assert.deepStrictEqual(tiers().p2, '');
    assert.deepStrictEqual(tiers().p3, 'near');
    click(play);
    // Stop clears everything.
    host({ command: 'readAloudControl', action: 'stop' });
    assert.deepStrictEqual(tiers(), {
      h: '',
      p1: '',
      p2: '',
      code: '',
      p3: '',
      p4: '',
    });
  });

  test('a re-render puts the classes on the new elements', async function () {
    boot({ globalTheme: 'dark' });
    await sleep(60);
    await startFromP1();
    const oldP2 = doc.getElementById('p2');
    doc.querySelector('.markdown-preview').innerHTML = FIXTURE;
    await sleep(80);
    assert.notStrictEqual(doc.getElementById('p2'), oldP2, 'fresh elements');
    assert.deepStrictEqual(tiers(), {
      h: 'far',
      p1: '',
      p2: 'near',
      code: '',
      p3: 'far',
      p4: 'far',
    });
    assert.ok(
      doc.getElementById('p1').classList.contains('mpe-ra-reading'),
      'p1 is still read',
    );
  });

  test('`dimWhileReading: false` from the host clears them mid-read, and `true` restores them', async function () {
    boot({ globalTheme: 'light' });
    await sleep(60);
    await startFromP1();
    assert.strictEqual(tiers().p3, 'far');
    host({ command: 'readAloudConfig', dimWhileReading: false });
    assert.deepStrictEqual(tiers(), {
      h: '',
      p1: '',
      p2: '',
      code: '',
      p3: '',
      p4: '',
    });
    host({ command: 'readAloudConfig', dimWhileReading: true });
    assert.strictEqual(tiers().p2, 'near');
    assert.strictEqual(tiers().p3, 'far');
  });

  test('with the page off nothing is dimmed, and turning the page on mid-read dims', async function () {
    boot({ globalTheme: 'off' });
    await sleep(60);
    await startFromP1();
    assert.deepStrictEqual(tiers(), {
      h: '',
      p1: '',
      p2: '',
      code: '',
      p3: '',
      p4: '',
    });
    host({ command: 'readAloudConfig', globalTheme: 'dark' });
    assert.strictEqual(tiers().p2, 'near');
    host({ command: 'readAloudConfig', globalTheme: 'off' });
    assert.strictEqual(tiers().p2, '');
  });

  test('a config that never mentions dimming leaves the default on', async function () {
    boot({ globalTheme: 'light' });
    await sleep(60);
    host({ command: 'readAloudConfig', enabled: true, speed: 1 });
    await startFromP1();
    assert.strictEqual(tiers().p4, 'far');
  });

  test('a help read tiers the sheet body only; the document keeps its own ink', async function () {
    boot({ globalTheme: 'light' });
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
    await startFromP1();
    assert.strictEqual(tiers().p2, 'near');
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById('p1'));
    win.getSelection().removeAllRanges();
    win.getSelection().addRange(range);
    doc.dispatchEvent(new win.Event('selectionchange'));
    await sleep(220);
    click(doc.querySelector('.mpe-ra-bar-help'));
    // Help paused the document read: its tiers are gone.
    assert.deepStrictEqual(tiers(), {
      h: '',
      p1: '',
      p2: '',
      code: '',
      p3: '',
      p4: '',
    });
    const help = posted.filter((m) => m.command === 'readAloudHelp').pop();
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
    const read = lastSynthesize();
    assert.strictEqual(read.args[3].kind, 'help');
    assert.strictEqual(read.args[3].blocks.length, 4);
    sendChunk(read, 0, 4, 0, 'What it says');
    await sleep(30);
    const body = doc.querySelector('.mpe-ra-help-body');
    const blocks = Array.from(body.children);
    assert.deepStrictEqual(
      blocks.map((el) =>
        el.classList.contains('mpe-ra-tier-near')
          ? 'near'
          : el.classList.contains('mpe-ra-tier-far')
            ? 'far'
            : '',
      ),
      ['', 'near', 'far', 'far'],
    );
    assert.deepStrictEqual(tiers(), {
      h: '',
      p1: '',
      p2: '',
      code: '',
      p3: '',
      p4: '',
    });
    assert.ok(
      !logs.some((line) => line.startsWith('jsdomError')),
      logs.join('\n'),
    );
  });
});
