/* global suite, test */
'use strict';

// Reading decoration (spec F4, the reader-app look): the line pills, the
// spoken-word spans and the highlight theme helpers of
// media/read-aloud-core.js, run under jsdom like text-extraction.test.js.
//
// The invariant every test guards: an offset map built before a wrap still
// resolves after the matching unwrap, because text nodes are moved (pills)
// or split and merged back into the original node (words), never replaced.

const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const core = require('../../media/read-aloud-core.js');

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

function assertSameMapping(mapA, mapB, length) {
  for (let k = 0; k < length; k++) {
    const a = core.offsetToDom(mapA, k);
    const b = core.offsetToDom(mapB, k);
    assert.ok(a && b, `offset ${k} resolves in both maps`);
    assert.strictEqual(a.node, b.node, `offset ${k}: same text node`);
    assert.strictEqual(a.offset, b.offset, `offset ${k}: same DOM offset`);
  }
}

function pillTexts(el) {
  return Array.from(el.getElementsByClassName(core.PILL_CLASS)).map(
    (span) => span.textContent,
  );
}

suite('read-aloud reading decoration: line pills', () => {
  test('wraps the inline run of a paragraph, leaving the play button outside', () => {
    const { root } = makeRoot(
      '<p><button class="mpe-ra-btn mpe-ra-ui" type="button">Play</button>' +
        'Prose with <em>emphasis</em> and a <a href="#">link</a>.</p>',
    );
    const p = root.firstElementChild;
    const before = core.extractText(p);

    const pills = core.decorateReadingBlock(p);

    assert.strictEqual(pills.length, 1);
    assert.ok(p.classList.contains(core.READING_CLASS));
    assert.strictEqual(p.childNodes.length, 2);
    assert.strictEqual(p.childNodes[0].className, 'mpe-ra-btn mpe-ra-ui');
    assert.strictEqual(p.childNodes[1], pills[0]);
    assert.strictEqual(pills[0].className, core.PILL_CLASS);
    assert.strictEqual(pills[0].textContent, 'Prose with emphasis and a link.');

    const after = core.extractText(p);
    assert.strictEqual(after.text, before.text);
    assertSameMapping(before.map, after.map, before.text.length);
  });

  test('pills every list item, recursing into nested and loose lists', () => {
    const { root } = makeRoot(
      '<ul>\n<li>one<ul>\n<li>nested</li>\n</ul>\n</li>\n' +
        '<li><p>loose</p></li>\n</ul>',
    );
    const ul = root.firstElementChild;

    const pills = core.decorateReadingBlock(ul);

    assert.deepStrictEqual(
      pills.map((span) => span.textContent),
      ['one', 'nested', 'loose'],
    );
    assert.strictEqual(pills[0].parentElement.tagName, 'LI');
    assert.strictEqual(pills[1].parentElement.tagName, 'LI');
    assert.strictEqual(pills[2].parentElement.tagName, 'P');
    // The "\n" runs between items are not worth a pill.
    assert.strictEqual(ul.getElementsByClassName(core.PILL_CLASS).length, 3);
  });

  test('a task-list checkbox rides inside its pill', () => {
    const { root } = makeRoot(
      '<ul data-source-line="15">\n' +
        '<li data-source-line="15"><input type="checkbox" class="task-list-item-checkbox" checked=""> task done</li>\n' +
        '</ul>',
    );
    const pills = core.decorateReadingBlock(root.firstElementChild);
    assert.strictEqual(pills.length, 1);
    assert.strictEqual(pills[0].firstElementChild.tagName, 'INPUT');
    assert.strictEqual(pills[0].textContent, ' task done');
  });

  test('blockquote paragraphs get a pill each; a nested code fence is left alone', () => {
    const { root } = makeRoot(
      '<blockquote>\n<p>first</p>\n<pre><code>x = 1</code></pre>\n<p>second</p>\n</blockquote>',
    );
    const quote = root.firstElementChild;
    core.decorateReadingBlock(quote);
    assert.deepStrictEqual(pillTexts(quote), ['first', 'second']);
    assert.strictEqual(
      quote.querySelector('pre').getElementsByClassName(core.PILL_CLASS).length,
      0,
    );
  });

  test('a heading and a table cell are wrapped like any other line container', () => {
    const { root } = makeRoot(
      '<h2 id="q5">Question 5</h2><table><tbody><tr><td>cell <b>text</b></td></tr></tbody></table>',
    );
    const h2 = root.children[0];
    const td = root.querySelector('td');
    assert.deepStrictEqual(
      core.decorateReadingBlock(h2).map((s) => s.textContent),
      ['Question 5'],
    );
    assert.deepStrictEqual(
      core.decorateReadingBlock(td).map((s) => s.textContent),
      ['cell text'],
    );
  });

  test('is idempotent: a second call adds nothing and reports the same pill', () => {
    const { root } = makeRoot('<p>Only once.</p>');
    const p = root.firstElementChild;
    const first = core.decorateReadingBlock(p);
    const second = core.decorateReadingBlock(p);
    assert.strictEqual(first.length, 1);
    assert.strictEqual(second.length, 1);
    assert.strictEqual(second[0], first[0]);
    assert.strictEqual(p.getElementsByClassName(core.PILL_CLASS).length, 1);
  });

  test('undecorateReadingBlock restores the child list node for node', () => {
    const { root } = makeRoot(
      '<ul>\n<li>one <em>two</em></li>\n<li>three</li>\n</ul>',
    );
    const ul = root.firstElementChild;
    const items = Array.from(ul.children);
    const before = items.map((li) => Array.from(li.childNodes));
    const map = core.extractText(ul);

    core.decorateReadingBlock(ul);
    core.undecorateReadingBlock(ul);

    assert.ok(!ul.classList.contains(core.READING_CLASS));
    assert.strictEqual(ul.getElementsByClassName(core.PILL_CLASS).length, 0);
    items.forEach((li, i) => {
      const after = Array.from(li.childNodes);
      assert.strictEqual(after.length, before[i].length);
      after.forEach((node, k) => assert.strictEqual(node, before[i][k]));
    });
    const again = core.extractText(ul);
    assert.strictEqual(again.text, map.text);
    assertSameMapping(map.map, again.map, map.text.length);
  });
});

