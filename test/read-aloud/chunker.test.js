/* global suite, test, suiteSetup, suiteTeardown */

/**
 * T-06 … T-09 — `src/read-aloud/chunker.ts` and `src/read-aloud/models.ts` (F11).
 *
 * Both modules are pure, so each is compiled on the fly with esbuild exactly
 * like `test/block-id-helpers.test.js`.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let chunker;
let models;
const tmpFiles = [];

const SENTENCES =
  'One two three. Four five six. Seven eight nine. Ten eleven twelve.';

async function compile(moduleName) {
  const result = await esbuild.build({
    entryPoints: [
      path.join(__dirname, '..', '..', 'src', 'read-aloud', `${moduleName}.ts`),
    ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
    logLevel: 'silent',
    external: ['vscode', 'crossnote'],
  });
  const tmpFile = path.join(__dirname, `.${moduleName}.bundle.cjs`);
  fs.writeFileSync(tmpFile, result.outputFiles[0].text);
  tmpFiles.push(tmpFile);
  return require(tmpFile);
}

function stripWhitespace(value) {
  return value.replace(/\s+/g, '');
}

suite('read-aloud/chunker', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    chunker = await compile('chunker');
    models = await compile('models');
  });

  suiteTeardown(function () {
    for (const tmpFile of tmpFiles) {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
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
      }
    });

    test('text shorter than the limit yields exactly one chunk', function () {
      const plan = chunker.planChunks('  Hello world.  ', 10000, 'en');
      assert.strictEqual(plan.chunks.length, 1);
      assert.strictEqual(plan.chunks[0].text, 'Hello world.');
      assert.strictEqual(plan.chunks[0].charOffset, 2);
    });
  });

  // Lazy synthesis: a short first chunk, larger ones after it, never above
  // the limit.
  suite('T-06b chunk targets', function () {
    const LONG = Array.from(
      { length: 12 },
      (_, i) => `Sentence number ${i + 1} is here to fill the paragraph out.`,
    ).join(' ');

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
      const plan = chunker.planChunks(SENTENCES, 10000, 'en', undefined, {
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
      const plan = chunker.planChunks(SENTENCES, 34, 'en', undefined, {
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

    test('replanFrom honours the targets too', function () {
      const replanned = chunker.replanFrom(
        SENTENCES,
        15,
        10000,
        'en',
        undefined,
        {
          first: 20,
          rest: 40,
        },
      );
      assert.deepStrictEqual(
        replanned.map((chunk) => [chunk.charOffset, chunk.text]),
        [
          [15, 'Four five six.'],
          [30, 'Seven eight nine. Ten eleven twelve.'],
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

  // T-07
  suite('T-07 context windows', function () {
    test('contextTail and contextHead cap at 300 characters', function () {
      assert.strictEqual(chunker.CONTEXT_WINDOW_CHARS, 300);
      const long = 'abcdefghij'.repeat(40);
      assert.strictEqual(long.length, 400);
      assert.strictEqual(chunker.contextTail(long).length, 300);
      assert.strictEqual(chunker.contextTail(long), long.slice(100));
      assert.strictEqual(chunker.contextHead(long).length, 300);
      assert.strictEqual(chunker.contextHead(long), long.slice(0, 300));
      assert.strictEqual(chunker.contextTail('short'), 'short');
      assert.strictEqual(chunker.contextHead('short'), 'short');
      assert.strictEqual(chunker.contextTail(''), '');
    });

    test('inner chunks carry their neighbours, outer context only the edges', function () {
      const plan = chunker.planChunks(SENTENCES, 34, 'en', {
        previousText: 'PREV',
        nextText: 'NEXT',
      });
      assert.deepStrictEqual(
        plan.chunks.map((chunk) => [chunk.previousText, chunk.nextText]),
        [
          ['PREV', 'Seven eight nine.'],
          ['One two three. Four five six.', 'Ten eleven twelve.'],
          ['Seven eight nine.', 'NEXT'],
        ],
      );
    });

    test('a single chunk carries only the outer context', function () {
      const plan = chunker.planChunks('Hello world.', 10000, 'en', {
        previousText: 'BEFORE',
        nextText: 'AFTER',
      });
      assert.strictEqual(plan.chunks.length, 1);
      assert.strictEqual(plan.chunks[0].previousText, 'BEFORE');
      assert.strictEqual(plan.chunks[0].nextText, 'AFTER');
    });

    test('outer context is itself truncated to 300 characters', function () {
      const long = 'abcdefghij'.repeat(40);
      const plan = chunker.planChunks('Hello world.', 10000, 'en', {
        previousText: long,
        nextText: long,
      });
      assert.strictEqual(plan.chunks[0].previousText, long.slice(100));
      assert.strictEqual(plan.chunks[0].nextText, long.slice(0, 300));
    });

    test('missing outer context becomes an empty string', function () {
      const plan = chunker.planChunks('Hello world.', 10000, 'en');
      assert.strictEqual(plan.chunks[0].previousText, '');
      assert.strictEqual(plan.chunks[0].nextText, '');
    });
  });

  // T-08
  suite('T-08 offsets, hard splits and re-planning', function () {
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

    test('replanFrom keeps offsets relative to the full text (G-07)', function () {
      const from = 30;
      const replanned = chunker.replanFrom(SENTENCES, from, 16, 'en', {
        previousText: 'TAIL',
        nextText: 'NEXT',
      });
      assert.ok(replanned.length > 0);
      assert.strictEqual(replanned[0].previousText, 'TAIL');
      assert.strictEqual(replanned[replanned.length - 1].nextText, 'NEXT');
      for (const chunk of replanned) {
        assert.ok(chunk.charOffset >= from, `${chunk.charOffset} < ${from}`);
        assert.strictEqual(
          SENTENCES.slice(
            chunk.charOffset,
            chunk.charOffset + chunk.text.length,
          ),
          chunk.text,
        );
      }
    });

    test('posted plus re-planned chunks cover the text gap-free', function () {
      const from = 30;
      const posted = chunker
        .planChunks(SENTENCES, 34, 'en')
        .chunks.filter((chunk) => chunk.charOffset < from);
      const replanned = chunker.replanFrom(SENTENCES, from, 16, 'en');
      const covered = posted
        .concat(replanned)
        .map((chunk) => stripWhitespace(chunk.text))
        .join('');
      assert.strictEqual(covered, stripWhitespace(SENTENCES));
    });

    test('replanFrom clamps an out-of-range offset', function () {
      assert.deepStrictEqual(
        chunker.replanFrom(SENTENCES, SENTENCES.length, 100, 'en'),
        [],
      );
      const fromNegative = chunker.replanFrom(SENTENCES, -5, 10000, 'en');
      assert.strictEqual(fromNegative.length, 1);
      assert.strictEqual(fromNegative[0].charOffset, 0);
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

  // T-09
  suite('T-09 per-model limits', function () {
    test('the R2 §8.1 fallback table', function () {
      assert.strictEqual(models.DEFAULT_MODEL_ID, 'eleven_flash_v2_5');
      assert.deepStrictEqual(models.FALLBACK_LIMITS, {
        eleven_v3: 5000,
        eleven_flash_v2_5: 40000,
        eleven_flash_v2: 30000,
        eleven_multilingual_v2: 10000,
      });
      assert.deepStrictEqual(
        models.limitFromModel(undefined, false, 'eleven_multilingual_v2'),
        {
          modelId: 'eleven_multilingual_v2',
          maxChars: 10000,
          source: 'fallback',
        },
      );
      assert.deepStrictEqual(
        models.limitFromModel(undefined, true, 'eleven_v3'),
        {
          modelId: 'eleven_v3',
          maxChars: 5000,
          source: 'fallback',
        },
      );
    });

    test('an unknown model falls back to 5000', function () {
      assert.strictEqual(models.FALLBACK_LIMIT_UNKNOWN_MODEL, 5000);
      assert.deepStrictEqual(
        models.limitFromModel(undefined, false, 'eleven_made_up'),
        {
          modelId: 'eleven_made_up',
          maxChars: 5000,
          source: 'fallback',
        },
      );
    });

    test('free users get the free limit, subscribers the subscribed one', function () {
      const model = {
        model_id: 'eleven_multilingual_v2',
        max_characters_request_free_user: 2500,
        max_characters_request_subscribed_user: 10000,
      };
      assert.deepStrictEqual(
        models.limitFromModel(model, true, 'eleven_multilingual_v2'),
        {
          modelId: 'eleven_multilingual_v2',
          maxChars: 2500,
          source: 'api',
        },
      );
      assert.deepStrictEqual(
        models.limitFromModel(model, false, 'eleven_multilingual_v2'),
        {
          modelId: 'eleven_multilingual_v2',
          maxChars: 10000,
          source: 'api',
        },
      );
    });

    test('maximum_text_length_per_request wins when it is smaller', function () {
      const model = {
        model_id: 'eleven_flash_v2_5',
        max_characters_request_free_user: 2500,
        max_characters_request_subscribed_user: 40000,
        maximum_text_length_per_request: 8000,
      };
      assert.strictEqual(
        models.limitFromModel(model, false, 'eleven_flash_v2_5').maxChars,
        8000,
      );
      assert.strictEqual(
        models.limitFromModel(model, true, 'eleven_flash_v2_5').maxChars,
        2500,
      );
    });

    test('a row with no usable number falls back to the table', function () {
      const model = { model_id: 'eleven_v3' };
      assert.deepStrictEqual(models.limitFromModel(model, true, 'eleven_v3'), {
        modelId: 'eleven_v3',
        maxChars: 5000,
        source: 'fallback',
      });
    });

    test('the missing free limit falls back to the subscribed one and vice versa', function () {
      const subscribedOnly = {
        model_id: 'eleven_v3',
        max_characters_request_subscribed_user: 5000,
      };
      assert.strictEqual(
        models.limitFromModel(subscribedOnly, true, 'eleven_v3').maxChars,
        5000,
      );
      const freeOnly = {
        model_id: 'eleven_v3',
        max_characters_request_free_user: 500,
      };
      assert.strictEqual(
        models.limitFromModel(freeOnly, false, 'eleven_v3').maxChars,
        500,
      );
    });

    test('isFreeSubscription is fail-closed', function () {
      assert.strictEqual(models.isFreeSubscription(undefined, undefined), true);
      assert.strictEqual(models.isFreeSubscription('free', 'free'), true);
      assert.strictEqual(
        models.isFreeSubscription('free_disabled', 'starter'),
        true,
      );
      assert.strictEqual(models.isFreeSubscription('active', 'Free'), true);
      assert.strictEqual(models.isFreeSubscription('active', 'creator'), false);
      assert.strictEqual(
        models.isFreeSubscription('trialing', 'starter'),
        false,
      );
    });

    test('findModel matches on model_id', function () {
      const list = [{ model_id: 'a' }, { model_id: 'eleven_v3' }];
      assert.strictEqual(models.findModel(list, 'eleven_v3'), list[1]);
      assert.strictEqual(models.findModel(list, 'missing'), undefined);
      assert.strictEqual(models.findModel([], 'eleven_v3'), undefined);
    });
  });
});
