/* global suite, test */
'use strict';

// 11 help fixes — the material a *partial* selection sends. Before this, a
// selection shorter than its block sent the selected words as the passage and
// put the [PASSAGE] marker where the whole block had been, so the sentence the
// words sat in was the one part of the document the model never saw. These
// tests drive `helpContext` and its helpers in `media/read-aloud-core.js` over
// a jsdom render shaped like the report's document (`featrues/11-help-fixes/`):
// a lesson that lists "the metrics" among the parts of a harness, a glossary
// table that defines the harness, and a sources list with a metrics URL.

const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const core = require('../../media/read-aloud-core.js');

const OPEN = '⟦';
const CLOSE = '⟧';

const LESSON =
  'Let me first say what everything else is. The harness, in this course, is the ' +
  'reusable collection of things you put around the coding agent: the agent ' +
  'profiles, the instruction files, the checks, the hooks, the setup files, the ' +
  'metrics, and the written operating procedures. It is the part you design, ' +
  'govern, and hand to the next team.';

const GLOSS =
  'the reusable collection of profiles, instructions, checks, hooks, setup ' +
  'files, metrics, and procedures around the agent';

const URL =
  'https://github.blog/changelog/2026-06-19-ai-credits-consumed-per-user-now-in-the-copilot-usage-metrics-api/';
const OTHER_URL =
  'https://github.blog/changelog/2026-06-02-shape-copilot-code-review-around-your-team/';

const FIXTURE =
  '<h1 id="h1">Module 1: The Governed Harness</h1>' +
  '<h2 id="lesson-h">Sign, Alarm, Lock</h2>' +
  '<p id="q">So, if GitHub is the only place a no really holds, what is everything else for?</p>' +
  `<p id="lesson">${LESSON}</p>` +
  '<p id="sort">And the way to keep that straight is a sorting rule. Every control is one of three things: a sign, an alarm, or a lock.</p>' +
  '<pre id="sketch"><code>SIGN  ALARM  LOCK  metrics</code></pre>' +
  '<h2 id="notes-h">Eyes-only: build notes</h2>' +
  '<h3 id="terms-h">Terms and analogies</h3>' +
  '<table id="glossary"><thead><tr><th>Term</th><th>Plain-words gloss used</th><th>First taught</th><th>Analogy</th></tr></thead>' +
  `<tbody><tr><td id="harness-cell">harness</td><td>${GLOSS}</td><td>1, 3</td><td>engine and car</td></tr>` +
  '<tr><td>tool</td><td>a capability the software exposes</td><td>2</td><td></td></tr></tbody></table>' +
  '<h3 id="sources-h">Sources</h3>' +
  `<ul id="sources"><li><a href="${OTHER_URL}">${OTHER_URL}</a></li><li><a href="${URL}">${URL}</a></li></ul>` +
  '<pre id="code-after"><code>metrics = collect()</code></pre>';

const PREVIEW_OPEN =
  '<!doctype html><body class="preview-container">' +
  '<div class="crossnote markdown-preview" data-for="preview">';
const PREVIEW_CLOSE = '</div></body>';

function makeRoot(html) {
  const dom = new JSDOM(PREVIEW_OPEN + html + PREVIEW_CLOSE);
  const document = dom.window.document;
  return { dom, document, root: document.querySelector(core.ROOT_SELECTOR) };
}

/** A Range over the `nth` occurrence of `needle` in the text node of `el`. */
function rangeOver(document, el, needle, nth) {
  const node = el.firstChild;
  let at = -1;
  for (let i = 0; i <= (nth || 0); i++) {
    at = node.data.indexOf(needle, at + 1);
    assert.ok(at >= 0, `"${needle}" occurrence ${i}`);
  }
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + needle.length);
  return range;
}