suite('read-aloud reading decoration: the spoken word', () => {
  test('wraps a word inside a text node; unwrapping restores the node', () => {
    const { root, document } = makeRoot(
      '<p>history, just what is in flight</p>',
    );
    const p = root.firstElementChild;
    const textNode = p.firstChild;
    const { text, map } = core.extractText(p);
    const words = wordSpans(text);
    const just = words[1];
    assert.strictEqual(just.text, 'just');

    const wrapped = core.wrapRange(
      core.spanToRange(map, just, document),
      core.WORD_CLASS,
    );

    assert.strictEqual(wrapped.length, 1);
    assert.strictEqual(
      wrapped[0].className,
      'mpe-ra-word mpe-ra-word-start mpe-ra-word-end',
    );
    assert.strictEqual(wrapped[0].textContent, 'just');
    assert.strictEqual(p.textContent, text);
    assert.strictEqual(p.childNodes.length, 3);
    // splitText keeps the original node as the first piece.
    assert.strictEqual(p.firstChild, textNode);

    core.unwrapSpans(wrapped);

    assert.strictEqual(p.childNodes.length, 1);
    assert.strictEqual(p.firstChild, textNode);
    assert.strictEqual(textNode.data, text);
    for (const word of words) {
      word._range = null;
      const range = core.spanToRange(map, word, document);
      assert.strictEqual(range.toString(), word.text);
    }
  });

  test('a word crossing an inline boundary becomes a start span and an end span', () => {
    const { root, document } = makeRoot('<p><em>Ital</em>ic word here</p>');
    const p = root.firstElementChild;
    const em = p.firstElementChild;
    const emText = em.firstChild;
    const tailText = p.lastChild;
    const { text, map } = core.extractText(p);
    const italic = wordSpans(text)[0];
    assert.strictEqual(italic.text, 'Italic');

    const wrapped = core.wrapRange(
      core.spanToRange(map, italic, document),
      core.WORD_CLASS,
    );

    assert.strictEqual(wrapped.length, 2);
    assert.strictEqual(wrapped[0].className, 'mpe-ra-word mpe-ra-word-start');
    assert.strictEqual(wrapped[1].className, 'mpe-ra-word mpe-ra-word-end');
    assert.strictEqual(wrapped[0].textContent, 'Ital');
    assert.strictEqual(wrapped[1].textContent, 'ic');
    assert.strictEqual(wrapped[0].parentNode, em);
    assert.strictEqual(wrapped[1].parentNode, p);

    core.unwrapSpans(wrapped);

    assert.strictEqual(em.childNodes.length, 1);
    assert.strictEqual(em.firstChild, emText);
    assert.strictEqual(p.childNodes.length, 2);
    assert.strictEqual(p.lastChild, tailText);
    assert.strictEqual(tailText.data, 'ic word here');
  });

  test('wrap/unwrap cycles over every word keep the map valid, first and last included', () => {
    const { root, document } = makeRoot(
      '<p>Alpha <strong>beta</strong> gamma delta.</p>',
    );
    const p = root.firstElementChild;
    const original = Array.from(p.childNodes);
    const { text, map } = core.extractText(p);
    const words = wordSpans(text);
    assert.strictEqual(words.length, 4);

    for (const word of words) {
      word._range = null;
      const range = core.spanToRange(map, word, document);
      assert.ok(range, `range for ${word.text}`);
      const wrapped = core.wrapRange(range, core.WORD_CLASS);
      assert.strictEqual(wrapped.map((s) => s.textContent).join(''), word.text);
      core.unwrapSpans(wrapped);
    }

    const after = Array.from(p.childNodes);
    assert.strictEqual(after.length, original.length);
    after.forEach((node, i) => assert.strictEqual(node, original[i]));
    assert.strictEqual(p.textContent, text);
    assert.strictEqual(p.getElementsByClassName(core.WORD_CLASS).length, 0);
  });

  test('works on text inside a pill (the two decorations compose)', () => {
    const { root, document } = makeRoot('<p>one two three</p>');
    const p = root.firstElementChild;
    const { text, map } = core.extractText(p);
    core.decorateReadingBlock(p);
    const two = wordSpans(text)[1];
    const wrapped = core.wrapRange(
      core.spanToRange(map, two, document),
      core.WORD_CLASS,
    );
    assert.strictEqual(wrapped.length, 1);
    assert.strictEqual(wrapped[0].parentNode.className, core.PILL_CLASS);
    core.unwrapSpans(wrapped);
    core.undecorateReadingBlock(p);
    assert.strictEqual(p.childNodes.length, 1);
    assert.strictEqual(p.firstChild.data, text);
  });

  test('unwrapSpans tolerates detached and missing spans', () => {
    const { document } = makeRoot('<p>x</p>');
    const span = document.createElement('span');
    assert.doesNotThrow(() => core.unwrapSpans([span, null, undefined]));
  });
});

