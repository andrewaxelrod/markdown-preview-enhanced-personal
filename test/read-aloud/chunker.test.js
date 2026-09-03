/* global suite, test, suiteSetup, suiteTeardown */

/**
 * T-06 … T-08 — `src/read-aloud/chunker.ts` (F11, decision 5).
 *
 * The module is pure, so it is compiled on the fly with esbuild exactly
 * like `test/block-id-helpers.test.js`.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let chunker;
let tmpFile;

const SENTENCES =
  'One two three. Four five six. Seven eight nine. Ten eleven twelve.';

const LONG = Array.from(
  { length: 12 },
  (_, i) => `Sentence number ${i + 1} is here to fill the paragraph out.`,
).join(' ');

function stripWhitespace(value) {
  return value.replace(/\s+/g, '');
}

suite('read-aloud/chunker', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    const result = await esbuild.build({
      entryPoints: [
        path.join(__dirname, '..', '..', 'src', 'read-aloud', 'chunker.ts'),
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      external: ['vscode', 'crossnote'],
    });
    tmpFile = path.join(__dirname, '.chunker.bundle.cjs');
    fs.writeFileSync(tmpFile, result.outputFiles[0].text);
    chunker = require(tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  // T-06
  suite('T-06 sentence packing under the effective limit', function () {
    test('effectiveLimit applies the 5 % margin', function () {
      assert.strictEqual(chunker.LIMIT_MARGIN, 0.05);
      assert.strictEqual(chunker.effectiveLimit(10000), 9500);
      assert.strictEqual(chunker.effectiveLimit(100), 95);
      assert.strictEqual(chunker.effectiveLimit(34), 32);
      assert.strictEqual(chunker.effectiveLimit(1), 1);
      assert.strictEqual(chunker.effectiveLimit(0), 1);
    });

    test('whole sentences are packed greedily under the limit', function () {
      const plan = chunker.planChunks(SENTENCES, 34, 'en');
      assert.strictEqual(plan.limit, 32);
      assert.deepStrictEqual(
        plan.chunks.map((chunk) => [chunk.index, chunk.charOffset, chunk.text]),
        [
          [0, 0, 'One two three. Four five six.'],
          [1, 30, 'Seven eight nine.'],
          [2, 48, 'Ten eleven twelve.'],
        ],
      );
      for (const chunk of plan.chunks) {
        assert.ok(chunk.text.length <= plan.limit, chunk.text);
        assert.strictEqual(chunk.text, chunk.text.trim());
        assert.ok(chunk.text.length > 0);
        assert.strictEqual(chunk.blockIndex, 0);
      }
    });

    test('text shorter than the limit yields exactly one chunk', function () {
      const plan = chunker.planChunks('  Hello world.  ', 10000, 'en');
      assert.strictEqual(plan.chunks.length, 1);
      assert.strictEqual(plan.chunks[0].text, 'Hello world.');
      assert.strictEqual(plan.chunks[0].charOffset, 2);
    });
  });

  // A short first chunk, larger ones after it, never above the limit.
  suite('T-06b chunk targets', function () {
    test('defaults are 250 for the first chunk and 700 after it', function () {
      assert.strictEqual(chunker.FIRST_CHUNK_TARGET_CHARS, 250);
      assert.strictEqual(chunker.CHUNK_TARGET_CHARS, 700);
      assert.deepStrictEqual(chunker.DEFAULT_CHUNK_TARGETS, {
        first: 250,
        rest: 700,
      });
    });

    test('a long paragraph starts with a short chunk and continues in larger ones', function () {
      const plan = chunker.planChunks(LONG, 10000, 'en');
      assert.ok(plan.chunks.length >= 2, 'the text must be split');
      assert.ok(plan.chunks[0].text.length <= 250, plan.chunks[0].text);
      assert.ok(
        plan.chunks[0].text.length > 100,
        'packs more than one sentence',
      );
      for (const chunk of plan.chunks.slice(1)) {
        assert.ok(chunk.text.length <= 700, chunk.text);
      }
      // The second chunk really uses the larger target.
      assert.ok(plan.chunks[1].text.length > 250, plan.chunks[1].text);
      assert.strictEqual(
        stripWhitespace(plan.chunks.map((chunk) => chunk.text).join('')),
        stripWhitespace(LONG),
      );
      for (const chunk of plan.chunks) {
        assert.strictEqual(
          LONG.slice(chunk.charOffset, chunk.charOffset + chunk.text.length),
          chunk.text,
        );
      }
    });

    test('explicit targets pack the first chunk and the rest differently', function () {
      const plan = chunker.planChunks(SENTENCES, 10000, 'en', {
        first: 20,
        rest: 40,
      });
      assert.deepStrictEqual(
        plan.chunks.map((chunk) => [chunk.charOffset, chunk.text]),
        [
          [0, 'One two three.'],
          [15, 'Four five six. Seven eight nine.'],
          [48, 'Ten eleven twelve.'],
        ],
      );
    });

    test('a sentence longer than its target stays whole up to the limit', function () {
      const text = `${'A'.repeat(300)}. Next.`;
      const plan = chunker.planChunks(text, 10000, 'en');
      assert.strictEqual(plan.chunks[0].text, `${'A'.repeat(300)}.`);
      assert.strictEqual(plan.chunks[1].text, 'Next.');
    });

    test('targets never exceed the effective limit', function () {
      const plan = chunker.planChunks(SENTENCES, 34, 'en', {
        first: 1000,
        rest: 1000,
      });
      assert.deepStrictEqual(
        plan.chunks.map((chunk) => chunk.text),
        [
          'One two three. Four five six.',
          'Seven eight nine.',
          'Ten eleven twelve.',
        ],
      );
    });

    test('chunks are in order and never overlap', function () {
      const plan = chunker.planChunks(SENTENCES, 34, 'en');
      for (let i = 1; i < plan.chunks.length; i++) {
        const previous = plan.chunks[i - 1];
        assert.ok(
          plan.chunks[i].charOffset >=
            previous.charOffset + previous.text.length,
          'chunks overlap',
        );
      }
    });
  });

  // T-08
  suite('T-08 offsets and hard splits', function () {
    test('every chunk satisfies the charOffset substring invariant', function () {
      for (const limit of [34, 60, 120, 10000]) {
        const plan = chunker.planChunks(SENTENCES, limit, 'en');
        for (const chunk of plan.chunks) {
          assert.strictEqual(
            SENTENCES.slice(
              chunk.charOffset,
              chunk.charOffset + chunk.text.length,
            ),
            chunk.text,
          );
        }
      }
    });

    test('an oversized sentence is hard-split at whitespace', function () {
      const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
      const plan = chunker.planChunks(words, 50, 'en');
      assert.strictEqual(plan.limit, 47);
      assert.ok(plan.chunks.length > 1);
      for (const chunk of plan.chunks) {
        assert.ok(
          chunk.text.length <= plan.limit,
          `${chunk.text.length} > ${plan.limit}`,
        );
        assert.strictEqual(
          words.slice(chunk.charOffset, chunk.charOffset + chunk.text.length),
          chunk.text,
        );
        const after = chunk.charOffset + chunk.text.length;
        if (after < words.length) {
          assert.ok(
            /\s/.test(words[after]),
            `chunk did not end at whitespace: ${chunk.text}`,
          );
        }
      }
      assert.strictEqual(
        plan.chunks.map((chunk) => chunk.text).join(' '),
        words,
        'hard split lost or duplicated words',
      );
    });

    test('a sentence with no whitespace is cut at the limit', function () {
      const solid = 'x'.repeat(60);
      const plan = chunker.planChunks(solid, 20, 'en');
      assert.strictEqual(plan.limit, 19);
      assert.deepStrictEqual(
        plan.chunks.map((chunk) => [chunk.charOffset, chunk.text.length]),
        [
          [0, 19],
          [19, 19],
          [38, 19],
          [57, 3],
        ],
      );
    });

    test('splitSentences returns contiguous segments', function () {
      const segments = chunker.splitSentences(SENTENCES, 'en');
      assert.deepStrictEqual(segments, [
        { index: 0, segment: 'One two three. ' },
        { index: 15, segment: 'Four five six. ' },
        { index: 30, segment: 'Seven eight nine. ' },
        { index: 48, segment: 'Ten eleven twelve.' },
      ]);
    });
  });

  // Decision 5: a continuous read is chunked block by block.
  suite('T-08b planReadChunks never crosses a block boundary', function () {
    const BLOCKS = [
      'Heading',
      'Para one. Para one continues here.',
      'Para two.',
    ];

    test('every chunk is cut from exactly one block, in document order', function () {
      const plan = chunker.planReadChunks(BLOCKS, 10000, 'en');
      assert.deepStrictEqual(
        plan.chunks.map((chunk) => [chunk.index, chunk.blockIndex, chunk.text]),
        [
          [0, 0, 'Heading'],
          [1, 1, 'Para one. Para one continues here.'],
          [2, 2, 'Para two.'],
        ],
      );
      for (const chunk of plan.chunks) {
        const block = BLOCKS[chunk.blockIndex];
        assert.strictEqual(
          block.slice(chunk.charOffset, chunk.charOffset + chunk.text.length),
          chunk.text,
          'charOffset is relative to the chunk’s own block',
        );
      }
    });

    test('a tiny block is never merged into the next one', function () {
      const plan = chunker.planReadChunks(['A.', 'B.'], 10000, 'en');
      assert.deepStrictEqual(
        plan.chunks.map((chunk) => [chunk.blockIndex, chunk.text]),
        [
          [0, 'A.'],
          [1, 'B.'],
        ],
      );
    });

    test('a block with no speakable text contributes nothing', function () {
      const plan = chunker.planReadChunks(['', '   ', 'Hi.'], 10000, 'en');
      assert.deepStrictEqual(
        plan.chunks.map((chunk) => [chunk.index, chunk.blockIndex, chunk.text]),
        [[0, 2, 'Hi.']],
      );
      assert.deepStrictEqual(
        chunker.planReadChunks([], 10000, 'en').chunks,
        [],
      );
    });

    test('only the first chunk of the read uses the small first target', function () {
      const plan = chunker.planReadChunks([LONG, LONG], 10000, 'en');
      const first = plan.chunks.filter((chunk) => chunk.blockIndex === 0);
      const second = plan.chunks.filter((chunk) => chunk.blockIndex === 1);
      assert.ok(first[0].text.length <= 250, first[0].text);
      assert.ok(
        second[0].text.length > 250,
        'the second block packs its first chunk to the large target',
      );
      assert.ok(second.length < first.length);
      assert.deepStrictEqual(
        plan.chunks.map((chunk) => chunk.index),
        plan.chunks.map((_, i) => i),
        'indexes run over the whole read',
      );
      const blockIndexes = plan.chunks.map((chunk) => chunk.blockIndex);
      assert.deepStrictEqual(blockIndexes, blockIndexes.slice().sort());
    });

    test('the request limit still bounds every chunk of every block', function () {
      const plan = chunker.planReadChunks([SENTENCES, SENTENCES], 34, 'en');
      assert.strictEqual(plan.limit, 32);
      assert.strictEqual(plan.chunks.length, 6);
      for (const chunk of plan.chunks) {
        assert.ok(chunk.text.length <= plan.limit, chunk.text);
      }
      assert.strictEqual(
        stripWhitespace(
          plan.chunks
            .filter((chunk) => chunk.blockIndex === 1)
            .map((chunk) => chunk.text)
            .join(''),
        ),
        stripWhitespace(SENTENCES),
      );
    });
  });
});
