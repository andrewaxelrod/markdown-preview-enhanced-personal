/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// Lane B / T-17, T-18 — rendered-text extraction and the offset map
// (spec F5, F4; contract §3.2).
//
// The markup literals below are copied verbatim from the crossnote render of
// `mpe-test.md` (build-runs/.../scratch/mpe-test.preview.html); T-14 keeps that
// render honest, these tests keep the extractor honest against it.

const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const core = require('../../media/read-aloud-core.js');

const BASICS_P =
  '<p data-source-line="13"><em>Italic</em>, <strong>bold</strong>, ' +
  '<s>strike</s>, <code>inline code</code>, ' +
  '<a href="https://shd101wyy.github.io/markdown-preview-enhanced/">a link</a>.</p>';

const TASK_LIST =
  '<ul data-source-line="15">\n' +
  '<li data-source-line="15"><input type="checkbox" class="task-list-item-checkbox" data-source-line="15" checked=""> task done</li>\n' +
  '<li data-source-line="16"><input type="checkbox" class="task-list-item-checkbox" data-source-line="16"> task pending</li>\n' +
  '</ul>';

const BLOCKQUOTE =
  '<blockquote>\n' +
  '<p data-source-line="23">Blockquote with a footnote.' +
  '<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup></p>\n' +
  '</blockquote>';

const INLINE_MATH_P =
  '<p data-source-line="29">Inline: <span class="katex">' +
  '<span class="katex-mathml"><math><semantics><mrow><mi>e</mi></mrow>' +
  '<annotation encoding="application/x-tex">e^{i\\pi} + 1 = 0</annotation>' +
  '</semantics></math></span>' +
  '<span class="katex-html" aria-hidden="true"><span class="base">e</span></span>' +
  '</span> and prose after it.</p>';

const WHITESPACE_P = '<p>   Lots\n   of \u00a0collapsible \t space   </p>';

const SPLIT_WORD_P = '<p><em>Ital</em>ic word here</p>';

const DECORATED_P =
  '<p><button class="mpe-ra-btn" type="button" aria-label="Read aloud: x">' +
  'Play</button>Prose after the button.</p>';

const ARIA_HIDDEN_P =
  '<p>Visible <span aria-hidden="true">hidden</span> tail</p>';

const TWO_PARAGRAPHS =
  '<p id="p1">First paragraph text.</p><p id="p2">Second paragraph text.</p>';

const PREVIEW_OPEN =
  '<!doctype html><body class="preview-container">' +
  '<div class="crossnote markdown-preview" data-for="preview">';
const PREVIEW_CLOSE = '</div></body>';

function makeRoot(html) {
  const dom = new JSDOM(PREVIEW_OPEN + html + PREVIEW_CLOSE);
  return {
    dom,
    document: dom.window.document,
    root: dom.window.document.querySelector(core.ROOT_SELECTOR),
  };
}

/** Whitespace-delimited words of `text` as `{ text, charStart, charEnd }`. */
function wordSpans(text) {
  const spans = [];
  const re = /\S+/g;
  let match = re.exec(text);
  while (match) {
    spans.push({
      text: match[0],
      charStart: match.index,
      charEnd: match.index + match[0].length,
    });
    match = re.exec(text);
  }
  return spans;
}