suite(
  'read-aloud reading decoration: the pill padding follows the line height',
  () => {
    // 05 §6.4: the pill's vertical padding is derived from the canvas line
    // height so that the line fragments of the block being read always
    // overlap by the corner radius and fuse into one shape, on the low-strain
    // page's 1.4–1.8 and on the 1.85 of `off` alike. jsdom does not evaluate
    // calc(), so the declaration is read from the stylesheet and its
    // arithmetic is done here.
    const fs = require('node:fs');
    const path = require('node:path');
    const css = fs.readFileSync(
      path.join(__dirname, '..', '..', 'media', 'read-aloud.css'),
      'utf8',
    );
    const RE =
      /--mpe-ra-pill-pad-y:\s*max\(\s*([\d.]+)em,\s*calc\(\s*\(var\(--mpe-ra-line-height, ([\d.]+)\) \* 1em - var\(--mpe-ra-content-area, ([\d.]+)em\)\) \/\s*2 \+ ([\d.]+)em\s*\)\s*\)/g;
    const CONTENT_AREA = 1.3;
    const RADIUS = 0.4;

    function padAt(declaration, lineHeight) {
      const [, min, , contentArea, extra] = declaration.map(Number);
      const raw = (lineHeight - contentArea) / 2 + extra;
      return Math.round(Math.max(min, raw) * 1000) / 1000;
    }

    test('the canvas, the pill and the word declare it, the first two alike', () => {
      const found = Array.from(css.matchAll(RE));
      assert.strictEqual(found.length, 3);
      assert.deepStrictEqual(found[0].slice(1), found[1].slice(1));
      // The content area is the face's ascent + descent (hhea 984 / -316).
      assert.strictEqual(found[0][3], String(CONTENT_AREA));
      assert.strictEqual(
        found[0][2],
        '1.85',
        'the fallback is the canvas rhythm',
      );
      assert.ok(/--mpe-ra-pill-radius:\s*0\.4em/.test(css));
    });

    test('adjacent line fragments overlap by at least the corner radius at every rhythm', () => {
      const pill = Array.from(css.matchAll(RE))[0];
      assert.strictEqual(padAt(pill, 1.6), 0.35);
      assert.strictEqual(padAt(pill, 1.85), 0.475);
      assert.strictEqual(padAt(pill, 1.4), 0.25);
      for (const lineHeight of [1.4, 1.5, 1.6, 1.7, 1.8, 1.85]) {
        const overlap = CONTENT_AREA + 2 * padAt(pill, lineHeight) - lineHeight;
        assert.ok(
          overlap >= RADIUS - 1e-9,
          `overlap ${overlap.toFixed(3)}em at ${lineHeight}`,
        );
      }
    });

    test('the spoken word stands proud of the pill by the same margin above and below', () => {
      const [pill, , word] = Array.from(css.matchAll(RE));
      for (const lineHeight of [1.4, 1.6, 1.85]) {
        const proud = padAt(word, lineHeight) - padAt(pill, lineHeight);
        assert.ok(proud > 0.1 && proud < 0.15, `proud by ${proud}em`);
      }
    });

    test('each margin cancels its own padding, shift included, so a read still moves nothing', () => {
      const pill = /\.mpe-ra-pill,\s*\.mpe-ra-word\s*\{([^}]*)\}/.exec(css);
      assert.ok(pill);
      const block = pill[1].replace(/\s+/g, ' ');
      const top = 'var(--mpe-ra-pill-pad-y) - var(--mpe-ra-pill-shift, 0.08em)';
      const bottom =
        'var(--mpe-ra-pill-pad-y) + var(--mpe-ra-pill-shift, 0.08em)';
      assert.ok(
        block.includes(
          `margin: calc(-1 * (${top})) calc(-1 * var(--mpe-ra-pill-pad-x)) calc(-1 * (${bottom}));`,
        ),
        block,
      );
      assert.ok(
        block.includes(
          `padding: calc(${top}) var(--mpe-ra-pill-pad-x) calc(${bottom});`,
        ),
        block,
      );
      // The shift is half of (ascent − cap height) − (descent − descender
      // depth) for the face: (0.984 − 0.668) − (0.316 − 0.19), halved.
      assert.ok(/--mpe-ra-pill-shift:\s*0\.08em/.test(css));
    });

    test('the spoken word is positioned, so it paints above the pill fragment of the line below', () => {
      // Inline boxes paint line by line: without this the next line's pill,
      // painted after the line the word is on, covered the part of the word
      // box that stands below its line and the box came out cut flat at the
      // bottom. Relative positioning with no offset changes the paint order
      // and nothing else.
      const word = Array.from(css.matchAll(/\.mpe-ra-word\s*\{([^}]*)\}/g))
        .map((m) => m[1])
        .find((body) => body.includes('background-color: var(--mpe-ra-word'));
      assert.ok(word, 'the word rule');
      assert.ok(/position:\s*relative;/.test(word), word);
      assert.ok(!/\b(top|left|right|bottom|inset):/.test(word), word);
    });
  },
);