suite('read-aloud help context (11 help fixes)', function () {
  suite('helpContext over the report document', function () {
    test('"the metrics" carries its sentence marked, and the glossary row and source that also say metrics', function () {
      const { document, root } = makeRoot(FIXTURE);
      const lesson = document.getElementById('lesson');
      const range = rangeOver(document, lesson, 'the metrics');
      const context = core.helpContext(root, [lesson], 'the metrics', range);

      assert.strictEqual(context.title, 'Module 1: The Governed Harness');
      assert.deepStrictEqual(context.breadcrumb, [
        'Module 1: The Governed Harness',
        'Sign, Alarm, Lock',
      ]);
      assert.match(context.before, /^So, if GitHub/);
      assert.match(context.after, /^And the way/);
      // The section still stands in for the block with the marker …
      assert.ok(context.section.includes('[PASSAGE]'));
      assert.ok(!context.section.includes('Let me first say'));
      // … and the block itself now travels, with the selection in brackets.
      assert.strictEqual(
        context.enclosing,
        LESSON.replace('the metrics', `${OPEN}the metrics${CLOSE}`),
      );

      // Two words are a term: the rest of the document is searched for
      // "metrics" (the article dropped) outside the lesson's own section.
      const mentions = context.mentions.split('\n\n');
      assert.strictEqual(mentions.length, 2, context.mentions);
      assert.strictEqual(
        mentions[0],
        'Under "Terms and analogies": Term: harness; Plain-words gloss used: ' +
          GLOSS +
          '; First taught: 1, 3; Analogy: engine and car',
      );
      // A list is scanned item by item: the one matching source, alone.
      assert.strictEqual(mentions[1], `Under "Sources": ${URL}`);
      assert.ok(!context.mentions.includes(OTHER_URL));
      // Code never counts as a mention, inside the section or after it.
      assert.ok(!context.mentions.includes('collect()'));
      assert.ok(!context.mentions.includes('SIGN'));
    });

    test('a selection that is the whole block has nothing to enclose', function () {
      const { root, document } = makeRoot(FIXTURE);
      const lesson = document.getElementById('lesson');
      const range = document.createRange();
      range.selectNodeContents(lesson);
      const context = core.helpContext(root, [lesson], LESSON, range);
      assert.strictEqual(context.enclosing, '');
      // Fifty-odd words are a passage, not a term: no lookup.
      assert.strictEqual(context.mentions, '');
    });

    test('a phrase of more than five words gets its block but no mentions', function () {
      const { root, document } = makeRoot(FIXTURE);
      const lesson = document.getElementById('lesson');
      const phrase =
        'the setup files, the metrics, and the written operating procedures';
      const range = rangeOver(document, lesson, phrase);
      const context = core.helpContext(root, [lesson], phrase, range);
      assert.ok(context.enclosing.includes(`${OPEN}${phrase}${CLOSE}`));
      assert.strictEqual(context.mentions, '');
    });

    test('without a live range the first occurrence is marked', function () {
      const { root, document } = makeRoot(FIXTURE);
      const lesson = document.getElementById('lesson');
      const context = core.helpContext(root, [lesson], 'the metrics', null);
      assert.strictEqual(
        context.enclosing,
        LESSON.replace('the metrics', `${OPEN}the metrics${CLOSE}`),
      );
    });

    test('a table-cell selection is enclosed by its row, headers named, and finds the term elsewhere', function () {
      const { root, document } = makeRoot(FIXTURE);
      const cell = document.getElementById('harness-cell');
      const context = core.helpContext(root, [cell], 'harness', null);
      assert.strictEqual(
        context.enclosing,
        `Term: ${OPEN}harness${CLOSE}; Plain-words gloss used: ${GLOSS}; ` +
          'First taught: 1, 3; Analogy: engine and car',
      );
      assert.deepStrictEqual(context.breadcrumb, [
        'Module 1: The Governed Harness',
        'Eyes-only: build notes',
        'Terms and analogies',
      ]);
      const mentions = context.mentions.split('\n\n');
      // The h1 has no heading above it, so it comes with no label; the lesson
      // is cut around the match because it is longer than a snippet.
      assert.strictEqual(mentions[0], 'Module 1: The Governed Harness');
      assert.ok(mentions[1].startsWith('Under "Sign, Alarm, Lock": '));
      assert.ok(mentions[1].includes('The harness, in this course'));
      assert.strictEqual(mentions.length, 2, context.mentions);
    });

    test('a selection in a document with no headings finds no mentions: the section is the document', function () {
      const { root, document } = makeRoot(
        '<p id="a">Metrics come first.</p><p id="b">Then the metrics again.</p>',
      );
      const b = document.getElementById('b');
      const context = core.helpContext(root, [b], 'the metrics', null);
      assert.strictEqual(
        context.enclosing,
        `Then ${OPEN}the metrics${CLOSE} again.`,
      );
      assert.strictEqual(context.mentions, '');
      // The only other block is the neighbour, which travels as "before".
      assert.strictEqual(context.before, 'Metrics come first.');
      assert.strictEqual(context.section, '[PASSAGE]');
    });
  });

  suite('markPassageIn', function () {
    test('marks the passage at its exact offset when it really starts there', function () {
      assert.strictEqual(
        core.markPassageIn(['alpha beta gamma beta'], 'beta', 17),
        `alpha beta gamma ${OPEN}beta${CLOSE}`,
      );
      // Leading whitespace before the offset is stepped over.
      assert.strictEqual(
        core.markPassageIn(['alpha beta gamma beta'], 'beta', 16),
        `alpha beta gamma ${OPEN}beta${CLOSE}`,
      );
    });

    test('falls back to the first occurrence when the offset does not fit', function () {
      assert.strictEqual(
        core.markPassageIn(['alpha beta gamma beta'], 'beta', 3),
        `alpha ${OPEN}beta${CLOSE} gamma beta`,
      );
      assert.strictEqual(
        core.markPassageIn(['alpha beta gamma beta'], 'beta', -1),
        `alpha ${OPEN}beta${CLOSE} gamma beta`,
      );
    });

    test('a passage that is the whole of its blocks gives nothing', function () {
      assert.strictEqual(
        core.markPassageIn(['alpha beta'], 'alpha beta', 0),
        '',
      );
      assert.strictEqual(
        core.markPassageIn(['alpha beta'], '  alpha beta ', -1),
        '',
      );
      assert.strictEqual(
        core.markPassageIn(['one two', 'three'], 'one two\nthree'),
        '',
      );
      assert.strictEqual(core.markPassageIn([], 'x'), '');
      assert.strictEqual(core.markPassageIn(['x'], ''), '');
    });

    test('a selection across blocks is located in the flattened text', function () {
      assert.strictEqual(
        core.markPassageIn(['one two', 'three four'], 'two\nthree'),
        `one ${OPEN}two three${CLOSE} four`,
      );
    });

    test('a passage that cannot be found leaves the block unmarked', function () {
      assert.strictEqual(
        core.markPassageIn(['alpha beta'], 'gamma'),
        'alpha beta',
      );
    });
  });

  suite('termKey and termPattern', function () {
    test('drops the small words at the edges and the punctuation', function () {
      assert.deepStrictEqual(core.termKey('the metrics'), ['metrics']);
      assert.deepStrictEqual(core.termKey('"the metrics,"'), ['metrics']);
      assert.deepStrictEqual(core.termKey('The Governed Path'), [
        'governed',
        'path',
      ]);
      assert.deepStrictEqual(core.termKey('a sign or'), ['sign']);
      assert.deepStrictEqual(core.termKey("GitHub's rulesets"), [
        "github's",
        'rulesets',
      ]);
      // A lone article is still looked up rather than emptied.
      assert.deepStrictEqual(core.termKey('the'), ['the']);
    });

    test('six words or more is a passage: no key', function () {
      assert.deepStrictEqual(core.termKey('one two three four five six'), []);
      assert.deepStrictEqual(core.termKey('one two three four five'), [
        'one',
        'two',
        'three',
        'four',
        'five',
      ]);
      assert.deepStrictEqual(core.termKey(''), []);
      assert.deepStrictEqual(core.termKey(null), []);
      assert.strictEqual(core.HELP_TERM_MAX_WORDS, 5);
    });

    test('the pattern is whole-word, case-insensitive and plural-tolerant', function () {
      const metrics = core.termPattern(['metrics']);
      assert.ok(metrics.test('the Metrics API'));
      assert.ok(metrics.test('one metric'));
      assert.ok(metrics.test('copilot-usage-metrics-api'));
      assert.ok(!metrics.test('metrical'));
      assert.ok(!metrics.test('biometrics'));

      const lock = core.termPattern(['lock']);
      assert.ok(lock.test('two locks'));
      assert.ok(!lock.test('locked'));
      assert.ok(!lock.test('block'));

      const two = core.termPattern(['required', 'check']);
      assert.ok(two.test('a required  check'));
      assert.ok(two.test('Required checks'));
      assert.ok(!two.test('required to check'));
      assert.strictEqual(core.termPattern([]), null);
      assert.strictEqual(core.termPattern(null), null);
    });

    test('regex characters in a term are literal', function () {
      const pattern = core.termPattern(['c++']);
      assert.ok(pattern.test('in C++ code'));
      assert.ok(!pattern.test('in C code'));
    });
  });

  suite('tableRowText', function () {
    test('names the columns when the first row is a header row of the same width', function () {
      const { document } = makeRoot(FIXTURE);
      const rows = document.querySelectorAll('#glossary tr');
      assert.strictEqual(
        core.tableRowText(rows[0]),
        'Term | Plain-words gloss used | First taught | Analogy',
      );
      assert.strictEqual(
        core.tableRowText(rows[1]),
        `Term: harness; Plain-words gloss used: ${GLOSS}; First taught: 1, 3; Analogy: engine and car`,
      );
      // An empty cell is left out rather than named.
      assert.strictEqual(
        core.tableRowText(rows[2]),
        'Term: tool; Plain-words gloss used: a capability the software exposes; First taught: 2',
      );
    });

    test('a table without a header row joins the cells with a bar', function () {
      const { document } = makeRoot(
        '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td></td></tr></table>',
      );
      const rows = document.querySelectorAll('tr');
      assert.strictEqual(core.tableRowText(rows[0]), 'a | b');
      assert.strictEqual(core.tableRowText(rows[1]), 'c');
      assert.strictEqual(core.tableRowText(null), '');
    });
  });
});
