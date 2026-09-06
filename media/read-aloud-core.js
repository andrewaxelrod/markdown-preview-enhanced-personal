/*
 * Read aloud (Kokoro) — pure DOM helpers.
 *
 * Shared by media/read-aloud.js (the preview app) and the jsdom unit tests.
 * The module touches no DOM global at load time: documents are reached through
 * `el.ownerDocument` and NodeFilter/Range constants are inlined as numbers, so
 * `require('media/read-aloud-core.js')` works in plain Node (spec §7, F6
 * "The classifier is a pure function with unit tests").
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  // crossnote renders two `.markdown-preview` elements; only the visible one
  // carries data-for="preview" (contract B7).
  var ROOT_SELECTOR = '.markdown-preview[data-for="preview"]';

  // Same bound as src/read-aloud/messages.ts, used for the selection pre-check.
  var MAX_TEXT_CHARS = 200000;

  var ELIGIBLE_TAGS = [
    'P',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'BLOCKQUOTE',
    'UL',
    'OL',
  ];
  var CONTAINER_TAGS = ['DIV'];

  // crossnote's diagram fence languages plus the d2 container class.
  var DIAGRAM_CLASSES = [
    'mermaid',
    'plantuml',
    'puml',
    'wavedrom',
    'bitfield',
    'bit-field',
    'graphviz',
    'viz',
    'dot',
    'vega',
    'vega-lite',
    'wsd',
    'd2',
    'd2-diagram',
    'tikz',
  ];
  var DIAGRAM_SELECTOR =
    '.mermaid, .plantuml, .puml, .wavedrom, .bitfield, .bit-field, .graphviz, .viz, .dot, .vega, .vega-lite, .wsd, .d2, .d2-diagram, .tikz';

  var INELIGIBLE_BLOCK_SELECTOR =
    '.md-toc, .code-chunk, .mermaid, .plantuml, .puml, .wavedrom, .bitfield, .bit-field, .graphviz, .viz, .dot, .vega, .vega-lite, .wsd, .d2, .d2-diagram, .tikz, .katex, .katex-display, math, pre, table, img, iframe, video, audio, object, embed, svg, canvas, script, style, .footnotes, .footnotes-sep';

  // Rule 4: a prose container (admonition, raw HTML block) is refused when it
  // holds one of these. Math is deliberately not in the list: inline math
  // inside prose is skipped by the extractor and the prose is read
  // (decision 8), exactly as for a paragraph.
  var CONTAINER_INELIGIBLE_SELECTOR =
    '.md-toc, .code-chunk, .mermaid, .plantuml, .puml, .wavedrom, .bitfield, .bit-field, .graphviz, .viz, .dot, .vega, .vega-lite, .wsd, .d2, .d2-diagram, .tikz, pre, table, img, iframe, video, audio, object, embed, svg, canvas, script, style, .footnotes, .footnotes-sep';

  // Rule 0: a block that *is* math (display math, a bare MathML element) is
  // never read. Math *inside* a block contributes no text (EXTRACT_SKIP_SELECTOR)
  // and a click on it is refused, so LaTeX is never spoken (decision 8).
  var MATH_CLASSES = ['katex', 'katex-display'];
  var MATH_SELECTOR = '.katex, .katex-display, math';

  // Subtrees that contribute no text: our own UI, footnote markers, math,
  // media, and every INELIGIBLE_BLOCK_SELECTOR block nested inside an eligible
  // one (a code fence in a list item, a table in a blockquote): F6 holds at
  // every depth, so a whole-block read never speaks code or diagram source.
  var EXTRACT_SKIP_SELECTOR =
    '.mpe-ra-btn, .mpe-ra-ui, sup.footnote-ref, a.footnote-backref, .katex, .katex-display, math, script, style, svg, input, img, a.header-anchor, a.anchor, [aria-hidden="true"], pre, table, iframe, video, audio, object, embed, canvas, .code-chunk, .md-toc, .footnotes, .footnotes-sep, ' +
    DIAGRAM_SELECTOR;

  var HINT_INELIGIBLE = 'Read aloud is not available for code or diagrams';
  var HINT_MULTI_CELL = 'Select text within a single table cell';
  var HINT_TOO_LONG = 'Selection is too long to read aloud';

  // Click to read (F17): a click on interactive content keeps its own action.
  // Matched with closestWithin, bounded to the preview root.
  var INTERACTIVE_SELECTOR =
    'a[href], input, button, select, textarea, label, summary, .mpe-ra-ui, .mpe-ra-btn';

  var LABEL_MAX_CHARS = 40;

  // Reading decoration (F4 look): the block being read gets READING_CLASS, each
  // run of inline content inside it is wrapped in a PILL_CLASS span (one rounded
  // "pill" per rendered line via box-decoration-break: clone) and the spoken
  // word is wrapped in WORD_CLASS spans. The characters touching the word on
  // either side are wrapped in WORD_EDGE_CLASS spans at the same time, up to
  // WORD_EDGE_CHARS of them per side: the word box overhangs its word by its
  // horizontal padding and is painted above the block's text, so whatever
  // stands in that overhang — the hyphen of "read-only", the full stop after
  // a sentence's last word — would be hidden under it; the edge spans are
  // positioned a step above the box so those glyphs are painted over it. The
  // palettes live in media/read-aloud.css.
  var READING_CLASS = 'mpe-ra-reading';
  var PILL_CLASS = 'mpe-ra-pill';
  var WORD_CLASS = 'mpe-ra-word';
  var WORD_EDGE_CLASS = 'mpe-ra-word-edge';
  // The overhang is 0.35 em; three glyphs are wider than that even in the
  // narrowest punctuation, so nothing under the box is ever left unwrapped.
  var WORD_EDGE_CHARS = 3;
  var HIGHLIGHT_THEMES = ['blue', 'pink', 'red', 'green', 'orange'];
  var DEFAULT_HIGHLIGHT_THEME = 'blue';

  // The player font (theme settings panel): an override for the preview
  // theme's own font family. Only families a machine already has — the
  // webview must not fetch a font over the network — so every entry is a
  // stack that degrades to a generic family on a platform without the first
  // choice. `default` leaves the preview theme's font alone.
  var PLAYER_FONTS = [
    { id: 'default', label: 'Theme default', stack: '' },
    {
      id: 'system',
      label: 'System',
      stack:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    },
    {
      id: 'helvetica',
      label: 'Helvetica',
      stack:
        '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif',
    },
    {
      id: 'verdana',
      label: 'Verdana',
      stack: 'Verdana, Geneva, "DejaVu Sans", sans-serif',
    },
    {
      id: 'trebuchet',
      label: 'Trebuchet MS',
      stack: '"Trebuchet MS", "Lucida Grande", Tahoma, sans-serif',
    },
    {
      id: 'georgia',
      label: 'Georgia',
      stack: 'Georgia, "Times New Roman", "Liberation Serif", serif',
    },
    {
      id: 'palatino',
      label: 'Palatino',
      stack:
        '"Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", serif',
    },
    {
      id: 'baskerville',
      label: 'Baskerville',
      stack: 'Baskerville, "Libre Baskerville", Georgia, serif',
    },
    {
      id: 'times',
      label: 'Times New Roman',
      stack: '"Times New Roman", Times, "Liberation Serif", serif',
    },
    {
      id: 'menlo',
      label: 'Menlo',
      stack: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
    },
  ];
  var DEFAULT_PLAYER_FONT = 'default';

  // The low-strain reading page (featrues/05-eye-strain.spec.md §4): the
  // Global theme of the theme settings sheet. Same values as
  // src/read-aloud/messages.ts. `off` is a Settings value only — the sheet
  // shows Auto · Light · Dark — and restores the preview theme exactly as it
  // was before the page existed.
  var GLOBAL_THEMES = ['auto', 'light', 'dark', 'off'];
  var DEFAULT_GLOBAL_THEME = 'auto';

  // Eye strain 2 (featrues/07-eye-strain-2/spec.md §5): one text-size
  // slider, in px as the reader sees it on the label, applied in rem. The
  // line height, the heading sizes and the reading column derive from it.
  var TEXT_SIZE_MIN = 16;
  var TEXT_SIZE_MAX = 28;
  var TEXT_SIZE_STEP = 1;
  var DEFAULT_TEXT_SIZE = 20;

  // The measure (07 §6): always this many characters of prose, in whatever
  // face is on, capped by the pane. `ch` is the advance of the digit zero,
  // which in a proportional face is wider than the average character (66 ch
  // of Atkinson held 83–84 characters), so the face's average advance is
  // measured at runtime against this sample: ordinary English prose with
  // normal spacing and punctuation, no quotes or apostrophes.
  var MEASURE_CHARS = 66;
  var MEASURE_SAMPLE =
    'The quick study of a long page begins with its lines. A reader moves ' +
    'along each one in a series of short hops, pausing on a few words at a ' +
    'time, then sweeps back to find the start of the next. When a line ' +
    'holds too many characters that return sweep lands in the wrong place ' +
    'and the eye must hunt; when it holds too few the hops are cut short ' +
    'and the rhythm breaks. Between those limits sits a measure that most ' +
    'people find comfortable.';
  // The em per character used until the face has been measured (jsdom lays
  // nothing out, so the page always has a measure).
  var DEFAULT_CHAR_EM = 0.5;

  // The word marker (07 §9): an underline sweep in the palette's stroke
  // colour (the glyphs keep their brightness), the filled box of 02, or
  // nothing. Published as `data-mpe-ra-marker` on the preview root.
  var WORD_MARKERS = ['underline', 'box', 'off'];
  var DEFAULT_WORD_MARKER = 'underline';

  // Follow-the-reading scroll (07 §7.1): the spoken word's top is kept inside
  // a band of the visible height and eased to the anchor when it leaves it.
  var FOLLOW_ANCHOR = 0.38;
  var FOLLOW_BAND_TOP = 0.34;
  var FOLLOW_BAND_BOTTOM = 0.42;
  var FOLLOW_EASE = 0.12;
  var FOLLOW_SETTLE_PX = 0.5;

  // Pauses at block boundaries (07 §11): a breath between blocks, a longer
  // one after a heading, both divided by the playback rate.
  var BLOCK_GAP_MS = 400;
  var HEADING_GAP_MS = 900;

  // Elements that establish a block of their own: their inline runs are
  // wrapped separately from the parent's. Anything else is treated as inline.
  var BLOCK_TAGS = {
    ADDRESS: true,
    ARTICLE: true,
    ASIDE: true,
    BLOCKQUOTE: true,
    CAPTION: true,
    CENTER: true,
    DD: true,
    DETAILS: true,
    DIALOG: true,
    DIV: true,
    DL: true,
    DT: true,
    FIELDSET: true,
    FIGCAPTION: true,
    FIGURE: true,
    FOOTER: true,
    FORM: true,
    H1: true,
    H2: true,
    H3: true,
    H4: true,
    H5: true,
    H6: true,
    HEADER: true,
    HGROUP: true,
    HR: true,
    LI: true,
    MAIN: true,
    MENU: true,
    NAV: true,
    OL: true,
    P: true,
    PRE: true,
    SECTION: true,
    SUMMARY: true,
    TABLE: true,
    TBODY: true,
    TD: true,
    TFOOT: true,
    TH: true,
    THEAD: true,
    TR: true,
    UL: true,
  };

  // Inline replaced elements that make a run worth a pill even without text.
  var REPLACED_TAGS = { IMG: true, INPUT: true, VIDEO: true, AUDIO: true };

  // NodeFilter / Node / Range constants (numeric so no DOM global is touched).
  var ELEMENT_NODE = 1;
  var TEXT_NODE = 3;
  var SHOW_ELEMENT = 0x1;
  var SHOW_TEXT = 0x4;
  var FILTER_ACCEPT = 1;
  var FILTER_REJECT = 2;
  var FILTER_SKIP = 3;
  var START_TO_START = 0;
  var START_TO_END = 1;
  var END_TO_START = 3;

  var HEADING_TAGS = {
    H1: true,
    H2: true,
    H3: true,
    H4: true,
    H5: true,
    H6: true,
  };
  var MEDIA_TAGS = {
    IMG: true,
    IFRAME: true,
    VIDEO: true,
    AUDIO: true,
    OBJECT: true,
    EMBED: true,
    FIGURE: true,
  };

  // Tag names of EXTRACT_SKIP_SELECTOR. Foreign elements (SVG, MathML) keep the
  // case they were parsed with, so both spellings are listed.
  var SKIP_TAGS = {
    SCRIPT: true,
    STYLE: true,
    SVG: true,
    svg: true,
    INPUT: true,
    IMG: true,
    MATH: true,
    math: true,
    PRE: true,
    TABLE: true,
    IFRAME: true,
    VIDEO: true,
    AUDIO: true,
    OBJECT: true,
    EMBED: true,
    CANVAS: true,
  };

  // Class names of EXTRACT_SKIP_SELECTOR that mark a nested ineligible block.
  var SKIP_CLASSES = [
    'code-chunk',
    'md-toc',
    'footnotes',
    'footnotes-sep',
  ].concat(DIAGRAM_CLASSES);

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function matchesSelector(el, selector) {
    return !!(el && el.nodeType === ELEMENT_NODE && el.matches(selector));
  }

  /**
   * The element's class attribute as a lookup table, or null when it has none.
   * Reading the attribute once beats repeated `classList.contains` calls, which
   * re-parse the attribute on every access in jsdom.
   */
  function classSet(el) {
    var raw = el.getAttribute ? el.getAttribute('class') : null;
    if (!raw) {
      return null;
    }
    var set = Object.create(null);
    var parts = raw.split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) {
        set[parts[i]] = true;
      }
    }
    return set;
  }

  /**
   * Hand-rolled equivalent of `el.matches(EXTRACT_SKIP_SELECTOR)`. The selector
   * string stays the documentation of the rule; this form is what the walker
   * calls, because a multi-part selector with an attribute clause costs about
   * 0.7 ms per call in jsdom, which alone would blow the §6 performance budget.
   */
  function isSkippedElement(el) {
    var tag = el.tagName;
    if (SKIP_TAGS[tag]) {
      return true;
    }
    if (el.getAttribute('aria-hidden') === 'true') {
      return true;
    }
    var set = classSet(el);
    if (!set) {
      return false;
    }
    if (
      set['mpe-ra-btn'] ||
      set['mpe-ra-ui'] ||
      set['katex'] ||
      set['katex-display'] ||
      setHasAnyClass(set, SKIP_CLASSES)
    ) {
      return true;
    }
    if (tag === 'SUP' && set['footnote-ref']) {
      return true;
    }
    if (
      tag === 'A' &&
      (set['footnote-backref'] || set['header-anchor'] || set['anchor'])
    ) {
      return true;
    }
    return false;
  }

  function setHasAnyClass(set, names) {
    if (!set) {
      return false;
    }
    for (var i = 0; i < names.length; i++) {
      if (set[names[i]]) {
        return true;
      }
    }
    return false;
  }

  /** `el.matches(MATH_SELECTOR)`: the element itself is math (rule 0). */
  function isMathElement(el, set) {
    if (setHasAnyClass(set, MATH_CLASSES)) {
      return true;
    }
    var tag = el.tagName;
    return tag === 'MATH' || tag === 'math';
  }

  /** True for every code point JavaScript's `\s` matches. */
  function isWhitespaceCode(code) {
    return (
      code === 0x20 ||
      (code >= 0x09 && code <= 0x0d) ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000 ||
      code === 0xfeff
    );
  }

  function containsSelector(el, selector) {
    return !!(
      el &&
      el.nodeType === ELEMENT_NODE &&
      el.querySelector(selector) !== null
    );
  }

  function nearestElement(node) {
    if (!node) {
      return null;
    }
    return node.nodeType === ELEMENT_NODE ? node : node.parentElement;
  }

  /**
   * `el.closest(selector)`, but stopping at `boundary` (exclusive): a match
   * above the boundary does not count.
   */
  function closestWithin(el, selector, boundary) {
    while (el && el !== boundary) {
      if (matchesSelector(el, selector)) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /** 32-bit FNV-1a, unsigned. */
  function fnv1a32(str) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      // hash * 16777619 without overflowing the 32-bit range
      hash =
        (hash +
          ((hash << 1) +
            (hash << 4) +
            (hash << 7) +
            (hash << 8) +
            (hash << 24))) >>>
        0;
    }
    return hash >>> 0;
  }

  /** Stable identity of a block across re-renders (contract decision D). */
  function blockKey(el, text) {
    var tag = el && el.tagName ? el.tagName : '';
    return 'b' + fnv1a32(tag + '\u0001' + text).toString(16);
  }

  /** Short human label for the player bar (contract decision H). */
  function blockLabel(text) {
    if (!text) {
      return '';
    }
    if (text.length <= LABEL_MAX_CHARS) {
      return text;
    }
    return text.slice(0, LABEL_MAX_CHARS) + '…';
  }

  // ---------------------------------------------------------------------------
  // Classification (F6)
  // ---------------------------------------------------------------------------

  function verdict(eligible, kind, reason) {
    return { eligible: eligible, kind: kind, reason: reason };
  }

  /**
   * Classify one direct child of the preview root. Pure function of tag name,
   * class names and (for paragraphs and containers) the extracted text.
   * Rules are applied in order; the first match wins (contract §1.2).
   */
  function classifyBlock(el) {
    if (!el || el.nodeType !== ELEMENT_NODE) {
      return verdict(false, 'other', 'not an element');
    }
    var tag = el.tagName;
    var set = classSet(el);

    // Rule 0 — a block that *is* math (display math, MathML) would speak
    // LaTeX, so it is never read. A block that merely contains inline math is
    // classified by the rules below; the extractor skips the math and the
    // prose around it is read (decision 8).
    if (isMathElement(el, set)) {
      return verdict(false, 'math', 'math markup');
    }

    // Rule 0b — a diagram class wins over the tag it happens to sit on
    // (crossnote renders vega-lite into `<p class="vega-lite">`, F6 "any diagram").
    if (setHasAnyClass(set, DIAGRAM_CLASSES)) {
      return verdict(false, 'diagram', 'diagram class');
    }

    // Rule 1 — paragraphs.
    if (tag === 'P') {
      if (set && set['empty-line']) {
        return verdict(false, 'empty', 'empty-line');
      }
      if (!hasVisibleText(el)) {
        return verdict(false, 'empty', 'no text');
      }
      return verdict(true, 'paragraph', 'eligible');
    }

    // Rule 2 — prose containers that are read as one block.
    if (HEADING_TAGS[tag]) {
      return verdict(true, 'heading', 'eligible');
    }
    if (tag === 'BLOCKQUOTE') {
      return verdict(true, 'blockquote', 'eligible');
    }
    if (tag === 'UL' || tag === 'OL') {
      return verdict(true, 'list', 'eligible');
    }

    // Rule 3 — known ineligible blocks.
    if (tag === 'TABLE') {
      return verdict(false, 'table', 'table (selection only)');
    }
    if (tag === 'PRE') {
      return verdict(false, 'code', 'code block');
    }
    if (set && set['code-chunk']) {
      return verdict(false, 'code-chunk', 'code chunk');
    }
    if (set && (set['footnotes'] || set['footnotes-sep'])) {
      return verdict(false, 'footnotes', 'footnotes');
    }
    if (MEDIA_TAGS[tag]) {
      return verdict(false, 'media', 'embedded media');
    }
    if (CONTAINER_TAGS.indexOf(tag) >= 0) {
      var firstChild = el.firstElementChild;
      if (
        (set && set['md-toc']) ||
        setHasAnyClass(classSet(firstChild || el), ['md-toc'])
      ) {
        return verdict(false, 'toc', 'table of contents');
      }
      if (containsSelector(el, DIAGRAM_SELECTOR)) {
        return verdict(false, 'diagram', 'diagram container');
      }
      if (
        firstChild &&
        firstChild.tagName === 'SVG' &&
        el.children.length === 1
      ) {
        return verdict(false, 'diagram', 'svg container');
      }

      // Rule 4 — other divs (admonitions, raw HTML prose).
      if (
        matchesSelector(el, INELIGIBLE_BLOCK_SELECTOR) ||
        containsSelector(el, CONTAINER_INELIGIBLE_SELECTOR)
      ) {
        return verdict(false, 'container', 'ineligible content');
      }
      if (!hasVisibleText(el)) {
        return verdict(false, 'empty', 'no text');
      }
      return verdict(true, 'container', 'eligible');
    }

    // Rule 5 — anything else.
    return verdict(false, 'other', 'unsupported element');
  }

  /** Eligible direct children of the root, in document order. */
  function collectBlocks(root) {
    var blocks = [];
    if (!root) {
      return blocks;
    }
    var children = root.children;
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      var info = classifyBlock(el);
      if (info.eligible) {
        blocks.push({ el: el, kind: info.kind, index: blocks.length });
      }
    }
    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Text extraction + offset map (F5, R2 §5.4)
  // ---------------------------------------------------------------------------

  function createState() {
    return { text: '', segments: [], pendingNode: null, pendingOffset: 0 };
  }

  function toMap(state) {
    return { text: state.text, segments: state.segments };
  }

  /**
   * Append `node.data.slice(from, to)` to the state, collapsing whitespace runs
   * to a single space and dropping leading whitespace. A collapsed space gets
   * its own one-character segment anchored at the first whitespace character of
   * the run, so every character of the produced text maps back into the DOM.
   */
  function appendTextNode(state, node, from, to) {
    var data = node.data;
    var i = from;
    while (i < to) {
      if (isWhitespaceCode(data.charCodeAt(i))) {
        if (state.text.length > 0 && state.pendingNode === null) {
          state.pendingNode = node;
          state.pendingOffset = i;
        }
        i++;
        continue;
      }
      var start = i;
      while (i < to && !isWhitespaceCode(data.charCodeAt(i))) {
        i++;
      }
      if (state.pendingNode !== null) {
        state.segments.push({
          textStart: state.text.length,
          textEnd: state.text.length + 1,
          node: state.pendingNode,
          domStart: state.pendingOffset,
        });
        state.text += ' ';
        state.pendingNode = null;
      }
      state.segments.push({
        textStart: state.text.length,
        textEnd: state.text.length + (i - start),
        node: node,
        domStart: start,
      });
      state.text += data.slice(start, i);
    }
  }

  /** Visit every text node of `el` that is not inside a skipped subtree. */
  function walkTextNodes(el, visit) {
    var doc = el.ownerDocument;
    var walker = doc.createTreeWalker(
      el,
      SHOW_ELEMENT | SHOW_TEXT,
      function (node) {
        if (node.nodeType === ELEMENT_NODE) {
          return isSkippedElement(node) ? FILTER_REJECT : FILTER_SKIP;
        }
        return FILTER_ACCEPT;
      },
    );
    var node = walker.nextNode();
    while (node) {
      visit(node);
      node = walker.nextNode();
    }
  }

  /** Portion of a text node covered by `range`, or null when disjoint. */
  function clipToRange(node, range) {
    if (!range) {
      return { from: 0, to: node.data.length };
    }
    var doc = node.ownerDocument;
    var nodeRange = doc.createRange();
    nodeRange.setStart(node, 0);
    nodeRange.setEnd(node, node.data.length);
    // range.end <= node.start, or range.start >= node.end → no overlap.
    if (range.compareBoundaryPoints(START_TO_END, nodeRange) <= 0) {
      return null;
    }
    if (range.compareBoundaryPoints(END_TO_START, nodeRange) >= 0) {
      return null;
    }
    var from = range.startContainer === node ? range.startOffset : 0;
    var to = range.endContainer === node ? range.endOffset : node.data.length;
    if (to <= from) {
      return null;
    }
    return { from: from, to: to };
  }

  function extractInto(state, el, range) {
    walkTextNodes(el, function (node) {
      var clip = clipToRange(node, range);
      if (clip) {
        appendTextNode(state, node, clip.from, clip.to);
      }
    });
    return state;
  }

  /** Whole-block extraction: `{ text, map }` (F5). */
  function extractText(el) {
    var state = extractInto(createState(), el, null);
    return { text: state.text, map: toMap(state) };
  }

  /**
   * `extractText(el).text !== ''`, decided without building the offset map:
   * classification runs over every block of the document, so it stops at the
   * first readable character (§6 Performance).
   */
  function hasVisibleText(el) {
    var found = false;
    var doc = el.ownerDocument;
    var walker = doc.createTreeWalker(
      el,
      SHOW_ELEMENT | SHOW_TEXT,
      function (node) {
        if (node.nodeType === ELEMENT_NODE) {
          return isSkippedElement(node) ? FILTER_REJECT : FILTER_SKIP;
        }
        return FILTER_ACCEPT;
      },
    );
    var node = walker.nextNode();
    while (node && !found) {
      var data = node.data;
      for (var i = 0; i < data.length; i++) {
        if (!isWhitespaceCode(data.charCodeAt(i))) {
          found = true;
          break;
        }
      }
      node = found ? null : walker.nextNode();
    }
    return found;
  }

  function rangeIntersectsElement(range, el) {
    var doc = el.ownerDocument;
    var elRange = doc.createRange();
    elRange.selectNode(el);
    return (
      range.compareBoundaryPoints(START_TO_END, elRange) > 0 &&
      range.compareBoundaryPoints(END_TO_START, elRange) < 0
    );
  }

  /** Append one block's extraction to a multi-block state, '\n'-separated. */
  function appendBlockState(state, sub) {
    if (!sub.text) {
      return;
    }
    if (state.text.length > 0) {
      // The separator maps to nothing on purpose (contract §3.2).
      state.text += '\n';
    }
    var offset = state.text.length;
    for (var i = 0; i < sub.segments.length; i++) {
      var seg = sub.segments[i];
      state.segments.push({
        textStart: seg.textStart + offset,
        textEnd: seg.textEnd + offset,
        node: seg.node,
        domStart: seg.domStart,
      });
    }
    state.text += sub.text;
  }

  /**
   * Multi-block, range-clipped extraction. Ineligible blocks (tables, math,
   * code, diagrams) and blocks whose clipped text is empty are dropped; the
   * survivors are joined with '\n' (contract §4 (j), G-12).
   * `eligibleCount` is the number of eligible blocks the range touched, before
   * the empty-drop — it tells "nothing readable was selected" (→ ineligible)
   * apart from "only whitespace was selected" (→ whitespace).
   */
  function extractRange(range, root) {
    var state = createState();
    var blocks = [];
    var eligibleCount = 0;
    var children = root ? root.children : [];
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      if (!rangeIntersectsElement(range, el)) {
        continue;
      }
      if (!classifyBlock(el).eligible) {
        continue;
      }
      eligibleCount++;
      var sub = extractInto(createState(), el, range);
      if (!sub.text) {
        continue;
      }
      appendBlockState(state, sub);
      blocks.push(el);
    }
    return {
      text: state.text,
      map: toMap(state),
      blocks: blocks,
      eligibleCount: eligibleCount,
    };
  }

  /**
   * The text of a continuous read (F15, decision 5): `elements` in order,
   * the first one from text offset `startOffset` of its whole text, the rest
   * whole, '\n'-joined like extractRange. Each surviving element is reported
   * as `{ el, start, end }`, the half-open range of `text` it produced;
   * elements with no text are dropped. `map` covers the whole text.
   */
  function extractBlocks(elements, startOffset) {
    var state = createState();
    var blocks = [];
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var whole = extractText(el);
      var extracted =
        i === 0 && startOffset > 0
          ? sliceExtraction(whole, startOffset)
          : whole;
      if (!extracted.text) {
        continue;
      }
      var start = state.text.length > 0 ? state.text.length + 1 : 0;
      appendBlockState(state, {
        text: extracted.text,
        segments: extracted.map.segments,
      });
      blocks.push({ el: el, start: start, end: state.text.length });
    }
    return { text: state.text, map: toMap(state), blocks: blocks };
  }

  /**
   * Rebuild the offset map of a continuous read after a re-render
   * (decision 6). `blocks` is the read's block table with `el` re-bound to
   * the new DOM (or null when the block is gone) and `startOffset` for the
   * first block; a block whose fresh extraction is exactly
   * `text.slice(start, end)` contributes its segments at those offsets, any
   * other block contributes nothing and its index is reported in `missing`.
   */
  function remapBlocks(text, blocks) {
    var segments = [];
    var missing = [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (!block.el) {
        missing.push(i);
        continue;
      }
      var whole = extractText(block.el);
      var extracted =
        block.startOffset > 0
          ? sliceExtraction(whole, block.startOffset)
          : whole;
      if (extracted.text !== text.slice(block.start, block.end)) {
        missing.push(i);
        continue;
      }
      var subs = extracted.map.segments;
      for (var k = 0; k < subs.length; k++) {
        segments.push({
          textStart: subs[k].textStart + block.start,
          textEnd: subs[k].textEnd + block.start,
          node: subs[k].node,
          domStart: subs[k].domStart,
        });
      }
    }
    return { map: { text: text, segments: segments }, missing: missing };
  }

  // ---------------------------------------------------------------------------
  // Offset map → DOM (F4)
  // ---------------------------------------------------------------------------

  /** `{ node, offset }` for a text offset, or null when the offset is unmapped. */
  function offsetToDom(map, offset) {
    if (!map || !map.segments || !map.segments.length || offset < 0) {
      return null;
    }
    var segments = map.segments;
    var lo = 0;
    var hi = segments.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var seg = segments[mid];
      if (offset < seg.textStart) {
        hi = mid - 1;
      } else if (offset >= seg.textEnd) {
        lo = mid + 1;
      } else {
        return {
          node: seg.node,
          offset: seg.domStart + (offset - seg.textStart),
        };
      }
    }
    return null;
  }

  /** DOM Range covering text offsets `[from, to)` of `map`, or null. */
  function offsetsToRange(map, from, to, doc) {
    if (!map || !(to > from)) {
      return null;
    }
    var start = offsetToDom(map, from);
    var end = offsetToDom(map, to - 1);
    if (!start || !end) {
      return null;
    }
    var document_ = doc || start.node.ownerDocument;
    var range = document_.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
    return range;
  }

  /**
   * DOM Range covering one word span. Ranges are cached on the span for the map
   * they were built from, so the rAF highlight loop stays O(1) (contract §3.2).
   */
  function spanToRange(map, span, doc) {
    if (!map || !span) {
      return null;
    }
    if (span._range && span._rangeMap === map) {
      return span._range;
    }
    var range = offsetsToRange(map, span.charStart, span.charEnd, doc);
    if (!range) {
      return null;
    }
    span._range = range;
    span._rangeMap = map;
    return range;
  }

  /**
   * The characters touching a word span on either side, as text offsets of
   * `map`: `before` is the run of non-whitespace characters that ends at
   * `charStart`, `after` the run that starts at `charEnd`, each cut to
   * `maxChars` (WORD_EDGE_CHARS by default) and null when the word is
   * bounded by whitespace or by the text's end. A run never crosses
   * whitespace, so it never crosses a block boundary either (blocks are
   * '\n'-separated in a multi-block map).
   */
  function wordEdges(map, span, maxChars) {
    var text = map && typeof map.text === 'string' ? map.text : '';
    var limit = typeof maxChars === 'number' ? maxChars : WORD_EDGE_CHARS;
    var out = { before: null, after: null };
    if (!span || !text || !(limit > 0)) {
      return out;
    }
    var from = span.charStart;
    while (from > 0 && span.charStart - from < limit) {
      if (isWhitespaceCode(text.charCodeAt(from - 1))) {
        break;
      }
      from--;
    }
    if (from < span.charStart) {
      out.before = { from: from, to: span.charStart };
    }
    var to = span.charEnd;
    while (to < text.length && to - span.charEnd < limit) {
      if (isWhitespaceCode(text.charCodeAt(to))) {
        break;
      }
      to++;
    }
    if (to > span.charEnd) {
      out.after = { from: span.charEnd, to: to };
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Selection (F2, D3)
  // ---------------------------------------------------------------------------

  function refuse(reason, hint) {
    return { ok: false, reason: reason, hint: hint };
  }

  /** Nearest direct child of `root` that contains `node`, or null. */
  function topLevelBlockFor(node, root) {
    var el = nearestElement(node);
    while (el && el !== root) {
      if (el.parentElement === root) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Nearest ancestor of `node` strictly below `root` that is itself an
   * ineligible block — a code fence, diagram, math or embed nested inside an
   * otherwise eligible blockquote, list item or container — or null. F6 holds
   * at every depth, not only for the direct children of the root.
   */
  function nestedIneligibleAncestor(node, root) {
    return closestWithin(nearestElement(node), INELIGIBLE_BLOCK_SELECTOR, root);
  }

  function isInsideRoot(root, node) {
    var el = nearestElement(node);
    return !!(el && root && root.contains(el));
  }

  /**
   * Decide what a preview selection reads (contract §4 (j)):
   * collapsed → empty; table → single cell only; ineligible ancestor → hint;
   * otherwise the eligible blocks the range touches, clipped and '\n'-joined.
   */
  function resolveSelection(selection, root) {
    if (!selection || !root || !selection.rangeCount) {
      return refuse('empty', '');
    }
    var range = selection.getRangeAt(0);
    if (range.collapsed) {
      return refuse('empty', '');
    }
    if (!isInsideRoot(root, range.commonAncestorContainer)) {
      return refuse('empty', '');
    }

    var ancestor = nearestElement(range.commonAncestorContainer);
    var table = ancestor ? ancestor.closest('table') : null;
    if (table) {
      var cells = cellsWithTextInRange(range, table);
      if (cells.length > 1) {
        return refuse('multi-cell', HINT_MULTI_CELL);
      }
      if (cells.length === 0) {
        return refuse('whitespace', '');
      }
      var cellState = extractInto(createState(), cells[0], range);
      if (cellState.text.length > MAX_TEXT_CHARS) {
        return refuse('too-long', HINT_TOO_LONG);
      }
      return {
        ok: true,
        text: cellState.text,
        map: toMap(cellState),
        blocks: [cells[0]],
      };
    }

    var block = topLevelBlockFor(range.commonAncestorContainer, root);
    if (block && !classifyBlock(block).eligible) {
      return refuse('ineligible', HINT_INELIGIBLE);
    }
    // A code fence or diagram nested inside an eligible blockquote or list
    // item is still "not available for code or diagrams" (F2; F6 at any depth).
    if (nestedIneligibleAncestor(range.commonAncestorContainer, root)) {
      return refuse('ineligible', HINT_INELIGIBLE);
    }

    var result = extractRange(range, root);
    if (result.eligibleCount === 0) {
      return refuse('ineligible', HINT_INELIGIBLE);
    }
    if (!result.text) {
      return refuse('whitespace', '');
    }
    if (result.text.length > MAX_TEXT_CHARS) {
      return refuse('too-long', HINT_TOO_LONG);
    }
    return {
      ok: true,
      text: result.text,
      map: result.map,
      blocks: result.blocks,
    };
  }

  /**
   * The cells of `table` that `range` covers with at least one readable
   * character, at most two of them (the caller only needs "one" or "more").
   * Chromium switches to cell-based ranges, anchored on a <tr> or <tbody>, as
   * soon as a drag brushes a cell border, so the containers a range starts
   * and ends in say little; the cells it intersects with text decide (F2, D3).
   */
  function cellsWithTextInRange(range, table) {
    var found = [];
    var cells = table.querySelectorAll('td, th');
    for (var i = 0; i < cells.length && found.length < 2; i++) {
      var cell = cells[i];
      if (!rangeIntersectsElement(range, cell)) {
        continue;
      }
      if (extractInto(createState(), cell, range).text) {
        found.push(cell);
      }
    }
    return found;
  }

  // ---------------------------------------------------------------------------
  // Help context (`featrues/04-help-module.md` §3.1)
  //
  // The selection alone is not enough: a passage leans on terms the document
  // set up chapters earlier. The fields below are assembled from the DOM the
  // reader already extracts, so what the model sees is exactly what the
  // listener heard — code, tables, diagrams and math are already gone. Caps
  // are the host's business (src/read-aloud/messages.ts); these are the
  // rules for *which* text, not how much of it.
  // ---------------------------------------------------------------------------

  /** The line that stands in for the passage inside `<section>` (§14.2). */
  var PASSAGE_MARKER = '[PASSAGE]';

  /** 1–6 for h1–h6, 0 for anything else. */
  function headingLevel(el) {
    var tag = el && el.tagName ? el.tagName : '';
    return HEADING_TAGS[tag] ? parseInt(tag.charAt(1), 10) : 0;
  }

  /** Nearest direct child of `scope` containing (or equal to) `el`. */
  function topLevelOf(el, scope) {
    var current = nearestElement(el);
    while (current && current !== scope) {
      if (current.parentElement === scope) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  /**
   * `{ title, breadcrumb, before, after, section }` for a selection of the
   * direct children `els` of `scope`.
   *
   * - **title**: the first `h1` of the scope, else ''; the caller falls back
   *   to the file name.
   * - **breadcrumb**: the headings above the passage, nearest of each level,
   *   outermost first — h2 > h3 rather than every h3 on the way down.
   * - **before** / **after**: the one eligible block either side.
   * - **section**: the eligible blocks from the nearest preceding heading to
   *   the next heading of the same or a higher level, minus before, the
   *   passage and after, with {@link PASSAGE_MARKER} where the passage sits.
   * - **enclosing** (11 help fixes): the block(s) the passage was taken from —
   *   in a table, the row with its column headers — with the passage marked
   *   between {@link ENCLOSING_OPEN} and {@link ENCLOSING_CLOSE}; '' when the
   *   passage is the whole of them. `passageText` is the passage as resolved
   *   and `range` the live selection, when there is one, for the exact offset.
   * - **mentions**: for a passage of {@link HELP_TERM_MAX_WORDS} words or
   *   fewer, the document's other uses of those words outside this section
   *   (which is sent already), each under the heading it sits beneath.
   */
  function helpContext(scope, els, passageText, range) {
    var empty = {
      title: '',
      breadcrumb: [],
      before: '',
      after: '',
      section: '',
      enclosing: '',
      mentions: '',
    };
    if (!scope || !els || !els.length) {
      return empty;
    }
    var children = [];
    for (var c = 0; c < scope.children.length; c++) {
      children.push(scope.children[c]);
    }
    // A table-cell selection resolves to the cell, not to a child of the
    // scope: climb to the block the cell belongs to (its table).
    var first = -1;
    var last = -1;
    for (var e = 0; e < els.length; e++) {
      var top = topLevelOf(els[e], scope);
      var at = top ? children.indexOf(top) : -1;
      if (at < 0) {
        continue;
      }
      if (first < 0 || at < first) {
        first = at;
      }
      if (at > last) {
        last = at;
      }
    }
    if (first < 0) {
      return empty;
    }

    var title = '';
    for (var t = 0; t < children.length; t++) {
      if (children[t].tagName === 'H1') {
        title = extractText(children[t]).text;
        break;
      }
    }

    // Breadcrumb: walk back, keeping a heading only when it is *outside* the
    // one already kept, so h2 > h3 comes back rather than h3 > h3 > h3.
    var breadcrumb = [];
    var minLevel = 7;
    var enclosing = -1;
    for (var b = first - 1; b >= 0; b--) {
      var level = headingLevel(children[b]);
      if (!level || level >= minLevel) {
        continue;
      }
      if (enclosing < 0) {
        enclosing = b;
      }
      breadcrumb.unshift(extractText(children[b]).text);
      minLevel = level;
      if (level === 1) {
        break;
      }
    }

    function eligibleText(index) {
      return index >= 0 &&
        index < children.length &&
        classifyBlock(children[index]).eligible
        ? extractText(children[index]).text
        : '';
    }

    // The one eligible block either side, skipping anything unreadable
    // between (a fence, an image) rather than reporting nothing.
    var before = '';
    for (var i = first - 1; i >= 0 && !before; i--) {
      before = eligibleText(i);
    }
    var after = '';
    for (var j = last + 1; j < children.length && !after; j++) {
      after = eligibleText(j);
    }

    // The enclosing section: from the heading found above to the next heading
    // of the same or a higher level.
    var sectionStart = enclosing >= 0 ? enclosing + 1 : 0;
    var sectionLevel = enclosing >= 0 ? headingLevel(children[enclosing]) : 0;
    var sectionEnd = children.length;
    for (var k = last + 1; k < children.length; k++) {
      var next = headingLevel(children[k]);
      if (next && sectionLevel && next <= sectionLevel) {
        sectionEnd = k;
        break;
      }
    }
    var beforeIndex = -1;
    for (var bi = first - 1; bi >= 0; bi--) {
      if (classifyBlock(children[bi]).eligible) {
        beforeIndex = bi;
        break;
      }
    }
    var afterIndex = -1;
    for (var ai = last + 1; ai < children.length; ai++) {
      if (classifyBlock(children[ai]).eligible) {
        afterIndex = ai;
        break;
      }
    }
    var head = [];
    var tail = [];
    for (var s = sectionStart; s < sectionEnd; s++) {
      if (s === beforeIndex || s === afterIndex || (s >= first && s <= last)) {
        continue;
      }
      if (!classifyBlock(children[s]).eligible) {
        continue;
      }
      var text = extractText(children[s]).text;
      if (!text) {
        continue;
      }
      (s < first ? head : tail).push(text);
    }
    var section = head.concat([PASSAGE_MARKER]).concat(tail).join('\n\n');

    // 11 — the block the passage came from, and the rest of the document's
    // uses of a short passage. The section's heading and body are skipped by
    // the mention scan because they travel in the breadcrumb and <section>.
    var enclosingText = enclosingFor(
      children,
      first,
      last,
      els,
      passageText,
      range,
    );
    var mentions = helpMentions(
      children,
      enclosing >= 0 ? enclosing : sectionStart,
      sectionEnd,
      passageText,
    );

    return {
      title: title,
      breadcrumb: breadcrumb,
      before: before,
      after: after,
      section: section,
      enclosing: enclosingText,
      mentions: mentions,
    };
  }

  /** U+27E6 / U+27E7 — the brackets around the passage inside <enclosing>. */
  var ENCLOSING_OPEN = '\u27e6';
  var ENCLOSING_CLOSE = '\u27e7';

  /**
   * A passage of this many whitespace-separated words or fewer is a *term*
   * (help-prompt.ts `HELP_TERM_MAX_WORDS`, the same count): it gets the
   * document's other mentions, and the host gives it the four-part shape.
   */
  var HELP_TERM_MAX_WORDS = 5;

  /** Articles and small words dropped from the edges of a term before it is looked up. */
  var TERM_EDGE_WORDS = {
    the: 1,
    a: 1,
    an: 1,
    this: 1,
    that: 1,
    these: 1,
    those: 1,
    its: 1,
    their: 1,
    our: 1,
    your: 1,
    my: 1,
    his: 1,
    her: 1,
    some: 1,
    any: 1,
    each: 1,
    every: 1,
    all: 1,
    both: 1,
    no: 1,
    of: 1,
    in: 1,
    on: 1,
    to: 1,
    for: 1,
    by: 1,
    with: 1,
    as: 1,
    at: 1,
    or: 1,
    and: 1,
    is: 1,
    are: 1,
    was: 1,
    were: 1,
    be: 1,
  };

  /** At most this many mentions, each cut to this many characters. */
  var MENTION_MAX = 6;
  var MENTION_SNIPPET_CHARS = 280;
  var MENTION_HEADING_CHARS = 80;

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isTableCell(el) {
    return !!(el && (el.tagName === 'TD' || el.tagName === 'TH'));
  }

  /**
   * One table row as a line the model can read: "Header: cell; Header: cell"
   * when the table's first row is a header row of the same width, else the
   * cells joined with " | ". A glossary row keeps its column names this way.
   */
  function tableRowText(tr) {
    if (!tr) {
      return '';
    }
    var table = tr.closest ? tr.closest('table') : null;
    var headRow = table ? table.querySelector('tr') : null;
    var headers = [];
    if (headRow && headRow !== tr) {
      var ths = headRow.querySelectorAll('th');
      for (var h = 0; h < ths.length; h++) {
        headers.push(extractText(ths[h]).text);
      }
    }
    var cells = tr.querySelectorAll('th, td');
    var named = headers.length > 0 && headers.length === cells.length;
    var parts = [];
    for (var c = 0; c < cells.length; c++) {
      var cellText = extractText(cells[c]).text;
      if (!cellText) {
        continue;
      }
      parts.push(named && headers[c] ? headers[c] + ': ' + cellText : cellText);
    }
    return parts.join(named ? '; ' : ' | ');
  }

  /**
   * The text of the block(s) `first..last` of `children` — the row, for a
   * table-cell selection — with the passage marked. The live range gives the
   * exact offset of the selection in the first block, so the marked words are
   * the selected ones even when the block repeats them.
   */
  function enclosingFor(children, first, last, els, text, range) {
    var texts = [];
    var exact = -1;
    if (els.length === 1 && isTableCell(els[0])) {
      texts.push(tableRowText(els[0].closest('tr')));
    } else {
      for (var s = first; s <= last; s++) {
        if (!classifyBlock(children[s]).eligible) {
          continue;
        }
        var extracted = extractText(children[s]);
        if (!extracted.text) {
          continue;
        }
        if (s === first && range && range.startContainer) {
          try {
            exact = caretToTextOffset(
              extracted.map,
              range.startContainer,
              range.startOffset,
            );
          } catch (error) {
            exact = -1;
          }
        }
        texts.push(extracted.text);
      }
    }
    return markPassageIn(texts, text, exact);
  }

  /**
   * `blockTexts` joined by blank lines with `passage` marked between the
   * brackets: at `exactStart` when the passage really starts there, else at
   * its first occurrence, else — a selection over several blocks is clipped
   * and '\n'-joined, so it is not a substring — in the whitespace-flattened
   * text. '' when the passage is the whole of the blocks (nothing to add), the
   * blocks unmarked when the passage cannot be found in them at all.
   */
  function markPassageIn(blockTexts, passage, exactStart) {
    var text = typeof passage === 'string' ? passage.trim() : '';
    var parts = [];
    for (var i = 0; i < blockTexts.length; i++) {
      if (blockTexts[i]) {
        parts.push(blockTexts[i]);
      }
    }
    var joined = parts.join('\n\n');
    if (!text || !joined) {
      return '';
    }
    var start = -1;
    if (typeof exactStart === 'number' && exactStart >= 0) {
      var at = exactStart;
      while (at < joined.length && isWhitespaceCode(joined.charCodeAt(at))) {
        at++;
      }
      if (joined.substr(at, text.length) === text) {
        start = at;
      }
    }
    if (start < 0) {
      start = joined.indexOf(text);
    }
    var end = start + text.length;
    if (start < 0) {
      var flat = joined.replace(/\s+/g, ' ');
      var flatText = text.replace(/\s+/g, ' ');
      start = flat.indexOf(flatText);
      if (start < 0) {
        return joined;
      }
      joined = flat;
      end = start + flatText.length;
    }
    if (start === 0 && end >= joined.length) {
      return '';
    }
    return (
      joined.slice(0, start) +
      ENCLOSING_OPEN +
      joined.slice(start, end) +
      ENCLOSING_CLOSE +
      joined.slice(end)
    );
  }

  /**
   * The words of a term to look up: lower-cased, punctuation dropped, the
   * small words of {@link TERM_EDGE_WORDS} taken off both ends ("the metrics"
   * → ["metrics"]). [] for a passage of more than {@link HELP_TERM_MAX_WORDS}
   * words, which is a passage and not a term.
   */
  function termKey(passage) {
    var text = typeof passage === 'string' ? passage.trim() : '';
    if (!text || text.split(/\s+/).length > HELP_TERM_MAX_WORDS) {
      return [];
    }
    var raw = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s'\u2019-]+/gu, ' ')
      .split(/\s+/);
    var words = [];
    for (var i = 0; i < raw.length; i++) {
      var word = raw[i].replace(/^['\u2019-]+|['\u2019-]+$/g, '');
      if (word) {
        words.push(word);
      }
    }
    while (words.length > 1 && TERM_EDGE_WORDS[words[0]]) {
      words.shift();
    }
    while (words.length > 1 && TERM_EDGE_WORDS[words[words.length - 1]]) {
      words.pop();
    }
    return words;
  }

  /**
   * A case-insensitive whole-word pattern for the words of {@link termKey},
   * any whitespace between them, the last word with or without a plural s
   * ("metric" finds "metrics", "metrics" finds "metric"). Null for no words.
   */
  function termPattern(words) {
    if (!words || !words.length) {
      return null;
    }
    var parts = [];
    for (var i = 0; i < words.length; i++) {
      parts.push(escapeRegExp(words[i]));
    }
    var last = words[words.length - 1];
    parts[parts.length - 1] = /s$/.test(last)
      ? escapeRegExp(last.slice(0, -1)) + 's?'
      : escapeRegExp(last) + '(?:e?s)?';
    try {
      return new RegExp(
        '(?<![\\p{L}\\p{N}])' + parts.join('\\s+') + '(?![\\p{L}\\p{N}])',
        'iu',
      );
    } catch (error) {
      return null;
    }
  }

  /**
   * The lines of one top-level block a mention scan reads: each row of a
   * table (the one block kind a read skips that still carries prose), each
   * item of a list (so a sources list yields the one matching entry, not its
   * neighbours), the extracted text of any other eligible block, nothing for
   * code, math or diagrams.
   */
  function mentionTexts(el) {
    if (!el || el.nodeType !== ELEMENT_NODE) {
      return [];
    }
    var lines = [];
    var parts;
    var i;
    if (el.tagName === 'TABLE') {
      parts = el.querySelectorAll('tr');
      for (i = 0; i < parts.length; i++) {
        var row = tableRowText(parts[i]);
        if (row) {
          lines.push(row);
        }
      }
      return lines;
    }
    if (!classifyBlock(el).eligible) {
      return [];
    }
    if (el.tagName === 'UL' || el.tagName === 'OL') {
      parts = el.querySelectorAll(':scope > li');
      for (i = 0; i < parts.length; i++) {
        var item = extractText(parts[i]).text;
        if (item) {
          lines.push(item);
        }
      }
      return lines;
    }
    var text = extractText(el).text;
    return text ? [text] : [];
  }

  /** The nearest heading above `children[index]`, cut for a label, or ''. */
  function nearestHeadingText(children, index) {
    for (var b = index - 1; b >= 0; b--) {
      if (headingLevel(children[b])) {
        return extractText(children[b]).text.slice(0, MENTION_HEADING_CHARS);
      }
    }
    return '';
  }

  /**
   * `text` cut to {@link MENTION_SNIPPET_CHARS} around the match at
   * `index`, on word boundaries, with an ellipsis on each cut side.
   */
  function mentionSnippet(text, index, length) {
    if (text.length <= MENTION_SNIPPET_CHARS) {
      return text;
    }
    var room = MENTION_SNIPPET_CHARS - length;
    var start = Math.max(0, index - Math.floor(room / 2));
    var end = Math.min(text.length, start + MENTION_SNIPPET_CHARS);
    start = Math.max(0, end - MENTION_SNIPPET_CHARS);
    if (start > 0) {
      var firstSpace = text.indexOf(' ', start);
      if (firstSpace >= 0 && firstSpace < index) {
        start = firstSpace + 1;
      }
    }
    if (end < text.length) {
      var lastSpace = text.lastIndexOf(' ', end);
      if (lastSpace > index + length) {
        end = lastSpace;
      }
    }
    return (
      (start > 0 ? '\u2026' : '') +
      text.slice(start, end) +
      (end < text.length ? '\u2026' : '')
    );
  }

  /**
   * Up to {@link MENTION_MAX} other places in `children` that use the words
   * of `passage` (see {@link termKey}), skipping `skipFrom..skipTo` — the
   * section the request already carries — each as
   * `Under "Heading": …snippet…`, blank-line separated. '' for a passage
   * that is not a term, or when nothing else mentions it.
   */
  function helpMentions(children, skipFrom, skipTo, passage) {
    var pattern = termPattern(termKey(passage));
    if (!pattern) {
      return '';
    }
    var found = [];
    for (var i = 0; i < children.length && found.length < MENTION_MAX; i++) {
      if (i >= skipFrom && i < skipTo) {
        continue;
      }
      var lines = mentionTexts(children[i]);
      for (var t = 0; t < lines.length && found.length < MENTION_MAX; t++) {
        var match = pattern.exec(lines[t]);
        if (!match) {
          continue;
        }
        var heading = nearestHeadingText(children, i);
        found.push(
          (heading ? 'Under "' + heading + '": ' : '') +
            mentionSnippet(lines[t], match.index, match[0].length),
        );
      }
    }
    return found.join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // Click to read (F17)
  // ---------------------------------------------------------------------------

  /**
   * Text offset, in `map`, of the first mapped character at or after the
   * caret (node, offset); `map.text.length` when the caret is past every
   * mapped character. Binary search over the segments, which are in document
   * order, comparing each segment's end with the caret through a Range.
   */
  function caretToTextOffset(map, node, offset) {
    var segments = map && map.segments ? map.segments : [];
    if (!segments.length) {
      return 0;
    }
    var doc = node.ownerDocument;
    var caret = doc.createRange();
    caret.setStart(node, offset);
    caret.collapse(true);
    var probe = doc.createRange();
    var lo = 0;
    var hi = segments.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      var seg = segments[mid];
      probe.setStart(seg.node, seg.domStart + (seg.textEnd - seg.textStart));
      probe.collapse(true);
      if (caret.compareBoundaryPoints(START_TO_START, probe) < 0) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    if (lo >= segments.length) {
      return map.text.length;
    }
    var first = segments[lo];
    if (first.node === node && offset > first.domStart) {
      return first.textStart + (offset - first.domStart);
    }
    return first.textStart;
  }

  /**
   * `{ start, end }` of the word the caret at `offset` belongs to: the word
   * containing the offset, or the word that ends exactly there (a click on
   * the right half of a word's last letter). Null when no word is adjacent.
   */
  function wordAt(text, offset) {
    var length = text.length;
    if (offset > length) {
      offset = length;
    }
    if (offset < 0) {
      offset = 0;
    }
    var start = offset;
    var end = offset;
    if (offset < length && !isWhitespaceCode(text.charCodeAt(offset))) {
      while (end < length && !isWhitespaceCode(text.charCodeAt(end))) {
        end++;
      }
    } else if (offset === 0 || isWhitespaceCode(text.charCodeAt(offset - 1))) {
      return null;
    }
    while (start > 0 && !isWhitespaceCode(text.charCodeAt(start - 1))) {
      start--;
    }
    return { start: start, end: end };
  }

  /**
   * `{ text, map }` of a whole-block extraction from text offset `start`
   * on, rebased so the new text starts at 0. Leading whitespace after the
   * cut is dropped, so the result is always trimmed (the host rejects
   * untrimmed text). Segments keep their DOM nodes; a segment the cut splits
   * is trimmed in place.
   */
  function sliceExtraction(extracted, start) {
    var text = extracted.text;
    var segments = extracted.map.segments;
    if (!(start > 0)) {
      return { text: text, map: { text: text, segments: segments.slice() } };
    }
    while (start < text.length && isWhitespaceCode(text.charCodeAt(start))) {
      start++;
    }
    var out = [];
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (seg.textEnd <= start) {
        continue;
      }
      var from = seg.textStart < start ? start : seg.textStart;
      out.push({
        textStart: from - start,
        textEnd: seg.textEnd - start,
        node: seg.node,
        domStart: seg.domStart + (from - seg.textStart),
      });
    }
    var rest = text.slice(start);
    return { text: rest, map: { text: rest, segments: out } };
  }

  /**
   * Decide what a click at the caret (node, offset) reads (F17): the reading
   * unit is the table cell around the caret, else the top-level block, and
   * reading starts at the word under the caret (the nearest word when the
   * caret sits on a space or at the end of a line, decision 9). The result
   * carries the whole-unit extraction so the caller can slice it after any
   * teardown.
   *
   * Refusals: `outside` (not in the preview), `interactive` (a link, a
   * checkbox, our own UI), `ineligible` (F6, at any depth: a click *on*
   * inline math or a nested fence is refused, one on the prose beside it is
   * not), `empty` (no word at the caret).
   */
  function resolveClick(node, offset, root) {
    if (!node || !root || !isInsideRoot(root, node)) {
      return refuse('outside', '');
    }
    var el = nearestElement(node);
    if (closestWithin(el, INTERACTIVE_SELECTOR, root)) {
      return refuse('interactive', '');
    }
    var unit;
    var target;
    var cell = closestWithin(el, 'td, th', root);
    if (cell) {
      var table = closestWithin(cell, 'table', root);
      if (
        closestWithin(el, INELIGIBLE_BLOCK_SELECTOR, cell) ||
        (table && nestedIneligibleAncestor(table.parentElement, root))
      ) {
        return refuse('ineligible', HINT_INELIGIBLE);
      }
      unit = 'cell';
      target = cell;
    } else {
      var block = topLevelBlockFor(node, root);
      if (!block) {
        return refuse('outside', '');
      }
      if (
        !classifyBlock(block).eligible ||
        nestedIneligibleAncestor(node, root)
      ) {
        return refuse('ineligible', HINT_INELIGIBLE);
      }
      unit = 'block';
      target = block;
    }
    var whole = extractText(target);
    if (!whole.text) {
      return refuse('empty', '');
    }
    var word = wordAt(whole.text, caretToTextOffset(whole.map, node, offset));
    if (!word) {
      return refuse('empty', '');
    }
    return {
      ok: true,
      unit: unit,
      el: target,
      wholeText: whole.text,
      wholeMap: whole.map,
      start: word.start,
      wordEnd: word.end,
    };
  }

  // ---------------------------------------------------------------------------
  // Reading decoration: line pills (F4 look)
  // ---------------------------------------------------------------------------

  function isUiElement(el) {
    var set = classSet(el);
    return !!(set && (set['mpe-ra-ui'] || set['mpe-ra-btn']));
  }

  function hasNonWhitespace(str) {
    for (var i = 0; i < str.length; i++) {
      if (!isWhitespaceCode(str.charCodeAt(i))) {
        return true;
      }
    }
    return false;
  }

  /** A run gets a pill only when it would render something. */
  function runHasContent(run) {
    for (var i = 0; i < run.length; i++) {
      var node = run[i];
      if (node.nodeType === TEXT_NODE) {
        if (hasNonWhitespace(node.data)) {
          return true;
        }
      } else if (node.nodeType === ELEMENT_NODE) {
        if (REPLACED_TAGS[node.tagName] || node.tagName === 'BR') {
          return true;
        }
        if (hasNonWhitespace(node.textContent || '')) {
          return true;
        }
        if (node.getElementsByTagName('img').length > 0) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Wrap every run of consecutive inline-level children of `el` in a
   * PILL_CLASS span and recurse into block-level children (list items,
   * nested lists, blockquote paragraphs). Text nodes are moved, never split
   * or copied, so an offset map built before the call stays valid after it.
   * Existing pills are kept, which makes the function idempotent. Code
   * fences, tables, diagrams and the other INELIGIBLE_BLOCK_SELECTOR
   * elements are left untouched; so is the play button.
   */
  function wrapInlineRuns(el, out) {
    var doc = el.ownerDocument;
    var children = Array.prototype.slice.call(el.childNodes);
    var run = [];

    function flush() {
      if (run.length && runHasContent(run)) {
        var span = doc.createElement('span');
        span.className = PILL_CLASS;
        el.insertBefore(span, run[0]);
        for (var k = 0; k < run.length; k++) {
          span.appendChild(run[k]);
        }
        out.push(span);
      }
      run = [];
    }

    for (var i = 0; i < children.length; i++) {
      var node = children[i];
      if (node.nodeType === ELEMENT_NODE) {
        if (isUiElement(node)) {
          flush();
          continue;
        }
        var set = classSet(node);
        if (set && set[PILL_CLASS]) {
          flush();
          out.push(node);
          continue;
        }
        var ineligible = matchesSelector(node, INELIGIBLE_BLOCK_SELECTOR);
        if (ineligible || BLOCK_TAGS[node.tagName]) {
          flush();
          if (!ineligible && !isSkippedElement(node)) {
            wrapInlineRuns(node, out);
          }
          continue;
        }
      }
      run.push(node);
    }
    flush();
    return out;
  }

  /** Move `span`'s children out in place and drop the span. */
  function unwrapElement(span) {
    var parent = span.parentNode;
    if (!parent) {
      return;
    }
    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span);
    }
    parent.removeChild(span);
  }

  /** Mark `el` as the block being read and pill its lines. Returns the pills. */
  function decorateReadingBlock(el) {
    if (!el || el.nodeType !== ELEMENT_NODE) {
      return [];
    }
    el.classList.add(READING_CLASS);
    return wrapInlineRuns(el, []);
  }

  /** Undo decorateReadingBlock: the child list is restored node for node. */
  function undecorateReadingBlock(el) {
    if (!el || el.nodeType !== ELEMENT_NODE) {
      return;
    }
    el.classList.remove(READING_CLASS);
    var pills = el.getElementsByClassName(PILL_CLASS);
    // Live collection: unwrap from the end so indexes stay stable.
    for (var i = pills.length - 1; i >= 0; i--) {
      unwrapElement(pills[i]);
    }
  }

  // ---------------------------------------------------------------------------
  // Reading decoration: the spoken word (F4)
  // ---------------------------------------------------------------------------

  /** `{ node, from, to }` for every text node `range` touches, in order. */
  function textPiecesInRange(range) {
    var start = range.startContainer;
    if (start === range.endContainer && start.nodeType === TEXT_NODE) {
      return [{ node: start, from: range.startOffset, to: range.endOffset }];
    }
    var ancestor = range.commonAncestorContainer;
    var el =
      ancestor.nodeType === ELEMENT_NODE ? ancestor : ancestor.parentNode;
    if (!el) {
      return [];
    }
    var walker = el.ownerDocument.createTreeWalker(el, SHOW_TEXT, null);
    var pieces = [];
    var node = walker.nextNode();
    while (node) {
      var clip = clipToRange(node, range);
      if (clip) {
        pieces.push({ node: node, from: clip.from, to: clip.to });
      }
      node = walker.nextNode();
    }
    return pieces;
  }

  /**
   * Wrap the text covered by `range` in `className` spans, one per text node
   * touched (a word split across an inline element boundary gets two). The
   * first span also gets `className + '-start'` and the last
   * `className + '-end'`, so CSS can round only the outer corners.
   *
   * Text nodes are split with `splitText`, which keeps the original node as
   * the first piece; unwrapSpans merges the pieces back into it, so node
   * identity, and with it the offset map, survives a wrap/unwrap cycle.
   */
  function wrapRange(range, className) {
    return wrapPieces(textPiecesInRange(range), className);
  }

  /** wrapRange over pieces taken beforehand (see wrapWord for why). */
  function wrapPieces(pieces, className) {
    var spans = [];
    for (var i = 0; i < pieces.length; i++) {
      var piece = pieces[i];
      var node = piece.node;
      if (!node.parentNode || piece.to <= piece.from) {
        continue;
      }
      var target = piece.from > 0 ? node.splitText(piece.from) : node;
      if (piece.to - piece.from < target.data.length) {
        target.splitText(piece.to - piece.from);
      }
      var span = node.ownerDocument.createElement('span');
      span.className = className;
      target.parentNode.insertBefore(span, target);
      span.appendChild(target);
      spans.push(span);
    }
    if (spans.length) {
      spans[0].classList.add(className + '-start');
      spans[spans.length - 1].classList.add(className + '-end');
    }
    return spans;
  }

  /**
   * Paint one word: wrap the text `span` covers in WORD_CLASS spans and the
   * characters touching it (wordEdges) in WORD_EDGE_CLASS spans. Returns
   * every span made, the word's first, so the caller can scroll to the word
   * and hand the whole list to unwrapSpans. Nothing is wrapped when the word
   * itself cannot be resolved.
   *
   * The pieces of all three ranges are taken before any node is split and
   * wrapped last to first in document order: splitText keeps the original
   * node as the head, so a piece that comes earlier in the same node keeps
   * its offsets while a later one is being wrapped.
   */
  function wrapWord(map, span, doc) {
    var range = spanToRange(map, span, doc);
    if (!range) {
      return [];
    }
    var wordPieces = textPiecesInRange(range);
    if (!wordPieces.length) {
      return [];
    }
    var edges = wordEdges(map, span);
    var before = edges.before
      ? offsetsToRange(map, edges.before.from, edges.before.to, doc)
      : null;
    var after = edges.after
      ? offsetsToRange(map, edges.after.from, edges.after.to, doc)
      : null;
    var beforePieces = before ? textPiecesInRange(before) : [];
    var afterPieces = after ? textPiecesInRange(after) : [];
    var afterSpans = wrapPieces(afterPieces, WORD_EDGE_CLASS);
    var wordSpans = wrapPieces(wordPieces, WORD_CLASS);
    var beforeSpans = wrapPieces(beforePieces, WORD_EDGE_CLASS);
    return wordSpans.concat(afterSpans, beforeSpans);
  }

  /**
   * Merge the run of adjacent text nodes around `node` into its first node,
   * i.e. the node `splitText` started from. Only siblings are touched, so
   * adjacent text nodes elsewhere in the document are left alone (unlike
   * `Node.normalize`).
   */
  function mergeTextRun(node) {
    var first = node;
    while (
      first.previousSibling &&
      first.previousSibling.nodeType === TEXT_NODE
    ) {
      first = first.previousSibling;
    }
    var next = first.nextSibling;
    while (next && next.nodeType === TEXT_NODE) {
      var after = next.nextSibling;
      first.appendData(next.data);
      next.parentNode.removeChild(next);
      next = after;
    }
  }

  /** Undo wrapRange. Safe on spans that are already detached. */
  function unwrapSpans(spans) {
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i];
      if (!span || !span.parentNode) {
        continue;
      }
      var first = span.firstChild;
      unwrapElement(span);
      if (first && first.nodeType === TEXT_NODE && first.parentNode) {
        mergeTextRun(first);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Highlight theme helpers
  // ---------------------------------------------------------------------------

  /** One of HIGHLIGHT_THEMES; anything else falls back to the default. */
  function normaliseHighlightTheme(value) {
    return typeof value === 'string' && HIGHLIGHT_THEMES.indexOf(value) >= 0
      ? value
      : DEFAULT_HIGHLIGHT_THEME;
  }

  /** One of PLAYER_FONTS' ids; anything else falls back to `default`. */
  function normalisePlayerFont(value) {
    if (typeof value === 'string') {
      for (var i = 0; i < PLAYER_FONTS.length; i++) {
        if (PLAYER_FONTS[i].id === value) {
          return value;
        }
      }
    }
    return DEFAULT_PLAYER_FONT;
  }

  /** The CSS font-family stack of a font id; '' for the theme's own font. */
  function playerFontStack(value) {
    var id = normalisePlayerFont(value);
    for (var i = 0; i < PLAYER_FONTS.length; i++) {
      if (PLAYER_FONTS[i].id === id) {
        return PLAYER_FONTS[i].stack;
      }
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // The low-strain page (05 §4.2): the Global theme and its resolution
  // ---------------------------------------------------------------------------

  /** One of GLOBAL_THEMES; anything else falls back to `auto`. */
  function normaliseGlobalTheme(value) {
    return typeof value === 'string' && GLOBAL_THEMES.indexOf(value) >= 0
      ? value
      : DEFAULT_GLOBAL_THEME;
  }

  // ---------------------------------------------------------------------------
  // Eye strain 2 (07): the text size and what derives from it
  // ---------------------------------------------------------------------------

  /**
   * Whole pixels, clamped to the slider's range; anything that is not a
   * finite number is the default (07 §5.1).
   */
  function clampTextSize(value) {
    if (typeof value !== 'number' || !isFinite(value)) {
      return DEFAULT_TEXT_SIZE;
    }
    return Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, Math.round(value)));
  }

  /**
   * The line height for a text size (07 §5.2): 1.70 at 16 px down to 1.45 at
   * 26 px and above, anchored at 1.60 for 20 px. Leading grows as the type
   * gets smaller — the return sweep needs proportionally more separation —
   * and shrinks as it gets larger, where 1.6 leaves gaps that read as rivers.
   * Rounded on the integer-and-a-half value, so 152.5 is 153 and not a float
   * artefact.
   */
  function deriveLineHeight(size) {
    var px = clampTextSize(size);
    var hundredths = Math.round(160 - (px - 20) * 2.5);
    return Math.min(1.7, Math.max(1.45, hundredths / 100));
  }

  /**
   * The average advance of the face in em (07 §6.2), from the width of the
   * laid-out sample and the width of a 100 em reference measured in the same
   * coordinate space — which divides out the font size and any body zoom.
   * The default when either width is not a positive finite number.
   */
  function charEmFrom(sampleWidth, referenceWidth, sampleLength) {
    var length =
      typeof sampleLength === 'number' && sampleLength > 0
        ? sampleLength
        : MEASURE_SAMPLE.length;
    if (
      typeof sampleWidth !== 'number' ||
      typeof referenceWidth !== 'number' ||
      !isFinite(sampleWidth) ||
      !isFinite(referenceWidth) ||
      !(sampleWidth > 0) ||
      !(referenceWidth > 0)
    ) {
      return DEFAULT_CHAR_EM;
    }
    var charEm = sampleWidth / length / (referenceWidth / 100);
    if (!isFinite(charEm) || !(charEm > 0)) {
      return DEFAULT_CHAR_EM;
    }
    return Math.round(charEm * 10000) / 10000;
  }

  /** One of WORD_MARKERS; anything else falls back to the underline. */
  function normaliseWordMarker(value) {
    return typeof value === 'string' && WORD_MARKERS.indexOf(value) >= 0
      ? value
      : DEFAULT_WORD_MARKER;
  }

  /**
   * One frame of the follow-the-reading scroll (07 §7.1). With the word's
   * top inside the band and no ease under way the position is left alone;
   * otherwise the target puts the word's top at the anchor, reached at once
   * under reduced motion and by a fraction of the remaining distance per
   * frame otherwise, until the remainder is below `settlePx`.
   *
   * @param {{ wordTop: number, viewportHeight: number, scrollTop: number,
   *           anchor: number, bandTop: number, bandBottom: number,
   *           ease: number, settlePx: number, reduced: boolean,
   *           moving: boolean }} input
   * @returns {{ scrollTop: number, moving: boolean }}
   */
  function followStep(input) {
    var wordTop = input.wordTop;
    var height = input.viewportHeight;
    var scrollTop = input.scrollTop;
    var inBand =
      wordTop >= input.bandTop * height && wordTop <= input.bandBottom * height;
    if (inBand && !input.moving) {
      return { scrollTop: scrollTop, moving: false };
    }
    var target = scrollTop + wordTop - input.anchor * height;
    if (input.reduced) {
      return { scrollTop: target, moving: false };
    }
    var remaining = target - scrollTop;
    if (Math.abs(remaining) <= input.settlePx) {
      return { scrollTop: target, moving: false };
    }
    var next = scrollTop + remaining * input.ease;
    if (Math.abs(target - next) <= input.settlePx) {
      return { scrollTop: target, moving: false };
    }
    return { scrollTop: next, moving: true };
  }

  /**
   * The pause before the next block starts (07 §11): longer after a heading,
   * divided by the playback rate so a 2× listener waits half as long.
   */
  function blockGapMs(previousEl, rate) {
    var tag =
      previousEl && typeof previousEl.tagName === 'string'
        ? previousEl.tagName.toUpperCase()
        : '';
    var gap = HEADING_TAGS[tag] ? HEADING_GAP_MS : BLOCK_GAP_MS;
    var speed =
      typeof rate === 'number' && isFinite(rate) && rate > 0 ? rate : 1;
    return Math.round(gap / speed);
  }

  /**
   * The dim tier of the block at `index` in a read (07 §8.1): the block being
   * read is active, the next is pre-warmed (near), every other readable block
   * is far.
   */
  function tierFor(index, activeIndex, nextIndex) {
    if (index === activeIndex) {
      return 'active';
    }
    if (index === nextIndex) {
      return 'near';
    }
    return 'far';
  }

  /**
   * Which page to show for a Global theme: 'light', 'dark', or null for off.
   *
   * `auto` follows VS Code's colour theme kind, read from the body classes
   * VS Code documents for webviews (`vscode-light`, `vscode-dark`,
   * `vscode-high-contrast`, `vscode-high-contrast-light`), in the same order
   * detectScheme's fallback has always tested them; before <body> exists, or
   * with no class on it, `prefers-color-scheme` — which in desktop VS Code
   * already follows the colour theme kind — decides instead.
   *
   * @param {string} mode  one of GLOBAL_THEMES
   * @param {{ bodyClasses?: string, prefersDark?: boolean }} env
   */
  function resolvePageScheme(mode, env) {
    var theme = normaliseGlobalTheme(mode);
    if (theme === 'off') {
      return null;
    }
    if (theme === 'light' || theme === 'dark') {
      return theme;
    }
    var classes =
      env && typeof env.bodyClasses === 'string' ? env.bodyClasses : '';
    if (/\bvscode-high-contrast-light\b/.test(classes)) {
      return 'light';
    }
    if (/\bvscode-(dark|high-contrast)\b/.test(classes)) {
      return 'dark';
    }
    if (/\bvscode-light\b/.test(classes)) {
      return 'light';
    }
    return env && env.prefersDark ? 'dark' : 'light';
  }

  var RGB_RE =
    /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i;
  var HEX_RE = /^#([0-9a-f]{3,8})$/i;

  /**
   * Luma (0..1, gamma-encoded Rec. 709 weights) of a computed CSS colour, or
   * null when it is transparent or not a colour this parser understands.
   * Used to pick the light or dark palette from the preview background.
   */
  function backgroundLuminance(cssColor) {
    if (typeof cssColor !== 'string') {
      return null;
    }
    var value = cssColor.trim();
    var r;
    var g;
    var b;
    var a = 1;
    var m = RGB_RE.exec(value);
    if (m) {
      r = parseFloat(m[1]);
      g = parseFloat(m[2]);
      b = parseFloat(m[3]);
      if (m[4] !== undefined) {
        a =
          m[4].charAt(m[4].length - 1) === '%'
            ? parseFloat(m[4]) / 100
            : parseFloat(m[4]);
      }
    } else if ((m = HEX_RE.exec(value))) {
      var hex = m[1];
      if (hex.length === 3 || hex.length === 4) {
        hex = hex.replace(/./g, function (c) {
          return c + c;
        });
      }
      if (hex.length !== 6 && hex.length !== 8) {
        return null;
      }
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      if (hex.length === 8) {
        a = parseInt(hex.slice(6, 8), 16) / 255;
      }
    } else {
      return null;
    }
    if (!(a > 0) || !isFinite(r) || !isFinite(g) || !isFinite(b)) {
      return null;
    }
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  // ---------------------------------------------------------------------------
  // Notes: the anchor and re-anchoring (featrues/12-notes/spec.md §9)
  //
  // Pure functions over the top-level children of a scope. `noteAnchorFor`
  // is computed once, when a note is captured; `anchorNotes` runs on every
  // `readAloudNotes` and after every re-render and decides, note by note,
  // which block (and which words) a note belongs to now — by the block's
  // content key, then by the exact passage with its prefix and suffix, then
  // by a fuzzy match of the enclosing block — or that it is an orphan.
  // ---------------------------------------------------------------------------

  var NOTE_CONTEXT_CHARS = 64;
  var NOTE_FUZZY_THRESHOLD = 0.75;
  var NOTE_FUZZY_MIN_RATIO = 0.5;
  var NOTE_FUZZY_MAX_RATIO = 2;

  /**
   * The `data-source-line` of the nearest ancestor-or-self of `node`, up to
   * and including `top` — a list item's own line, a table row's — else null.
   */
  function sourceLineOf(node, top) {
    var el = nearestElement(node);
    while (el) {
      if (el.hasAttribute && el.hasAttribute('data-source-line')) {
        var value = parseInt(el.getAttribute('data-source-line'), 10);
        if (isFinite(value) && value >= 0) {
          return value;
        }
      }
      if (el === top) {
        break;
      }
      el = el.parentElement;
    }
    return null;
  }

  /** The cells of a table, extracted and joined with spaces (§9.2 step 2). */
  function tableSearchText(table) {
    if (!table || !table.querySelectorAll) {
      return '';
    }
    var cells = table.querySelectorAll('th, td');
    var parts = [];
    for (var i = 0; i < cells.length; i++) {
      var text = extractText(cells[i]).text;
      if (text) {
        parts.push(text);
      }
    }
    return parts.join(' ');
  }

  /** A candidate for anchoring: an eligible block, or a table (for cell notes). */
  function isAnchorCandidate(el) {
    if (!el || el.nodeType !== ELEMENT_NODE) {
      return false;
    }
    if (el.tagName === 'TABLE') {
      return true;
    }
    return classifyBlock(el).eligible;
  }

  /** `{ text, map }` a candidate is searched in; a table has no map. */
  function candidateExtraction(el) {
    if (el.tagName === 'TABLE') {
      return { text: tableSearchText(el), map: null };
    }
    return extractText(el);
  }

  /** The heading path above `index` among `children`, outermost first. */
  function headingPathOf(children, index) {
    var path = [];
    var minLevel = 7;
    for (var b = index - 1; b >= 0; b--) {
      var level = headingLevel(children[b]);
      if (!level || level >= minLevel) {
        continue;
      }
      path.unshift(extractText(children[b]).text);
      minLevel = level;
      if (level === 1) {
        break;
      }
    }
    return path;
  }

  /**
   * §9.1 — the anchor of a resolved selection (`resolveSelection`'s `ok`
   * result) inside `scope`, with the live `range` when there is one for the
   * exact offset. Null when the selection is not inside the scope.
   */
  function noteAnchorFor(resolved, scope, range) {
    if (
      !resolved ||
      !resolved.ok ||
      !resolved.blocks ||
      !resolved.blocks.length ||
      !scope
    ) {
      return null;
    }
    var first = resolved.blocks[0];
    var top = topLevelOf(first, scope);
    if (!top) {
      return null;
    }
    var cell = isTableCell(first);
    var whole = candidateExtraction(top);
    var exact = typeof resolved.text === 'string' ? resolved.text : '';
    var firstPart = exact.split('\n')[0];
    var offset = -1;
    if (!cell && whole.map && range && range.startContainer) {
      try {
        var caret = caretToTextOffset(
          whole.map,
          range.startContainer,
          range.startOffset,
        );
        if (typeof caret === 'number' && caret >= 0) {
          var at = caret;
          while (
            at < whole.text.length &&
            isWhitespaceCode(whole.text.charCodeAt(at))
          ) {
            at++;
          }
          if (whole.text.substr(at, firstPart.length) === firstPart) {
            offset = at;
          }
        }
      } catch (error) {
        offset = -1;
      }
    }
    if (offset < 0) {
      offset = whole.text.indexOf(firstPart);
    }
    if (offset < 0) {
      offset = 0;
    }
    var end = offset + firstPart.length;
    var tops = [];
    for (var b = 0; b < resolved.blocks.length; b++) {
      var t = topLevelOf(resolved.blocks[b], scope);
      if (t && tops.indexOf(t) < 0) {
        tops.push(t);
      }
    }
    var startNode =
      !cell && range && range.startContainer ? range.startContainer : first;
    return {
      block: blockKey(top, whole.text),
      line: sourceLineOf(startNode, top),
      exact: exact,
      prefix: whole.text.slice(
        Math.max(0, offset - NOTE_CONTEXT_CHARS),
        offset,
      ),
      suffix: whole.text.slice(end, end + NOTE_CONTEXT_CHARS),
      offset: offset,
      blocks: Math.max(1, tops.length),
    };
  }

  function bigramCounts(text) {
    var map = Object.create(null);
    var count = 0;
    for (var i = 0; i + 1 < text.length; i++) {
      var gram = text.substr(i, 2);
      map[gram] = (map[gram] || 0) + 1;
      count++;
    }
    return { map: map, count: count };
  }

  /** Sørensen–Dice over character bigrams, 0–1. */
  function bigramDice(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) {
      return 0;
    }
    if (a === b) {
      return 1;
    }
    var x = bigramCounts(a);
    var y = bigramCounts(b);
    if (!x.count || !y.count) {
      return 0;
    }
    var shared = 0;
    for (var gram in x.map) {
      if (y.map[gram]) {
        shared += Math.min(x.map[gram], y.map[gram]);
      }
    }
    return (2 * shared) / (x.count + y.count);
  }

  /**
   * How much of the stored `expected` context the candidate's `actual`
   * context repeats, counted from the passage outwards: 0–1. With nothing
   * stored there is nothing to contradict.
   */
  function contextScore(expected, actual, fromEnd) {
    if (!expected) {
      return actual ? 0.5 : 1;
    }
    var matched = 0;
    var n = Math.min(expected.length, actual.length);
    for (var i = 0; i < n; i++) {
      var e = fromEnd
        ? expected.charAt(expected.length - 1 - i)
        : expected.charAt(i);
      var a = fromEnd ? actual.charAt(actual.length - 1 - i) : actual.charAt(i);
      if (e !== a) {
        break;
      }
      matched++;
    }
    return matched / expected.length;
  }

  function lineDistance(a, b) {
    if (typeof a !== 'number' || typeof b !== 'number') {
      return Number.MAX_SAFE_INTEGER;
    }
    return Math.abs(a - b);
  }

  /** The stored enclosing block with the ⟦ ⟧ markers removed, whitespace flattened. */
  function enclosingPlain(note) {
    var text =
      note && note.context && typeof note.context.enclosing === 'string'
        ? note.context.enclosing
        : '';
    return text
      .split(ENCLOSING_OPEN)
      .join('')
      .split(ENCLOSING_CLOSE)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function storedLine(note) {
    var anchor = note.anchor || {};
    if (anchor.current && typeof anchor.current.line === 'number') {
      return anchor.current.line;
    }
    return typeof anchor.line === 'number' ? anchor.line : null;
  }

  /**
   * The continuation of a multi-block passage (§9.2): following candidates
   * whose text carries the next parts of the passage in order. Middle parts
   * must be whole blocks; the last part is the start of its block.
   */
  function continuationSpans(candidates, fromIndex, parts) {
    var spans = [];
    var k = 1;
    for (
      var c = fromIndex + 1;
      c < candidates.length && k < parts.length;
      c++
    ) {
      var candidate = candidates[c];
      var part = parts[k];
      var last = k === parts.length - 1;
      if (last ? candidate.text.indexOf(part) === 0 : candidate.text === part) {
        spans.push({
          el: candidate.el,
          map: candidate.map,
          start: 0,
          end: part.length,
        });
        k++;
      } else {
        break;
      }
    }
    return spans;
  }

  function found(note, candidate, step, start, end, parts, candidates) {
    var result = {
      noteId: note.id,
      found: true,
      step: step,
      el: candidate.el,
      index: candidate.index,
      block: candidate.key,
      line: candidate.line,
      text: candidate.text,
      map: candidate.map,
      start: start,
      end: end,
      spans: [],
    };
    if (start >= 0 && candidate.map) {
      result.spans.push({
        el: candidate.el,
        map: candidate.map,
        start: start,
        end: end,
      });
      if (parts.length > 1) {
        result.spans = result.spans.concat(
          continuationSpans(candidates, candidate.index, parts),
        );
      }
      var dom = offsetToDom(candidate.map, start);
      if (dom) {
        var line = sourceLineOf(dom.node, candidate.el);
        if (line !== null) {
          result.line = line;
        }
      }
    }
    return result;
  }

  /**
   * §9.2 — re-anchor `notes` against the top-level children of `scope`. One
   * extraction per candidate for the pass. Returns one result per note, in
   * the order given: `{ noteId, found, step, el, index, block, line, text,
   * map, start, end, spans }`, with `found: false` and `step: 0` for an orphan.
   */
  function anchorNotes(scope, notes) {
    var results = [];
    if (!scope || !notes || !notes.length) {
      return results;
    }
    var children = [];
    for (var c = 0; c < scope.children.length; c++) {
      children.push(scope.children[c]);
    }
    var candidates = [];
    var byKey = Object.create(null);
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      if (!isAnchorCandidate(el)) {
        continue;
      }
      var extracted = candidateExtraction(el);
      if (!extracted.text) {
        continue;
      }
      var candidate = {
        el: el,
        index: candidates.length,
        childIndex: i,
        text: extracted.text,
        map: extracted.map,
        key: blockKey(el, extracted.text),
        line: sourceLineOf(el, el),
        path: null,
      };
      candidates.push(candidate);
      (byKey[candidate.key] = byKey[candidate.key] || []).push(candidate);
    }

    var byId = Object.create(null);
    var order = notes.slice().sort(function (a, b) {
      var la = storedLine(a);
      var lb = storedLine(b);
      if (la === null && lb === null) {
        return 0;
      }
      if (la === null) {
        return 1;
      }
      if (lb === null) {
        return -1;
      }
      return la - lb;
    });

    // Step 1 — block key. Identical blocks are told apart by the stored
    // line, and consumed in document order when no line is known.
    var cursor = Object.create(null);
    var remaining = [];
    for (var n = 0; n < order.length; n++) {
      var note = order[n];
      var anchor = note.anchor || {};
      var parts = String(anchor.exact || '').split('\n');
      var keys = [];
      if (anchor.current && anchor.current.block) {
        keys.push(anchor.current.block);
      }
      if (anchor.block && keys.indexOf(anchor.block) < 0) {
        keys.push(anchor.block);
      }
      var hit = null;
      for (var k = 0; k < keys.length && !hit; k++) {
        var list = byKey[keys[k]];
        if (!list || !list.length) {
          continue;
        }
        var want = storedLine(note);
        if (list.length === 1) {
          hit = list[0];
        } else if (want !== null) {
          var best = null;
          var bestDistance = Infinity;
          for (var l = 0; l < list.length; l++) {
            var distance = lineDistance(list[l].line, want);
            if (distance < bestDistance) {
              best = list[l];
              bestDistance = distance;
            }
          }
          hit = best;
        } else {
          var used = cursor[keys[k]] || 0;
          hit = list[Math.min(used, list.length - 1)];
          cursor[keys[k]] = used + 1;
        }
      }
      if (!hit) {
        remaining.push(note);
        continue;
      }
      var start = -1;
      if (
        typeof anchor.offset === 'number' &&
        hit.text.substr(anchor.offset, parts[0].length) === parts[0]
      ) {
        start = anchor.offset;
      } else {
        start = hit.text.indexOf(parts[0]);
      }
      byId[note.id] = found(
        note,
        hit,
        1,
        start,
        start >= 0 ? start + parts[0].length : -1,
        parts,
        candidates,
      );
    }

    // Step 2 — the exact passage, scored by prefix, suffix, line, order.
    var stillRemaining = [];
    for (var r = 0; r < remaining.length; r++) {
      var note2 = remaining[r];
      var anchor2 = note2.anchor || {};
      var parts2 = String(anchor2.exact || '').split('\n');
      var needle = parts2[0];
      var occurrences = [];
      if (needle) {
        for (var ci = 0; ci < candidates.length; ci++) {
          var text = candidates[ci].text;
          var from = 0;
          var at;
          while ((at = text.indexOf(needle, from)) >= 0) {
            occurrences.push({ candidate: candidates[ci], start: at });
            from = at + Math.max(1, needle.length);
          }
        }
      }
      if (!occurrences.length) {
        stillRemaining.push(note2);
        continue;
      }
      var chosen = occurrences[0];
      if (occurrences.length > 1) {
        var want2 = storedLine(note2);
        var scored = occurrences.map(function (occurrence, position) {
          var textAt = occurrence.candidate.text;
          var before = textAt.slice(
            Math.max(0, occurrence.start - NOTE_CONTEXT_CHARS),
            occurrence.start,
          );
          var after = textAt.slice(
            occurrence.start + needle.length,
            occurrence.start + needle.length + NOTE_CONTEXT_CHARS,
          );
          return {
            occurrence: occurrence,
            score:
              contextScore(anchor2.prefix || '', before, true) +
              contextScore(anchor2.suffix || '', after, false),
            distance: lineDistance(occurrence.candidate.line, want2),
            position: position,
          };
        });
        scored.sort(function (a, b) {
          if (b.score !== a.score) {
            return b.score - a.score;
          }
          if (a.distance !== b.distance) {
            return a.distance - b.distance;
          }
          return a.position - b.position;
        });
        chosen = scored[0].occurrence;
      }
      byId[note2.id] = found(
        note2,
        chosen.candidate,
        2,
        chosen.start,
        chosen.start + needle.length,
        parts2,
        candidates,
      );
    }

    // Step 3 — fuzzy: the enclosing block against candidates of a similar
    // length, under the same heading path first.
    for (var f = 0; f < stillRemaining.length; f++) {
      var note3 = stillRemaining[f];
      var plain = enclosingPlain(note3);
      var result3 = null;
      if (plain) {
        var wantPath = (
          note3.headings ||
          (note3.document && note3.document.headings) ||
          []
        ).join(' › ');
        var bestFuzzy = null;
        for (var fi = 0; fi < candidates.length; fi++) {
          var fc = candidates[fi];
          var ratio = fc.text.length / plain.length;
          if (ratio < NOTE_FUZZY_MIN_RATIO || ratio > NOTE_FUZZY_MAX_RATIO) {
            continue;
          }
          var dice = bigramDice(plain, fc.text.replace(/\s+/g, ' ').trim());
          if (dice < NOTE_FUZZY_THRESHOLD) {
            continue;
          }
          if (fc.path === null) {
            fc.path = headingPathOf(children, fc.childIndex).join(' › ');
          }
          var samePath = fc.path === wantPath ? 1 : 0;
          if (
            !bestFuzzy ||
            samePath > bestFuzzy.samePath ||
            (samePath === bestFuzzy.samePath && dice > bestFuzzy.dice)
          ) {
            bestFuzzy = { candidate: fc, dice: dice, samePath: samePath };
          }
        }
        if (bestFuzzy) {
          var parts3 = String((note3.anchor || {}).exact || '').split('\n');
          var start3 = parts3[0]
            ? bestFuzzy.candidate.text.indexOf(parts3[0])
            : -1;
          result3 = found(
            note3,
            bestFuzzy.candidate,
            3,
            start3,
            start3 >= 0 ? start3 + parts3[0].length : -1,
            parts3,
            candidates,
          );
        }
      }
      byId[note3.id] = result3 || {
        noteId: note3.id,
        found: false,
        step: 0,
        el: null,
        index: -1,
        block: null,
        line: null,
        text: '',
        map: null,
        start: -1,
        end: -1,
        spans: [],
      };
    }

    for (var o = 0; o < notes.length; o++) {
      results.push(byId[notes[o].id]);
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var core = {
    ROOT_SELECTOR: ROOT_SELECTOR,
    MAX_TEXT_CHARS: MAX_TEXT_CHARS,
    ELIGIBLE_TAGS: ELIGIBLE_TAGS,
    CONTAINER_TAGS: CONTAINER_TAGS,
    DIAGRAM_SELECTOR: DIAGRAM_SELECTOR,
    INELIGIBLE_BLOCK_SELECTOR: INELIGIBLE_BLOCK_SELECTOR,
    MATH_SELECTOR: MATH_SELECTOR,
    EXTRACT_SKIP_SELECTOR: EXTRACT_SKIP_SELECTOR,
    HINT_INELIGIBLE: HINT_INELIGIBLE,
    HINT_MULTI_CELL: HINT_MULTI_CELL,
    HINT_TOO_LONG: HINT_TOO_LONG,
    classifyBlock: classifyBlock,
    collectBlocks: collectBlocks,
    extractText: extractText,
    extractRange: extractRange,
    extractBlocks: extractBlocks,
    remapBlocks: remapBlocks,
    offsetToDom: offsetToDom,
    offsetsToRange: offsetsToRange,
    spanToRange: spanToRange,
    wordEdges: wordEdges,
    resolveSelection: resolveSelection,
    helpContext: helpContext,
    PASSAGE_MARKER: PASSAGE_MARKER,
    ENCLOSING_OPEN: ENCLOSING_OPEN,
    ENCLOSING_CLOSE: ENCLOSING_CLOSE,
    HELP_TERM_MAX_WORDS: HELP_TERM_MAX_WORDS,
    markPassageIn: markPassageIn,
    termKey: termKey,
    termPattern: termPattern,
    tableRowText: tableRowText,
    caretToTextOffset: caretToTextOffset,
    wordAt: wordAt,
    sliceExtraction: sliceExtraction,
    resolveClick: resolveClick,
    blockKey: blockKey,
    blockLabel: blockLabel,
    fnv1a32: fnv1a32,
    READING_CLASS: READING_CLASS,
    PILL_CLASS: PILL_CLASS,
    WORD_CLASS: WORD_CLASS,
    WORD_EDGE_CLASS: WORD_EDGE_CLASS,
    WORD_EDGE_CHARS: WORD_EDGE_CHARS,
    HIGHLIGHT_THEMES: HIGHLIGHT_THEMES,
    DEFAULT_HIGHLIGHT_THEME: DEFAULT_HIGHLIGHT_THEME,
    PLAYER_FONTS: PLAYER_FONTS,
    DEFAULT_PLAYER_FONT: DEFAULT_PLAYER_FONT,
    GLOBAL_THEMES: GLOBAL_THEMES,
    DEFAULT_GLOBAL_THEME: DEFAULT_GLOBAL_THEME,
    TEXT_SIZE_MIN: TEXT_SIZE_MIN,
    TEXT_SIZE_MAX: TEXT_SIZE_MAX,
    TEXT_SIZE_STEP: TEXT_SIZE_STEP,
    DEFAULT_TEXT_SIZE: DEFAULT_TEXT_SIZE,
    MEASURE_CHARS: MEASURE_CHARS,
    MEASURE_SAMPLE: MEASURE_SAMPLE,
    DEFAULT_CHAR_EM: DEFAULT_CHAR_EM,
    WORD_MARKERS: WORD_MARKERS,
    DEFAULT_WORD_MARKER: DEFAULT_WORD_MARKER,
    FOLLOW_ANCHOR: FOLLOW_ANCHOR,
    FOLLOW_BAND_TOP: FOLLOW_BAND_TOP,
    FOLLOW_BAND_BOTTOM: FOLLOW_BAND_BOTTOM,
    FOLLOW_EASE: FOLLOW_EASE,
    FOLLOW_SETTLE_PX: FOLLOW_SETTLE_PX,
    BLOCK_GAP_MS: BLOCK_GAP_MS,
    HEADING_GAP_MS: HEADING_GAP_MS,
    decorateReadingBlock: decorateReadingBlock,
    undecorateReadingBlock: undecorateReadingBlock,
    wrapRange: wrapRange,
    wrapWord: wrapWord,
    unwrapSpans: unwrapSpans,
    normaliseHighlightTheme: normaliseHighlightTheme,
    normalisePlayerFont: normalisePlayerFont,
    playerFontStack: playerFontStack,
    normaliseGlobalTheme: normaliseGlobalTheme,
    clampTextSize: clampTextSize,
    deriveLineHeight: deriveLineHeight,
    charEmFrom: charEmFrom,
    normaliseWordMarker: normaliseWordMarker,
    followStep: followStep,
    blockGapMs: blockGapMs,
    tierFor: tierFor,
    resolvePageScheme: resolvePageScheme,
    backgroundLuminance: backgroundLuminance,
    // Notes (12 §9)
    NOTE_CONTEXT_CHARS: NOTE_CONTEXT_CHARS,
    NOTE_FUZZY_THRESHOLD: NOTE_FUZZY_THRESHOLD,
    sourceLineOf: sourceLineOf,
    tableSearchText: tableSearchText,
    headingPathOf: headingPathOf,
    noteAnchorFor: noteAnchorFor,
    bigramDice: bigramDice,
    anchorNotes: anchorNotes,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
  }
  if (typeof window !== 'undefined') {
    window.MpeReadAloudCore = core;
  }
})();
