/* global suite, test, suiteSetup, suiteTeardown */

/**
 * `src/retell/sections.ts` (`featrues/15-convert-readable/spec.md` §6,
 * §7.2): the outline with headings inside fences skipped and one-based
 * lines; the units a cover becomes; the word counts of a unit by kind, which
 * always sum to the total; and the cover check against the anchor's text.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { compileEntry, fixture } = require('./compile');

let sections;
let tmpFile;

/** A document with an h1, a preamble paragraph, two h2 sections, an h3 and a fence. */
const DOC = [
  '# The Title', // 1
  '', // 2
  'A preamble paragraph, before any section.', // 3
  '', // 4
  '## First section', // 5
  '', // 6
  'The first paragraph of the first section.', // 7
  'It wraps onto a second line.', // 8
  '', // 9
  '### A part of the first', // 10
  '', // 11
  'Some words under the h3.', // 12
  '', // 13
  '```md', // 14
  '# not a heading', // 15
  '## nor this', // 16
  '```', // 17
  '', // 18
  '## Second section', // 19
  '', // 20
  'The only paragraph of the second section.', // 21
  '', // the trailing newline: 21 lines
].join('\n');

function unitsOf(result) {
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  return result.units.map((u) => [u.n, u.heading, u.line, u.endLine]);
}

