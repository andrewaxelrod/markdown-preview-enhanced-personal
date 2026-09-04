/* global suite, test, teardown */
'use strict';

// The word marker (featrues/07-eye-strain-2/spec.md §9) under jsdom: the
// attribute on the preview root, the help sheet and the swatch container,
// the sheet's segmented control, the host's config, the three rules of
// media/read-aloud.css and the span that is created under every style.

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
const PLAYER_CSS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud.css'),
  'utf8',
);
const UNCOMMENTED = PLAYER_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const PREVIEW =
  '<!doctype html><html><body class="preview-container">' +
  '<div id="crossnote-data" data-config=\'{"sourceUri":"file:///doc.md"}\'></div>' +
  '<div class="crossnote markdown-preview" data-for="preview">' +
  '<p id="p1">First, hooks. Claude Code has them too, and they are broader than before.</p>' +
  '</div></body></html>';

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

suite('read-aloud word marker (07 §9)', function () {
  this.timeout(20000);

  let dom;
  let win;
  let doc;
  let posted;
  let logs;

  function boot(config) {
    posted = [];
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
    win.URL.createObjectURL = () => 'blob:fake';
    win.URL.revokeObjectURL = () => {};
    win.Element.prototype.scrollIntoView = function () {};
    win.scrollTo = function () {};
    win.Audio = class extends win.EventTarget {
      constructor() {
        super();
        this.currentTime = 0;
        this.duration = 30;
        this.volume = 1;
        this.paused = true;
      }
      play() {
        this.paused = false;
        return Promise.resolve();
      }
      pause() {
        this.paused = true;
      }
      load() {}
      removeAttribute() {}
    };
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

  function root() {
    return doc.querySelector('.markdown-preview');
  }

  function markerOf(el) {
    return el.getAttribute('data-mpe-ra-marker');
  }

  function attributes() {
    return [
      markerOf(root()),
      markerOf(doc.querySelector('.mpe-ra-help')),
      markerOf(doc.querySelector('.mpe-ra-sheet-swatches')),
    ];
  }

  function segment(name) {
    return doc.querySelector('[data-mpe-ra-marker-choice="' + name + '"]');
  }

  function posts(command) {
    return posted.filter((m) => m.command === command);
  }

  function rule(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('(?:^|\\n)' + escaped + '\\s*\\{([^}]*)\\}').exec(
      UNCOMMENTED,
    );
    assert.ok(m, `the stylesheet has a ${selector} rule`);
    return m[1].replace(/\s+/g, ' ').trim();
  }

  teardown(function () {
    if (dom) {
      dom.window.close();
      dom = null;
    }
  });

  test('the attribute is published on the root, the help sheet and the swatch container from data-config', async function () {
    boot({ wordMarker: 'box' });
    await sleep(60);
    assert.deepStrictEqual(attributes(), ['box', 'box', 'box']);
    assert.strictEqual(core.normaliseWordMarker('dots'), 'underline');
    assert.strictEqual(core.DEFAULT_WORD_MARKER, 'underline');
    boot();
    await sleep(60);
    assert.deepStrictEqual(attributes(), [
      'underline',
      'underline',
      'underline',
    ]);
  });

  test('the sheet’s segmented control posts readAloudSetWordMarker and switches the attribute at once; the host switches it back', async function () {
    boot();
    await sleep(60);
    click(doc.querySelector('.mpe-ra-bar-theme'));
    assert.strictEqual(
      segment('underline').getAttribute('aria-checked'),
      'true',
    );
    click(segment('box'));
    assert.deepStrictEqual(attributes(), ['box', 'box', 'box']);
    assert.deepStrictEqual(
      posts('readAloudSetWordMarker').map((m) => Array.from(m.args)),
      [['box']],
    );
    assert.strictEqual(segment('box').getAttribute('aria-checked'), 'true');
    click(segment('off'));
    assert.deepStrictEqual(attributes(), ['off', 'off', 'off']);
    host({ command: 'readAloudConfig', wordMarker: 'underline' });
    assert.deepStrictEqual(attributes(), [
      'underline',
      'underline',
      'underline',
    ]);
    assert.strictEqual(
      segment('underline').getAttribute('aria-checked'),
      'true',
    );
    assert.strictEqual(segment('off').getAttribute('aria-checked'), 'false');
    // The marker is not a page row: it stays enabled with the page off.
    host({ command: 'readAloudConfig', globalTheme: 'off', wordMarker: 'box' });
    assert.deepStrictEqual(attributes(), ['box', 'box', 'box']);
    assert.strictEqual(segment('box').disabled, false);
  });

  test('the word span is still created under every style, so the follow loop and click-to-seek have their anchor', async function () {
    for (const marker of core.WORD_MARKERS) {
      boot({ wordMarker: marker });
      await sleep(60);
      click(doc.querySelector('#p1 .mpe-ra-btn'));
      const request = posted
        .filter((m) => m.command === 'readAloudSynthesize')
        .pop();
      assert.ok(request, marker + ': a read was requested');
      host({
        command: 'readAloudAudio',
        requestId: request.args[1],
        chunkIndex: 0,
        chunkCount: 1,
        blockIndex: 0,
        audioBase64: 'QUJD',
        mimeType: 'audio/mpeg',
        spans: spansOf('First, hooks.', 0),
        durationHint: 30,
      });
      await sleep(40);
      const word = doc.querySelector('.mpe-ra-word');
      assert.ok(word, marker + ': the word span exists');
      assert.strictEqual(word.textContent, 'First,');
      assert.strictEqual(markerOf(root()), marker);
      assert.ok(
        doc.querySelector('#p1 .mpe-ra-pill'),
        marker + ': the pills are there under every marker',
      );
    }
  });

  test('the three styles of §9.1 are in the stylesheet: the underline and off cancel the box, the underline adds the sweep', () => {
    const cancel = rule(
      "[data-mpe-ra-marker='underline'] .mpe-ra-word,\n[data-mpe-ra-marker='off'] .mpe-ra-word",
    );
    for (const declaration of [
      '--mpe-ra-pill-pad-x: 0;',
      '--mpe-ra-pill-pad-y: 0;',
      '--mpe-ra-pill-shift: 0;',
      'margin: 0;',
      'padding: 0;',
      'border-radius: 0;',
      'background-color: transparent;',
    ]) {
      assert.ok(cancel.includes(declaration), `${declaration} in ${cancel}`);
    }
    const underline = rule("[data-mpe-ra-marker='underline'] .mpe-ra-word");
    assert.ok(
      underline.includes(
        'box-shadow: inset 0 -0.14em 0 0 var(--mpe-ra-word-line, currentColor);',
      ),
      underline,
    );
    assert.ok(underline.includes('box-decoration-break: clone;'), underline);
    assert.ok(
      !/text-decoration/.test(underline),
      'box-shadow, not text-decoration',
    );
    // The box is the base rule, untouched: positioned, filled, padded.
    const box = Array.from(
      UNCOMMENTED.matchAll(/\n\.mpe-ra-word\s*\{([^}]*)\}/g),
    )
      .map((m) => m[1])
      .find((body) => body.includes('background-color: var(--mpe-ra-word'));
    assert.ok(box && /position:\s*relative;/.test(box));
    // Every palette declares the stroke.
    assert.strictEqual(
      Array.from(UNCOMMENTED.matchAll(/--mpe-ra-word-line:\s*#[0-9a-f]{6};/g))
        .length,
      10,
    );
    // Forced colours: the sweep is Highlight.
    assert.ok(
      /forced-colors: active[\s\S]*\[data-mpe-ra-marker='underline'\] \.mpe-ra-word\s*\{\s*box-shadow: inset 0 -0\.14em 0 0 Highlight;/.test(
        UNCOMMENTED,
      ),
    );
    // The cards paint the chosen marker.
    assert.ok(
      /\[data-mpe-ra-marker='underline'\] \.mpe-ra-swatch-word\s*\{\s*box-shadow: inset 0 -0\.14em 0 0 var\(--mpe-ra-word-line, currentColor\);/.test(
        UNCOMMENTED,
      ),
    );
  });

  test('nothing moves under any style: the box cancels its padding with its margin, the others have none (02’s invariant)', () => {
    const base = /\.mpe-ra-pill,\s*\.mpe-ra-word\s*\{([^}]*)\}/.exec(
      UNCOMMENTED,
    );
    assert.ok(base);
    const block = base[1].replace(/\s+/g, ' ');
    assert.ok(
      block.includes(
        'margin: calc(-1 * (var(--mpe-ra-pill-pad-y) - var(--mpe-ra-pill-shift, 0.08em))) calc(-1 * var(--mpe-ra-pill-pad-x)) calc(-1 * (var(--mpe-ra-pill-pad-y) + var(--mpe-ra-pill-shift, 0.08em)));',
      ),
    );
    const cancel = rule(
      "[data-mpe-ra-marker='underline'] .mpe-ra-word,\n[data-mpe-ra-marker='off'] .mpe-ra-word",
    );
    assert.ok(cancel.includes('margin: 0;') && cancel.includes('padding: 0;'));
    // An inset shadow paints inside the box and takes no layout space.
    const underline = rule("[data-mpe-ra-marker='underline'] .mpe-ra-word");
    assert.ok(/box-shadow: inset/.test(underline));
    assert.ok(
      !/\b(top|left|right|bottom|inset):|border:|outline/.test(underline),
    );
  });
});
