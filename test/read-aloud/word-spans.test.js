/* global suite, test, suiteSetup, suiteTeardown */

/**
 * T-01 … T-05 — `src/read-aloud/word-spans.ts` (F4).
 *
 * The module is pure (no `vscode`, no I/O), so it is compiled on the fly with
 * esbuild exactly like `test/block-id-helpers.test.js`.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let alignmentFromWire;
let buildCodeUnitIndex;
let charIndexAtCodeUnit;
let segmentWords;
let toWordSpans;
let tmpFile;

/** Times are `codeUnitOffset / 10`, so both alignment shapes agree exactly. */
function at(codeUnit) {
  return codeUnit / 10;
}

/** One alignment entry per UTF-16 code unit. */
function perCodeUnitAlignment(text) {
  const characters = text.split('');
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => at(i)),
    characterEndTimesSeconds: characters.map((_, i) => at(i + 1)),
  };
}

/** One alignment entry per code point (astral characters stay whole). */
function perCodePointAlignment(text) {
  const characters = Array.from(text);
  const starts = [];
  const ends = [];
  let offset = 0;
  for (const character of characters) {
    starts.push(at(offset));
    offset += character.length;
    ends.push(at(offset));
  }
  return {
    characters,
    characterStartTimesSeconds: starts,
    characterEndTimesSeconds: ends,
  };
}

