/*
 * Read aloud (ElevenLabs) — pure DOM helpers.
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

  // Rule 0 (contract B17): a block that matches *or contains* math is never read.
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
  // word is wrapped in WORD_CLASS spans. Palettes are the ElevenLabs Reader
  // "Player highlight theme" colours, see media/read-aloud.css.
  var READING_CLASS = 'mpe-ra-reading';
  var PILL_CLASS = 'mpe-ra-pill';
  var WORD_CLASS = 'mpe-ra-word';
  var HIGHLIGHT_THEMES = ['blue', 'orange', 'yellow', 'green'];
  var DEFAULT_HIGHLIGHT_THEME = 'blue';

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

  /**
   * `el.matches(MATH_SELECTOR) || el.querySelector(MATH_SELECTOR) !== null`,
   * written with `getElementsBy*` so classification of a large document stays
   * inside the §6 performance budget (rule 0, contract B17).
   */
  function isOrContainsMath(el, set) {
    if (setHasAnyClass(set, MATH_CLASSES)) {
      return true;
    }
    var tag = el.tagName;
    if (tag === 'MATH' || tag === 'math') {
      return true;
    }
    for (var i = 0; i < MATH_CLASSES.length; i++) {
      if (el.getElementsByClassName(MATH_CLASSES[i]).length > 0) {
        return true;
      }
    }
    return el.getElementsByTagName('math').length > 0;
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

    // Rule 0 — math first, fail-closed (contract B17/G-02): any block that is
    // or contains KaTeX/MathML would speak LaTeX, so it is never read.
    if (isOrContainsMath(el, set)) {
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
        containsSelector(el, INELIGIBLE_BLOCK_SELECTOR)
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
    var start = offsetToDom(map, span.charStart);
    var end = offsetToDom(map, span.charEnd - 1);
    if (!start || !end) {
      return null;
    }
    var document_ = doc || start.node.ownerDocument;
    var range = document_.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
    span._range = range;
    span._rangeMap = map;
    return range;
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
   * reading starts at the word under the caret and ends where the unit's
   * play button would end. The result carries the whole-unit extraction so
   * the caller can hit-test the word's rects and slice after any teardown.
   *
   * Refusals: `outside` (not in the preview), `interactive` (a link, a
   * checkbox, our own UI), `ineligible` (F6, at any depth), `empty` (no
   * word at the caret).
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
        isOrContainsMath(cell, classSet(cell)) ||
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
    var pieces = textPiecesInRange(range);
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
    offsetToDom: offsetToDom,
    spanToRange: spanToRange,
    resolveSelection: resolveSelection,
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
    HIGHLIGHT_THEMES: HIGHLIGHT_THEMES,
    DEFAULT_HIGHLIGHT_THEME: DEFAULT_HIGHLIGHT_THEME,
    decorateReadingBlock: decorateReadingBlock,
    undecorateReadingBlock: undecorateReadingBlock,
    wrapRange: wrapRange,
    unwrapSpans: unwrapSpans,
    normaliseHighlightTheme: normaliseHighlightTheme,
    backgroundLuminance: backgroundLuminance,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
  }
  if (typeof window !== 'undefined') {
    window.MpeReadAloudCore = core;
  }
})();
