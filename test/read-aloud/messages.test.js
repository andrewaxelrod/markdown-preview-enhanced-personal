/* global suite, test, suiteSetup, suiteTeardown */

/**
 * T-12 — `src/read-aloud/messages.ts` (F13 shapes, spec §6 Security).
 *
 * These validators are the host's boundary: anything the webview posts that is
 * not the exact F13 shape must be dropped, never coerced.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let messages;
let tmpFile;

const URI = 'file:///tmp/doc.md';
const REQUEST_ID = 'ra-1';

function synthesizeArgs(overrides) {
  const base = {
    sourceUri: URI,
    requestId: REQUEST_ID,
    text: 'Hello world',
    options: { kind: 'block' },
  };
  const merged = Object.assign({}, base, overrides);
  return [merged.sourceUri, merged.requestId, merged.text, merged.options];
}

suite('read-aloud/messages', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    const result = await esbuild.build({
      entryPoints: [
        path.join(__dirname, '..', '..', 'src', 'read-aloud', 'messages.ts'),
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      external: ['vscode', 'crossnote'],
    });
    tmpFile = path.join(__dirname, '.messages.bundle.cjs');
    fs.writeFileSync(tmpFile, result.outputFiles[0].text);
    messages = require(tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  suite('T-12 parseSynthesizeArgs', function () {
    test('accepts the exact F13 shape', function () {
      assert.deepStrictEqual(messages.parseSynthesizeArgs(synthesizeArgs()), {
        sourceUri: URI,
        requestId: REQUEST_ID,
        text: 'Hello world',
        options: { kind: 'block' },
      });
    });

    test('accepts every optional field', function () {
      const parsed = messages.parseSynthesizeArgs(
        synthesizeArgs({
          options: {
            kind: 'selection',
            blockId: 'b1a2b3c4#7',
            previousText: 'before',
            nextText: 'after',
          },
        }),
      );
      assert.deepStrictEqual(parsed.options, {
        kind: 'selection',
        blockId: 'b1a2b3c4#7',
        previousText: 'before',
        nextText: 'after',
      });
    });

    test('rejects a non-array or a wrong arity', function () {
      assert.strictEqual(messages.parseSynthesizeArgs(undefined), undefined);
      assert.strictEqual(
        messages.parseSynthesizeArgs({ sourceUri: URI }),
        undefined,
      );
      assert.strictEqual(
        messages.parseSynthesizeArgs([URI, REQUEST_ID, 'x']),
        undefined,
      );
      assert.strictEqual(
        messages.parseSynthesizeArgs([
          URI,
          REQUEST_ID,
          'x',
          { kind: 'block' },
          'extra',
        ]),
        undefined,
      );
    });

    test('rejects a missing or non-string sourceUri', function () {
      assert.strictEqual(
        messages.parseSynthesizeArgs(synthesizeArgs({ sourceUri: '' })),
        undefined,
      );
      assert.strictEqual(
        messages.parseSynthesizeArgs(synthesizeArgs({ sourceUri: 42 })),
        undefined,
      );
      assert.strictEqual(
        messages.parseSynthesizeArgs(synthesizeArgs({ sourceUri: null })),
        undefined,
      );
    });

    test('rejects a requestId that does not match the pattern', function () {
      assert.ok(messages.REQUEST_ID_RE.test('ra-abc_123'));
      for (const bad of [
        '',
        'ra 1',
        'ra/1',
        'ra.1',
        'a'.repeat(65),
        42,
        null,
        {},
      ]) {
        assert.strictEqual(
          messages.parseSynthesizeArgs(synthesizeArgs({ requestId: bad })),
          undefined,
          String(bad),
        );
      }
      assert.ok(
        messages.parseSynthesizeArgs(
          synthesizeArgs({ requestId: 'a'.repeat(64) }),
        ),
      );
    });

    test('rejects empty and oversized text', function () {
      assert.strictEqual(messages.MAX_TEXT_CHARS, 200000);
      assert.strictEqual(
        messages.parseSynthesizeArgs(synthesizeArgs({ text: '' })),
        undefined,
      );
      assert.strictEqual(
        messages.parseSynthesizeArgs(synthesizeArgs({ text: 7 })),
        undefined,
      );
      const tooLong = 'a'.repeat(messages.MAX_TEXT_CHARS + 1);
      assert.strictEqual(
        messages.parseSynthesizeArgs(synthesizeArgs({ text: tooLong })),
        undefined,
      );
      const atLimit = 'a'.repeat(messages.MAX_TEXT_CHARS);
      assert.strictEqual(
        messages.parseSynthesizeArgs(synthesizeArgs({ text: atLimit })).text
          .length,
        messages.MAX_TEXT_CHARS,
      );
    });

    test('rejects untrimmed text rather than trimming it (A-25)', function () {
      for (const text of [' x', 'x ', 'x\n', '\tx', ' x ']) {
        assert.strictEqual(
          messages.parseSynthesizeArgs(synthesizeArgs({ text })),
          undefined,
          JSON.stringify(text),
        );
      }
    });

    test('rejects a bad options object or kind', function () {
      for (const options of [
        undefined,
        null,
        'block',
        [],
        { kind: 'paragraph' },
        {},
      ]) {
        assert.strictEqual(
          messages.parseSynthesizeArgs(synthesizeArgs({ options })),
          undefined,
          JSON.stringify(options),
        );
      }
    });

    test('rejects a non-string or oversized blockId', function () {
      assert.strictEqual(messages.MAX_BLOCK_ID_CHARS, 128);
      assert.strictEqual(
        messages.parseSynthesizeArgs(
          synthesizeArgs({ options: { kind: 'block', blockId: 5 } }),
        ),
        undefined,
      );
      assert.strictEqual(
        messages.parseSynthesizeArgs(
          synthesizeArgs({
            options: { kind: 'block', blockId: 'b'.repeat(129) },
          }),
        ),
        undefined,
      );
      assert.strictEqual(
        messages.parseSynthesizeArgs(
          synthesizeArgs({
            options: { kind: 'block', blockId: 'b'.repeat(128) },
          }),
        ).options.blockId.length,
        128,
      );
    });

    test('truncates previousText to the last 300 and nextText to the first 300', function () {
      assert.strictEqual(messages.MAX_CONTEXT_CHARS, 300);
      const long = 'abcdefghij'.repeat(40);
      assert.strictEqual(long.length, 400);
      const parsed = messages.parseSynthesizeArgs(
        synthesizeArgs({
          options: { kind: 'block', previousText: long, nextText: long },
        }),
      );
      assert.strictEqual(parsed.options.previousText, long.slice(100));
      assert.strictEqual(parsed.options.nextText, long.slice(0, 300));
    });

    test('rejects non-string context fields', function () {
      assert.strictEqual(
        messages.parseSynthesizeArgs(
          synthesizeArgs({ options: { kind: 'block', previousText: 12 } }),
        ),
        undefined,
      );
      assert.strictEqual(
        messages.parseSynthesizeArgs(
          synthesizeArgs({ options: { kind: 'block', nextText: {} } }),
        ),
        undefined,
      );
    });
  });

  suite('T-12 parseCancelArgs', function () {
    test('accepts the exact F13 shape', function () {
      assert.deepStrictEqual(messages.parseCancelArgs([URI, REQUEST_ID]), {
        sourceUri: URI,
        requestId: REQUEST_ID,
      });
    });

    test('rejects wrong arity, wrong types and a bad requestId', function () {
      assert.strictEqual(messages.parseCancelArgs([URI]), undefined);
      assert.strictEqual(
        messages.parseCancelArgs([URI, REQUEST_ID, 'extra']),
        undefined,
      );
      assert.strictEqual(messages.parseCancelArgs([42, REQUEST_ID]), undefined);
      assert.strictEqual(messages.parseCancelArgs(['', REQUEST_ID]), undefined);
      assert.strictEqual(messages.parseCancelArgs([URI, 'bad id']), undefined);
      assert.strictEqual(messages.parseCancelArgs('nope'), undefined);
    });
  });

  suite('T-12 parseSetSpeedArgs and clampSpeed', function () {
    test('accepts a finite rate inside [0.25, 4]', function () {
      assert.strictEqual(messages.SPEED_MIN, 0.25);
      assert.strictEqual(messages.SPEED_MAX, 4);
      assert.strictEqual(messages.parseSetSpeedArgs([0.25]), 0.25);
      assert.strictEqual(messages.parseSetSpeedArgs([1]), 1);
      assert.strictEqual(messages.parseSetSpeedArgs([2.5]), 2.5);
      assert.strictEqual(messages.parseSetSpeedArgs([4]), 4);
    });

    test('rejects an out-of-range rate rather than clamping it', function () {
      assert.strictEqual(messages.parseSetSpeedArgs([0.24]), undefined);
      assert.strictEqual(messages.parseSetSpeedArgs([4.01]), undefined);
      assert.strictEqual(messages.parseSetSpeedArgs([0]), undefined);
      assert.strictEqual(messages.parseSetSpeedArgs([-1]), undefined);
    });

    test('rejects non-numbers, non-finite values and wrong arity', function () {
      assert.strictEqual(messages.parseSetSpeedArgs(['1']), undefined);
      assert.strictEqual(messages.parseSetSpeedArgs([Number.NaN]), undefined);
      assert.strictEqual(
        messages.parseSetSpeedArgs([Number.POSITIVE_INFINITY]),
        undefined,
      );
      assert.strictEqual(messages.parseSetSpeedArgs([]), undefined);
      assert.strictEqual(messages.parseSetSpeedArgs([1, 2]), undefined);
      assert.strictEqual(messages.parseSetSpeedArgs(1), undefined);
    });

    test('clampSpeed is the settings-read path and does clamp', function () {
      assert.strictEqual(messages.clampSpeed(0.1), 0.25);
      assert.strictEqual(messages.clampSpeed(9), 4);
      assert.strictEqual(messages.clampSpeed(1.75), 1.75);
      assert.strictEqual(messages.clampSpeed(Number.NaN), 1);
      assert.strictEqual(messages.clampSpeed('fast'), 1);
    });
  });

  suite('T-12 parsePlayingArgs', function () {
    test('accepts [sourceUri, requestId, chunkIndex]', function () {
      assert.deepStrictEqual(messages.parsePlayingArgs([URI, REQUEST_ID, 0]), {
        sourceUri: URI,
        requestId: REQUEST_ID,
        chunkIndex: 0,
      });
      assert.deepStrictEqual(messages.parsePlayingArgs([URI, REQUEST_ID, 7]), {
        sourceUri: URI,
        requestId: REQUEST_ID,
        chunkIndex: 7,
      });
    });

    test('rejects the wrong arity, a bad uri or request id', function () {
      assert.strictEqual(
        messages.parsePlayingArgs([URI, REQUEST_ID]),
        undefined,
      );
      assert.strictEqual(
        messages.parsePlayingArgs([URI, REQUEST_ID, 0, 'extra']),
        undefined,
      );
      assert.strictEqual(
        messages.parsePlayingArgs(['', REQUEST_ID, 0]),
        undefined,
      );
      assert.strictEqual(
        messages.parsePlayingArgs([URI, 'bad id!', 0]),
        undefined,
      );
      assert.strictEqual(messages.parsePlayingArgs('nope'), undefined);
    });

    test('rejects a negative, fractional, NaN or non-number index', function () {
      for (const index of [
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        '0',
        null,
      ]) {
        assert.strictEqual(
          messages.parsePlayingArgs([URI, REQUEST_ID, index]),
          undefined,
          String(index),
        );
      }
    });
  });

  suite('T-12 highlight theme', function () {
    test('HIGHLIGHT_THEMES is the same list the webview core ships', function () {
      const core = require('../../media/read-aloud-core.js');
      assert.deepStrictEqual(
        Array.from(messages.HIGHLIGHT_THEMES),
        core.HIGHLIGHT_THEMES,
      );
      assert.strictEqual(
        messages.DEFAULT_HIGHLIGHT_THEME,
        core.DEFAULT_HIGHLIGHT_THEME,
      );
    });

    test('normaliseHighlightTheme keeps a known theme and falls back to the default', function () {
      for (const theme of messages.HIGHLIGHT_THEMES) {
        assert.strictEqual(messages.normaliseHighlightTheme(theme), theme);
      }
      assert.strictEqual(messages.normaliseHighlightTheme('Blue'), 'blue');
      assert.strictEqual(messages.normaliseHighlightTheme(undefined), 'blue');
      assert.strictEqual(messages.normaliseHighlightTheme(null), 'blue');
      assert.strictEqual(messages.normaliseHighlightTheme(3), 'blue');
    });
  });
});
