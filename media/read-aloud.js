/*
 * Read aloud (Kokoro) — preview app (spec F1, F2, F3, F4, F13, F15, F17 webview side).
 *
 * Injected into the live preview only (never into an export) through the `head`
 * argument of generateHTMLTemplateForPreview, next to media/read-aloud.css and
 * after media/read-aloud-core.js, which holds the pure DOM helpers.
 *
 * All player state lives in this closure. The DOM only carries the transient
 * reading decoration (line pills and the spoken-word spans) that section 6
 * adds for the block being read and removes again when the read ends.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Share the single VS Code API instance with crossnote's own preview.js
  //    (`acquireVsCodeApi` may be called once per session). This has to happen
  //    before preview.js runs, which is why the script is injected without
  //    `defer` — see the contract, decision A.
  // ---------------------------------------------------------------------------

  var vscodeApi = null;
  if (
    typeof window !== 'undefined' &&
    typeof window.acquireVsCodeApi === 'function'
  ) {
    var acquireOriginal = window.acquireVsCodeApi;
    window.acquireVsCodeApi = function () {
      if (!vscodeApi) {
        vscodeApi = acquireOriginal();
      }
      return vscodeApi;
    };
  }

  var core = window.MpeReadAloudCore;
  if (!core) {
    return;
  }

  // ---------------------------------------------------------------------------
  // 2. Constants
  // ---------------------------------------------------------------------------

  var SPEED_STOPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
  var SPEED_MIN = 0.25;
  var SPEED_MAX = 4;
  var VOLUME_MIN = 0;
  var VOLUME_MAX = 1;
  // The control panel's skip buttons (F3): ±10 s, bounded to the block being
  // read — a rewind past its first word restarts the block, a forward past
  // its last word does nothing.
  var SEEK_SECONDS = 10;
  var ERROR_DISPLAY_MS = 4000;
  var FINISH_DISPLAY_MS = 4000;
  var HINT_MS = 2500;
  var SPEED_DEBOUNCE_MS = 300;
  var VOLUME_DEBOUNCE_MS = 300;
  var SELECTION_SETTLE_MS = 150;
  var USER_SCROLL_IDLE_MS = 3000;
  var PROGRAMMATIC_SCROLL_MS = 1200;
  var GUTTER_MIN_PX = 28;
  // Click to read (F17): wait out the double-click window before starting.
  var CLICK_READ_DELAY_MS = 250;
  // Class on the preview root while click to read is on: playable text
  // shows a pointer (media/read-aloud.css).
  var CLICK_CLASS = 'mpe-ra-click';
  // Classes on the preview root: the reading canvas (one vertical rhythm for
  // read and unread text alike) and the bottom padding that keeps the control
  // panel off the last lines.
  var CANVAS_CLASS = 'mpe-ra-canvas';
  var PANEL_CLASS = 'mpe-ra-panel';
  // Tailwind's `fixed`, which crossnote's zoom effect looks for: it divides
  // the body zoom out again on every element that carries it, so the panel
  // keeps its size on screen while the text zooms in and out.
  var UNZOOM_CLASS = 'fixed';
  // Media elements (autoplay policy, see section 11a): two <audio> elements
  // reused for every chunk, unlocked on the user's gesture with 100 ms of
  // silence (8 kHz, 8-bit mono wav).
  var MEDIA_POOL_SIZE = 2;
  var SILENT_WAV =
    'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

  // Codes that need no UI: a cancelled job, and text with nothing to say.
  var SILENT_CODES = {
    cancelled: true,
    empty_text: true,
  };

  // Control panel glyphs (F3). Own markup, no font and no network: the
  // webview's CSP allows inline SVG and nothing else would load.
  var STROKE =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none"' +
    ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round"' +
    ' stroke-linejoin="round">';
  var FILL =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"' +
    ' fill="currentColor">';
  var SPEAKER =
    '<path fill="currentColor" stroke="none" d="M11.4 4.8 6.5 8.9H3.7a.7.7 0' +
    ' 0 0-.7.7v4.8a.7.7 0 0 0 .7.7h2.8l4.9 4.1a.6.6 0 0 0 1-.46V5.26a.6.6 0' +
    ' 0 0-1-.46Z"/>';
  var ICONS = {
    play:
      FILL +
      '<path d="M8.2 5.1v13.8a.8.8 0 0 0 1.23.67l10.4-6.9a.8.8 0 0 0 0-1.34L9.43 4.43A.8.8 0 0 0 8.2 5.1Z"/></svg>',
    pause:
      FILL +
      '<rect x="7.6" y="5" width="3.4" height="14" rx="1.2"/>' +
      '<rect x="13" y="5" width="3.4" height="14" rx="1.2"/></svg>',
    loading:
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"' +
      ' fill="none" stroke="currentColor" stroke-width="2.2"' +
      ' stroke-linecap="round">' +
      '<circle cx="12" cy="12" r="8" stroke-opacity=".35"/>' +
      '<path d="M20 12a8 8 0 0 0-8-8"/></svg>',
    volumeHigh:
      STROKE +
      SPEAKER +
      '<path d="M15.5 9.3a4 4 0 0 1 0 5.4"/>' +
      '<path d="M18.3 6.7a8 8 0 0 1 0 10.6"/></svg>',
    volumeLow: STROKE + SPEAKER + '<path d="M15.5 9.3a4 4 0 0 1 0 5.4"/></svg>',
    volumeMute:
      STROKE + SPEAKER + '<path d="m16.4 9.6 5 4.8m0-4.8-5 4.8"/></svg>',
    // Placeholder for the voice-model chooser (a chip): the panel keeps its
    // slot until the chooser itself is built.
    model:
      STROKE +
      '<rect x="7" y="7" width="10" height="10" rx="2.2"/>' +
      '<rect x="10.2" y="10.2" width="3.6" height="3.6" rx="1"/>' +
      '<path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3"/>' +
      '</svg>',
    back10:
      STROKE +
      '<path d="M3.6 12a8.4 8.4 0 1 0 8.4-8.4 9.1 9.1 0 0 0-6.3 2.56L3.6 8.4"/>' +
      '<path d="M3.6 3.6v4.8h4.8"/>' +
      '<text x="12.4" y="15.3" text-anchor="middle" font-size="8"' +
      ' font-weight="700" fill="currentColor" stroke="none">10</text></svg>',
    forward10:
      STROKE +
      '<path d="M20.4 12a8.4 8.4 0 1 1-8.4-8.4 9.1 9.1 0 0 1 6.3 2.56L20.4 8.4"/>' +
      '<path d="M20.4 3.6v4.8h-4.8"/>' +
      '<text x="11.6" y="15.3" text-anchor="middle" font-size="8"' +
      ' font-weight="700" fill="currentColor" stroke="none">10</text></svg>',
    close: STROKE + '<path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8"/></svg>',
  };

  var NAV_KEYS = {
    'ArrowUp': true,
    'ArrowDown': true,
    'PageUp': true,
    'PageDown': true,
    'Home': true,
    'End': true,
    ' ': true,
  };

  // ---------------------------------------------------------------------------
  // 3. Closure state
  // ---------------------------------------------------------------------------

  var config = {
    enabled: true,
    clickToRead: true,
    speed: 1,
    volume: 1,
    voiceName: '',
    modelId: '',
    highlightTheme: core.DEFAULT_HIGHLIGHT_THEME,
  };
  try {
    if (
      document.currentScript &&
      document.currentScript.dataset &&
      document.currentScript.dataset.config
    ) {
      var parsed = JSON.parse(document.currentScript.dataset.config);
      if (parsed && typeof parsed === 'object') {
        config.enabled = parsed.enabled !== false;
        config.clickToRead = parsed.clickToRead !== false;
        config.speed = normaliseRate(parsed.speed);
        config.volume = normaliseVolume(parsed.volume);
        config.voiceName =
          typeof parsed.voiceName === 'string' ? parsed.voiceName : '';
        config.modelId =
          typeof parsed.modelId === 'string' ? parsed.modelId : '';
        config.highlightTheme = core.normaliseHighlightTheme(
          parsed.highlightTheme,
        );
      }
    }
  } catch (error) {
    /* a malformed data-config must never break the preview */
  }

  var sourceUri = '';
  var root = null;
  var blocks = [];
  var blocksByKey = Object.create(null);
  var blocksByElement = new Map();
  var rate = config.speed;
  var volume = config.volume;
  var requestCounter = 0;

  var rootObserver = null;
  var bodyObserver = null;
  var viewportObserver = null;
  var decorateScheduled = false;

  var bar = null;
  var barParts = null;
  // The user closed the panel with its × ; it comes back with the next read.
  var panelDismissed = false;
  var floatButton = null;
  var hintElement = null;

  var errorTimer = 0;
  var finishTimer = 0;
  var hintTimer = 0;
  var speedTimer = 0;
  var volumeTimer = 0;
  var selectionTimer = 0;

  var lastUserScrollAt = 0;
  var programmaticScrollUntil = 0;
  var floatSelection = null;
  var floatRect = null;
  var pendingClick = null;
  var mediaPool = null;
  // Whether the last gesture was a key press: a popover opened from the
  // keyboard takes focus (and shows a focus ring on the slider's thumb), one
  // opened with the mouse does not.
  var lastGestureWasKey = false;

  var record = emptyRecord();

  function emptyRecord() {
    return {
      state: 'idle',
      requestId: null,
      kind: null,
      blockEl: null,
      blockEls: [],
      // The blocks of the read in document order (F15, decision 5), each
      // `{ key, el, start, end, startOffset, label, missing }`: `key` is the
      // content hash (null for a table cell), [start, end) the block's range
      // of record.text, `startOffset` where the first block's text starts in
      // its element's whole text (a click on a word, F17). Empty for a drag
      // selection, which can neither seek nor survive a re-render.
      readBlocks: [],
      // Index into readBlocks of the block that carries the decoration and
      // the button state; −1 for a drag selection.
      blockIndex: -1,
      wordSpans: [],
      label: '',
      text: '',
      map: null,
      chunks: [],
      chunkCount: 0,
      current: -1,
      offsets: [],
      allSpans: [],
      spanIndex: 0,
      lastSpan: null,
      rafId: 0,
      errorCode: '',
      errorMessage: '',
    };
  }

  // ---------------------------------------------------------------------------
  // 4. Host messaging (F13)
  // ---------------------------------------------------------------------------

  function getApi() {
    if (!vscodeApi && typeof window.acquireVsCodeApi === 'function') {
      try {
        vscodeApi = window.acquireVsCodeApi();
      } catch (error) {
        vscodeApi = null;
      }
    }
    return vscodeApi;
  }

  function post(command, args) {
    var api = getApi();
    if (!api) {
      return;
    }
    try {
      api.postMessage({ command: command, args: args });
    } catch (error) {
      /* the panel may be going away */
    }
  }

  function readSourceUriFromPage() {
    try {
      var meta = document.getElementById('crossnote-data');
      if (meta && meta.dataset && meta.dataset.config) {
        var data = JSON.parse(meta.dataset.config);
        if (data && typeof data.sourceUri === 'string') {
          return data.sourceUri;
        }
      }
    } catch (error) {
      /* fall through */
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // 5. Small helpers
  // ---------------------------------------------------------------------------

  function normaliseRate(value) {
    var number = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(number)) {
      return 1;
    }
    if (number < SPEED_MIN) {
      number = SPEED_MIN;
    }
    if (number > SPEED_MAX) {
      number = SPEED_MAX;
    }
    return Math.round(number * 100) / 100;
  }

  function normaliseVolume(value) {
    var number = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(number)) {
      return 1;
    }
    if (number < VOLUME_MIN) {
      number = VOLUME_MIN;
    }
    if (number > VOLUME_MAX) {
      number = VOLUME_MAX;
    }
    return Math.round(number * 100) / 100;
  }

  function formatTime(seconds) {
    var value = isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    var minutes = Math.floor(value / 60);
    var rest = value % 60;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest;
  }

  function clearTimer(id) {
    if (id) {
      clearTimeout(id);
    }
    return 0;
  }

  function base64ToBlob(base64, mimeType) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType || 'audio/mpeg' });
  }

  function entryForElement(el) {
    return el ? blocksByElement.get(el) || null : null;
  }

  /**
   * A chunk's length in seconds: the element's own duration once it has been
   * loaded, else the host's estimate, else nothing.
   */
  function chunkLength(chunk) {
    if (!chunk) {
      return 0;
    }
    if (typeof chunk.duration === 'number' && isFinite(chunk.duration)) {
      return chunk.duration;
    }
    if (
      typeof chunk.durationHint === 'number' &&
      isFinite(chunk.durationHint)
    ) {
      return chunk.durationHint;
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // 6. Reading decoration (F4): line pills, the spoken word, the colour theme
  // ---------------------------------------------------------------------------

  /**
   * Run a DOM mutation of our own without waking the root MutationObserver:
   * records queued before the call are still honoured, records the call
   * produces are dropped. Cheaper and safer than teaching isSelfMutation to
   * recognise split text nodes.
   */
  function mutateSilently(fn) {
    if (rootObserver) {
      var pending = rootObserver.takeRecords();
      if (pending.length && !isSelfMutation(pending)) {
        scheduleDecorate();
      }
    }
    try {
      fn();
    } finally {
      if (rootObserver) {
        rootObserver.takeRecords();
      }
    }
  }

  /**
   * 'dark' or 'light' from the preview's effective background: the nearest
   * ancestor of the root with an opaque background colour (the preview theme
   * sets it on <body>), then VS Code's body classes, then the OS preference.
   */
  function detectScheme() {
    var el = root;
    while (el) {
      var luminance = null;
      try {
        luminance = core.backgroundLuminance(
          window.getComputedStyle(el).backgroundColor,
        );
      } catch (error) {
        luminance = null;
      }
      if (luminance !== null) {
        return luminance < 0.5 ? 'dark' : 'light';
      }
      el = el.parentElement;
    }
    var classes = document.body ? document.body.className : '';
    if (/\bvscode-high-contrast-light\b/.test(classes)) {
      return 'light';
    }
    if (/\bvscode-(dark|high-contrast)\b/.test(classes)) {
      return 'dark';
    }
    if (/\bvscode-light\b/.test(classes)) {
      return 'light';
    }
    if (
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
      return 'dark';
    }
    return 'light';
  }

  /** Publish the theme and scheme to CSS through attributes on the root. */
  function applyThemeAttributes() {
    if (!root) {
      return;
    }
    root.setAttribute('data-mpe-ra-theme', config.highlightTheme);
    root.setAttribute('data-mpe-ra-scheme', detectScheme());
    applyBarScheme();
  }

  function removeThemeAttributes() {
    if (root) {
      root.removeAttribute('data-mpe-ra-theme');
      root.removeAttribute('data-mpe-ra-scheme');
    }
  }

  /** Pill the lines of the blocks being read (idempotent). */
  function decorateBlocks(els) {
    if (!els || !els.length) {
      return;
    }
    mutateSilently(function () {
      for (var i = 0; i < els.length; i++) {
        try {
          core.decorateReadingBlock(els[i]);
        } catch (error) {
          /* a detached or foreign node must not stop the read */
        }
      }
    });
  }

  function undecorateBlocks(els) {
    if (!els || !els.length) {
      return;
    }
    mutateSilently(function () {
      for (var i = 0; i < els.length; i++) {
        try {
          core.undecorateReadingBlock(els[i]);
        } catch (error) {
          /* ignore */
        }
      }
    });
  }

  /** Unwrap the current word and merge its text nodes back (map stays valid). */
  function clearWordBox() {
    var spans = record.wordSpans;
    record.wordSpans = [];
    if (!spans || !spans.length) {
      return;
    }
    mutateSilently(function () {
      try {
        core.unwrapSpans(spans);
      } catch (error) {
        /* ignore */
      }
    });
  }

  function clearReadingDecoration() {
    clearWordBox();
    var els = record.blockEls;
    record.blockEls = [];
    undecorateBlocks(els);
    record.lastSpan = null;
  }

  /**
   * Paint one word: unwrap the previous one first, so the offset map (built on
   * the unsplit text nodes) resolves, then wrap the new range. Every DOM call
   * is guarded: a throw would escape the rAF callback and silently stop the
   * highlight loop for the rest of the read.
   */
  function paintSpan(span) {
    clearWordBox();
    if (!span || !record.map) {
      return;
    }
    var spans = [];
    try {
      // The DOM changes between words; a Range cached on the span is stale.
      span._range = null;
      span._rangeMap = null;
      var range = core.spanToRange(record.map, span, document);
      if (!range) {
        return;
      }
      mutateSilently(function () {
        spans = core.wrapRange(range, core.WORD_CLASS);
      });
    } catch (error) {
      /* a stale map or a detached node must not stop playback */
    }
    record.wordSpans = spans;
    if (spans.length) {
      maybeScrollTo(spans[0]);
    }
  }

  function maybeScrollTo(el) {
    if (Date.now() - lastUserScrollAt < USER_SCROLL_IDLE_MS) {
      return;
    }
    var rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (error) {
      return;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return;
    }
    var viewport = window.innerHeight || document.documentElement.clientHeight;
    if (rect.top >= 0 && rect.bottom <= viewport) {
      return;
    }
    if (!el.scrollIntoView) {
      return;
    }
    programmaticScrollUntil = Date.now() + PROGRAMMATIC_SCROLL_MS;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ---------------------------------------------------------------------------
  // 7. Control panel (F3)
  //
  // A pill at the bottom centre of the preview, in the geometry of a reader
  // app: volume, voice model (a placeholder until the chooser is built),
  // −10 s, play/pause, +10 s, speed and close. It is on screen whenever read
  // aloud is enabled — pressing play with nothing loaded starts a read at the
  // first block in view — and the × puts it away until the next read.
  //
  // The panel carries Tailwind's `fixed`, which crossnote's zoom effect uses
  // to divide the body zoom out again, so the panel keeps its size on screen
  // while the text zooms; everything the panel measures is in px for that
  // reason, and everything the canvas measures is in em.
  // ---------------------------------------------------------------------------

  function makeButton(action, label, className) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'mpe-ra-ui ' + className;
    button.setAttribute('data-mpe-ra-action', action);
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    return button;
  }

  /** Swap a button's glyph, by name, only when it actually changes. */
  function setIcon(button, name) {
    if (!button || button.getAttribute('data-icon') === name) {
      return;
    }
    button.setAttribute('data-icon', name);
    button.innerHTML = ICONS[name];
  }

  function makeIconButton(action, label, className, icon) {
    var button = makeButton(action, label, className);
    setIcon(button, icon);
    return button;
  }

  /**
   * One popover in the style of the reference: a label, a slider and the
   * value in its own rounded box. `format` turns the raw number into what
   * the box shows.
   */
  function makePopover(className, labelText, min, max, step) {
    var popover = document.createElement('div');
    popover.className = 'mpe-ra-ui mpe-ra-pop ' + className;
    popover.hidden = true;

    var label = document.createElement('span');
    label.className = 'mpe-ra-pop-label';
    label.textContent = labelText;

    var range = document.createElement('input');
    range.className = 'mpe-ra-ui mpe-ra-pop-range';
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.setAttribute('aria-label', labelText);

    var value = document.createElement('span');
    value.className = 'mpe-ra-pop-value';

    popover.appendChild(label);
    popover.appendChild(range);
    popover.appendChild(value);
    return { root: popover, range: range, value: value };
  }

  function ensureBar() {
    if (bar && bar.isConnected) {
      return bar;
    }
    bar = document.createElement('div');
    bar.className = 'mpe-ra-bar mpe-ra-ui ' + UNZOOM_CLASS;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Read aloud player');
    bar.setAttribute('tabindex', '0');
    bar.hidden = true;

    var progress = document.createElement('div');
    progress.className = 'mpe-ra-bar-progress';
    var progressFill = document.createElement('i');
    progress.appendChild(progressFill);

    var status = document.createElement('div');
    status.className = 'mpe-ra-bar-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    var volumePop = makePopover('mpe-ra-pop-volume', 'Volume', 0, 1, 0.05);
    var speedPop = makePopover(
      'mpe-ra-pop-speed',
      'Reading speed',
      SPEED_MIN,
      SPEED_MAX,
      0.05,
    );

    var volumeButton = makeIconButton(
      'volume',
      'Volume',
      'mpe-ra-bar-btn mpe-ra-bar-volume',
      'volumeHigh',
    );
    volumeButton.setAttribute('aria-haspopup', 'true');
    volumeButton.setAttribute('aria-expanded', 'false');

    var model = makeIconButton(
      'model',
      'Voice model (coming soon)',
      'mpe-ra-bar-btn mpe-ra-bar-model',
      'model',
    );
    model.setAttribute('aria-disabled', 'true');

    var back = makeIconButton(
      'back10',
      'Back 10 seconds',
      'mpe-ra-bar-btn mpe-ra-bar-back10',
      'back10',
    );
    var play = makeIconButton(
      'play',
      'Play',
      'mpe-ra-bar-btn mpe-ra-bar-play',
      'play',
    );
    play.setAttribute('data-state', 'idle');
    var forward = makeIconButton(
      'forward10',
      'Forward 10 seconds',
      'mpe-ra-bar-btn mpe-ra-bar-forward10',
      'forward10',
    );

    var speedButton = makeButton(
      'speed',
      'Reading speed',
      'mpe-ra-bar-btn mpe-ra-bar-speed',
    );
    speedButton.setAttribute('aria-haspopup', 'true');
    speedButton.setAttribute('aria-expanded', 'false');

    var close = makeIconButton(
      'close',
      'Close the player',
      'mpe-ra-bar-btn mpe-ra-bar-close',
      'close',
    );

    bar.appendChild(progress);
    bar.appendChild(status);
    bar.appendChild(volumePop.root);
    bar.appendChild(speedPop.root);
    bar.appendChild(volumeButton);
    bar.appendChild(model);
    bar.appendChild(back);
    bar.appendChild(play);
    bar.appendChild(forward);
    bar.appendChild(speedButton);
    bar.appendChild(close);
    document.body.appendChild(bar);

    barParts = {
      progress: progress,
      progressFill: progressFill,
      status: status,
      volume: volumeButton,
      volumePop: volumePop,
      model: model,
      back: back,
      play: play,
      forward: forward,
      speed: speedButton,
      speedPop: speedPop,
      close: close,
    };

    speedPop.range.addEventListener('input', function () {
      applyRate(parseFloat(speedPop.range.value), true, speedPop.range);
    });
    volumePop.range.addEventListener('input', function () {
      applyVolume(parseFloat(volumePop.range.value), true, volumePop.range);
    });
    bar.addEventListener('keydown', onBarKeydown);

    applyBarScheme();
    syncSpeedControls();
    syncVolumeControls();
    renderBar();
    return bar;
  }

  /** The panel takes its light/dark palette from the preview background. */
  function applyBarScheme() {
    if (!bar || !root) {
      return;
    }
    var scheme = root.getAttribute('data-mpe-ra-scheme');
    if (scheme) {
      bar.setAttribute('data-mpe-ra-scheme', scheme);
    }
  }

  function setRangeFill(range, fraction) {
    try {
      range.style.setProperty(
        '--mpe-ra-range-fill',
        Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%',
      );
    } catch (error) {
      /* jsdom and old engines drop custom properties; cosmetic only */
    }
  }

  function formatRate(value) {
    return String(Math.round(value * 100) / 100);
  }

  /**
   * `from` is the slider the value came from, if any: writing a value back
   * into the input the user is dragging makes the thumb stutter.
   */
  function syncSpeedControls(from) {
    if (!barParts) {
      return;
    }
    barParts.speed.textContent = formatRate(rate) + '×';
    barParts.speed.setAttribute(
      'title',
      'Reading speed: ' + formatRate(rate) + '×',
    );
    barParts.speed.setAttribute(
      'aria-label',
      'Reading speed: ' + formatRate(rate) + ' times',
    );
    if (barParts.speedPop.range !== from) {
      barParts.speedPop.range.value = String(rate);
    }
    barParts.speedPop.value.textContent = formatRate(rate);
    setRangeFill(
      barParts.speedPop.range,
      (rate - SPEED_MIN) / (SPEED_MAX - SPEED_MIN),
    );
  }

  function syncVolumeControls(from) {
    if (!barParts) {
      return;
    }
    var percent = Math.round(volume * 100);
    setIcon(
      barParts.volume,
      volume === 0 ? 'volumeMute' : volume < 0.5 ? 'volumeLow' : 'volumeHigh',
    );
    barParts.volume.setAttribute('title', 'Volume: ' + percent + '%');
    barParts.volume.setAttribute(
      'aria-label',
      'Volume: ' + percent + ' percent',
    );
    if (barParts.volumePop.range !== from) {
      barParts.volumePop.range.value = String(volume);
    }
    barParts.volumePop.value.textContent = percent + '%';
    setRangeFill(barParts.volumePop.range, volume);
  }

  function setEnabled(button, enabled) {
    if (!button) {
      return;
    }
    button.disabled = !enabled;
  }

  /** Whether the panel belongs on screen at all. */
  function barVisible() {
    return config.enabled && !panelDismissed;
  }

  /** Play, pause, skip and progress, from `record`. */
  function renderBar() {
    if (!barParts) {
      return;
    }
    var state = record.state;
    setIcon(
      barParts.play,
      state === 'playing' ? 'pause' : state === 'loading' ? 'loading' : 'play',
    );
    barParts.play.setAttribute('data-state', state);
    var action = state === 'playing' ? 'Pause' : 'Play';
    barParts.play.setAttribute('aria-label', action);
    barParts.play.setAttribute(
      'title',
      record.label ? action + ' — ' + record.label : action,
    );
    syncSeekButtons();
    syncSpeedControls();
    syncVolumeControls();
    updateTimeDisplay();
    applyCanvasClasses();
  }

  function showBar(statusText) {
    ensureBar();
    finishTimer = clearTimer(finishTimer);
    bar.hidden = !barVisible();
    barParts.status.textContent = statusText || '';
    renderBar();
  }

  /**
   * The read is over: the panel stays, with its controls back in the idle
   * state and nothing to say. Only `dismissBar` takes it off screen.
   */
  function hideBar() {
    finishTimer = clearTimer(finishTimer);
    if (!bar) {
      return;
    }
    if (barParts) {
      barParts.status.textContent = '';
    }
    bar.hidden = !barVisible();
    renderBar();
  }

  /** The × , and read aloud being switched off. */
  function dismissBar() {
    finishTimer = clearTimer(finishTimer);
    closePopovers();
    if (bar) {
      bar.hidden = true;
      if (barParts) {
        barParts.status.textContent = '';
      }
    }
    applyCanvasClasses();
  }

  var lastTimeText = '';
  var lastProgress = -1;

  /**
   * How far the read has come, as a fraction of the text it was asked to
   * read: the word being spoken, not the audio, so a document-length read
   * whose later chunks are still being synthesised still advances evenly.
   */
  function readProgress() {
    var spans = record.allSpans;
    if (!record.text || !spans.length) {
      return 0;
    }
    // The word the highlight is on, by index rather than by `record.lastSpan`:
    // between two words — and after the last word of the chunks that have
    // arrived — there is no current span, and the bar must not fall back to
    // the start of the document there.
    var index = record.spanIndex;
    if (index >= spans.length) {
      index = spans.length - 1;
    }
    var end = spans[index].charEnd;
    if (!(end > 0)) {
      return 0;
    }
    return Math.max(0, Math.min(1, end / record.text.length));
  }

  function updateTimeDisplay() {
    if (!barParts || !bar || bar.hidden) {
      return;
    }
    var elapsed = 0;
    var total = 0;
    for (var i = 0; i < record.chunks.length; i++) {
      total += chunkLength(record.chunks[i]);
    }
    if (record.current >= 0 && record.chunks[record.current]) {
      var playing = record.chunks[record.current];
      elapsed =
        record.offsets[record.current] +
        (playing.slot ? playing.slot.el.currentTime : 0);
    }
    var text = formatTime(elapsed) + ' / ' + formatTime(total);
    if (text !== lastTimeText) {
      lastTimeText = text;
      barParts.progress.setAttribute('title', text);
    }
    var fraction = record.state === 'idle' ? 0 : readProgress();
    var percent = Math.round(fraction * 1000) / 10;
    if (percent !== lastProgress) {
      lastProgress = percent;
      barParts.progressFill.style.width = percent + '%';
    }
    syncSeekButtons();
  }

  var lastSeekState = '';

  function syncSeekButtons() {
    if (!barParts) {
      return;
    }
    var bounds = seekBounds();
    var canBack = !!bounds;
    var canForward = !!bounds && bounds.here + SEEK_SECONDS < bounds.end;
    var next = (canBack ? '1' : '0') + (canForward ? '1' : '0');
    if (next === lastSeekState) {
      return;
    }
    lastSeekState = next;
    setEnabled(barParts.back, canBack);
    setEnabled(barParts.forward, canForward);
  }

  // ------------------------------------------------------------- popovers

  function popoverFor(name) {
    if (!barParts) {
      return null;
    }
    if (name === 'volume') {
      return { pop: barParts.volumePop, button: barParts.volume };
    }
    if (name === 'speed') {
      return { pop: barParts.speedPop, button: barParts.speed };
    }
    return null;
  }

  function closePopovers(except) {
    if (!barParts) {
      return;
    }
    var names = ['volume', 'speed'];
    for (var i = 0; i < names.length; i++) {
      if (names[i] === except) {
        continue;
      }
      var found = popoverFor(names[i]);
      found.pop.root.hidden = true;
      found.button.setAttribute('aria-expanded', 'false');
    }
  }

  function togglePopover(name) {
    var found = popoverFor(name);
    if (!found) {
      return;
    }
    var open = found.pop.root.hidden;
    closePopovers(name);
    found.pop.root.hidden = !open;
    found.button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && lastGestureWasKey && found.pop.range.focus) {
      found.pop.range.focus();
    }
  }

  // ---------------------------------------------------------------- keys

  function onBarKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (
        barParts &&
        !(barParts.volumePop.root.hidden && barParts.speedPop.root.hidden)
      ) {
        closePopovers();
        return;
      }
      handleStop();
      return;
    }
    if (event.key === '[') {
      event.preventDefault();
      stepSpeed(-1);
      return;
    }
    if (event.key === ']') {
      event.preventDefault();
      stepSpeed(1);
      return;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      if (event.target !== bar) {
        return;
      }
      event.preventDefault();
      handleTogglePlayPause();
    }
  }

  function stepSpeed(direction) {
    var index = SPEED_STOPS.indexOf(rate);
    if (index < 0) {
      index = 0;
      for (var i = 0; i < SPEED_STOPS.length; i++) {
        if (SPEED_STOPS[i] <= rate) {
          index = i;
        }
      }
    }
    var next = index + direction;
    if (next < 0) {
      next = 0;
    }
    if (next > SPEED_STOPS.length - 1) {
      next = SPEED_STOPS.length - 1;
    }
    applyRate(SPEED_STOPS[next], true);
  }

  function applyRate(value, persist, from) {
    rate = normaliseRate(value);
    if (mediaPool) {
      for (var i = 0; i < mediaPool.length; i++) {
        mediaPool[i].el.preservesPitch = true;
        mediaPool[i].el.playbackRate = rate;
      }
    }
    syncSpeedControls(from);
    if (!persist) {
      return;
    }
    speedTimer = clearTimer(speedTimer);
    speedTimer = setTimeout(function () {
      speedTimer = 0;
      post('readAloudSetSpeed', [rate]);
    }, SPEED_DEBOUNCE_MS);
  }

  function applyVolume(value, persist, from) {
    volume = normaliseVolume(value);
    if (mediaPool) {
      for (var i = 0; i < mediaPool.length; i++) {
        // Never touch an element that is still being unlocked with the
        // silent wav: Chromium counts a volume of 0 as muted and would not
        // grant the element the permission the read needs (11a).
        if (mediaPool[i].chunk) {
          mediaPool[i].el.volume = volume;
        }
      }
    }
    syncVolumeControls(from);
    if (!persist) {
      return;
    }
    volumeTimer = clearTimer(volumeTimer);
    volumeTimer = setTimeout(function () {
      volumeTimer = 0;
      post('readAloudSetVolume', [volume]);
    }, VOLUME_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------------
  // 8. Hints and the selection affordance (F2)
  // ---------------------------------------------------------------------------

  function ensureHint() {
    if (hintElement && hintElement.isConnected) {
      return hintElement;
    }
    hintElement = document.createElement('div');
    hintElement.className = 'mpe-ra-hint mpe-ra-ui';
    hintElement.setAttribute('role', 'status');
    hintElement.setAttribute('aria-live', 'polite');
    hintElement.hidden = true;
    document.body.appendChild(hintElement);
    return hintElement;
  }

  function showHint(text, rect) {
    if (!text) {
      return;
    }
    var element = ensureHint();
    element.textContent = text;
    element.hidden = false;
    var top = 12;
    var left = 12;
    if (rect) {
      top = rect.bottom + window.scrollY + 8;
      left = rect.left + window.scrollX;
    }
    element.style.top = top + 'px';
    element.style.left = left + 'px';
    hintTimer = clearTimer(hintTimer);
    hintTimer = setTimeout(function () {
      hintTimer = 0;
      element.hidden = true;
    }, HINT_MS);
  }

  function ensureFloat() {
    if (floatButton && floatButton.isConnected) {
      return floatButton;
    }
    floatButton = makeButton('float', 'Read aloud selection', 'mpe-ra-float');
    floatButton.textContent = 'Read aloud';
    floatButton.hidden = true;
    document.body.appendChild(floatButton);
    return floatButton;
  }

  function hideFloat() {
    if (floatButton) {
      floatButton.hidden = true;
    }
    floatSelection = null;
  }

  var ZERO_RECT = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };

  /** Last client rect of the current selection; null when layout says nothing. */
  function currentSelectionRect() {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount) {
      return null;
    }
    return rectOfRange(selection.getRangeAt(0));
  }

  function rectOfRange(range) {
    try {
      if (typeof range.getClientRects === 'function') {
        var rects = range.getClientRects();
        if (rects && rects.length) {
          return rects[rects.length - 1];
        }
      }
      if (typeof range.getBoundingClientRect === 'function') {
        var rect = range.getBoundingClientRect();
        if (rect && (rect.width || rect.height || rect.top || rect.left)) {
          return rect;
        }
      }
    } catch (error) {
      /* no layout information available */
    }
    return null;
  }

  function updateFloatAffordance() {
    if (!config.enabled || !root) {
      hideFloat();
      return;
    }
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) {
      hideFloat();
      return;
    }
    var range = selection.getRangeAt(0);
    var container =
      range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!container || !root.contains(container)) {
      hideFloat();
      return;
    }
    var rect = rectOfRange(range) || ZERO_RECT;
    var resolved = core.resolveSelection(selection, root);
    var element = ensureFloat();
    element.hidden = false;
    element.style.top = rect.bottom + window.scrollY + 6 + 'px';
    element.style.left = rect.left + window.scrollX + 'px';
    floatSelection = resolved;
    floatRect = rect;
  }

  // ---------------------------------------------------------------------------
  // 9. Block decoration (F1)
  // ---------------------------------------------------------------------------

  function ensureButton(entry) {
    if (entry.button && entry.button.parentNode === entry.el) {
      return entry.button;
    }
    var existing = null;
    for (var i = 0; i < entry.el.children.length; i++) {
      var child = entry.el.children[i];
      if (child.classList && child.classList.contains('mpe-ra-btn')) {
        existing = child;
        break;
      }
    }
    var button = existing;
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'mpe-ra-btn mpe-ra-ui';
      button.setAttribute('data-state', 'idle');
      button.setAttribute('aria-pressed', 'false');
      entry.el.insertBefore(button, entry.el.firstChild);
    }
    button.setAttribute('aria-label', 'Read aloud: ' + entry.label);
    button.setAttribute('title', 'Read aloud');
    entry.button = button;
    if (record.state !== 'idle' && record.blockEl === entry.el) {
      setButtonState(entry.el, record.state, record.errorMessage);
    }
    return button;
  }

  function setButtonState(el, state, message) {
    if (!el) {
      return;
    }
    var entry = entryForElement(el);
    var button = entry ? entry.button : null;
    if (!button && entry) {
      button = ensureButton(entry);
    }
    if (!button) {
      return;
    }
    button.setAttribute('data-state', state);
    button.setAttribute('aria-pressed', state === 'playing' ? 'true' : 'false');
    button.setAttribute(
      'title',
      state === 'error' && message ? message : 'Read aloud',
    );
  }

  function ensureViewportObserver() {
    if (viewportObserver || typeof window.IntersectionObserver !== 'function') {
      return viewportObserver;
    }
    viewportObserver = new window.IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) {
            continue;
          }
          var entry = entryForElement(entries[i].target);
          if (entry) {
            ensureButton(entry);
          }
        }
      },
      { rootMargin: '100% 0px' },
    );
    return viewportObserver;
  }

  function applyGutter() {
    if (!root) {
      return;
    }
    var rect = root.getBoundingClientRect();
    var padding = 0;
    try {
      padding = parseFloat(window.getComputedStyle(root).paddingLeft) || 0;
    } catch (error) {
      padding = 0;
    }
    if (rect.left + padding < GUTTER_MIN_PX) {
      root.classList.add('mpe-ra-gutter');
    }
  }

  function decorate() {
    if (!root) {
      return;
    }
    if (!config.enabled) {
      removeDecorations();
      return;
    }
    if (!panelDismissed && (!bar || !bar.isConnected)) {
      // The panel lives in <body>, outside the preview root: rebuild it if a
      // re-render of the page ever takes it with it.
      showBar('');
    }
    if (viewportObserver) {
      viewportObserver.disconnect();
    }
    var collected = core.collectBlocks(root);
    var next = [];
    var byKey = Object.create(null);
    var byElement = new Map();
    for (var i = 0; i < collected.length; i++) {
      var el = collected[i].el;
      var text = core.extractText(el).text;
      var key = core.blockKey(el, text);
      var entry = {
        el: el,
        kind: collected[i].kind,
        index: collected[i].index,
        key: key,
        text: text,
        label: core.blockLabel(text),
        button: null,
      };
      next.push(entry);
      byElement.set(el, entry);
      if (!byKey[key]) {
        byKey[key] = entry;
      }
      el.classList.add('mpe-ra-block');
    }
    blocks = next;
    blocksByKey = byKey;
    blocksByElement = byElement;

    var observer = ensureViewportObserver();
    for (var j = 0; j < blocks.length; j++) {
      if (observer) {
        observer.observe(blocks[j].el);
      } else {
        ensureButton(blocks[j]);
      }
    }
    applyThemeAttributes();
    applyClickClass();
    applyCanvasClasses();
    applyGutter();
    rebindAfterRender();
  }

  /** Playable text shows a pointer only while click to read is on (F17). */
  function applyClickClass() {
    if (!root) {
      return;
    }
    if (config.enabled && config.clickToRead) {
      root.classList.add(CLICK_CLASS);
    } else {
      root.classList.remove(CLICK_CLASS);
    }
  }

  /**
   * The reading canvas: one vertical rhythm for read and unread text alike
   * (media/read-aloud.css §1), plus room at the bottom for the panel.
   */
  function applyCanvasClasses() {
    if (!root) {
      return;
    }
    if (config.enabled) {
      root.classList.add(CANVAS_CLASS);
    } else {
      root.classList.remove(CANVAS_CLASS);
    }
    if (barVisible()) {
      root.classList.add(PANEL_CLASS);
    } else {
      root.classList.remove(PANEL_CLASS);
    }
  }

  function removeDecorations() {
    if (viewportObserver) {
      viewportObserver.disconnect();
    }
    var buttons = document.querySelectorAll('.mpe-ra-btn');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].remove();
    }
    var marked = document.querySelectorAll('.mpe-ra-block');
    for (var j = 0; j < marked.length; j++) {
      marked[j].classList.remove('mpe-ra-block');
    }
    removeThemeAttributes();
    if (root) {
      root.classList.remove(CLICK_CLASS);
      root.classList.remove(CANVAS_CLASS);
      root.classList.remove(PANEL_CLASS);
    }
    blocks = [];
    blocksByKey = Object.create(null);
    blocksByElement = new Map();
  }

  /**
   * After a re-render (F1, decision 6): re-locate every block of the read by
   * its content hash — in document order, so two blocks with the same text
   * stay apart — rebuild the offset map and rebind the decoration. The read
   * stops when the block being read is gone; a later block that is gone
   * stops it when its first chunk is about to play (enterBlock).
   */
  function rebindAfterRender() {
    if (record.state === 'idle') {
      return;
    }
    if (record.kind !== 'block' || !record.readBlocks.length) {
      endJob({ next: 'idle', reason: 'selection read; document re-rendered' });
      return;
    }
    var readBlocks = record.readBlocks;
    var cursor = 0;
    for (var b = 0; b < readBlocks.length; b++) {
      var rb = readBlocks[b];
      rb.el = null;
      rb.missing = true;
      for (var j = cursor; j < blocks.length; j++) {
        if (blocks[j].key === rb.key) {
          rb.el = blocks[j].el;
          rb.missing = false;
          cursor = j + 1;
          break;
        }
      }
    }
    var current = readBlocks[record.blockIndex] || null;
    if (!current || current.missing) {
      if (record.state === 'error') {
        clearTransientError();
      } else {
        endJob({ next: 'idle', reason: 'current block gone after re-render' });
      }
      return;
    }
    var entry = entryForElement(current.el);
    if (record.state === 'error') {
      record.blockEl = current.el;
      if (entry) {
        ensureButton(entry);
      }
      setButtonState(current.el, 'error', record.errorMessage);
      return;
    }
    var lastSpan = record.lastSpan;
    // The word spans must go before the map is rebuilt: they split text nodes.
    clearWordBox();
    var previousEls = record.blockEls;
    record.blockEls = [];
    if (previousEls.length !== 1 || previousEls[0] !== current.el) {
      undecorateBlocks(previousEls);
    }
    var remapped = core.remapBlocks(record.text, readBlocks);
    for (var m = 0; m < remapped.missing.length; m++) {
      readBlocks[remapped.missing[m]].missing = true;
      readBlocks[remapped.missing[m]].el = null;
    }
    if (current.missing) {
      endJob({
        next: 'idle',
        reason: 'current block text changed after re-render',
      });
      return;
    }
    record.map = remapped.map;
    record.blockEl = current.el;
    for (var i = 0; i < record.allSpans.length; i++) {
      record.allSpans[i]._range = null;
      record.allSpans[i]._rangeMap = null;
    }
    record.spanIndex = 0;
    record.lastSpan = null;
    if (entry) {
      ensureButton(entry);
    }
    setButtonState(current.el, record.state, '');
    record.blockEls = [current.el];
    decorateBlocks(record.blockEls);
    if (lastSpan) {
      // Keep the word visible across a re-render, also while paused.
      paintSpan(lastSpan);
      record.lastSpan = lastSpan;
    }
  }

  function scheduleDecorate() {
    if (decorateScheduled) {
      return;
    }
    decorateScheduled = true;
    window.requestAnimationFrame(function () {
      decorateScheduled = false;
      decorate();
    });
  }

  function isSelfMutation(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var mutation = mutations[i];
      if (
        !isOwnNodeList(mutation.addedNodes) ||
        !isOwnNodeList(mutation.removedNodes)
      ) {
        return false;
      }
    }
    return true;
  }

  function isOwnNodeList(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.nodeType !== 1) {
        return false;
      }
      var className = node.getAttribute('class') || '';
      if (className.indexOf('mpe-ra-') === -1) {
        return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // 10. Job lifecycle (contract §3.6)
  // ---------------------------------------------------------------------------

  /** Drop a chunk's audio and its blob; the chunk record itself stays. */
  function releaseChunkAudio(chunk) {
    if (chunk.released) {
      return;
    }
    chunk.released = true;
    if (chunk.slot) {
      releaseSlot(chunk.slot);
    }
    try {
      URL.revokeObjectURL(chunk.url);
    } catch (error) {
      /* ignore */
    }
  }

  /**
   * Memory rule of a continuous read: only the block being played and the
   * prefetched chunks keep their audio; every chunk of an earlier block is
   * released once the read moves on. Its spans and duration stay, so the time
   * display and the seek rule (a released chunk needs a new read) still work.
   */
  function releaseBlocksBefore(blockIndex) {
    for (var i = 0; i < record.chunks.length; i++) {
      var chunk = record.chunks[i];
      if (chunk.blockIndex < blockIndex) {
        releaseChunkAudio(chunk);
      }
    }
  }

  function releaseChunks() {
    stopLoop();
    for (var i = 0; i < record.chunks.length; i++) {
      releaseChunkAudio(record.chunks[i]);
    }
    record.chunks = [];
    record.chunkCount = 0;
    record.current = -1;
    record.offsets = [];
    record.allSpans = [];
    record.spanIndex = 0;
    record.lastSpan = null;
  }

  /**
   * The single path out of loading/playing/paused, in the order the contract
   * fixes: clear the requestId, cancel the host job when it may still be
   * running, then tear the player down.
   */
  function endJob(options) {
    var next = options.next || 'idle';
    var oldId = record.requestId;
    var mayBeRunning =
      record.state === 'loading' || record.chunks.length < record.chunkCount;
    var postCancel =
      options.forceCancel === true ||
      (options.skipCancel !== true && mayBeRunning);

    record.requestId = null;
    if (postCancel && oldId) {
      // The reason lands in the host's output channel next to the job.
      post('readAloudCancel', [sourceUri, oldId, options.reason || 'end']);
    }

    var blockEl = record.blockEl;
    releaseChunks();
    clearReadingDecoration();

    record.state = next;
    record.kind = next === 'error' ? record.kind : null;
    record.text = '';
    record.map = null;

    if (next === 'error') {
      record.errorCode = options.code || '';
      record.errorMessage = options.message || 'Read aloud failed.';
      setButtonState(blockEl, 'error', record.errorMessage);
      showBar(record.errorMessage);
      errorTimer = clearTimer(errorTimer);
      errorTimer = setTimeout(function () {
        errorTimer = 0;
        clearTransientError();
      }, ERROR_DISPLAY_MS);
      return;
    }

    setButtonState(blockEl, 'idle', '');
    record.blockEl = null;
    record.readBlocks = [];
    record.blockIndex = -1;
    record.label = '';
    record.errorCode = '';
    record.errorMessage = '';
    if (options.finished) {
      showBar('Finished');
      finishTimer = clearTimer(finishTimer);
      finishTimer = setTimeout(function () {
        finishTimer = 0;
        hideBar();
      }, FINISH_DISPLAY_MS);
      return;
    }
    hideBar();
  }

  function clearTransientError() {
    errorTimer = clearTimer(errorTimer);
    if (record.state !== 'error') {
      return;
    }
    setButtonState(record.blockEl, 'idle', '');
    record.state = 'idle';
    record.kind = null;
    record.blockEl = null;
    record.readBlocks = [];
    record.blockIndex = -1;
    record.label = '';
    record.errorCode = '';
    record.errorMessage = '';
    hideBar();
  }

  function nextRequestId() {
    requestCounter++;
    return 'ra-' + Date.now().toString(36) + '-' + requestCounter;
  }

  function startRead(options) {
    if (!config.enabled) {
      return;
    }
    if (record.state === 'error') {
      clearTransientError();
    } else if (record.state !== 'idle') {
      endJob({ next: 'idle', reason: 'superseded by a new read' });
    }

    // A new read always brings the panel back, however it was started.
    panelDismissed = false;
    record = emptyRecord();
    record.state = 'loading';
    record.requestId = nextRequestId();
    record.kind = options.kind;
    record.text = options.text;
    record.map = options.map;
    record.label = options.label;
    record.readBlocks = options.readBlocks ? options.readBlocks.slice() : [];
    record.blockIndex = record.readBlocks.length ? 0 : -1;
    record.blockEl = record.readBlocks.length
      ? record.readBlocks[0].el
      : options.blockEl || null;
    record.blockEls = record.readBlocks.length
      ? [record.readBlocks[0].el]
      : options.blocks && options.blocks.length
        ? options.blocks.slice()
        : record.blockEl
          ? [record.blockEl]
          : [];
    applyThemeAttributes();
    decorateBlocks(record.blockEls);

    var payload = { kind: options.kind };
    if (options.blockId) {
      payload.blockId = options.blockId;
    }
    if (options.kind === 'block' && record.readBlocks.length) {
      // Decision 5: the host chunks block by block, never across a boundary.
      payload.blocks = record.readBlocks.map(function (rb) {
        return { key: rb.key, start: rb.start, end: rb.end };
      });
    }
    post('readAloudSynthesize', [
      sourceUri,
      record.requestId,
      options.text,
      payload,
    ]);

    setButtonState(record.blockEl, 'loading', '');
    showBar('Loading…');
  }

  /**
   * Read from `entry` to the end of the document (F15, decision 4): from the
   * start of the block, or from text offset `startOffset` of its whole text
   * (a click on a word, F17). Every eligible block after it goes into the
   * same request with its boundaries, so the host never merges two blocks
   * into one chunk (decision 5) and the next block's audio is synthesised
   * while this one plays. A document longer than the request bound is read
   * up to the last block that still fits.
   */
  function startBlockRead(entry, startOffset) {
    var start = startOffset > 0 ? startOffset : 0;
    var position = blocks.indexOf(entry);
    if (position < 0) {
      return;
    }
    var elements = [];
    var total = 0;
    for (var i = position; i < blocks.length; i++) {
      var length = blocks[i].text.length + 1;
      if (elements.length && total + length > core.MAX_TEXT_CHARS) {
        break;
      }
      elements.push(blocks[i].el);
      total += length;
    }
    var extracted = core.extractBlocks(elements, start);
    if (!extracted.text || extracted.text.length > core.MAX_TEXT_CHARS) {
      return;
    }
    var readBlocks = [];
    for (var k = 0; k < extracted.blocks.length; k++) {
      var block = extracted.blocks[k];
      var item = entryForElement(block.el);
      var first = block.el === entry.el;
      var text = extracted.text.slice(block.start, block.end);
      readBlocks.push({
        key: item ? item.key : core.blockKey(block.el, text),
        el: block.el,
        start: block.start,
        end: block.end,
        startOffset: first ? start : 0,
        label:
          !first || start > 0 || !item ? core.blockLabel(text) : item.label,
        missing: false,
      });
    }
    if (!readBlocks.length) {
      return;
    }
    startRead({
      kind: 'block',
      text: extracted.text,
      map: extracted.map,
      label: readBlocks[0].label,
      blockId: entry.key + '#' + entry.index + (start > 0 ? '@' + start : ''),
      readBlocks: readBlocks,
    });
  }

  function startSelectionRead(fallback) {
    var selection = window.getSelection();
    var resolved = core.resolveSelection(selection, root);
    if (!resolved.ok && resolved.reason === 'empty' && fallback) {
      resolved = fallback;
    }
    if (!resolved.ok) {
      if (resolved.hint) {
        showHint(resolved.hint, currentSelectionRect() || floatRect);
      }
      return;
    }
    hideFloat();
    startRead({
      kind: 'selection',
      text: resolved.text,
      map: resolved.map,
      label: 'Selection',
      blocks: resolved.blocks,
    });
  }

  // ---------------------------------------------------------------------------
  // 10b. Click to read (F17)
  // ---------------------------------------------------------------------------

  /** The caret the browser would place at a client point, or null. */
  function caretFromPoint(x, y) {
    try {
      if (typeof document.caretPositionFromPoint === 'function') {
        var position = document.caretPositionFromPoint(x, y);
        if (position && position.offsetNode) {
          return { node: position.offsetNode, offset: position.offset };
        }
      }
      if (typeof document.caretRangeFromPoint === 'function') {
        var range = document.caretRangeFromPoint(x, y);
        if (range) {
          return { node: range.startContainer, offset: range.startOffset };
        }
      }
    } catch (error) {
      /* no layout information available */
    }
    return null;
  }

  function cancelPendingClickRead() {
    if (pendingClick) {
      clearTimeout(pendingClick.timer);
      pendingClick = null;
    }
  }

  /** Verbose-level trace of why a click did or did not start a read. */
  function traceClick(what, detail) {
    if (window.console && console.debug) {
      console.debug(
        'read-aloud: click ' + what,
        detail === undefined ? '' : detail,
      );
    }
  }

  /**
   * A plain left click inside an eligible block (no drag, no modifier, not a
   * link or a checkbox) schedules a read from the nearest word: the caret
   * the browser places at the point snaps to the word under it, or to the
   * word before a space or a line end, so a click in the margin or between
   * lines starts too (decision 9). The delay lets a double or triple click,
   * whose second press cancels the timer, select text as usual.
   */
  function maybeClickToRead(event, element) {
    if (
      !config.enabled ||
      !config.clickToRead ||
      !root ||
      !root.contains(element)
    ) {
      traceClick('ignored', {
        enabled: config.enabled,
        clickToRead: config.clickToRead,
        inRoot: !!(root && root.contains(element)),
      });
      return;
    }
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      event.detail > 1
    ) {
      traceClick('ignored (button, modifier or repeat)', event.detail);
      return;
    }
    var selection = window.getSelection();
    if (selection && selection.rangeCount && !selection.isCollapsed) {
      // A drag: the selection affordance owns it.
      traceClick('ignored (selection is not collapsed)');
      return;
    }
    var caret = caretFromPoint(event.clientX, event.clientY);
    if (!caret) {
      traceClick('no caret at point');
      return;
    }
    var resolved;
    try {
      resolved = core.resolveClick(caret.node, caret.offset, root);
    } catch (error) {
      traceClick('resolve failed', String(error));
      return;
    }
    if (!resolved.ok) {
      traceClick('refused', resolved.reason);
      return;
    }
    if (!resolved.el.contains(element)) {
      // The caret snapped into a neighbouring block: the click landed between
      // blocks, not inside this one's box.
      traceClick('outside the block box', resolved.unit);
      return;
    }
    traceClick('scheduled', {
      unit: resolved.unit,
      start: resolved.start,
      word: resolved.wholeText.slice(resolved.start, resolved.wordEnd),
    });
    cancelPendingClickRead();
    pendingClick = {
      timer: setTimeout(function () {
        pendingClick = null;
        startClickRead(resolved);
      }, CLICK_READ_DELAY_MS),
    };
  }

  /** The block of the current read that `el` is, or null. */
  function readBlockFor(el) {
    for (var i = 0; i < record.readBlocks.length; i++) {
      if (record.readBlocks[i].el === el) {
        return record.readBlocks[i];
      }
    }
    return null;
  }

  /**
   * The offset into record.text of text offset `start` in the whole text of
   * `el`, when `el` is a block of the current read and `start` is at or after
   * where the read began in it; −1 otherwise.
   */
  function readOffsetOf(el, start) {
    var rb = readBlockFor(el);
    if (!rb || rb.missing || start < rb.startOffset) {
      return -1;
    }
    return rb.start + (start - rb.startOffset);
  }

  /** The click landed inside the text of the read that is already loaded. */
  function clickTargetsCurrentRead(resolved) {
    if (readOffsetOf(resolved.el, resolved.start) < 0) {
      return false;
    }
    return (
      record.state === 'playing' ||
      record.state === 'paused' ||
      (record.state === 'loading' && record.chunks.length > 0)
    );
  }

  /**
   * Move playback of the current read to the word whose text starts at
   * `relative` (an offset into record.text), when the chunk holding it has
   * arrived and still has its audio. No request. False when a new read is
   * needed instead (the chunk is not synthesised yet, or its block is
   * finished and its audio released).
   */
  function seekToOffset(relative) {
    var spans = record.allSpans;
    if (!spans.length || !record.chunks.length) {
      return false;
    }
    var k = -1;
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].charStart >= relative) {
        k = i;
        break;
      }
    }
    if (k < 0) {
      return false;
    }
    var chunkIndex = -1;
    for (var c = 0; c < record.chunks.length; c++) {
      if (record.chunks[c].spanStart <= k) {
        chunkIndex = c;
      } else {
        break;
      }
    }
    if (chunkIndex < 0) {
      return false;
    }
    var chunk = record.chunks[chunkIndex];
    if (chunk.released) {
      return false;
    }
    var local = spans[k].start - record.offsets[chunkIndex];
    if (!(local >= 0)) {
      local = 0;
    }
    stopLoop();
    clearWordBox();
    var playing = record.chunks[record.current];
    if (playing && playing !== chunk && playing.slot) {
      // Abandoned mid-way: rewind it, so a later pass starts at its top.
      try {
        playing.slot.el.pause();
        playing.slot.el.currentTime = 0;
      } catch (error) {
        /* ignore */
      }
    }
    var slot = loadChunk(chunk);
    if (!slot) {
      return false;
    }
    try {
      // Before the metadata has loaded this sets the start position.
      slot.el.currentTime = local;
    } catch (error) {
      return false;
    }
    playChunk(chunkIndex);
    return true;
  }

  /**
   * Start (or seek) the read a click resolved to. The unit's text is
   * re-extracted after the previous job is torn down, because that teardown
   * merges the text nodes the reading decoration had split; text offsets are
   * unaffected by the decoration, so `resolved.start` stays valid.
   */
  function startClickRead(resolved) {
    if (!config.enabled || !config.clickToRead || !root) {
      return;
    }
    var el = resolved.el;
    if (!el.isConnected || !root.contains(el)) {
      return;
    }
    var offset = clickTargetsCurrentRead(resolved)
      ? readOffsetOf(resolved.el, resolved.start)
      : -1;
    if (offset >= 0 && seekToOffset(offset)) {
      traceClick('seeked', offset);
      hideFloat();
      return;
    }
    traceClick('starting', resolved.unit);
    if (record.state === 'error') {
      clearTransientError();
    } else if (record.state !== 'idle') {
      endJob({ next: 'idle' });
    }
    hideFloat();
    if (resolved.unit === 'block') {
      var entry = entryForElement(el);
      if (entry) {
        startBlockRead(entry, resolved.start);
        return;
      }
    }
    // A table cell is its own reading unit and the read ends at the cell
    // (decision 7): no continuation to the end of the document.
    var sliced = core.sliceExtraction(core.extractText(el), resolved.start);
    if (!sliced.text || sliced.text.length > core.MAX_TEXT_CHARS) {
      return;
    }
    startRead({
      kind: 'selection',
      text: sliced.text,
      map: sliced.map,
      label: core.blockLabel(sliced.text),
      readBlocks: [
        {
          key: null,
          el: el,
          start: 0,
          end: sliced.text.length,
          startOffset: resolved.start,
          label: core.blockLabel(sliced.text),
          missing: false,
        },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // 11. Playback (F3, F4)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // 11a. Media elements (autoplay policy)
  //
  // VS Code's webview iframe is cross-origin and is not granted the
  // `autoplay` permission, so Chromium lets a media element play only once
  // play() has been called on it with transient user activation: within
  // about five seconds of a click or key press in the preview. A fresh
  // <audio> per chunk therefore played the first chunk of a read and was
  // refused with NotAllowedError on every later one. Two elements are
  // created once, unlocked on the user's own gesture (mousedown, click,
  // keydown: 100 ms of silence is played on them) and reused for every chunk
  // of every read: one plays while the other preloads the next chunk, so
  // the hand-off stays gapless. A chunk keeps its blob URL until its block
  // is finished; the element it played on is handed back as soon as it ends.
  // ---------------------------------------------------------------------------

  function ensureMediaPool() {
    if (mediaPool) {
      return mediaPool;
    }
    mediaPool = [];
    for (var i = 0; i < MEDIA_POOL_SIZE; i++) {
      var el = new Audio();
      el.preload = 'auto';
      el.preservesPitch = true;
      el.playbackRate = rate;
      var slot = { el: el, chunk: null, unlocked: false };
      attachSlotEvents(slot);
      mediaPool.push(slot);
    }
    return mediaPool;
  }

  function attachSlotEvents(slot) {
    var el = slot.el;
    el.addEventListener('loadedmetadata', function () {
      var chunk = slot.chunk;
      if (!chunk || chunk.released) {
        return;
      }
      if (isFinite(el.duration)) {
        chunk.duration = el.duration;
        updateTimeDisplay();
      }
    });
    el.addEventListener('ended', function () {
      var chunk = slot.chunk;
      if (!chunk || chunk.released) {
        return;
      }
      onChunkEnded(chunk);
    });
    el.addEventListener('error', function () {
      var chunk = slot.chunk;
      if (!chunk || chunk.released || record.chunks.indexOf(chunk) === -1) {
        return;
      }
      if (record.current >= 0 && record.chunks[record.current] === chunk) {
        handleAudioFailure('error event', el);
      } else {
        // A preload failed: forget it, playChunk loads the chunk again.
        detachSlot(slot);
      }
    });
  }

  function markUnlocked(slot) {
    return function () {
      slot.unlocked = true;
    };
  }

  function ignoreRejection() {
    /* a play() refused outside a gesture leaves the element locked */
  }

  /**
   * Unlock every idle element while the user's gesture is fresh. Called from
   * the capture-phase mousedown, click and keydown listeners; cheap once the
   * elements are unlocked, and never touches an element that holds a chunk.
   */
  function unlockMediaPool() {
    var pool = ensureMediaPool();
    for (var i = 0; i < pool.length; i++) {
      var slot = pool[i];
      if (slot.unlocked || slot.chunk) {
        continue;
      }
      try {
        slot.el.src = SILENT_WAV;
        // Full volume for the unlock itself: Chromium treats a volume of 0
        // as muted, and a muted play() does not grant the permission the
        // read needs. loadChunk puts the user's volume back.
        slot.el.volume = 1;
        var promise = slot.el.play();
        if (promise && typeof promise.then === 'function') {
          promise.then(markUnlocked(slot), ignoreRejection);
        }
      } catch (error) {
        /* ignore */
      }
    }
  }

  function freeSlot() {
    var pool = ensureMediaPool();
    for (var i = 0; i < pool.length; i++) {
      if (!pool[i].chunk) {
        return pool[i];
      }
    }
    return null;
  }

  function detachSlot(slot) {
    if (slot.chunk) {
      slot.chunk.slot = null;
      slot.chunk = null;
    }
  }

  /** Hand an element back: detach its chunk and drop the loaded resource. */
  function releaseSlot(slot) {
    var el = slot.el;
    detachSlot(slot);
    try {
      el.pause();
    } catch (error) {
      /* ignore */
    }
    el.removeAttribute('src');
    try {
      el.load();
    } catch (error) {
      /* ignore */
    }
  }

  /**
   * Bind `chunk` to an element and start loading its audio: the element it
   * already has, else a free one, else the element of whichever chunk is not
   * the one playing. Null only when nothing can be freed.
   */
  function loadChunk(chunk) {
    if (chunk.slot) {
      return chunk.slot;
    }
    var slot = freeSlot();
    if (!slot) {
      var pool = ensureMediaPool();
      var playing = record.current >= 0 ? record.chunks[record.current] : null;
      for (var i = 0; i < pool.length; i++) {
        if (pool[i].chunk !== playing) {
          releaseSlot(pool[i]);
          slot = pool[i];
          break;
        }
      }
    }
    if (!slot) {
      return null;
    }
    slot.chunk = chunk;
    chunk.slot = slot;
    slot.el.playbackRate = rate;
    slot.el.preservesPitch = true;
    slot.el.volume = volume;
    slot.el.src = chunk.url;
    return slot;
  }

  // ---------------------------------------------------------------------------
  // 11b. Chunks
  // ---------------------------------------------------------------------------

  function appendChunk(message) {
    var index = record.chunks.length;
    var blob = base64ToBlob(message.audioBase64, message.mimeType);
    var url = URL.createObjectURL(blob);

    var chunk = {
      url: url,
      slot: null,
      released: false,
      blockIndex:
        typeof message.blockIndex === 'number' && message.blockIndex >= 0
          ? message.blockIndex
          : 0,
      duration: null,
      durationHint:
        typeof message.durationHint === 'number' ? message.durationHint : null,
      spans: [],
      spanStart: record.allSpans.length,
    };

    record.chunkCount = message.chunkCount;
    record.offsets[index] =
      index === 0
        ? 0
        : record.offsets[index - 1] + chunkLength(record.chunks[index - 1]);

    var offset = record.offsets[index];
    if (message.spans && message.spans.length) {
      for (var i = 0; i < message.spans.length; i++) {
        var span = message.spans[i];
        var shifted = {
          text: span.text,
          charStart: span.charStart,
          charEnd: span.charEnd,
          start: span.start + offset,
          end: span.end + offset,
        };
        chunk.spans.push(shifted);
        record.allSpans.push(shifted);
      }
    }

    record.chunks.push(chunk);
    if (record.current >= 0 && index === record.current + 1) {
      // The chunk after the one playing: preload it on the idle element.
      loadChunk(chunk);
    }
    return index;
  }

  /**
   * Hand the decoration and the button state over to block `blockIndex` of
   * the read (F15): the previous block is undecorated and its button reset,
   * the new one pilled, the bar label updated, and the audio of every block
   * before it released. Auto-scroll follows with the first painted word.
   * False, with the read stopped, when the block is gone after a re-render
   * (decision 6).
   */
  function enterBlock(blockIndex) {
    if (blockIndex === record.blockIndex || !record.readBlocks.length) {
      return true;
    }
    var rb = record.readBlocks[blockIndex];
    if (!rb) {
      return true;
    }
    if (rb.missing || !rb.el || !rb.el.isConnected) {
      endJob({ next: 'idle', reason: 'next block gone (document changed)' });
      return false;
    }
    clearWordBox();
    var previousEls = record.blockEls;
    record.blockEls = [];
    undecorateBlocks(previousEls);
    if (record.blockEl && record.blockEl !== rb.el) {
      setButtonState(record.blockEl, 'idle', '');
    }
    record.blockIndex = blockIndex;
    record.blockEl = rb.el;
    record.label = rb.label || record.label;
    record.blockEls = [rb.el];
    decorateBlocks(record.blockEls);
    releaseBlocksBefore(blockIndex);
    return true;
  }

  function playChunk(index) {
    var chunk = record.chunks[index];
    if (!chunk || chunk.released) {
      return;
    }
    if (!enterBlock(chunk.blockIndex)) {
      return;
    }
    var slot = loadChunk(chunk);
    if (!slot) {
      handleAudioFailure('no media element free');
      return;
    }
    record.current = index;
    record.spanIndex = chunk.spanStart;
    record.lastSpan = null;
    record.state = 'playing';
    // Prefetch window (F11): the host requests up to two chunks beyond the
    // one it hears playing, so the next block's audio is ready before this
    // one ends and a stop wastes little synthesis.
    if (record.requestId !== null) {
      post('readAloudPlaying', [sourceUri, record.requestId, index]);
    }
    slot.el.playbackRate = rate;
    slot.el.preservesPitch = true;
    slot.el.volume = volume;
    var promise = slot.el.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(function (reason) {
        // A play() cut short by our own pause, seek or reload is not a
        // failure; only the chunk that is still meant to be playing counts.
        if (
          slot.chunk === chunk &&
          !chunk.released &&
          record.state === 'playing' &&
          record.chunks[record.current] === chunk
        ) {
          handleAudioFailure(reason, slot.el);
        }
      });
    }
    startLoop();
    setButtonState(record.blockEl, 'playing', '');
    showBar('');
    var next = record.chunks[index + 1];
    if (next && !next.released && !next.slot) {
      loadChunk(next);
    }
  }

  function onChunkEnded(chunk) {
    // E6 guard (A-03).
    if (
      record.state !== 'playing' ||
      record.requestId === null ||
      record.current < 0 ||
      record.chunks[record.current] !== chunk
    ) {
      return;
    }
    var finished = record.current;
    if (chunk.slot) {
      // Hand the element back so the chunk after next can preload on it.
      releaseSlot(chunk.slot);
    }
    if (record.chunks[finished + 1]) {
      playChunk(finished + 1);
      return;
    }
    if (finished + 1 < record.chunkCount) {
      record.state = 'loading';
      stopLoop();
      clearWordBox();
      setButtonState(record.blockEl, 'loading', '');
      showBar('Loading…');
      return;
    }
    endJob({ next: 'idle', finished: true });
  }

  /** Why an HTMLMediaElement failed, for the bar and the host log. */
  function describeAudioFailure(reason, audio) {
    var parts = [];
    if (reason && typeof reason === 'object' && reason.name) {
      parts.push(reason.name + (reason.message ? ': ' + reason.message : ''));
    } else if (typeof reason === 'string') {
      parts.push(reason);
    }
    try {
      if (audio && audio.error) {
        parts.push(
          'MediaError ' + audio.error.code + ' ' + (audio.error.message || ''),
        );
      }
    } catch (error) {
      /* ignore */
    }
    return parts.join('; ');
  }

  function handleAudioFailure(reason, audio) {
    if (record.state === 'idle' || record.state === 'error') {
      return;
    }
    var detail = describeAudioFailure(reason, audio);
    if (window.console && console.error) {
      console.error('read-aloud: audio failure', detail, reason);
    }
    var blocked =
      !!reason &&
      typeof reason === 'object' &&
      reason.name === 'NotAllowedError';
    // E7 (A-38): a local failure, but the host job may still be running.
    endJob({
      next: 'error',
      forceCancel: true,
      code: 'audio_error',
      message: blocked
        ? 'Audio is blocked until you click in the preview. Click a word or a play button to start.'
        : 'Could not play the audio.' + (detail ? ' (' + detail + ')' : ''),
      reason: 'audio: ' + (detail || 'unknown'),
    });
  }

  function startLoop() {
    if (record.rafId) {
      return;
    }
    record.rafId = window.requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (record.rafId) {
      window.cancelAnimationFrame(record.rafId);
      record.rafId = 0;
    }
  }

  function tick() {
    record.rafId = 0;
    if (record.state !== 'playing') {
      return;
    }
    var chunk = record.chunks[record.current];
    if (!chunk) {
      return;
    }
    var time =
      record.offsets[record.current] +
      (chunk.slot ? chunk.slot.el.currentTime : 0);
    var spans = record.allSpans;
    while (
      record.spanIndex < spans.length &&
      spans[record.spanIndex].end <= time
    ) {
      record.spanIndex++;
    }
    var current =
      record.spanIndex < spans.length && spans[record.spanIndex].start <= time
        ? spans[record.spanIndex]
        : null;
    if (current !== record.lastSpan) {
      paintSpan(current);
      record.lastSpan = current;
    }
    updateTimeDisplay();
    record.rafId = window.requestAnimationFrame(tick);
  }

  function pausePlayback() {
    var chunk = record.chunks[record.current];
    if (chunk && chunk.slot) {
      chunk.slot.el.pause();
    }
    stopLoop();
    record.state = 'paused';
    setButtonState(record.blockEl, 'paused', '');
    showBar('Paused');
  }

  function resumePlayback() {
    var chunk = record.chunks[record.current];
    if (!chunk) {
      return;
    }
    playChunk(record.current);
  }

  // ---------------------------------------------------------------------------
  // 11c. Skipping (F3): the ±10 s buttons of the control panel
  //
  // A skip stays inside the block being read, which is also the only block
  // whose audio is guaranteed to still be there: the memory rule releases
  // every earlier block as the read moves on (section 10). So a rewind that
  // would land before the block's first word restarts the block, and a
  // forward that would land past its last synthesised word does nothing.
  // ---------------------------------------------------------------------------

  /**
   * `{ start, end, here, blockIndex }` on the read's own timeline for the
   * block being read, from the chunks of it that have arrived and still have
   * their audio; null when there is nothing to skip within.
   */
  function seekBounds() {
    if (record.current < 0) {
      return null;
    }
    var chunk = record.chunks[record.current];
    if (!chunk || chunk.released) {
      return null;
    }
    var blockIndex = chunk.blockIndex;
    var start = null;
    var end = 0;
    for (var i = 0; i < record.chunks.length; i++) {
      var candidate = record.chunks[i];
      if (candidate.blockIndex !== blockIndex || candidate.released) {
        continue;
      }
      if (start === null) {
        start = record.offsets[i];
      }
      end = record.offsets[i] + chunkLength(candidate);
    }
    if (start === null) {
      return null;
    }
    return {
      start: start,
      end: end,
      here:
        record.offsets[record.current] +
        (chunk.slot ? chunk.slot.el.currentTime : 0),
      blockIndex: blockIndex,
    };
  }

  /** Move the word highlight to time `time` without touching the audio. */
  function syncSpansTo(time) {
    var spans = record.allSpans;
    var index = 0;
    while (index < spans.length && spans[index].end <= time) {
      index++;
    }
    record.spanIndex = index;
    var current =
      index < spans.length && spans[index].start <= time ? spans[index] : null;
    paintSpan(current);
    record.lastSpan = current;
  }

  /**
   * Move playback to `target` seconds on the read's timeline. The chunk that
   * holds it must belong to the block being read and still have its audio; a
   * paused read stays paused at the new position, a playing one plays on.
   */
  function seekToTime(target) {
    var bounds = seekBounds();
    if (!bounds) {
      return false;
    }
    if (target < bounds.start) {
      target = bounds.start;
    }
    if (target >= bounds.end) {
      return false;
    }
    var index = -1;
    for (var i = 0; i < record.chunks.length; i++) {
      var candidate = record.chunks[i];
      if (
        candidate.blockIndex === bounds.blockIndex &&
        !candidate.released &&
        record.offsets[i] <= target
      ) {
        index = i;
      }
    }
    if (index < 0) {
      return false;
    }
    var chunk = record.chunks[index];
    var local = target - record.offsets[index];
    if (!(local >= 0)) {
      local = 0;
    }
    var wasPaused = record.state === 'paused';
    stopLoop();
    clearWordBox();
    var playing = record.chunks[record.current];
    if (playing && playing !== chunk && playing.slot) {
      // Abandoned mid-way: rewind it, so a later pass starts at its top.
      try {
        playing.slot.el.pause();
        playing.slot.el.currentTime = 0;
      } catch (error) {
        /* ignore */
      }
    }
    var slot = loadChunk(chunk);
    if (!slot) {
      return false;
    }
    try {
      // Before the metadata has loaded this sets the start position.
      slot.el.currentTime = local;
    } catch (error) {
      return false;
    }
    if (wasPaused) {
      record.current = index;
      syncSpansTo(target);
      showBar('Paused');
      return true;
    }
    playChunk(index);
    return true;
  }

  /** The −10 s / +10 s buttons; `delta` is in seconds. */
  function handleSeek(delta) {
    var bounds = seekBounds();
    if (!bounds) {
      return;
    }
    var target = bounds.here + delta;
    if (delta > 0 && target >= bounds.end) {
      // Past the end of the block that is being read: do nothing.
      syncSeekButtons();
      return;
    }
    seekToTime(target);
    syncSeekButtons();
  }

  // ---------------------------------------------------------------------------
  // 12. Events from the user (E1, E2, E3)
  // ---------------------------------------------------------------------------

  function handleBlockButton(button) {
    var el = button.parentElement;
    while (el && !entryForElement(el)) {
      el = el.parentElement;
    }
    var entry = el ? entryForElement(el) : null;
    if (!entry) {
      return;
    }
    if (record.state === 'error') {
      clearTransientError();
      startBlockRead(entry);
      return;
    }
    if (record.state !== 'idle' && record.blockEl === entry.el) {
      if (record.state === 'loading') {
        endJob({ next: 'idle' });
        return;
      }
      if (record.state === 'playing') {
        pausePlayback();
        return;
      }
      resumePlayback();
      return;
    }
    startBlockRead(entry);
  }

  /**
   * The first eligible block that is still on screen, so the panel's play
   * button starts where the reader is looking rather than at the top of a
   * document they have scrolled halfway through.
   */
  function firstVisibleEntry() {
    for (var i = 0; i < blocks.length; i++) {
      var rect = null;
      try {
        rect = blocks[i].el.getBoundingClientRect();
      } catch (error) {
        rect = null;
      }
      if (rect && rect.bottom > 4) {
        return blocks[i];
      }
    }
    return blocks.length ? blocks[0] : null;
  }

  function handleTogglePlayPause() {
    if (record.state === 'idle') {
      // Nothing loaded: read from the top of the viewport to the end of the
      // document, the same read a play button in the gutter would start.
      var entry = firstVisibleEntry();
      if (entry) {
        startBlockRead(entry);
      }
      return;
    }
    if (record.state === 'error') {
      clearTransientError();
      return;
    }
    if (record.state === 'loading') {
      if (record.chunks.length === 0) {
        endJob({ next: 'idle' });
      }
      // between chunks: the user is waiting for the next chunk (A-05).
      return;
    }
    if (record.state === 'playing') {
      pausePlayback();
      return;
    }
    resumePlayback();
  }

  function handleStop() {
    if (record.state === 'idle') {
      return;
    }
    if (record.state === 'error') {
      clearTransientError();
      return;
    }
    endJob({ next: 'idle', reason: 'stop' });
  }

  function handleAction(action) {
    if (action === 'play') {
      closePopovers();
      handleTogglePlayPause();
      return;
    }
    if (action === 'stop') {
      handleStop();
      return;
    }
    if (action === 'back10') {
      handleSeek(-SEEK_SECONDS);
      return;
    }
    if (action === 'forward10') {
      handleSeek(SEEK_SECONDS);
      return;
    }
    if (action === 'volume' || action === 'speed') {
      togglePopover(action);
      return;
    }
    if (action === 'model') {
      // Placeholder: the voice-model chooser is not built yet.
      return;
    }
    if (action === 'close') {
      handleStop();
      panelDismissed = true;
      dismissBar();
      return;
    }
    if (action === 'setup') {
      if (record.state === 'error') {
        clearTransientError();
      }
      post('readAloudOpenSetup', []);
      return;
    }
    if (action === 'float') {
      startSelectionRead(floatSelection);
    }
  }

  // ---------------------------------------------------------------------------
  // 13. Messages from the host (F13)
  // ---------------------------------------------------------------------------

  function matchesRecord(message) {
    if (
      typeof message.requestId !== 'string' ||
      record.requestId === null ||
      message.requestId !== record.requestId
    ) {
      if (window.console && console.debug) {
        console.debug(
          'read-aloud: dropped stale',
          message.command,
          message.requestId,
        );
      }
      return false;
    }
    return true;
  }

  function onAudioMessage(message) {
    if (
      typeof message.chunkIndex !== 'number' ||
      typeof message.chunkCount !== 'number' ||
      message.chunkCount <= message.chunkIndex ||
      message.chunkIndex !== record.chunks.length
    ) {
      if (window.console && console.debug) {
        console.debug(
          'read-aloud: dropped out-of-order chunk',
          message.chunkIndex,
          message.chunkCount,
        );
      }
      return;
    }
    var index;
    try {
      index = appendChunk(message);
    } catch (error) {
      handleAudioFailure(error);
      return;
    }
    if (record.state === 'loading') {
      playChunk(index);
      return;
    }
    // playing / paused: queued for the `ended` rule (G-06).
    updateTimeDisplay();
  }

  function onErrorMessage(message) {
    var code = typeof message.code === 'string' ? message.code : '';
    if (SILENT_CODES[code]) {
      endJob({ next: 'idle', skipCancel: true });
      return;
    }
    endJob({
      next: 'error',
      skipCancel: true,
      code: code,
      message:
        typeof message.message === 'string' && message.message
          ? message.message
          : 'Read aloud failed.',
    });
  }

  function applyConfig(message) {
    var wasEnabled = config.enabled;
    if (typeof message.enabled === 'boolean') {
      config.enabled = message.enabled;
    }
    if (typeof message.clickToRead === 'boolean') {
      config.clickToRead = message.clickToRead;
      if (!config.clickToRead) {
        cancelPendingClickRead();
      }
    }
    if (typeof message.voiceName === 'string') {
      config.voiceName = message.voiceName;
    }
    if (typeof message.modelId === 'string') {
      config.modelId = message.modelId;
    }
    if (typeof message.highlightTheme === 'string') {
      config.highlightTheme = core.normaliseHighlightTheme(
        message.highlightTheme,
      );
    }
    if (typeof message.speed === 'number') {
      var incoming = normaliseRate(message.speed);
      if (incoming !== rate) {
        applyRate(incoming, false);
      }
    }
    if (typeof message.volume === 'number') {
      var level = normaliseVolume(message.volume);
      if (level !== volume) {
        applyVolume(level, false);
      }
    }
    if (!config.enabled) {
      cancelPendingClickRead();
      if (record.state !== 'idle') {
        endJob({ next: 'idle' });
      }
      errorTimer = clearTimer(errorTimer);
      clearTransientError();
      removeDecorations();
      dismissBar();
      hideFloat();
      return;
    }
    if (!wasEnabled) {
      decorate();
      showBar('');
    } else {
      applyThemeAttributes();
      applyClickClass();
    }
    syncSpeedControls();
    syncVolumeControls();
  }

  function handleControl(action) {
    if (!config.enabled) {
      return;
    }
    if (action === 'stop') {
      handleStop();
      return;
    }
    if (action === 'togglePlayPause') {
      handleTogglePlayPause();
      return;
    }
    if (action === 'readSelection') {
      startSelectionRead();
    }
  }

  function onHostMessage(event) {
    var message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }
    switch (message.command) {
      case 'updateHtml':
        if (typeof message.sourceUri === 'string') {
          sourceUri = message.sourceUri;
        }
        return;
      case 'readAloudConfig':
        applyConfig(message);
        return;
      case 'readAloudControl':
        handleControl(message.action);
        return;
      case 'readAloudAudio':
        if (matchesRecord(message)) {
          onAudioMessage(message);
        }
        return;
      case 'readAloudError':
        if (matchesRecord(message)) {
          onErrorMessage(message);
        }
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // 14. Wiring
  // ---------------------------------------------------------------------------

  function onDocumentClick(event) {
    unlockMediaPool();
    var target = event.target;
    var element = target && target.nodeType === 1 ? target : null;
    if (!element && target && target.parentElement) {
      element = target.parentElement;
    }
    if (!element || !element.closest) {
      return;
    }
    var button = element.closest('.mpe-ra-btn');
    if (button) {
      event.preventDefault();
      event.stopPropagation();
      handleBlockButton(button);
      return;
    }
    var ui = element.closest('.mpe-ra-ui');
    if (!ui) {
      hideFloat();
      closePopovers();
      maybeClickToRead(event, element);
      return;
    }
    event.stopPropagation();
    var actionElement = element.closest('[data-mpe-ra-action]');
    if (!actionElement) {
      // Inside a popover: leave it open while its slider is being used.
      if (!element.closest('.mpe-ra-pop')) {
        closePopovers();
      }
      return;
    }
    event.preventDefault();
    handleAction(actionElement.getAttribute('data-mpe-ra-action'));
  }

  function markUserScroll() {
    if (Date.now() < programmaticScrollUntil) {
      return;
    }
    lastUserScrollAt = Date.now();
  }

  function attachRoot(candidate) {
    if (!candidate || candidate === root) {
      return;
    }
    if (rootObserver) {
      rootObserver.disconnect();
    }
    root = candidate;
    rootObserver = new MutationObserver(function (mutations) {
      if (isSelfMutation(mutations)) {
        return;
      }
      scheduleDecorate();
    });
    rootObserver.observe(root, { childList: true, subtree: true });
    decorate();
  }

  function start() {
    sourceUri = readSourceUriFromPage();
    attachRoot(document.querySelector(core.ROOT_SELECTOR));
    if (config.enabled) {
      // The control panel is part of the page, not just of a running read.
      showBar('');
    }
    bodyObserver = new MutationObserver(function () {
      if (root && root.isConnected) {
        return;
      }
      attachRoot(document.querySelector(core.ROOT_SELECTOR));
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    document.addEventListener(
      'mousedown',
      function (event) {
        // A gesture: the moment the media elements can be unlocked (11a).
        unlockMediaPool();
        lastGestureWasKey = false;
        // Any new press, including the second one of a double click,
        // cancels a click-to-read that is still waiting out its delay.
        cancelPendingClickRead();
        var element =
          event.target && event.target.nodeType === 1
            ? event.target
            : event.target && event.target.parentElement;
        if (element && element.closest && element.closest('.mpe-ra-float')) {
          // Keep the selection alive until the click handler reads it.
          event.preventDefault();
        }
      },
      true,
    );
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('selectionchange', function () {
      selectionTimer = clearTimer(selectionTimer);
      selectionTimer = setTimeout(function () {
        selectionTimer = 0;
        updateFloatAffordance();
      }, SELECTION_SETTLE_MS);
    });
    window.addEventListener('wheel', markUserScroll, { passive: true });
    window.addEventListener('touchmove', markUserScroll, { passive: true });
    window.addEventListener('scroll', markUserScroll, { passive: true });
    window.addEventListener(
      'keydown',
      function (event) {
        unlockMediaPool();
        lastGestureWasKey = true;
        if (NAV_KEYS[event.key]) {
          markUserScroll();
        }
      },
      true,
    );
    window.addEventListener('scroll', hideFloat, { passive: true });
  }

  window.addEventListener('message', onHostMessage);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
