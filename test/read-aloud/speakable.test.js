/* global suite, test, suiteSetup, suiteTeardown */

/**
 * T-30 — `src/read-aloud/speakable.ts` (F5; cost pass 2026-09-02).
 *
 * Only letters, digits, whitespace and sentence punctuation may reach
 * ElevenLabs. The module is pure, so it is compiled on the fly with esbuild
 * exactly like `test/block-id-helpers.test.js`.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let speakable;
let tmpFile;

function clean(text) {
  return speakable.sanitizeForSpeech(text).text;
}

suite('read-aloud/speakable', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    const result = await esbuild.build({
      entryPoints: [
        path.join(__dirname, '..', '..', 'src', 'read-aloud', 'speakable.ts'),
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      external: ['vscode', 'crossnote'],
    });
    tmpFile = path.join(__dirname, '.speakable.bundle.cjs');
    fs.writeFileSync(tmpFile, result.outputFiles[0].text);
    speakable = require(tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  suite('T-30 sanitizeForSpeech', function () {
    test('drops markdown residue', function () {
      assert.strictEqual(
        clean(
          '**bold** text # heading ## sub > quote [x] done [ ] todo `code` ~~gone~~ | pipe',
        ),
        'bold text heading sub quote done todo code gone pipe',
      );
    });

    test('keeps sentence punctuation, quotes and apostrophes', function () {
      const prose = "Don't stop; it's 3.5%, OK? (Yes!) “quoted” — dash… ¿Qué?";
      assert.strictEqual(clean(prose), prose);
    });

    test('keeps letters and digits of every script', function () {
      const text = 'naïve café 日本語 Ελληνικά ½ 42 𝒜';
      assert.strictEqual(clean(text), text);
    });

    test('keeps a hyphen only between two letters or digits', function () {
      assert.strictEqual(
        clean('read-aloud e-mail - dash -5 a--b 2024-09-02'),
        'read-aloud e-mail dash 5 a b 2024-09-02',
      );
      assert.strictEqual(clean('co‑operate'), 'co‑operate');
    });

    test('turns underscores and pipes into word separators', function () {
      assert.strictEqual(clean('snake_case a|b'), 'snake case a b');
    });

    test('a dropped symbol separates words instead of gluing them', function () {
      assert.strictEqual(
        clean('5*3 C# a>b foo<bar> x^2'),
        '5 3 C a b foo bar x 2',
      );
    });

    test('a dropped run before punctuation adds no space', function () {
      assert.strictEqual(
        clean('**Note:** see `pnpm build`, then (**really**) stop.'),
        'Note: see pnpm build, then (really) stop.',
      );
    });

    test('collapses whitespace, including no-break spaces, and trims', function () {
      assert.strictEqual(clean('  a \n\n b c\t d  '), 'a b c d');
      assert.strictEqual(clean('\n\n'), '');
      assert.strictEqual(clean(''), '');
    });

    test('drops emoji, brackets, backslashes and other symbols', function () {
      assert.strictEqual(
        clean('ship it 🚀 now © 2026 ^ ~ \\ { } [ ] < > § • ·'),
        'ship it now 2026',
      );
      assert.strictEqual(clean('*** # > [x]'), '');
    });

    test('keeps the currency, percent and operator characters prose needs', function () {
      const text = '$5, €10, £2, ¥3, 50%, 20°C, R&D, C++, a/b, a = b, me@x.io';
      assert.strictEqual(clean(text), text);
    });

    test('every character of the output is speakable', function () {
      const samples = [
        "**bold** `code` [x] > # 🚀 naïve don't 3.5 a-b",
        ' 　ok ',
        'a😀b',
      ];
      for (const sample of samples) {
        const result = speakable.sanitizeForSpeech(sample);
        assert.ok(speakable.isSpeakable(result.text), result.text);
        assert.strictEqual(result.map.length, result.text.length);
      }
    });

    test('sanitising twice is a no-op', function () {
      const once = clean('**bold** text # heading > quote [x] done 5*3 a_b');
      assert.strictEqual(clean(once), once);
    });
  });

  suite('T-30 offset map', function () {
    test('maps every kept character back to itself in the original', function () {
      const original = '**Hello**, wörld [x] done! 5*3 a😀b';
      const { text, map } = speakable.sanitizeForSpeech(original);
      assert.strictEqual(text, 'Hello, wörld done! 5 3 a b');
      assert.strictEqual(map.length, text.length);
      for (let i = 0; i < text.length; i++) {
        if (text[i] === ' ') {
          // A collapsed separator points at the start of the whitespace or
          // dropped run it replaced, never at a letter or digit.
          const at = String.fromCodePoint(original.codePointAt(map[i]));
          assert.ok(!/[\p{L}\p{N}]/u.test(at), `space ${i} -> ${at}`);
        } else {
          assert.strictEqual(original[map[i]], text[i], `char ${i}`);
        }
      }
      assert.deepStrictEqual(map.slice(0, 5), [2, 3, 4, 5, 6]);
    });

    test('surrogate pairs map both code units', function () {
      const { text, map } = speakable.sanitizeForSpeech('𝒜x');
      assert.strictEqual(text, '𝒜x');
      assert.deepStrictEqual(map, [0, 1, 2]);
    });

    test('mapSpanBack re-expresses a span in original offsets', function () {
      const original = '**Hello** world';
      const { text, map } = speakable.sanitizeForSpeech(original);
      assert.strictEqual(text, 'Hello world');
      const hello = speakable.mapSpanBack(
        { text: 'Hello', charStart: 0, charEnd: 5, start: 0, end: 0.4 },
        map,
      );
      assert.deepStrictEqual(hello, {
        text: 'Hello',
        charStart: 2,
        charEnd: 7,
        start: 0,
        end: 0.4,
      });
      const world = speakable.mapSpanBack(
        { text: 'world', charStart: 6, charEnd: 11, start: 0.5, end: 0.9 },
        map,
      );
      assert.strictEqual(
        original.slice(world.charStart, world.charEnd),
        'world',
      );
    });

    test('mapSpanBack rejects an empty or out-of-range span', function () {
      const { map } = speakable.sanitizeForSpeech('Hello');
      assert.strictEqual(
        speakable.mapSpanBack(
          { text: '', charStart: 2, charEnd: 2, start: 0, end: 0 },
          map,
        ),
        undefined,
      );
      assert.strictEqual(
        speakable.mapSpanBack(
          { text: 'x', charStart: 4, charEnd: 9, start: 0, end: 0 },
          map,
        ),
        undefined,
      );
    });
  });

  suite('T-30 the client-side guard', function () {
    test('isSpeakable and UNSPEAKABLE_RE agree with the sanitiser', function () {
      assert.ok(speakable.isSpeakable('Plain prose, with 3.5% and a-b.'));
      for (const bad of [
        '*',
        '#',
        '>',
        '[',
        ']',
        '`',
        '~',
        '\\',
        '🚀',
        '_',
        '|',
      ]) {
        assert.ok(!speakable.isSpeakable(`a${bad}b`), bad);
        assert.ok(speakable.UNSPEAKABLE_RE.test(bad), bad);
      }
    });

    test('assertSpeakable throws with a sample of the offending characters', function () {
      assert.doesNotThrow(() =>
        speakable.assertSpeakable('fine text.', 'text'),
      );
      assert.throws(
        () => speakable.assertSpeakable('**bad** # text', 'previous_text'),
        (error) =>
          error instanceof Error &&
          error.message.includes('previous_text') &&
          error.message.includes('"*#"'),
      );
      assert.strictEqual(
        speakable.unspeakableSample('a*b#c*d>e[f]g{h}'),
        '*#>[]',
      );
    });
  });
});