function shape(spans) {
  return spans.map((span) => [span.text, span.charStart, span.charEnd]);
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
    const mod = require(tmpFile);
    alignmentFromWire = mod.alignmentFromWire;
    buildCodeUnitIndex = mod.buildCodeUnitIndex;
    charIndexAtCodeUnit = mod.charIndexAtCodeUnit;
    segmentWords = mod.segmentWords;
    toWordSpans = mod.toWordSpans;
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  // T-01
  suite('T-01 Latin grouping', function () {
    test('"Hello brave new world" becomes four spans', function () {
      const text = 'Hello brave new world';
      const spans = toWordSpans(text, perCodeUnitAlignment(text), 'en');
      assert.deepStrictEqual(spans, [
        { text: 'Hello', charStart: 0, charEnd: 5, start: at(0), end: at(5) },
        { text: 'brave', charStart: 6, charEnd: 11, start: at(6), end: at(11) },
        { text: 'new', charStart: 12, charEnd: 15, start: at(12), end: at(15) },
        {
          text: 'world',
          charStart: 16,
          charEnd: 21,
          start: at(16),
          end: at(21),
        },
      ]);
    });

    test('times come from the first and last character of the word', function () {
      const text = 'Hello brave new world';
      const alignment = perCodeUnitAlignment(text);
      const spans = toWordSpans(text, alignment, 'en');
      for (const span of spans) {
        assert.strictEqual(
          span.start,
          alignment.characterStartTimesSeconds[span.charStart],
        );
        assert.strictEqual(
          span.end,
          alignment.characterEndTimesSeconds[span.charEnd - 1],
        );
      }
    });

    test('spans are emitted in ascending charStart', function () {
      const text = 'Hello brave new world';
      const spans = toWordSpans(text, perCodeUnitAlignment(text), 'en');
      for (let i = 1; i < spans.length; i++) {
        assert.ok(spans[i].charStart > spans[i - 1].charStart);
      }
    });
  });

  // T-02
  suite('T-02 punctuation, quotes and em-dashes', function () {
    const text = 'He said, “don’t stop” — really!';

    test('punctuation, curly quotes and the em-dash produce no spans', function () {
      const spans = toWordSpans(text, perCodeUnitAlignment(text), 'en');
      assert.deepStrictEqual(shape(spans), [
        ['He', 0, 2],
        ['said', 3, 7],
        ['don’t', 10, 15],
        ['stop', 16, 20],
        ['really', 24, 30],
      ]);
    });

    test("straight-quoted don't is a single span", function () {
      const plain = "I don't stop";
      const spans = toWordSpans(plain, perCodeUnitAlignment(plain), 'en');
      assert.deepStrictEqual(shape(spans), [
        ['I', 0, 1],
        ["don't", 2, 7],
        ['stop', 8, 12],
      ]);
    });

    test('no span text contains a quote, comma, dash or exclamation mark', function () {
      const spans = toWordSpans(text, perCodeUnitAlignment(text), 'en');
      for (const span of spans) {
        assert.ok(!/[,!“”—]/.test(span.text), span.text);
      }
    });
  });

  // T-03
  suite('T-03 numerals, dates, currency, URLs and code', function () {
    test('v2.5, 2026-09-01 and $1,000', function () {
      const text = 'v2.5 released 2026-09-01 for $1,000';
      const spans = toWordSpans(text, perCodeUnitAlignment(text), 'en');
      assert.deepStrictEqual(shape(spans), [
        ['v2.5', 0, 4],
        ['released', 5, 13],
        ['2026', 14, 18],
        ['09', 19, 21],
        ['01', 22, 24],
        ['for', 25, 28],
        ['1,000', 30, 35],
      ]);
      assert.ok(!spans.some((span) => span.text.includes('$')));
    });

    test('a URL is split into word-like parts, separators excluded', function () {
      const text = 'See https://example.com/read-aloud now';
      const spans = toWordSpans(text, perCodeUnitAlignment(text), 'en');
      assert.deepStrictEqual(shape(spans), [
        ['See', 0, 3],
        ['https', 4, 9],
        ['example.com', 12, 23],
        ['read', 24, 28],
        ['aloud', 29, 34],
        ['now', 35, 38],
      ]);
    });

    test('backticks around inline code are not spoken as words', function () {
      const text = 'Use `npm run build` today';
      const spans = toWordSpans(text, perCodeUnitAlignment(text), 'en');
      assert.deepStrictEqual(shape(spans), [
        ['Use', 0, 3],
        ['npm', 5, 8],
        ['run', 9, 12],
        ['build', 13, 18],
        ['today', 20, 25],
      ]);
      assert.ok(!spans.some((span) => span.text.includes('`')));
    });
  });

  // T-04
  suite('T-04 CJK and astral characters', function () {
    test('CJK is segmented into dictionary words, not characters', function () {
      const text = '你好世界';
      const spans = toWordSpans(text, perCodeUnitAlignment(text), 'zh-CN');
      assert.deepStrictEqual(shape(spans), [
        ['你好', 0, 2],
        ['世界', 2, 4],
      ]);
      assert.deepStrictEqual(segmentWords(text, 'zh-CN'), [
        { index: 0, segment: '你好' },
        { index: 2, segment: '世界' },
      ]);
    });

    test('buildCodeUnitIndex / charIndexAtCodeUnit handle a surrogate pair', function () {
      const text = 'Hi 😀 ok';
      const perPoint = perCodePointAlignment(text);
      assert.strictEqual(perPoint.characters.length, 7);
      const prefix = buildCodeUnitIndex(perPoint.characters);
      assert.deepStrictEqual(prefix, [0, 1, 2, 3, 5, 6, 7, 8]);
      assert.strictEqual(charIndexAtCodeUnit(prefix, 3), 3);
      assert.strictEqual(charIndexAtCodeUnit(prefix, 4), 3);
      assert.strictEqual(charIndexAtCodeUnit(prefix, 6), 5);
      assert.strictEqual(charIndexAtCodeUnit(prefix, -1), -1);
      assert.strictEqual(charIndexAtCodeUnit(prefix, 8), -1);
    });

    test('per-code-unit and per-code-point alignments give identical spans', function () {
      const text = 'Hi 😀 ok';
      const byUnit = toWordSpans(text, perCodeUnitAlignment(text), 'en');
      const byPoint = toWordSpans(text, perCodePointAlignment(text), 'en');
      assert.deepStrictEqual(shape(byUnit), [
        ['Hi', 0, 2],
        ['ok', 6, 8],
      ]);
      assert.deepStrictEqual(byPoint, byUnit);
    });
  });

  // T-05
  suite('T-05 guards', function () {
    test('undefined when characters.join("") does not equal the text', function () {
      const text = 'Hello world';
      const alignment = perCodeUnitAlignment('Hello  world');
      assert.strictEqual(toWordSpans(text, alignment, 'en'), undefined);
    });

    test('alignmentFromWire rejects null, undefined and non-objects', function () {
      assert.strictEqual(alignmentFromWire(null), undefined);
      assert.strictEqual(alignmentFromWire(undefined), undefined);
      assert.strictEqual(alignmentFromWire('nope'), undefined);
    });

    test('alignmentFromWire rejects absent, empty and unequal arrays', function () {
      assert.strictEqual(alignmentFromWire({ characters: ['a'] }), undefined);
      assert.strictEqual(
        alignmentFromWire({
          characters: [],
          character_start_times_seconds: [],
          character_end_times_seconds: [],
        }),
        undefined,
      );
      assert.strictEqual(
        alignmentFromWire({
          characters: ['a', 'b'],
          character_start_times_seconds: [0],
          character_end_times_seconds: [0.1, 0.2],
        }),
        undefined,
      );
    });

    test('alignmentFromWire rejects non-numbers and non-strings', function () {
      assert.strictEqual(
        alignmentFromWire({
          characters: ['a'],
          character_start_times_seconds: ['0'],
          character_end_times_seconds: [0.1],
        }),
        undefined,
      );
      assert.strictEqual(
        alignmentFromWire({
          characters: ['a'],
          character_start_times_seconds: [Number.NaN],
          character_end_times_seconds: [0.1],
        }),
        undefined,
      );
      assert.strictEqual(
        alignmentFromWire({
          characters: [1],
          character_start_times_seconds: [0],
          character_end_times_seconds: [0.1],
        }),
        undefined,
      );
    });

    test('alignmentFromWire copies a well-formed payload to camelCase', function () {
      const alignment = alignmentFromWire({
        characters: ['H', 'i'],
        character_start_times_seconds: [0, 0.1],
        character_end_times_seconds: [0.1, 0.2],
      });
      assert.deepStrictEqual(alignment, {
        characters: ['H', 'i'],
        characterStartTimesSeconds: [0, 0.1],
        characterEndTimesSeconds: [0.1, 0.2],
      });
    });

    test('an end time before the start time is clamped to the start', function () {
      const text = 'ab';
      const spans = toWordSpans(
        text,
        {
          characters: ['a', 'b'],
          characterStartTimesSeconds: [0.5, 0.6],
          characterEndTimesSeconds: [0.6, 0.2],
        },
        'en',
      );
      assert.deepStrictEqual(spans, [
        { text: 'ab', charStart: 0, charEnd: 2, start: 0.5, end: 0.5 },
      ]);
    });

    test('undefined when a looked-up time is missing', function () {
      const text = 'ab';
      const spans = toWordSpans(
        text,
        {
          characters: ['a', 'b'],
          characterStartTimesSeconds: [0.5],
          characterEndTimesSeconds: [0.6],
        },
        'en',
      );
      assert.strictEqual(spans, undefined);
    });
  });
});
