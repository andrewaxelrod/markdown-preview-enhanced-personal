/* global suite, test, teardown */
'use strict';

// The low-strain page of media/read-aloud.js under jsdom
// (featrues/05-eye-strain.spec.md §12, revised by 07 §5–§6): the Global theme
// and its resolution, the attribute and the three derived properties on
// <html>, the segmented control, the measured column, Reset, and the `off`
// regression guard. jsdom lacks `matchMedia`, so the harness stubs it, with
// a switch that fires its `change` listeners.

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
const PAGE_CSS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud-page.css'),
  'utf8',
);
const PLAYER_CSS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud.css'),
  'utf8',
);

function preview(bodyAttrs) {
  return (
    '<!doctype html><html><body class="preview-container' +
    (bodyAttrs && bodyAttrs.bodyClass ? ' ' + bodyAttrs.bodyClass : '') +
    '"' +
    (bodyAttrs && bodyAttrs.bodyStyle
      ? ' style="' + bodyAttrs.bodyStyle + '"'
      : '') +
    '>' +
    '<div id="crossnote-data" data-config=\'{"sourceUri":"file:///doc.md"}\'></div>' +
    '<div class="crossnote markdown-preview" data-for="preview">' +
    '<p id="p1">First, hooks. They are broader than before.</p>' +
    '<p id="p2">Second, a paragraph to read.</p>' +
    '</div></body></html>'
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('read-aloud low-strain page (05)', function () {
  this.timeout(20000);

  let dom;
  let win;
  let doc;
  let posted;
  let logs;
  let mediaListeners;
  let prefersDark;
  /**
   * The average advance the fake layout reports for the measuring probe
   * (07 §6.2), in px per character at a 10 px em: null means no layout at
   * all, as jsdom has.
   */
  let advancePx;

  /**
   * @param {{ config?: object, bodyClass?: string, bodyStyle?: string,
   *           prefersDark?: boolean, advancePx?: number }} options
   */
  function boot(options) {
    options = options || {};
    posted = [];
    logs = [];
    mediaListeners = [];
    prefersDark = !!options.prefersDark;
    advancePx =
      typeof options.advancePx === 'number' ? options.advancePx : null;
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
    dom = new JSDOM(preview(options), {
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
    // The measuring probe (07 §6.2): the sample span and the 100 em
    // reference get a width from the fake layout, everything else none.
    const rect = win.Element.prototype.getBoundingClientRect;
    win.Element.prototype.getBoundingClientRect = function () {
      const parent = this.parentElement;
      if (
        advancePx !== null &&
        parent &&
        parent.classList &&
        parent.classList.contains('mpe-ra-probe')
      ) {
        const width = /100em/.test(this.style.cssText)
          ? 1000
          : advancePx * core.MEASURE_SAMPLE.length;
        return { top: 0, left: 0, right: width, bottom: 10, width, height: 10 };
      }
      return rect.call(this);
    };
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
    win.matchMedia = (query) => ({
      media: query,
      get matches() {
        return /dark/.test(query) ? prefersDark : false;
      },
      addEventListener: (type, fn) => mediaListeners.push(fn),
      removeEventListener: () => {},
      addListener: (fn) => mediaListeners.push(fn),
      removeListener: () => {},
    });
    // What the host puts in the script's `data-config` attribute (§4.3): the
    // page is applied from it at script evaluation.
    if (options.config) {
      Object.defineProperty(doc, 'currentScript', {
        configurable: true,
        get: () => ({ dataset: { config: JSON.stringify(options.config) } }),
      });
    }
    win.eval(CORE);
    win.eval(APP);
  }

  function setPrefersDark(value) {
    prefersDark = value;
    for (const fn of mediaListeners) {
      fn({ matches: value });
    }
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

  function openSheet() {
    click(doc.querySelector('.mpe-ra-bar-theme'));
    assert.strictEqual(sheet().hidden, false, 'logs: ' + logs.join('\n'));
  }

  function click(element) {
    element.dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  }

  function segment(name) {
    const found = sheet().querySelector(
      '[data-mpe-ra-page-choice="' + name + '"]',
    );
    assert.ok(found, 'there is a ' + name + ' segment');
    return found;
  }

  function slide(range, value) {
    range.value = String(value);
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
  }

  function labelOf(range) {
    return range.parentElement.textContent.split('\n')[0];
  }

  function posts(command) {
    return posted.filter((m) => m.command === command);
  }

  teardown(function () {
    if (dom) {
      dom.window.close();
      dom = null;
    }
  });

  test('resolvePageScheme: the table of §4.2', function () {
    const r = core.resolvePageScheme;
    assert.strictEqual(r('off', {}), null);
    assert.strictEqual(r('light', { bodyClasses: 'vscode-dark' }), 'light');
    assert.strictEqual(r('dark', { prefersDark: false }), 'dark');
    assert.strictEqual(r('auto', { bodyClasses: 'vscode-light' }), 'light');
    assert.strictEqual(r('auto', { bodyClasses: 'vscode-dark' }), 'dark');
    assert.strictEqual(
      r('auto', { bodyClasses: 'x vscode-high-contrast y' }),
      'dark',
    );
    assert.strictEqual(
      r('auto', { bodyClasses: 'vscode-high-contrast-light' }),
      'light',
    );
    // No body yet, or no class on it: the media query decides.
    assert.strictEqual(r('auto', { prefersDark: true }), 'dark');
    assert.strictEqual(r('auto', { prefersDark: false }), 'light');
    assert.strictEqual(r('auto', undefined), 'light');
    // An unknown value is `auto`, the default.
    assert.strictEqual(r('sepia', { bodyClasses: 'vscode-dark' }), 'dark');
    assert.strictEqual(core.normaliseGlobalTheme('sepia'), 'auto');
    // The two clamps of 05 gave way to the text size and its derivation.
    assert.strictEqual(core.clampLineHeight, undefined);
    assert.strictEqual(core.clampColumnWidth, undefined);
    assert.strictEqual(core.clampTextSize(24.4), 24);
    assert.strictEqual(core.deriveLineHeight(24), 1.5);
  });

  test('booting with `dark` and a text size puts the page and its three properties on <html>', async function () {
    boot({ config: { globalTheme: 'dark', textSize: 24 } });
    await sleep(60);
    assert.strictEqual(html().getAttribute('data-mpe-ra-page'), 'dark');
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-text-size'),
      '24',
    );
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-line-height'),
      '1.5',
      'derived (07 §5.2)',
    );
    // jsdom lays nothing out, so the measure is 66 characters at the
    // fallback advance of 0.5 em (07 §6.2).
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-measure'),
      '33em',
    );
    assert.strictEqual(root().getAttribute('data-mpe-ra-scheme'), 'dark');
    assert.strictEqual(bar().getAttribute('data-mpe-ra-scheme'), 'dark');
  });

  test('the measure is taken from the face in use and again after a font change (07 §6.2)', async function () {
    // 4.7 px per character at a 10 px em: 0.47 em, so 66 characters are
    // 31.02 em.
    boot({ config: { globalTheme: 'light' }, advancePx: 4.7 });
    await sleep(60);
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-measure'),
      '31.02em',
    );
    assert.strictEqual(
      root().querySelector('.mpe-ra-probe'),
      null,
      'the probe is removed at once',
    );
    // A wider face (Georgia's advance is larger) gives a wider column in em
    // and the same 66 characters.
    advancePx = 5.2;
    host({ command: 'readAloudConfig', font: 'georgia' });
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-measure'),
      '34.32em',
    );
    // A text size change does not re-measure: the ratio is size-independent
    // and the property is in em.
    advancePx = 9;
    host({ command: 'readAloudConfig', textSize: 26 });
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-measure'),
      '34.32em',
    );
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-line-height'),
      '1.45',
    );
  });

  test('booting with `light` under a dark VS Code is light', async function () {
    boot({
      config: { globalTheme: 'light' },
      bodyClass: 'vscode-dark',
      prefersDark: true,
    });
    await sleep(60);
    assert.strictEqual(html().getAttribute('data-mpe-ra-page'), 'light');
    assert.strictEqual(root().getAttribute('data-mpe-ra-scheme'), 'light');
    assert.strictEqual(bar().getAttribute('data-mpe-ra-scheme'), 'light');
  });

  test('`off` sets nothing and the scheme is read from the background as before', async function () {
    boot({
      config: { globalTheme: 'off', textSize: 16 },
      bodyStyle: 'background: #000',
    });
    await sleep(60);
    assert.strictEqual(html().hasAttribute('data-mpe-ra-page'), false);
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-text-size'),
      '',
    );
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-line-height'),
      '',
    );
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-measure'),
      '',
    );
    assert.strictEqual(root().getAttribute('data-mpe-ra-scheme'), 'dark');
    assert.strictEqual(bar().getAttribute('data-mpe-ra-scheme'), 'dark');
  });

  test('`auto` follows the VS Code body classes live, with no message from the host', async function () {
    boot({ config: { globalTheme: 'auto' }, bodyClass: 'vscode-dark' });
    await sleep(60);
    assert.strictEqual(html().getAttribute('data-mpe-ra-page'), 'dark');
    const before = posted.length;
    doc.body.className = 'preview-container vscode-light';
    await sleep(30);
    assert.strictEqual(html().getAttribute('data-mpe-ra-page'), 'light');
    assert.strictEqual(root().getAttribute('data-mpe-ra-scheme'), 'light');
    assert.strictEqual(bar().getAttribute('data-mpe-ra-scheme'), 'light');
    assert.strictEqual(posted.length, before, 'nothing was posted');
    // A forced theme ignores the body classes.
    host({ command: 'readAloudConfig', globalTheme: 'dark' });
    doc.body.className = 'preview-container vscode-light';
    await sleep(30);
    assert.strictEqual(html().getAttribute('data-mpe-ra-page'), 'dark');
  });

  test('`auto` with no body class follows prefers-color-scheme', async function () {
    boot({ config: { globalTheme: 'auto' }, prefersDark: true });
    await sleep(60);
    assert.strictEqual(html().getAttribute('data-mpe-ra-page'), 'dark');
    setPrefersDark(false);
    assert.strictEqual(html().getAttribute('data-mpe-ra-page'), 'light');
    assert.strictEqual(root().getAttribute('data-mpe-ra-scheme'), 'light');
  });

  test('the segmented control: three radios, the current one checked; a click switches at once and persists', async function () {
    boot({ config: { globalTheme: 'auto' }, bodyClass: 'vscode-dark' });
    await sleep(60);
    openSheet();
    const radios = Array.from(
      sheet().querySelectorAll(
        '.mpe-ra-seg:not(.mpe-ra-seg-marker) [role="radio"]',
      ),
    );
    assert.deepStrictEqual(
      radios.map((el) => el.getAttribute('data-mpe-ra-page-choice')),
      ['auto', 'light', 'dark'],
    );
    assert.deepStrictEqual(
      radios.map((el) => el.textContent),
      ['Auto', 'Light', 'Dark'],
    );
    assert.strictEqual(
      sheet()
        .querySelector('.mpe-ra-seg:not(.mpe-ra-seg-marker)')
        .getAttribute('role'),
      'radiogroup',
    );
    assert.strictEqual(segment('auto').getAttribute('aria-checked'), 'true');
    assert.strictEqual(segment('light').getAttribute('aria-checked'), 'false');
    // The sheet's label for the page is the reference's.
    const labels = Array.from(
      sheet().querySelectorAll('.mpe-ra-sheet-label'),
    ).map((el) => el.firstChild.textContent);
    assert.strictEqual(labels[0], 'Global theme');

    click(segment('light'));
    assert.strictEqual(html().getAttribute('data-mpe-ra-page'), 'light');
    assert.strictEqual(root().getAttribute('data-mpe-ra-scheme'), 'light');
    assert.strictEqual(bar().getAttribute('data-mpe-ra-scheme'), 'light');
    assert.strictEqual(segment('light').getAttribute('aria-checked'), 'true');
    assert.strictEqual(segment('auto').getAttribute('aria-checked'), 'false');
    assert.deepStrictEqual(
      posts('readAloudSetGlobalTheme').map((m) => Array.from(m.args)),
      [['light']],
    );
    assert.strictEqual(sheet().hidden, false, 'the sheet stays open');
    // Every swatch follows the page's scheme.
    for (const swatch of sheet().querySelectorAll('.mpe-ra-swatch')) {
      assert.strictEqual(swatch.getAttribute('data-mpe-ra-scheme'), 'light');
    }
  });

  test('with `off` from the host no segment is checked and the text size slider is disabled; a segment turns the page on', async function () {
    boot({ config: { globalTheme: 'dark' } });
    await sleep(60);
    openSheet();
    const size = sheet().querySelector('.mpe-ra-sheet-size');
    const hint = sheet().querySelector('.mpe-ra-sheet-hint');
    assert.strictEqual(hint.hidden, true);
    assert.strictEqual(size.disabled, false);

    host({ command: 'readAloudConfig', globalTheme: 'off' });
    assert.strictEqual(html().hasAttribute('data-mpe-ra-page'), false);
    for (const name of ['auto', 'light', 'dark']) {
      assert.strictEqual(segment(name).getAttribute('aria-checked'), 'false');
    }
    assert.strictEqual(size.disabled, true);
    // The label still shows the value (07 §5.6).
    assert.strictEqual(labelOf(size), 'Text size: 20 px');
    // The word marker needs no page and stays enabled (07 §9.3).
    for (const button of sheet().querySelectorAll(
      '.mpe-ra-seg-marker button',
    )) {
      assert.strictEqual(button.disabled, false);
    }
    assert.strictEqual(hint.hidden, false);
    assert.ok(/^Off in Settings/.test(hint.textContent));
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-sheet-font option').textContent,
      'Default — preview theme',
    );

    click(segment('dark'));
    assert.strictEqual(html().getAttribute('data-mpe-ra-page'), 'dark');
    assert.strictEqual(segment('dark').getAttribute('aria-checked'), 'true');
    assert.strictEqual(size.disabled, false);
    assert.strictEqual(hint.hidden, true);
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-sheet-font option').textContent,
      'Default — Atkinson Hyperlegible',
    );
    assert.deepStrictEqual(
      Array.from(posts('readAloudSetGlobalTheme').pop().args),
      ['dark'],
    );
  });

  test('the text size slider writes the three properties, and a hand-edited 23 is shown as 23 px', async function () {
    boot({ config: { globalTheme: 'light', textSize: 20 } });
    await sleep(60);
    openSheet();
    const range = sheet().querySelector('.mpe-ra-sheet-size');
    assert.strictEqual(labelOf(range), 'Text size: 20 px');
    slide(range, 18);
    slide(range, 17);
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-text-size'),
      '17',
    );
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-line-height'),
      '1.68',
    );
    assert.strictEqual(labelOf(range), 'Text size: 17 px');
    assert.strictEqual(range.getAttribute('aria-valuetext'), '17 pixels');
    assert.strictEqual(range.value, '17');
    await sleep(400);
    assert.deepStrictEqual(
      posts('readAloudSetTextSize').map((m) => Array.from(m.args)),
      [[17]],
    );
    host({ command: 'readAloudConfig', textSize: 23 });
    assert.strictEqual(labelOf(range), 'Text size: 23 px');
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-line-height'),
      '1.53',
    );
  });

  test('Reset posts readAloudResetPage, leaves the zoom alone and the host config restores the sheet', async function () {
    boot({ config: { globalTheme: 'dark', textSize: 28, wordMarker: 'box' } });
    await sleep(60);
    openSheet();
    // crossnote's own zoom is not the sheet's any more (07 §5.7).
    doc.body.style.zoom = '1.3';
    const reset = sheet().querySelector('.mpe-ra-sheet-reset');
    assert.strictEqual(reset.textContent, 'Reset page settings');
    click(reset);
    assert.deepStrictEqual(
      posts('readAloudResetPage').map((m) => Array.from(m.args)),
      [[]],
    );
    assert.strictEqual(doc.body.style.zoom, '1.3', 'the zoom stays');
    assert.strictEqual(sheet().hidden, false);
    host({
      command: 'readAloudConfig',
      globalTheme: 'auto',
      textSize: 20,
      wordMarker: 'underline',
      font: 'default',
    });
    assert.strictEqual(segment('auto').getAttribute('aria-checked'), 'true');
    assert.strictEqual(
      labelOf(sheet().querySelector('.mpe-ra-sheet-size')),
      'Text size: 20 px',
    );
    assert.strictEqual(
      html().style.getPropertyValue('--mpe-ra-page-line-height'),
      '1.6',
    );
    assert.strictEqual(root().getAttribute('data-mpe-ra-marker'), 'underline');
    // The guidance caption is there and is not a control.
    const note = sheet().querySelector('.mpe-ra-sheet-note');
    assert.ok(/20 minutes/.test(note.textContent));
    assert.strictEqual(note.querySelector('button'), null);
  });

  test('a render that rewrites the root class attribute gets the player classes back', async function () {
    boot({ config: { globalTheme: 'dark', font: 'georgia' } });
    await sleep(60);
    const before = root().className;
    for (const name of [
      'mpe-ra-canvas',
      'mpe-ra-click',
      'mpe-ra-panel',
      'mpe-ra-font',
    ]) {
      assert.ok(root().classList.contains(name), name + ' before');
    }
    // What crossnote's React root does on every render, child nodes untouched.
    root().setAttribute('class', 'crossnote markdown-preview system-dark');
    await sleep(30);
    for (const name of [
      'mpe-ra-canvas',
      'mpe-ra-click',
      'mpe-ra-panel',
      'mpe-ra-font',
    ]) {
      assert.ok(root().classList.contains(name), name + ' after');
    }
    assert.ok(
      root().classList.contains('system-dark'),
      'crossnote keeps its own',
    );
    assert.strictEqual(
      root().className.split(' ').sort().join(' '),
      (before + ' system-dark').split(' ').sort().join(' '),
    );
    // Restoring is idempotent: no further mutation churn.
    const snapshot = root().className;
    await sleep(30);
    assert.strictEqual(root().className, snapshot);
  });

  test('the pill text token is the page text colour on the page, and #000000 off it', function () {
    // jsdom does not cascade custom properties, so the rules are read as text.
    const onPage =
      /html\[data-mpe-ra-page\] body \[data-mpe-ra-theme\]\s*\{([^}]*)\}/.exec(
        PAGE_CSS,
      );
    assert.ok(onPage, 'the page overrides the pill text token');
    assert.ok(/--mpe-ra-text:\s*var\(--text\)/.test(onPage[1]));
    assert.ok(
      /html\[data-mpe-ra-page='light'\]\s*\{[^}]*--text:\s*#2b2b2b/.test(
        PAGE_CSS,
      ),
    );
    assert.ok(
      /html\[data-mpe-ra-page='dark'\]\s*\{[^}]*--text:\s*#e6e6e6/.test(
        PAGE_CSS,
      ),
    );
    const offPage = /\[data-mpe-ra-theme='blue'\]\s*\{([^}]*)\}/.exec(
      PLAYER_CSS,
    );
    assert.ok(/--mpe-ra-text:\s*#000000/.test(offPage[1]));
    // The panel takes a tokenised surface on the page (D11).
    assert.ok(
      /html\[data-mpe-ra-page\] body \.mpe-ra-bar\s*\{[^}]*--mpe-ra-panel-bg:\s*var\(--panel-surface\)/.test(
        PAGE_CSS,
      ),
    );
  });

  test('regression guard: with `off` the sheet and the root behave exactly as before 05', async function () {
    boot({
      config: { globalTheme: 'off', highlightTheme: 'green', font: 'georgia' },
      bodyStyle: 'background: #1d1f21',
    });
    await sleep(60);
    openSheet();
    assert.strictEqual(html().hasAttribute('data-mpe-ra-page'), false);
    assert.strictEqual(root().getAttribute('data-mpe-ra-theme'), 'green');
    assert.strictEqual(root().getAttribute('data-mpe-ra-scheme'), 'dark');
    assert.ok(root().classList.contains('mpe-ra-canvas'));
    assert.ok(root().classList.contains('mpe-ra-font'));
    assert.ok(
      /^Georgia,/.test(root().style.getPropertyValue('--mpe-ra-font-family')),
    );
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-sheet-font').value,
      'georgia',
    );
    // The rows are there, in order (07 §14).
    const labels = Array.from(
      sheet().querySelectorAll('.mpe-ra-sheet-label'),
    ).map((el) => el.firstChild.textContent);
    assert.strictEqual(labels[1], 'Player font');
    assert.strictEqual(labels[2], 'Text size: 20 px');
    assert.strictEqual(labels[3], 'Word marker');
    assert.strictEqual(labels[4], 'Player highlight theme');
    // The marker applies with the page off, like the palettes (07 §9.1).
    assert.strictEqual(root().getAttribute('data-mpe-ra-marker'), 'underline');
    // Choosing a palette and a font still repaints and persists.
    click(sheet().querySelector('[data-mpe-ra-theme-choice="red"]'));
    assert.strictEqual(root().getAttribute('data-mpe-ra-theme'), 'red');
    assert.deepStrictEqual(
      Array.from(posts('readAloudSetHighlightTheme').pop().args),
      ['red'],
    );
    // The scheme still comes from the background, not from a page.
    doc.body.style.background = '#ffffff';
    host({ command: 'readAloudConfig', highlightTheme: 'blue' });
    assert.strictEqual(root().getAttribute('data-mpe-ra-scheme'), 'light');
    assert.strictEqual(html().hasAttribute('data-mpe-ra-page'), false);
  });
});