suite(
  'read-aloud reading decoration: the characters touching the spoken word',
  () => {
    // The word box overhangs its word by its horizontal padding and is painted
    // above the block's text (it is positioned, see the CSS suite below), so a
    // glyph standing in that overhang — the hyphen of "read-only", the full
    // stop after a sentence's last word — vanished under it. wrapWord wraps
    // those characters in edge spans that are positioned a step above the box.

    test('wordEdges: the non-whitespace run on each side, cut to WORD_EDGE_CHARS', () => {
      const { root } = makeRoot(
        '<p>a read-only reviewer. Now the firewall. The end</p>',
      );
      const { text, map } = core.extractText(root.firstElementChild);
      const words = wordSpans(text);
      const at = (word) => {
        const start = text.indexOf(word);
        return { charStart: start, charEnd: start + word.length };
      };

      assert.strictEqual(core.WORD_EDGE_CHARS, 3);
      // "read-only" is one whitespace token; the spoken words are its halves.
      const only = at('only');
      assert.deepStrictEqual(core.wordEdges(map, only), {
        before: { from: only.charStart - 3, to: only.charStart },
        after: null,
      });
      assert.strictEqual(
        text.slice(only.charStart - 3, only.charStart),
        'ad-',
        'three characters, the hyphen among them',
      );
      const read = at('read');
      assert.deepStrictEqual(core.wordEdges(map, read), {
        before: null,
        after: { from: read.charEnd, to: read.charEnd + 3 },
      });
      assert.strictEqual(text.slice(read.charEnd, read.charEnd + 3), '-on');

      const firewall = at('firewall');
      assert.deepStrictEqual(core.wordEdges(map, firewall), {
        before: null,
        after: { from: firewall.charEnd, to: firewall.charEnd + 1 },
      });
      assert.strictEqual(text[firewall.charEnd], '.');

      // Bounded by whitespace on both sides, and by the text's ends.
      assert.deepStrictEqual(core.wordEdges(map, at('Now')), {
        before: null,
        after: null,
      });
      assert.deepStrictEqual(core.wordEdges(map, words[0]), {
        before: null,
        after: null,
      });
      assert.deepStrictEqual(core.wordEdges(map, words[words.length - 1]), {
        before: null,
        after: null,
      });

      // The limit is a parameter; nothing or a bad map gives no edges.
      assert.deepStrictEqual(core.wordEdges(map, only, 1), {
        before: { from: only.charStart - 1, to: only.charStart },
        after: null,
      });
      assert.deepStrictEqual(core.wordEdges(map, only, 0), {
        before: null,
        after: null,
      });
      assert.deepStrictEqual(core.wordEdges(null, only), {
        before: null,
        after: null,
      });
      assert.deepStrictEqual(core.wordEdges(map, null), {
        before: null,
        after: null,
      });
    });

    test('wordEdges never crosses the block separator of a multi-block map', () => {
      const { root } = makeRoot('<p>first.</p><p>second</p>');
      const { text, map } = core.extractBlocks(Array.from(root.children), 0);
      assert.strictEqual(text, 'first.\nsecond');
      const first = { charStart: 0, charEnd: 5 };
      assert.deepStrictEqual(core.wordEdges(map, first), {
        before: null,
        after: { from: 5, to: 6 },
      });
      const second = { charStart: 7, charEnd: 13 };
      assert.deepStrictEqual(core.wordEdges(map, second), {
        before: null,
        after: null,
      });
    });

    test('wrapWord wraps the word first and its edges after it, across inline boundaries', () => {
      const { root, document } = makeRoot(
        '<p>A <strong>boldface</strong>d, <a href="#">linked-word</a>. Done.</p>',
      );
      const p = root.firstElementChild;
      const strong = p.querySelector('strong');
      const strongText = strong.firstChild;
      const tailText = strong.nextSibling;
      const original = Array.from(p.childNodes);
      const { text, map } = core.extractText(p);
      const start = text.indexOf('face');
      const face = { charStart: start, charEnd: start + 4 };

      const spans = core.wrapWord(map, face, document);

      assert.deepStrictEqual(
        spans.map((s) => [s.className, s.textContent, s.parentNode.tagName]),
        [
          ['mpe-ra-word mpe-ra-word-start mpe-ra-word-end', 'face', 'STRONG'],
          // The tail "d," is in the paragraph's own text node.
          [
            'mpe-ra-word-edge mpe-ra-word-edge-start mpe-ra-word-edge-end',
            'd,',
            'P',
          ],
          // "bold" cut to three characters.
          [
            'mpe-ra-word-edge mpe-ra-word-edge-start mpe-ra-word-edge-end',
            'old',
            'STRONG',
          ],
        ],
      );
      assert.strictEqual(p.textContent, text, 'the text is untouched');
      // splitText keeps the original node as the head of each run.
      assert.strictEqual(strong.firstChild, strongText);
      assert.strictEqual(strongText.data, 'b');

      core.unwrapSpans(spans);

      assert.strictEqual(strong.childNodes.length, 1);
      assert.strictEqual(strong.firstChild, strongText);
      assert.strictEqual(strongText.data, 'boldface');
      assert.strictEqual(tailText.data, 'd, ');
      const after = Array.from(p.childNodes);
      assert.strictEqual(after.length, original.length);
      after.forEach((node, i) => assert.strictEqual(node, original[i]));
      assert.strictEqual(p.querySelectorAll('span').length, 0);

      // The link's word: its edge crosses nothing and stays inside the link.
      const linkedAt = text.indexOf('linked');
      const linked = core.wrapWord(
        map,
        { charStart: linkedAt, charEnd: linkedAt + 6 },
        document,
      );
      assert.deepStrictEqual(
        linked.map((s) => [s.textContent, s.parentNode.tagName]),
        [
          ['linked', 'A'],
          ['-wo', 'A'],
        ],
      );
      core.unwrapSpans(linked);
      assert.strictEqual(p.querySelector('a').childNodes.length, 1);
      assert.strictEqual(p.querySelector('a').textContent, 'linked-word');
    });

    test('wrapWord wraps nothing for a word the map cannot resolve', () => {
      const { root, document } = makeRoot('<p>short</p>');
      const p = root.firstElementChild;
      const { map } = core.extractText(p);
      assert.deepStrictEqual(
        core.wrapWord(map, { charStart: 40, charEnd: 44 }, document),
        [],
      );
      assert.deepStrictEqual(
        core.wrapWord(null, { charStart: 0, charEnd: 2 }),
        [],
      );
      assert.strictEqual(p.childNodes.length, 1);
    });

    test('wrapWord/unwrapSpans cycles over every word of punctuated prose keep the map valid', () => {
      const { root, document } = makeRoot(
        '<p>“Quoted,” she said—<em>read-only</em>; (really?) yes.</p>',
      );
      const p = root.firstElementChild;
      const original = Array.from(p.childNodes);
      const { text, map } = core.extractText(p);
      const words = [];
      const re = /[\p{L}\p{N}]+/gu;
      let match = re.exec(text);
      while (match) {
        words.push({
          charStart: match.index,
          charEnd: match.index + match[0].length,
        });
        match = re.exec(text);
      }
      assert.strictEqual(words.length, 7);

      for (const word of words) {
        const spans = core.wrapWord(map, word, document);
        assert.ok(
          spans.length >= 1,
          `spans for ${text.slice(word.charStart, word.charEnd)}`,
        );
        assert.strictEqual(
          spans[0].className.split(' ')[0],
          core.WORD_CLASS,
          'the word comes first',
        );
        assert.strictEqual(
          spans
            .filter((s) => s.classList.contains(core.WORD_CLASS))
            .map((s) => s.textContent)
            .join(''),
          text.slice(word.charStart, word.charEnd),
        );
        assert.strictEqual(p.textContent, text);
        core.unwrapSpans(spans);
      }

      const after = Array.from(p.childNodes);
      assert.strictEqual(after.length, original.length);
      after.forEach((node, i) => assert.strictEqual(node, original[i]));
      assert.strictEqual(p.textContent, text);
      assert.strictEqual(p.getElementsByTagName('span').length, 0);
    });

    test('the edge span is positioned a step above the box and shows nothing of its own', () => {
      const fs = require('node:fs');
      const path = require('node:path');
      const css = fs.readFileSync(
        path.join(__dirname, '..', '..', 'media', 'read-aloud.css'),
        'utf8',
      );
      const edge = /\.mpe-ra-word-edge\s*\{([^}]*)\}/.exec(css);
      assert.ok(edge, 'the edge rule');
      assert.ok(/position:\s*relative;/.test(edge[1]), edge[1]);
      assert.ok(/z-index:\s*1;/.test(edge[1]), edge[1]);
      assert.ok(
        !/\b(top|left|right|bottom|inset|background|padding|margin)/.test(
          edge[1],
        ),
        edge[1],
      );
      // The box it stands above has z-index auto, so 1 is above it.
      const word = Array.from(css.matchAll(/\.mpe-ra-word\s*\{([^}]*)\}/g))
        .map((m) => m[1])
        .find((body) => body.includes('background-color: var(--mpe-ra-word'));
      assert.ok(!/z-index/.test(word), word);
    });
  },
);

