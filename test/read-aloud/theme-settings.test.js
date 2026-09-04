/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// The theme settings sheet of media/read-aloud.js under jsdom: the player
// font, the text size slider (featrues/07-eye-strain-2/spec.md §5), the
// word marker row (07 §9) and the five highlight palettes. The Global theme
// row, the page's properties and Reset have their own suite,
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

suite('read-aloud theme settings (F3/F4, 07 §14)', function () {
  this.timeout(20000);

  let dom;
  let win;
  let doc;
  let posted;
  let logs;

  function boot() {
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
    win.eval(CORE);
    win.eval(APP);
  }

  function host(message) {
    win.dispatchEvent(new win.MessageEvent('message', { data: message }));
  }

  function html() {
    return doc.documentElement;
  }

  function root() {
    return doc.querySelector('.markdown-preview');
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

  function markerSegment(name) {
    const found = sheet().querySelector(
      '[data-mpe-ra-marker-choice="' + name + '"]',
    );
    assert.ok(found, 'there is a ' + name + ' marker segment');
    return found;
  }

  function sizeRange() {
    return sheet().querySelector('.mpe-ra-sheet-size');
  }

  function slide(range, value) {
    range.value = String(value);
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
  }

  function labelOf(range) {
    return range.parentElement.textContent.split('\n')[0];
  }

  function lastPost(command) {
    return posted.filter((m) => m.command === command).pop();
  }

  function posts(command) {
    return posted.filter((m) => m.command === command);
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

  test('the sheet is titled, closable and has the six rows of 07 §14', function () {
    assert.strictEqual(sheet().hidden, false, 'logs: ' + logs.join('\n'));
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-sheet-title').textContent,
      'Theme settings',
    );
    // Each label's own text; the slider and the select wrap their control.
    const labels = Array.from(
      sheet().querySelectorAll('.mpe-ra-sheet-label'),
    ).map((el) => el.firstChild.textContent);
    assert.deepStrictEqual(labels, [
      'Global theme',
      'Player font',
      'Text size: 20 px',
      'Word marker',
      'Player highlight theme',
    ]);
    // The sixth row is the footer: Reset and the reader guidance.
    assert.ok(
      sheet().querySelector('.mpe-ra-sheet-footer .mpe-ra-sheet-reset'),
    );
    assert.ok(sheet().querySelector('.mpe-ra-sheet-footer .mpe-ra-sheet-note'));
    // The page is on by default (`auto`), so the first font option says so.
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-sheet-font option').textContent,
      'Default — Atkinson Hyperlegible',
    );
    // The two sliders of 05 and the zoom slider of 03 are gone.
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-sheet-line-height'),
      null,
    );
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-sheet-column-width'),
      null,
    );
    assert.strictEqual(
      sheet().querySelectorAll('input[type="range"]').length,
      1,
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
    assert.strictEqual(root().getAttribute('data-mpe-ra-theme'), 'red');
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
    assert.strictEqual(select.value, 'default');
    assert.strictEqual(root().classList.contains('mpe-ra-font'), false);

    select.value = 'georgia';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.ok(root().classList.contains('mpe-ra-font'));
    assert.ok(
      /^Georgia,/.test(root().style.getPropertyValue('--mpe-ra-font-family')),
      'the root carries the Georgia stack',
    );
    assert.deepStrictEqual(Array.from(lastPost('readAloudSetFont').args), [
      'georgia',
    ]);

    select.value = 'default';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.strictEqual(root().classList.contains('mpe-ra-font'), false);
    assert.strictEqual(
      root().style.getPropertyValue('--mpe-ra-font-family'),
      '',
    );
  });

  test('the host can set the palette and the font without the sheet', function () {
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
    assert.strictEqual(root().getAttribute('data-mpe-ra-theme'), 'green');
    assert.strictEqual(swatch('green').getAttribute('aria-checked'), 'true');
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-sheet-font').value,
      'menlo',
    );
    assert.ok(
      /^Menlo,/.test(root().style.getPropertyValue('--mpe-ra-font-family')),
    );
    // A retired palette and an unknown font fall back rather than breaking.
    host({
      command: 'readAloudConfig',
      highlightTheme: 'yellow',
      font: 'comic',
    });
    assert.strictEqual(root().getAttribute('data-mpe-ra-theme'), 'blue');
    assert.strictEqual(root().classList.contains('mpe-ra-font'), false);
  });

  test('the text size slider is bounded 16–28 in steps of 1 and labels itself in px', function () {
    const range = sizeRange();
    assert.ok(range, 'the sheet has the text size slider');
    assert.strictEqual(range.min, '16');
    assert.strictEqual(range.max, '28');
    assert.strictEqual(range.step, '1');
    assert.strictEqual(range.getAttribute('aria-label'), 'Text size');
    assert.strictEqual(range.value, '20');
    assert.strictEqual(range.getAttribute('aria-valuetext'), '20 pixels');
    assert.strictEqual(labelOf(range), 'Text size: 20 px');
    assert.strictEqual(range.disabled, false, 'enabled while the page is on');
  });

  test('a drag writes the three page properties at once and persists one readAloudSetTextSize per drag', async function () {
    const range = sizeRange();
    const before = posts('readAloudSetTextSize').length;
    slide(range, 22);
    slide(range, 26);
    slide(range, 24);
    // The text size, the derived line height (07 §5.2: 1.50 at 24 px) and
    // the measure in em — 66 characters at the fallback advance under
    // jsdom, which lays nothing out.
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-text-size'),
      '24',
    );
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-line-height'),
      '1.5',
    );
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-measure'),
      '33em',
    );
    assert.strictEqual(labelOf(range), 'Text size: 24 px');
    assert.strictEqual(range.getAttribute('aria-valuetext'), '24 pixels');
    // Not written back while it is being dragged (03's rule).
    assert.strictEqual(range.value, '24');
    assert.strictEqual(
      posts('readAloudSetTextSize').length,
      before,
      'nothing posted before the debounce',
    );
    await sleep(400);
    assert.deepStrictEqual(
      posts('readAloudSetTextSize')
        .slice(before)
        .map((m) => Array.from(m.args)),
      [[24]],
    );
    // The ends of the range and their line heights.
    slide(range, 16);
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-line-height'),
      '1.7',
    );
    slide(range, 28);
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-line-height'),
      '1.45',
    );
    assert.strictEqual(labelOf(range), 'Text size: 28 px');
    await sleep(400);
  });

  test('the word marker row: three radios, the underline checked; a click switches the attribute at once and persists', function () {
    const radios = Array.from(
      sheet().querySelectorAll('.mpe-ra-seg-marker [role="radio"]'),
    );
    assert.deepStrictEqual(
      radios.map((el) => el.getAttribute('data-mpe-ra-marker-choice')),
      ['underline', 'box', 'off'],
    );
    assert.deepStrictEqual(
      radios.map((el) => el.textContent),
      ['Underline', 'Box', 'Off'],
    );
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-seg-marker').getAttribute('role'),
      'radiogroup',
    );
    assert.strictEqual(
      markerSegment('underline').getAttribute('aria-checked'),
      'true',
    );
    assert.strictEqual(root().getAttribute('data-mpe-ra-marker'), 'underline');

    click(markerSegment('box'));
    assert.strictEqual(root().getAttribute('data-mpe-ra-marker'), 'box');
    assert.strictEqual(
      doc.querySelector('.mpe-ra-help').getAttribute('data-mpe-ra-marker'),
      'box',
      'the help sheet marks the way the document does (07 §9.4)',
    );
    assert.strictEqual(
      sheet()
        .querySelector('.mpe-ra-sheet-swatches')
        .getAttribute('data-mpe-ra-marker'),
      'box',
      'the cards paint the chosen marker (07 §9.3)',
    );
    assert.strictEqual(
      markerSegment('box').getAttribute('aria-checked'),
      'true',
    );
    assert.strictEqual(
      markerSegment('underline').getAttribute('aria-checked'),
      'false',
    );
    assert.deepStrictEqual(
      Array.from(lastPost('readAloudSetWordMarker').args),
      ['box'],
    );
    assert.strictEqual(sheet().hidden, false, 'the sheet stays open');
  });

  test('the host can set the text size and the marker without the sheet, and a bad value falls back', function () {
    host({ command: 'readAloudConfig', textSize: 16, wordMarker: 'off' });
    assert.strictEqual(labelOf(sizeRange()), 'Text size: 16 px');
    assert.strictEqual(sizeRange().value, '16');
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-text-size'),
      '16',
    );
    assert.strictEqual(root().getAttribute('data-mpe-ra-marker'), 'off');
    assert.strictEqual(
      markerSegment('off').getAttribute('aria-checked'),
      'true',
    );
    host({ command: 'readAloudConfig', textSize: 999, wordMarker: 'dots' });
    assert.strictEqual(labelOf(sizeRange()), 'Text size: 28 px');
    assert.strictEqual(root().getAttribute('data-mpe-ra-marker'), 'underline');
    host({ command: 'readAloudConfig', textSize: 20 });
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

  test('the sheet never dispatches a wheel event: crossnote’s zoom is not its business any more', async function () {
    boot();
    await sleep(60);
    const wheels = [];
    doc.addEventListener('wheel', () => wheels.push(1), true);
    click(button('theme'));
    slide(sizeRange(), 26);
    click(sheet().querySelector('.mpe-ra-sheet-reset'));
    assert.deepStrictEqual(wheels, []);
    assert.deepStrictEqual(
      posts('readAloudResetPage').map((m) => Array.from(m.args)),
      [[]],
    );
  });
});
