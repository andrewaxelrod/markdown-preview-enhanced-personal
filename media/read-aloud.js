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
  // Eye strain 2 (featrues/07-eye-strain-2/spec.md §5.3): the text size
  // slider persists on the same debounce as the speed.
  var TEXT_SIZE_DEBOUNCE_MS = 300;
  // The page's whole state lives on <html>, which crossnote never touches
  // (05 §4.3): the scheme as an attribute, and three custom properties that
  // media/read-aloud-page.css reads — the text size in px (unitless), the
  // line height derived from it, and the measure in em (07 §5.3).
  var PAGE_ATTR = 'data-mpe-ra-page';
  var PAGE_TEXT_SIZE_PROP = '--mpe-ra-page-text-size';
  var PAGE_LINE_HEIGHT_PROP = '--mpe-ra-page-line-height';
  var PAGE_MEASURE_PROP = '--mpe-ra-page-measure';
  // The word marker (07 §9): on the preview root, the help sheet and the
  // sheet's swatch container, next to `data-mpe-ra-theme`.
  var MARKER_ATTR = 'data-mpe-ra-marker';
  // Dim while reading (07 §8): the two tier classes on readable blocks.
  var TIER_NEAR_CLASS = 'mpe-ra-tier-near';
  var TIER_FAR_CLASS = 'mpe-ra-tier-far';
  // Follow-the-reading scroll (07 §7.3): a `scroll` event this far from the
  // position the loop last wrote is somebody else's and suspends the
  // following.
  var FOLLOW_OWN_SCROLL_PX = 2;
  var FOLLOW_CHIP_LABEL = 'Back to the reading';
  // Panel auto-hide (07 §10): playback with no activity for this long fades
  // the panel out.
  var PANEL_IDLE_MS = 3000;
  var GLOBAL_THEME_LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  var WORD_MARKER_LABELS = { underline: 'Underline', box: 'Box', off: 'Off' };
  var FONT_DEFAULT_LABEL_PAGE = 'Default \u2014 Atkinson Hyperlegible';
  var FONT_DEFAULT_LABEL_OFF = 'Default \u2014 preview theme';
  var PAGE_OFF_HINT =
    'Off in Settings \u2014 choose a theme to turn the page on';
  // Requirement §9, as one muted line at the foot of the sheet (D14).
  var READER_GUIDANCE =
    'Match the screen\u2019s brightness to the room; every 20 minutes, look 20 feet away for 20 seconds.';
  var SELECTION_SETTLE_MS = 150;
  var GUTTER_MIN_PX = 28;
  // Click to read (F17): wait out the double-click window before starting.
  var CLICK_READ_DELAY_MS = 250;
  // Help (04-help-module §4): how often the "Thinking… (n s)" counter ticks
  // while the engine is working, and the class on the sheet's reading scope.
  var HELP_TICK_MS = 1000;
  var HELP_BODY_CLASS = 'mpe-ra-help-body';
  var HELP_TOOLTIP = 'Explain the selection';
  var HELP_TOOLTIP_DISABLED = 'Select text to get help';
  // Notes (featrues/12-notes/spec.md §5, §10–§12): the copy deck of the brief.
  // The Note sheet's body carries the help body's class as well, so the
  // reader template of both stylesheets reaches it without a second copy.
  var NOTE_BODY_CLASS = 'mpe-ra-help-body mpe-ra-note-body';
  var NOTE_HIGHLIGHT_NAME = 'mpe-ra-note';
  var NOTE_TOOLTIP = 'Save a note (Alt+N)';
  var NOTE_HINT_NO_SELECTION = 'Select text to save a note';
  var NOTES_TOOLTIP = 'Notes in this document (Alt+Shift+N)';
  var NOTE_SAVED_CHIP = 'Saved as note';
  var NOTE_CHIP_MS = 3000;
  var NOTE_ERROR_CHIP_MS = 6000;
  var NOTE_UNDO_MS = 6000;
  var NOTE_TRANSIENT_MS = 1000;
  var NOTE_MY_NOTE_DEBOUNCE_MS = 500;
  var NOTE_TAGS_MAX = 12;
  var NOTE_ORPHAN_TEXT =
    'This passage was not found in the current version of the document. The context saved with the note is below.';
  var NOTE_OFF_TEXT =
    'Summaries are off in settings. The passage and your note are saved.';
  var NOTE_ERROR_PREFIX = 'The summary could not be written.';
  var NOTES_EMPTY_TEXT = 'No notes yet. Select text and choose Save a note.';
  // Classroom (featrues/13-classroom/spec.md §5, §12): the copy deck.
  var CLASSROOM_TOOLTIP = 'Teach me this (Alt+C)';
  var CLASSROOM_HINT_NO_SELECTION = 'Select text to open a classroom';
  var CLASSROOM_TEACH_LABEL = 'Teach me this';
  var CLASSROOM_MODULE_TOOLTIP = 'This module (Alt+Shift+C)';
  var CLASSROOM_NOT_MODULE_HINT = 'This preview is not a classroom module';
  var CLASSROOM_ANCHOR_MISSING =
    'The passage is not in this version of the document';
  var CLASSROOM_NOTE_PLACEHOLDER =
    'In your own words, what is confusing? Optional.';
  var CLASSROOM_NOTE_MAX = 500;
  var CLASSROOM_AUDIENCE_MAX = 300;
  var CLASSROOM_PASSAGE_CHARS = 160;
  var CLASSROOM_TICK_MS = 1000;
  var CLASSROOM_FLASH_MS = 1000;
  var CLASSROOM_WORDS_PER_MINUTE = 150;
  var CLASSROOM_LEVELS = [
    { level: 1, row: 'A few gaps: I follow most of it' },
    { level: 2, row: 'I understand the words, not how it fits together' },
    { level: 3, row: 'Lost: half of these terms mean nothing to me' },
  ];
  var CLASSROOM_DEFAULT_LEVEL = 2;
  // 13 §12.5, §11.4 — the module marker and the delete chip.
  var CLASSROOM_MARKER_BELOW_NOTE = '1.6em';
  var CLASSROOM_DELETE_TRASH_CHIP = 'Module moved to Trash';
  var CLASSROOM_DELETE_PERMANENT_CHIP = 'Module deleted';
  var NOTE_MARKER_LINE_TAGS = {
    LI: true,
    TR: true,
    P: true,
    DD: true,
    DT: true,
    TD: true,
    TH: true,
  };
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
    // Theme settings (the second button): a painter's palette.
    theme:
      STROKE +
      '<path d="M12 3.2a8.8 8.8 0 0 0 0 17.6c1.1 0 1.9-.85 1.9-1.85 0-.5-.2-.92-.5-1.24-.3-.33-.5-.75-.5-1.25 0-1 .84-1.86 1.9-1.86h2.05A4.35 4.35 0 0 0 21 10.25C21 6.32 16.97 3.2 12 3.2Z"/>' +
      '<circle cx="7.6" cy="12" r="1.15" fill="currentColor" stroke="none"/>' +
      '<circle cx="9.7" cy="8.1" r="1.15" fill="currentColor" stroke="none"/>' +
      '<circle cx="14.3" cy="7.8" r="1.15" fill="currentColor" stroke="none"/>' +
      '<circle cx="17.4" cy="11" r="1.15" fill="currentColor" stroke="none"/>' +
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
    // Help (04-help-module §2): a ? in a circle, between the speed and the ×.
    help:
      STROKE +
      '<circle cx="12" cy="12" r="8.6"/>' +
      '<path d="M9.7 9.5a2.35 2.35 0 1 1 2.9 2.28c-.53.14-.9.62-.9 1.17v.62"/>' +
      '<circle cx="11.95" cy="16.4" r="1.05" fill="currentColor" stroke="none"/>' +
      '</svg>',
    // Notes (12 §5.1, §10.1): a page with a folded corner, for the cluster
    // button and the margin marker; a bookmark for the bar's Notes button.
    note:
      STROKE +
      '<path d="M6.6 3.9h7.9l3.9 3.9v12.3H6.6z"/>' +
      '<path d="M14.5 3.9v3.9h3.9"/>' +
      '<path d="M9.6 12.2h4.8M9.6 15.5h4.8"/></svg>',
    notes: STROKE + '<path d="M7.2 4.3h9.6v15.4l-4.8-3.3-4.8 3.3z"/></svg>',
    check: STROKE + '<path d="m5.6 12.4 3.9 3.9 8.9-8.9"/></svg>',
    // Classroom (13 §5.1, §12.2): the flat cap as a rhombus with a short
    // tassel line, for the cluster button and the module preview's bar
    // button; a triangle for the stopped and failed badge; a ring for a
    // queued chapter; a small flag for a flagged one.
    classroom:
      STROKE +
      '<path d="M2.8 9.6 12 5.2l9.2 4.4L12 14z"/>' +
      '<path d="M6.4 11.3v4.3c0 1.3 2.5 2.6 5.6 2.6s5.6-1.3 5.6-2.6v-4.3"/>' +
      '<path d="M21.2 9.6v5.6"/></svg>',
    warning:
      STROKE +
      '<path d="M12 4.2 21 19.4H3z"/>' +
      '<path d="M12 9.6v4.6"/>' +
      '<circle cx="12" cy="16.9" r="1" fill="currentColor" stroke="none"/></svg>',
    circle: STROKE + '<circle cx="12" cy="12" r="7.5"/></svg>',
    flag:
      STROKE +
      '<path d="M6.5 20.2V4.6"/>' +
      '<path d="M6.5 5.2h10.4l-2.2 3.8 2.2 3.8H6.5"/></svg>',
    chevronLeft: STROKE + '<path d="m14.6 6.2-5.8 5.8 5.8 5.8"/></svg>',
    chevronRight: STROKE + '<path d="m9.4 6.2 5.8 5.8-5.8 5.8"/></svg>',
  };

  // Keys that scroll the document when they reach it (07 §7.3): pressing one
  // outside a form control or the panel suspends the following.
  var NAV_KEYS = {
    'ArrowUp': true,
    'ArrowDown': true,
    'PageUp': true,
    'PageDown': true,
    'Home': true,
    'End': true,
    ' ': true,
    'Spacebar': true,
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
    font: core.DEFAULT_PLAYER_FONT,
    // The low-strain page (05 §4.1) and eye strain 2 (07 §15.2).
    globalTheme: core.DEFAULT_GLOBAL_THEME,
    textSize: core.DEFAULT_TEXT_SIZE,
    wordMarker: core.DEFAULT_WORD_MARKER,
    dimWhileReading: true,
    panelAutoHide: true,
    // Help (04-help-module §7.1). `helpAvailable` is false in the web build,
    // where no process can be spawned, and hides the button entirely.
    helpAvailable: false,
    helpEngine: 'claude',
    helpModel: 'sonnet',
    helpEffort: 'low',
    helpAutoPlay: true,
    helpContextMode: 'section',
    // Notes (12 §14.3): false in the web build and when `notesEnabled` is off.
    notesAvailable: false,
    notesDecoration: 'marker-and-mark',
    // Classroom (13 §14.3): the cluster button and the sheets; and, in a
    // module's own preview, what the module is.
    classroomAvailable: false,
    classroomMarker: true,
    classroomModule: null,
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
        config.font = core.normalisePlayerFont(parsed.font);
        config.globalTheme = core.normaliseGlobalTheme(parsed.globalTheme);
        config.textSize = core.clampTextSize(parsed.textSize);
        config.wordMarker = core.normaliseWordMarker(parsed.wordMarker);
        config.dimWhileReading = parsed.dimWhileReading !== false;
        config.panelAutoHide = parsed.panelAutoHide !== false;
        applyHelpConfig(parsed);
        applyNotesConfig(parsed);
        applyClassroomConfig(parsed);
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
  // The help sheet is a *second reading scope* (04-help-module §5): the same
  // player, panel, highlighting and click-to-read, over the blocks of the
  // sheet body instead of the preview root. Its block list is kept apart from
  // the document's, because a re-render replaces one and never the other.
  var helpBlocks = [];
  var helpBlocksByElement = new Map();
  // The Note sheet's body is a third reading scope (12 §11.5), kept apart for
  // the same reason.
  var noteBlocks = [];
  var noteBlocksByElement = new Map();
  var rate = config.speed;
  var volume = config.volume;
  var requestCounter = 0;

  var rootObserver = null;
  // crossnote's React root owns the preview root's `class` attribute and
  // rewrites it on every render — including renders that change no child
  // node, which the root observer never sees. This one watches the attribute
  // itself and puts the player's own classes back (see restoreRootClasses).
  var rootClassObserver = null;
  var bodyObserver = null;
  var viewportObserver = null;
  var decorateScheduled = false;

  var bar = null;
  var barParts = null;
  // The user closed the panel with its × ; it comes back with the next read.
  var panelDismissed = false;
  // Panel auto-hide (07 §10): the panel has faded out and the progress strip
  // stands in for it. `pointerOverBar` keeps the countdown from starting
  // while the pointer rests on the panel.
  var panelIdle = false;
  var panelIdleTimer = 0;
  var pointerOverBar = false;
  var strip = null;
  var stripFill = null;
  var floatButton = null;
  var floatParts = null;
  var hintElement = null;

  var errorTimer = 0;
  var finishTimer = 0;
  var hintTimer = 0;
  var speedTimer = 0;
  var volumeTimer = 0;
  var textSizeTimer = 0;
  var selectionTimer = 0;
  // The scheme the low-strain page is showing — 'light', 'dark', or null
  // while it is off (05 §4). Kept apart from `config.globalTheme` because
  // `auto` resolves to one of the two and can change under us.
  var pageScheme = null;
  // The average advance of the face in use, in em (07 §6.2): measured from
  // a sample passage laid out in the preview root, the default until then.
  var charEm = core.DEFAULT_CHAR_EM;

  /**
   * Follow-the-reading scroll (07 §7): `engaged` is false from a manual
   * scroll until the chip, a play, a skip or a scroll that brings the word
   * back into the band; `moving` while an ease is under way; `wroteScrollTop`
   * the last position the loop wrote, so the `scroll` event it causes is
   * recognised as its own; `container` the scroll container of the read
   * (`window` for the document, the sheet body for a help read); `reduced`
   * follows `prefers-reduced-motion`.
   */
  var follow = {
    engaged: true,
    moving: false,
    wroteScrollTop: null,
    container: null,
    reduced: false,
  };

  var floatSelection = null;
  var floatRect = null;
  // Which scope the floating affordance's selection belongs to: the preview
  // root, or the help sheet's body. The help button follows the first only
  // (04-help-module D9).
  var floatScope = null;
  // The range the affordance points at, kept so a scroll can re-measure it
  // without re-resolving the selection (09 §9), and the pending frame of that
  // reposition.
  var floatRange = null;
  var floatFrame = 0;

  /**
   * The help sheet (04-help-module §4). One request in flight; `context` is
   * the first request's material, which every follow-up reuses byte for byte
   * (§14.3), and `stack` is the Back stack of explanations already shown.
   */
  var help = {
    open: false,
    // 'idle' | 'thinking' | 'ready' | 'error'
    state: 'idle',
    requestId: null,
    markdown: '',
    html: '',
    stack: [],
    question: '',
    context: null,
    resume: null,
    startedAt: 0,
    timer: 0,
    message: '',
    // What Retry resends, and which follow-up the answer in flight belongs to.
    last: null,
    pending: null,
    // Notes (12 §5.4): the anchor of the passage behind the sheet, computed
    // when it opened, and whether the answer on screen has been saved.
    anchor: null,
    saved: false,
  };

  /**
   * Notes (12): the document's list as the host last posted it, the result
   * of the last anchoring pass per note, the markers by block, the highlight
   * registered for the words' mark, and the two sheets' state.
   */
  var notes = {
    list: [],
    byId: Object.create(null),
    deleting: [],
    deleteMode: 'trash',
    generate: true,
    results: Object.create(null),
    markers: new Map(),
    markerResults: new Map(),
    anyFound: false,
    highlight: null,
    highlightRanges: [],
    lastAnchorsReport: '',
    lastPassMs: 0,
    open: false,
    currentId: null,
    opener: null,
    renderedKey: '',
    contextOpen: false,
    listOpen: false,
    listOpener: null,
    pendingCreate: null,
    pendingMyNote: null,
    myNoteTimer: 0,
    transient: '',
    transientTimer: 0,
    chipTimer: 0,
    chipNoteId: null,
    resume: null,
    layoutFrame: 0,
  };
  /**
   * Classroom (13 §5): the sheet's state is held here and rendered from the
   * host's messages; the webview keeps no build state the host has not sent.
   */
  var classroom = {
    open: false,
    // 'preparing' | 'ready' | 'building' | 'done' | 'error'
    state: 'preparing',
    requestId: null,
    passage: null,
    context: null,
    anchor: null,
    headingId: null,
    prepared: null,
    progress: null,
    progressAt: 0,
    moduleId: null,
    level: CLASSROOM_DEFAULT_LEVEL,
    note: '',
    personaId: '',
    audience: '',
    unticked: Object.create(null),
    message: '',
    timer: 0,
    opener: null,
    // The Module sheet of a module preview (13 §12.2).
    moduleOpen: false,
    moduleOpener: null,
    moduleProgress: null,
    flashTimer: 0,
    // 13 §12.5 — the document's modules as the host last posted them, the
    // result of the last anchoring pass per module, the markers by block.
    modules: {
      list: [],
      byId: Object.create(null),
      results: Object.create(null),
      markers: new Map(),
      markerResults: new Map(),
      anyFound: false,
      deleting: [],
      deleteMode: 'trash',
    },
    // The block a marker click opened the sheet for: its modules come first.
    markerBlockIds: null,
  };
  var pendingClick = null;
  var mediaPool = null;
  // Whether the last gesture was a key press: a popover opened from the
  // keyboard takes focus (and shows a focus ring on the slider's thumb), one
  // opened with the mouse does not.
  var lastGestureWasKey = false;

  var record = emptyRecord();

  // The low-strain page is applied here, at script evaluation (05 §4.3): this
  // script sits in <head> and is not deferred, so the attribute is on <html>
  // before <body> is parsed and the first paint is already the page — no
  // flash of the wrong theme on a cold load. There is no body yet, so `auto`
  // falls back to prefers-color-scheme; start() re-resolves with the body
  // classes once they exist.
  applyPage();

  function emptyRecord() {
    return {
      state: 'idle',
      requestId: null,
      kind: null,
      // The element the read belongs to (04-help-module §5): the preview root
      // for a document read, the help sheet's body for a help read. Every
      // click, selection and hand-off is relative to it, and a read never
      // leaves it.
      scope: null,
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
      // Every chunk's word spans, timed on the chunk's own clock (14).
      allSpans: [],
      spanIndex: 0,
      lastSpan: null,
      rafId: 0,
      // The pause at a block boundary (07 §11): the timer, when the next
      // block is due to start, and the chunk waiting behind the gap (−1 for
      // none) so a pause during the gap resumes with the right chunk.
      gapTimer: 0,
      gapDueAt: 0,
      pendingChunk: -1,
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
    if (!el) {
      return null;
    }
    return (
      blocksByElement.get(el) ||
      helpBlocksByElement.get(el) ||
      noteBlocksByElement.get(el) ||
      null
    );
  }

  /** The body of the help sheet, once it exists; the second reading scope. */
  function helpBody() {
    return barParts && barParts.help ? barParts.help.body : null;
  }

  /** The body of the Note sheet (12 §11.5); the third reading scope. */
  function noteBody() {
    return barParts && barParts.note ? barParts.note.body : null;
  }

  /**
   * Which scope `el` belongs to (04-help-module §5): the help sheet's body
   * when it is inside it, the preview root otherwise. Null when neither.
   */
  function scopeOf(el) {
    if (!el) {
      return null;
    }
    var sheetBody = helpBody();
    if (sheetBody && sheetBody.contains(el)) {
      return sheetBody;
    }
    var noteSheetBody = noteBody();
    if (noteSheetBody && noteSheetBody.contains(el)) {
      return noteSheetBody;
    }
    return root && root.contains(el) ? root : null;
  }

  /** The block list of a scope, in document order. */
  function blocksIn(scope) {
    if (scope && scope === helpBody()) {
      return helpBlocks;
    }
    if (scope && scope === noteBody()) {
      return noteBlocks;
    }
    return blocks;
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

  /**
   * Where chunk `index` starts on the read's own timeline: the lengths of
   * the chunks before it — the audio's once loaded, else the host's hint,
   * else nothing. Computed when asked, never stored (14): a length that
   * arrives later (loadedmetadata, or no hint at all for a cache hit) moves
   * every chunk after it, and a stored offset would be stale.
   */
  function offsetOf(index) {
    var total = 0;
    for (var i = 0; i < index && i < record.chunks.length; i++) {
      total += chunkLength(record.chunks[i]);
    }
    return total;
  }

  /** One past the last of chunk `index`'s spans in record.allSpans. */
  function spanEndOf(index) {
    var next = record.chunks[index + 1];
    return next ? next.spanStart : record.allSpans.length;
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
    // The low-strain page decides (05 §4.5): with a 150 ms background
    // transition a luminance read mid-switch could answer wrongly, and the
    // page's own attribute cannot.
    if (pageScheme) {
      return pageScheme;
    }
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

  /**
   * Publish the theme, the scheme and the word marker (07 §9.1) to CSS
   * through attributes on the root — and on the help sheet, which is the
   * second reading scope and paints the same pills and spoken-word marks
   * (04-help-module §5) — and the marker on the sheet's swatch container, so
   * the cards preview it.
   */
  function applyThemeAttributes() {
    if (!root) {
      return;
    }
    var scheme = detectScheme();
    root.setAttribute('data-mpe-ra-theme', config.highlightTheme);
    root.setAttribute('data-mpe-ra-scheme', scheme);
    root.setAttribute(MARKER_ATTR, config.wordMarker);
    if (barParts && barParts.help) {
      barParts.help.root.setAttribute(
        'data-mpe-ra-theme',
        config.highlightTheme,
      );
      barParts.help.root.setAttribute('data-mpe-ra-scheme', scheme);
      barParts.help.root.setAttribute(MARKER_ATTR, config.wordMarker);
    }
    if (barParts && barParts.note) {
      barParts.note.root.setAttribute(
        'data-mpe-ra-theme',
        config.highlightTheme,
      );
      barParts.note.root.setAttribute('data-mpe-ra-scheme', scheme);
      barParts.note.root.setAttribute(MARKER_ATTR, config.wordMarker);
    }
    if (barParts && barParts.sheet) {
      barParts.sheet.swatchContainer.setAttribute(
        MARKER_ATTR,
        config.wordMarker,
      );
    }
    applyBarScheme();
  }

  function removeThemeAttributes() {
    if (root) {
      root.removeAttribute('data-mpe-ra-theme');
      root.removeAttribute('data-mpe-ra-scheme');
      root.removeAttribute(MARKER_ATTR);
    }
  }

  // ------------------------------------------ the low-strain page (05 §4)

  function prefersDarkScheme() {
    try {
      return !!(
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
      );
    } catch (error) {
      return false;
    }
  }

  /** The measure in em of the root: 66 characters at the face's advance (07 §6.4). */
  function measureValue() {
    return Math.round(core.MEASURE_CHARS * charEm * 100) / 100 + 'em';
  }

  /**
   * Resolve the Global theme to a scheme and publish it on <html>, with the
   * three derived values as custom properties (05 §4.3, 07 §5.3): the text
   * size in px, the line height derived from it, the measure in em. With
   * `off`, or with read aloud disabled, the attribute and the properties are
   * removed and media/read-aloud-page.css matches nothing. Returns true when
   * the scheme changed, so callers know whether the decoration and the panel
   * must follow.
   */
  function applyPage() {
    var html = document.documentElement;
    if (!html) {
      return false;
    }
    var next = config.enabled
      ? core.resolvePageScheme(config.globalTheme, {
          bodyClasses: document.body ? document.body.className : '',
          prefersDark: prefersDarkScheme(),
        })
      : null;
    try {
      if (next) {
        html.setAttribute(PAGE_ATTR, next);
        html.style.setProperty(PAGE_TEXT_SIZE_PROP, String(config.textSize));
        html.style.setProperty(
          PAGE_LINE_HEIGHT_PROP,
          String(core.deriveLineHeight(config.textSize)),
        );
        html.style.setProperty(PAGE_MEASURE_PROP, measureValue());
      } else {
        html.removeAttribute(PAGE_ATTR);
        html.style.removeProperty(PAGE_TEXT_SIZE_PROP);
        html.style.removeProperty(PAGE_LINE_HEIGHT_PROP);
        html.style.removeProperty(PAGE_MEASURE_PROP);
      }
    } catch (error) {
      /* cosmetic only */
    }
    var changed = next !== pageScheme;
    pageScheme = next;
    return changed;
  }

  function pageIsOn() {
    return pageScheme !== null;
  }

  /**
   * Measure the average advance of the face in use (07 §6.2): a probe inside
   * the preview root — so it inherits the page's face or the player font
   * override, and the body size — lays the sample out on one line next to a
   * 100 em reference, and the ratio of the two widths divides the font size
   * and any body zoom out. Called after the root attaches, after every font
   * change and when the Atkinson face arrives (`document.fonts`), never from
   * a rAF loop. The page is re-applied when the value moved.
   */
  function measureCharEm() {
    if (!root || !root.isConnected) {
      return false;
    }
    var next = charEm;
    try {
      mutateSilently(function () {
        var probe = document.createElement('span');
        probe.className = 'mpe-ra-ui mpe-ra-probe';
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText =
          'position:absolute;visibility:hidden;white-space:nowrap;' +
          'left:-99999px;top:0;pointer-events:none';
        var sample = document.createElement('span');
        sample.textContent = core.MEASURE_SAMPLE;
        var reference = document.createElement('span');
        reference.style.cssText = 'display:inline-block;width:100em';
        probe.appendChild(sample);
        probe.appendChild(reference);
        root.appendChild(probe);
        try {
          next = core.charEmFrom(
            sample.getBoundingClientRect().width,
            reference.getBoundingClientRect().width,
            core.MEASURE_SAMPLE.length,
          );
        } finally {
          probe.remove();
        }
      });
    } catch (error) {
      return false;
    }
    if (next === charEm) {
      return false;
    }
    charEm = next;
    applyPage();
    return true;
  }

  /**
   * The Atkinson face arrives with `font-display: swap` after the first
   * paint; a measurement taken against `system-ui` would be a few percent
   * off, so the face is measured again once the fonts have loaded.
   */
  function watchFonts() {
    try {
      var fonts = document.fonts;
      if (fonts && typeof fonts.addEventListener === 'function') {
        fonts.addEventListener('loadingdone', function () {
          measureCharEm();
        });
      }
    } catch (error) {
      /* no Font Loading API here */
    }
  }

  /** `prefers-reduced-motion` (07 §7.2): the follow jumps instead of easing. */
  function watchReducedMotion() {
    try {
      var media =
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)');
      if (!media) {
        return;
      }
      follow.reduced = !!media.matches;
      var update = function (event) {
        follow.reduced = !!(event && typeof event.matches === 'boolean'
          ? event.matches
          : media.matches);
      };
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', update);
      } else if (typeof media.addListener === 'function') {
        media.addListener(update);
      }
    } catch (error) {
      follow.reduced = false;
    }
  }

  /**
   * VS Code rewrites the body classes without reloading the webview when the
   * colour theme changes, and prefers-color-scheme follows it; under `auto`
   * the page follows both, without a reload and without a message from the
   * host (05 §4.4).
   */
  function onPageEnvironmentChange() {
    if (config.globalTheme !== 'auto') {
      return;
    }
    if (applyPage()) {
      applyThemeAttributes();
      syncSheet();
    }
  }

  function watchPageEnvironment() {
    if (typeof MutationObserver === 'function' && document.body) {
      new MutationObserver(function () {
        onPageEnvironmentChange();
      }).observe(document.body, {
        attributes: true,
        attributeFilter: ['class'],
      });
    }
    try {
      var media =
        window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
      if (media && typeof media.addEventListener === 'function') {
        media.addEventListener('change', onPageEnvironmentChange);
      } else if (media && typeof media.addListener === 'function') {
        media.addListener(onPageEnvironmentChange);
      }
    } catch (error) {
      /* no media queries here: the body classes still carry the theme */
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
    // The words' mark steps aside for the block being read (12 §10.2).
    syncNoteHighlight();
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
    // The pill merged the block's text nodes back: the note ranges of that
    // block are rebuilt from a fresh extraction (12 §10.2).
    anchorPass();
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
    clearTiers();
  }

  /**
   * Paint one word: unwrap the previous one first, so the offset map (built on
   * the unsplit text nodes) resolves, then wrap the new word and the
   * characters touching it (core.wrapWord; the word's spans come first).
   * Every DOM call is guarded: a throw would escape the rAF callback and
   * silently stop the highlight loop for the rest of the read. Scrolling is
   * the follow loop's (07 §7), one step per frame, not the paint's.
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
      mutateSilently(function () {
        spans = core.wrapWord(record.map, span, document);
      });
    } catch (error) {
      /* a stale map or a detached node must not stop playback */
    }
    record.wordSpans = spans;
  }

  // -------------------------------------- follow-the-reading scroll (07 §7)

  /**
   * The scroll container of a read (07 §7.6): the sheet body for a help
   * read — its own scroll element — else the first ancestor of the scope
   * whose `overflow-y` computes to `auto` or `scroll` *and* that actually
   * overflows, else `window`. crossnote's preview root is `overflow-y: auto`
   * without ever scrolling (its height is its content's), and measuring the
   * word against that box would keep it "inside the band" for ever.
   */
  function scrollContainerFor(scope) {
    if (!scope) {
      return window;
    }
    if (scope === helpBody()) {
      return scope;
    }
    var el = scope;
    while (el && el !== document.body && el !== document.documentElement) {
      var overflow = '';
      try {
        overflow = window.getComputedStyle(el).overflowY;
      } catch (error) {
        overflow = '';
      }
      if (
        (overflow === 'auto' || overflow === 'scroll') &&
        el.scrollHeight > el.clientHeight + 1
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return window;
  }

  function followContainer() {
    return follow.container || window;
  }

  function readScrollTop(container) {
    if (container === window) {
      var top = window.scrollY;
      if (typeof top !== 'number') {
        top = window.pageYOffset;
      }
      if (typeof top !== 'number' && document.documentElement) {
        top = document.documentElement.scrollTop;
      }
      return typeof top === 'number' && isFinite(top) ? top : 0;
    }
    return container.scrollTop || 0;
  }

  function writeScrollTop(container, value) {
    try {
      if (container === window) {
        window.scrollTo(window.scrollX || 0, value);
      } else {
        container.scrollTop = value;
      }
    } catch (error) {
      /* a container that cannot scroll */
    }
  }

  /**
   * The geometry of the spoken word against its container (07 §7.1): the
   * word's top relative to the container's visible top, the visible height
   * and the current scroll position; null when there is no word on screen.
   */
  function followGeometry() {
    var spans = record.wordSpans;
    if (!spans || !spans.length) {
      return null;
    }
    var rect;
    try {
      rect = spans[0].getBoundingClientRect();
    } catch (error) {
      return null;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return null;
    }
    var container = followContainer();
    var containerTop = 0;
    var height = 0;
    if (container === window) {
      height = window.innerHeight || document.documentElement.clientHeight;
    } else {
      try {
        containerTop = container.getBoundingClientRect().top;
      } catch (error) {
        containerTop = 0;
      }
      height = container.clientHeight;
    }
    if (!(height > 0)) {
      return null;
    }
    return {
      container: container,
      wordTop: rect.top - containerTop,
      viewportHeight: height,
      scrollTop: readScrollTop(container),
    };
  }

  function wordInsideBand(geometry) {
    return (
      geometry.wordTop >= core.FOLLOW_BAND_TOP * geometry.viewportHeight &&
      geometry.wordTop <= core.FOLLOW_BAND_BOTTOM * geometry.viewportHeight
    );
  }

  /**
   * One frame of the following (07 §7.2): one rect read, one scroll write,
   * only while playing and engaged.
   */
  function followFrame() {
    if (!follow.engaged || record.state !== 'playing') {
      return;
    }
    var geometry = followGeometry();
    if (!geometry) {
      return;
    }
    var step = core.followStep({
      wordTop: geometry.wordTop,
      viewportHeight: geometry.viewportHeight,
      scrollTop: geometry.scrollTop,
      anchor: core.FOLLOW_ANCHOR,
      bandTop: core.FOLLOW_BAND_TOP,
      bandBottom: core.FOLLOW_BAND_BOTTOM,
      ease: core.FOLLOW_EASE,
      settlePx: core.FOLLOW_SETTLE_PX,
      reduced: follow.reduced,
      moving: follow.moving,
    });
    follow.moving = step.moving;
    if (step.scrollTop === geometry.scrollTop) {
      return;
    }
    // Remembered before the write, for an engine that fires `scroll`
    // synchronously, and corrected after it to what the container actually
    // took: at the end of the document the engine clamps the write, and the
    // event reports the clamped position, which is still the loop's own.
    follow.wroteScrollTop = step.scrollTop;
    writeScrollTop(geometry.container, step.scrollTop);
    follow.wroteScrollTop = readScrollTop(geometry.container);
    if (follow.wroteScrollTop === geometry.scrollTop) {
      // Nothing moved: the container is at its limit, the ease is over.
      follow.moving = false;
    }
  }

  /** Re-engage the following with an ease to the anchor (07 §7.4). */
  function engageFollow() {
    follow.engaged = true;
    follow.moving = false;
    syncChip();
  }

  /** A manual scroll: the page stays where the reader put it (07 §7.3). */
  function suspendFollow() {
    if (!follow.engaged) {
      return;
    }
    follow.engaged = false;
    follow.moving = false;
    syncChip();
  }

  /**
   * A `scroll` event of the container: the loop's own — within
   * FOLLOW_OWN_SCROLL_PX of the position it last wrote — is ignored; any
   * other suspends the following (crossnote's editor-to-preview sync, an
   * anchor jump, a scrollbar drag). While suspended, a scroll that brings the
   * spoken word back inside the band re-engages silently (07 §7.4): the page
   * is already where the loop would keep it, so nothing moves against the
   * reader.
   */
  function onContainerScroll(container) {
    if (record.state === 'idle' || container !== followContainer()) {
      return;
    }
    var position = readScrollTop(container);
    if (follow.engaged) {
      if (
        follow.wroteScrollTop !== null &&
        Math.abs(position - follow.wroteScrollTop) <= FOLLOW_OWN_SCROLL_PX
      ) {
        return;
      }
      suspendFollow();
      return;
    }
    if (record.state !== 'playing') {
      return;
    }
    var geometry = followGeometry();
    if (geometry && wordInsideBand(geometry)) {
      follow.wroteScrollTop = position;
      engageFollow();
    }
  }

  /** Whether a key press is the document's to scroll with (07 §7.3). */
  function isScrollKey(event) {
    if (!NAV_KEYS[event.key]) {
      return false;
    }
    var target = event.target;
    if (!target || target.nodeType !== 1) {
      return true;
    }
    var tag = target.tagName;
    if (
      tag === 'INPUT' ||
      tag === 'SELECT' ||
      tag === 'TEXTAREA' ||
      tag === 'BUTTON' ||
      target.isContentEditable
    ) {
      return false;
    }
    return !(target.closest && target.closest('.mpe-ra-bar'));
  }

  // ---------------------------------------------------------------------------
  // 7. Control panel (F3)
  //
  // A pill at the bottom centre of the preview, in the geometry of a reader
  // app: volume, theme settings, −10 s, play/pause, +10 s, speed and close.
  // It is on screen whenever read aloud is enabled — pressing play with
  // nothing loaded starts a read at the first block in view — and the × puts
  // it away until the next read.
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

  /**
   * The theme settings sheet (`featrues/control2.png`, 07 §14): the Global
   * theme, the player font, the text size (07 §5), the word marker (07 §9)
   * and the five highlight palettes, then Reset and the reader guidance.
   */
  function makeSheet() {
    var sheet = document.createElement('div');
    sheet.className = 'mpe-ra-ui mpe-ra-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Theme settings');
    sheet.hidden = true;

    var head = document.createElement('div');
    head.className = 'mpe-ra-sheet-head';
    var title = document.createElement('span');
    title.className = 'mpe-ra-sheet-title';
    title.textContent = 'Theme settings';
    var close = makeIconButton(
      'themeClose',
      'Close theme settings',
      'mpe-ra-bar-btn mpe-ra-sheet-close',
      'close',
    );
    head.appendChild(title);
    head.appendChild(close);

    // Global theme (05 §9.1): the row the reference had and 03 left out.
    var pageLabel = document.createElement('span');
    pageLabel.className = 'mpe-ra-sheet-label';
    pageLabel.textContent = 'Global theme';
    var seg = document.createElement('div');
    seg.className = 'mpe-ra-seg';
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Global theme');
    var segments = Object.create(null);
    for (var g = 0; g < core.GLOBAL_THEMES.length; g++) {
      var choice = core.GLOBAL_THEMES[g];
      if (!GLOBAL_THEME_LABELS[choice]) {
        // `off` is a Settings value, not a segment (D2).
        continue;
      }
      var segment = document.createElement('button');
      segment.type = 'button';
      segment.className = 'mpe-ra-ui mpe-ra-seg-btn';
      segment.setAttribute('data-mpe-ra-action', 'globalTheme');
      segment.setAttribute('data-mpe-ra-page-choice', choice);
      segment.setAttribute('role', 'radio');
      segment.setAttribute('aria-checked', 'false');
      segment.textContent = GLOBAL_THEME_LABELS[choice];
      segments[choice] = segment;
      seg.appendChild(segment);
    }
    var pageHint = document.createElement('p');
    pageHint.className = 'mpe-ra-sheet-hint';
    pageHint.textContent = PAGE_OFF_HINT;
    pageHint.hidden = true;

    var fontLabel = document.createElement('label');
    fontLabel.className = 'mpe-ra-sheet-label';
    fontLabel.textContent = 'Player font';
    var fontSelect = document.createElement('select');
    fontSelect.className = 'mpe-ra-ui mpe-ra-sheet-select mpe-ra-sheet-font';
    for (var i = 0; i < core.PLAYER_FONTS.length; i++) {
      var font = core.PLAYER_FONTS[i];
      var option = document.createElement('option');
      option.value = font.id;
      option.textContent = font.label;
      if (font.stack) {
        option.style.fontFamily = font.stack;
      }
      fontSelect.appendChild(option);
    }
    fontLabel.appendChild(fontSelect);

    // Text size (07 §5.6): one slider, 16–28 px, from which the line height,
    // the measure and the heading sizes derive.
    var sizeLabel = document.createElement('label');
    sizeLabel.className = 'mpe-ra-sheet-label mpe-ra-sheet-size-label';
    var sizeText = document.createTextNode('');
    sizeLabel.appendChild(sizeText);
    var sizeRange = document.createElement('input');
    sizeRange.className =
      'mpe-ra-ui mpe-ra-pop-range mpe-ra-sheet-range mpe-ra-sheet-size';
    sizeRange.type = 'range';
    sizeRange.min = String(core.TEXT_SIZE_MIN);
    sizeRange.max = String(core.TEXT_SIZE_MAX);
    sizeRange.step = String(core.TEXT_SIZE_STEP);
    sizeRange.setAttribute('aria-label', 'Text size');
    sizeLabel.appendChild(sizeRange);

    // Word marker (07 §9.3): a segmented control like the Global theme's.
    var markerLabel = document.createElement('span');
    markerLabel.className = 'mpe-ra-sheet-label';
    markerLabel.textContent = 'Word marker';
    var markerSeg = document.createElement('div');
    markerSeg.className = 'mpe-ra-seg mpe-ra-seg-marker';
    markerSeg.setAttribute('role', 'radiogroup');
    markerSeg.setAttribute('aria-label', 'Word marker');
    var markerSegments = Object.create(null);
    for (var m = 0; m < core.WORD_MARKERS.length; m++) {
      var marker = core.WORD_MARKERS[m];
      var markerButton = document.createElement('button');
      markerButton.type = 'button';
      markerButton.className = 'mpe-ra-ui mpe-ra-seg-btn';
      markerButton.setAttribute('data-mpe-ra-action', 'wordMarker');
      markerButton.setAttribute('data-mpe-ra-marker-choice', marker);
      markerButton.setAttribute('role', 'radio');
      markerButton.setAttribute('aria-checked', 'false');
      markerButton.textContent = WORD_MARKER_LABELS[marker] || marker;
      markerSegments[marker] = markerButton;
      markerSeg.appendChild(markerButton);
    }

    var themeLabel = document.createElement('span');
    themeLabel.className = 'mpe-ra-sheet-label';
    themeLabel.textContent = 'Player highlight theme';

    var swatches = document.createElement('div');
    swatches.className = 'mpe-ra-sheet-swatches';
    swatches.setAttribute('role', 'radiogroup');
    swatches.setAttribute('aria-label', 'Player highlight theme');
    // The cards paint the chosen marker through this attribute (07 §9.3).
    swatches.setAttribute(MARKER_ATTR, config.wordMarker);
    var swatchByTheme = Object.create(null);
    for (var t = 0; t < core.HIGHLIGHT_THEMES.length; t++) {
      var theme = core.HIGHLIGHT_THEMES[t];
      var swatch = makeSwatch(theme);
      swatchByTheme[theme] = swatch;
      swatches.appendChild(swatch);
    }

    // Reset page settings, and the reader guidance (05 §9.4).
    var footer = document.createElement('div');
    footer.className = 'mpe-ra-sheet-footer';
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'mpe-ra-ui mpe-ra-sheet-reset';
    reset.setAttribute('data-mpe-ra-action', 'resetPage');
    reset.textContent = 'Reset page settings';
    var note = document.createElement('p');
    note.className = 'mpe-ra-sheet-note';
    note.textContent = READER_GUIDANCE;
    footer.appendChild(reset);
    footer.appendChild(note);

    sheet.appendChild(head);
    sheet.appendChild(pageLabel);
    sheet.appendChild(seg);
    sheet.appendChild(pageHint);
    sheet.appendChild(fontLabel);
    sheet.appendChild(sizeLabel);
    sheet.appendChild(markerLabel);
    sheet.appendChild(markerSeg);
    sheet.appendChild(themeLabel);
    sheet.appendChild(swatches);
    sheet.appendChild(footer);

    return {
      root: sheet,
      segments: segments,
      hint: pageHint,
      font: fontSelect,
      fontDefaultOption: fontSelect.options[0],
      sizeRange: sizeRange,
      sizeText: sizeText,
      markerSegments: markerSegments,
      swatchContainer: swatches,
      swatches: swatchByTheme,
      reset: reset,
    };
  }

  /** One palette card: three lines of sample text with one word spoken. */
  function makeSwatch(theme) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'mpe-ra-ui mpe-ra-swatch';
    button.setAttribute('data-mpe-ra-action', 'highlightTheme');
    button.setAttribute('data-mpe-ra-theme-choice', theme);
    // The palettes of media/read-aloud.css are keyed on these two attributes,
    // so a swatch paints itself exactly as the preview would.
    button.setAttribute('data-mpe-ra-theme', theme);
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    var name = theme.charAt(0).toUpperCase() + theme.slice(1);
    button.setAttribute('aria-label', name + ' highlight theme');

    var lines = [
      ['In a world where', -1],
      ['melodies dance and', 0],
      ['dreams take flight', -1],
    ];
    for (var i = 0; i < lines.length; i++) {
      var line = document.createElement('span');
      line.className = 'mpe-ra-swatch-line';
      var words = lines[i][0].split(' ');
      for (var w = 0; w < words.length; w++) {
        if (w > 0) {
          line.appendChild(document.createTextNode(' '));
        }
        if (w === lines[i][1]) {
          var spoken = document.createElement('span');
          spoken.className = 'mpe-ra-swatch-word';
          spoken.textContent = words[w];
          line.appendChild(spoken);
        } else {
          line.appendChild(document.createTextNode(words[w]));
        }
      }
      button.appendChild(line);
    }

    var caption = document.createElement('span');
    caption.className = 'mpe-ra-swatch-name';
    caption.textContent = name;
    button.appendChild(caption);
    return button;
  }

  /** A footer button of the help sheet: a chip, Ask, Back, Resume, … */
  function makeHelpButton(action, label, className) {
    var button = makeButton(action, label, 'mpe-ra-help-btn ' + className);
    button.textContent = label;
    return button;
  }

  /**
   * The help sheet (04-help-module §4): a wider sheet above the panel in the
   * theme sheet's style, holding the explanation, the follow-up chips and the
   * question box.
   *
   * Its **body** deliberately does not carry `.mpe-ra-ui`: it is the second
   * reading scope (§5), so its rendered paragraphs, lists and headings are
   * classified by the existing eligibility rules with no new code, while
   * everything around it stays chrome the reader never speaks.
   */
  function makeHelpSheet() {
    var sheet = document.createElement('div');
    sheet.className = 'mpe-ra-ui mpe-ra-help';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Help');
    sheet.setAttribute('tabindex', '-1');
    sheet.hidden = true;

    var head = document.createElement('div');
    head.className = 'mpe-ra-help-head';
    var title = document.createElement('span');
    title.className = 'mpe-ra-help-title';
    title.textContent = 'Help';
    // The engine label is a button: it opens the same quick pick as the
    // `Choose Help Model` command, so the model or the effort can be raised
    // before Retry or a follow-up without leaving the preview (§4 step 2).
    var label = makeButton(
      'helpModel',
      'Change the help model',
      'mpe-ra-help-model',
    );
    var close = makeIconButton(
      'helpClose',
      'Close help',
      'mpe-ra-bar-btn mpe-ra-sheet-close',
      'close',
    );
    head.appendChild(title);
    head.appendChild(label);
    head.appendChild(close);

    var body = document.createElement('div');
    body.className = HELP_BODY_CLASS;

    var status = document.createElement('div');
    status.className = 'mpe-ra-help-status';
    var statusText = document.createElement('span');
    statusText.className = 'mpe-ra-help-status-text';
    statusText.setAttribute('role', 'status');
    statusText.setAttribute('aria-live', 'polite');
    var cancel = makeHelpButton('helpCancel', 'Cancel', 'mpe-ra-help-cancel');
    var retry = makeHelpButton('helpRetry', 'Retry', 'mpe-ra-help-retry');
    status.appendChild(statusText);
    status.appendChild(cancel);
    status.appendChild(retry);

    var footer = document.createElement('div');
    footer.className = 'mpe-ra-help-footer';

    var chips = document.createElement('div');
    chips.className = 'mpe-ra-help-chips';
    var simpler = makeHelpButton('helpSimpler', 'Simpler', 'mpe-ra-help-chip');
    var deeper = makeHelpButton('helpDeeper', 'Deeper', 'mpe-ra-help-chip');
    var example = makeHelpButton('helpExample', 'Example', 'mpe-ra-help-chip');
    chips.appendChild(simpler);
    chips.appendChild(deeper);
    chips.appendChild(example);

    var ask = document.createElement('div');
    ask.className = 'mpe-ra-help-ask';
    var input = document.createElement('input');
    input.className = 'mpe-ra-ui mpe-ra-help-input';
    input.type = 'text';
    input.placeholder = 'What confused you?';
    input.setAttribute('aria-label', 'Ask a question about the passage');
    var askButton = makeHelpButton('helpAsk', 'Ask', 'mpe-ra-help-send');
    ask.appendChild(input);
    ask.appendChild(askButton);

    var actions = document.createElement('div');
    actions.className = 'mpe-ra-help-actions';
    var back = makeHelpButton('helpBack', 'Back', 'mpe-ra-help-action');
    var again = makeHelpButton(
      'helpPlayAgain',
      'Play again',
      'mpe-ra-help-action',
    );
    var resume = makeHelpButton(
      'helpResume',
      'Resume',
      'mpe-ra-help-action mpe-ra-help-resume',
    );
    // 12 §5.4 — the explanation on screen becomes a note, no second call.
    var save = makeHelpButton(
      'helpSaveNote',
      'Save as note',
      'mpe-ra-help-action mpe-ra-help-save',
    );
    save.hidden = true;
    // 13 §5.5 — the explanation was not enough: escalate to a module.
    var teach = makeHelpButton(
      'helpTeach',
      CLASSROOM_TEACH_LABEL,
      'mpe-ra-help-action mpe-ra-help-teach',
    );
    teach.hidden = true;
    actions.appendChild(back);
    actions.appendChild(again);
    actions.appendChild(save);
    actions.appendChild(teach);
    actions.appendChild(resume);

    footer.appendChild(chips);
    footer.appendChild(ask);
    footer.appendChild(actions);

    sheet.appendChild(head);
    sheet.appendChild(body);
    sheet.appendChild(status);
    sheet.appendChild(footer);

    return {
      root: sheet,
      label: label,
      body: body,
      status: status,
      statusText: statusText,
      cancel: cancel,
      retry: retry,
      footer: footer,
      chips: [simpler, deeper, example],
      input: input,
      ask: askButton,
      back: back,
      again: again,
      save: save,
      teach: teach,
      resume: resume,
    };
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

    // _Back to the reading_ (07 §7.5): the status slot's other occupant.
    var chip = makeButton('follow', FOLLOW_CHIP_LABEL, 'mpe-ra-bar-chip');
    chip.textContent = FOLLOW_CHIP_LABEL;
    chip.hidden = true;

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

    var themeButton = makeIconButton(
      'theme',
      'Theme settings',
      'mpe-ra-bar-btn mpe-ra-bar-theme',
      'theme',
    );
    themeButton.setAttribute('aria-haspopup', 'dialog');
    themeButton.setAttribute('aria-expanded', 'false');

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

    // 04-help-module §2: between the speed and the ×, so the × stays last.
    var helpButton = makeIconButton(
      'help',
      HELP_TOOLTIP,
      'mpe-ra-bar-btn mpe-ra-bar-help',
      'help',
    );
    helpButton.setAttribute('aria-haspopup', 'dialog');
    helpButton.setAttribute('aria-expanded', 'false');

    // 12 §12: the Notes button, between help and the ×, with a count badge.
    var notesButton = makeIconButton(
      'notes',
      NOTES_TOOLTIP,
      'mpe-ra-bar-btn mpe-ra-bar-notes',
      'notes',
    );
    notesButton.setAttribute('aria-haspopup', 'dialog');
    notesButton.setAttribute('aria-expanded', 'false');
    notesButton.hidden = !config.notesAvailable;
    var notesBadge = document.createElement('span');
    notesBadge.className = 'mpe-ra-bar-badge';
    notesBadge.setAttribute('aria-hidden', 'true');
    notesBadge.hidden = true;
    notesButton.appendChild(notesBadge);

    // 13 §12.2: the module preview's own button, between notes and the ×,
    // with a progress badge. Absent in every other preview.
    var classroomButton = makeIconButton(
      'classroomModule',
      CLASSROOM_MODULE_TOOLTIP,
      'mpe-ra-bar-btn mpe-ra-bar-classroom',
      'classroom',
    );
    classroomButton.setAttribute('aria-haspopup', 'dialog');
    classroomButton.setAttribute('aria-expanded', 'false');
    classroomButton.hidden = !config.classroomModule;
    var classroomBadge = document.createElement('span');
    classroomBadge.className = 'mpe-ra-bar-badge mpe-ra-bar-classroom-badge';
    classroomBadge.setAttribute('aria-hidden', 'true');
    classroomBadge.hidden = true;
    classroomButton.appendChild(classroomBadge);

    var close = makeIconButton(
      'close',
      'Close the player',
      'mpe-ra-bar-btn mpe-ra-bar-close',
      'close',
    );

    var sheet = makeSheet();
    var helpSheet = makeHelpSheet();
    var noteSheet = makeNoteSheet();
    var listSheet = makeNotesListSheet();
    var noteChip = makeNoteChip();
    var classroomSheet = makeClassroomSheet();
    var moduleSheet = makeModuleSheet();

    bar.appendChild(progress);
    bar.appendChild(status);
    bar.appendChild(chip);
    bar.appendChild(volumePop.root);
    bar.appendChild(speedPop.root);
    bar.appendChild(sheet.root);
    bar.appendChild(helpSheet.root);
    bar.appendChild(noteSheet.root);
    bar.appendChild(listSheet.root);
    bar.appendChild(classroomSheet.root);
    bar.appendChild(moduleSheet.root);
    bar.appendChild(noteChip.root);
    bar.appendChild(volumeButton);
    bar.appendChild(themeButton);
    bar.appendChild(back);
    bar.appendChild(play);
    bar.appendChild(forward);
    bar.appendChild(speedButton);
    bar.appendChild(helpButton);
    bar.appendChild(notesButton);
    bar.appendChild(classroomButton);
    bar.appendChild(close);
    document.body.appendChild(bar);

    // The idle progress strip (07 §10.1): fixed at the bottom edge of the
    // viewport, in <body> beside the panel, shown only while the panel is
    // faded out.
    strip = document.createElement('div');
    strip.className = 'mpe-ra-strip mpe-ra-ui ' + UNZOOM_CLASS;
    strip.setAttribute('aria-hidden', 'true');
    strip.hidden = true;
    stripFill = document.createElement('i');
    strip.appendChild(stripFill);
    document.body.appendChild(strip);

    barParts = {
      progress: progress,
      progressFill: progressFill,
      status: status,
      chip: chip,
      volume: volumeButton,
      volumePop: volumePop,
      theme: themeButton,
      sheet: sheet,
      back: back,
      play: play,
      forward: forward,
      speed: speedButton,
      speedPop: speedPop,
      helpButton: helpButton,
      help: helpSheet,
      notesButton: notesButton,
      notesBadge: notesBadge,
      note: noteSheet,
      notesList: listSheet,
      noteChip: noteChip,
      classroomButton: classroomButton,
      classroomBadge: classroomBadge,
      classroom: classroomSheet,
      module: moduleSheet,
      close: close,
    };

    speedPop.range.addEventListener('input', function () {
      applyRate(parseFloat(speedPop.range.value), true, speedPop.range);
    });
    volumePop.range.addEventListener('input', function () {
      applyVolume(parseFloat(volumePop.range.value), true, volumePop.range);
    });
    sheet.font.addEventListener('change', function () {
      applyFont(sheet.font.value, true);
    });
    sheet.sizeRange.addEventListener('input', function () {
      applyTextSize(parseFloat(sheet.sizeRange.value), true, sheet.sizeRange);
    });
    // Auto-hide (07 §10.1): the panel never fades under the pointer or with
    // focus inside it; leaving it starts the countdown again.
    bar.addEventListener('pointerenter', function () {
      pointerOverBar = true;
      touchPanel();
    });
    bar.addEventListener('pointerleave', function () {
      pointerOverBar = false;
      armPanelIdle();
    });
    bar.addEventListener('focusin', touchPanel);
    bar.addEventListener('focusout', function () {
      // Let the focus land before deciding whether it left the panel.
      setTimeout(armPanelIdle, 0);
    });
    helpSheet.input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        askTypedQuestion();
      }
    });
    helpSheet.input.addEventListener('input', syncHelpSheet);
    // The Note sheet's fields (12 §11.1): My note saves 500 ms after the last
    // keystroke and on blur; tags commit on Enter or a comma.
    noteSheet.textarea.addEventListener('input', onMyNoteInput);
    noteSheet.textarea.addEventListener('blur', flushMyNote);
    noteSheet.tagInput.addEventListener('keydown', onTagInputKeydown);
    noteSheet.tagInput.addEventListener('blur', function () {
      commitTagInput();
    });
    // The Classroom sheet's fields (13 §5.2) are read at Build; the note
    // and the audience are mirrored so a re-render keeps what was typed.
    classroomSheet.note.addEventListener('input', function () {
      classroom.note = classroomSheet.note.value.slice(0, CLASSROOM_NOTE_MAX);
    });
    classroomSheet.audience.addEventListener('input', function () {
      classroom.audience = classroomSheet.audience.value.slice(
        0,
        CLASSROOM_AUDIENCE_MAX,
      );
    });
    classroomSheet.persona.addEventListener('change', function () {
      classroom.personaId = classroomSheet.persona.value;
    });
    classroomSheet.note.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        buildClassroom();
      }
    });
    bar.addEventListener('keydown', onBarKeydown);

    applyBarScheme();
    // The sheet exists now, so a font chosen before the panel was built
    // reaches it (09 §6.2).
    applyFontToRoot();
    syncSpeedControls();
    syncVolumeControls();
    syncSheet();
    syncHelpSheet();
    syncNotesBar();
    syncNotesList();
    syncClassroomBar();
    syncClassroomSheet();
    syncModuleSheet();
    renderBar();
    return bar;
  }

  /** The panel takes its light/dark palette from the preview background. */
  function applyBarScheme() {
    if (!bar || !root) {
      return;
    }
    var scheme = root.getAttribute('data-mpe-ra-scheme');
    if (!scheme) {
      return;
    }
    bar.setAttribute('data-mpe-ra-scheme', scheme);
    if (strip) {
      strip.setAttribute('data-mpe-ra-scheme', scheme);
    }
    if (!barParts || !barParts.sheet) {
      return;
    }
    // The palettes are keyed on the theme and the scheme together, on one
    // element, so every swatch carries the scheme as well as its own theme.
    for (var i = 0; i < core.HIGHLIGHT_THEMES.length; i++) {
      barParts.sheet.swatches[core.HIGHLIGHT_THEMES[i]].setAttribute(
        'data-mpe-ra-scheme',
        scheme,
      );
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
    syncHelpButton();
    updateTimeDisplay();
    applyCanvasClasses();
    syncChip();
    armPanelIdle();
  }

  function showBar(statusText) {
    ensureBar();
    finishTimer = clearTimer(finishTimer);
    bar.hidden = !barVisible();
    barParts.status.textContent = statusText || '';
    if (statusText) {
      // A message — Loading…, Paused, Finished, an error — brings the panel
      // back (07 §10.1).
      wakePanel();
    }
    renderBar();
  }

  /**
   * _Back to the reading_ (07 §7.5): shown while a read is on, the following
   * is suspended and the status slot is free; the messages win the slot.
   */
  function syncChip() {
    if (!barParts || !barParts.chip) {
      return;
    }
    var show =
      record.state !== 'idle' &&
      !follow.engaged &&
      !barParts.status.textContent;
    if (barParts.chip.hidden === !show) {
      return;
    }
    barParts.chip.hidden = !show;
  }

  // ------------------------------------------------ panel auto-hide (07 §10)

  /**
   * Keyboard focus inside the panel (07 §10.1): a control reached with Tab
   * keeps the panel on screen. A button the mouse clicked is focused too,
   * but not `:focus-visible`, and must not pin the panel for the rest of
   * the read; where the engine has no `:focus-visible`, any focus counts.
   */
  function keyboardFocusInBar() {
    var active = document.activeElement;
    if (!active || !bar || active === document.body || !bar.contains(active)) {
      return false;
    }
    try {
      return active.matches(':focus-visible');
    } catch (error) {
      return true;
    }
  }

  /** Whether the panel may fade right now. */
  function panelIdleEligible() {
    return (
      config.panelAutoHide &&
      record.state === 'playing' &&
      barVisible() &&
      !!bar &&
      !bar.hidden &&
      !anyPopoverOpen() &&
      !help.open &&
      // 09 §11: a selection affordance on screen means the reader is about to
      // ask for something. The panel is not taken away underneath it; the
      // next plain click collapses the selection, hides the affordance and
      // starts the countdown again.
      !floatVisible() &&
      !pointerOverBar &&
      !keyboardFocusInBar()
    );
  }

  function setPanelIdle(idle) {
    if (panelIdle === idle) {
      return;
    }
    panelIdle = idle;
    if (bar) {
      bar.classList.toggle('mpe-ra-bar-idle', idle);
    }
    if (strip) {
      strip.hidden = !idle;
    }
  }

  /** Bring the panel back and stop the countdown. */
  function wakePanel() {
    panelIdleTimer = clearTimer(panelIdleTimer);
    setPanelIdle(false);
  }

  /**
   * Keep the countdown running while the panel may fade, without waking a
   * panel that has already faded: called on every render, so a chunk
   * hand-off does not pop the panel back.
   */
  function armPanelIdle() {
    if (!panelIdleEligible()) {
      wakePanel();
      return;
    }
    if (panelIdle || panelIdleTimer) {
      return;
    }
    panelIdleTimer = setTimeout(function () {
      panelIdleTimer = 0;
      if (panelIdleEligible()) {
        setPanelIdle(true);
      }
    }, PANEL_IDLE_MS);
  }

  /** Activity: the panel comes back and the countdown restarts (07 §10.1). */
  function touchPanel() {
    wakePanel();
    armPanelIdle();
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
    wakePanel();
    if (bar) {
      bar.hidden = true;
      if (barParts) {
        barParts.status.textContent = '';
        barParts.chip.hidden = true;
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
      // During a block gap (07 §11) the finished chunk has handed its
      // element back: the read stands at its end.
      elapsed =
        offsetOf(record.current) +
        (record.gapTimer
          ? chunkLength(playing)
          : playing.slot
            ? playing.slot.el.currentTime
            : 0);
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
      if (stripFill) {
        stripFill.style.width = percent + '%';
      }
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

  var POPOVER_NAMES = ['volume', 'speed', 'theme'];

  function popoverFor(name) {
    if (!barParts) {
      return null;
    }
    if (name === 'volume') {
      return {
        pop: barParts.volumePop.root,
        focus: barParts.volumePop.range,
        button: barParts.volume,
      };
    }
    if (name === 'speed') {
      return {
        pop: barParts.speedPop.root,
        focus: barParts.speedPop.range,
        button: barParts.speed,
      };
    }
    if (name === 'theme') {
      return {
        pop: barParts.sheet.root,
        focus: barParts.sheet.font,
        button: barParts.theme,
      };
    }
    return null;
  }

  function anyPopoverOpen() {
    if (!barParts) {
      return false;
    }
    for (var i = 0; i < POPOVER_NAMES.length; i++) {
      if (!popoverFor(POPOVER_NAMES[i]).pop.hidden) {
        return true;
      }
    }
    return false;
  }

  function closePopovers(except) {
    if (!barParts) {
      return;
    }
    for (var i = 0; i < POPOVER_NAMES.length; i++) {
      if (POPOVER_NAMES[i] === except) {
        continue;
      }
      var found = popoverFor(POPOVER_NAMES[i]);
      found.pop.hidden = true;
      found.button.setAttribute('aria-expanded', 'false');
    }
    armPanelIdle();
  }

  function togglePopover(name) {
    var found = popoverFor(name);
    if (!found) {
      return;
    }
    var open = found.pop.hidden;
    closePopovers(name);
    found.pop.hidden = !open;
    found.button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      if (name === 'theme') {
        syncSheet();
      }
      if (lastGestureWasKey && found.focus && found.focus.focus) {
        found.focus.focus();
      }
    }
    // An open sheet or popover keeps the panel on screen (07 §10.1).
    touchPanel();
  }

  // ------------------------------------------------ 7b. Theme settings

  /**
   * The player font: an override for the preview theme's own family. A new
   * face has a new average advance, so the measure is taken again (07 §6.2).
   */
  function applyFont(value, persist) {
    config.font = core.normalisePlayerFont(value);
    applyFontToRoot();
    measureCharEm();
    syncSheet();
    if (persist) {
      post('readAloudSetFont', [config.font]);
    }
  }

  /**
   * The text size slider (07 §5.3): the page follows at once — the line
   * height and the measure derive from it in applyPage — and the host
   * persists the value on the speed's debounce; its broadcast brings every
   * other preview along. `from` is the slider the value came from, if any.
   */
  function applyTextSize(value, persist, from) {
    config.textSize = core.clampTextSize(value);
    applyPage();
    syncSheet(from);
    if (!persist) {
      return;
    }
    textSizeTimer = clearTimer(textSizeTimer);
    textSizeTimer = setTimeout(function () {
      textSizeTimer = 0;
      post('readAloudSetTextSize', [config.textSize]);
    }, TEXT_SIZE_DEBOUNCE_MS);
  }

  /** The word marker (07 §9.3): applied at once, persisted through the host. */
  function applyWordMarker(value, persist) {
    config.wordMarker = core.normaliseWordMarker(value);
    applyThemeAttributes();
    syncSheet();
    if (persist) {
      post('readAloudSetWordMarker', [config.wordMarker]);
    }
  }

  /**
   * The chosen player font, published on the preview root and — 09 §6.2 — on
   * the help sheet, which lives in <body> beside the panel and so never saw
   * the root's copy. Set on the sheet element rather than on <html> so
   * nothing outside the dialog can pick it up.
   */
  function applyFontToRoot() {
    var stack = core.playerFontStack(config.font);
    var sheet = barParts && barParts.help ? barParts.help.root : null;
    var targets = [root, sheet];
    for (var i = 0; i < targets.length; i++) {
      var target = targets[i];
      if (!target) {
        continue;
      }
      try {
        if (stack) {
          target.style.setProperty('--mpe-ra-font-family', stack);
        } else {
          target.style.removeProperty('--mpe-ra-font-family');
        }
      } catch (error) {
        /* cosmetic only */
      }
    }
    if (root) {
      root.classList.toggle('mpe-ra-font', !!stack);
    }
  }

  /**
   * The Global theme (05 §4.4): the page switches at once, the decoration
   * and the panel follow through the same attribute, and the host persists
   * the choice — its settings-change broadcast brings every other preview
   * along, the way a highlight-theme change does.
   */
  function applyGlobalTheme(value, persist) {
    config.globalTheme = core.normaliseGlobalTheme(value);
    applyPage();
    applyThemeAttributes();
    syncSheet();
    if (persist) {
      post('readAloudSetGlobalTheme', [config.globalTheme]);
    }
  }

  /**
   * Reset page settings (05 §9.4, 07 §14): the host clears the four page
   * settings — the Global theme, the text size, the font, the word marker —
   * and its broadcast restores the sheet. The highlight palette, speed,
   * volume, dimming and auto-hide are player preferences and are left alone;
   * crossnote's zoom is no longer a sheet control and is not touched.
   */
  function resetPage() {
    post('readAloudResetPage', []);
  }

  /** The highlight palette: applied at once, persisted through the host. */
  function applyHighlightTheme(value, persist) {
    config.highlightTheme = core.normaliseHighlightTheme(value);
    applyThemeAttributes();
    syncSheet();
    if (persist) {
      post('readAloudSetHighlightTheme', [config.highlightTheme]);
    }
  }

  /** Every control of the sheet, from `config`. */
  function syncSheet(from) {
    if (!barParts || !barParts.sheet) {
      return;
    }
    var sheet = barParts.sheet;
    var on = pageIsOn();
    // Global theme: under `off` no segment is checked, the hint shows and
    // the text size slider is disabled (05 §9.1, 07 §5.6).
    for (var g = 0; g < core.GLOBAL_THEMES.length; g++) {
      var choice = core.GLOBAL_THEMES[g];
      if (sheet.segments[choice]) {
        sheet.segments[choice].setAttribute(
          'aria-checked',
          on && choice === config.globalTheme ? 'true' : 'false',
        );
      }
    }
    sheet.hint.hidden = config.globalTheme !== 'off';
    // `default` means the page's own face while the page is on (05 §9.2).
    var defaultLabel = on ? FONT_DEFAULT_LABEL_PAGE : FONT_DEFAULT_LABEL_OFF;
    if (sheet.fontDefaultOption.textContent !== defaultLabel) {
      sheet.fontDefaultOption.textContent = defaultLabel;
    }
    if (sheet.font.value !== config.font) {
      sheet.font.value = config.font;
    }
    // Text size (07 §5.6): the label shows the value even while disabled.
    sheet.sizeText.data = 'Text size: ' + config.textSize + ' px';
    sheet.sizeRange.setAttribute('aria-valuetext', config.textSize + ' pixels');
    if (sheet.sizeRange !== from) {
      sheet.sizeRange.value = String(config.textSize);
    }
    setRangeFill(
      sheet.sizeRange,
      (config.textSize - core.TEXT_SIZE_MIN) /
        (core.TEXT_SIZE_MAX - core.TEXT_SIZE_MIN),
    );
    sheet.sizeRange.disabled = !on;
    // Word marker (07 §9.3): not disabled under `off`; it needs no page.
    for (var w = 0; w < core.WORD_MARKERS.length; w++) {
      var marker = core.WORD_MARKERS[w];
      if (sheet.markerSegments[marker]) {
        sheet.markerSegments[marker].setAttribute(
          'aria-checked',
          marker === config.wordMarker ? 'true' : 'false',
        );
      }
    }
    if (sheet.swatchContainer.getAttribute(MARKER_ATTR) !== config.wordMarker) {
      sheet.swatchContainer.setAttribute(MARKER_ATTR, config.wordMarker);
    }
    for (var i = 0; i < core.HIGHLIGHT_THEMES.length; i++) {
      var theme = core.HIGHLIGHT_THEMES[i];
      sheet.swatches[theme].setAttribute(
        'aria-checked',
        theme === config.highlightTheme ? 'true' : 'false',
      );
    }
  }

  // ------------------------------------------------------ 7c. Help (§4, §5)
  //
  // The help button explains the passage the listener selected, through a
  // headless CLI on the host. The answer arrives as HTML rendered by the
  // preview's own engine and goes into the sheet body, which is a second
  // reading scope: the same player, panel, highlighting and click-to-read,
  // bounded to the sheet the way a table-cell read is bounded to its cell.

  function applyHelpConfig(message) {
    if (typeof message.helpAvailable === 'boolean') {
      config.helpAvailable = message.helpAvailable;
    }
    if (typeof message.helpEngine === 'string') {
      config.helpEngine = message.helpEngine;
    }
    if (typeof message.helpModel === 'string') {
      config.helpModel = message.helpModel;
    }
    if (typeof message.helpEffort === 'string') {
      config.helpEffort = message.helpEffort;
    }
    if (typeof message.helpAutoPlay === 'boolean') {
      config.helpAutoPlay = message.helpAutoPlay;
    }
    if (typeof message.helpContextMode === 'string') {
      config.helpContextMode = message.helpContextMode;
    }
  }

  /** `claude · sonnet · low` — the sheet's header button and its status line. */
  function helpLabelText() {
    var parts = [config.helpEngine];
    if (config.helpModel) {
      parts.push(config.helpModel);
    }
    if (config.helpEffort && config.helpEffort !== 'n/a') {
      parts.push(config.helpEffort);
    }
    return parts.join(' · ');
  }

  /**
   * §2 — what the help button would explain, or null when nothing can be:
   *
   * 1. a live preview selection, resolved the way the floating _Read aloud_
   *    affordance's is, or
   * 2. the passage of a selection read that is playing or paused, remembered
   *    on the job so a collapsed browser selection does not disable the
   *    button mid-read.
   *
   * Both are bounded to the preview root, which is what keeps a selection
   * inside the sheet from being explained (D9).
   *
   * The live selection is resolved here and now rather than read off
   * `floatSelection` (09 §8). That variable is bookkeeping for the
   * affordance's position, and it used to be cleared by things that say
   * nothing about whether a selection exists — a scroll above all, and the
   * follow-the-reading loop scrolls on every frame of a read, so the button
   * and `Alt+H` with it went dead within a frame of any selection made while
   * listening.
   */
  function helpPassage() {
    var live = liveSelectionIn(root);
    if (live) {
      // The range travels with the passage so the enclosing block can mark
      // the selected words at their exact offset (11), not a repeat of them.
      var selection = window.getSelection();
      return {
        text: live.text,
        els: live.blocks.slice(),
        range:
          selection && selection.rangeCount ? selection.getRangeAt(0) : null,
      };
    }
    if (
      record.kind === 'selection' &&
      record.scope === root &&
      (record.state === 'playing' ||
        record.state === 'paused' ||
        record.state === 'loading') &&
      record.text &&
      record.blockEls.length
    ) {
      return { text: record.text, els: record.blockEls.slice() };
    }
    return null;
  }

  function syncHelpButton() {
    // The affordance's _Explain_ (09 §10) follows the same availability flag,
    // which may arrive from the host after the affordance was built.
    if (floatParts && floatParts.help) {
      floatParts.help.hidden = !config.helpAvailable || floatScope !== root;
    }
    if (floatParts && floatParts.note) {
      floatParts.note.hidden = !config.notesAvailable || floatScope !== root;
    }
    if (floatParts && floatParts.classroom) {
      floatParts.classroom.hidden =
        !config.classroomAvailable || floatScope !== root;
    }
    // The orphan banner's Re-attach follows the live selection too (12 §11.3).
    syncNoteReattach();
    if (!barParts || !barParts.helpButton) {
      return;
    }
    var button = barParts.helpButton;
    // §1 — the web build cannot spawn a process, so the button is not there.
    button.hidden = !config.helpAvailable;
    if (!config.helpAvailable) {
      return;
    }
    var passage = help.open ? null : helpPassage();
    var enabled = help.open || !!passage;
    setEnabled(button, enabled);
    var label = help.open
      ? 'Close help'
      : passage
        ? HELP_TOOLTIP
        : HELP_TOOLTIP_DISABLED;
    button.setAttribute('title', label);
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', help.open ? 'true' : 'false');
  }

  function helpElapsedSeconds() {
    return Math.max(0, Math.round((Date.now() - help.startedAt) / 1000));
  }

  function syncHelpSheet() {
    if (!barParts || !barParts.help) {
      return;
    }
    var sheet = barParts.help;
    var labelText = helpLabelText();
    sheet.label.textContent = labelText;
    sheet.label.setAttribute('title', 'Help model: ' + labelText);
    sheet.label.setAttribute(
      'aria-label',
      'Help model: ' + labelText + '. Choose another.',
    );

    var thinking = help.state === 'thinking';
    var failed = help.state === 'error';
    sheet.cancel.hidden = !thinking;
    sheet.retry.hidden = !failed;
    sheet.statusText.textContent = thinking
      ? 'Thinking… (' + labelText + ') — ' + helpElapsedSeconds() + ' s'
      : failed
        ? help.message
        : '';
    sheet.status.hidden = !thinking && !failed;

    var ready = help.state === 'ready' && !!help.markdown;
    for (var i = 0; i < sheet.chips.length; i++) {
      setEnabled(sheet.chips[i], ready);
    }
    sheet.input.disabled = !ready;
    setEnabled(sheet.ask, ready && sheet.input.value.trim().length > 0);
    setEnabled(sheet.back, help.stack.length > 0);
    setEnabled(sheet.again, ready && helpBlocks.length > 0);
    if (sheet.save) {
      // 12 §5.4 — visible with an answer, Saved (and disabled) once kept.
      sheet.save.hidden = !ready || !config.notesAvailable;
      setEnabled(sheet.save, ready && !help.saved);
      if (help.saved) {
        sheet.save.innerHTML = ICONS.check;
        sheet.save.appendChild(document.createTextNode('Saved'));
        sheet.save.setAttribute('title', 'Saved as a note');
        sheet.save.setAttribute('aria-label', 'Saved as a note');
      } else {
        sheet.save.textContent = 'Save as note';
        sheet.save.setAttribute('title', 'Keep this explanation as a note');
        sheet.save.setAttribute('aria-label', 'Save as note');
      }
    }

    if (sheet.teach) {
      // 13 §5.5 — visible whenever the sheet holds an answer.
      sheet.teach.hidden = !ready || !config.classroomAvailable;
    }

    var resumable = canResume();
    setEnabled(sheet.resume, resumable);
    sheet.resume.setAttribute(
      'title',
      resumable
        ? 'Close help and continue the read where it paused'
        : help.resume
          ? 'The paused text is no longer in the document'
          : 'No read was paused',
    );
  }

  function startHelpTicker() {
    stopHelpTicker();
    help.timer = setInterval(function () {
      if (help.state !== 'thinking') {
        stopHelpTicker();
        return;
      }
      syncHelpSheet();
    }, HELP_TICK_MS);
  }

  function stopHelpTicker() {
    if (help.timer) {
      clearInterval(help.timer);
      help.timer = 0;
    }
  }

  /** The file name of the preview, when the document has no `h1` (§3.1). */
  function documentTitleFallback() {
    var name = String(sourceUri || '').split(/[?#]/)[0];
    var parts = name.split('/');
    try {
      return decodeURIComponent(parts[parts.length - 1] || '');
    } catch (error) {
      return parts[parts.length - 1] || '';
    }
  }

  /**
   * §3.1 — the material of the *first* request, which every follow-up then
   * reuses byte for byte (§14.3). Which fields are gathered follows
   * `readAloudHelpContext`: `selection` sends the title, the breadcrumb,
   * the passage and the block it was taken from, so the least text leaves the
   * machine; `section` and `document` add the document's other mentions of
   * a short passage (11 help fixes).
   */
  function buildHelpContextFor(passage) {
    var context = {
      title: '',
      breadcrumb: [],
      before: '',
      after: '',
      section: '',
      enclosing: '',
      mentions: '',
      passage: passage.text,
      contextMode: config.helpContextMode,
    };
    try {
      var built = core.helpContext(
        root,
        passage.els,
        passage.text,
        passage.range || null,
      );
      context.title = built.title;
      context.breadcrumb = built.breadcrumb;
      // The block the passage came from goes in every mode: a few words out
      // of a sentence mean nothing without it, and it is bounded by one block.
      context.enclosing = built.enclosing;
      if (config.helpContextMode === 'section') {
        context.before = built.before;
        context.after = built.after;
        context.section = built.section;
      }
      if (config.helpContextMode !== 'selection') {
        context.mentions = built.mentions;
      }
    } catch (error) {
      /* the passage on its own is still worth explaining */
    }
    if (!context.title) {
      context.title = documentTitleFallback();
    }
    return context;
  }

  // -------------------------------------------------- the remembered read

  /**
   * §4 step 1 — where the paused read was, so Resume can continue from the
   * same word. A block read is remembered by the block's *content hash*, so
   * it re-locates after a re-render exactly as a continuous read does; a
   * selection read keeps its text, its offset map and its elements, and
   * Resume is disabled once any of them leaves the document (D5).
   */
  function rememberResume() {
    if (
      record.state !== 'playing' &&
      record.state !== 'paused' &&
      record.state !== 'loading'
    ) {
      return null;
    }
    if (record.scope && record.scope !== root) {
      // A help read is not something to come back to.
      return null;
    }
    var spans = record.allSpans;
    var span = record.lastSpan;
    if (!span && spans.length) {
      span =
        spans[
          record.spanIndex < spans.length ? record.spanIndex : spans.length - 1
        ];
    }
    if (record.kind === 'block' && record.readBlocks.length) {
      var rb = record.readBlocks[record.blockIndex] || record.readBlocks[0];
      var offset = rb.startOffset;
      if (span && span.charStart >= rb.start && span.charStart < rb.end) {
        offset = rb.startOffset + (span.charStart - rb.start);
      }
      return {
        kind: 'block',
        key: rb.key,
        offset: offset,
        label: rb.label || record.label,
      };
    }
    if (record.kind === 'selection' && record.text && record.map) {
      return {
        kind: 'selection',
        text: record.text,
        map: record.map,
        offset: span ? span.charStart : 0,
        els: record.blockEls.slice(),
        label: record.label,
      };
    }
    return null;
  }

  function canResume() {
    return canResumeFrom(help.resume);
  }

  /** Whether a remembered read (help's or a note's, 12 §11.5) can continue. */
  function canResumeFrom(resume) {
    if (!resume) {
      return false;
    }
    if (resume.kind === 'block') {
      return !!blocksByKey[resume.key];
    }
    if (!resume.text || !resume.els.length) {
      return false;
    }
    for (var i = 0; i < resume.els.length; i++) {
      var el = resume.els[i];
      if (!el || !el.isConnected || !root || !root.contains(el)) {
        return false;
      }
    }
    return true;
  }

  /** §4 step 6 — close the sheet and continue the read where it paused. */
  function resumeRead() {
    var resume = help.resume;
    if (!canResume()) {
      return;
    }
    closeHelp('resume');
    resumeFrom(resume);
  }

  /** Continue a remembered read: the block from its word, or the selection's rest. */
  function resumeFrom(resume) {
    if (!canResumeFrom(resume)) {
      return;
    }
    if (resume.kind === 'block') {
      var entry = blocksByKey[resume.key];
      if (entry) {
        startBlockRead(entry, resume.offset);
      }
      return;
    }
    // A selection read resumes bounded to what is left of the selection.
    var sliced;
    try {
      sliced = core.sliceExtraction(
        { text: resume.text, map: resume.map },
        resume.offset,
      );
    } catch (error) {
      return;
    }
    if (!sliced || !sliced.text) {
      return;
    }
    startRead({
      kind: 'selection',
      scope: root,
      text: sliced.text,
      map: sliced.map,
      label: resume.label || 'Selection',
      blocks: resume.els,
    });
  }

  // ------------------------------------------------------- open, ask, close

  function toggleHelp() {
    if (help.open) {
      closeHelp('button');
      return;
    }
    openHelp();
  }

  /** §4 steps 1–2. */
  function openHelp() {
    if (!config.enabled || !config.helpAvailable) {
      return;
    }
    var passage = helpPassage();
    if (!passage) {
      showHint(HELP_TOOLTIP_DISABLED, currentSelectionRect() || floatRect);
      return;
    }
    ensureBar();
    // The read is paused, not stopped: the position is remembered first, then
    // the job is cancelled with reason `help` and its audio released.
    help.resume = rememberResume();
    if (record.state === 'error') {
      clearTransientError();
    } else if (record.state !== 'idle') {
      endJob({ next: 'idle', reason: 'help' });
    }
    panelDismissed = false;
    closePopovers();
    hideFloat();
    closeNote('help');
    closeNotesList('help');
    closeClassroom('help');
    closeModuleSheet('help');

    help.open = true;
    help.state = 'idle';
    help.markdown = '';
    help.html = '';
    help.stack = [];
    help.question = '';
    help.message = '';
    help.context = buildHelpContextFor(passage);
    // 12 §5.4 — the anchor of the passage behind the sheet, for Save as note.
    help.anchor = noteAnchorForPassage(passage);
    help.saved = false;
    barParts.help.root.hidden = false;
    barParts.help.input.value = '';
    setHelpBodyHtml('');
    applyThemeAttributes();
    showBar('');
    sendHelpRequest(null, '');
    focusHelpSheet();
  }

  function focusHelpSheet() {
    if (!barParts || !barParts.help) {
      return;
    }
    try {
      barParts.help.root.focus();
    } catch (error) {
      /* jsdom and detached nodes */
    }
  }

  /** §4 step 7 — close, kill the request, end a help read, empty the scope. */
  function closeHelp(reason) {
    if (!help.open) {
      return;
    }
    cancelHelpRequest(reason || 'close');
    if (
      record.scope &&
      record.scope === helpBody() &&
      record.state !== 'idle'
    ) {
      endJob({ next: 'idle', reason: 'help sheet closed' });
    }
    help.open = false;
    help.state = 'idle';
    help.markdown = '';
    help.html = '';
    help.stack = [];
    help.question = '';
    help.message = '';
    help.context = null;
    help.anchor = null;
    help.saved = false;
    if (barParts && barParts.help) {
      barParts.help.root.hidden = true;
      barParts.help.input.value = '';
    }
    setHelpBodyHtml('');
    syncHelpSheet();
    syncHelpButton();
    armPanelIdle();
    if (barParts && barParts.helpButton && !barParts.helpButton.hidden) {
      try {
        barParts.helpButton.focus();
      } catch (error) {
        /* the panel may be going away */
      }
    }
  }

  function cancelHelpRequest(reason) {
    stopHelpTicker();
    if (help.requestId) {
      post('readAloudHelpCancel', [sourceUri, help.requestId, reason]);
      help.requestId = null;
    }
  }

  function sendHelpRequest(followUp, question) {
    if (!help.context) {
      return;
    }
    cancelHelpRequest('superseded');
    help.last = { followUp: followUp, question: question };
    help.pending = { followUp: followUp, question: question };
    help.state = 'thinking';
    help.message = '';
    help.requestId = nextRequestId();
    help.startedAt = Date.now();
    startHelpTicker();

    var fields = {
      title: help.context.title,
      breadcrumb: help.context.breadcrumb,
      before: help.context.before,
      after: help.context.after,
      section: help.context.section,
      enclosing: help.context.enclosing,
      mentions: help.context.mentions,
      contextMode: help.context.contextMode,
    };
    if (followUp) {
      fields.followUp = followUp;
      fields.previous = help.markdown;
      if (question) {
        fields.question = question;
      }
    }
    post('readAloudHelp', [
      sourceUri,
      help.requestId,
      help.context.passage,
      fields,
    ]);
    syncHelpSheet();
  }

  /** §8 — the three chips, each with the previous explanation attached. */
  function askFollowUp(kind) {
    if (help.state !== 'ready' || !help.markdown) {
      return;
    }
    sendHelpRequest(kind, '');
  }

  function askTypedQuestion() {
    if (!barParts || !barParts.help) {
      return;
    }
    // Whitespace collapsed here as well as on the host (§14.5), so the
    // heading the listener hears is exactly the question the model was asked.
    var question = barParts.help.input.value.replace(/\s+/g, ' ').trim();
    if (!question || help.state !== 'ready' || !help.markdown) {
      return;
    }
    barParts.help.input.value = '';
    sendHelpRequest('question', question);
  }

  /** §8 — Back restores the previous explanation from the sheet's stack. */
  function helpBackStep() {
    var previous = help.stack.pop();
    if (!previous) {
      return;
    }
    // Going back abandons a follow-up that is still being written, rather
    // than letting it land on top of the explanation just restored.
    cancelHelpRequest('back');
    stopHelpTicker();
    if (
      record.scope &&
      record.scope === helpBody() &&
      record.state !== 'idle'
    ) {
      endJob({ next: 'idle', reason: 'help back' });
    }
    help.markdown = previous.markdown;
    help.html = previous.html;
    help.question = previous.question;
    help.state = 'ready';
    help.message = '';
    setHelpBodyHtml(help.html);
    syncHelpSheet();
    syncHelpButton();
  }

  // ------------------------------------------------------ the sheet's scope

  /**
   * Put the rendered explanation into the sheet body and collect its blocks.
   * The body is outside the preview DOM, so crossnote's `updateHtml` never
   * replaces it and none of the re-render machinery applies here (§5).
   */
  function setHelpBodyHtml(html) {
    var body = helpBody();
    helpBlocks = [];
    helpBlocksByElement = new Map();
    if (!body) {
      return;
    }
    body.innerHTML = html || '';
    if (!html) {
      return;
    }
    // §14.5 — a typed question goes above the answer as a one-line heading of
    // the sheet's own, *inside* the reading scope, so the listener hears what
    // is being answered before they hear the answer.
    if (help.question) {
      var heading = body.ownerDocument.createElement('p');
      heading.className = 'mpe-ra-help-question';
      heading.textContent = help.question;
      body.insertBefore(heading, body.firstChild);
    }
    var collected = core.collectBlocks(body);
    for (var i = 0; i < collected.length; i++) {
      var el = collected[i].el;
      var text = core.extractText(el).text;
      var entry = {
        el: el,
        kind: collected[i].kind,
        index: collected[i].index,
        key: core.blockKey(el, text),
        text: text,
        label: core.blockLabel(text),
        button: null,
        scope: body,
        // The sheet has no gutter play buttons: the panel drives it.
        noButton: true,
      };
      helpBlocks.push(entry);
      helpBlocksByElement.set(el, entry);
      el.classList.add('mpe-ra-block');
    }
  }

  /** §4 step 5 — read the explanation from its first block to the sheet's end. */
  function playHelpFromStart() {
    if (!helpBlocks.length) {
      return;
    }
    startBlockRead(helpBlocks[0], 0);
  }

  // ------------------------------------------------------- host -> sheet

  function onHelpResult(message) {
    if (!help.open || !help.requestId || message.requestId !== help.requestId) {
      return;
    }
    stopHelpTicker();
    help.requestId = null;
    if (help.markdown) {
      help.stack.push({
        markdown: help.markdown,
        html: help.html,
        question: help.question,
      });
    }
    help.markdown =
      typeof message.markdown === 'string' ? message.markdown : '';
    help.html = typeof message.html === 'string' ? message.html : '';
    help.question =
      help.pending && help.pending.followUp === 'question'
        ? help.pending.question
        : '';
    help.state = help.markdown ? 'ready' : 'error';
    help.saved = false;
    help.message = help.markdown ? '' : 'The help engine returned nothing.';
    setHelpBodyHtml(help.html);
    syncHelpSheet();
    syncHelpButton();
    if (help.state === 'ready' && config.helpAutoPlay) {
      playHelpFromStart();
    }
  }

  function onHelpError(message) {
    if (!help.open || !help.requestId || message.requestId !== help.requestId) {
      return;
    }
    stopHelpTicker();
    help.requestId = null;
    help.state = 'error';
    help.message =
      typeof message.message === 'string' && message.message
        ? message.message
        : 'Help failed.';
    syncHelpSheet();
    syncHelpButton();
    // The same text goes in the panel's message line, so it is visible even
    // when the sheet is scrolled (§4).
    showBar(help.message);
  }

  // ---------------------------------------------------------------- keys

  function onBarKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (anyPopoverOpen()) {
        closePopovers();
        return;
      }
      // Escape closes the help sheet, as it closes the theme sheet (§2).
      if (help.open) {
        closeHelp('escape');
        return;
      }
      // And the two note sheets (12 §11.4, §12).
      if (notes.open) {
        closeNote('escape');
        return;
      }
      if (notes.listOpen) {
        closeNotesList('escape');
        return;
      }
      // And the two classroom sheets (13 §5.4 step 6, §12.2).
      if (classroom.open) {
        closeClassroom('escape');
        return;
      }
      if (classroom.moduleOpen) {
        closeModuleSheet('escape');
        return;
      }
      handleStop();
      return;
    }
    // The question box, My note and the tag input are text fields: `[`, `]`
    // and the space bar are characters there.
    var target = event.target;
    if (
      target &&
      target.tagName &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') &&
      event.key !== 'Escape'
    ) {
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

  /**
   * The selection affordance (09 §10): a container of the shape the single
   * button used to have, holding _Read aloud_ and _Explain_. The second is
   * the only way to reach help while the panel is faded out or dismissed.
   *
   * The container keeps the class `mpe-ra-float`, so the `mousedown` guard
   * that holds the selection open (§14) and every `hideFloat` caller work
   * unchanged; the read button keeps `data-mpe-ra-action="float"`, so
   * `handleAction` does too.
   */
  function ensureFloat() {
    if (floatButton && floatButton.isConnected) {
      return floatButton;
    }
    floatButton = document.createElement('div');
    floatButton.className = 'mpe-ra-ui mpe-ra-float';
    var read = makeButton(
      'float',
      'Read aloud selection',
      'mpe-ra-float-btn mpe-ra-float-read',
    );
    read.textContent = 'Read aloud';
    var explain = makeIconButton(
      'floatHelp',
      HELP_TOOLTIP,
      'mpe-ra-float-btn mpe-ra-float-help',
      'help',
    );
    explain.setAttribute('aria-haspopup', 'dialog');
    explain.hidden = !config.helpAvailable;
    // 12 §5.1 — the third button: Note, enabled by the help predicate.
    var note = makeIconButton(
      'floatNote',
      NOTE_TOOLTIP,
      'mpe-ra-float-btn mpe-ra-float-note',
      'note',
    );
    note.hidden = !config.notesAvailable;
    // 13 §5.1 — the fourth button: Classroom, enabled by the help predicate.
    var teach = makeIconButton(
      'floatClassroom',
      CLASSROOM_TOOLTIP,
      'mpe-ra-float-btn mpe-ra-float-classroom',
      'classroom',
    );
    teach.setAttribute('aria-haspopup', 'dialog');
    teach.hidden = !config.classroomAvailable;
    floatButton.appendChild(read);
    floatButton.appendChild(explain);
    floatButton.appendChild(note);
    floatButton.appendChild(teach);
    floatButton.hidden = true;
    floatParts = { read: read, help: explain, note: note, classroom: teach };
    document.body.appendChild(floatButton);
    return floatButton;
  }

  /**
   * Take the affordance off screen without forgetting what it pointed at
   * (09 §9). A scroll moves the affordance, it does not end the selection.
   */
  function hideFloatElement() {
    if (floatButton) {
      floatButton.hidden = true;
    }
  }

  /** The selection is over: hide the affordance and forget it. */
  function hideFloat() {
    hideFloatElement();
    floatSelection = null;
    floatScope = null;
    floatRange = null;
    syncHelpButton();
    touchPanel();
  }

  /** Whether the affordance is on screen (09 §11: the panel holds while it is). */
  function floatVisible() {
    return !!(floatButton && !floatButton.hidden && floatButton.isConnected);
  }

  /** Whether there is still a selection on the page with text in it. */
  function selectionIsLive() {
    var selection = window.getSelection();
    return !!(selection && selection.rangeCount && !selection.isCollapsed);
  }

  /** The element a range sits in, for `scopeOf`. */
  function containerElementOf(range) {
    var node = range.commonAncestorContainer;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  /**
   * The live selection resolved inside `scope`, or null. Used by the help
   * predicate (§7c) and by the affordance, so both answer the same question
   * from the same place.
   */
  function liveSelectionIn(scope) {
    if (!config.enabled || !scope) {
      return null;
    }
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) {
      return null;
    }
    var range = selection.getRangeAt(0);
    if (scopeOf(containerElementOf(range)) !== scope) {
      return null;
    }
    var resolved = core.resolveSelection(selection, scope);
    return resolved.ok && resolved.blocks && resolved.blocks.length
      ? resolved
      : null;
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
    // A selection inside the help sheet gets the same affordance and reads
    // bounded to the sheet (04-help-module §5); one anywhere else is not a
    // reading scope at all.
    var scope = scopeOf(container);
    if (!scope) {
      hideFloat();
      return;
    }
    // While the sheet is open it owns the reading, and the document selection
    // it left behind is the passage being explained: offering to read or to
    // re-explain it there would cross the two scopes, and the affordance
    // would stand over the answer (09 §10).
    if (
      (help.open ||
        notes.open ||
        notes.listOpen ||
        classroom.open ||
        classroom.moduleOpen) &&
      scope === root
    ) {
      hideFloat();
      return;
    }
    var rect = rectOfRange(range) || ZERO_RECT;
    var resolved = core.resolveSelection(selection, scope);
    var element = ensureFloat();
    element.hidden = false;
    floatSelection = resolved;
    floatScope = scope;
    floatRange = range;
    positionFloat(rect, scope);
    // Sets the affordance's _Explain_ visibility from the scope just stored:
    // a selection inside the sheet is read, not explained (04 D9).
    syncHelpButton();
    // A selection is activity: the panel comes back for it, and §11 keeps it
    // there while the affordance is up.
    touchPanel();
  }

  /**
   * Put the affordance under `rect`. In the preview the button is
   * `position: absolute` in document coordinates, so it travels with the text
   * on its own; in the sheet — which is fixed to the viewport — the rect is
   * already in client coordinates and adding the page scroll would misplace
   * it.
   */
  function positionFloat(rect, scope) {
    var element = ensureFloat();
    if (scope === root) {
      element.style.position = '';
      element.style.top = rect.bottom + window.scrollY + 6 + 'px';
      element.style.left = rect.left + window.scrollX + 'px';
    } else {
      element.style.position = 'fixed';
      element.style.top = rect.bottom + 6 + 'px';
      element.style.left = rect.left + 'px';
    }
    floatRect = rect;
  }

  /**
   * A scroll (09 §9): the affordance moves, the selection is not forgotten.
   * At most one reposition a frame, and never a re-resolve — walking the range
   * on every frame of a follow-the-reading scroll is the cost this avoids;
   * `selectionchange` is where resolving belongs.
   */
  function onScrollMoveFloat() {
    if (!floatSelection || !floatRange || !selectionIsLive()) {
      if (floatVisible()) {
        hideFloat();
      }
      return;
    }
    if (floatFrame) {
      return;
    }
    floatFrame = window.requestAnimationFrame(function () {
      floatFrame = 0;
      if (!floatSelection || !floatRange || !selectionIsLive()) {
        return;
      }
      positionFloat(
        rectOfRange(floatRange) || floatRect || ZERO_RECT,
        floatScope,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // 9. Block decoration (F1)
  // ---------------------------------------------------------------------------

  function ensureButton(entry) {
    // The help sheet is driven by the panel alone: no gutter play buttons.
    if (entry.noButton) {
      return null;
    }
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
        // The reading scope this block belongs to (04-help-module §5).
        scope: root,
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
    applyFontToRoot();
    applyGutter();
    rebindAfterRender();
    // The registry was rebuilt: the tier classes go on the new elements
    // (07 §8.4), or are cleared if the rebind ended the read.
    applyTiers();
    // Notes re-anchor in the same pass, right after the read re-located
    // (12 §9.3), and both sheets follow the fresh results.
    anchorPass();
    // A re-render can take the paused block with it, which is what decides
    // whether Resume is still on offer (04-help-module §4 step 6).
    syncHelpSheet();
    syncHelpButton();
    syncNoteSheet();
    syncNotesList();
  }

  // ------------------------------------------- dim while reading (07 §8)

  /**
   * Put the tier classes on every readable block of the read's scope (07
   * §8.1): none on the block being read (a selection read's blocks all count
   * as active), `near` on the read's next block, `far` on every other. Only
   * the registry's blocks are touched, so skipped content — code, diagrams,
   * maths, images, tables in a continuous read — never carries a class.
   * Cleared when the feature or the page is off, and by
   * clearReadingDecoration when the read ends.
   */
  function applyTiers() {
    var scope = record.scope;
    if (
      !scope ||
      record.state === 'idle' ||
      record.state === 'error' ||
      !config.dimWhileReading ||
      !pageIsOn()
    ) {
      clearTiers();
      return;
    }
    var list = blocksIn(scope);
    var activeEls = record.blockEls.length
      ? record.blockEls
      : record.blockEl
        ? [record.blockEl]
        : [];
    var nextBlock = record.readBlocks[record.blockIndex + 1];
    var nextEl = nextBlock && !nextBlock.missing ? nextBlock.el : null;
    var activeIndex = -1;
    var nextIndex = -1;
    for (var i = 0; i < list.length; i++) {
      if (activeEls.indexOf(list[i].el) >= 0) {
        if (activeIndex < 0) {
          activeIndex = i;
        }
      } else if (list[i].el === nextEl) {
        nextIndex = i;
      }
    }
    for (var j = 0; j < list.length; j++) {
      var el = list[j].el;
      var tier =
        activeEls.indexOf(el) >= 0
          ? 'active'
          : core.tierFor(j, activeIndex, nextIndex);
      setTier(el, tier);
    }
    // A scope's stale classes from an earlier read of another scope.
    var scopes = [root, helpBody(), noteBody()];
    for (var s = 0; s < scopes.length; s++) {
      if (scopes[s] && scopes[s] !== scope) {
        clearTiersIn(scopes[s]);
      }
    }
  }

  function setTier(el, tier) {
    if (!el || !el.classList) {
      return;
    }
    el.classList.toggle(TIER_NEAR_CLASS, tier === 'near');
    el.classList.toggle(TIER_FAR_CLASS, tier === 'far');
  }

  function clearTiersIn(scope) {
    if (!scope || !scope.querySelectorAll) {
      return;
    }
    var marked = scope.querySelectorAll(
      '.' + TIER_NEAR_CLASS + ', .' + TIER_FAR_CLASS,
    );
    for (var i = 0; i < marked.length; i++) {
      marked[i].classList.remove(TIER_NEAR_CLASS);
      marked[i].classList.remove(TIER_FAR_CLASS);
    }
  }

  function clearTiers() {
    clearTiersIn(root);
    clearTiersIn(helpBody());
    clearTiersIn(noteBody());
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
    clearNoteDecorations();
    clearModuleMarkers();
    removeThemeAttributes();
    if (root) {
      root.classList.remove(CLICK_CLASS);
      root.classList.remove(CANVAS_CLASS);
      root.classList.remove(PANEL_CLASS);
      root.classList.remove('mpe-ra-font');
      root.style.removeProperty('--mpe-ra-font-family');
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
    // A help read lives in the sheet, which is outside the preview DOM:
    // crossnote's `updateHtml` never replaces it, so a document re-render is
    // none of its business (04-help-module §5).
    if (record.scope && record.scope !== root) {
      syncHelpSheet();
      syncNoteSheet();
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
    // Back to the top of the chunk being played, never of the read (14):
    // the next frame walks forward from there to the word being spoken.
    var playingChunk =
      record.current >= 0 ? record.chunks[record.current] : null;
    record.spanIndex = playingChunk ? playingChunk.spanStart : 0;
    record.lastSpan = null;
    if (entry) {
      ensureButton(entry);
    }
    setButtonState(current.el, record.state, '');
    record.blockEls = [current.el];
    decorateBlocks(record.blockEls);
    applyTiers();
    if (lastSpan) {
      // Keep the word visible across a re-render, also while paused; the
      // follow loop re-anchors from it on the next playing frame (07 §7.2).
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

  /** Drop a block gap that is waiting (07 §11.3). */
  function cancelGap() {
    record.gapTimer = clearTimer(record.gapTimer);
    record.gapDueAt = 0;
    record.pendingChunk = -1;
  }

  function releaseChunks() {
    stopLoop();
    cancelGap();
    for (var i = 0; i < record.chunks.length; i++) {
      releaseChunkAudio(record.chunks[i]);
    }
    record.chunks = [];
    record.chunkCount = 0;
    record.current = -1;
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
    follow.container = null;
    follow.wroteScrollTop = null;
    follow.moving = false;

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
    // The reader has asked to hear from a place, so the page goes there
    // (07 §7.4): the following is engaged, in the read's own container.
    follow.container = scrollContainerFor(options.scope || root);
    follow.wroteScrollTop = null;
    engageFollow();
    record.requestId = nextRequestId();
    record.kind = options.kind;
    record.scope = options.scope || root;
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
    applyTiers();

    var payload = { kind: options.kind };
    if (options.blockId) {
      payload.blockId = options.blockId;
    }
    if (
      (options.kind === 'block' ||
        options.kind === 'help' ||
        options.kind === 'note') &&
      record.readBlocks.length
    ) {
      // Decision 5: the host chunks block by block, never across a boundary.
      // A help read is the same shape, over the sheet's blocks instead of the
      // document's (04-help-module §5).
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
    // The scope decides where the read ends: the document root reads to the
    // end of the document, the help sheet's body to the end of the sheet
    // (04-help-module §5).
    var scope = entry.scope || root;
    var list = blocksIn(scope);
    var start = startOffset > 0 ? startOffset : 0;
    var position = list.indexOf(entry);
    if (position < 0) {
      return;
    }
    var elements = [];
    var total = 0;
    for (var i = position; i < list.length; i++) {
      var length = list[i].text.length + 1;
      if (elements.length && total + length > core.MAX_TEXT_CHARS) {
        break;
      }
      elements.push(list[i].el);
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
      kind: sheetKindFor(scope, 'block'),
      scope: scope,
      text: extracted.text,
      map: extracted.map,
      label: sheetLabelFor(scope, readBlocks[0].label),
      blockId: entry.key + '#' + entry.index + (start > 0 ? '@' + start : ''),
      readBlocks: readBlocks,
    });
  }

  /** The read kind of a scope: the document's, or the sheet's own (12 §11.5). */
  function sheetKindFor(scope, documentKind) {
    if (scope === noteBody()) {
      return 'note';
    }
    return scope === root ? documentKind : 'help';
  }

  function sheetLabelFor(scope, documentLabel) {
    if (scope === noteBody()) {
      return 'Note';
    }
    return scope === root ? documentLabel : 'Help';
  }

  function startSelectionRead(fallback) {
    var selection = window.getSelection();
    // A selection inside the help sheet reads bounded to the sheet (§5).
    var scope = null;
    if (selection && selection.rangeCount) {
      scope = scopeOf(containerElementOf(selection.getRangeAt(0)));
    }
    if (!scope) {
      scope = fallback && floatScope ? floatScope : root;
    }
    var resolved = core.resolveSelection(selection, scope);
    if (!resolved.ok && resolved.reason === 'empty' && fallback) {
      resolved = fallback;
      scope = floatScope || root;
    }
    if (!resolved.ok) {
      if (resolved.hint) {
        showHint(resolved.hint, currentSelectionRect() || floatRect);
      }
      return;
    }
    hideFloat();
    startRead({
      kind: sheetKindFor(scope, 'selection'),
      scope: scope,
      text: resolved.text,
      map: resolved.map,
      label: sheetLabelFor(scope, 'Selection'),
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
    // The scope decides what the click resolves against: the preview root, or
    // the help sheet's body (04-help-module §5).
    var scope = scopeOf(element);
    if (!config.enabled || !config.clickToRead || !scope) {
      traceClick('ignored', {
        enabled: config.enabled,
        clickToRead: config.clickToRead,
        inScope: !!scope,
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
      resolved = core.resolveClick(caret.node, caret.offset, scope);
    } catch (error) {
      traceClick('resolve failed', String(error));
      return;
    }
    if (!resolved.ok) {
      traceClick('refused', resolved.reason);
      return;
    }
    resolved.scope = scope;
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
    // The span is timed on its chunk's clock: the seek position itself.
    var local = spans[k].start;
    if (!(local >= 0)) {
      local = 0;
    }
    stopLoop();
    cancelGap();
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
    // A click on a word is a request to hear from there (07 §7.4).
    engageFollow();
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
    var scope = resolved.scope || root;
    if (!config.enabled || !config.clickToRead || !scope) {
      return;
    }
    var el = resolved.el;
    if (!el.isConnected || !scope.contains(el)) {
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
      kind: scope === root ? 'selection' : 'help',
      scope: scope,
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
    // The spans keep the chunk's own clock (14): they are never shifted
    // onto the read's timeline, because that timeline is only known once
    // every earlier audio has loaded — and a cache hit used to carry no
    // hint at all, which put every chunk at zero and let the word cursor
    // land in another chunk's words after a re-render's rebind.
    if (message.spans && message.spans.length) {
      for (var i = 0; i < message.spans.length; i++) {
        var span = message.spans[i];
        var copy = {
          text: span.text,
          charStart: span.charStart,
          charEnd: span.charEnd,
          start: span.start,
          end: span.end,
        };
        chunk.spans.push(copy);
        record.allSpans.push(copy);
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
    // The tiers move with the hand-off (07 §8.4).
    applyTiers();
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

  /**
   * The pause at a block boundary (07 §11.2): chunk `index` starts a new
   * block, so it waits `delayMs` before playing. The state stays `playing`
   * — the play button stays a pause button, the bar shows nothing — the
   * last word stays painted, and the rAF loop keeps running for the follow
   * step alone (nothing to paint), so an ease under way is not frozen.
   */
  function startGap(index, delayMs) {
    cancelGap();
    if (!(delayMs > 0)) {
      playChunk(index);
      return;
    }
    record.pendingChunk = index;
    record.state = 'playing';
    setButtonState(record.blockEl, 'playing', '');
    showBar('');
    record.gapTimer = setTimeout(function () {
      record.gapTimer = 0;
      var pending = record.pendingChunk;
      record.pendingChunk = -1;
      record.gapDueAt = 0;
      if (pending >= 0) {
        playChunk(pending);
      }
    }, delayMs);
    startLoop();
  }

  /** The gap after the block `chunk` belongs to, at the current rate. */
  function gapAfter(chunk) {
    var rb = chunk ? record.readBlocks[chunk.blockIndex] : null;
    return core.blockGapMs(rb ? rb.el : null, rate);
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
    var next = record.chunks[finished + 1];
    if (next) {
      if (next.blockIndex !== chunk.blockIndex) {
        // A hand-off between blocks takes a breath (07 §11.1); chunks of the
        // same block hand over gaplessly.
        startGap(finished + 1, gapAfter(chunk));
        return;
      }
      playChunk(finished + 1);
      return;
    }
    if (finished + 1 < record.chunkCount) {
      // The gap is measured from here; a chunk that arrives after it is
      // due starts at once (07 §11.3).
      record.gapDueAt = Date.now() + gapAfter(chunk);
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
    if (record.gapTimer) {
      // A block gap (07 §11.2): the last word stays painted, only the
      // follow step runs.
      followFrame();
      updateTimeDisplay();
      record.rafId = window.requestAnimationFrame(tick);
      return;
    }
    // The chunk's own clock (14): the search stays inside the chunk's
    // spans, so a cursor reset — a re-render's rebind — can never pick a
    // word of another chunk, whatever the chunks' lengths are known to be.
    var time = chunk.slot ? chunk.slot.el.currentTime : 0;
    var spans = record.allSpans;
    var last = spanEndOf(record.current);
    if (record.spanIndex < chunk.spanStart) {
      record.spanIndex = chunk.spanStart;
    }
    while (record.spanIndex < last && spans[record.spanIndex].end <= time) {
      record.spanIndex++;
    }
    var current =
      record.spanIndex < last && spans[record.spanIndex].start <= time
        ? spans[record.spanIndex]
        : null;
    if (current !== record.lastSpan) {
      paintSpan(current);
      record.lastSpan = current;
    }
    // The follow step after the word for the frame is painted (07 §7.2).
    followFrame();
    updateTimeDisplay();
    record.rafId = window.requestAnimationFrame(tick);
  }

  function pausePlayback() {
    var chunk = record.chunks[record.current];
    if (chunk && chunk.slot) {
      chunk.slot.el.pause();
    }
    stopLoop();
    // A pause during a block gap keeps the chunk behind it (07 §11.3);
    // resume plays it with no further gap.
    record.gapTimer = clearTimer(record.gapTimer);
    record.state = 'paused';
    setButtonState(record.blockEl, 'paused', '');
    showBar('Paused');
  }

  function resumePlayback() {
    var chunk = record.chunks[record.current];
    if (!chunk) {
      return;
    }
    // Play from paused re-engages the following (07 §7.4).
    engageFollow();
    if (record.pendingChunk >= 0) {
      var pending = record.pendingChunk;
      record.pendingChunk = -1;
      playChunk(pending);
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
        start = offsetOf(i);
      }
      end = offsetOf(i) + chunkLength(candidate);
    }
    if (start === null) {
      return null;
    }
    return {
      start: start,
      end: end,
      // During a block gap the read stands at the finished chunk's end
      // (07 §11.3): −10 s seeks inside the block, +10 s has nowhere to go.
      here:
        offsetOf(record.current) +
        (record.gapTimer || record.pendingChunk >= 0
          ? chunkLength(chunk)
          : chunk.slot
            ? chunk.slot.el.currentTime
            : 0),
      blockIndex: blockIndex,
    };
  }

  /**
   * Move the word highlight to `local` seconds into chunk `index` without
   * touching the audio: the chunk's own clock, inside its own spans (14).
   */
  function syncSpansTo(index, local) {
    var chunk = record.chunks[index];
    var spans = record.allSpans;
    var cursor = chunk ? chunk.spanStart : 0;
    var last = spanEndOf(index);
    while (cursor < last && spans[cursor].end <= local) {
      cursor++;
    }
    record.spanIndex = cursor;
    var current =
      cursor < last && spans[cursor].start <= local ? spans[cursor] : null;
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
        offsetOf(i) <= target
      ) {
        index = i;
      }
    }
    if (index < 0) {
      return false;
    }
    var chunk = record.chunks[index];
    var local = target - offsetOf(index);
    if (!(local >= 0)) {
      local = 0;
    }
    var wasPaused = record.state === 'paused';
    stopLoop();
    // A skip during a block gap cancels the gap (07 §11.3); it is taken
    // again at the boundary.
    cancelGap();
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
      syncSpansTo(index, local);
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
    // A skip re-engages the following (07 §7.4).
    engageFollow();
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
      // With the help sheet open the panel drives the sheet: play reads the
      // explanation from its first block (04-help-module §4 step 5).
      if (help.open && helpBlocks.length) {
        playHelpFromStart();
        return;
      }
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

  function handleAction(action, element) {
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
    if (action === 'volume' || action === 'speed' || action === 'theme') {
      togglePopover(action);
      return;
    }
    if (action === 'themeClose') {
      closePopovers();
      return;
    }
    if (action === 'highlightTheme') {
      applyHighlightTheme(
        element ? element.getAttribute('data-mpe-ra-theme-choice') : '',
        true,
      );
      return;
    }
    // ------------------------------------------ the low-strain page (05 §9)
    if (action === 'globalTheme') {
      applyGlobalTheme(
        element ? element.getAttribute('data-mpe-ra-page-choice') : '',
        true,
      );
      return;
    }
    if (action === 'resetPage') {
      resetPage();
      return;
    }
    // ------------------------------------------------ eye strain 2 (07)
    if (action === 'wordMarker') {
      applyWordMarker(
        element ? element.getAttribute('data-mpe-ra-marker-choice') : '',
        true,
      );
      return;
    }
    if (action === 'follow') {
      // _Back to the reading_ (07 §7.5): the ease to the anchor resumes.
      engageFollow();
      return;
    }
    // ------------------------------------------- help (04-help-module §4)
    if (action === 'help') {
      closePopovers();
      toggleHelp();
      return;
    }
    if (action === 'helpClose') {
      closeHelp('close');
      return;
    }
    if (action === 'helpCancel') {
      cancelHelpRequest('user');
      // With an explanation already on screen the sheet goes back to it;
      // with nothing to go back to, Retry is what the sheet has to offer.
      help.state = help.markdown ? 'ready' : 'error';
      help.message = help.markdown ? '' : 'Cancelled.';
      syncHelpSheet();
      return;
    }
    if (action === 'helpRetry') {
      sendHelpRequest(
        help.last ? help.last.followUp : null,
        help.last ? help.last.question : '',
      );
      return;
    }
    if (action === 'helpSimpler') {
      askFollowUp('simpler');
      return;
    }
    if (action === 'helpDeeper') {
      askFollowUp('deeper');
      return;
    }
    if (action === 'helpExample') {
      askFollowUp('example');
      return;
    }
    if (action === 'helpAsk') {
      askTypedQuestion();
      return;
    }
    if (action === 'helpBack') {
      helpBackStep();
      return;
    }
    if (action === 'helpPlayAgain') {
      if (
        record.scope &&
        record.scope === helpBody() &&
        record.state !== 'idle'
      ) {
        endJob({ next: 'idle', reason: 'help replay' });
      }
      playHelpFromStart();
      return;
    }
    if (action === 'helpSaveNote') {
      saveHelpAsNote();
      return;
    }
    if (action === 'helpTeach') {
      openClassroomFromHelp();
      return;
    }
    if (action === 'helpResume') {
      resumeRead();
      return;
    }
    if (action === 'helpModel') {
      post('readAloudHelpChooseModel', []);
      return;
    }
    if (handleNoteAction(action, element)) {
      return;
    }
    if (handleClassroomAction(action, element)) {
      return;
    }
    if (action === 'close') {
      handleStop();
      // Closing the panel closes the sheets (§4 step 7; 12 §11.7; 13 §5.4).
      closeHelp('panel closed');
      closeNote('panel closed');
      closeNotesList('panel closed');
      closeClassroom('panel closed');
      closeModuleSheet('panel closed');
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
      return;
    }
    // 09 §10 — the affordance's second button. `openHelp` already pauses the
    // read, remembers where it was and refuses with the hint when there is
    // nothing to explain, so there is no second path into the sheet.
    if (action === 'floatHelp') {
      openHelp();
    }
  }

  // ---------------------------------------------------------------------------
  // 12b. Notes (featrues/12-notes/spec.md)
  //
  // Capture from the selection cluster (§5), the margin markers and the
  // words' mark (§10), the Note sheet as a third reading scope (§11), the
  // Notes list sheet and the bar button (§12). The host owns the files; this
  // layer owns what the page shows and re-anchors every note on every render
  // through `core.anchorNotes` (§9).
  // ---------------------------------------------------------------------------

  function applyNotesConfig(message) {
    if (typeof message.notesAvailable === 'boolean') {
      config.notesAvailable = message.notesAvailable;
    }
    if (typeof message.notesDecoration === 'string') {
      config.notesDecoration =
        message.notesDecoration === 'marker' ||
        message.notesDecoration === 'none'
          ? message.notesDecoration
          : 'marker-and-mark';
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function noteById(id) {
    return id && notes.byId[id] ? notes.byId[id] : null;
  }

  function noteResult(id) {
    return id && notes.results[id] ? notes.results[id] : null;
  }

  /** Orphaned means a pass ran and did not find it (§9.2 step 4). */
  function noteIsOrphan(id) {
    var result = noteResult(id);
    return !!(result && !result.found);
  }

  function noteIsPending(note) {
    return !!(note && note.generated && note.generated.status === 'pending');
  }

  /** `5 Sept 2026` — the details chip's date (brief §6). */
  function noteDateText(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) {
      return '';
    }
    try {
      return date.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch (error) {
      return String(iso).slice(0, 10);
    }
  }

  function noteTitleText(note) {
    if (!note) {
      return 'Note';
    }
    if (noteIsPending(note) && !note.titleEdited) {
      return core.blockLabel(note.passage) || 'Note';
    }
    return note.title || core.blockLabel(note.passage) || 'Note';
  }

  /** §9.1 — the anchor of what the help predicate resolved. */
  function noteAnchorForPassage(passage) {
    if (!passage || !root) {
      return null;
    }
    try {
      var resolved = null;
      if (passage.range) {
        var live = core.resolveSelection(window.getSelection(), root);
        if (live && live.ok) {
          resolved = live;
        }
      }
      if (!resolved) {
        resolved = { ok: true, text: passage.text, blocks: passage.els || [] };
      }
      return core.noteAnchorFor(resolved, root, passage.range || null);
    } catch (error) {
      return null;
    }
  }

  /** The help fields object of §14.2, from `buildHelpContextFor`'s result. */
  function noteFieldsFrom(context) {
    return {
      title: context.title,
      breadcrumb: context.breadcrumb.slice(),
      before: context.before,
      after: context.after,
      section: context.section,
      enclosing: context.enclosing,
      mentions: context.mentions,
      contextMode: context.contextMode,
    };
  }

  // ------------------------------------------------------------- capture

  /** §5.2 — the cluster's Note button and `Alt+N`. */
  function saveNoteFromSelection() {
    if (!config.enabled || !config.notesAvailable) {
      return;
    }
    var passage = helpPassage();
    if (!passage) {
      showHint(NOTE_HINT_NO_SELECTION, currentSelectionRect() || floatRect);
      return;
    }
    var context = buildHelpContextFor(passage);
    var anchor = noteAnchorForPassage(passage);
    if (!anchor) {
      showHint(NOTE_HINT_NO_SELECTION, currentSelectionRect() || floatRect);
      return;
    }
    var requestId = nextRequestId();
    var pending = {
      requestId: requestId,
      passage: passage.text,
      breadcrumb: context.breadcrumb.slice(),
      context: {
        enclosing: context.enclosing,
        before: context.before,
        after: context.after,
      },
      knownIds: Object.keys(notes.byId),
      error: '',
    };
    post('readAloudNoteCreate', [
      sourceUri,
      requestId,
      passage.text,
      noteFieldsFrom(context),
      anchor,
      { source: 'selection' },
    ]);
    var opener = floatParts && floatParts.note ? floatParts.note : null;
    hideFloat();
    notes.pendingCreate = pending;
    showNoteChip(NOTE_SAVED_CHIP, NOTE_CHIP_MS, null);
    openNoteSheet(null, opener);
  }

  /** §5.4 — Save as note on the help sheet: the answer on screen, no engine. */
  function saveHelpAsNote() {
    if (
      !config.notesAvailable ||
      help.state !== 'ready' ||
      !help.markdown ||
      !help.context ||
      help.saved
    ) {
      return;
    }
    if (!help.anchor) {
      showHint(NOTE_HINT_NO_SELECTION, floatRect);
      return;
    }
    var requestId = nextRequestId();
    post('readAloudNoteCreate', [
      sourceUri,
      requestId,
      help.context.passage,
      noteFieldsFrom(help.context),
      help.anchor,
      { source: 'help', explanation: help.markdown },
    ]);
    help.saved = true;
    showNoteChip(NOTE_SAVED_CHIP, NOTE_CHIP_MS, null);
    syncHelpSheet();
  }

  // ------------------------------------------------------ host -> notes

  function isNoteSummary(value) {
    return !!(
      value &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      typeof value.passage === 'string' &&
      value.anchor &&
      typeof value.anchor === 'object'
    );
  }

  /** §14.3 — the whole list every time; the page diffs. */
  function onNotesMessage(message) {
    // Single-preview mode reuses one panel: a list for another document is
    // not this page's (§4).
    if (
      typeof message.sourceUri === 'string' &&
      sourceUri &&
      message.sourceUri !== sourceUri
    ) {
      return;
    }
    var previousDeleting = notes.deleting.slice();
    var list = Array.isArray(message.notes) ? message.notes : [];
    notes.list = [];
    notes.byId = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var note = list[i];
      if (!isNoteSummary(note)) {
        continue;
      }
      if (!Array.isArray(note.headings)) {
        note.headings = [];
      }
      if (!Array.isArray(note.tags)) {
        note.tags = [];
      }
      if (!note.generated || typeof note.generated !== 'object') {
        note.generated = { status: 'done' };
      }
      if (!note.context || typeof note.context !== 'object') {
        note.context = { enclosing: '', before: '', after: '' };
      }
      if (!Array.isArray(note.sectionNames)) {
        note.sectionNames = [];
      }
      notes.list.push(note);
      notes.byId[note.id] = note;
    }
    notes.deleting = Array.isArray(message.deleting)
      ? message.deleting.filter(function (id) {
          return typeof id === 'string';
        })
      : [];
    if (message.deleteMode === 'permanent' || message.deleteMode === 'trash') {
      notes.deleteMode = message.deleteMode;
    }
    if (typeof message.generate === 'boolean') {
      notes.generate = message.generate;
    }

    // A capture in flight: the new note is the one the list did not have.
    if (notes.pendingCreate) {
      var pending = notes.pendingCreate;
      var match = null;
      for (var m = 0; m < notes.list.length; m++) {
        var candidate = notes.list[m];
        if (
          pending.knownIds.indexOf(candidate.id) < 0 &&
          candidate.passage === pending.passage
        ) {
          match = candidate;
        }
      }
      if (match) {
        notes.pendingCreate = null;
        if (notes.open && notes.currentId === null) {
          notes.currentId = match.id;
          notes.contextOpen = false;
        }
        // My note typed while the file was being written (§5.2 step 2).
        if (notes.pendingMyNote) {
          var typed = notes.pendingMyNote;
          notes.pendingMyNote = null;
          post('readAloudNoteUpdate', [sourceUri, match.id, { myNote: typed }]);
        }
      }
    }

    // A delete that started elsewhere (the Notes view) shows the Undo chip
    // here too (§7.7).
    for (var d = 0; d < notes.deleting.length; d++) {
      var id = notes.deleting[d];
      if (previousDeleting.indexOf(id) < 0 && notes.chipNoteId !== id) {
        showNoteChip(deleteChipText(), NOTE_UNDO_MS, id);
      }
    }
    if (notes.chipNoteId && notes.deleting.indexOf(notes.chipNoteId) < 0) {
      // Trashed, or undone: the chip has nothing left to undo.
      hideNoteChip();
    }

    // The open note is gone: page on, or close (§7.7).
    if (notes.open && notes.currentId && !notes.byId[notes.currentId]) {
      pageOnFromMissing();
    }
    anchorPass();
    syncNotesBar();
    syncNoteSheet();
    syncNotesList();
    syncHelpSheet();
  }

  function deleteChipText() {
    return notes.deleteMode === 'permanent'
      ? 'Note deleted'
      : 'Note moved to Trash';
  }

  /** §14.3 — a write or a generation failed: the chip, and the sheet's row. */
  function onNoteError(message) {
    var text =
      typeof message.message === 'string' && message.message
        ? message.message
        : 'The note could not be saved.';
    if (
      notes.pendingCreate &&
      typeof message.requestId === 'string' &&
      message.requestId === notes.pendingCreate.requestId
    ) {
      notes.pendingCreate.error = text;
      notes.renderedKey = '';
    }
    showNoteChip(text, NOTE_ERROR_CHIP_MS, null);
    syncNoteSheet();
  }

  // ----------------------------------------------------- anchoring pass

  var anchorPassBusy = false;

  /**
   * §9.3 — every note of the document against the current DOM, one pass:
   * markers and highlight ranges under `mutateSilently`, then the report.
   */
  function anchorPass() {
    if (anchorPassBusy || !root) {
      return;
    }
    anchorPassBusy = true;
    try {
      if (!config.enabled || !config.notesAvailable) {
        clearNoteDecorations();
      } else {
        var started =
          typeof performance !== 'undefined' && performance.now
            ? performance.now()
            : Date.now();
        var results = notes.list.length
          ? core.anchorNotes(root, notes.list)
          : [];
        notes.results = Object.create(null);
        for (var i = 0; i < results.length; i++) {
          notes.results[results[i].noteId] = results[i];
        }
        mutateSilently(function () {
          drawMarkers(results);
        });
        syncNoteHighlight();
        notes.lastPassMs =
          (typeof performance !== 'undefined' && performance.now
            ? performance.now()
            : Date.now()) - started;
        // For the harness's `checks()` (12 §18 C9); harmless anywhere else.
        window.mpeReadAloudNotesPassMs = notes.lastPassMs;
        reportAnchors(results);
      }
      // The module markers ride the same pass (13 §12.5), after the notes'
      // so a module marker can sit under a note marker on the same block.
      moduleMarkersPass();
    } catch (error) {
      /* an anchoring failure must never break the preview */
    }
    anchorPassBusy = false;
  }

  /** The gutter is on while a note or a module marker is anchored (13 §12.5). */
  function gutterWanted() {
    return (
      (notes.anyFound && config.notesDecoration !== 'none') ||
      classroom.modules.anyFound
    );
  }

  function syncGutter() {
    if (root) {
      root.classList.toggle('mpe-ra-notes-gutter', gutterWanted());
    }
  }

  /** §10.1 — one marker per noted block, in the right margin. */
  function drawMarkers(results) {
    var show = config.notesDecoration !== 'none';
    var groups = new Map();
    var anyFound = false;
    for (var i = 0; i < results.length; i++) {
      var result = results[i];
      if (!result.found || !result.el) {
        continue;
      }
      anyFound = true;
      if (!show) {
        continue;
      }
      var list = groups.get(result.el);
      if (!list) {
        list = [];
        groups.set(result.el, list);
      }
      list.push(result);
    }
    notes.anyFound = anyFound;
    notes.markers.forEach(function (marker, el) {
      if (!groups.has(el) || !el.isConnected) {
        if (marker.parentNode) {
          marker.parentNode.removeChild(marker);
        }
        notes.markers.delete(el);
        notes.markerResults.delete(el);
      }
    });
    groups.forEach(function (list, el) {
      list.sort(function (a, b) {
        var sa = a.start < 0 ? Number.MAX_SAFE_INTEGER : a.start;
        var sb = b.start < 0 ? Number.MAX_SAFE_INTEGER : b.start;
        return sa - sb;
      });
      var first = list[0];
      var marker = notes.markers.get(el);
      if (!marker || marker.parentNode !== el) {
        marker = null;
        for (var c = 0; c < el.children.length; c++) {
          var child = el.children[c];
          if (
            child.classList &&
            child.classList.contains('mpe-ra-note-marker')
          ) {
            marker = child;
            break;
          }
        }
        if (!marker) {
          marker = document.createElement('button');
          marker.type = 'button';
          marker.className = 'mpe-ra-ui mpe-ra-note-marker';
          marker.setAttribute('data-mpe-ra-action', 'noteOpen');
          marker.innerHTML = ICONS.note;
          el.appendChild(marker);
        }
        notes.markers.set(el, marker);
      }
      el.classList.add('mpe-ra-block');
      marker.setAttribute('data-mpe-ra-note', first.noteId);
      var count = list.length;
      var badge = null;
      for (var b = 0; b < marker.children.length; b++) {
        if (
          marker.children[b].classList &&
          marker.children[b].classList.contains('mpe-ra-note-count')
        ) {
          badge = marker.children[b];
        }
      }
      if (count > 1) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'mpe-ra-note-count';
          badge.setAttribute('aria-hidden', 'true');
          marker.appendChild(badge);
        }
        if (badge.textContent !== String(count)) {
          badge.textContent = String(count);
        }
      } else if (badge) {
        marker.removeChild(badge);
      }
      var title = noteTitleText(noteById(first.noteId));
      var tip = count > 1 ? title + ' · ' + count + ' notes' : title;
      marker.setAttribute('title', tip);
      marker.setAttribute('aria-label', tip);
      var allPending = true;
      var active = false;
      for (var k = 0; k < list.length; k++) {
        if (!noteIsPending(noteById(list[k].noteId))) {
          allPending = false;
        }
        if (notes.open && list[k].noteId === notes.currentId) {
          active = true;
        }
      }
      marker.classList.toggle('is-pending', allPending);
      marker.classList.toggle('is-active', active);
      notes.markerResults.set(el, first);
      positionMarker(marker, first);
    });
    syncGutter();
  }

  /** The innermost block the passage starts in: the item, the row, the p. */
  function innerBlockOf(result) {
    if (!result || !result.el || !result.map || result.start < 0) {
      return result ? result.el : null;
    }
    var dom = null;
    try {
      dom = core.offsetToDom(result.map, result.start);
    } catch (error) {
      dom = null;
    }
    if (!dom) {
      return result.el;
    }
    var node = dom.node.nodeType === 1 ? dom.node : dom.node.parentElement;
    while (node && node !== result.el) {
      if (NOTE_MARKER_LINE_TAGS[node.tagName]) {
        return node;
      }
      node = node.parentElement;
    }
    return result.el;
  }

  /** §10.1 — the marker's top is the passage's first line box, relative to the block. */
  function positionMarker(marker, result) {
    var top = null;
    try {
      var blockRect = result.el.getBoundingClientRect();
      var range =
        result.spans && result.spans.length
          ? core.offsetsToRange(
              result.spans[0].map,
              result.spans[0].start,
              result.spans[0].end,
              document,
            )
          : null;
      var rects = range && range.getClientRects ? range.getClientRects() : null;
      if (rects && rects.length && (rects[0].height || rects[0].width)) {
        top = rects[0].top - blockRect.top;
      } else {
        var inner = innerBlockOf(result);
        if (inner && inner !== result.el) {
          var rect = inner.getBoundingClientRect();
          if (rect.height) {
            top = rect.top - blockRect.top;
          }
        }
      }
    } catch (error) {
      top = null;
    }
    if (top !== null && top > 1) {
      marker.style.top = Math.round(top) + 'px';
    } else {
      marker.style.removeProperty('top');
    }
  }

  function scheduleMarkerLayout() {
    if (notes.layoutFrame || !notes.markers.size) {
      return;
    }
    notes.layoutFrame = window.requestAnimationFrame(function () {
      notes.layoutFrame = 0;
      notes.markers.forEach(function (marker, el) {
        var result = notes.markerResults.get(el);
        if (result && el.isConnected) {
          positionMarker(marker, result);
        }
      });
    });
  }

  /** The active class follows the open sheet without a whole pass. */
  function markMarkersActive() {
    notes.markers.forEach(function (marker) {
      var id = marker.getAttribute('data-mpe-ra-note');
      var active = false;
      if (notes.open && notes.currentId) {
        var result = noteResult(notes.currentId);
        active =
          !!result &&
          result.found &&
          notes.markerResults.get(result.el) &&
          marker.parentNode === result.el;
      }
      marker.classList.toggle(
        'is-active',
        !!active || (notes.open && id === notes.currentId),
      );
    });
  }

  function clearNoteDecorations() {
    notes.markers.forEach(function (marker) {
      if (marker.parentNode) {
        marker.parentNode.removeChild(marker);
      }
    });
    notes.markers.clear();
    notes.markerResults.clear();
    notes.anyFound = false;
    syncGutter();
    if (highlightSupported()) {
      try {
        window.CSS.highlights.delete(NOTE_HIGHLIGHT_NAME);
      } catch (error) {
        /* no registry */
      }
    }
    notes.highlight = null;
    notes.highlightRanges = [];
  }

  // ------------------------------------------------ the words' mark

  /** §10.2 — the CSS Custom Highlight API, when the engine has it. */
  function highlightSupported() {
    try {
      return (
        typeof window.CSS !== 'undefined' &&
        !!window.CSS &&
        !!window.CSS.highlights &&
        typeof window.Highlight === 'function'
      );
    } catch (error) {
      return false;
    }
  }

  function syncNoteHighlight() {
    if (!highlightSupported()) {
      return;
    }
    var registry = window.CSS.highlights;
    var show =
      config.enabled &&
      config.notesAvailable &&
      config.notesDecoration === 'marker-and-mark';
    if (!show) {
      try {
        registry.delete(NOTE_HIGHLIGHT_NAME);
      } catch (error) {
        /* ignore */
      }
      notes.highlight = null;
      notes.highlightRanges = [];
      return;
    }
    var reading = record.blockEls || [];
    var ranges = [];
    for (var id in notes.results) {
      var result = notes.results[id];
      if (!result.found || !result.spans) {
        continue;
      }
      for (var i = 0; i < result.spans.length; i++) {
        var span = result.spans[i];
        if (reading.indexOf(span.el) >= 0 || !span.el.isConnected) {
          continue;
        }
        try {
          var range = core.offsetsToRange(
            span.map,
            span.start,
            span.end,
            document,
          );
          if (range) {
            range._mpeNoteId = id;
            ranges.push(range);
          }
        } catch (error) {
          /* a stale map after an edit: the next pass rebuilds it */
        }
      }
    }
    var highlight = new window.Highlight();
    for (var r = 0; r < ranges.length; r++) {
      try {
        highlight.add(ranges[r]);
      } catch (error) {
        /* ignore */
      }
    }
    try {
      registry.set(NOTE_HIGHLIGHT_NAME, highlight);
    } catch (error) {
      /* ignore */
    }
    notes.highlight = highlight;
    notes.highlightRanges = ranges;
  }

  /** §11.7 — the note whose marked words a click landed on, or null. */
  function noteAtPoint(event) {
    if (
      !notes.highlightRanges.length ||
      config.notesDecoration !== 'marker-and-mark'
    ) {
      return null;
    }
    var caret = caretFromPoint(event.clientX, event.clientY);
    if (!caret) {
      return null;
    }
    for (var i = 0; i < notes.highlightRanges.length; i++) {
      var range = notes.highlightRanges[i];
      try {
        if (range.isPointInRange(caret.node, caret.offset)) {
          return range._mpeNoteId || null;
        }
      } catch (error) {
        /* a node from another document */
      }
    }
    return null;
  }

  // ------------------------------------------------------- the report

  /** §9.4 — one post per pass, only when the result changed. */
  function reportAnchors(results) {
    var report = [];
    for (var i = 0; i < results.length && i < 500; i++) {
      var result = results[i];
      var entry = { noteId: result.noteId, found: !!result.found };
      if (result.found) {
        if (result.block) {
          entry.block = result.block;
        }
        entry.line = typeof result.line === 'number' ? result.line : null;
      }
      report.push(entry);
    }
    var key = JSON.stringify(report);
    if (key === notes.lastAnchorsReport) {
      return;
    }
    notes.lastAnchorsReport = key;
    if (report.length) {
      post('readAloudNoteAnchors', [sourceUri, report]);
    }
  }

  // ---------------------------------------------------- reading order

  /** §11.6 — anchored notes by block position then offset; orphans last by date. */
  function noteReadingOrder() {
    var anchored = [];
    var orphans = [];
    for (var i = 0; i < notes.list.length; i++) {
      var note = notes.list[i];
      var result = noteResult(note.id);
      if (result && result.found) {
        anchored.push({
          note: note,
          index: result.index,
          start: result.start < 0 ? 0 : result.start,
        });
      } else {
        orphans.push(note);
      }
    }
    anchored.sort(function (a, b) {
      return a.index - b.index || a.start - b.start;
    });
    orphans.sort(function (a, b) {
      return a.created < b.created ? -1 : a.created > b.created ? 1 : 0;
    });
    return anchored
      .map(function (entry) {
        return entry.note;
      })
      .concat(orphans);
  }

  // --------------------------------------------------------- the chips

  function makeNoteChip() {
    var chip = document.createElement('div');
    chip.className = 'mpe-ra-ui mpe-ra-note-chip';
    chip.setAttribute('role', 'status');
    chip.setAttribute('aria-live', 'polite');
    chip.hidden = true;
    var text = document.createElement('span');
    text.className = 'mpe-ra-note-chip-text';
    var undo = makeButton('noteUndo', 'Undo', 'mpe-ra-note-undo');
    undo.textContent = 'Undo';
    undo.hidden = true;
    chip.appendChild(text);
    chip.appendChild(undo);
    return { root: chip, text: text, undo: undo };
  }

  /** A chip above the bar for `ms`; with `undoId` it carries Undo (§7.7). */
  function showNoteChip(text, ms, undoId, kind) {
    ensureBar();
    var chip = barParts.noteChip;
    chip.text.textContent = text;
    chip.undo.hidden = !undoId;
    if (undoId) {
      chip.undo.setAttribute('data-mpe-ra-note', undoId);
      // 13 §11.4 — the same chip undoes a module's delete.
      chip.undo.setAttribute('data-mpe-ra-kind', kind || 'note');
    } else {
      chip.undo.removeAttribute('data-mpe-ra-note');
      chip.undo.removeAttribute('data-mpe-ra-kind');
    }
    notes.chipNoteId = undoId || null;
    chip.root.hidden = false;
    wakePanel();
    notes.chipTimer = clearTimer(notes.chipTimer);
    notes.chipTimer = setTimeout(function () {
      notes.chipTimer = 0;
      hideNoteChip();
    }, ms);
  }

  function hideNoteChip() {
    notes.chipTimer = clearTimer(notes.chipTimer);
    notes.chipNoteId = null;
    if (barParts && barParts.noteChip) {
      barParts.noteChip.root.hidden = true;
      barParts.noteChip.undo.hidden = true;
    }
  }

  /** `Saved` / `Copied` in the details chip for a second (§11.1, §11.4). */
  function showNoteTransient(text) {
    notes.transient = text;
    notes.transientTimer = clearTimer(notes.transientTimer);
    notes.transientTimer = setTimeout(function () {
      notes.transientTimer = 0;
      notes.transient = '';
      syncNoteSheet();
    }, NOTE_TRANSIENT_MS);
    syncNoteSheet();
  }

  // ------------------------------------------------------ the bar button

  function syncNotesBar() {
    if (!barParts || !barParts.notesButton) {
      return;
    }
    var button = barParts.notesButton;
    button.hidden = !config.notesAvailable;
    var count = notes.list.length;
    if (count > 0) {
      barParts.notesBadge.textContent = String(count);
      barParts.notesBadge.hidden = false;
    } else {
      barParts.notesBadge.hidden = true;
    }
    button.classList.toggle('is-active', notes.listOpen);
    button.setAttribute('aria-expanded', notes.listOpen ? 'true' : 'false');
    var label = notes.listOpen
      ? 'Close the notes list'
      : count
        ? NOTES_TOOLTIP + ' · ' + count
        : NOTES_TOOLTIP;
    button.setAttribute('title', label);
    button.setAttribute('aria-label', label);
  }

  // ------------------------------------------------------ the Note sheet

  function makeNoteSheet() {
    var sheet = document.createElement('div');
    sheet.className = 'mpe-ra-ui mpe-ra-note';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Note');
    sheet.setAttribute('tabindex', '-1');
    sheet.hidden = true;

    var head = document.createElement('div');
    head.className = 'mpe-ra-note-head';
    var title = document.createElement('span');
    title.className = 'mpe-ra-note-title';
    title.textContent = 'Note';
    var details = document.createElement('span');
    details.className = 'mpe-ra-note-details';
    details.setAttribute('role', 'status');
    details.setAttribute('aria-live', 'polite');
    var close = makeIconButton(
      'noteClose',
      'Close note',
      'mpe-ra-bar-btn mpe-ra-sheet-close',
      'close',
    );
    head.appendChild(title);
    head.appendChild(details);
    head.appendChild(close);

    var scroll = document.createElement('div');
    scroll.className = 'mpe-ra-note-scroll';

    var banner = document.createElement('div');
    banner.className = 'mpe-ra-note-banner';
    banner.hidden = true;
    var bannerText = document.createElement('span');
    bannerText.className = 'mpe-ra-note-banner-text';
    bannerText.textContent = NOTE_ORPHAN_TEXT;
    var reattach = makeHelpButton(
      'noteReattach',
      'Re-attach to selection',
      'mpe-ra-help-action mpe-ra-note-reattach',
    );
    banner.appendChild(bannerText);
    banner.appendChild(reattach);

    var path = document.createElement('div');
    path.className = 'mpe-ra-note-path';
    path.hidden = true;

    // The body carries no `.mpe-ra-ui`: it is a reading scope (§11.1).
    var body = document.createElement('div');
    body.className = NOTE_BODY_CLASS;

    var mine = document.createElement('div');
    mine.className = 'mpe-ra-note-mine';
    var textarea = document.createElement('textarea');
    textarea.className = 'mpe-ra-ui mpe-ra-note-textarea';
    textarea.placeholder = 'Why did you save this? Optional.';
    textarea.rows = 2;
    textarea.setAttribute('aria-label', 'My note');
    mine.appendChild(textarea);

    var tags = document.createElement('div');
    tags.className = 'mpe-ra-note-tags';
    var tagsLabel = document.createElement('span');
    tagsLabel.className = 'mpe-ra-note-tags-label';
    tagsLabel.textContent = 'Tags';
    var tagList = document.createElement('span');
    tagList.className = 'mpe-ra-note-tag-list';
    var tagInput = document.createElement('input');
    tagInput.className = 'mpe-ra-ui mpe-ra-note-tag-input';
    tagInput.type = 'text';
    tagInput.placeholder = '+ Add tag';
    tagInput.setAttribute('aria-label', 'Add a tag');
    tagInput.setAttribute('maxlength', '32');
    tags.appendChild(tagsLabel);
    tags.appendChild(tagList);
    tags.appendChild(tagInput);

    var context = document.createElement('div');
    context.className = 'mpe-ra-note-context';
    var contextToggle = makeButton(
      'noteContext',
      'Show context',
      'mpe-ra-note-context-toggle',
    );
    contextToggle.textContent = 'Show context';
    contextToggle.setAttribute('aria-expanded', 'false');
    var contextBody = document.createElement('div');
    contextBody.className = 'mpe-ra-note-context-body';
    contextBody.hidden = true;
    context.appendChild(contextToggle);
    context.appendChild(contextBody);

    scroll.appendChild(banner);
    scroll.appendChild(path);
    scroll.appendChild(body);
    scroll.appendChild(mine);
    scroll.appendChild(tags);
    scroll.appendChild(context);

    var footer = document.createElement('div');
    footer.className = 'mpe-ra-note-footer';
    var actions = document.createElement('div');
    actions.className = 'mpe-ra-note-actions';
    var regenerate = makeHelpButton(
      'noteRegenerate',
      'Regenerate',
      'mpe-ra-help-action mpe-ra-note-regenerate',
    );
    var openEditor = makeHelpButton(
      'noteOpenEditor',
      'Open in editor',
      'mpe-ra-help-action mpe-ra-note-open-editor',
    );
    var copy = makeHelpButton(
      'noteCopy',
      'Copy',
      'mpe-ra-help-action mpe-ra-note-copy',
    );
    copy.setAttribute('title', 'Copy as markdown');
    copy.setAttribute('aria-label', 'Copy as markdown');
    var remove = makeHelpButton(
      'noteDelete',
      'Delete',
      'mpe-ra-help-action mpe-ra-note-delete',
    );
    actions.appendChild(regenerate);
    actions.appendChild(openEditor);
    actions.appendChild(copy);
    actions.appendChild(remove);

    var pager = document.createElement('div');
    pager.className = 'mpe-ra-note-pager';
    var prev = makeHelpButton(
      'notePrev',
      'Previous note',
      'mpe-ra-help-action mpe-ra-note-prev',
    );
    prev.innerHTML = ICONS.chevronLeft;
    var pagerLabel = document.createElement('span');
    pagerLabel.className = 'mpe-ra-note-pager-label';
    var next = makeHelpButton(
      'noteNext',
      'Next note',
      'mpe-ra-help-action mpe-ra-note-next',
    );
    next.innerHTML = ICONS.chevronRight;
    var play = makeHelpButton(
      'notePlay',
      'Play',
      'mpe-ra-help-action mpe-ra-note-play',
    );
    var resume = makeHelpButton(
      'noteResume',
      'Resume',
      'mpe-ra-help-action mpe-ra-note-resume',
    );
    resume.hidden = true;
    pager.appendChild(prev);
    pager.appendChild(pagerLabel);
    pager.appendChild(next);
    pager.appendChild(play);
    pager.appendChild(resume);

    footer.appendChild(actions);
    footer.appendChild(pager);

    sheet.appendChild(head);
    sheet.appendChild(scroll);
    sheet.appendChild(footer);

    return {
      root: sheet,
      details: details,
      close: close,
      scroll: scroll,
      banner: banner,
      reattach: reattach,
      path: path,
      body: body,
      textarea: textarea,
      tagList: tagList,
      tagInput: tagInput,
      contextToggle: contextToggle,
      contextBody: contextBody,
      regenerate: regenerate,
      openEditor: openEditor,
      copy: copy,
      remove: remove,
      pager: pager,
      prev: prev,
      pagerLabel: pagerLabel,
      next: next,
      play: play,
      resume: resume,
    };
  }

  /** The scrolling column of the Note sheet (the follow scroll's container). */
  function noteScrollBox() {
    return barParts && barParts.note ? barParts.note.scroll : null;
  }

  function skeletonHtml(lines, title) {
    var out =
      '<div class="mpe-ra-ui mpe-ra-note-skel' +
      (title ? ' is-title' : '') +
      '" aria-hidden="true">';
    for (var i = 0; i < lines; i++) {
      out += '<i></i>';
    }
    return out + '</div>';
  }

  function lineHtml(text, error) {
    return (
      '<div class="mpe-ra-ui mpe-ra-note-line-wrap"><p class="mpe-ra-ui mpe-ra-note-line' +
      (error ? ' is-error' : '') +
      '">' +
      escapeHtml(text) +
      '</p></div>'
    );
  }

  /** §11.1–§11.2 — the body: title, passage, sections or their stand-ins, My note. */
  function buildNoteBodyHtml(note, pending) {
    var parts = [];
    var pendingState = !note || noteIsPending(note);
    var hasSections = !!(note && note.html);
    if (pendingState && !hasSections && !(note && note.titleEdited)) {
      parts.push(skeletonHtml(1, true));
    } else {
      parts.push('<h1>' + escapeHtml(note ? note.title : '') + '</h1>');
    }
    var passage = note ? note.passage : pending ? pending.passage : '';
    parts.push(
      '<blockquote>' +
        passage
          .split('\n')
          .map(function (line) {
            return '<p>' + escapeHtml(line) + '</p>';
          })
          .join('') +
        '</blockquote>',
    );
    if (pending && pending.error) {
      parts.push(lineHtml(pending.error, true));
    } else if (hasSections) {
      parts.push(note.html);
    } else if (note && note.generated.status === 'error') {
      parts.push(
        lineHtml(
          NOTE_ERROR_PREFIX +
            (note.generated.error ? ' ' + note.generated.error : ''),
          true,
        ),
      );
    } else if (pendingState) {
      parts.push(skeletonHtml(2) + skeletonHtml(1) + skeletonHtml(2));
    } else if (note && !notes.generate && note.generated.source !== 'help') {
      parts.push(lineHtml(NOTE_OFF_TEXT, false));
    }
    parts.push('<h2>My note</h2>');
    if (note && note.myNote) {
      parts.push(
        '<p class="mpe-ra-note-mine-echo">' + escapeHtml(note.myNote) + '</p>',
      );
    }
    return parts.join('');
  }

  /** Put the rendered note into the body and collect its blocks (§11.5). */
  function setNoteBodyHtml(html) {
    var body = noteBody();
    noteBlocks = [];
    noteBlocksByElement = new Map();
    if (!body) {
      return;
    }
    body.innerHTML = html || '';
    if (!html) {
      return;
    }
    var collected = core.collectBlocks(body);
    for (var i = 0; i < collected.length; i++) {
      var el = collected[i].el;
      var text = core.extractText(el).text;
      var entry = {
        el: el,
        kind: collected[i].kind,
        index: collected[i].index,
        key: core.blockKey(el, text),
        text: text,
        label: core.blockLabel(text),
        button: null,
        scope: body,
        noButton: true,
      };
      noteBlocks.push(entry);
      noteBlocksByElement.set(el, entry);
      el.classList.add('mpe-ra-block');
    }
  }

  function renderTags(tags) {
    var sheet = barParts.note;
    sheet.tagList.innerHTML = '';
    for (var i = 0; i < tags.length; i++) {
      var chip = document.createElement('span');
      chip.className = 'mpe-ra-note-tag';
      chip.setAttribute('data-tag', tags[i]);
      var text = document.createElement('span');
      text.textContent = tags[i];
      var remove = makeButton(
        'noteTagRemove',
        'Remove tag ' + tags[i],
        'mpe-ra-note-tag-remove',
      );
      remove.textContent = '×';
      remove.setAttribute('data-tag', tags[i]);
      chip.appendChild(text);
      chip.appendChild(remove);
      sheet.tagList.appendChild(chip);
    }
    sheet.tagInput.hidden = tags.length >= NOTE_TAGS_MAX;
  }

  function contextBlock(label, text) {
    return (
      '<div class="mpe-ra-note-context-label">' +
      escapeHtml(label) +
      '</div><blockquote class="mpe-ra-note-context-quote">' +
      escapeHtml(text) +
      '</blockquote>'
    );
  }

  function renderContext(context) {
    var sheet = barParts.note;
    var parts = [];
    if (context.enclosing) {
      parts.push(contextBlock('Enclosing', context.enclosing));
    }
    if (context.before) {
      parts.push(contextBlock('Before', context.before));
    }
    if (context.after) {
      parts.push(contextBlock('After', context.after));
    }
    sheet.contextBody.innerHTML = parts.join('');
    var has = parts.length > 0;
    sheet.contextToggle.hidden = !has;
    sheet.contextBody.hidden = !has || !notes.contextOpen;
    sheet.contextToggle.textContent = notes.contextOpen
      ? 'Hide context'
      : 'Show context';
    sheet.contextToggle.setAttribute(
      'aria-expanded',
      notes.contextOpen ? 'true' : 'false',
    );
  }

  /** The textarea grows to eight lines, then scrolls (§11.1). */
  function autoGrowTextarea(textarea) {
    var lines = textarea.value.split('\n').length;
    textarea.rows = Math.max(2, Math.min(8, lines));
    try {
      textarea.style.height = 'auto';
      var height = textarea.scrollHeight;
      if (height > 0) {
        var lineHeight =
          parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
        textarea.style.height = Math.min(height, lineHeight * 8 + 14) + 'px';
      }
    } catch (error) {
      /* no layout */
    }
  }

  /** §11.1–§11.3 — everything the sheet shows, from the current note. */
  function renderNote() {
    if (!barParts || !barParts.note) {
      return;
    }
    var sheet = barParts.note;
    var note = noteById(notes.currentId);
    var pending = !note && notes.pendingCreate ? notes.pendingCreate : null;
    if (!note && !pending) {
      closeNote('gone');
      return;
    }
    var status = note ? note.generated.status : 'pending';
    var fromHelp = !!(note && note.generated.source === 'help');
    var orphan = note ? noteIsOrphan(note.id) : false;

    var details;
    if (pending && pending.error) {
      details = pending.error;
    } else if (!note || status === 'pending') {
      details = 'Writing the note…';
    } else if (status === 'error') {
      details = NOTE_ERROR_PREFIX;
    } else {
      details = noteDateText(note.created);
      if (fromHelp) {
        details += ' · from Explain';
      } else if (note.generated.engine) {
        details +=
          ' · ' +
          note.generated.engine +
          (note.generated.model ? ' · ' + note.generated.model : '');
      }
    }
    if (notes.transient) {
      details = notes.transient;
    }
    sheet.details.textContent = details;
    sheet.details.classList.toggle(
      'is-error',
      !notes.transient && (status === 'error' || !!(pending && pending.error)),
    );

    sheet.banner.hidden = !orphan;
    var headings = note ? note.headings : pending.breadcrumb;
    sheet.path.textContent =
      (orphan ? 'Was under ' : '') + headings.join(' › ');
    sheet.path.hidden = !headings.length;

    var key = [
      note ? note.id : 'pending',
      note ? note.updated : '',
      note ? status : 'pending',
      note ? (note.html || '').length : 0,
      note ? note.title : '',
      note ? note.myNote : '',
      pending && pending.error ? 'error' : '',
      notes.generate ? 'gen' : 'off',
    ].join('|');
    if (key !== notes.renderedKey) {
      if (record.scope === noteBody() && record.state !== 'idle') {
        endJob({ next: 'idle', reason: 'note changed' });
      }
      notes.renderedKey = key;
      setNoteBodyHtml(buildNoteBodyHtml(note, pending));
      applyThemeAttributes();
    }

    if (document.activeElement !== sheet.textarea) {
      var value = note
        ? note.myNote
        : notes.pendingMyNote !== null && notes.pendingMyNote !== undefined
          ? notes.pendingMyNote
          : '';
      if (sheet.textarea.value !== value && !notes.myNoteTimer) {
        sheet.textarea.value = value;
      }
    }
    autoGrowTextarea(sheet.textarea);
    renderTags(note ? note.tags : []);
    sheet.tagInput.disabled = !note;
    renderContext(note ? note.context : pending.context);

    var regenerable = !!note && status !== 'pending';
    setEnabled(sheet.regenerate, regenerable);
    sheet.regenerate.setAttribute(
      'title',
      regenerable ? 'Write the summary again' : 'Being written',
    );
    sheet.openEditor.hidden = orphan || !note;
    setEnabled(sheet.copy, !!note);
    setEnabled(sheet.remove, !!note);

    var order = noteReadingOrder();
    var index = note ? order.indexOf(note) : -1;
    sheet.pagerLabel.textContent =
      index >= 0 ? index + 1 + ' of ' + order.length : '';
    setEnabled(sheet.prev, index > 0);
    setEnabled(sheet.next, index >= 0 && index < order.length - 1);
    setEnabled(sheet.play, noteBlocks.length > 0);
    var resumable = canResumeFrom(notes.resume);
    sheet.resume.hidden = !notes.resume;
    setEnabled(sheet.resume, resumable);

    var liveSelection = !!liveSelectionIn(root);
    setEnabled(sheet.reattach, liveSelection);
    sheet.reattach.setAttribute(
      'title',
      liveSelection ? 'Re-attach to selection' : 'Select text to re-attach',
    );
  }

  function syncNoteSheet() {
    if (!notes.open || !barParts || !barParts.note) {
      return;
    }
    renderNote();
    markMarkersActive();
  }

  /** Re-attach is enabled while the document has a selection that resolves. */
  function syncNoteReattach() {
    if (!notes.open || !barParts || !barParts.note) {
      return;
    }
    var liveSelection = !!liveSelectionIn(root);
    setEnabled(barParts.note.reattach, liveSelection);
    barParts.note.reattach.setAttribute(
      'title',
      liveSelection ? 'Re-attach to selection' : 'Select text to re-attach',
    );
  }

  function focusNoteSheet() {
    if (!barParts || !barParts.note) {
      return;
    }
    try {
      barParts.note.root.focus();
    } catch (error) {
      /* jsdom and detached nodes */
    }
  }

  /** §11.6 — the follow scroll's own centring, for the note's block. */
  function scrollBlockIntoView(el) {
    if (!el || !el.getBoundingClientRect) {
      return;
    }
    try {
      var rect = el.getBoundingClientRect();
      var viewport = window.innerHeight || 0;
      if (!viewport) {
        return;
      }
      var target =
        readScrollTop(window) + rect.top - viewport * core.FOLLOW_ANCHOR;
      writeScrollTop(window, Math.max(0, target));
    } catch (error) {
      /* no layout */
    }
  }

  /**
   * §11.7 — open a note: from a marker, a marked word, the list, the view
   * or the pager. `id` null opens the pending capture's sheet (§5.2).
   */
  function openNoteSheet(id, opener) {
    if (!config.enabled || !config.notesAvailable) {
      return;
    }
    if (id && !notes.byId[id]) {
      return;
    }
    ensureBar();
    closePopovers();
    closeHelp('note');
    closeNotesList('note');
    closeClassroom('note');
    closeModuleSheet('note');
    hideFloat();
    panelDismissed = false;
    if (notes.open && notes.currentId !== id) {
      flushMyNote();
    }
    notes.open = true;
    notes.currentId = id;
    notes.opener = opener || null;
    notes.contextOpen = id ? noteIsOrphan(id) : false;
    notes.renderedKey = '';
    barParts.note.root.hidden = false;
    renderNote();
    showBar('');
    if (id) {
      var result = noteResult(id);
      if (result && result.found && result.el) {
        scrollBlockIntoView(result.el);
      }
    }
    markMarkersActive();
    syncNotesBar();
    syncHelpButton();
    focusNoteSheet();
  }

  function openNote(id, opener) {
    if (!id || !notes.byId[id]) {
      return;
    }
    openNoteSheet(id, opener);
  }

  /** §11.4 — Escape and ×; a pending My note is written first. */
  function closeNote(reason) {
    if (!notes.open) {
      return;
    }
    flushMyNote();
    if (record.scope === noteBody() && record.state !== 'idle') {
      endJob({ next: 'idle', reason: 'note sheet closed (' + reason + ')' });
    }
    var opener = notes.opener;
    notes.open = false;
    notes.currentId = null;
    notes.opener = null;
    notes.pendingCreate = null;
    notes.pendingMyNote = null;
    notes.renderedKey = '';
    notes.transient = '';
    notes.transientTimer = clearTimer(notes.transientTimer);
    if (barParts && barParts.note) {
      barParts.note.root.hidden = true;
    }
    setNoteBodyHtml('');
    markMarkersActive();
    syncNotesBar();
    syncHelpButton();
    armPanelIdle();
    var target =
      opener && opener.isConnected
        ? opener
        : barParts && barParts.notesButton && !barParts.notesButton.hidden
          ? barParts.notesButton
          : null;
    if (target) {
      try {
        target.focus();
      } catch (error) {
        /* the panel may be going away */
      }
    }
  }

  /** The open note vanished from the list: the next in order, or close. */
  function pageOnFromMissing() {
    var order = noteReadingOrder();
    if (!order.length) {
      closeNote('deleted');
      return;
    }
    notes.currentId = order[0].id;
    notes.contextOpen = noteIsOrphan(notes.currentId);
    notes.renderedKey = '';
  }

  function stepNote(direction) {
    var order = noteReadingOrder();
    var current = noteById(notes.currentId);
    var index = current ? order.indexOf(current) : -1;
    var target = order[index + direction];
    if (!target) {
      return;
    }
    flushMyNote();
    notes.currentId = target.id;
    notes.contextOpen = noteIsOrphan(target.id);
    notes.renderedKey = '';
    renderNote();
    var result = noteResult(target.id);
    if (result && result.found && result.el) {
      scrollBlockIntoView(result.el);
    }
    markMarkersActive();
  }

  // ---------------------------------------------------- My note and tags

  function onMyNoteInput() {
    var sheet = barParts.note;
    autoGrowTextarea(sheet.textarea);
    notes.myNoteTimer = clearTimer(notes.myNoteTimer);
    notes.myNoteTimer = setTimeout(function () {
      notes.myNoteTimer = 0;
      flushMyNote();
    }, NOTE_MY_NOTE_DEBOUNCE_MS);
  }

  /** Write the textarea's text now, if it differs from the note's (§11.1). */
  function flushMyNote() {
    if (!barParts || !barParts.note) {
      return;
    }
    var hadTimer = notes.myNoteTimer !== 0;
    notes.myNoteTimer = clearTimer(notes.myNoteTimer);
    var value = barParts.note.textarea.value;
    var note = noteById(notes.currentId);
    if (!note) {
      if (notes.pendingCreate && value) {
        notes.pendingMyNote = value;
      }
      return;
    }
    if (!hadTimer && value === note.myNote) {
      return;
    }
    if (value === note.myNote) {
      return;
    }
    note.myNote = value;
    post('readAloudNoteUpdate', [sourceUri, note.id, { myNote: value }]);
    showNoteTransient('Saved');
  }

  function commitTagInput() {
    var sheet = barParts.note;
    var note = noteById(notes.currentId);
    var raw = sheet.tagInput.value;
    sheet.tagInput.value = '';
    if (!note) {
      return;
    }
    var tag = raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    if (
      !tag ||
      note.tags.indexOf(tag) >= 0 ||
      note.tags.length >= NOTE_TAGS_MAX
    ) {
      return;
    }
    var tags = note.tags.concat([tag]);
    note.tags = tags;
    post('readAloudNoteUpdate', [sourceUri, note.id, { tags: tags }]);
    renderTags(tags);
  }

  function removeTag(tag) {
    var note = noteById(notes.currentId);
    if (!note || !tag) {
      return;
    }
    var tags = note.tags.filter(function (candidate) {
      return candidate !== tag;
    });
    if (tags.length === note.tags.length) {
      return;
    }
    note.tags = tags;
    post('readAloudNoteUpdate', [sourceUri, note.id, { tags: tags }]);
    renderTags(tags);
  }

  /** §11.1 — Enter or a comma commits; Backspace on an empty input removes the last. */
  function onTagInputKeydown(event) {
    var sheet = barParts.note;
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commitTagInput();
      return;
    }
    if (event.key === 'Backspace' && sheet.tagInput.value === '') {
      var note = noteById(notes.currentId);
      if (note && note.tags.length) {
        event.preventDefault();
        removeTag(note.tags[note.tags.length - 1]);
      }
    }
  }

  // ------------------------------------------------------------ actions

  /** §11.5 — Play: pause a document read and read the sheet, bounded to it. */
  function playNoteFromStart() {
    if (!noteBlocks.length) {
      return;
    }
    if (record.scope === root && record.state !== 'idle') {
      var remembered = rememberResume();
      if (remembered) {
        notes.resume = remembered;
      }
    }
    if (record.state === 'error') {
      clearTransientError();
    } else if (record.state !== 'idle') {
      endJob({ next: 'idle', reason: 'note play' });
    }
    startBlockRead(noteBlocks[0], 0);
    syncNoteSheet();
  }

  function resumeNoteRead() {
    var resume = notes.resume;
    if (!canResumeFrom(resume)) {
      return;
    }
    notes.resume = null;
    closeNote('resume');
    resumeFrom(resume);
  }

  function regenerateNote() {
    var note = noteById(notes.currentId);
    if (!note || noteIsPending(note)) {
      return;
    }
    var fields = null;
    var result = noteResult(note.id);
    if (result && result.found && result.el && result.el.isConnected) {
      try {
        fields = noteFieldsFrom(
          buildHelpContextFor({
            text: note.passage,
            els: [result.el],
            range: null,
          }),
        );
      } catch (error) {
        fields = null;
      }
    }
    post('readAloudNoteRegenerate', [sourceUri, note.id, fields]);
    setEnabled(barParts.note.regenerate, false);
    barParts.note.regenerate.setAttribute('title', 'Being written');
  }

  function deleteCurrentNote() {
    var note = noteById(notes.currentId);
    if (!note) {
      return;
    }
    flushMyNote();
    post('readAloudNoteDelete', [sourceUri, note.id]);
    showNoteChip(deleteChipText(), NOTE_UNDO_MS, note.id);
    notes.deleting = notes.deleting.concat([note.id]);
  }

  function undoDelete(id) {
    if (!id) {
      return;
    }
    post('readAloudNoteUndoDelete', [sourceUri, id]);
    hideNoteChip();
  }

  /** §11.3 — a fresh anchor from the live selection; the passage stays. */
  function reattachNote() {
    var note = noteById(notes.currentId);
    if (!note) {
      return;
    }
    var live = liveSelectionIn(root);
    if (!live) {
      showHint('Select text to re-attach', currentSelectionRect() || floatRect);
      return;
    }
    var selection = window.getSelection();
    var passage = {
      text: live.text,
      els: live.blocks.slice(),
      range: selection && selection.rangeCount ? selection.getRangeAt(0) : null,
    };
    var anchor = noteAnchorForPassage(passage);
    if (!anchor) {
      return;
    }
    var context = buildHelpContextFor(passage);
    post('readAloudNoteReattach', [
      sourceUri,
      note.id,
      anchor,
      context.breadcrumb.slice(),
    ]);
    hideFloat();
  }

  /** The note actions of `handleAction`; true when `action` was one. */
  function handleNoteAction(action, element) {
    if (action === 'notes') {
      closePopovers();
      toggleNotesList();
      return true;
    }
    if (action === 'notesClose') {
      closeNotesList('close');
      return true;
    }
    if (action === 'notesShowAll') {
      post('readAloudNotesShowAll', [sourceUri]);
      return true;
    }
    if (action === 'noteOpen') {
      var id = element ? element.getAttribute('data-mpe-ra-note') : null;
      openNote(id, element);
      return true;
    }
    if (action === 'noteClose') {
      closeNote('close');
      return true;
    }
    if (action === 'noteUndo') {
      var undoId = element ? element.getAttribute('data-mpe-ra-note') : null;
      if (element && element.getAttribute('data-mpe-ra-kind') === 'module') {
        undoModuleDelete(undoId);
      } else {
        undoDelete(undoId);
      }
      return true;
    }
    if (action === 'noteRegenerate') {
      regenerateNote();
      return true;
    }
    if (action === 'noteOpenEditor') {
      if (notes.currentId) {
        post('readAloudNoteOpen', [sourceUri, notes.currentId, 'editor']);
      }
      return true;
    }
    if (action === 'noteCopy') {
      if (notes.currentId) {
        post('readAloudNoteCopy', [sourceUri, notes.currentId]);
        showNoteTransient('Copied');
      }
      return true;
    }
    if (action === 'noteDelete') {
      deleteCurrentNote();
      return true;
    }
    if (action === 'notePrev') {
      stepNote(-1);
      return true;
    }
    if (action === 'noteNext') {
      stepNote(1);
      return true;
    }
    if (action === 'notePlay') {
      playNoteFromStart();
      return true;
    }
    if (action === 'noteResume') {
      resumeNoteRead();
      return true;
    }
    if (action === 'noteReattach') {
      reattachNote();
      return true;
    }
    if (action === 'noteContext') {
      notes.contextOpen = !notes.contextOpen;
      syncNoteSheet();
      return true;
    }
    if (action === 'noteTagRemove') {
      removeTag(element ? element.getAttribute('data-tag') : null);
      return true;
    }
    if (action === 'floatNote') {
      saveNoteFromSelection();
      return true;
    }
    return false;
  }

  // ------------------------------------------------ the Notes list sheet

  function makeNotesListSheet() {
    var sheet = document.createElement('div');
    sheet.className = 'mpe-ra-ui mpe-ra-notes-list';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Notes in this document');
    sheet.setAttribute('tabindex', '-1');
    sheet.hidden = true;

    var head = document.createElement('div');
    head.className = 'mpe-ra-notes-list-head';
    var title = document.createElement('span');
    title.className = 'mpe-ra-notes-list-title';
    title.textContent = 'Notes in this document';
    var details = document.createElement('span');
    details.className = 'mpe-ra-note-details';
    details.textContent = 'Reading order';
    var close = makeIconButton(
      'notesClose',
      'Close the notes list',
      'mpe-ra-bar-btn mpe-ra-sheet-close',
      'close',
    );
    head.appendChild(title);
    head.appendChild(details);
    head.appendChild(close);

    var rows = document.createElement('div');
    rows.className = 'mpe-ra-notes-list-rows';
    rows.setAttribute('role', 'list');
    var empty = document.createElement('p');
    empty.className = 'mpe-ra-notes-list-empty';
    empty.textContent = NOTES_EMPTY_TEXT;
    empty.hidden = true;

    var footer = document.createElement('div');
    footer.className = 'mpe-ra-notes-list-footer';
    var all = makeHelpButton(
      'notesShowAll',
      'All notes',
      'mpe-ra-help-action mpe-ra-notes-all',
    );
    var hint = document.createElement('span');
    hint.className = 'mpe-ra-notes-list-hint';
    hint.textContent = 'Click a note to go to it';
    footer.appendChild(all);
    footer.appendChild(hint);

    sheet.appendChild(head);
    sheet.appendChild(rows);
    sheet.appendChild(empty);
    sheet.appendChild(footer);
    return {
      root: sheet,
      title: title,
      rows: rows,
      empty: empty,
      all: all,
      close: close,
    };
  }

  /** §12 — one row per note in reading order, orphans last with a badge. */
  function syncNotesList() {
    if (!barParts || !barParts.notesList) {
      return;
    }
    var sheet = barParts.notesList;
    var count = notes.list.length;
    sheet.title.textContent =
      'Notes in this document' + (count ? ' · ' + count : '');
    if (!notes.listOpen) {
      return;
    }
    var order = noteReadingOrder();
    sheet.rows.innerHTML = '';
    for (var i = 0; i < order.length; i++) {
      var note = order[i];
      var orphan = noteIsOrphan(note.id);
      var row = makeButton('noteOpen', noteTitleText(note), 'mpe-ra-notes-row');
      row.setAttribute('role', 'listitem');
      row.setAttribute('data-mpe-ra-note', note.id);
      row.removeAttribute('title');
      var titleLine = document.createElement('span');
      titleLine.className = 'mpe-ra-notes-row-title';
      var titleText = document.createElement('span');
      titleText.textContent = noteTitleText(note);
      titleLine.appendChild(titleText);
      if (orphan) {
        var badge = document.createElement('span');
        badge.className = 'mpe-ra-notes-badge';
        badge.textContent = 'Not in this version';
        titleLine.appendChild(badge);
      }
      var summary = document.createElement('span');
      summary.className = 'mpe-ra-notes-row-summary';
      summary.textContent =
        note.summaryLine ||
        (noteIsPending(note) ? 'Writing the note…' : note.passage);
      var meta = document.createElement('span');
      meta.className = 'mpe-ra-notes-row-meta';
      var path = note.headings.length
        ? note.headings[note.headings.length - 1]
        : '';
      var metaParts = [];
      if (path) {
        metaParts.push((orphan ? 'Was under ' : '') + path);
      }
      var date = noteDateText(note.created);
      if (date) {
        metaParts.push(date);
      }
      meta.textContent = metaParts.join(' · ');
      row.appendChild(titleLine);
      row.appendChild(summary);
      row.appendChild(meta);
      sheet.rows.appendChild(row);
    }
    sheet.empty.hidden = count > 0;
    sheet.rows.hidden = count === 0;
  }

  function toggleNotesList() {
    if (notes.listOpen) {
      closeNotesList('button');
      return;
    }
    openNotesList(
      barParts && barParts.notesButton ? barParts.notesButton : null,
    );
  }

  function openNotesList(opener) {
    if (!config.enabled || !config.notesAvailable) {
      return;
    }
    ensureBar();
    closePopovers();
    closeHelp('notes list');
    closeNote('notes list');
    closeClassroom('notes list');
    closeModuleSheet('notes list');
    hideFloat();
    panelDismissed = false;
    notes.listOpen = true;
    notes.listOpener = opener || null;
    barParts.notesList.root.hidden = false;
    syncNotesList();
    syncNotesBar();
    showBar('');
    try {
      barParts.notesList.root.focus();
    } catch (error) {
      /* jsdom and detached nodes */
    }
  }

  function closeNotesList(reason) {
    if (!notes.listOpen) {
      return;
    }
    var opener = notes.listOpener;
    notes.listOpen = false;
    notes.listOpener = null;
    if (barParts && barParts.notesList) {
      barParts.notesList.root.hidden = true;
    }
    syncNotesBar();
    armPanelIdle();
    if (reason !== 'note') {
      var target =
        opener && opener.isConnected
          ? opener
          : barParts && barParts.notesButton && !barParts.notesButton.hidden
            ? barParts.notesButton
            : null;
      if (target) {
        try {
          target.focus();
        } catch (error) {
          /* the panel may be going away */
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 12c. Classroom (featrues/13-classroom/spec.md)
  //
  // The fourth cluster button (§5.1), the Classroom sheet and its four states
  // (§5.2–§5.4), _Teach me this_ on the help sheet (§5.5), and, in a module's
  // own preview, the bar button, the Module sheet and the message line
  // (§12.2) plus the reveal of the passage (§12.4). The host owns the build
  // and the files; this layer renders the card from the progress messages
  // alone and keeps no build state the host has not sent.
  // ---------------------------------------------------------------------------

  function applyClassroomConfig(message) {
    if (typeof message.classroomAvailable === 'boolean') {
      config.classroomAvailable = message.classroomAvailable;
    }
    if (typeof message.classroomMarker === 'boolean') {
      config.classroomMarker = message.classroomMarker;
    }
    // A broadcast leaves the field out; a module preview's own config carries
    // an object, or null for any other document.
    if (message.classroomModule === null) {
      config.classroomModule = null;
    } else if (
      message.classroomModule &&
      typeof message.classroomModule === 'object' &&
      typeof message.classroomModule.id === 'string'
    ) {
      var module = message.classroomModule;
      config.classroomModule = {
        id: module.id,
        title: typeof module.title === 'string' ? module.title : '',
        status: typeof module.status === 'string' ? module.status : 'done',
        chapters: Array.isArray(module.chapters) ? module.chapters : [],
        documentTitle:
          typeof module.documentTitle === 'string' ? module.documentTitle : '',
        documentPath:
          typeof module.documentPath === 'string' ? module.documentPath : '',
        documentHeading:
          typeof module.documentHeading === 'string'
            ? module.documentHeading
            : '',
      };
    }
  }

  /** The nearest heading before the passage's first block, by its `id`. */
  function nearestHeadingId(els) {
    if (!root || !els || !els.length) {
      return null;
    }
    var first = els[0];
    while (first && first.parentElement !== root) {
      first = first.parentElement;
    }
    if (!first) {
      return null;
    }
    var node = first.previousElementSibling;
    while (node) {
      if (/^H[1-6]$/.test(node.tagName) && node.id) {
        return String(node.id).slice(0, 200);
      }
      node = node.previousElementSibling;
    }
    return null;
  }

  /** §5.4 step 1 — the help fields in `document` mode; the source is the host's. */
  function classroomFieldsFrom(context) {
    var fields = noteFieldsFrom(context);
    fields.contextMode = 'document';
    return fields;
  }

  function classroomDateText(iso) {
    return noteDateText(iso);
  }

  function classroomMinutes(words) {
    return Math.max(1, Math.round(words / CLASSROOM_WORDS_PER_MINUTE));
  }

  function makeField(labelText, control, className) {
    var field = document.createElement('div');
    field.className = 'mpe-ra-classroom-field ' + className;
    var label = document.createElement('label');
    label.className = 'mpe-ra-classroom-label';
    label.textContent = labelText;
    field.appendChild(label);
    field.appendChild(control);
    return field;
  }

  /** §5.2 — the Classroom sheet, in the help sheet's slot. */
  function makeClassroomSheet() {
    var sheet = document.createElement('div');
    sheet.className = 'mpe-ra-ui mpe-ra-classroom';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Classroom');
    sheet.setAttribute('tabindex', '-1');
    sheet.hidden = true;

    var head = document.createElement('div');
    head.className = 'mpe-ra-classroom-head';
    var title = document.createElement('span');
    title.className = 'mpe-ra-classroom-title';
    title.textContent = 'Classroom';
    var details = document.createElement('span');
    details.className = 'mpe-ra-note-details mpe-ra-classroom-details';
    details.setAttribute('role', 'status');
    details.setAttribute('aria-live', 'polite');
    var close = makeIconButton(
      'classroomClose',
      'Close the classroom',
      'mpe-ra-bar-btn mpe-ra-sheet-close',
      'close',
    );
    head.appendChild(title);
    head.appendChild(details);
    head.appendChild(close);

    var scroll = document.createElement('div');
    scroll.className = 'mpe-ra-classroom-scroll';

    var passage = document.createElement('div');
    passage.className = 'mpe-ra-classroom-passage';
    var path = document.createElement('div');
    path.className = 'mpe-ra-classroom-path';
    path.hidden = true;
    var quote = document.createElement('div');
    quote.className = 'mpe-ra-classroom-quote';
    passage.appendChild(path);
    passage.appendChild(quote);

    var form = document.createElement('div');
    form.className = 'mpe-ra-classroom-form';

    var lever = document.createElement('div');
    lever.className = 'mpe-ra-classroom-lever';
    lever.setAttribute('role', 'radiogroup');
    lever.setAttribute('aria-label', 'How lost are you?');
    var rows = [];
    for (var i = 0; i < CLASSROOM_LEVELS.length; i++) {
      var row = makeButton(
        'classroomLevel',
        CLASSROOM_LEVELS[i].row,
        'mpe-ra-lever-row',
      );
      row.textContent = CLASSROOM_LEVELS[i].row;
      row.removeAttribute('title');
      row.setAttribute('role', 'radio');
      row.setAttribute('data-mpe-ra-level', String(CLASSROOM_LEVELS[i].level));
      row.setAttribute('aria-checked', 'false');
      lever.appendChild(row);
      rows.push(row);
    }

    var note = document.createElement('input');
    note.className = 'mpe-ra-ui mpe-ra-help-input mpe-ra-classroom-note';
    note.type = 'text';
    note.placeholder = CLASSROOM_NOTE_PLACEHOLDER;
    note.setAttribute('maxlength', String(CLASSROOM_NOTE_MAX));
    note.setAttribute('aria-label', 'In your own words, what is confusing?');

    var persona = document.createElement('select');
    persona.className =
      'mpe-ra-ui mpe-ra-sheet-select mpe-ra-classroom-persona-select';
    persona.setAttribute('aria-label', 'Instructor');

    var audience = document.createElement('input');
    audience.className =
      'mpe-ra-ui mpe-ra-help-input mpe-ra-classroom-audience-input';
    audience.type = 'text';
    audience.setAttribute('maxlength', String(CLASSROOM_AUDIENCE_MAX));
    audience.setAttribute('aria-label', 'Audience');

    var engine = makeButton(
      'helpModel',
      'Change the help model',
      'mpe-ra-help-model mpe-ra-classroom-engine',
    );

    var sending = document.createElement('div');
    sending.className = 'mpe-ra-classroom-sending';
    var sendingLine = document.createElement('p');
    sendingLine.className = 'mpe-ra-classroom-sending-line';
    var links = document.createElement('div');
    links.className = 'mpe-ra-classroom-links';
    sending.appendChild(sendingLine);
    sending.appendChild(links);

    var modules = document.createElement('div');
    modules.className = 'mpe-ra-classroom-modules';
    modules.hidden = true;
    var modulesTitle = document.createElement('p');
    modulesTitle.className = 'mpe-ra-classroom-modules-title';
    modulesTitle.textContent = 'Modules for this document';
    var moduleRows = document.createElement('div');
    moduleRows.className = 'mpe-ra-classroom-module-rows';
    moduleRows.setAttribute('role', 'list');
    modules.appendChild(modulesTitle);
    modules.appendChild(moduleRows);

    // 13 §6.1 — the size line: what the checked row buys for this passage.
    var size = document.createElement('p');
    size.className = 'mpe-ra-classroom-size';
    size.setAttribute('role', 'status');
    size.hidden = true;

    form.appendChild(lever);
    form.appendChild(size);
    form.appendChild(
      makeField('In your own words', note, 'mpe-ra-classroom-note-field'),
    );
    form.appendChild(
      makeField('Instructor', persona, 'mpe-ra-classroom-persona'),
    );
    form.appendChild(
      makeField('Audience', audience, 'mpe-ra-classroom-audience'),
    );
    form.appendChild(
      makeField('Engine', engine, 'mpe-ra-classroom-engine-field'),
    );
    form.appendChild(sending);
    form.appendChild(modules);

    var card = document.createElement('div');
    card.className = 'mpe-ra-classroom-card';
    card.hidden = true;
    var cardTitle = document.createElement('p');
    cardTitle.className = 'mpe-ra-classroom-card-title';
    var chapters = document.createElement('div');
    chapters.className = 'mpe-ra-classroom-chapters';
    chapters.setAttribute('role', 'list');
    var elapsed = document.createElement('p');
    elapsed.className = 'mpe-ra-classroom-elapsed';
    elapsed.hidden = true;
    var error = document.createElement('p');
    error.className = 'mpe-ra-classroom-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    card.appendChild(cardTitle);
    card.appendChild(chapters);
    card.appendChild(elapsed);
    card.appendChild(error);

    scroll.appendChild(passage);
    scroll.appendChild(form);
    scroll.appendChild(card);

    var footer = document.createElement('div');
    footer.className = 'mpe-ra-classroom-footer';
    var cancel = makeHelpButton(
      'classroomCancel',
      'Cancel',
      'mpe-ra-help-action mpe-ra-classroom-cancel',
    );
    var open = makeHelpButton(
      'classroomOpen',
      'Open',
      'mpe-ra-help-action mpe-ra-classroom-open',
    );
    var cont = makeHelpButton(
      'classroomContinue',
      'Continue',
      'mpe-ra-help-action mpe-ra-classroom-continue',
    );
    var retry = makeHelpButton(
      'classroomRetry',
      'Retry',
      'mpe-ra-help-action mpe-ra-classroom-retry',
    );
    var another = makeHelpButton(
      'classroomAnother',
      'Build another',
      'mpe-ra-help-action mpe-ra-classroom-another',
    );
    var build = makeHelpButton(
      'classroomBuild',
      'Build',
      'mpe-ra-help-action mpe-ra-classroom-build',
    );
    footer.appendChild(cancel);
    footer.appendChild(open);
    footer.appendChild(cont);
    footer.appendChild(retry);
    footer.appendChild(another);
    footer.appendChild(build);

    sheet.appendChild(head);
    sheet.appendChild(scroll);
    sheet.appendChild(footer);

    return {
      root: sheet,
      details: details,
      close: close,
      scroll: scroll,
      path: path,
      quote: quote,
      form: form,
      lever: lever,
      rows: rows,
      size: size,
      note: note,
      persona: persona,
      audience: audience,
      engine: engine,
      sending: sending,
      sendingLine: sendingLine,
      links: links,
      modules: modules,
      moduleRows: moduleRows,
      card: card,
      cardTitle: cardTitle,
      chapters: chapters,
      elapsed: elapsed,
      error: error,
      footer: footer,
      cancel: cancel,
      open: open,
      cont: cont,
      retry: retry,
      another: another,
      build: build,
    };
  }

  /** §12.2 — the Module sheet of a module preview. */
  function makeModuleSheet() {
    var sheet = document.createElement('div');
    sheet.className = 'mpe-ra-ui mpe-ra-module';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'This module');
    sheet.setAttribute('tabindex', '-1');
    sheet.hidden = true;

    var head = document.createElement('div');
    head.className = 'mpe-ra-module-head';
    var title = document.createElement('span');
    title.className = 'mpe-ra-module-title';
    title.textContent = 'This module';
    var details = document.createElement('span');
    details.className = 'mpe-ra-note-details mpe-ra-module-details';
    details.setAttribute('role', 'status');
    details.setAttribute('aria-live', 'polite');
    var close = makeIconButton(
      'moduleClose',
      'Close the module sheet',
      'mpe-ra-bar-btn mpe-ra-sheet-close',
      'close',
    );
    head.appendChild(title);
    head.appendChild(details);
    head.appendChild(close);

    var from = document.createElement('p');
    from.className = 'mpe-ra-module-from';
    from.hidden = true;
    var moduleTitle = document.createElement('p');
    moduleTitle.className = 'mpe-ra-classroom-card-title mpe-ra-module-name';
    var rows = document.createElement('div');
    rows.className = 'mpe-ra-classroom-chapters mpe-ra-module-rows';
    rows.setAttribute('role', 'list');
    var error = document.createElement('p');
    error.className = 'mpe-ra-classroom-error mpe-ra-module-error';
    error.hidden = true;

    var footer = document.createElement('div');
    footer.className = 'mpe-ra-module-footer';
    var cont = makeHelpButton(
      'moduleContinue',
      'Continue',
      'mpe-ra-help-action mpe-ra-module-continue',
    );
    var cancel = makeHelpButton(
      'moduleCancel',
      'Cancel',
      'mpe-ra-help-action mpe-ra-module-cancel',
    );
    var source = makeHelpButton(
      'moduleOpenSource',
      'Open the source passage',
      'mpe-ra-help-action mpe-ra-module-source',
    );
    var folder = makeHelpButton(
      'moduleOpenFolder',
      'Open module folder',
      'mpe-ra-help-action mpe-ra-module-folder',
    );
    // 13 §11.4 — no dialog: the chip's Undo is the safety.
    var remove = makeHelpButton(
      'moduleDelete',
      'Delete module',
      'mpe-ra-help-action mpe-ra-module-delete',
    );
    footer.appendChild(cont);
    footer.appendChild(cancel);
    footer.appendChild(source);
    footer.appendChild(folder);
    footer.appendChild(remove);

    sheet.appendChild(head);
    sheet.appendChild(from);
    sheet.appendChild(moduleTitle);
    sheet.appendChild(rows);
    sheet.appendChild(error);
    sheet.appendChild(footer);
    return {
      root: sheet,
      details: details,
      close: close,
      from: from,
      name: moduleTitle,
      rows: rows,
      error: error,
      cont: cont,
      cancel: cancel,
      source: source,
      folder: folder,
      remove: remove,
    };
  }

  // ----------------------------------------------------- the chapter rows

  function chapterGlyphName(state) {
    if (state.status === 'done') {
      return state.flagged && state.flagged.length ? 'flag' : 'check';
    }
    if (state.status === 'writing') {
      return 'loading';
    }
    if (state.status === 'failed') {
      return 'warning';
    }
    return 'circle';
  }

  function chapterRowState(state) {
    if (state.status === 'done' && state.flagged && state.flagged.length) {
      return 'flagged';
    }
    return state.status || 'queued';
  }

  /** One row per planned chapter with its state glyph (§5.4, §12.2). */
  function renderChapterRows(container, chapters) {
    container.innerHTML = '';
    for (var i = 0; i < chapters.length; i++) {
      var state = chapters[i] || {};
      var row = document.createElement('div');
      row.className = 'mpe-ra-chapter-row';
      row.setAttribute('role', 'listitem');
      row.setAttribute('data-state', chapterRowState(state));
      var glyph = document.createElement('span');
      glyph.className = 'mpe-ra-chapter-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = ICONS[chapterGlyphName(state)];
      var text = document.createElement('span');
      text.className = 'mpe-ra-chapter-title';
      text.textContent = (state.n ? state.n + '. ' : '') + (state.title || '');
      var stateText =
        state.status === 'done'
          ? state.flagged && state.flagged.length
            ? 'done, flagged: ' + state.flagged.join(', ')
            : 'done'
          : state.status === 'writing'
            ? 'being written'
            : state.status === 'failed'
              ? 'failed'
              : 'queued';
      row.setAttribute('title', stateText);
      row.setAttribute('aria-label', text.textContent + ' (' + stateText + ')');
      row.appendChild(glyph);
      row.appendChild(text);
      container.appendChild(row);
    }
  }

  function progressElapsedSeconds() {
    var progress = classroom.progress;
    if (!progress) {
      return 0;
    }
    var base = typeof progress.elapsedMs === 'number' ? progress.elapsedMs : 0;
    return Math.max(
      0,
      Math.round((base + (Date.now() - classroom.progressAt)) / 1000),
    );
  }

  function doneCount(chapters) {
    var count = 0;
    for (var i = 0; i < chapters.length; i++) {
      if (chapters[i] && chapters[i].status === 'done') {
        count++;
      }
    }
    return count;
  }

  /** The details chip and the message line for one progress state (§5.2, §12.2). */
  function progressChipText(progress) {
    if (!progress) {
      return '';
    }
    var chapters = Array.isArray(progress.chapters) ? progress.chapters : [];
    var done = doneCount(chapters);
    if (progress.status === 'queued') {
      return 'Waiting: another module is being written';
    }
    if (progress.status === 'planning') {
      return 'Planning the module…';
    }
    if (progress.status === 'writing') {
      if (progress.chapter) {
        return 'Writing chapter ' + progress.chapter + ' of ' + progress.of;
      }
      // Every chapter is done and the closing write is under way.
      return chapters.length && done === chapters.length
        ? 'Finishing the module…'
        : 'Writing the module…';
    }
    if (progress.status === 'done') {
      return (
        'Ready · ' +
        chapters.length +
        ' chapters · about ' +
        classroomMinutes(progress.words || 0) +
        ' minutes'
      );
    }
    if (progress.status === 'stopped') {
      return 'Stopped after chapter ' + done;
    }
    if (progress.status === 'failed') {
      return 'Failed: ' + (progress.error || 'the build did not finish');
    }
    return '';
  }

  // ------------------------------------------------------- the bar button

  /** §12.2 — the module preview's button: the badge counts the chapters. */
  function syncClassroomBar() {
    if (!barParts || !barParts.classroomButton) {
      return;
    }
    var button = barParts.classroomButton;
    var module = config.classroomModule;
    button.hidden = !module || !config.enabled;
    if (!module) {
      classroom.moduleOpen = false;
      return;
    }
    var progress = classroom.moduleProgress;
    var status = progress ? progress.status : module.status;
    var chapters =
      progress && Array.isArray(progress.chapters)
        ? progress.chapters
        : module.chapters;
    var badge = barParts.classroomBadge;
    badge.classList.remove('is-warning');
    if (status === 'writing' || status === 'planning' || status === 'queued') {
      // The chapter being written over the total (`3/6`), or the count done
      // while nothing is being written yet.
      var writing = null;
      for (var w = 0; w < chapters.length; w++) {
        if (chapters[w] && chapters[w].status === 'writing') {
          writing = chapters[w];
        }
      }
      badge.textContent =
        (writing ? writing.n : doneCount(chapters)) + '/' + chapters.length;
      badge.hidden = false;
    } else if (status === 'stopped' || status === 'failed') {
      badge.innerHTML = ICONS.warning;
      badge.classList.add('is-warning');
      badge.hidden = false;
    } else {
      badge.textContent = '';
      badge.hidden = true;
    }
    button.classList.toggle('is-active', classroom.moduleOpen);
    button.setAttribute(
      'aria-expanded',
      classroom.moduleOpen ? 'true' : 'false',
    );
    var label = classroom.moduleOpen
      ? 'Close the module sheet'
      : CLASSROOM_MODULE_TOOLTIP;
    button.setAttribute('title', label);
    button.setAttribute('aria-label', label);
  }

  // ---------------------------------------------------- the Classroom sheet

  function classroomLinkedPaths() {
    var prepared = classroom.prepared;
    var out = [];
    if (!prepared || !Array.isArray(prepared.linked)) {
      return out;
    }
    for (var i = 0; i < prepared.linked.length; i++) {
      var link = prepared.linked[i];
      if (
        link &&
        typeof link.path === 'string' &&
        !classroom.unticked[link.path]
      ) {
        out.push(link.path);
      }
    }
    return out;
  }

  function renderClassroomForm(sheet) {
    var prepared = classroom.prepared;
    for (var i = 0; i < sheet.rows.length; i++) {
      var level = Number(sheet.rows[i].getAttribute('data-mpe-ra-level'));
      sheet.rows[i].setAttribute(
        'aria-checked',
        level === classroom.level ? 'true' : 'false',
      );
    }
    if (sheet.note.value !== classroom.note) {
      sheet.note.value = classroom.note;
    }
    // The instructor select: the installed personas, the configured one selected.
    var personas =
      prepared && Array.isArray(prepared.personas) ? prepared.personas : [];
    var wanted =
      classroom.personaId ||
      (prepared && prepared.persona ? prepared.persona.id : '');
    var key =
      personas
        .map(function (p) {
          return p.id;
        })
        .join('|') +
      '#' +
      wanted;
    if (sheet.persona.getAttribute('data-key') !== key) {
      sheet.persona.innerHTML = '';
      if (!personas.length) {
        var placeholder = document.createElement('option');
        placeholder.value = wanted || 'max';
        placeholder.textContent = wanted ? wanted : 'Max';
        sheet.persona.appendChild(placeholder);
      }
      for (var p = 0; p < personas.length; p++) {
        var option = document.createElement('option');
        option.value = personas[p].id;
        option.textContent = personas[p].name || personas[p].id;
        if (personas[p].tagline) {
          option.setAttribute('title', personas[p].tagline);
        }
        option.selected = personas[p].id === wanted;
        sheet.persona.appendChild(option);
      }
      sheet.persona.setAttribute('data-key', key);
    }
    if (sheet.audience.value !== classroom.audience) {
      sheet.audience.value = classroom.audience;
    }
    var engineText =
      prepared && prepared.engine
        ? [
            prepared.engine.engine,
            prepared.engine.model,
            prepared.engine.effort,
          ]
            .filter(function (part) {
              return part && part !== 'n/a';
            })
            .join(' · ')
        : helpLabelText();
    sheet.engine.textContent = engineText;
    sheet.engine.setAttribute('title', 'Help model: ' + engineText);
    sheet.engine.setAttribute(
      'aria-label',
      'Help model: ' + engineText + '. Choose another.',
    );

    // Sending: one line, then a checkbox per linked document.
    var linked =
      prepared && Array.isArray(prepared.linked) ? prepared.linked : [];
    if (!prepared) {
      sheet.sendingLine.textContent = 'Preparing…';
      sheet.sendingLine.classList.add('is-skeleton');
      sheet.links.innerHTML = '';
    } else {
      sheet.sendingLine.classList.remove('is-skeleton');
      var words =
        typeof prepared.documentWords === 'number' ? prepared.documentWords : 0;
      var engineName =
        prepared.engine && prepared.engine.engine
          ? prepared.engine.engine
          : 'the engine';
      var ticked = classroomLinkedPaths().length;
      sheet.sendingLine.textContent =
        'Sends this document (' +
        words.toLocaleString() +
        ' words)' +
        (linked.length
          ? ' and ' + ticked + ' linked document' + (ticked === 1 ? '' : 's')
          : '') +
        ' to ' +
        engineName;
      var linksKey = linked
        .map(function (l) {
          return l.path;
        })
        .join('|');
      if (sheet.links.getAttribute('data-key') !== linksKey) {
        sheet.links.innerHTML = '';
        for (var l = 0; l < linked.length; l++) {
          var link = linked[l];
          var label = document.createElement('label');
          label.className = 'mpe-ra-classroom-link';
          var box = document.createElement('input');
          box.className = 'mpe-ra-ui mpe-ra-classroom-link-box';
          box.type = 'checkbox';
          box.setAttribute('data-mpe-ra-path', link.path);
          box.checked = !classroom.unticked[link.path];
          box.addEventListener('change', onClassroomLinkToggle);
          var text = document.createElement('span');
          text.className = 'mpe-ra-classroom-link-text';
          text.textContent =
            (link.title || link.path) +
            ' · ' +
            link.path +
            ' · ' +
            (typeof link.words === 'number'
              ? link.words.toLocaleString()
              : '0') +
            ' words';
          label.appendChild(box);
          label.appendChild(text);
          sheet.links.appendChild(label);
        }
        sheet.links.setAttribute('data-key', linksKey);
      }
    }

    // 13 §6.1 — the size line under the lever.
    renderClassroomSize(sheet);

    // Modules for this document: the host's live list when it has posted one
    // (13 §12.5), else what Prepared carried; a marker's block first.
    var modules = classroomModuleRows();
    sheet.modules.hidden = modules.length === 0;
    var modulesKey = modules
      .map(function (m) {
        var result = classroom.modules.results[m.id];
        return (
          m.id +
          ':' +
          m.status +
          ':' +
          m.done +
          ':' +
          (result ? (result.found ? 'a' : 'o') : '?')
        );
      })
      .join('|');
    if (sheet.moduleRows.getAttribute('data-key') !== modulesKey) {
      sheet.moduleRows.innerHTML = '';
      for (var m = 0; m < modules.length; m++) {
        var summary = modules[m];
        var row = document.createElement('div');
        row.className = 'mpe-ra-classroom-module-row';
        row.setAttribute('role', 'listitem');
        row.setAttribute('data-mpe-ra-module', summary.id);
        var titleText = document.createElement('span');
        titleText.className = 'mpe-ra-classroom-module-title';
        titleText.textContent = summary.title || 'Module';
        var meta = document.createElement('span');
        meta.className = 'mpe-ra-classroom-module-meta';
        var metaParts = [];
        var date = classroomDateText(summary.created);
        if (date) {
          metaParts.push(date);
        }
        metaParts.push(
          summary.chapters + ' chapter' + (summary.chapters === 1 ? '' : 's'),
        );
        meta.textContent = metaParts.join(' · ');
        var badge = document.createElement('span');
        badge.className = 'mpe-ra-notes-badge mpe-ra-classroom-status';
        badge.textContent = summary.status;
        row.appendChild(titleText);
        row.appendChild(meta);
        row.appendChild(badge);
        var result = classroom.modules.results[summary.id];
        if (result && !result.found) {
          var orphan = document.createElement('span');
          orphan.className = 'mpe-ra-notes-badge mpe-ra-classroom-orphan';
          orphan.textContent = 'Not in this version';
          row.appendChild(orphan);
        }
        var openButton = makeHelpButton(
          'classroomOpenModule',
          'Open',
          'mpe-ra-help-action mpe-ra-classroom-open-module',
        );
        openButton.setAttribute('data-mpe-ra-module', summary.id);
        var deleteButton = makeHelpButton(
          'classroomDeleteModule',
          'Delete',
          'mpe-ra-help-action mpe-ra-classroom-delete-module',
        );
        deleteButton.setAttribute('data-mpe-ra-module', summary.id);
        row.appendChild(openButton);
        row.appendChild(deleteButton);
        sheet.moduleRows.appendChild(row);
      }
      sheet.moduleRows.setAttribute('data-key', modulesKey);
    }
  }

  /** The sheet's module rows: the live list, else Prepared's; a marker's block first. */
  function classroomModuleRows() {
    var prepared = classroom.prepared;
    var source = classroom.modules.list.length
      ? classroom.modules.list
      : prepared && Array.isArray(prepared.modules)
        ? prepared.modules
        : [];
    var deleting = classroom.modules.deleting;
    var rows = [];
    for (var i = 0; i < source.length; i++) {
      if (source[i] && deleting.indexOf(source[i].id) < 0) {
        rows.push(source[i]);
      }
    }
    var first = classroom.markerBlockIds;
    if (first && first.length) {
      rows.sort(function (a, b) {
        var ia = first.indexOf(a.id) < 0 ? 1 : 0;
        var ib = first.indexOf(b.id) < 0 ? 1 : 0;
        return ia - ib;
      });
    }
    return rows;
  }

  /** 13 §6.1 — the passage's shape as the sheet sees it: a term or a passage. */
  function classroomShape() {
    var prepared = classroom.prepared;
    if (prepared && prepared.shortTerm === false) {
      return 'passage';
    }
    var text = classroom.passage ? String(classroom.passage.text || '') : '';
    var words = text.trim().split(/\s+/).filter(Boolean).length;
    return words > 0 && words <= core.HELP_TERM_MAX_WORDS ? 'term' : 'passage';
  }

  /** 13 §6.1 — _5 or 6 chapters · about 20 minutes_, from the row and the shape. */
  function renderClassroomSize(sheet) {
    var prepared = classroom.prepared;
    var budgets = prepared && prepared.budgets ? prepared.budgets : null;
    var shape = classroomShape();
    var budget =
      budgets && budgets[shape] ? budgets[shape][classroom.level] : null;
    if (!budget || !Array.isArray(budget.chapters)) {
      sheet.size.hidden = true;
      return;
    }
    var min = budget.chapters[0];
    var max = budget.chapters[1];
    var chapters =
      min === max
        ? min + ' chapter' + (min === 1 ? '' : 's')
        : min + ' or ' + max + ' chapters';
    sheet.size.textContent =
      chapters + ' · about ' + budget.minutes + ' minutes';
    sheet.size.hidden = false;
  }

  function renderClassroomCard(sheet) {
    var progress = classroom.progress;
    var chapters =
      progress && Array.isArray(progress.chapters) ? progress.chapters : [];
    sheet.cardTitle.textContent =
      progress && progress.title ? progress.title : '';
    sheet.cardTitle.hidden = !sheet.cardTitle.textContent;
    renderChapterRows(sheet.chapters, chapters);
    var live =
      progress &&
      (progress.status === 'writing' ||
        progress.status === 'planning' ||
        progress.status === 'queued');
    if (live) {
      sheet.elapsed.textContent =
        progressElapsedSeconds() +
        ' s' +
        (progress.status === 'writing' && progress.chapterTitle
          ? ' · ' + progress.chapterTitle
          : '');
      sheet.elapsed.hidden = false;
    } else {
      sheet.elapsed.hidden = true;
    }
    var failed = progress && progress.status === 'failed';
    sheet.error.textContent = failed
      ? 'Failed: ' + (progress.error || 'the build did not finish')
      : classroom.state === 'error'
        ? classroom.message
        : '';
    sheet.error.hidden = !sheet.error.textContent;
  }

  /** §5.2 — render the sheet from its state; nothing is diffed. */
  function syncClassroomSheet() {
    if (!barParts || !barParts.classroom) {
      return;
    }
    var sheet = barParts.classroom;
    if (!classroom.open) {
      stopClassroomTicker();
      return;
    }
    var state = classroom.state;
    var progress = classroom.progress;
    var prepared = classroom.prepared;

    // The passage, under its heading path.
    var context = classroom.context;
    var crumbs =
      context && Array.isArray(context.breadcrumb) ? context.breadcrumb : [];
    sheet.path.textContent = crumbs.join(' › ');
    sheet.path.hidden = crumbs.length === 0;
    var text = classroom.passage ? String(classroom.passage.text || '') : '';
    var flat = text.replace(/\s+/g, ' ').trim();
    sheet.quote.textContent =
      flat.length > CLASSROOM_PASSAGE_CHARS
        ? flat.slice(0, CLASSROOM_PASSAGE_CHARS).replace(/\s+\S*$/, '') + '…'
        : flat;

    // The details chip.
    var chip = '';
    var chipError = false;
    if (state === 'preparing') {
      chip = 'Preparing…';
    } else if (state === 'ready') {
      chip = prepared
        ? 'This document · ' +
          (typeof prepared.documentWords === 'number'
            ? prepared.documentWords.toLocaleString()
            : '0') +
          ' words'
        : '';
    } else if (state === 'error') {
      chip = classroom.message || 'Something went wrong';
      chipError = true;
    } else {
      chip = progressChipText(progress);
      chipError =
        !!progress &&
        (progress.status === 'failed' || progress.status === 'stopped');
    }
    sheet.details.textContent = chip;
    sheet.details.classList.toggle('is-error', chipError);

    var showForm = state === 'preparing' || state === 'ready';
    sheet.form.hidden = !showForm;
    sheet.card.hidden = showForm;
    if (showForm) {
      renderClassroomForm(sheet);
    } else {
      renderClassroomCard(sheet);
    }

    // The footer, by state.
    var status = progress ? progress.status : '';
    var live =
      status === 'writing' || status === 'planning' || status === 'queued';
    var hasChapter = !!(progress && progress.hasChapter);
    sheet.build.hidden = !showForm;
    setEnabled(sheet.build, state === 'ready');
    sheet.build.setAttribute(
      'title',
      state === 'ready' ? 'Build the module' : 'Preparing',
    );
    sheet.cancel.hidden = !(state === 'building' && live);
    sheet.open.hidden = !(
      (state === 'building' && hasChapter) ||
      (state === 'done' && progress)
    );
    sheet.cont.hidden = !(
      state === 'building' &&
      (status === 'stopped' || status === 'failed')
    );
    sheet.retry.hidden = state !== 'error';
    sheet.another.hidden = !(
      state === 'done' ||
      state === 'error' ||
      (state === 'building' && (status === 'stopped' || status === 'failed'))
    );

    if (state === 'building' && live) {
      startClassroomTicker();
    } else {
      stopClassroomTicker();
    }
  }

  function startClassroomTicker() {
    if (classroom.timer) {
      return;
    }
    classroom.timer = setInterval(function () {
      if (!classroom.open || classroom.state !== 'building') {
        stopClassroomTicker();
        return;
      }
      if (
        barParts &&
        barParts.classroom &&
        !barParts.classroom.elapsed.hidden
      ) {
        barParts.classroom.elapsed.textContent =
          progressElapsedSeconds() +
          ' s' +
          (classroom.progress &&
          classroom.progress.status === 'writing' &&
          classroom.progress.chapterTitle
            ? ' · ' + classroom.progress.chapterTitle
            : '');
      }
    }, CLASSROOM_TICK_MS);
  }

  function stopClassroomTicker() {
    if (classroom.timer) {
      clearInterval(classroom.timer);
      classroom.timer = 0;
    }
  }

  function onClassroomLinkToggle(event) {
    var box = event.target;
    var linkPath =
      box && box.getAttribute ? box.getAttribute('data-mpe-ra-path') : null;
    if (!linkPath) {
      return;
    }
    if (box.checked) {
      delete classroom.unticked[linkPath];
    } else {
      classroom.unticked[linkPath] = true;
    }
    syncClassroomSheet();
  }

  function focusClassroomSheet() {
    if (!barParts || !barParts.classroom) {
      return;
    }
    try {
      barParts.classroom.root.focus();
    } catch (error) {
      /* jsdom and detached nodes */
    }
  }

  function toggleClassroom() {
    if (classroom.open) {
      closeClassroom('button');
      return;
    }
    openClassroom(null, '', null);
  }

  /**
   * §5.1–§5.3 — open the sheet for the passage: the live selection or the
   * one handed over by the help sheet; post Prepare at once.
   */
  function openClassroom(passageOverride, prefillNote, opener) {
    if (!config.enabled || !config.classroomAvailable) {
      return;
    }
    var passage = passageOverride || helpPassage();
    if (!passage) {
      showHint(
        CLASSROOM_HINT_NO_SELECTION,
        currentSelectionRect() || floatRect,
      );
      return;
    }
    ensureBar();
    var context =
      passageOverride && passageOverride.context
        ? passageOverride.context
        : buildHelpContextFor(passage);
    var anchor =
      passageOverride && passageOverride.anchor
        ? passageOverride.anchor
        : noteAnchorForPassage(passage);
    if (!anchor) {
      showHint(
        CLASSROOM_HINT_NO_SELECTION,
        currentSelectionRect() || floatRect,
      );
      return;
    }
    panelDismissed = false;
    closePopovers();
    hideFloat();
    closeHelp('classroom');
    closeNote('classroom');
    closeNotesList('classroom');
    closeModuleSheet('classroom');

    classroom.open = true;
    classroom.state = 'preparing';
    classroom.passage = {
      text: passage.text,
      els: passage.els ? passage.els.slice() : [],
    };
    classroom.context = context;
    classroom.anchor = anchor;
    classroom.headingId = nearestHeadingId(passage.els);
    classroom.prepared = null;
    classroom.progress = null;
    classroom.moduleId = null;
    classroom.level = CLASSROOM_DEFAULT_LEVEL;
    classroom.note = (prefillNote || '').slice(0, CLASSROOM_NOTE_MAX);
    classroom.personaId = '';
    classroom.audience = '';
    classroom.unticked = Object.create(null);
    classroom.message = '';
    classroom.opener = opener || null;
    classroom.markerBlockIds = null;
    classroom.requestId = nextRequestId();
    barParts.classroom.root.hidden = false;
    barParts.classroom.persona.removeAttribute('data-key');
    barParts.classroom.links.removeAttribute('data-key');
    barParts.classroom.moduleRows.removeAttribute('data-key');
    applyThemeAttributes();
    syncClassroomSheet();
    syncHelpButton();
    showBar('');
    post('readAloudClassroomPrepare', [
      sourceUri,
      classroom.requestId,
      classroomFieldsFrom(context),
    ]);
    focusClassroomSheet();
  }

  /** §5.5 — _Teach me this_: the help passage, its material and its anchor. */
  function openClassroomFromHelp() {
    if (!config.classroomAvailable || help.state !== 'ready' || !help.context) {
      return;
    }
    var override = {
      text: help.context.passage,
      els: [],
      context: help.context,
      anchor: help.anchor,
    };
    var question = help.question || (help.last && help.last.question) || '';
    closeHelp('classroom');
    openClassroom(override, question, null);
  }

  /** §5.4 step 6 — closing never cancels a build. */
  function closeClassroom(reason) {
    if (!classroom.open) {
      return;
    }
    stopClassroomTicker();
    var opener = classroom.opener;
    classroom.open = false;
    classroom.opener = null;
    classroom.requestId = null;
    if (barParts && barParts.classroom) {
      barParts.classroom.root.hidden = true;
    }
    classroom.markerBlockIds = null;
    syncModuleMarkerStates();
    syncHelpButton();
    armPanelIdle();
    if (reason !== 'help' && reason !== 'note' && reason !== 'notes list') {
      var target = opener && opener.isConnected ? opener : null;
      if (target) {
        try {
          target.focus();
        } catch (error) {
          /* the panel may be going away */
        }
      }
    }
  }

  /** §5.4 step 1 — the Build payload. */
  function buildClassroom() {
    if (
      !classroom.open ||
      classroom.state !== 'ready' ||
      !classroom.passage ||
      !classroom.context ||
      !classroom.anchor
    ) {
      return;
    }
    var prepared = classroom.prepared;
    var personaId =
      classroom.personaId ||
      (prepared && prepared.persona && prepared.persona.id) ||
      'max';
    var requestId = nextRequestId();
    classroom.requestId = requestId;
    classroom.state = 'building';
    classroom.progress = null;
    classroom.progressAt = Date.now();
    classroom.moduleId = null;
    classroom.message = '';
    post('readAloudClassroomBuild', [
      sourceUri,
      requestId,
      classroom.passage.text,
      classroomFieldsFrom(classroom.context),
      classroom.anchor,
      {
        level: classroom.level,
        readerNote: classroom.note.slice(0, CLASSROOM_NOTE_MAX),
        persona: personaId,
        audience: classroom.audience.slice(0, CLASSROOM_AUDIENCE_MAX),
        linked: classroomLinkedPaths(),
        headingId: classroom.headingId,
      },
    ]);
    syncClassroomSheet();
  }

  function cancelClassroomBuild(reason) {
    if (classroom.moduleId) {
      post('readAloudClassroomCancel', [
        sourceUri,
        classroom.moduleId,
        reason || 'sheet',
      ]);
    }
  }

  function classroomBuildAnother() {
    classroom.state = classroom.prepared ? 'ready' : 'preparing';
    classroom.progress = null;
    classroom.moduleId = null;
    classroom.message = '';
    if (!classroom.prepared && classroom.context) {
      classroom.requestId = nextRequestId();
      post('readAloudClassroomPrepare', [
        sourceUri,
        classroom.requestId,
        classroomFieldsFrom(classroom.context),
      ]);
    }
    syncClassroomSheet();
  }

  // -------------------------------------------------------- the Module sheet

  function toggleModuleSheet() {
    if (!config.classroomModule) {
      showHint(CLASSROOM_NOT_MODULE_HINT, null);
      return;
    }
    if (classroom.moduleOpen) {
      closeModuleSheet('button');
      return;
    }
    openModuleSheet(
      barParts && barParts.classroomButton ? barParts.classroomButton : null,
    );
  }

  function openModuleSheet(opener) {
    if (!config.enabled || !config.classroomModule) {
      return;
    }
    ensureBar();
    closePopovers();
    closeHelp('module');
    closeNote('module');
    closeNotesList('module');
    closeClassroom('module');
    hideFloat();
    panelDismissed = false;
    classroom.moduleOpen = true;
    classroom.moduleOpener = opener || null;
    barParts.module.root.hidden = false;
    syncModuleSheet();
    syncClassroomBar();
    syncHelpButton();
    showBar(barParts.status.textContent);
    try {
      barParts.module.root.focus();
    } catch (error) {
      /* jsdom and detached nodes */
    }
  }

  function closeModuleSheet(reason) {
    if (!classroom.moduleOpen) {
      return;
    }
    var opener = classroom.moduleOpener;
    classroom.moduleOpen = false;
    classroom.moduleOpener = null;
    if (barParts && barParts.module) {
      barParts.module.root.hidden = true;
    }
    syncClassroomBar();
    syncHelpButton();
    armPanelIdle();
    if (
      reason !== 'help' &&
      reason !== 'note' &&
      reason !== 'notes list' &&
      reason !== 'classroom'
    ) {
      var target =
        opener && opener.isConnected
          ? opener
          : barParts &&
              barParts.classroomButton &&
              !barParts.classroomButton.hidden
            ? barParts.classroomButton
            : null;
      if (target) {
        try {
          target.focus();
        } catch (error) {
          /* the panel may be going away */
        }
      }
    }
  }

  /** §12.2 — the Module sheet from the config and the last progress. */
  function syncModuleSheet() {
    if (!barParts || !barParts.module) {
      return;
    }
    var sheet = barParts.module;
    var module = config.classroomModule;
    if (!module) {
      if (classroom.moduleOpen) {
        closeModuleSheet('not a module');
      }
      return;
    }
    if (!classroom.moduleOpen) {
      return;
    }
    var progress = classroom.moduleProgress;
    var status = progress ? progress.status : module.status;
    var chapters =
      progress && Array.isArray(progress.chapters)
        ? progress.chapters
        : module.chapters;
    var words =
      progress && typeof progress.words === 'number' ? progress.words : 0;
    var chip;
    if (progress) {
      chip = progressChipText(progress);
    } else if (status === 'done') {
      chip =
        'Ready · ' +
        chapters.length +
        ' chapters' +
        (words ? ' · about ' + classroomMinutes(words) + ' minutes' : '');
    } else if (status === 'stopped') {
      chip = 'Stopped after chapter ' + doneCount(chapters);
    } else if (status === 'failed') {
      chip = 'Failed';
    } else {
      chip =
        'Writing chapter ' +
        (doneCount(chapters) + 1) +
        ' of ' +
        chapters.length;
    }
    sheet.details.textContent = chip;
    sheet.details.classList.toggle(
      'is-error',
      status === 'stopped' || status === 'failed',
    );
    var from = module.documentTitle
      ? 'From "' +
        module.documentTitle +
        '"' +
        (module.documentHeading
          ? ', under "' + module.documentHeading + '"'
          : '')
      : module.documentPath
        ? 'From ' + module.documentPath
        : '';
    sheet.from.textContent = from;
    sheet.from.hidden = !from;
    sheet.name.textContent = (progress && progress.title) || module.title || '';
    renderChapterRows(sheet.rows, chapters);
    var error = progress && progress.status === 'failed' ? progress.error : '';
    sheet.error.textContent = error ? 'Failed: ' + error : '';
    sheet.error.hidden = !error;
    var live =
      status === 'writing' || status === 'planning' || status === 'queued';
    sheet.cont.hidden = !(status === 'stopped' || status === 'failed');
    sheet.cancel.hidden = !live;
  }

  // ------------------------------------------------------ host -> classroom

  function onClassroomPrepared(message) {
    if (!classroom.open || message.requestId !== classroom.requestId) {
      return;
    }
    classroom.prepared = {
      persona: message.persona || null,
      personas: Array.isArray(message.personas) ? message.personas : [],
      audience: typeof message.audience === 'string' ? message.audience : '',
      documentWords:
        typeof message.documentWords === 'number' ? message.documentWords : 0,
      linked: Array.isArray(message.linked) ? message.linked : [],
      modules: Array.isArray(message.modules) ? message.modules : [],
      engine: message.engine || null,
      // 13 §6.1 — the sizes per shape and level, for the size line.
      budgets:
        message.budgets && typeof message.budgets === 'object'
          ? message.budgets
          : null,
      shortTerm: message.shortTerm !== false,
    };
    if (!classroom.personaId && message.persona && message.persona.id) {
      classroom.personaId = message.persona.id;
    }
    if (!classroom.audience) {
      classroom.audience = classroom.prepared.audience.slice(
        0,
        CLASSROOM_AUDIENCE_MAX,
      );
    }
    if (message.building && typeof message.building === 'object') {
      // A build is running for this document: show its card again (§5.4 step 6).
      classroom.state = 'building';
      classroom.progress = message.building;
      classroom.progressAt = Date.now();
      classroom.moduleId = message.building.moduleId || null;
    } else if (classroom.state === 'preparing') {
      classroom.state = 'ready';
    }
    syncClassroomSheet();
  }

  /** §5.4 step 3, §12.2 — the whole state, for the sheet and for the module preview. */
  function onClassroomProgress(message) {
    if (!message || typeof message.moduleId !== 'string') {
      return;
    }
    var mine =
      typeof message.documentUri === 'string' &&
      sourceUri &&
      message.documentUri === sourceUri;
    if (mine) {
      noteModuleProgress(message);
      var tracking =
        classroom.moduleId === message.moduleId ||
        (classroom.state === 'building' && classroom.moduleId === null);
      if (tracking) {
        classroom.moduleId = message.moduleId;
        classroom.progress = message;
        classroom.progressAt = Date.now();
        if (message.status === 'done') {
          classroom.state = 'done';
        } else {
          classroom.state = 'building';
        }
        syncClassroomSheet();
      } else if (classroom.open && classroom.state === 'ready') {
        // Another module of this document finished or moved: the rows will
        // refresh on the next Prepare; nothing to do now.
      }
    }
    var module = config.classroomModule;
    if (module && module.id === message.moduleId) {
      classroom.moduleProgress = message;
      config.classroomModule.status = message.status;
      if (Array.isArray(message.chapters)) {
        config.classroomModule.chapters = message.chapters;
      }
      if (typeof message.title === 'string' && message.title) {
        config.classroomModule.title = message.title;
      }
      syncClassroomBar();
      syncModuleSheet();
      // The message line (§12.2): in the status slot's existing style.
      if (message.status === 'writing' && message.chapter) {
        showBar(
          'Chapter ' +
            message.chapter +
            ' of ' +
            message.of +
            ' is being written',
        );
      } else if (message.status === 'planning') {
        showBar('Planning the module…');
      } else if (message.status === 'stopped') {
        showBar(
          'Stopped after chapter ' +
            doneCount(message.chapters || []) +
            ' · Continue in the module sheet',
        );
      } else if (message.status === 'failed') {
        showBar('Failed: ' + (message.error || 'the build did not finish'));
      } else if (message.status === 'done' && record.state === 'idle') {
        showBar('');
      }
    }
  }

  function onClassroomError(message) {
    var text =
      typeof message.message === 'string' && message.message
        ? message.message
        : 'The classroom could not be built.';
    if (
      classroom.open &&
      typeof message.requestId === 'string' &&
      message.requestId === classroom.requestId
    ) {
      classroom.state = 'error';
      classroom.message = text;
      syncClassroomSheet();
      showBar(text);
      return;
    }
    if (
      classroom.open &&
      classroom.moduleId &&
      message.moduleId === classroom.moduleId
    ) {
      // The progress message carries the failure; the chip is enough.
      showBar(text);
      return;
    }
    showNoteChip(text, NOTE_ERROR_CHIP_MS, null);
  }

  // --------------------------------------------------------- the reveal

  function flashBlock(el) {
    if (!el || !el.classList) {
      return;
    }
    classroom.flashTimer = clearTimer(classroom.flashTimer);
    mutateSilently(function () {
      el.classList.add('mpe-ra-flash');
    });
    classroom.flashTimer = setTimeout(function () {
      classroom.flashTimer = 0;
      mutateSilently(function () {
        el.classList.remove('mpe-ra-flash');
      });
    }, CLASSROOM_FLASH_MS);
  }

  /** §12.4 — _Open the source passage_: anchor, centre, flash; or the chip. */
  function revealAnchor(message) {
    if (
      !root ||
      !message ||
      !message.anchor ||
      typeof message.anchor !== 'object'
    ) {
      return;
    }
    var found = null;
    try {
      var results = core.anchorNotes(root, [
        {
          id:
            typeof message.moduleId === 'string' ? message.moduleId : 'module',
          anchor: message.anchor,
        },
      ]);
      found = results && results.length ? results[0] : null;
    } catch (error) {
      found = null;
    }
    if (found && found.found && found.el) {
      scrollBlockIntoView(found.el);
      flashBlock(found.el);
      return;
    }
    showNoteChip(CLASSROOM_ANCHOR_MISSING, NOTE_CHIP_MS, null);
  }

  // ------------------------------------------------------------- actions

  function handleClassroomAction(action, element) {
    if (action === 'floatClassroom') {
      openClassroom(null, '', element || null);
      return true;
    }
    if (action === 'classroomClose') {
      closeClassroom('close');
      return true;
    }
    if (action === 'classroomLevel') {
      var level = element
        ? Number(element.getAttribute('data-mpe-ra-level'))
        : 0;
      if (level === 1 || level === 2 || level === 3) {
        classroom.level = level;
        syncClassroomSheet();
      }
      return true;
    }
    if (action === 'classroomBuild') {
      buildClassroom();
      return true;
    }
    if (action === 'classroomCancel') {
      cancelClassroomBuild('sheet');
      return true;
    }
    if (action === 'classroomOpen') {
      if (classroom.moduleId) {
        post('readAloudClassroomOpen', [sourceUri, classroom.moduleId]);
      }
      return true;
    }
    if (action === 'classroomOpenModule') {
      var id = element ? element.getAttribute('data-mpe-ra-module') : null;
      if (id) {
        post('readAloudClassroomOpen', [sourceUri, id]);
      }
      return true;
    }
    if (action === 'classroomContinue') {
      if (classroom.moduleId) {
        post('readAloudClassroomContinue', [sourceUri, classroom.moduleId]);
      }
      return true;
    }
    if (action === 'classroomRetry') {
      classroom.state = 'ready';
      classroom.message = '';
      if (!classroom.prepared) {
        classroom.state = 'preparing';
        classroom.requestId = nextRequestId();
        post('readAloudClassroomPrepare', [
          sourceUri,
          classroom.requestId,
          classroomFieldsFrom(classroom.context),
        ]);
        syncClassroomSheet();
        return true;
      }
      buildClassroom();
      return true;
    }
    if (action === 'classroomAnother') {
      classroomBuildAnother();
      return true;
    }
    if (action === 'classroomModule') {
      closePopovers();
      toggleModuleSheet();
      return true;
    }
    if (action === 'moduleClose') {
      closeModuleSheet('close');
      return true;
    }
    if (action === 'moduleContinue') {
      if (config.classroomModule) {
        post('readAloudClassroomContinue', [
          sourceUri,
          config.classroomModule.id,
        ]);
      }
      return true;
    }
    if (action === 'moduleCancel') {
      if (config.classroomModule) {
        post('readAloudClassroomCancel', [
          sourceUri,
          config.classroomModule.id,
          'module sheet',
        ]);
      }
      return true;
    }
    if (action === 'moduleOpenSource') {
      if (config.classroomModule) {
        post('readAloudClassroomOpenSource', [
          sourceUri,
          config.classroomModule.id,
        ]);
      }
      return true;
    }
    if (action === 'moduleOpenFolder') {
      post('readAloudClassroomOpenFolder', [sourceUri]);
      return true;
    }
    // 13 §12.5 — the marker: one module opens, several open the sheet.
    if (action === 'classroomMarker') {
      var block = element ? element.parentElement : null;
      var ids = moduleIdsOnBlock(block);
      if (ids.length === 1) {
        post('readAloudClassroomOpen', [sourceUri, ids[0]]);
      } else if (ids.length > 1) {
        openClassroomForBlock(block, ids, element);
      }
      return true;
    }
    // 13 §11.4 — Delete from a sheet row or the Module sheet.
    if (action === 'classroomDeleteModule') {
      deleteModule(element ? element.getAttribute('data-mpe-ra-module') : null);
      return true;
    }
    if (action === 'moduleDelete') {
      if (config.classroomModule) {
        deleteModule(config.classroomModule.id);
      }
      return true;
    }
    return false;
  }

  // ------------------------------------------------- the module marker

  /** 13 §12.5 — the host's list of this document's modules. */
  function onClassroomModules(message) {
    if (
      typeof message.sourceUri === 'string' &&
      sourceUri &&
      message.sourceUri !== sourceUri
    ) {
      return;
    }
    var previousDeleting = classroom.modules.deleting.slice();
    var list = Array.isArray(message.modules) ? message.modules : [];
    classroom.modules.list = [];
    classroom.modules.byId = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var summary = list[i];
      if (
        !summary ||
        typeof summary !== 'object' ||
        typeof summary.id !== 'string' ||
        !summary.anchor ||
        typeof summary.anchor !== 'object'
      ) {
        continue;
      }
      if (!Array.isArray(summary.headings)) {
        summary.headings = [];
      }
      classroom.modules.list.push(summary);
      classroom.modules.byId[summary.id] = summary;
    }
    classroom.modules.deleting = Array.isArray(message.deleting)
      ? message.deleting.filter(function (id) {
          return typeof id === 'string';
        })
      : [];
    if (message.deleteMode === 'permanent' || message.deleteMode === 'trash') {
      classroom.modules.deleteMode = message.deleteMode;
    }
    // A delete that started elsewhere shows the Undo chip here too.
    for (var d = 0; d < classroom.modules.deleting.length; d++) {
      var id = classroom.modules.deleting[d];
      if (previousDeleting.indexOf(id) < 0 && notes.chipNoteId !== id) {
        showNoteChip(deleteModuleChipText(), NOTE_UNDO_MS, id, 'module');
      }
    }
    if (
      notes.chipNoteId &&
      barParts &&
      barParts.noteChip &&
      barParts.noteChip.undo.getAttribute('data-mpe-ra-kind') === 'module' &&
      classroom.modules.deleting.indexOf(notes.chipNoteId) < 0
    ) {
      hideNoteChip();
    }
    if (barParts && barParts.classroom) {
      barParts.classroom.moduleRows.removeAttribute('data-key');
    }
    anchorPass();
    syncClassroomSheet();
  }

  function deleteModuleChipText() {
    return classroom.modules.deleteMode === 'permanent'
      ? CLASSROOM_DELETE_PERMANENT_CHIP
      : CLASSROOM_DELETE_TRASH_CHIP;
  }

  /** The list as `core.anchorNotes` wants it: id, anchor, headings. */
  function modulesAsAnchorNotes() {
    var out = [];
    for (var i = 0; i < classroom.modules.list.length; i++) {
      var summary = classroom.modules.list[i];
      if (classroom.modules.deleting.indexOf(summary.id) >= 0) {
        continue;
      }
      out.push({
        id: summary.id,
        created: summary.created,
        headings: summary.headings,
        passage: summary.anchor.exact,
        anchor: summary.anchor,
        context: { enclosing: '', before: '', after: '' },
      });
    }
    return out;
  }

  /** 13 §12.5 — anchor every module and draw its marker, inside `anchorPass`. */
  function moduleMarkersPass() {
    var show =
      config.enabled && config.classroomAvailable && config.classroomMarker;
    var wanted = show ? modulesAsAnchorNotes() : [];
    if (!wanted.length) {
      classroom.modules.results = Object.create(null);
      clearModuleMarkers();
      return;
    }
    var results = core.anchorNotes(root, wanted);
    classroom.modules.results = Object.create(null);
    for (var i = 0; i < results.length; i++) {
      classroom.modules.results[results[i].noteId] = results[i];
    }
    mutateSilently(function () {
      drawModuleMarkers(results);
    });
  }

  function moduleStateOf(summary) {
    var status = summary && summary.status ? summary.status : 'done';
    if (status === 'writing' || status === 'planning' || status === 'queued') {
      return 'writing';
    }
    if (status === 'stopped' || status === 'failed') {
      return 'stopped';
    }
    return 'done';
  }

  /** One marker per module-bearing block, under a note marker when both are there. */
  function drawModuleMarkers(results) {
    var groups = new Map();
    var anyFound = false;
    for (var i = 0; i < results.length; i++) {
      var result = results[i];
      if (!result.found || !result.el) {
        continue;
      }
      anyFound = true;
      var list = groups.get(result.el);
      if (!list) {
        list = [];
        groups.set(result.el, list);
      }
      list.push(result);
    }
    classroom.modules.anyFound = anyFound;
    classroom.modules.markers.forEach(function (marker, el) {
      if (!groups.has(el) || !el.isConnected) {
        if (marker.parentNode) {
          marker.parentNode.removeChild(marker);
        }
        classroom.modules.markers.delete(el);
        classroom.modules.markerResults.delete(el);
      }
    });
    groups.forEach(function (list, el) {
      // Newest first: the marker names and opens the latest module.
      list.sort(function (a, b) {
        var ca = classroom.modules.byId[a.noteId]
          ? classroom.modules.byId[a.noteId].created
          : '';
        var cb = classroom.modules.byId[b.noteId]
          ? classroom.modules.byId[b.noteId].created
          : '';
        return ca < cb ? 1 : ca > cb ? -1 : 0;
      });
      var first = list[0];
      var marker = classroom.modules.markers.get(el);
      if (!marker || marker.parentNode !== el) {
        marker = null;
        for (var c = 0; c < el.children.length; c++) {
          var child = el.children[c];
          if (
            child.classList &&
            child.classList.contains('mpe-ra-classroom-marker')
          ) {
            marker = child;
            break;
          }
        }
        if (!marker) {
          marker = document.createElement('button');
          marker.type = 'button';
          marker.className = 'mpe-ra-ui mpe-ra-classroom-marker';
          marker.setAttribute('data-mpe-ra-action', 'classroomMarker');
          marker.innerHTML = ICONS.classroom;
          el.appendChild(marker);
        }
        classroom.modules.markers.set(el, marker);
      }
      el.classList.add('mpe-ra-block');
      marker.setAttribute('data-mpe-ra-module', first.noteId);
      marker.setAttribute(
        'data-mpe-ra-modules',
        list
          .map(function (r) {
            return r.noteId;
          })
          .join(' '),
      );
      classroom.modules.markerResults.set(el, first);
      syncModuleMarker(marker, list);
      positionMarker(marker, first);
      // Under a note marker on the same block (13 §12.5).
      var noteMarker = notes.markers.get(el);
      if (noteMarker && noteMarker.parentNode === el) {
        marker.classList.add('is-below-note');
        var base = noteMarker.style.top || '0.1em';
        marker.setAttribute('data-mpe-ra-below', base);
        try {
          marker.style.top =
            'calc(' + base + ' + ' + CLASSROOM_MARKER_BELOW_NOTE + ')';
        } catch (error) {
          /* an engine that refuses calc() keeps the class's own offset */
        }
      } else {
        marker.classList.remove('is-below-note');
        marker.removeAttribute('data-mpe-ra-below');
      }
    });
    syncGutter();
  }

  /** The tooltip, the count badge and the state classes of one marker. */
  function syncModuleMarker(marker, list) {
    var first = classroom.modules.byId[list[0].noteId];
    var title = first && first.title ? first.title : 'Classroom module';
    var count = list.length;
    var tip = count > 1 ? title + ' · ' + count + ' modules' : title;
    marker.setAttribute('title', tip);
    marker.setAttribute('aria-label', tip);
    var countBadge = marker.querySelector('.mpe-ra-classroom-count');
    if (count > 1) {
      if (!countBadge) {
        countBadge = document.createElement('span');
        countBadge.className = 'mpe-ra-classroom-count';
        countBadge.setAttribute('aria-hidden', 'true');
        marker.appendChild(countBadge);
      }
      if (countBadge.textContent !== String(count)) {
        countBadge.textContent = String(count);
      }
    } else if (countBadge) {
      marker.removeChild(countBadge);
    }
    var writing = null;
    var stopped = false;
    for (var i = 0; i < list.length; i++) {
      var summary = classroom.modules.byId[list[i].noteId];
      var state = moduleStateOf(summary);
      if (state === 'writing' && !writing) {
        writing = summary;
      }
      if (state === 'stopped') {
        stopped = true;
      }
    }
    var progressBadge = marker.querySelector('.mpe-ra-classroom-progress');
    if (writing) {
      if (!progressBadge) {
        progressBadge = document.createElement('span');
        progressBadge.className = 'mpe-ra-classroom-progress';
        progressBadge.setAttribute('aria-hidden', 'true');
        marker.appendChild(progressBadge);
      }
      var text =
        (typeof writing.writing === 'number' && writing.writing
          ? writing.writing
          : writing.done || 0) +
        '/' +
        (writing.chapters || 0);
      if (progressBadge.textContent !== text) {
        progressBadge.textContent = text;
      }
    } else if (progressBadge) {
      marker.removeChild(progressBadge);
    }
    marker.classList.toggle('is-writing', !!writing);
    marker.classList.toggle('is-stopped', stopped && !writing);
    var active =
      classroom.open &&
      !!classroom.markerBlockIds &&
      classroom.markerBlockIds.indexOf(list[0].noteId) >= 0;
    marker.classList.toggle('is-active', active);
  }

  /** A progress message moves a module's marker badge (13 §12.5). */
  function noteModuleProgress(message) {
    var summary = classroom.modules.byId[message.moduleId];
    if (!summary) {
      return;
    }
    summary.status = message.status || summary.status;
    if (typeof message.of === 'number' && message.of) {
      summary.chapters = message.of;
    }
    if (Array.isArray(message.chapters)) {
      summary.done = doneCount(message.chapters);
    }
    summary.writing = typeof message.chapter === 'number' ? message.chapter : 0;
    syncModuleMarkerStates();
  }

  function syncModuleMarkerStates() {
    classroom.modules.markers.forEach(function (marker) {
      var ids = (marker.getAttribute('data-mpe-ra-modules') || '')
        .split(' ')
        .filter(Boolean);
      var list = [];
      for (var i = 0; i < ids.length; i++) {
        var result = classroom.modules.results[ids[i]];
        if (result) {
          list.push(result);
        }
      }
      if (list.length) {
        mutateSilently(function () {
          syncModuleMarker(marker, list);
        });
      }
    });
  }

  function clearModuleMarkers() {
    classroom.modules.markers.forEach(function (marker) {
      if (marker.parentNode) {
        marker.parentNode.removeChild(marker);
      }
    });
    classroom.modules.markers.clear();
    classroom.modules.markerResults.clear();
    classroom.modules.anyFound = false;
    syncGutter();
  }

  /** The ids of the modules anchored on `el`, newest first. */
  function moduleIdsOnBlock(el) {
    var ids = [];
    if (!el) {
      return ids;
    }
    var marker = classroom.modules.markers.get(el);
    if (!marker) {
      return ids;
    }
    return (marker.getAttribute('data-mpe-ra-modules') || '')
      .split(' ')
      .filter(Boolean);
  }

  /** 13 §12.5 — several modules on one block: the sheet, that block's rows first. */
  function openClassroomForBlock(el, ids, opener) {
    var newest = classroom.modules.byId[ids[0]];
    if (!newest || !el) {
      return;
    }
    var passage = { text: newest.anchor.exact || newest.passage, els: [el] };
    var context;
    try {
      context = buildHelpContextFor(passage);
    } catch (error) {
      context = null;
    }
    if (!context) {
      return;
    }
    openClassroom(
      {
        text: passage.text,
        els: [el],
        context: context,
        anchor: newest.anchor,
      },
      '',
      opener,
    );
    if (classroom.open) {
      classroom.markerBlockIds = ids.slice();
      if (barParts && barParts.classroom) {
        barParts.classroom.moduleRows.removeAttribute('data-key');
      }
      syncClassroomSheet();
      syncModuleMarkerStates();
    }
  }

  /** 13 §11.4 — post the delete and show the chip with Undo at once. */
  function deleteModule(id) {
    if (!id) {
      return;
    }
    post('readAloudClassroomDelete', [sourceUri, id]);
    if (classroom.modules.deleting.indexOf(id) < 0) {
      classroom.modules.deleting = classroom.modules.deleting.concat([id]);
    }
    showNoteChip(deleteModuleChipText(), NOTE_UNDO_MS, id, 'module');
    if (barParts && barParts.classroom) {
      barParts.classroom.moduleRows.removeAttribute('data-key');
    }
    anchorPass();
    syncClassroomSheet();
  }

  function undoModuleDelete(id) {
    if (!id) {
      return;
    }
    post('readAloudClassroomUndoDelete', [sourceUri, id]);
    hideNoteChip();
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
      // A chunk that arrives after the previous block's audio has ended
      // still takes the boundary gap, measured from that end (07 §11.3):
      // whatever is left of it, nothing if the wait already exceeded it.
      var previous = record.current >= 0 ? record.chunks[record.current] : null;
      if (
        previous &&
        record.gapDueAt > 0 &&
        record.chunks[index].blockIndex !== previous.blockIndex
      ) {
        var remaining = record.gapDueAt - Date.now();
        record.gapDueAt = 0;
        startGap(index, remaining);
        return;
      }
      record.gapDueAt = 0;
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
    // 13 §12.5 — read before any apply* below, so a change re-runs the pass.
    var markerBefore = config.classroomMarker;
    var classroomBefore = config.classroomAvailable;
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
    if (typeof message.font === 'string') {
      config.font = core.normalisePlayerFont(message.font);
      applyFontToRoot();
    }
    // The low-strain page (05 §4.4): from Settings, or another preview's
    // sheet, or a Reset — the page follows the way the font does.
    if (typeof message.globalTheme === 'string') {
      config.globalTheme = core.normaliseGlobalTheme(message.globalTheme);
    }
    // Eye strain 2 (07 §15.2): the four fields, the way the page's are.
    if (typeof message.textSize === 'number') {
      config.textSize = core.clampTextSize(message.textSize);
    }
    if (typeof message.wordMarker === 'string') {
      config.wordMarker = core.normaliseWordMarker(message.wordMarker);
    }
    if (typeof message.dimWhileReading === 'boolean') {
      config.dimWhileReading = message.dimWhileReading;
    }
    if (typeof message.panelAutoHide === 'boolean') {
      config.panelAutoHide = message.panelAutoHide;
    }
    applyPage();
    if (typeof message.font === 'string') {
      measureCharEm();
    }
    // A model or effort change re-labels an open sheet at once (§7.1).
    applyHelpConfig(message);
    var decorationBefore = config.notesDecoration;
    var notesBefore = config.notesAvailable;
    applyNotesConfig(message);
    applyClassroomConfig(message);
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
      closeHelp('read aloud disabled');
      closeClassroom('read aloud disabled');
      closeModuleSheet('read aloud disabled');
      removeDecorations();
      dismissBar();
      hideFloat();
      return;
    }
    if (!config.helpAvailable && help.open) {
      closeHelp('help unavailable');
    }
    if (!config.notesAvailable) {
      closeNote('notes unavailable');
      closeNotesList('notes unavailable');
    }
    if (!config.classroomAvailable) {
      closeClassroom('classroom unavailable');
      closeModuleSheet('classroom unavailable');
    }
    if (!wasEnabled) {
      decorate();
      showBar('');
    } else {
      applyThemeAttributes();
      applyClickClass();
    }
    // Dimming or the page may have changed mid-read (07 §8.4), and the
    // auto-hide may have been switched (07 §10).
    applyTiers();
    if (
      decorationBefore !== config.notesDecoration ||
      notesBefore !== config.notesAvailable ||
      markerBefore !== config.classroomMarker ||
      classroomBefore !== config.classroomAvailable
    ) {
      anchorPass();
    }
    armPanelIdle();
    syncSpeedControls();
    syncVolumeControls();
    syncSheet();
    syncHelpSheet();
    syncHelpButton();
    syncNotesBar();
    syncNoteSheet();
    syncNotesList();
    syncClassroomBar();
    syncClassroomSheet();
    syncModuleSheet();
  }

  function handleControl(action, message) {
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
      return;
    }
    // §2 — `Alt+H`, the same thing the panel's ? button does.
    if (action === 'help') {
      toggleHelp();
      return;
    }
    // 12 §5.1, §12, §13.1 — `Alt+N`, `Alt+Shift+N`, Reveal in preview.
    if (action === 'note') {
      saveNoteFromSelection();
      return;
    }
    if (action === 'notesList') {
      toggleNotesList();
      return;
    }
    if (action === 'showNote') {
      if (message && typeof message.noteId === 'string') {
        openNote(message.noteId, null);
      }
      return;
    }
    // 13 §5.1, §12.2, §12.4 — `Alt+C`, `Alt+Shift+C`, Open the source passage.
    if (action === 'classroom') {
      toggleClassroom();
      return;
    }
    if (action === 'classroomModule') {
      toggleModuleSheet();
      return;
    }
    if (action === 'revealAnchor') {
      revealAnchor(message);
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
        handleControl(message.action, message);
        return;
      case 'readAloudNotes':
        onNotesMessage(message);
        return;
      case 'readAloudNoteError':
        onNoteError(message);
        return;
      case 'readAloudClassroomPrepared':
        onClassroomPrepared(message);
        return;
      case 'readAloudClassroomProgress':
        onClassroomProgress(message);
        return;
      case 'readAloudClassroomError':
        onClassroomError(message);
        return;
      case 'readAloudClassroomModules':
        onClassroomModules(message);
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
      case 'readAloudHelpResult':
        onHelpResult(message);
        return;
      case 'readAloudHelpError':
        onHelpError(message);
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
    // The help sheet's body is a reading scope, not chrome: a click in it
    // starts or seeks the help read exactly as a click in the document does
    // (04-help-module §5). It sits inside the panel, which is `.mpe-ra-ui`,
    // so it has to be recognised before the chrome branch below.
    var sheetBody = helpBody();
    var noteSheetBody = noteBody();
    if (
      (sheetBody && sheetBody.contains(element)) ||
      (noteSheetBody && noteSheetBody.contains(element))
    ) {
      event.stopPropagation();
      closePopovers();
      hideFloat();
      maybeClickToRead(event, element);
      return;
    }
    var ui = element.closest('.mpe-ra-ui');
    if (!ui) {
      // A drag ends with a click, and that click must not take the selection
      // affordance — or the help button, which follows the same predicate —
      // away again while the selection it belongs to is still on screen. A
      // plain click has already collapsed the selection by the time this
      // runs, so only that case dismisses them.
      if (!selectionIsLive()) {
        hideFloat();
      }
      closePopovers();
      // 12 §11.7 — a click on marked words opens the note, not a read.
      var notedId = selectionIsLive() ? null : noteAtPoint(event);
      if (notedId) {
        cancelPendingClickRead();
        openNote(notedId, null);
        return;
      }
      maybeClickToRead(event, element);
      return;
    }
    event.stopPropagation();
    var actionElement = element.closest('[data-mpe-ra-action]');
    if (!actionElement) {
      // Inside a popover or the theme settings sheet: leave it open while
      // its own controls are being used.
      if (!element.closest('.mpe-ra-pop, .mpe-ra-sheet')) {
        closePopovers();
      }
      return;
    }
    event.preventDefault();
    handleAction(
      actionElement.getAttribute('data-mpe-ra-action'),
      actionElement,
    );
  }

  /**
   * The suspension listeners of the follow-the-reading scroll (07 §7.3):
   * a wheel, a touch, a press on the vertical scrollbar, a scrolling key
   * outside a form control or the panel, and any scroll of the container
   * that is not the loop's own. Every one of them is also activity for the
   * panel's auto-hide (07 §10.1).
   */
  function onWheel(event) {
    touchPanel();
    var container = followContainer();
    if (
      container !== window &&
      event.target &&
      container.contains &&
      !container.contains(event.target)
    ) {
      return;
    }
    suspendFollow();
  }

  function onTouchStart(event) {
    touchPanel();
    var container = followContainer();
    if (
      container !== window &&
      event.target &&
      container.contains &&
      !container.contains(event.target)
    ) {
      return;
    }
    suspendFollow();
  }

  function onScrollbarMouseDown(event) {
    var width = document.documentElement
      ? document.documentElement.clientWidth
      : 0;
    if (width > 0 && event.clientX >= width) {
      suspendFollow();
    }
  }

  function attachRoot(candidate) {
    if (!candidate || candidate === root) {
      return;
    }
    if (rootObserver) {
      rootObserver.disconnect();
    }
    if (rootClassObserver) {
      rootClassObserver.disconnect();
    }
    root = candidate;
    rootObserver = new MutationObserver(function (mutations) {
      if (isSelfMutation(mutations)) {
        return;
      }
      scheduleDecorate();
    });
    rootObserver.observe(root, { childList: true, subtree: true });
    rootClassObserver = new MutationObserver(restoreRootClasses);
    rootClassObserver.observe(root, {
      attributes: true,
      attributeFilter: ['class'],
    });
    // The face's advance, now that there is a root to lay the sample out in
    // (07 §6.2).
    measureCharEm();
    decorate();
  }

  /**
   * Put the player's root classes back after crossnote rewrote the `class`
   * attribute (`setAttribute("class", "crossnote markdown-preview …")` on
   * every React render). Without them the reading canvas loses its rhythm,
   * the pills their padding variables, click-to-read its pointer and the
   * panel its clearance. A no-op when nothing is missing, so re-adding the
   * classes — which is itself an attribute mutation — cannot loop.
   */
  function restoreRootClasses() {
    if (!root || !config.enabled) {
      return;
    }
    var wanted = [CANVAS_CLASS];
    if (config.clickToRead) {
      wanted.push(CLICK_CLASS);
    }
    if (barVisible()) {
      wanted.push(PANEL_CLASS);
    }
    if (core.playerFontStack(config.font)) {
      wanted.push('mpe-ra-font');
    }
    var gutter = gutterWanted();
    if (gutter) {
      wanted.push('mpe-ra-notes-gutter');
    }
    for (var i = 0; i < wanted.length; i++) {
      if (!root.classList.contains(wanted[i])) {
        applyClickClass();
        applyCanvasClasses();
        applyFontToRoot();
        applyGutter();
        if (gutter) {
          root.classList.add('mpe-ra-notes-gutter');
        }
        return;
      }
    }
  }

  function start() {
    sourceUri = readSourceUriFromPage();
    // The body classes carry VS Code's colour theme kind now that the body
    // exists (05 §4.3); if they disagree with the media query the page
    // switches once, here, before the root is decorated.
    applyPage();
    watchPageEnvironment();
    watchReducedMotion();
    watchFonts();
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
        // A press on the vertical scrollbar is a manual scroll (07 §7.3).
        onScrollbarMouseDown(event);
        var element =
          event.target && event.target.nodeType === 1
            ? event.target
            : event.target && event.target.parentElement;
        if (
          element &&
          element.closest &&
          element.closest(
            '.mpe-ra-float, .mpe-ra-bar-help, .mpe-ra-bar-notes, .mpe-ra-note-reattach',
          )
        ) {
          // Keep the selection alive until the click handler reads it. The
          // help button needs this for the same reason the float does: a
          // mousedown on a control collapses the document selection, and both
          // of them are about the passage that selection covers.
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
    // Follow-the-reading (07 §7.3) and panel auto-hide (07 §10.1): the
    // suspension and activity listeners. All passive; the scroll listener
    // of the document is on the window, the help sheet body's is attached
    // when the sheet is built.
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener(
      'scroll',
      function () {
        onContainerScroll(window);
      },
      { passive: true },
    );
    document.addEventListener(
      'scroll',
      function (event) {
        // A scroll of the help sheet body (07 §7.6) does not bubble, but it
        // is seen here in the capture phase.
        var target = event.target;
        if (
          target &&
          target.nodeType === 1 &&
          (target === helpBody() || target === noteScrollBox())
        ) {
          onContainerScroll(target);
          // A selection inside the sheet is the one case where a scroll does
          // move the affordance relative to its text (09 §9).
          onScrollMoveFloat();
        }
      },
      true,
    );
    // The markers follow their line boxes when the pane is resized (12 §10.1).
    window.addEventListener('resize', scheduleMarkerLayout, { passive: true });
    window.addEventListener(
      'keydown',
      function (event) {
        unlockMediaPool();
        lastGestureWasKey = true;
        touchPanel();
        if (isScrollKey(event)) {
          suspendFollow();
        }
      },
      true,
    );
    window.addEventListener('pointermove', touchPanel, { passive: true });
    window.addEventListener('pointerdown', touchPanel, { passive: true });
    // 09 §9. This used to be `hideFloat`, which also discarded the resolved
    // selection — and the follow-the-reading loop scrolls on every frame of a
    // read, so the help button and `Alt+H` were disabled within a frame of
    // any selection made while listening.
    window.addEventListener('scroll', onScrollMoveFloat, { passive: true });
  }

  window.addEventListener('message', onHostMessage);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
