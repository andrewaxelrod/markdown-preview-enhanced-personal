/*
 * Read aloud (ElevenLabs) — preview app (spec F1, F2, F3, F4, F13 webview side).
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
  var ERROR_DISPLAY_MS = 4000;
  var FINISH_DISPLAY_MS = 4000;
  var HINT_MS = 2500;
  var SPEED_DEBOUNCE_MS = 300;
  var SELECTION_SETTLE_MS = 150;
  var USER_SCROLL_IDLE_MS = 3000;
  var PROGRAMMATIC_SCROLL_MS = 1200;
  var GUTTER_MIN_PX = 28;
  // Click to read (F17): wait out the double-click window before starting,
  // and accept a click this far outside the word's glyph box.
  var CLICK_READ_DELAY_MS = 250;
  var CLICK_HIT_PAD_PX = 4;

  // Codes the host has already surfaced (notification) or that need no UI.
  var SILENT_CODES = {
    cancelled: true,
    text_too_short: true,
    empty_text: true,
    insufficient_credits: true,
    feature_not_available: true,
    subscription_required: true,
  };
  var KEY_CODES = {
    missing_api_key: true,
    invalid_api_key: true,
    unauthorized: true,
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
  var requestCounter = 0;

  var rootObserver = null;
  var bodyObserver = null;
  var viewportObserver = null;
  var decorateScheduled = false;

  var bar = null;
  var barParts = null;
  var floatButton = null;
  var hintElement = null;

  var errorTimer = 0;
  var finishTimer = 0;
  var hintTimer = 0;
  var speedTimer = 0;
  var selectionTimer = 0;

  var lastUserScrollAt = 0;
  var programmaticScrollUntil = 0;
  var floatSelection = null;
  var floatRect = null;
  var pendingClick = null;

  var record = emptyRecord();

  function emptyRecord() {
    return {
      state: 'idle',
      requestId: null,
      kind: null,
      blockKey: null,
      blockEl: null,
      blockEls: [],
      // The element a click can seek within, and where record.text starts
      // in that element's whole text (F17). Null for drag selections.
      unitEl: null,
      startOffset: 0,
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

  function formatTime(seconds) {
    var value = isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    var minutes = Math.floor(value / 60);
    var rest = value % 60;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest;
  }

  function tail(text, max) {
    return text.length <= max ? text : text.slice(text.length - max);
  }

  function head(text, max) {
    return text.length <= max ? text : text.slice(0, max);
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
  // 7. Player bar (F3)
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

  function ensureBar() {
    if (bar && bar.isConnected) {
      return bar;
    }
    bar = document.createElement('div');
    bar.className = 'mpe-ra-bar mpe-ra-ui';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Read aloud player');
    bar.setAttribute('tabindex', '0');
    bar.hidden = true;

    var play = makeButton('play', 'Play or pause', 'mpe-ra-bar-play');
    play.setAttribute('data-state', 'idle');
    var stop = makeButton('stop', 'Stop read aloud', 'mpe-ra-bar-stop');

    var label = document.createElement('span');
    label.className = 'mpe-ra-bar-label';

    var time = document.createElement('span');
    time.className = 'mpe-ra-bar-time';
    time.textContent = '0:00 / 0:00';

    var speedLabel = document.createElement('label');
    speedLabel.className = 'mpe-ra-bar-speed-label';
    speedLabel.setAttribute('for', 'mpe-ra-speed-select');
    speedLabel.textContent = 'Speed';

    var select = document.createElement('select');
    select.className = 'mpe-ra-ui mpe-ra-bar-speed';
    select.id = 'mpe-ra-speed-select';
    for (var i = 0; i < SPEED_STOPS.length; i++) {
      var option = document.createElement('option');
      option.value = String(SPEED_STOPS[i]);
      option.textContent = SPEED_STOPS[i] + 'x';
      select.appendChild(option);
    }
    var custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'Custom';
    select.appendChild(custom);

    var number = document.createElement('input');
    number.className = 'mpe-ra-ui mpe-ra-bar-rate';
    number.type = 'number';
    number.min = String(SPEED_MIN);
    number.max = String(SPEED_MAX);
    number.step = '0.05';
    number.setAttribute('aria-label', 'Playback speed');

    var voice = makeButton('setup', 'Read aloud setup', 'mpe-ra-bar-voice');
    var setKey = makeButton(
      'setup',
      'Set ElevenLabs API key',
      'mpe-ra-bar-setkey',
    );
    setKey.textContent = 'Set API key…';
    setKey.hidden = true;

    var status = document.createElement('span');
    status.className = 'mpe-ra-bar-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    bar.appendChild(play);
    bar.appendChild(stop);
    bar.appendChild(label);
    bar.appendChild(time);
    bar.appendChild(speedLabel);
    bar.appendChild(select);
    bar.appendChild(number);
    bar.appendChild(voice);
    bar.appendChild(setKey);
    bar.appendChild(status);
    document.body.appendChild(bar);

    barParts = {
      play: play,
      stop: stop,
      label: label,
      time: time,
      select: select,
      number: number,
      voice: voice,
      setKey: setKey,
      status: status,
    };

    select.addEventListener('change', function () {
      if (select.value === 'custom') {
        barParts.number.focus();
        return;
      }
      applyRate(parseFloat(select.value), true);
    });
    number.addEventListener('change', function () {
      applyRate(parseFloat(number.value), true);
    });
    bar.addEventListener('keydown', onBarKeydown);

    syncSpeedControls();
    syncVoiceLabel();
    return bar;
  }

  function syncSpeedControls() {
    if (!barParts) {
      return;
    }
    var known = SPEED_STOPS.indexOf(rate) >= 0;
    barParts.select.value = known ? String(rate) : 'custom';
    barParts.number.value = String(rate);
  }

  function syncVoiceLabel() {
    if (!barParts) {
      return;
    }
    var name = config.voiceName || 'ElevenLabs voice';
    barParts.voice.textContent = name;
    barParts.voice.setAttribute(
      'title',
      config.modelId ? name + ' · ' + config.modelId : name,
    );
  }

  function showBar(statusText) {
    ensureBar();
    finishTimer = clearTimer(finishTimer);
    bar.hidden = false;
    barParts.label.textContent = record.label || '';
    barParts.status.textContent = statusText || '';
    barParts.play.setAttribute('data-state', record.state);
    barParts.play.setAttribute(
      'aria-label',
      record.state === 'playing' ? 'Pause' : 'Play',
    );
    barParts.setKey.hidden = !(
      record.state === 'error' && KEY_CODES[record.errorCode]
    );
    syncSpeedControls();
    syncVoiceLabel();
    updateTimeDisplay();
  }

  function hideBar() {
    finishTimer = clearTimer(finishTimer);
    if (bar) {
      bar.hidden = true;
      if (barParts) {
        barParts.status.textContent = '';
        barParts.setKey.hidden = true;
      }
    }
  }

  var lastTimeText = '';

  function updateTimeDisplay() {
    if (!barParts || bar.hidden) {
      return;
    }
    var elapsed = 0;
    var total = 0;
    for (var i = 0; i < record.chunks.length; i++) {
      var chunk = record.chunks[i];
      var length = chunk.duration;
      if (typeof length !== 'number' || !isFinite(length)) {
        length =
          typeof chunk.durationHint === 'number' ? chunk.durationHint : 0;
      }
      total += length;
    }
    if (record.current >= 0 && record.chunks[record.current]) {
      elapsed =
        record.offsets[record.current] +
        record.chunks[record.current].audio.currentTime;
    }
    var text = formatTime(elapsed) + ' / ' + formatTime(total);
    if (text !== lastTimeText) {
      lastTimeText = text;
      barParts.time.textContent = text;
    }
  }

  function onBarKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
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

  function applyRate(value, persist) {
    rate = normaliseRate(value);
    for (var i = 0; i < record.chunks.length; i++) {
      var audio = record.chunks[i].audio;
      audio.preservesPitch = true;
      audio.playbackRate = rate;
    }
    syncSpeedControls();
    if (!persist) {
      return;
    }
    speedTimer = clearTimer(speedTimer);
    speedTimer = setTimeout(function () {
      speedTimer = 0;
      post('readAloudSetSpeed', [rate]);
    }, SPEED_DEBOUNCE_MS);
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
    applyGutter();
    rebindAfterRender();
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
    blocks = [];
    blocksByKey = Object.create(null);
    blocksByElement = new Map();
  }

  /** After a re-render: rebind the playing block by key, or stop cleanly (F1). */
  function rebindAfterRender() {
    if (record.state === 'idle') {
      return;
    }
    if (record.kind !== 'block') {
      endJob({ next: 'idle' });
      return;
    }
    var entry = blocksByKey[record.blockKey];
    if (!entry) {
      if (record.state === 'error') {
        clearTransientError();
      } else {
        endJob({ next: 'idle' });
      }
      return;
    }
    if (record.state === 'error') {
      record.blockEl = entry.el;
      ensureButton(entry);
      setButtonState(entry.el, 'error', record.errorMessage);
      return;
    }
    record.blockEl = entry.el;
    var lastSpan = record.lastSpan;
    // The word spans must go before the map is rebuilt: they split text nodes.
    clearWordBox();
    var previousEls = record.blockEls;
    record.blockEls = [];
    if (previousEls.length !== 1 || previousEls[0] !== entry.el) {
      undecorateBlocks(previousEls);
    }
    record.unitEl = entry.el;
    record.map = core.sliceExtraction(
      core.extractText(entry.el),
      record.startOffset,
    ).map;
    for (var i = 0; i < record.allSpans.length; i++) {
      record.allSpans[i]._range = null;
      record.allSpans[i]._rangeMap = null;
    }
    record.spanIndex = 0;
    record.lastSpan = null;
    ensureButton(entry);
    setButtonState(entry.el, record.state, '');
    record.blockEls = [entry.el];
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

  function releaseChunks() {
    stopLoop();
    for (var i = 0; i < record.chunks.length; i++) {
      var chunk = record.chunks[i];
      chunk.released = true;
      try {
        chunk.audio.pause();
      } catch (error) {
        /* ignore */
      }
      chunk.audio.removeAttribute('src');
      try {
        URL.revokeObjectURL(chunk.url);
      } catch (error) {
        /* ignore */
      }
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
      post('readAloudCancel', [sourceUri, oldId]);
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
    record.blockKey = null;
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
    record.blockKey = null;
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
      endJob({ next: 'idle' });
    }

    record = emptyRecord();
    record.state = 'loading';
    record.requestId = nextRequestId();
    record.kind = options.kind;
    record.text = options.text;
    record.map = options.map;
    record.label = options.label;
    record.blockEl = options.blockEl || null;
    record.blockKey = options.blockKey || null;
    record.blockEls =
      options.blocks && options.blocks.length
        ? options.blocks.slice()
        : record.blockEl
          ? [record.blockEl]
          : [];
    record.unitEl = options.unitEl || null;
    record.startOffset = options.startOffset > 0 ? options.startOffset : 0;
    applyThemeAttributes();
    decorateBlocks(record.blockEls);

    var payload = { kind: options.kind };
    if (options.blockId) {
      payload.blockId = options.blockId;
    }
    if (options.previousText) {
      payload.previousText = options.previousText;
    }
    if (options.nextText) {
      payload.nextText = options.nextText;
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
   * Read a block from its start, or from text offset `startOffset` of its
   * whole text (a click on a word, F17). A partial read gets the words before
   * the cut as `previous_text`, so prosody continues as if the whole block
   * were spoken.
   */
  function startBlockRead(entry, startOffset) {
    var start = startOffset > 0 ? startOffset : 0;
    var whole = core.extractText(entry.el);
    var extracted = start > 0 ? core.sliceExtraction(whole, start) : whole;
    if (!extracted.text) {
      return;
    }
    var previous = null;
    var next = null;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i] === entry) {
        previous = i > 0 ? blocks[i - 1] : null;
        next = i + 1 < blocks.length ? blocks[i + 1] : null;
        break;
      }
    }
    var previousText = '';
    if (start > 0) {
      previousText = tail(whole.text.slice(0, start).replace(/\s+$/, ''), 300);
    } else if (previous) {
      previousText = tail(previous.text, 300);
    }
    startRead({
      kind: 'block',
      text: extracted.text,
      map: extracted.map,
      label: start > 0 ? core.blockLabel(extracted.text) : entry.label,
      blockEl: entry.el,
      blockKey: entry.key,
      blockId: entry.key + '#' + entry.index + (start > 0 ? '@' + start : ''),
      previousText: previousText,
      nextText: next ? head(next.text, 300) : '',
      unitEl: entry.el,
      startOffset: start,
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

  /**
   * True when the client point lies on the clicked word's glyph boxes (with
   * a small pad). A click in the margin, between lines or past the end of a
   * line then starts nothing: every read costs a request.
   */
  function clickHitsWord(resolved, x, y) {
    var range = null;
    try {
      range = core.spanToRange(
        resolved.wholeMap,
        { charStart: resolved.start, charEnd: resolved.wordEnd },
        document,
      );
    } catch (error) {
      return false;
    }
    if (!range || typeof range.getClientRects !== 'function') {
      return false;
    }
    var rects = range.getClientRects();
    for (var i = 0; i < rects.length; i++) {
      var rect = rects[i];
      if (
        x >= rect.left - CLICK_HIT_PAD_PX &&
        x <= rect.right + CLICK_HIT_PAD_PX &&
        y >= rect.top - CLICK_HIT_PAD_PX &&
        y <= rect.bottom + CLICK_HIT_PAD_PX
      ) {
        return true;
      }
    }
    return false;
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
   * A plain left click on a word (no drag, no modifier, not a link or a
   * checkbox) schedules a read from that word. The delay lets a double or
   * triple click, whose second press cancels the timer, select text as usual.
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
    if (!clickHitsWord(resolved, event.clientX, event.clientY)) {
      traceClick(
        'missed the word',
        resolved.wholeText.slice(resolved.start, resolved.wordEnd),
      );
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

  /** The click landed inside the text of the read that is already loaded. */
  function clickTargetsCurrentRead(resolved) {
    if (!record.unitEl || record.unitEl !== resolved.el) {
      return false;
    }
    if (resolved.start < record.startOffset) {
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
   * arrived. No request, no cost. False when a new read is needed instead.
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
    var local = spans[k].start - record.offsets[chunkIndex];
    if (!(local >= 0)) {
      local = 0;
    }
    stopLoop();
    clearWordBox();
    var playing = record.chunks[record.current];
    if (playing && record.current !== chunkIndex) {
      try {
        playing.audio.pause();
      } catch (error) {
        /* ignore */
      }
    }
    for (var j = chunkIndex + 1; j < record.chunks.length; j++) {
      try {
        record.chunks[j].audio.currentTime = 0;
      } catch (error) {
        /* ignore */
      }
    }
    try {
      chunk.audio.currentTime = local;
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
    if (
      clickTargetsCurrentRead(resolved) &&
      seekToOffset(resolved.start - record.startOffset)
    ) {
      traceClick('seeked', resolved.start - record.startOffset);
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
    var sliced = core.sliceExtraction(core.extractText(el), resolved.start);
    if (!sliced.text || sliced.text.length > core.MAX_TEXT_CHARS) {
      return;
    }
    startRead({
      kind: 'selection',
      text: sliced.text,
      map: sliced.map,
      label: core.blockLabel(sliced.text),
      blocks: [el],
      unitEl: el,
      startOffset: resolved.start,
    });
  }

  // ---------------------------------------------------------------------------
  // 11. Playback (F3, F4)
  // ---------------------------------------------------------------------------

  function appendChunk(message) {
    var index = record.chunks.length;
    var blob = base64ToBlob(message.audioBase64, message.mimeType);
    var url = URL.createObjectURL(blob);
    var audio = new Audio(url);
    audio.preload = 'auto';
    audio.preservesPitch = true;
    audio.playbackRate = rate;

    var chunk = {
      audio: audio,
      url: url,
      released: false,
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
        : record.offsets[index - 1] +
          (record.chunks[index - 1].duration !== null
            ? record.chunks[index - 1].duration
            : record.chunks[index - 1].durationHint || 0);

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

    audio.addEventListener('loadedmetadata', function () {
      if (chunk.released) {
        return;
      }
      if (isFinite(audio.duration)) {
        chunk.duration = audio.duration;
        updateTimeDisplay();
      }
    });
    audio.addEventListener('ended', onChunkEnded);
    audio.addEventListener('error', function () {
      // A chunk torn down by a stop or a supersede fires `error` when its src
      // goes away; that must never fail the job that replaced it.
      if (chunk.released || record.chunks.indexOf(chunk) === -1) {
        return;
      }
      handleAudioFailure();
    });

    record.chunks.push(chunk);
    return index;
  }

  function playChunk(index) {
    var chunk = record.chunks[index];
    if (!chunk) {
      return;
    }
    record.current = index;
    record.spanIndex = chunk.spanStart;
    record.lastSpan = null;
    record.state = 'playing';
    // Lazy synthesis (F11): the host holds the request for the chunk after
    // this one until it hears that this one is playing, so stopping early
    // never pays for audio that was not about to be heard.
    if (record.requestId !== null) {
      post('readAloudPlaying', [sourceUri, record.requestId, index]);
    }
    chunk.audio.playbackRate = rate;
    chunk.audio.preservesPitch = true;
    var promise = chunk.audio.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(function () {
        handleAudioFailure();
      });
    }
    startLoop();
    setButtonState(record.blockEl, 'playing', '');
    showBar('');
  }

  function onChunkEnded(event) {
    // E6 guard (A-03).
    if (
      record.state !== 'playing' ||
      record.requestId === null ||
      record.current < 0 ||
      !record.chunks[record.current] ||
      event.target !== record.chunks[record.current].audio
    ) {
      return;
    }
    var finished = record.current;
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

  function handleAudioFailure() {
    if (record.state === 'idle' || record.state === 'error') {
      return;
    }
    // E7 (A-38): a local failure, but the host job may still be running.
    endJob({
      next: 'error',
      forceCancel: true,
      code: 'audio_error',
      message: 'Could not play the audio.',
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
    var time = record.offsets[record.current] + chunk.audio.currentTime;
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
    if (chunk) {
      chunk.audio.pause();
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

  function handleTogglePlayPause() {
    if (record.state === 'idle') {
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
    endJob({ next: 'idle' });
  }

  function handleAction(action) {
    if (action === 'play') {
      handleTogglePlayPause();
      return;
    }
    if (action === 'stop') {
      handleStop();
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
      handleAudioFailure();
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
    if (!config.enabled) {
      cancelPendingClickRead();
      if (record.state !== 'idle') {
        endJob({ next: 'idle' });
      }
      errorTimer = clearTimer(errorTimer);
      clearTransientError();
      removeDecorations();
      hideBar();
      hideFloat();
      return;
    }
    if (!wasEnabled) {
      decorate();
    } else {
      applyThemeAttributes();
    }
    syncVoiceLabel();
    syncSpeedControls();
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
      maybeClickToRead(event, element);
      return;
    }
    event.stopPropagation();
    var actionElement = element.closest('[data-mpe-ra-action]');
    if (!actionElement) {
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
    window.addEventListener('keydown', function (event) {
      if (NAV_KEYS[event.key]) {
        markUserScroll();
      }
    });
    window.addEventListener('scroll', hideFloat, { passive: true });
  }

  window.addEventListener('message', onHostMessage);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
