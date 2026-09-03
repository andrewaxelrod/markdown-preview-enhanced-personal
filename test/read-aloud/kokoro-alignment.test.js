/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

/**
 * `src/read-aloud/kokoro-alignment.ts` — Kokoro-FastAPI word timestamps ->
 * word spans over the sent text (F4 for the Kokoro provider).
 *
 * The fixtures are the token lists Kokoro-FastAPI actually returned for these
 * sentences (normalisation off), including the run of words it drops after a
 * bare `$` token. Pure module, compiled on the fly with esbuild like
 * `test/read-aloud/word-spans.test.js`.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let mod;
let tmpFile;

function tok(word, start, end) {
  return { word, start, end };
}

/** Words of `text` per the same segmenter the module uses. */
function wordsOf(text) {
  const seg = new Intl.Segmenter('en', { granularity: 'word' });
  return Array.from(seg.segment(text))
    .filter((s) => s.isWordLike)
    .map((s) => s.segment);
}

function assertSpanShape(spans, text) {
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    assert.strictEqual(
      text.slice(span.charStart, span.charEnd),
      span.text,
      `span ${i} indexes its own text`,
    );
    assert.ok(Number.isFinite(span.start), `span ${i} start finite`);
    assert.ok(Number.isFinite(span.end), `span ${i} end finite`);
    assert.ok(span.end >= span.start, `span ${i} end >= start`);
    if (i > 0) {
      assert.ok(
        span.charStart >= spans[i - 1].charEnd,
        `span ${i} follows span ${i - 1} in the text`,
      );
      assert.ok(
        span.start >= spans[i - 1].start - 1e-9,
        `span ${i} does not start before span ${i - 1}`,
      );
    }
  }
}