suite('read-aloud highlight theme helpers', () => {
  test('normaliseHighlightTheme accepts the five themes and falls back to blue', () => {
    assert.deepStrictEqual(core.HIGHLIGHT_THEMES, [
      'blue',
      'pink',
      'red',
      'green',
      'orange',
    ]);
    assert.strictEqual(core.DEFAULT_HIGHLIGHT_THEME, 'blue');
    for (const theme of core.HIGHLIGHT_THEMES) {
      assert.strictEqual(core.normaliseHighlightTheme(theme), theme);
    }
    assert.strictEqual(core.normaliseHighlightTheme('Blue'), 'blue');
    // `yellow` was one of the original four and is retired: a settings file
    // that still names it falls back rather than losing the decoration.
    assert.strictEqual(core.normaliseHighlightTheme('yellow'), 'blue');
    assert.strictEqual(core.normaliseHighlightTheme(undefined), 'blue');
    assert.strictEqual(core.normaliseHighlightTheme(42), 'blue');
    assert.strictEqual(core.normaliseHighlightTheme(''), 'blue');
  });

  test('backgroundLuminance tells dark from light and ignores transparency', () => {
    const dark = core.backgroundLuminance('rgb(29, 31, 33)'); // atom-dark
    const light = core.backgroundLuminance('rgb(255, 255, 255)');
    assert.ok(dark !== null && dark < 0.5, `dark=${dark}`);
    assert.ok(light !== null && light > 0.9, `light=${light}`);
    assert.ok(core.backgroundLuminance('#1d1f21') < 0.5);
    assert.ok(core.backgroundLuminance('#fff') > 0.9);
    assert.ok(core.backgroundLuminance('#fdf6e3') > 0.5); // solarized-light
    assert.ok(core.backgroundLuminance('#002b36') < 0.5); // solarized-dark
    assert.ok(core.backgroundLuminance('rgb(255 255 255 / 50%)') > 0.9);
    assert.strictEqual(core.backgroundLuminance('rgba(0, 0, 0, 0)'), null);
    assert.strictEqual(core.backgroundLuminance('rgb(0 0 0 / 0)'), null);
    assert.strictEqual(core.backgroundLuminance('transparent'), null);
    assert.strictEqual(core.backgroundLuminance('#00000000'), null);
    assert.strictEqual(
      core.backgroundLuminance('color(display-p3 1 1 1)'),
      null,
    );
    assert.strictEqual(core.backgroundLuminance(undefined), null);
  });
});