suite('read-aloud: text extraction (F5) and offset map (F4)', function () {
  this.timeout(20000);

  let fixture;

  suiteSetup(function () {
    fixture = makeRoot(
      BASICS_P +
        TASK_LIST +
        BLOCKQUOTE +
        INLINE_MATH_P +
        WHITESPACE_P +
        SPLIT_WORD_P +
        DECORATED_P +
        ARIA_HIDDEN_P,
    );
  });

  suiteTeardown(function () {
    if (fixture) {
      fixture.dom.window.close();
    }
  });

  // T-17
  test('T-17 rendered text only: markup, checkboxes, markers and math dropped', function () {
    const children = fixture.root.children;

    assert.strictEqual(
      core.extractText(children[0]).text,
      'Italic, bold, strike, inline code, a link.',
      'emphasis, inline code and link text are read as ordinary words',
    );
    assert.strictEqual(
      core.extractText(children[1]).text,
      'task done task pending',
      'checkbox <input> contributes no text (requirement 6)',
    );
    assert.strictEqual(
      core.extractText(children[2]).text,
      'Blockquote with a footnote.',
      'the footnote marker is not spoken',
    );
    assert.strictEqual(
      core.extractText(children[3]).text,
      'Inline: and prose after it.',
      'KaTeX subtrees are skipped by the extractor',
    );
    assert.strictEqual(
      core.extractText(children[4]).text,
      'Lots of collapsible space',
      'whitespace runs (NBSP included) collapse to one space and are trimmed',
    );
    assert.strictEqual(
      core.extractText(children[6]).text,
      'Prose after the button.',
    );
    assert.ok(
      core.extractText(children[6]).text.indexOf('Play') === -1,
      'the injected play button never leaks into the spoken text',
    );
    assert.strictEqual(core.extractText(children[7]).text, 'Visible tail');
  });

  // T-17
  test('T-17 extracted text is always collapsed and trimmed', function () {
    const children = fixture.root.children;
    for (let i = 0; i < children.length; i++) {
      const text = core.extractText(children[i]).text;
      assert.strictEqual(text, text.trim(), 'trimmed: ' + JSON.stringify(text));
      assert.ok(
        !/\s\s/.test(text),
        'no whitespace run survives: ' + JSON.stringify(text),
      );
      assert.ok(
        !/[^\S ]/.test(text),
        'space is the only whitespace character: ' + JSON.stringify(text),
      );
    }
  });

  // T-18
  test('T-18 offset map round trip over the Basics paragraph', function () {
    const doc = fixture.document;
    const { text, map } = core.extractText(fixture.root.children[0]);
    const spans = wordSpans(text);
    assert.strictEqual(spans.length, 7);
    for (const span of spans) {
      const range = core.spanToRange(map, span, doc);
      assert.ok(range, 'range for ' + JSON.stringify(span.text));
      assert.strictEqual(
        range.toString(),
        span.text,
        'round trip for ' + JSON.stringify(span.text),
      );
    }
    // "Italic," starts in <em> and ends in the following text node.
    const first = core.spanToRange(map, spans[0], doc);
    assert.strictEqual(first.startContainer.parentElement.tagName, 'EM');
    assert.notStrictEqual(first.startContainer, first.endContainer);
  });

  // T-18
  test('T-18 offset map round trip for a word split across inline elements', function () {
    const doc = fixture.document;
    const { text, map } = core.extractText(fixture.root.children[5]);
    assert.strictEqual(text, 'Italic word here');
    const spans = wordSpans(text);
    assert.strictEqual(
      core.spanToRange(map, spans[0], doc).toString(),
      'Italic',
      'a word split across <em> and text still maps to one range',
    );
    assert.strictEqual(core.spanToRange(map, spans[1], doc).toString(), 'word');
    assert.strictEqual(core.spanToRange(map, spans[2], doc).toString(), 'here');
  });

  // T-18
  test('T-18 multi-block extraction joins with newlines that map to nothing', function () {
    const two = makeRoot(TWO_PARAGRAPHS);
    const doc = two.document;
    const range = doc.createRange();
    range.setStart(doc.getElementById('p1').firstChild, 0);
    range.setEnd(
      doc.getElementById('p2').firstChild,
      doc.getElementById('p2').firstChild.data.length,
    );
    const result = core.extractRange(range, two.root);

    assert.strictEqual(
      result.text,
      'First paragraph text.\nSecond paragraph text.',
    );
    assert.strictEqual(result.blocks.length, 2);
    assert.strictEqual(result.text, result.text.trim());

    const newlineAt = result.text.indexOf('\n');
    assert.strictEqual(
      core.offsetToDom(result.map, newlineAt),
      null,
      'the block separator has no DOM segment',
    );

    for (const span of wordSpans(result.text)) {
      const spanRange = core.spanToRange(result.map, span, doc);
      assert.ok(spanRange, 'range for ' + JSON.stringify(span.text));
      assert.strictEqual(spanRange.toString(), span.text);
    }
    two.dom.window.close();
  });

  // T-18
  test('T-18 offsetToDom is out-of-range safe and spanToRange caches per map', function () {
    const doc = fixture.document;
    const { text, map } = core.extractText(fixture.root.children[0]);
    assert.strictEqual(core.offsetToDom(map, -1), null);
    assert.strictEqual(core.offsetToDom(map, text.length), null);
    assert.strictEqual(core.offsetToDom(map, 0).offset, 0);

    const span = wordSpans(text)[1];
    const first = core.spanToRange(map, span, doc);
    assert.strictEqual(core.spanToRange(map, span, doc), first, 'range cached');

    const rebuilt = core.extractText(fixture.root.children[0]).map;
    const second = core.spanToRange(rebuilt, span, doc);
    assert.notStrictEqual(
      second,
      first,
      'a rebuilt map drops the cached range',
    );
    assert.strictEqual(second.toString(), span.text);
  });
});