suite('read-aloud/kokoro-alignment', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    const result = await esbuild.build({
      entryPoints: [
        path.join(
          __dirname,
          '..',
          '..',
          'src',
          'read-aloud',
          'kokoro-alignment.ts',
        ),
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      external: ['vscode', 'crossnote'],
    });
    tmpFile = path.join(__dirname, '.kokoro-alignment.bundle.cjs');
    fs.writeFileSync(tmpFile, result.outputFiles[0].text);
    mod = require(tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  test('foldForAlignment keeps letters, marks and digits only, case-folded', function () {
    assert.strictEqual(mod.foldForAlignment("Smith's"), 'smiths');
    assert.strictEqual(mod.foldForAlignment('Smith’s'), 'smiths');
    assert.strictEqual(mod.foldForAlignment('10,000-credit'), '10000credit');
    assert.strictEqual(mod.foldForAlignment('U.S.'), 'us');
    assert.strictEqual(mod.foldForAlignment('...'), '');
    assert.strictEqual(mod.foldForAlignment('Ünïcode'), 'ünïcode');
  });

  test('one-to-one tokens time every word and punctuation tokens are dropped', function () {
    const text = 'Hello there, world.';
    const words = [
      tok('Hello', 0.0, 0.3),
      tok('there', 0.3, 0.6),
      tok(',', 0.6, 0.65),
      tok('world', 0.65, 1.0),
      tok('.', 1.0, 1.1),
    ];
    const aligned = mod.alignKokoroWords(text, words, 'en');
    assert.ok(aligned);
    assert.strictEqual(aligned.matched, 3);
    assert.strictEqual(aligned.total, 3);
    assert.strictEqual(aligned.audioEnd, 1.1);
    assert.deepStrictEqual(
      aligned.spans.map((s) => [s.text, s.start, s.end]),
      [
        ['Hello', 0.0, 0.3],
        ['there', 0.3, 0.6],
        ['world', 0.65, 1.0],
      ],
    );
    assertSpanShape(aligned.spans, text);
  });

  test('a hyphenated or dotted token covers several words, split by length', function () {
    const text = 'The read-aloud feature was built on 2024-09-02.';
    const words = [
      tok('The', 0.001, 0.113),
      tok('read-aloud', 0.113, 0.701),
      tok('feature', 0.701, 1.076),
      tok('was', 1.076, 1.251),
      tok('built', 1.251, 1.551),
      tok('on', 1.551, 1.763),
      tok('2024-09-02', 1.763, 4.326),
      tok('.', 4.326, 4.501),
    ];
    const aligned = mod.alignKokoroWords(text, words, 'en');
    assert.ok(aligned);
    assert.deepStrictEqual(
      aligned.spans.map((s) => s.text),
      wordsOf(text),
    );
    assert.strictEqual(aligned.matched, aligned.total);
    const byText = Object.fromEntries(aligned.spans.map((s) => [s.text, s]));
    assert.strictEqual(byText.read.start, 0.113);
    assert.ok(byText.read.end > 0.113 && byText.read.end < 0.701);
    assert.strictEqual(byText.aloud.start, byText.read.end);
    assert.strictEqual(byText.aloud.end, 0.701);
    // "2024" (4 chars) gets half of the token's time, "09" and "02" a quarter each.
    assert.strictEqual(byText['2024'].start, 1.763);
    assert.ok(Math.abs(byText['2024'].end - (1.763 + 2.563 / 2)) < 1e-6);
    assert.strictEqual(byText['02'].end, 4.326);
    assertSpanShape(aligned.spans, text);
  });

  test('one word spanning several tokens takes the first start and the last end', function () {
    const text = "Don't stop.";
    const words = [
      tok('Do', 0.0, 0.2),
      tok("n't", 0.2, 0.35),
      tok('stop', 0.4, 0.8),
      tok('.', 0.8, 0.9),
    ];
    const aligned = mod.alignKokoroWords(text, words, 'en');
    assert.ok(aligned);
    assert.deepStrictEqual(
      aligned.spans.map((s) => [s.text, s.start, s.end]),
      [
        ["Don't", 0.0, 0.35],
        ['stop', 0.4, 0.8],
      ],
    );
    assert.strictEqual(aligned.matched, 2);
  });

  test('a run of words the server dropped is interpolated between its timed neighbours', function () {
    // Kokoro-FastAPI output for this sentence: everything from "$12.50" to
    // "speed." is missing (a bare "$" token has no phonemes and the server
    // stops timestamping the chunk), while the audio is still there.
    const text =
      'It costs 0.5 credits per character, or $12.50 of value at 4x speed. Dr. Smith shipped it.';
    const words = [
      tok('It', 4.501, 4.651),
      tok('costs', 4.651, 5.063),
      tok('0.5', 5.063, 6.101),
      tok('credits', 6.101, 6.476),
      tok('per', 6.476, 6.626),
      tok('character', 6.626, 7.376),
      tok(',', 7.376, 7.476),
      tok('or', 12.251, 12.376),
      tok('Dr.', 15.951, 16.351),
      tok('Smith', 16.351, 16.726),
      tok('shipped', 18.388, 18.626),
      tok('it', 18.626, 18.701),
      tok('.', 18.701, 18.8),
    ];
    const aligned = mod.alignKokoroWords(text, words, 'en');
    assert.ok(aligned);
    assert.deepStrictEqual(
      aligned.spans.map((s) => s.text),
      wordsOf(text),
    );
    assert.strictEqual(aligned.total, 17);
    assert.strictEqual(aligned.matched, 11);
    const byText = Object.fromEntries(aligned.spans.map((s) => [s.text, s]));
    // The gap [12.376, 15.951] is shared by "12.50 of value at 4x speed".
    assert.strictEqual(byText['12.50'].start, 12.376);
    assert.ok(byText['12.50'].end > 12.376);
    assert.ok(byText.of.start >= byText['12.50'].end - 1e-9);
    assert.ok(byText.value.start > byText.of.start);
    assert.ok(byText.at.start > byText.value.start);
    assert.ok(byText['4x'].start > byText.at.start);
    assert.ok(byText.speed.start > byText['4x'].start);
    assert.strictEqual(byText.speed.end, 15.951);
    assert.strictEqual(byText.Dr.start, 15.951);
    assertSpanShape(aligned.spans, text);
  });

  test('extra tokens with no counterpart in the text are skipped on resync', function () {
    const text = 'One two three.';
    const words = [
      tok('One', 0, 0.2),
      tok('and', 0.2, 0.3),
      tok('a', 0.3, 0.35),
      tok('two', 0.4, 0.6),
      tok('three', 0.6, 0.9),
    ];
    const aligned = mod.alignKokoroWords(text, words, 'en');
    assert.ok(aligned);
    assert.deepStrictEqual(
      aligned.spans.map((s) => [s.text, s.start, s.end]),
      [
        ['One', 0, 0.2],
        ['two', 0.4, 0.6],
        ['three', 0.6, 0.9],
      ],
    );
    assert.strictEqual(aligned.matched, 3);
  });

  test('a leading and a trailing untimed run are anchored to the audio bounds', function () {
    const text = 'alpha beta gamma delta';
    const words = [tok('beta', 1.0, 1.5), tok('gamma', 1.5, 2.0)];
    const aligned = mod.alignKokoroWords(text, words, 'en');
    assert.ok(aligned);
    assert.deepStrictEqual(
      aligned.spans.map((s) => [s.text, s.start, s.end]),
      [
        ['alpha', 0, 1.0],
        ['beta', 1.0, 1.5],
        ['gamma', 1.5, 2.0],
        ['delta', 2.0, 2.0],
      ],
    );
    assert.strictEqual(aligned.matched, 2);
    assert.strictEqual(aligned.audioEnd, 2.0);
  });

  test('case, curly apostrophes and trailing dots do not break a match', function () {
    const text = 'Smith’s team (the U.S. group) shipped it.';
    const words = [
      tok("Smith's", 0, 0.4),
      tok('team', 0.4, 1.0),
      tok('(', 1.0, 1.05),
      tok('the', 1.05, 1.15),
      tok('U.S.', 1.15, 1.6),
      tok('group', 1.6, 2.0),
      tok(')', 2.0, 2.1),
      tok('shipped', 2.1, 2.4),
      tok('it', 2.4, 2.5),
      tok('.', 2.5, 2.6),
    ];
    const aligned = mod.alignKokoroWords(text, words, 'en');
    assert.ok(aligned);
    assert.strictEqual(aligned.matched, aligned.total);
    const byText = Object.fromEntries(aligned.spans.map((s) => [s.text, s]));
    assert.deepStrictEqual(
      [byText['Smith’s'].start, byText['Smith’s'].end],
      [0, 0.4],
    );
    assert.deepStrictEqual(
      [byText['U.S'].start, byText['U.S'].end],
      [1.15, 1.6],
    );
  });

  test('undefined when nothing can be matched, or when there are no words or tokens', function () {
    assert.strictEqual(
      mod.alignKokoroWords(
        'alpha beta',
        [tok('gamma', 0, 1), tok('delta', 1, 2)],
        'en',
      ),
      undefined,
    );
    assert.strictEqual(
      mod.alignKokoroWords('...', [tok('a', 0, 1)], 'en'),
      undefined,
    );
    assert.strictEqual(mod.alignKokoroWords('alpha', [], 'en'), undefined);
    assert.strictEqual(
      mod.alignKokoroWords('alpha', [tok('.', 0, 1), tok('', 1, 2)], 'en'),
      undefined,
    );
  });

  test('malformed tokens are ignored and end < start is clamped', function () {
    const text = 'alpha beta';
    const words = [
      tok('alpha', 0.5, 0.2),
      null,
      { word: 42, start: 0, end: 1 },
      tok('beta', NaN, 1),
      tok('beta', 0.6, 0.9),
    ];
    const aligned = mod.alignKokoroWords(text, words, 'en');
    assert.ok(aligned);
    assert.deepStrictEqual(
      aligned.spans.map((s) => [s.text, s.start, s.end]),
      [
        ['alpha', 0.5, 0.5],
        ['beta', 0.6, 0.9],
      ],
    );
  });
});
