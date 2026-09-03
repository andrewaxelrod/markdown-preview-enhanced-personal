/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// The preview player (media/read-aloud.js) driven end to end under jsdom
// with fake <audio> elements: a continuous read across blocks, the loading
// state between chunks, the block hand-off, the memory rule and the click
// seek. Every message the player posts to the host is recorded, so a
// `readAloudCancel` the host never asked for is a failure.

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
  '<p id="p3">Third, managed settings. These outrank everything else.</p>';

const PREVIEW =
  '<!doctype html><html><body class="preview-container">' +
  '<div id="crossnote-data" data-config=\'{"sourceUri":"file:///doc.md"}\'></div>' +
  '<div class="crossnote markdown-preview" data-for="preview">' +
  FIXTURE +
  '</div></body></html>';

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

suite('read-aloud player: continuous read (F15)', function () {
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
    win.__revoked = [];
    win.URL.createObjectURL = () => 'blob:fake-' + ++blobs;
    win.URL.revokeObjectURL = (url) => win.__revoked.push(url);
    win.Element.prototype.scrollIntoView = function () {};
    // The two pool elements: `src` is swapped per chunk, play() records the
    // source it started, `ended` is fired by the tests on the playing one.
    class FakeAudio extends win.EventTarget {
      constructor(url) {
        super();
        this._src = url || '';
        this.currentTime = 0;
        this.duration = 2;
        this.playbackRate = 1;
        this.preservesPitch = true;
        this.paused = true;
        this.calls = [];
        audios.push(this);
      }
      // Setting src runs the load algorithm: the element is paused again.
      get src() {
        return this._src;
      }
      set src(value) {
        this._src = value;
        this.paused = true;
        this.currentTime = 0;
      }
      play() {
        this.calls.push('play:' + this.src.slice(0, 12));
        this.paused = false;
        return Promise.resolve();
      }
      pause() {
        this.calls.push('pause');
        this.paused = true;
      }
      load() {
        this.calls.push('load');
        this.paused = true;
      }
      removeAttribute(name) {
        this.calls.push('removeAttribute:' + name);
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

  function lastSynthesize() {
    return posted.filter((m) => m.command === 'readAloudSynthesize').pop();
  }

  function cancels() {
    return posted.filter((m) => m.command === 'readAloudCancel');
  }

  function playing() {
    return posted
      .filter((m) => m.command === 'readAloudPlaying')
      .map((m) => m.args[2]);
  }

  function readingIds() {
    return Array.from(doc.querySelectorAll('.mpe-ra-reading')).map(
      (el) => el.id,
    );
  }

  function clickPlay(id) {
    const button = doc.getElementById(id).querySelector('.mpe-ra-btn');
    assert.ok(button, 'play button on #' + id);
    button.dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  }

  /** The host's answer for chunk `index`: audio for block `blockIndex` of the request. */
  function sendChunk(request, index, count, blockIndex, chunkText) {
    const text = request.args[2];
    const block = request.args[3].blocks[blockIndex];
    const base = text.indexOf(chunkText, block.start);
    assert.ok(base >= 0 && base < block.end, 'chunk text is in its block');
    host({
      command: 'readAloudAudio',
      requestId: request.args[1],
      chunkIndex: index,
      chunkCount: count,
      blockIndex,
      audioBase64: 'QUJD',
      mimeType: 'audio/mpeg',
      spans: spansOf(chunkText, base),
      durationHint: 2,
    });
  }

  /** Fire `ended` on the pool element that is playing a chunk. */
  function endCurrent() {
    const current = audios
      .filter((audio) => !audio.paused && /^blob:/.test(audio.src))
      .pop();
    assert.ok(
      current,
      'an element plays a chunk: ' +
        JSON.stringify(audios.map((a) => [a.src, a.calls])),
    );
    current.paused = true;
    current.dispatchEvent(new win.Event('ended'));
  }

  function playedSources() {
    return audios.map((a) => a.calls.filter((c) => c.startsWith('play:')));
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

  test('the play button sends one request with the block boundaries of the rest of the document', function () {
    clickPlay('p1');
    const request = lastSynthesize();
    assert.ok(request, 'readAloudSynthesize posted; logs: ' + logs.join('\n'));
    const [sourceUri, requestId, text, options] = request.args;
    assert.strictEqual(sourceUri, 'file:///doc.md');
    assert.match(requestId, /^ra-/);
    assert.strictEqual(options.kind, 'block');
    assert.strictEqual(options.blocks.length, 3, 'p1, p2, p3');
    assert.strictEqual(
      text.slice(options.blocks[1].start, options.blocks[1].end),
      'Second, permission modes. The documented modes are default and plan.',
    );
    assert.deepStrictEqual(readingIds(), ['p1']);
    assert.strictEqual(
      doc.querySelector('#p1 .mpe-ra-btn').getAttribute('data-state'),
      'loading',
    );
    // The gesture unlocked the two pool elements with the silent wav.
    assert.strictEqual(
      audios.length,
      2,
      'two media elements, created on the gesture',
    );
    for (const audio of audios) {
      assert.ok(
        audio.calls[0].startsWith('play:data:audio'),
        JSON.stringify(audio.calls),
      );
    }
  });

  test('chunk 1 plays, ends, and a chunk that arrives while loading plays without a cancel', async function () {
    const request = lastSynthesize();
    sendChunk(request, 0, 4, 0, 'First, hooks.');
    await sleep(40);
    assert.deepStrictEqual(playing(), [0]);
    assert.deepStrictEqual(cancels(), [], logs.join('\n'));
    assert.strictEqual(audios.length, 2, 'no element is created per chunk');
    const playing0 = audios.find((a) => a.src === 'blob:fake-1');
    assert.ok(playing0 && !playing0.paused, 'chunk 0 plays on a pool element');

    endCurrent();
    await sleep(40);
    assert.strictEqual(
      doc.querySelector('#p1 .mpe-ra-btn').getAttribute('data-state'),
      'loading',
      'between chunks the button spins',
    );
    assert.deepStrictEqual(cancels(), [], logs.join('\n'));

    sendChunk(
      request,
      1,
      4,
      0,
      'Claude Code has them too, and they are broader than before.',
    );
    await sleep(60);
    assert.deepStrictEqual(
      cancels(),
      [],
      'no cancel; logs:\n' + logs.join('\n'),
    );
    assert.deepStrictEqual(playing(), [0, 1]);
    assert.deepStrictEqual(readingIds(), ['p1']);
    assert.ok(doc.querySelector('.mpe-ra-word'), 'a word is boxed');
    assert.strictEqual(audios.length, 2);
    assert.ok(
      audios.some((a) => a.src === 'blob:fake-2' && !a.paused),
      'chunk 1 plays on a pool element: ' +
        JSON.stringify(audios.map((a) => [a.src, a.calls])),
    );
  });

  test('a foreign DOM mutation during playback re-decorates without stopping the read', async function () {
    const before = cancels().length;
    const stray = doc.createElement('span');
    stray.textContent = ' (edited elsewhere)';
    doc.getElementById('h').appendChild(stray);
    await sleep(80);
    assert.strictEqual(
      cancels().length,
      before,
      'no cancel; logs:\n' + logs.join('\n'),
    );
    assert.deepStrictEqual(readingIds(), ['p1']);
    assert.ok(
      doc.querySelector('.mpe-ra-word'),
      'the word box survives the re-decorate',
    );
  });

  test('a full re-render with identical content rebinds every block and keeps playing', async function () {
    const before = cancels().length;
    const root = doc.querySelector('.markdown-preview');
    root.innerHTML = FIXTURE;
    await sleep(80);
    assert.strictEqual(
      cancels().length,
      before,
      'no cancel; logs:\n' + logs.join('\n'),
    );
    assert.deepStrictEqual(readingIds(), ['p1'], 'the fresh p1 is decorated');
    assert.strictEqual(
      doc.querySelector('#p1 .mpe-ra-btn').getAttribute('data-state'),
      'playing',
    );
    assert.ok(
      doc.querySelector('#p1 .mpe-ra-word'),
      'the word box is repainted in the fresh DOM',
    );
  });

  test('the hand-off to the next block moves the pills and the button, and releases the old audio', async function () {
    const request = lastSynthesize();
    sendChunk(
      request,
      2,
      4,
      1,
      'Second, permission modes. The documented modes are default and plan.',
    );
    await sleep(30);
    assert.deepStrictEqual(
      playing(),
      [0, 1],
      'queued behind the playing chunk',
    );
    assert.ok(
      audios.some((a) => a.src === 'blob:fake-3' && a.paused),
      'the next chunk is preloaded on the idle element: ' +
        JSON.stringify(audios.map((a) => [a.src, a.calls])),
    );

    endCurrent();
    await sleep(60);
    assert.deepStrictEqual(
      cancels(),
      [],
      'no cancel; logs:\n' + logs.join('\n'),
    );
    assert.deepStrictEqual(playing(), [0, 1, 2]);
    assert.deepStrictEqual(readingIds(), ['p2'], 'p1 undecorated, p2 pilled');
    assert.strictEqual(
      doc.querySelector('#p1 .mpe-ra-btn').getAttribute('data-state'),
      'idle',
    );
    assert.strictEqual(
      doc.querySelector('#p2 .mpe-ra-btn').getAttribute('data-state'),
      'playing',
    );
    assert.deepStrictEqual(
      win.__revoked.sort(),
      ['blob:fake-1', 'blob:fake-2'],
      'block 0 audio released (blob URLs revoked)',
    );
    assert.ok(
      audios.some((a) => a.src === 'blob:fake-3' && !a.paused),
      'chunk 2 plays: ' + JSON.stringify(audios.map((a) => [a.src, a.calls])),
    );
    assert.strictEqual(doc.querySelectorAll('#p1 .mpe-ra-pill').length, 0);
  });

  test('the last chunk finishes the read cleanly', async function () {
    const request = lastSynthesize();
    sendChunk(request, 3, 4, 2, 'Third, managed settings.');
    await sleep(30);
    endCurrent();
    await sleep(60);
    assert.deepStrictEqual(playing(), [0, 1, 2, 3]);
    assert.deepStrictEqual(readingIds(), ['p3']);
    endCurrent();
    await sleep(60);
    assert.deepStrictEqual(cancels(), [], logs.join('\n'));
    assert.deepStrictEqual(readingIds(), []);
    assert.strictEqual(doc.querySelectorAll('.mpe-ra-word').length, 0);
    const bar = doc.querySelector('.mpe-ra-bar');
    assert.strictEqual(
      bar.querySelector('.mpe-ra-bar-status').textContent,
      'Finished',
    );
    assert.ok(
      !logs.some((line) => line.startsWith('jsdomError')),
      logs.join('\n'),
    );
    assert.strictEqual(audios.length, 2, 'still only the two pool elements');
    for (const audio of audios) {
      assert.strictEqual(audio.src, '', 'both elements handed back');
    }
    assert.deepStrictEqual(win.__revoked.sort(), [
      'blob:fake-1',
      'blob:fake-2',
      'blob:fake-3',
      'blob:fake-4',
    ]);
    assert.ok(
      playedSources().flat().length >= 6,
      JSON.stringify(playedSources()),
    );
  });

  test('a second read reuses the unlocked elements without a new gesture', async function () {
    // No mousedown/click here: the read is started from the host control
    // path, as Alt+R or a command would, on elements unlocked earlier.
    const before = audios.length;
    const range = doc.createRange();
    const walker = doc.createTreeWalker(doc.getElementById('p3'), 4);
    const node = walker.nextNode();
    assert.ok(
      node && node.data.startsWith('Third, managed settings.'),
      node && node.data,
    );
    range.setStart(node, 0);
    range.setEnd(node, 24);
    const selection = win.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    host({ command: 'readAloudControl', action: 'readSelection' });
    await sleep(30);
    const request = lastSynthesize();
    assert.ok(
      request && request.args[3].kind === 'selection',
      'selection read requested',
    );
    assert.strictEqual(request.args[2], 'Third, managed settings.');
    host({
      command: 'readAloudAudio',
      requestId: request.args[1],
      chunkIndex: 0,
      chunkCount: 1,
      blockIndex: 0,
      audioBase64: 'QUJD',
      mimeType: 'audio/mpeg',
      spans: spansOf('Third, managed settings.', 0),
      durationHint: 2,
    });
    await sleep(40);
    assert.strictEqual(audios.length, before, 'no new element');
    assert.deepStrictEqual(playing().slice(-1), [0]);
    assert.ok(audios.some((a) => /^blob:/.test(a.src) && !a.paused));
    endCurrent();
    await sleep(60);
    assert.deepStrictEqual(cancels(), []);
    assert.deepStrictEqual(readingIds(), []);
  });
});