suite('retell/sections', function () {
  this.timeout(30000);

  suiteSetup(async function () {
    tmpFile = path.join(__dirname, '.sections.bundle.cjs');
    sections = await compileEntry('src/retell/sections.ts', tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  // ------------------------------------------------------------ outline

  test('outlineOf: every ATX heading outside fences, with one-based lines', function () {
    assert.deepStrictEqual(sections.outlineOf(DOC), [
      { level: 1, text: 'The Title', line: 1 },
      { level: 2, text: 'First section', line: 5 },
      { level: 3, text: 'A part of the first', line: 10 },
      { level: 2, text: 'Second section', line: 19 },
    ]);
    assert.strictEqual(sections.lineCount(DOC), 21);
    assert.strictEqual(sections.lineCount(''), 0);
    assert.strictEqual(sections.lineCount('one'), 1);
    assert.strictEqual(sections.lineCount('one\r\ntwo\r\n'), 2);
  });

  test('outlineOf: the front matter is skipped, trailing hashes and CRLF are handled', function () {
    const withFront = [
      '---',
      'title: x',
      '# not a heading in yaml',
      '---',
      '# Real heading ##',
      'text',
    ].join('\r\n');
    assert.deepStrictEqual(sections.outlineOf(withFront), [
      { level: 1, text: 'Real heading', line: 5 },
    ]);
    assert.deepStrictEqual(sections.outlineOf(''), []);
    assert.deepStrictEqual(sections.outlineOf('#hashtag, not a heading'), []);
  });

  test("the fixture's outline: the h2 and its five h3s, none from inside a fence", function () {
    const outline = sections.outlineOf(fixture('section-7.source.md'));
    assert.deepStrictEqual(
      outline.map((h) => [h.level, h.text, h.line]),
      [
        [2, '7. Specs, ADRs, constitution', 1],
        [3, 'Specs', 3],
        [3, 'ADRs', 9],
        [3, 'Linking code to specs', 20],
        [3, 'Should source code link to specs?', 145],
        [3, 'Constitution', 158],
      ],
    );
  });

  test('headingsIn, breadcrumbFor, sameHeading and normaliseHeadingText', function () {
    const outline = sections.outlineOf(DOC);
    assert.deepStrictEqual(
      sections.headingsIn(outline, { line: 5, endLine: 17 }).map((h) => h.text),
      ['First section', 'A part of the first'],
    );
    assert.deepStrictEqual(
      sections.breadcrumbFor(outline, { line: 5, level: 2 }),
      ['The Title'],
    );
    assert.deepStrictEqual(
      sections.breadcrumbFor(outline, { line: 10, level: 3 }),
      ['The Title', 'First section'],
    );
    assert.deepStrictEqual(
      sections.breadcrumbFor(outline, { line: 1, level: 1 }),
      [],
    );
    assert.strictEqual(
      sections.normaliseHeadingText('  **7.** _Specs_, `ADRs`   ##  '),
      '7. Specs, ADRs',
    );
    assert.strictEqual(
      sections.sameHeading('## The **measure**', '## the measure'),
      true,
    );
    assert.strictEqual(sections.sameHeading('Specs', 'ADRs'), false);
  });

  // -------------------------------------------------------------- units

  test('allUnits: the preamble headed by the h1, then one unit per h2', function () {
    assert.deepStrictEqual(
      sections
        .allUnits(DOC)
        .map((u) => [u.n, u.heading, u.level, u.line, u.endLine, u.preamble]),
      [
        [1, 'The Title', 1, 1, 3, true],
        [2, 'First section', 2, 5, 17, false],
        [3, 'Second section', 2, 19, 21, false],
      ],
    );
    // An h1 followed at once by the first h2 makes no preamble unit.
    const tight = '# T\n\n## A\n\ntext\n\n## B\n\nmore\n';
    assert.deepStrictEqual(
      sections.allUnits(tight).map((u) => [u.heading, u.line, u.endLine]),
      [
        ['A', 3, 5],
        ['B', 7, 9],
      ],
    );
    // Text before an h1 is headed by the file name.
    const loose = 'intro\n\n# T\n\nafter\n\n## A\n\nx\n';
    assert.deepStrictEqual(
      sections
        .allUnits(loose, { fileName: 'doc.md' })
        .map((u) => [u.heading, u.line, u.endLine, u.preamble]),
      [
        ['doc.md', 1, 1, true],
        ['T', 3, 5, true],
        ['A', 7, 9, false],
      ],
    );
    // Front matter belongs to no unit.
    const front = '---\ntitle: x\n---\n\nintro\n\n## A\n\nx\n';
    assert.deepStrictEqual(
      sections
        .allUnits(front, { fileName: 'doc.md' })
        .map((u) => [u.heading, u.line, u.endLine]),
      [
        ['doc.md', 5, 5],
        ['A', 7, 9],
      ],
    );
  });

  test('unitsFor: a cover inside one h2 section gives that unit, widened', function () {
    const result = sections.unitsFor(DOC, { startLine: 7, endLine: 8 });
    assert.deepStrictEqual(unitsOf(result), [[1, 'First section', 5, 17]]);
    assert.strictEqual(result.widened, true);
    // The whole section, from its heading to its last block: not widened.
    const whole = sections.unitsFor(DOC, { startLine: 5, endLine: 14 });
    assert.deepStrictEqual(unitsOf(whole), [[1, 'First section', 5, 17]]);
    assert.strictEqual(
      whole.widened,
      false,
      "the cover's last line is the fence's first; the fence's end is the cover's",
    );
    const fixtureSource = fixture('section-7.source.md');
    const inside = sections.unitsFor(fixtureSource, {
      startLine: 30,
      endLine: 30,
    });
    assert.deepStrictEqual(unitsOf(inside), [
      [1, '7. Specs, ADRs, constitution', 1, 170],
    ]);
    assert.strictEqual(inside.widened, true);
    const all = sections.unitsFor(fixtureSource, {
      startLine: 1,
      endLine: 170,
    });
    assert.strictEqual(all.widened, false);
  });

  test('unitsFor: a cover across two sections gives two units, split at the boundary and renumbered', function () {
    const result = sections.unitsFor(DOC, { startLine: 12, endLine: 21 });
    assert.deepStrictEqual(unitsOf(result), [
      [1, 'First section', 5, 17],
      [2, 'Second section', 19, 21],
    ]);
    assert.strictEqual(result.widened, true);
    const both = sections.unitsFor(DOC, { startLine: 5, endLine: 21 });
    assert.strictEqual(both.widened, false);
  });

  test('unitsFor: a selected h2 line extends to the next h2; a selected h3 widens to its h2', function () {
    const h2 = sections.unitsFor(DOC, { startLine: 5, endLine: 5 });
    assert.deepStrictEqual(unitsOf(h2), [[1, 'First section', 5, 17]]);
    assert.strictEqual(h2.widened, false, 'the heading means the section');
    const h3 = sections.unitsFor(DOC, { startLine: 10, endLine: 10 });
    assert.deepStrictEqual(unitsOf(h3), [[1, 'First section', 5, 17]]);
    assert.strictEqual(h3.widened, true);
    // An h1 heading selected runs to the next heading of its level or the
    // end (§6.2 step 1): every unit of the document, and not widened.
    const h1 = sections.unitsFor(DOC, { startLine: 1, endLine: 1 });
    assert.deepStrictEqual(unitsOf(h1), [
      [1, 'The Title', 1, 3],
      [2, 'First section', 5, 17],
      [3, 'Second section', 19, 21],
    ]);
    assert.strictEqual(h1.widened, false);
  });

  test('unitsFor: a cover in the preamble gives the preamble unit named by the h1', function () {
    const result = sections.unitsFor(DOC, { startLine: 3, endLine: 3 });
    assert.deepStrictEqual(unitsOf(result), [[1, 'The Title', 1, 3]]);
    assert.strictEqual(result.units[0].preamble, true);
    assert.strictEqual(result.units[0].level, 1);
  });

  test('unitsFor: a document with no h2 is one unit; an empty one refuses', function () {
    const plain = 'Just a paragraph.\n\nAnd another.\n';
    const result = sections.unitsFor(
      plain,
      { startLine: 3, endLine: 3 },
      { fileName: 'notes.md' },
    );
    assert.deepStrictEqual(unitsOf(result), [[1, 'notes.md', 1, 3]]);
    assert.strictEqual(result.widened, true);
    const titled = '# Only a title\n\nwith text under it\n';
    assert.deepStrictEqual(
      unitsOf(sections.unitsFor(titled, { startLine: 3, endLine: 3 })),
      [[1, 'Only a title', 1, 3]],
    );
    assert.deepStrictEqual(
      sections.unitsFor('', { startLine: 1, endLine: 1 }),
      {
        ok: false,
        reason: 'no-sections',
      },
    );
    assert.deepStrictEqual(
      sections.unitsFor('\n\n\n', { startLine: 1, endLine: 1 }),
      { ok: false, reason: 'no-sections' },
    );
    // A cover on the front matter, before any unit, lands on no unit.
    const front = '---\ntitle: x\n---\n\n## A\n\nx\n';
    assert.deepStrictEqual(
      sections.unitsFor(front, { startLine: 2, endLine: 2 }),
      {
        ok: false,
        reason: 'no-sections',
      },
    );
  });

  test('unitsFor: a caret on the blank line between two units belongs to the earlier one; lines are clamped', function () {
    const gap = sections.unitsFor(DOC, { startLine: 18, endLine: 18 });
    assert.deepStrictEqual(unitsOf(gap), [[1, 'First section', 5, 17]]);
    const past = sections.unitsFor(DOC, { startLine: 900, endLine: 900 });
    assert.deepStrictEqual(unitsOf(past), [[1, 'Second section', 19, 21]]);
  });

  // -------------------------------------------------------------- stats

  test('sectionStats: the three kinds sum to the total; a fence in a list item and a table row inside a fence', function () {
    const doc = [
      '## S',
      '',
      'One two three.',
      '',
      '- item one',
      '- item two',
      '',
      '  ```ts',
      '  // nested fence',
      '  ```',
      '',
      '| a | b |',
      '|---|---|',
      '| c | d |',
      '',
      '```txt',
      '| not | a | table |',
      '```',
      '',
      'Tail words.',
    ].join('\n');
    const unit = { line: 1, endLine: 20 };
    const stats = sections.sectionStats(doc, unit);
    assert.strictEqual(
      stats.words,
      stats.codeWords + stats.tableWords + stats.proseWords,
    );
    assert.strictEqual(stats.fences, 2);
    assert.strictEqual(stats.tables, 1);
    // The nested fence's three lines (1 + 3 + 1 words) and the txt fence's
    // three (1 + 7 + 1): the fence lines themselves count as code.
    assert.strictEqual(stats.codeWords, 5 + 9);
    assert.strictEqual(stats.tableWords, 5 + 1 + 5);
    assert.strictEqual(stats.proseWords, 2 + 3 + 3 + 3 + 2);
    assert.strictEqual(
      sections.sectionText(doc, { line: 3, endLine: 3 }),
      'One two three.',
    );
    assert.strictEqual(
      sections.sectionText(doc, { line: 30, endLine: 40 }),
      '',
    );
  });

  test('sectionStats on section 7: 1,323 source words, 722 prose, 242 in 3 tables, 359 in 7 code blocks', function () {
    // The experiment's 1,246 counted the *rendered* text (measure.js sums
    // `el.textContent` words), which has no fence markers, pipes, bullets or
    // heading hashes; the source markdown, counted as §7.2 says, is 1,323.
    const source = fixture('section-7.source.md');
    const unit = sections.allUnits(source)[0];
    const stats = sections.sectionStats(source, unit);
    assert.deepStrictEqual(stats, {
      words: 1323,
      codeWords: 359,
      tableWords: 242,
      proseWords: 722,
      fences: 7,
      tables: 3,
    });
    assert.strictEqual(
      stats.words,
      stats.codeWords + stats.tableWords + stats.proseWords,
    );
    const three = fixture('run-4-section-3.source.md');
    assert.deepStrictEqual(
      sections.sectionStats(three, sections.allUnits(three)[0]),
      {
        words: 304,
        codeWords: 0,
        tableWords: 298,
        proseWords: 6,
        fences: 0,
        tables: 1,
      },
    );
    const nine = fixture('run-5-section-9.source.md');
    const nineStats = sections.sectionStats(nine, sections.allUnits(nine)[0]);
    assert.strictEqual(nineStats.words, 426);
    assert.strictEqual(nineStats.fences, 4);
    assert.strictEqual(nineStats.tables, 0);
    assert.strictEqual(nineStats.codeWords, 133);
  });

  // -------------------------------------------------------- cover check

  test('coverCheck: the anchor at the line, a few lines down, wrapped across lines', function () {
    assert.deepStrictEqual(
      sections.coverCheck(DOC, 7, 'The first paragraph of the first section.'),
      { ok: true, startLine: 7, moved: false },
    );
    // The passage's block starts at 5 (the heading); its text is two lines down.
    assert.deepStrictEqual(sections.coverCheck(DOC, 5, 'The first paragraph'), {
      ok: true,
      startLine: 5,
      moved: false,
    });
    // Whitespace-insensitive: the extracted text has one space where the
    // source wraps.
    assert.deepStrictEqual(
      sections.coverCheck(
        DOC,
        7,
        'first section. It wraps onto a second line.',
      ),
      { ok: true, startLine: 7, moved: false },
    );
    assert.deepStrictEqual(sections.coverCheck(DOC, 7, '   '), {
      ok: true,
      startLine: 7,
      moved: false,
    });
  });

  test('coverCheck: one hit elsewhere moves the cover; two refuse; none refuse', function () {
    assert.deepStrictEqual(
      sections.coverCheck(DOC, 1, 'The only paragraph of the second section.'),
      { ok: true, startLine: 21, moved: true },
    );
    const twice =
      DOC + '\n## Third\n\nThe only paragraph of the second section.\n';
    assert.deepStrictEqual(
      sections.coverCheck(
        twice,
        1,
        'The only paragraph of the second section.',
      ),
      { ok: false, reason: 'ambiguous' },
    );
    assert.deepStrictEqual(
      sections.coverCheck(DOC, 7, 'words that are nowhere in this document'),
      { ok: false, reason: 'missing' },
    );
    // Only the first 40 letters and digits are compared.
    assert.deepStrictEqual(
      sections.coverCheck(
        DOC,
        7,
        'The first paragraph of the first section. It wraps onto a second line. And then some words that are not there.',
      ),
      { ok: true, startLine: 7, moved: false },
    );
    assert.strictEqual(sections.COVER_CHECK_WINDOW_LINES, 5);
    assert.strictEqual(sections.COVER_CHECK_CHARS, 40);
  });

  test('coverCheck: the render and the markdown agree once inline markup is dropped (bold, link, code, tag, typographer)', function () {
    const doc = [
      '# T',
      '',
      '## Specs',
      '',
      'Keep **one living spec per area or feature** that is the current truth.',
      'Express changes as deltas (the [OpenSpec](https://openspec.dev/) pattern) --',
      'see `drift.lock` and <abbr title="architecture decision record">ADRs</abbr>.',
      'Say "never" \\*literally\\*, not _sometimes_.',
      '',
      '| Column | Value |',
      '| --- | --- |',
      '| Keep the **bold** cell | 1 |',
      '',
    ].join('\n');
    // The screenshot case: a selection starting inside bold text.
    assert.deepStrictEqual(
      sections.coverCheck(
        doc,
        5,
        'Keep one living spec per area or feature that is the current truth.',
      ),
      { ok: true, startLine: 5, moved: false },
    );
    // A link's destination, a code span, an HTML tag and the typographer's
    // dash never reach the comparison.
    assert.deepStrictEqual(
      sections.coverCheck(
        doc,
        6,
        'Express changes as deltas (the OpenSpec pattern) — see drift.lock and ADRs.',
      ),
      { ok: true, startLine: 6, moved: false },
    );
    // Curly quotes, escapes and emphasis.
    assert.deepStrictEqual(
      sections.coverCheck(doc, 8, 'Say “never” *literally*, not sometimes.'),
      { ok: true, startLine: 8, moved: false },
    );
    // A table cell's text against its pipes.
    assert.deepStrictEqual(sections.coverCheck(doc, 12, 'Keep the bold cell'), {
      ok: true,
      startLine: 12,
      moved: false,
    });
    // A needle of markup alone is no needle: nothing to check.
    assert.deepStrictEqual(sections.coverCheck(doc, 5, '** -- ( ) **'), {
      ok: true,
      startLine: 5,
      moved: false,
    });
    assert.strictEqual(
      sections.coverText(
        'Keep **one living** [spec](https://x.y/z) <b>now</b> “q”',
      ),
      'Keeponelivingspecnowq',
    );
  });
});
