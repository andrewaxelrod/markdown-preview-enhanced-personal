/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// The theme settings sheet of media/read-aloud.js under jsdom: the player
// font, the player font size (which is the preview's own zoom, driven through
// crossnote's ctrl+wheel handler) and the five highlight palettes. The Global
// theme row and the two page sliders of 05 have their own suite,
// page-theme.test.js.

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
  '<p id="p1">First, hooks. They are broader than before.</p>' +
  '</div></body></html>';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('read-aloud theme settings (F3/F4)', function () {
  this.timeout(20000);

  let dom;
  let win;
  let doc;
  let posted;
  let logs;
  /** Every ctrl+wheel crossnote's own handler would have seen. */
  let wheels;

  function boot(options) {
    posted = [];
    logs = [];
    wheels = [];
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
    win.URL.createObjectURL = () => 'blob:fake';
    win.URL.revokeObjectURL = () => {};
    win.Element.prototype.scrollIntoView = function () {};
    win.Audio = class extends win.EventTarget {
      constructor() {
        super();
        this.currentTime = 0;
        this.volume = 1;
        this.paused = true;
      }
      play() {
        return Promise.resolve();
      }
      pause() {}
      load() {}
      removeAttribute() {}
    };
    if (options && options.crossnoteZoom) {
      // What crossnote's preview does with a ctrl+wheel: ±0.1 of `zoomLevel`,
      // written to `document.body.style.zoom` (jsdom drops the unknown
      // property, so the fake keeps it on a data attribute the stub reads).
      let level = 1;
      doc.body.dataset.zoom = '1';
      doc.addEventListener(
        'wheel',
        (event) => {
          if (!event.ctrlKey && !event.metaKey) {
            return;
          }
          wheels.push(event.deltaY);
          level =
            Math.round((level + (event.deltaY < 0 ? 0.1 : -0.1)) * 100) / 100;
          doc.body.dataset.zoom = String(level);
          doc.body.style.zoom = String(level);
        },
        true,
      );
    }
    win.eval(CORE);
    win.eval(APP);
  }

  function host(message) {
    win.dispatchEvent(new win.MessageEvent('message', { data: message }));
  }

  function bar() {
    return doc.querySelector('.mpe-ra-bar');
  }

  function sheet() {
    return bar().querySelector('.mpe-ra-sheet');
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

  function swatch(theme) {
    const found = sheet().querySelector(
      '[data-mpe-ra-theme-choice="' + theme + '"]',
    );
    assert.ok(found, 'there is a ' + theme + ' swatch');
    return found;
  }

  function lastPost(command) {
    return posted.filter((m) => m.command === command).pop();
  }

  suiteSetup(async function () {
    boot();
    await sleep(60);
    click(button('theme'));
  });

  suiteTeardown(function () {
    if (dom) {
      dom.window.close();
    }
  });

  test('the sheet is titled, closable and has the seven rows of 05 §9', function () {
    assert.strictEqual(sheet().hidden, false, 'logs: ' + logs.join('\n'));
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-sheet-title').textContent,
      'Theme settings',
    );
    // Each label's own text; the sliders and the select wrap their control.
    const labels = Array.from(
      sheet().querySelectorAll('.mpe-ra-sheet-label'),
    ).map((el) => el.firstChild.textContent);
    assert.strictEqual(labels.length, 6);
    assert.strictEqual(labels[0], 'Global theme');
    assert.strictEqual(labels[1], 'Player font');
    assert.ok(
      /^Player font size: \d+px$/.test(labels[2]),
      'the size label names a pixel size, got ' + labels[2],
    );
    assert.strictEqual(labels[3], 'Line height: 1.6');
    assert.strictEqual(labels[4], 'Column width: 66 ch');
    assert.strictEqual(labels[5], 'Player highlight theme');
    // The seventh row is the footer: Reset and the reader guidance.
    assert.ok(
      sheet().querySelector('.mpe-ra-sheet-footer .mpe-ra-sheet-reset'),
    );
    assert.ok(sheet().querySelector('.mpe-ra-sheet-footer .mpe-ra-sheet-note'));
    // The page is on by default (`auto`), so the first font option says so.
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-sheet-font option').textContent,
      'Default — Atkinson Hyperlegible',
    );
  });

  test('the five palettes are offered, the current one checked', function () {
    const themes = Array.from(sheet().querySelectorAll('.mpe-ra-swatch')).map(
      (el) => el.getAttribute('data-mpe-ra-theme-choice'),
    );
    assert.deepStrictEqual(themes, ['blue', 'pink', 'red', 'green', 'orange']);
    assert.strictEqual(swatch('blue').getAttribute('aria-checked'), 'true');
    assert.strictEqual(swatch('red').getAttribute('aria-checked'), 'false');
    // Each swatch paints itself with the palette it offers, and follows the
    // panel's light/dark scheme.
    assert.strictEqual(swatch('red').getAttribute('data-mpe-ra-theme'), 'red');
    assert.strictEqual(
      swatch('red').getAttribute('data-mpe-ra-scheme'),
      bar().getAttribute('data-mpe-ra-scheme'),
    );
    // Three lines of sample text with one word spoken.
    assert.strictEqual(
      swatch('red').querySelectorAll('.mpe-ra-swatch-line').length,
      3,
    );
    assert.strictEqual(
      swatch('red').querySelector('.mpe-ra-swatch-word').textContent,
      'melodies',
    );
  });

  test('choosing a palette repaints the preview and persists the choice', function () {
    click(swatch('red'));
    const root = doc.querySelector('.markdown-preview');
    assert.strictEqual(root.getAttribute('data-mpe-ra-theme'), 'red');
    assert.strictEqual(swatch('red').getAttribute('aria-checked'), 'true');
    assert.strictEqual(swatch('blue').getAttribute('aria-checked'), 'false');
    assert.deepStrictEqual(
      Array.from(lastPost('readAloudSetHighlightTheme').args),
      ['red'],
    );
    assert.strictEqual(sheet().hidden, false, 'the sheet stays open');
  });

  test('choosing a font overrides the preview theme family, and clearing it puts the theme back', function () {
    const select = sheet().querySelector('.mpe-ra-sheet-font');
    const root = doc.querySelector('.markdown-preview');
    assert.strictEqual(select.value, 'default');
    assert.strictEqual(root.classList.contains('mpe-ra-font'), false);

    select.value = 'georgia';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.ok(root.classList.contains('mpe-ra-font'));
    assert.ok(
      /^Georgia,/.test(root.style.getPropertyValue('--mpe-ra-font-family')),
      'the root carries the Georgia stack',
    );
    assert.deepStrictEqual(Array.from(lastPost('readAloudSetFont').args), [
      'georgia',
    ]);

    select.value = 'default';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.strictEqual(root.classList.contains('mpe-ra-font'), false);
    assert.strictEqual(root.style.getPropertyValue('--mpe-ra-font-family'), '');
  });

  test('the host can set the palette and the font without the sheet', function () {
    const root = doc.querySelector('.markdown-preview');
    host({
      command: 'readAloudConfig',
      enabled: true,
      clickToRead: true,
      speed: 1,
      volume: 1,
      voiceName: 'af_heart',
      modelId: 'kokoro',
      highlightTheme: 'green',
      font: 'menlo',
    });
    assert.strictEqual(root.getAttribute('data-mpe-ra-theme'), 'green');
    assert.strictEqual(swatch('green').getAttribute('aria-checked'), 'true');
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-sheet-font').value,
      'menlo',
    );
    assert.ok(
      /^Menlo,/.test(root.style.getPropertyValue('--mpe-ra-font-family')),
    );
    // A retired palette and an unknown font fall back rather than breaking.
    host({
      command: 'readAloudConfig',
      highlightTheme: 'yellow',
      font: 'comic',
    });
    assert.strictEqual(root.getAttribute('data-mpe-ra-theme'), 'blue');
    assert.strictEqual(root.classList.contains('mpe-ra-font'), false);
  });

  test('the font size slider posts nothing: it is the preview zoom, not a setting', async function () {
    const before = posted.length;
    const range = sheet().querySelector('.mpe-ra-sheet-size');
    range.value = '1.3';
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
    await sleep(400);
    assert.strictEqual(posted.length, before, 'nothing was persisted');
  });

  test('the font size label follows the zoom and the slider is bounded', function () {
    const range = sheet().querySelector('.mpe-ra-sheet-size');
    const label = range.parentElement;
    assert.strictEqual(range.min, '0.6');
    assert.strictEqual(range.max, '2');
    assert.strictEqual(range.step, '0.1');
    // jsdom reports no font size for the root, so the label falls back to the
    // 16px default: the slider's own arithmetic is what is under test.
    range.value = '1.5';
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.strictEqual(
      label.textContent.split('\n')[0],
      'Player font size: 24px',
    );
    range.value = '1';
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.strictEqual(
      label.textContent.split('\n')[0],
      'Player font size: 16px',
    );
  });

  test('a click outside closes the sheet, and Escape closes it before it stops a read', function () {
    assert.strictEqual(sheet().hidden, false);
    click(doc.getElementById('p1'));
    assert.strictEqual(sheet().hidden, true);
    click(button('theme'));
    assert.strictEqual(sheet().hidden, false);
    bar().dispatchEvent(
      new win.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.strictEqual(sheet().hidden, true);
  });

  test('the size slider drives the preview zoom through crossnote itself', async function () {
    boot({ crossnoteZoom: true });
    await sleep(60);
    click(button('theme'));
    const range = sheet().querySelector('.mpe-ra-sheet-size');

    range.value = '1.3';
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
    // Three steps up: crossnote's handler moves 0.1 at a time.
    assert.deepStrictEqual(wheels, [-120, -120, -120]);
    assert.strictEqual(doc.body.dataset.zoom, '1.3');

    range.value = '0.9';
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.strictEqual(wheels.length, 7, 'four steps back down');
    assert.strictEqual(doc.body.dataset.zoom, '0.9');

    // Out of the slider's range, so it is clamped rather than passed on.
    range.value = '5';
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.strictEqual(doc.body.dataset.zoom, '2');

    // And once crossnote has answered, the sheet leaves the zoom to it.
    await sleep(200);
    const settled = wheels.length;
    range.value = '1';
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.ok(wheels.length > settled, 'still going through crossnote');
    assert.strictEqual(doc.body.dataset.zoom, '1');
  });

  test('with no crossnote on the page the sheet zooms the body itself', async function () {
    boot();
    await sleep(60);
    click(button('theme'));
    const range = sheet().querySelector('.mpe-ra-sheet-size');
    range.value = '1.4';
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
    // The wheel events went nowhere; after the probe the sheet takes over.
    await sleep(300);
    const label = range.parentElement;
    assert.strictEqual(
      label.textContent.split('\n')[0],
      'Player font size: 22px',
      'the label is honest either way',
    );
    range.value = '1.7';
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.strictEqual(
      label.textContent.split('\n')[0],
      'Player font size: 27px',
    );
  });
});
