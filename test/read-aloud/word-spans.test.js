/* global suite, test, suiteSetup, suiteTeardown */

/**
 * T-01 … T-05 — `src/read-aloud/word-spans.ts` (F4): the word segmentation
 * the Kokoro alignment is built on.
 *
 * The module is pure (no `vscode`, no I/O), so it is compiled on the fly with
 * esbuild exactly like `test/block-id-helpers.test.js`.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let segmentWords;
let tmpFile;

function shape(segments) {
  return segments.map((segment) => [segment.segment, segment.index]);
}

/** The reference: `Intl.Segmenter` word granularity, word-like only. */
function reference(text, locale) {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
  return Array.from(segmenter.segment(text))
    .filter((data) => data.isWordLike)
    .map((data) => ({ index: data.index, segment: data.segment }));
}

suite('read-aloud/word-spans', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    const result = await esbuild.build({
      entryPoints: [
        path.join(__dirname, '..', '..', 'src', 'read-aloud', 'word-spans.ts'),
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      external: ['vscode', 'crossnote'],
    });
    tmpFile = path.join(__dirname, '.word-spans.bundle.cjs');
    fs.writeFileSync(tmpFile, result.outputFiles[0].text);
    segmentWords = require(tmpFile).segmentWords;
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  // T-01
  suite('T-01 Latin grouping', function () {
    test('"Hello brave new world" becomes four segments with their offsets', function () {
      assert.deepStrictEqual(
        shape(segmentWords('Hello brave new world', 'en')),
        [
          ['Hello', 0],
          ['brave', 6],
          ['new', 12],
          ['world', 16],
        ],
      );
    });

    test('segments index their own text and are in ascending order', function () {
      const text = 'Read aloud, from here to the end of the document.';
      const segments = segmentWords(text, 'en');
      assert.ok(segments.length >= 9);
      let last = -1;
      for (const segment of segments) {
        assert.strictEqual(
          text.slice(segment.index, segment.index + segment.segment.length),
          segment.segment,
        );
        assert.ok(segment.index > last);
        last = segment.index;
      }
    });
  });

  // T-02
  suite('T-02 punctuation, quotes and dashes', function () {
    test('punctuation, curly quotes and the em-dash produce no segments', function () {
      const text = 'Wait, “really”—yes!';
      assert.deepStrictEqual(shape(segmentWords(text, 'en')), [
        ['Wait', 0],
        ['really', 7],
        ['yes', 15],
      ]);
    });

    test("straight-quoted don't is a single segment", function () {
      assert.deepStrictEqual(shape(segmentWords("I don't know", 'en')), [
        ['I', 0],
        ["don't", 2],
        ['know', 8],
      ]);
    });
  });

  // T-03
  suite('T-03 numerals, dates, currency, URLs and code', function () {
    test('matches the Intl.Segmenter reference for mixed technical text', function () {
      for (const text of [
        'Version v2.5 shipped on 2026-09-01 for $1,000.',
        'See https://example.com/docs?x=1 or `inline code` now.',
        'A read-aloud pass over 10,000-credit quotas.',
      ]) {
        assert.deepStrictEqual(segmentWords(text, 'en'), reference(text, 'en'));
      }
    });

    test('a URL is split into word-like parts, separators excluded', function () {
      const segments = segmentWords('https://example.com/docs', 'en').map(
        (segment) => segment.segment,
      );
      assert.ok(segments.includes('https'));
      // A dot between letters is word-internal for the segmenter, like v2.5.
      assert.ok(segments.includes('example.com'));
      assert.ok(segments.includes('docs'));
      for (const segment of segments) {
        assert.ok(!/[:/]/.test(segment), segment);
      }
    });
  });

  // T-04
  suite('T-04 CJK and astral characters', function () {
    test('CJK is segmented into dictionary words, not characters', function () {
      assert.deepStrictEqual(segmentWords('你好世界', 'zh-CN'), [
        { index: 0, segment: '你好' },
        { index: 2, segment: '世界' },
      ]);
    });

    test('indexes are UTF-16 code units, so an emoji counts twice', function () {
      assert.deepStrictEqual(shape(segmentWords('Hi 😀 ok', 'en')), [
        ['Hi', 0],
        ['ok', 6],
      ]);
    });
  });

  // T-05
  suite('T-05 fallbacks', function () {
    test('an unusable locale falls back to English segmentation', function () {
      assert.deepStrictEqual(
        segmentWords('Hello world', 'not-a-locale-at-all-!!'),
        reference('Hello world', 'en'),
      );
    });

    test('without Intl.Segmenter, whitespace-delimited runs are the words', function () {
      const original = Intl.Segmenter;
      try {
        Intl.Segmenter = undefined;
        assert.deepStrictEqual(shape(segmentWords('Hello, world!', 'en')), [
          ['Hello,', 0],
          ['world!', 7],
        ]);
      } finally {
        Intl.Segmenter = original;
      }
    });

    test('empty text has no segments', function () {
      assert.deepStrictEqual(segmentWords('', 'en'), []);
      assert.deepStrictEqual(segmentWords('   ', 'en'), []);
    });
  });
});
