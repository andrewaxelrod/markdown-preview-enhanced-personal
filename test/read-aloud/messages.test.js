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
            kind: 'block',
            blockId: 'b1a2b3c4#7',
            blocks: [
              { key: 'b1a2b3c4', start: 0, end: 5 },
              { key: 'bdeadbeef', start: 6, end: 11 },
            ],
          },
        }),
      );
      assert.deepStrictEqual(parsed.options, {
        kind: 'block',
        blockId: 'b1a2b3c4#7',
        blocks: [
          { key: 'b1a2b3c4', start: 0, end: 5 },
          { key: 'bdeadbeef', start: 6, end: 11 },
        ],
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

    test('drops unknown option fields instead of forwarding them', function () {
      const parsed = messages.parseSynthesizeArgs(
        synthesizeArgs({
          options: { kind: 'block', previousText: 'gone', nextText: 'gone' },
        }),
      );
      assert.deepStrictEqual(parsed.options, { kind: 'block' });
    });

    test('an empty or absent blocks list means one block', function () {
      for (const blocks of [undefined, null, []]) {
        const parsed = messages.parseSynthesizeArgs(
          synthesizeArgs({ options: { kind: 'block', blocks } }),
        );
        assert.deepStrictEqual(
          parsed.options,
          { kind: 'block' },
          String(blocks),
        );
      }
    });

    test('blocks must be ascending, non-empty, non-overlapping ranges inside the text', function () {
      assert.strictEqual(messages.MAX_BLOCK_KEY_CHARS, 64);
      assert.strictEqual(messages.MAX_REQUEST_BLOCKS, 20000);
      const ok = (blocks) =>
        messages.parseSynthesizeArgs(
          synthesizeArgs({ options: { kind: 'block', blocks } }),
        );
      // "Hello world" is 11 characters.
      assert.ok(ok([{ key: 'b1', start: 0, end: 11 }]));
      assert.ok(ok([{ key: '', start: 3, end: 4 }]), 'an empty key is allowed');
      assert.ok(
        ok([
          { key: 'b1', start: 0, end: 5 },
          { key: 'b2', start: 5, end: 11 },
        ]),
        'adjacent ranges are allowed',
      );
      for (const blocks of [
        'nope',
        {},
        [null],
        ['b1'],
        [{ start: 0, end: 5 }],
        [{ key: 5, start: 0, end: 5 }],
        [{ key: 'b'.repeat(65), start: 0, end: 5 }],
        [{ key: 'b1', start: 0, end: 12 }],
        [{ key: 'b1', start: 5, end: 5 }],
        [{ key: 'b1', start: 6, end: 5 }],
        [{ key: 'b1', start: -1, end: 5 }],
        [{ key: 'b1', start: 0.5, end: 5 }],
        [{ key: 'b1', start: 0, end: '5' }],
        [
          { key: 'b1', start: 0, end: 6 },
          { key: 'b2', start: 5, end: 11 },
        ],
        [
          { key: 'b2', start: 6, end: 11 },
          { key: 'b1', start: 0, end: 5 },
        ],
      ]) {
        assert.strictEqual(ok(blocks), undefined, JSON.stringify(blocks));
      }
      assert.strictEqual(
        ok(
          Array.from({ length: messages.MAX_REQUEST_BLOCKS + 1 }, () => ({
            key: 'b',
            start: 0,
            end: 1,
          })),
        ),
        undefined,
        'too many blocks',
      );
    });
  });

  suite('T-12 parseCancelArgs', function () {
    test('accepts the exact F13 shape, with or without a reason', function () {
      assert.deepStrictEqual(messages.parseCancelArgs([URI, REQUEST_ID]), {
        sourceUri: URI,
        requestId: REQUEST_ID,
      });
      assert.deepStrictEqual(
        messages.parseCancelArgs([URI, REQUEST_ID, 'stop']),
        { sourceUri: URI, requestId: REQUEST_ID, reason: 'stop' },
      );
      assert.strictEqual(messages.MAX_CANCEL_REASON_CHARS, 200);
      const long = messages.parseCancelArgs([
        URI,
        REQUEST_ID,
        'a\nb'.repeat(200),
      ]);
      assert.strictEqual(long.reason.length, 200);
      assert.ok(!/\n/.test(long.reason));
      assert.strictEqual(
        messages.parseCancelArgs([URI, REQUEST_ID, 42]),
        undefined,
      );
    });

    test('rejects wrong arity, wrong types and a bad requestId', function () {
      assert.strictEqual(messages.parseCancelArgs([URI]), undefined);
      assert.strictEqual(
        messages.parseCancelArgs([URI, REQUEST_ID, 'extra', 'more']),
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

  suite('T-12 parseSetVolumeArgs and clampVolume', function () {
    test('accepts a finite level inside [0, 1]', function () {
      assert.strictEqual(messages.VOLUME_MIN, 0);
      assert.strictEqual(messages.VOLUME_MAX, 1);
      assert.strictEqual(messages.parseSetVolumeArgs([0]), 0);
      assert.strictEqual(messages.parseSetVolumeArgs([0.4]), 0.4);
      assert.strictEqual(messages.parseSetVolumeArgs([1]), 1);
    });

    test('rejects out of range, non-numbers and wrong arity', function () {
      assert.strictEqual(messages.parseSetVolumeArgs([-0.01]), undefined);
      assert.strictEqual(messages.parseSetVolumeArgs([1.01]), undefined);
      assert.strictEqual(messages.parseSetVolumeArgs(['1']), undefined);
      assert.strictEqual(messages.parseSetVolumeArgs([Number.NaN]), undefined);
      assert.strictEqual(messages.parseSetVolumeArgs([]), undefined);
      assert.strictEqual(messages.parseSetVolumeArgs([0.5, 0.5]), undefined);
      assert.strictEqual(messages.parseSetVolumeArgs(0.5), undefined);
    });

    test('clampVolume is the settings-read path and does clamp', function () {
      assert.strictEqual(messages.clampVolume(-2), 0);
      assert.strictEqual(messages.clampVolume(9), 1);
      assert.strictEqual(messages.clampVolume(0.65), 0.65);
      assert.strictEqual(messages.clampVolume(Number.NaN), 1);
      assert.strictEqual(messages.clampVolume('loud'), 1);
    });
  });

  suite(
    '05 the low-strain page: parseSetGlobalThemeArgs, the sliders and Reset',
    function () {
      test('parseSetGlobalThemeArgs accepts the four values and nothing else', function () {
        assert.deepStrictEqual(messages.GLOBAL_THEMES, [
          'auto',
          'light',
          'dark',
          'off',
        ]);
        assert.strictEqual(messages.DEFAULT_GLOBAL_THEME, 'auto');
        for (const theme of messages.GLOBAL_THEMES) {
          assert.strictEqual(messages.parseSetGlobalThemeArgs([theme]), theme);
        }
        assert.strictEqual(
          messages.parseSetGlobalThemeArgs(['sepia']),
          undefined,
        );
        assert.strictEqual(
          messages.parseSetGlobalThemeArgs(['Dark']),
          undefined,
        );
        assert.strictEqual(messages.parseSetGlobalThemeArgs([1]), undefined);
        assert.strictEqual(messages.parseSetGlobalThemeArgs([]), undefined);
        assert.strictEqual(
          messages.parseSetGlobalThemeArgs(['dark', 'light']),
          undefined,
        );
        assert.strictEqual(messages.parseSetGlobalThemeArgs('dark'), undefined);
        assert.strictEqual(messages.normaliseGlobalTheme('sepia'), 'auto');
        assert.strictEqual(messages.normaliseGlobalTheme(undefined), 'auto');
        assert.strictEqual(messages.normaliseGlobalTheme('off'), 'off');
      });

      test('parseSetTextSizeArgs rounds and clamps to 16–28 (07 §15.2)', function () {
        assert.strictEqual(messages.TEXT_SIZE_MIN, 16);
        assert.strictEqual(messages.TEXT_SIZE_MAX, 28);
        assert.strictEqual(messages.TEXT_SIZE_STEP, 1);
        assert.strictEqual(messages.DEFAULT_TEXT_SIZE, 20);
        assert.strictEqual(messages.parseSetTextSizeArgs([20]), 20);
        assert.strictEqual(messages.parseSetTextSizeArgs([21.5]), 22);
        assert.strictEqual(messages.parseSetTextSizeArgs([15.4]), 16);
        assert.strictEqual(messages.parseSetTextSizeArgs([28.6]), 28);
        // Out of range is clamped, not dropped: an integer can never be CSS.
        assert.strictEqual(messages.parseSetTextSizeArgs([5]), 16);
        assert.strictEqual(messages.parseSetTextSizeArgs([500]), 28);
        // Wrong type, wrong arity.
        assert.strictEqual(messages.parseSetTextSizeArgs(['20']), undefined);
        assert.strictEqual(
          messages.parseSetTextSizeArgs([Number.NaN]),
          undefined,
        );
        assert.strictEqual(
          messages.parseSetTextSizeArgs([Number.POSITIVE_INFINITY]),
          undefined,
        );
        assert.strictEqual(messages.parseSetTextSizeArgs([]), undefined);
        assert.strictEqual(messages.parseSetTextSizeArgs([20, 20]), undefined);
        assert.strictEqual(messages.parseSetTextSizeArgs(20), undefined);
        assert.strictEqual(messages.clampTextSize('big'), 20);
        assert.strictEqual(messages.clampTextSize(null), 20);
        assert.strictEqual(messages.clampTextSize(24.4), 24);
        // The two sliders of 05 are gone with their parsers.
        assert.strictEqual(messages.parseSetLineHeightArgs, undefined);
        assert.strictEqual(messages.parseSetColumnWidthArgs, undefined);
        assert.strictEqual(messages.clampLineHeight, undefined);
        assert.strictEqual(messages.clampColumnWidth, undefined);
      });

      test('parseSetWordMarkerArgs accepts the three styles only (07 §15.2)', function () {
        assert.deepStrictEqual(Array.from(messages.WORD_MARKERS), [
          'underline',
          'box',
          'off',
        ]);
        assert.strictEqual(messages.DEFAULT_WORD_MARKER, 'underline');
        assert.strictEqual(
          messages.parseSetWordMarkerArgs(['underline']),
          'underline',
        );
        assert.strictEqual(messages.parseSetWordMarkerArgs(['box']), 'box');
        assert.strictEqual(messages.parseSetWordMarkerArgs(['off']), 'off');
        // Unknown, wrong case, wrong type, wrong arity.
        assert.strictEqual(messages.parseSetWordMarkerArgs(['dot']), undefined);
        assert.strictEqual(messages.parseSetWordMarkerArgs(['Box']), undefined);
        assert.strictEqual(messages.parseSetWordMarkerArgs([1]), undefined);
        assert.strictEqual(messages.parseSetWordMarkerArgs([]), undefined);
        assert.strictEqual(
          messages.parseSetWordMarkerArgs(['box', 'off']),
          undefined,
        );
        assert.strictEqual(messages.parseSetWordMarkerArgs('box'), undefined);
        assert.strictEqual(messages.normaliseWordMarker('dot'), 'underline');
        assert.strictEqual(
          messages.normaliseWordMarker(undefined),
          'underline',
        );
        assert.strictEqual(messages.normaliseWordMarker('off'), 'off');
      });

      test('parseResetPageArgs accepts the empty argument list only', function () {
        assert.strictEqual(messages.parseResetPageArgs([]), true);
        assert.strictEqual(messages.parseResetPageArgs([1]), false);
        assert.strictEqual(messages.parseResetPageArgs(undefined), false);
        assert.strictEqual(messages.parseResetPageArgs({}), false);
      });
    },
  );

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

  // -------------------------------------------------------------------------
  // Help (`featrues/04-help-module.md` §9). This is the first read-aloud
  // message that carries document text off the machine, so the shape is the
  // only thing that gets through; over-long fields are truncated rather than
  // rejected, because they are assembled from the document and a long section
  // is the normal case.
  // -------------------------------------------------------------------------

  suite('parseHelpArgs', function () {
    const PASSAGE = 'The passage the listener did not understand.';

    function helpArgs(fieldOverrides, overrides) {
      const base = {
        sourceUri: URI,
        requestId: REQUEST_ID,
        passage: PASSAGE,
      };
      const merged = Object.assign({}, base, overrides);
      const fields = Object.assign(
        {
          title: 'The Title',
          breadcrumb: ['Chapter', 'Section'],
          before: 'before',
          after: 'after',
          section: 'section',
          contextMode: 'section',
        },
        fieldOverrides,
      );
      return [
        merged.sourceUri,
        merged.requestId,
        merged.passage,
        'fields' in merged ? merged.fields : fields,
      ];
    }

    test('accepts the exact four-element shape', function () {
      assert.deepStrictEqual(messages.parseHelpArgs(helpArgs()), {
        sourceUri: URI,
        requestId: REQUEST_ID,
        passage: PASSAGE,
        title: 'The Title',
        breadcrumb: ['Chapter', 'Section'],
        before: 'before',
        after: 'after',
        section: 'section',
        enclosing: '',
        mentions: '',
        contextMode: 'section',
      });
    });

    test('carries the enclosing block and the mentions of 11 through, capped', function () {
      const caps = messages.HELP_FIELD_CAPS;
      const parsed = messages.parseHelpArgs(
        helpArgs({
          enclosing: 'The harness is ⟦the metrics⟧ and more.',
          mentions: 'Under "Glossary": metrics, defined',
        }),
      );
      assert.strictEqual(
        parsed.enclosing,
        'The harness is ⟦the metrics⟧ and more.',
      );
      assert.strictEqual(parsed.mentions, 'Under "Glossary": metrics, defined');

      const long = messages.parseHelpArgs(
        helpArgs({
          enclosing: 'E'.repeat(caps.enclosing + 500),
          mentions: 'M'.repeat(caps.mentions + 500),
        }),
      );
      assert.strictEqual(long.enclosing.length, caps.enclosing);
      assert.strictEqual(long.mentions.length, caps.mentions);
      assert.ok(
        caps.enclosing > 3000,
        'the message cap must be looser than the 3,000-character prompt cap, so the ⟦ marker survives to the trim',
      );

      for (const key of ['enclosing', 'mentions']) {
        for (const value of [42, true, {}, ['a']]) {
          const override = {};
          override[key] = value;
          assert.strictEqual(
            messages.parseHelpArgs(helpArgs(override)),
            undefined,
            `${key}=${String(value)}`,
          );
        }
      }
    });

    test('accepts every context mode, and only those three', function () {
      for (const contextMode of messages.HELP_CONTEXT_MODES) {
        const parsed = messages.parseHelpArgs(helpArgs({ contextMode }));
        assert.ok(parsed, contextMode);
        assert.strictEqual(parsed.contextMode, contextMode);
      }
      for (const contextMode of ['whole', 'Section', '', 42, null, undefined]) {
        assert.strictEqual(
          messages.parseHelpArgs(helpArgs({ contextMode })),
          undefined,
          String(contextMode),
        );
      }
    });

    test('every optional field may be absent: only the passage is required', function () {
      assert.deepStrictEqual(
        messages.parseHelpArgs([
          URI,
          REQUEST_ID,
          PASSAGE,
          { contextMode: 'selection' },
        ]),
        {
          sourceUri: URI,
          requestId: REQUEST_ID,
          passage: PASSAGE,
          title: '',
          breadcrumb: [],
          before: '',
          after: '',
          section: '',
          enclosing: '',
          mentions: '',
          contextMode: 'selection',
        },
      );
    });

    test('rejects the wrong arity', function () {
      assert.strictEqual(messages.parseHelpArgs([]), undefined);
      assert.strictEqual(messages.parseHelpArgs([URI]), undefined);
      assert.strictEqual(
        messages.parseHelpArgs([URI, REQUEST_ID, PASSAGE]),
        undefined,
      );
      assert.strictEqual(
        messages.parseHelpArgs(helpArgs().concat(['extra'])),
        undefined,
      );
      assert.strictEqual(messages.parseHelpArgs('nope'), undefined);
      assert.strictEqual(messages.parseHelpArgs(undefined), undefined);
      assert.strictEqual(
        messages.parseHelpArgs({ 0: URI, length: 4 }),
        undefined,
      );
    });

    test('rejects a non-string or empty sourceUri', function () {
      for (const sourceUri of ['', 42, null, undefined, {}, [URI]]) {
        assert.strictEqual(
          messages.parseHelpArgs(helpArgs(undefined, { sourceUri })),
          undefined,
          String(sourceUri),
        );
      }
    });

    test('rejects a requestId that fails REQUEST_ID_RE', function () {
      for (const requestId of [
        '',
        'ra 1',
        'ra/1',
        'ra.1',
        'ra:1',
        '<script>',
        'x'.repeat(65),
        42,
        null,
        undefined,
      ]) {
        assert.strictEqual(
          messages.parseHelpArgs(helpArgs(undefined, { requestId })),
          undefined,
          String(requestId),
        );
      }
      // The shapes the webview actually mints do get through.
      for (const requestId of ['ra-1', 'help_42', 'A-b_0', 'x'.repeat(64)]) {
        assert.ok(
          messages.parseHelpArgs(helpArgs(undefined, { requestId })),
          requestId,
        );
      }
    });

    test('rejects an empty or whitespace-only passage', function () {
      for (const passage of ['', '   ', '\n\n', '\r\n \t', 42, null, [], {}]) {
        assert.strictEqual(
          messages.parseHelpArgs(helpArgs(undefined, { passage })),
          undefined,
          JSON.stringify(passage),
        );
      }
    });

    test('rejects a fields argument that is not a plain object', function () {
      for (const fields of ['fields', 42, null, undefined, [], [{}], true]) {
        assert.strictEqual(
          messages.parseHelpArgs(helpArgs(undefined, { fields })),
          undefined,
          String(fields),
        );
      }
    });

    test('rejects a non-string title, before, after or section', function () {
      for (const key of ['title', 'before', 'after', 'section']) {
        for (const value of [42, true, {}, ['a']]) {
          const override = {};
          override[key] = value;
          assert.strictEqual(
            messages.parseHelpArgs(helpArgs(override)),
            undefined,
            `${key}=${String(value)}`,
          );
        }
      }
    });

    test('truncates over-long fields instead of rejecting them', function () {
      const caps = messages.HELP_FIELD_CAPS;
      const parsed = messages.parseHelpArgs(
        helpArgs(
          {
            title: 'T'.repeat(caps.title + 500),
            before: 'B'.repeat(caps.before + 500),
            after: 'A'.repeat(caps.after + 500),
            section: 'S'.repeat(caps.section + 500),
          },
          { passage: 'P'.repeat(caps.passage + 500) },
        ),
      );
      assert.ok(
        parsed,
        'a long section is the normal case, not a rogue message',
      );
      assert.strictEqual(parsed.title.length, caps.title);
      assert.strictEqual(parsed.before.length, caps.before);
      assert.strictEqual(parsed.after.length, caps.after);
      assert.strictEqual(parsed.section.length, caps.section);
      assert.strictEqual(parsed.passage.length, caps.passage);
      assert.deepStrictEqual(Object.assign({}, caps), {
        title: 200,
        breadcrumbLevels: 6,
        breadcrumbLevel: 200,
        before: 1500,
        passage: 6000,
        after: 1500,
        // Four times the §3.1 prompt cap on purpose: this is a bound on a
        // rogue message, and cutting from the front here would throw the
        // [PASSAGE] marker away before help-prompt's trimAroundPassage saw it.
        section: 24000,
        // Same reasoning for the enclosing block and its ⟦ marker (11); the
        // mentions are cut from the front by the prompt, so theirs is just
        // looser than the prompt's 2,400.
        enclosing: 12000,
        mentions: 4000,
        question: 500,
        previous: 6000,
      });
    });

    test('the section cap leaves the [PASSAGE] marker for trimAroundPassage', function () {
      const caps = messages.HELP_FIELD_CAPS;
      assert.ok(
        caps.section > 6000,
        'the message cap must be looser than the §3.1 prompt cap',
      );
      const section = `${'A'.repeat(caps.section)}[PASSAGE]${'B'.repeat(50)}`;
      const parsed = messages.parseHelpArgs(helpArgs({ section }));
      assert.strictEqual(parsed.section.length, caps.section);
      // A section big enough to lose the marker here is a rogue message, not a
      // document: what the prompt sends is trimmed around the marker instead.
      assert.ok(section.length > caps.section);
    });

    test('normalises CRLF in every capped field', function () {
      const parsed = messages.parseHelpArgs(
        helpArgs({ section: 'a\r\nb\rc' }, { passage: 'p\r\nq' }),
      );
      assert.strictEqual(parsed.section, 'a\nb\nc');
      assert.strictEqual(parsed.passage, 'p\nq');
    });

    test('caps the breadcrumb at six levels and each level at 200 characters', function () {
      const parsed = messages.parseHelpArgs(
        helpArgs({
          breadcrumb: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'],
        }),
      );
      assert.deepStrictEqual(parsed.breadcrumb, [
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
      ]);
      assert.strictEqual(
        parsed.breadcrumb.length,
        messages.HELP_FIELD_CAPS.breadcrumbLevels,
      );

      const long = messages.parseHelpArgs(
        helpArgs({ breadcrumb: ['x'.repeat(500), 'y'.repeat(201)] }),
      );
      assert.strictEqual(
        long.breadcrumb[0].length,
        messages.HELP_FIELD_CAPS.breadcrumbLevel,
      );
      assert.strictEqual(long.breadcrumb[1].length, 200);
    });

    test('an absent breadcrumb is an empty array', function () {
      for (const breadcrumb of [undefined, null, []]) {
        const parsed = messages.parseHelpArgs(helpArgs({ breadcrumb }));
        assert.deepStrictEqual(parsed.breadcrumb, [], String(breadcrumb));
      }
    });

    test('rejects a non-array breadcrumb and a non-string level', function () {
      for (const breadcrumb of ['Chapter', 42, {}, true]) {
        assert.strictEqual(
          messages.parseHelpArgs(helpArgs({ breadcrumb })),
          undefined,
          String(breadcrumb),
        );
      }
      for (const level of [42, null, {}, ['nested']]) {
        assert.strictEqual(
          messages.parseHelpArgs(helpArgs({ breadcrumb: ['ok', level] })),
          undefined,
          String(level),
        );
      }
    });

    test('accepts every known follow-up when it carries the explanation it follows', function () {
      for (const followUp of messages.HELP_FOLLOW_UPS) {
        const parsed = messages.parseHelpArgs(
          helpArgs({
            followUp,
            previous: '### What it says\nthe answer on screen',
            question: 'what does OIDC mean?',
          }),
        );
        assert.ok(parsed, followUp);
        assert.strictEqual(parsed.followUp, followUp);
        assert.strictEqual(
          parsed.previous,
          '### What it says\nthe answer on screen',
        );
        assert.strictEqual(parsed.question, 'what does OIDC mean?');
      }
      assert.deepStrictEqual(Array.from(messages.HELP_FOLLOW_UPS), [
        'simpler',
        'deeper',
        'example',
        'question',
      ]);
    });

    test('rejects an unknown follow-up', function () {
      for (const followUp of ['harder', 'Simpler', '', 42, {}, ['simpler']]) {
        assert.strictEqual(
          messages.parseHelpArgs(helpArgs({ followUp, previous: 'prior' })),
          undefined,
          String(followUp),
        );
      }
    });

    test('rejects a follow-up with no previous explanation', function () {
      for (const followUp of messages.HELP_FOLLOW_UPS) {
        assert.strictEqual(
          messages.parseHelpArgs(helpArgs({ followUp, question: 'why?' })),
          undefined,
          followUp,
        );
        assert.strictEqual(
          messages.parseHelpArgs(
            helpArgs({ followUp, previous: '', question: 'why?' }),
          ),
          undefined,
          `${followUp} (empty previous)`,
        );
      }
    });

    test('rejects a question follow-up with no question', function () {
      assert.strictEqual(
        messages.parseHelpArgs(
          helpArgs({ followUp: 'question', previous: 'prior' }),
        ),
        undefined,
      );
      assert.strictEqual(
        messages.parseHelpArgs(
          helpArgs({ followUp: 'question', previous: 'prior', question: '' }),
        ),
        undefined,
      );
      assert.ok(
        messages.parseHelpArgs(
          helpArgs({
            followUp: 'question',
            previous: 'prior',
            question: 'why?',
          }),
        ),
      );
    });

    test('a first request carries no followUp, question or previous', function () {
      const parsed = messages.parseHelpArgs(helpArgs());
      assert.strictEqual(parsed.followUp, undefined);
      assert.strictEqual(parsed.question, undefined);
      assert.strictEqual(parsed.previous, undefined);
      assert.ok(!('followUp' in parsed));
      assert.ok(!('question' in parsed));
      assert.ok(!('previous' in parsed));
    });

    test('rejects a non-string question or previous', function () {
      for (const value of [42, true, {}, ['a']]) {
        assert.strictEqual(
          messages.parseHelpArgs(helpArgs({ question: value })),
          undefined,
          `question=${String(value)}`,
        );
        assert.strictEqual(
          messages.parseHelpArgs(helpArgs({ previous: value })),
          undefined,
          `previous=${String(value)}`,
        );
      }
    });

    test('truncates an over-long question and previous explanation', function () {
      const parsed = messages.parseHelpArgs(
        helpArgs({
          followUp: 'question',
          question: 'q'.repeat(1000),
          previous: 'p'.repeat(10000),
        }),
      );
      assert.strictEqual(
        parsed.question.length,
        messages.HELP_FIELD_CAPS.question,
      );
      assert.strictEqual(
        parsed.previous.length,
        messages.HELP_FIELD_CAPS.previous,
      );
    });

    test('nothing beyond the F13 shape survives', function () {
      const parsed = messages.parseHelpArgs(
        helpArgs({
          engine: 'custom',
          command: ['rm', '-rf', '/'],
          __proto__: {},
        }),
      );
      assert.deepStrictEqual(Object.keys(parsed).sort(), [
        'after',
        'before',
        'breadcrumb',
        'contextMode',
        'enclosing',
        'mentions',
        'passage',
        'requestId',
        'section',
        'sourceUri',
        'title',
      ]);
    });
  });

  suite('parseHelpCancelArgs', function () {
    test('accepts [uri, id] and [uri, id, reason]', function () {
      assert.deepStrictEqual(messages.parseHelpCancelArgs([URI, REQUEST_ID]), {
        sourceUri: URI,
        requestId: REQUEST_ID,
      });
      assert.deepStrictEqual(
        messages.parseHelpCancelArgs([URI, REQUEST_ID, 'sheet closed']),
        { sourceUri: URI, requestId: REQUEST_ID, reason: 'sheet closed' },
      );
      assert.deepStrictEqual(
        messages.parseHelpCancelArgs([URI, REQUEST_ID, undefined]),
        { sourceUri: URI, requestId: REQUEST_ID },
      );
      assert.deepStrictEqual(
        messages.parseHelpCancelArgs([URI, REQUEST_ID, null]),
        { sourceUri: URI, requestId: REQUEST_ID },
      );
    });

    test('flattens and caps the reason, which is only ever logged', function () {
      assert.strictEqual(
        messages.parseHelpCancelArgs([URI, REQUEST_ID, 'a\r\n\nb']).reason,
        'a b',
      );
      assert.strictEqual(
        messages.parseHelpCancelArgs([URI, REQUEST_ID, 'r'.repeat(500)]).reason
          .length,
        messages.MAX_CANCEL_REASON_CHARS,
      );
    });

    test('rejects everything else', function () {
      const bad = [
        [],
        [URI],
        [URI, REQUEST_ID, 'reason', 'extra'],
        ['', REQUEST_ID],
        [42, REQUEST_ID],
        [URI, 'bad id'],
        [URI, ''],
        [URI, 42],
        [URI, REQUEST_ID, 42],
        [URI, REQUEST_ID, {}],
        'nope',
        undefined,
        null,
      ];
      for (const args of bad) {
        assert.strictEqual(
          messages.parseHelpCancelArgs(args),
          undefined,
          JSON.stringify(args),
        );
      }
    });
  });
  // ---------------------------------------------------------- notes (12 §14.2)

  suite('notes parsers (12 §14.2)', function () {
    const NOTE_ID = '20260905T154210Z-7f3a';
    const anchor = (overrides) =>
      Object.assign(
        {
          block: 'b3f9a1c2',
          line: 76,
          exact: 'the eligible block before the first selected block',
          prefix: '| Before | ',
          suffix: ', extracted',
          offset: 11,
          blocks: 1,
        },
        overrides || {},
      );
    const fields = (overrides) =>
      Object.assign(
        {
          title: 'T',
          breadcrumb: ['A', 'B'],
          before: 'b',
          after: 'a',
          section: 's [PASSAGE]',
          enclosing: '⟦x⟧ y',
          mentions: '',
          contextMode: 'section',
        },
        overrides || {},
      );
    const createArgs = (overrides) => {
      const o = Object.assign(
        {
          sourceUri: URI,
          requestId: REQUEST_ID,
          passage: 'the eligible block before the first selected block',
          fields: fields(),
          anchor: anchor(),
          options: { source: 'selection' },
        },
        overrides || {},
      );
      return [
        o.sourceUri,
        o.requestId,
        o.passage,
        o.fields,
        o.anchor,
        o.options,
      ];
    };

    test('parseNoteCreateArgs accepts a selection capture', function () {
      const request = messages.parseNoteCreateArgs(createArgs());
      assert.ok(request);
      assert.strictEqual(request.source, 'selection');
      assert.strictEqual(request.explanation, undefined);
      assert.deepStrictEqual(request.anchor, anchor());
      assert.deepStrictEqual(request.fields, fields());
    });

    test('parseNoteCreateArgs accepts Save as note with the explanation', function () {
      const request = messages.parseNoteCreateArgs(
        createArgs({
          options: { source: 'help', explanation: '### What it says\nX.' },
        }),
      );
      assert.strictEqual(request.source, 'help');
      assert.strictEqual(request.explanation, '### What it says\nX.');
    });

    test('parseNoteCreateArgs refusals', function () {
      const bad = [
        createArgs().slice(0, 5),
        createArgs({ sourceUri: '' }),
        createArgs({ requestId: 'bad id' }),
        createArgs({ passage: '   ' }),
        createArgs({ passage: 42 }),
        createArgs({ fields: null }),
        createArgs({ fields: fields({ contextMode: 'everything' }) }),
        createArgs({ fields: fields({ breadcrumb: 'A > B' }) }),
        createArgs({ anchor: null }),
        createArgs({ anchor: anchor({ block: 'x1' }) }),
        createArgs({ anchor: anchor({ block: 'b' + 'f'.repeat(9) }) }),
        createArgs({ anchor: anchor({ line: -1 }) }),
        createArgs({ anchor: anchor({ line: 1.5 }) }),
        createArgs({ anchor: anchor({ exact: 'x'.repeat(6001) }) }),
        createArgs({ anchor: anchor({ prefix: 'x'.repeat(65) }) }),
        createArgs({ anchor: anchor({ suffix: 'x'.repeat(65) }) }),
        createArgs({ anchor: anchor({ offset: -1 }) }),
        createArgs({ anchor: anchor({ blocks: 0 }) }),
        createArgs({ anchor: anchor({ blocks: 51 }) }),
        createArgs({ options: { source: 'clipboard' } }),
        createArgs({ options: { source: 'help' } }),
        createArgs({ options: { source: 'help', explanation: '  ' } }),
        createArgs({ options: { source: 'selection', explanation: 'stray' } }),
        'nope',
        null,
      ];
      for (const args of bad) {
        assert.strictEqual(
          messages.parseNoteCreateArgs(args),
          undefined,
          JSON.stringify(args).slice(0, 120),
        );
      }
    });

    test('parseNoteAnchor: line may be null or absent, blocks defaults to 1, CRLF normalised', function () {
      assert.strictEqual(
        messages.parseNoteAnchor(anchor({ line: null })).line,
        null,
      );
      const bare = messages.parseNoteAnchor({
        block: 'b1',
        exact: 'a\r\nb',
        offset: 0,
      });
      assert.deepStrictEqual(bare, {
        block: 'b1',
        line: null,
        exact: 'a\nb',
        prefix: '',
        suffix: '',
        offset: 0,
        blocks: 1,
      });
    });

    test('parseNoteUpdateArgs: title, myNote, tags, each capped and normalised', function () {
      const request = messages.parseNoteUpdateArgs([
        URI,
        NOTE_ID,
        {
          title: '  A   title ',
          myNote: 'line\r\ntwo',
          tags: ['Help', 'two words', '!!!', 'help'],
        },
      ]);
      assert.deepStrictEqual(request, {
        sourceUri: URI,
        noteId: NOTE_ID,
        title: 'A title',
        myNote: 'line\ntwo',
        tags: ['help', 'two-words'],
      });
      assert.strictEqual(
        messages.parseNoteUpdateArgs([URI, NOTE_ID, { title: 'x'.repeat(200) }])
          .title.length,
        120,
      );
      assert.strictEqual(
        messages.parseNoteUpdateArgs([
          URI,
          NOTE_ID,
          { myNote: 'x'.repeat(30000) },
        ]).myNote.length,
        20000,
      );
      assert.strictEqual(
        messages.parseNoteUpdateArgs([
          URI,
          NOTE_ID,
          { tags: Array.from({ length: 20 }, (_, i) => 't' + i) },
        ]).tags.length,
        12,
      );
      assert.strictEqual(
        messages.parseNoteUpdateArgs([URI, NOTE_ID, { tags: ['x'.repeat(40)] }])
          .tags[0].length,
        32,
      );
    });

    test('parseNoteUpdateArgs refusals', function () {
      const bad = [
        [URI, NOTE_ID],
        [URI, NOTE_ID, {}],
        [URI, NOTE_ID, { title: '   ' }],
        [URI, NOTE_ID, { title: 42 }],
        [URI, NOTE_ID, { myNote: 42 }],
        [URI, NOTE_ID, { tags: 'help' }],
        [URI, NOTE_ID, { tags: [42] }],
        [URI, 'note-1', { title: 'x' }],
        ['', NOTE_ID, { title: 'x' }],
        [URI, NOTE_ID, null],
      ];
      for (const args of bad) {
        assert.strictEqual(
          messages.parseNoteUpdateArgs(args),
          undefined,
          JSON.stringify(args),
        );
      }
    });

    test('the id-only messages: delete, undo, copy', function () {
      for (const fn of [
        'parseNoteDeleteArgs',
        'parseNoteUndoDeleteArgs',
        'parseNoteCopyArgs',
      ]) {
        assert.deepStrictEqual(messages[fn]([URI, NOTE_ID]), {
          sourceUri: URI,
          noteId: NOTE_ID,
        });
        for (const args of [
          [URI],
          [URI, NOTE_ID, 'x'],
          [URI, 'x'],
          ['', NOTE_ID],
          [URI, 42],
          null,
        ]) {
          assert.strictEqual(
            messages[fn](args),
            undefined,
            fn + ' ' + JSON.stringify(args),
          );
        }
      }
    });

    test('parseNoteRegenerateArgs: fields or null', function () {
      assert.deepStrictEqual(
        messages.parseNoteRegenerateArgs([URI, NOTE_ID, null]),
        {
          sourceUri: URI,
          noteId: NOTE_ID,
          fields: null,
        },
      );
      assert.deepStrictEqual(
        messages.parseNoteRegenerateArgs([URI, NOTE_ID, fields()]).fields,
        fields(),
      );
      for (const args of [
        [URI, NOTE_ID],
        [URI, NOTE_ID, 'fields'],
        [URI, NOTE_ID, fields({ contextMode: 'x' })],
        [URI, 'bad', null],
      ]) {
        assert.strictEqual(
          messages.parseNoteRegenerateArgs(args),
          undefined,
          JSON.stringify(args),
        );
      }
    });

    test('parseNoteReattachArgs: anchor and breadcrumb', function () {
      const request = messages.parseNoteReattachArgs([
        URI,
        NOTE_ID,
        anchor(),
        ['A', 'B'],
      ]);
      assert.deepStrictEqual(request.anchor, anchor());
      assert.deepStrictEqual(request.breadcrumb, ['A', 'B']);
      assert.deepStrictEqual(
        messages.parseNoteReattachArgs([URI, NOTE_ID, anchor(), null])
          .breadcrumb,
        [],
      );
      assert.strictEqual(
        messages.parseNoteReattachArgs([
          URI,
          NOTE_ID,
          anchor(),
          ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
        ]).breadcrumb.length,
        6,
      );
      for (const args of [
        [URI, NOTE_ID, anchor()],
        [URI, NOTE_ID, anchor({ block: 'nope' }), []],
        [URI, NOTE_ID, anchor(), 'A'],
        [URI, NOTE_ID, anchor(), [1]],
      ]) {
        assert.strictEqual(
          messages.parseNoteReattachArgs(args),
          undefined,
          JSON.stringify(args),
        );
      }
    });

    test('parseNoteOpenArgs: editor or file', function () {
      assert.deepStrictEqual(
        messages.parseNoteOpenArgs([URI, NOTE_ID, 'editor']),
        {
          sourceUri: URI,
          noteId: NOTE_ID,
          target: 'editor',
        },
      );
      assert.strictEqual(
        messages.parseNoteOpenArgs([URI, NOTE_ID, 'file']).target,
        'file',
      );
      for (const args of [
        [URI, NOTE_ID],
        [URI, NOTE_ID, 'browser'],
        [URI, 'x', 'editor'],
      ]) {
        assert.strictEqual(
          messages.parseNoteOpenArgs(args),
          undefined,
          JSON.stringify(args),
        );
      }
    });

    test('parseNoteAnchorsArgs: at most 500 distinct reports', function () {
      const request = messages.parseNoteAnchorsArgs([
        URI,
        [
          { noteId: NOTE_ID, found: true, block: 'b1', line: 3 },
          { noteId: '20260905T154211Z-0001', found: false },
          {
            noteId: '20260905T154212Z-0002',
            found: true,
            block: 'b2',
            line: null,
          },
        ],
      ]);
      assert.strictEqual(request.anchors.length, 3);
      assert.deepStrictEqual(request.anchors[0], {
        noteId: NOTE_ID,
        found: true,
        block: 'b1',
        line: 3,
      });
      assert.deepStrictEqual(request.anchors[1], {
        noteId: '20260905T154211Z-0001',
        found: false,
      });
      assert.strictEqual(request.anchors[2].line, null);
      assert.deepStrictEqual(
        messages.parseNoteAnchorsArgs([URI, []]).anchors,
        [],
      );
      const many = Array.from({ length: 501 }, (_, i) => ({
        noteId: '20260905T154210Z-' + (i + 0x1000).toString(16).slice(-4),
        found: true,
      }));
      assert.strictEqual(
        messages.parseNoteAnchorsArgs([URI, many]),
        undefined,
        'over the cap',
      );
      for (const args of [
        [URI],
        [URI, 'x'],
        [URI, [{ noteId: 'x', found: true }]],
        [URI, [{ noteId: NOTE_ID }]],
        [URI, [{ noteId: NOTE_ID, found: 'yes' }]],
        [URI, [{ noteId: NOTE_ID, found: true, block: 'zz' }]],
        [URI, [{ noteId: NOTE_ID, found: true, line: -2 }]],
        [
          URI,
          [
            { noteId: NOTE_ID, found: true },
            { noteId: NOTE_ID, found: false },
          ],
        ],
      ]) {
        assert.strictEqual(
          messages.parseNoteAnchorsArgs(args),
          undefined,
          JSON.stringify(args),
        );
      }
    });

    test('parseNotesShowAllArgs', function () {
      assert.strictEqual(messages.parseNotesShowAllArgs([URI]), URI);
      for (const args of [[], [URI, 'x'], [''], [42], null]) {
        assert.strictEqual(messages.parseNotesShowAllArgs(args), undefined);
      }
    });

    test('kind note is accepted by parseSynthesizeArgs; anything else is not', function () {
      assert.strictEqual(
        messages.parseSynthesizeArgs(
          synthesizeArgs({ options: { kind: 'note' } }),
        ).options.kind,
        'note',
      );
      assert.strictEqual(
        messages.parseSynthesizeArgs(
          synthesizeArgs({ options: { kind: 'sheet' } }),
        ),
        undefined,
      );
    });

    test('normaliseNotesDecoration', function () {
      assert.strictEqual(messages.normaliseNotesDecoration('marker'), 'marker');
      assert.strictEqual(messages.normaliseNotesDecoration('none'), 'none');
      assert.strictEqual(
        messages.normaliseNotesDecoration('glow'),
        'marker-and-mark',
      );
      assert.strictEqual(
        messages.normaliseNotesDecoration(undefined),
        'marker-and-mark',
      );
    });
  });

  suite('classroom parsers (13 §14.2)', function () {
    const MODULE_ID = '20260905T173010Z-4c2e';
    const anchor = () => ({
      block: 'b3f9a1c2',
      line: 393,
      exact: 'Then the human path',
      prefix: '',
      suffix: '',
      offset: 0,
      blocks: 1,
    });
    const fields = (overrides) =>
      Object.assign(
        {
          title: 'T',
          breadcrumb: ['A'],
          before: '',
          after: '',
          section: '',
          enclosing: 'x ⟦Then the human path⟧ y',
          mentions: '',
          contextMode: 'document',
        },
        overrides || {},
      );
    const options = (overrides) =>
      Object.assign(
        {
          level: 2,
          readerNote: 'I do not get it',
          persona: 'max',
          audience: 'a reader',
          linked: ['featrues/04-help-module.md'],
          headingId: 'the-governed-path',
        },
        overrides || {},
      );
    const buildArgs = (opts, fieldOverrides) => [
      URI,
      REQUEST_ID,
      'Then the human path',
      fields(fieldOverrides),
      anchor(),
      options(opts),
    ];

    test('parseClassroomPrepareArgs takes the uri, the request id and the fields', function () {
      const request = messages.parseClassroomPrepareArgs([
        URI,
        REQUEST_ID,
        fields(),
      ]);
      assert.ok(request);
      assert.strictEqual(request.sourceUri, URI);
      assert.strictEqual(request.requestId, REQUEST_ID);
      assert.strictEqual(request.fields.contextMode, 'document');
      assert.strictEqual(
        messages.parseClassroomPrepareArgs([URI, REQUEST_ID]),
        undefined,
      );
      assert.strictEqual(
        messages.parseClassroomPrepareArgs([URI, 'bad id!', fields()]),
        undefined,
      );
      assert.strictEqual(
        messages.parseClassroomPrepareArgs([
          URI,
          REQUEST_ID,
          fields({ contextMode: 'odd' }),
        ]),
        undefined,
      );
      assert.strictEqual(
        messages.parseClassroomPrepareArgs(['', REQUEST_ID, fields()]),
        undefined,
      );
    });

    test('parseClassroomBuildArgs accepts the whole payload and normalises the free text', function () {
      const request = messages.parseClassroomBuildArgs(
        buildArgs({
          readerNote: '  two   lines\nhere ',
          audience: ' the  audience ',
        }),
      );
      assert.ok(request);
      assert.strictEqual(request.passage, 'Then the human path');
      assert.strictEqual(request.level, 2);
      assert.strictEqual(request.readerNote, 'two lines here');
      assert.strictEqual(request.audience, 'the audience');
      assert.strictEqual(request.persona, 'max');
      assert.deepStrictEqual(request.linked, ['featrues/04-help-module.md']);
      assert.strictEqual(request.headingId, 'the-governed-path');
      assert.deepStrictEqual(request.anchor, anchor());
      const bare = messages.parseClassroomBuildArgs(
        buildArgs({
          readerNote: '',
          audience: '',
          linked: [],
          headingId: null,
        }),
      );
      assert.ok(bare, 'empty strings and null are allowed');
      assert.strictEqual(bare.readerNote, '');
      assert.strictEqual(bare.headingId, null);
      const noLinked = messages.parseClassroomBuildArgs(
        buildArgs({ linked: undefined }),
      );
      assert.ok(noLinked);
      assert.deepStrictEqual(noLinked.linked, []);
    });

    test('parseClassroomBuildArgs refuses every bad field', function () {
      const bad = [
        ['wrong length', buildArgs().slice(0, 5)],
        [
          'empty passage',
          [URI, REQUEST_ID, '   ', fields(), anchor(), options()],
        ],
        ['level 0', buildArgs({ level: 0 })],
        ['level 4', buildArgs({ level: 4 })],
        ['level as string', buildArgs({ level: '2' })],
        ['bad persona', buildArgs({ persona: 'Max!' })],
        ['persona too long', buildArgs({ persona: 'a'.repeat(41) })],
        ['readerNote not a string', buildArgs({ readerNote: 5 })],
        [
          'five linked',
          buildArgs({ linked: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'] }),
        ],
        ['linked climbs', buildArgs({ linked: ['../secrets.md'] })],
        ['linked absolute', buildArgs({ linked: ['/etc/passwd.md'] })],
        ['linked drive', buildArgs({ linked: ['C:\\x.md'] })],
        ['linked scheme', buildArgs({ linked: ['file:///x.md'] })],
        ['linked too long', buildArgs({ linked: ['a/'.repeat(201) + 'x.md'] })],
        ['linked not strings', buildArgs({ linked: [1] })],
        ['headingId with whitespace', buildArgs({ headingId: 'a b' })],
        ['headingId too long', buildArgs({ headingId: 'x'.repeat(201) })],
        [
          'bad anchor',
          [URI, REQUEST_ID, 'p', fields(), { block: 'nope' }, options()],
        ],
        [
          'bad fields',
          [URI, REQUEST_ID, 'p', { contextMode: 'odd' }, anchor(), options()],
        ],
        [
          'options not an object',
          [URI, REQUEST_ID, 'p', fields(), anchor(), 'x'],
        ],
      ];
      for (const [label, args] of bad) {
        assert.strictEqual(
          messages.parseClassroomBuildArgs(args),
          undefined,
          label,
        );
      }
      const capped = messages.parseClassroomBuildArgs(
        buildArgs({ readerNote: 'n'.repeat(600), audience: 'a'.repeat(400) }),
      );
      assert.strictEqual(
        capped.readerNote.length,
        500,
        'the note is capped, not refused',
      );
      assert.strictEqual(capped.audience.length, 300);
    });

    test('cancel, continue, open, openSource and openFolder', function () {
      const cancel = messages.parseClassroomCancelArgs([
        URI,
        MODULE_ID,
        'sheet\nline',
      ]);
      assert.deepStrictEqual(cancel, {
        sourceUri: URI,
        moduleId: MODULE_ID,
        reason: 'sheet line',
      });
      assert.deepStrictEqual(
        messages.parseClassroomCancelArgs([URI, MODULE_ID]),
        {
          sourceUri: URI,
          moduleId: MODULE_ID,
          reason: '',
        },
      );
      assert.strictEqual(
        messages.parseClassroomCancelArgs([URI, 'nope', 'x']),
        undefined,
      );
      assert.strictEqual(
        messages.parseClassroomCancelArgs([URI, MODULE_ID, 5]),
        undefined,
      );
      assert.deepStrictEqual(
        messages.parseClassroomContinueArgs([URI, MODULE_ID]),
        {
          sourceUri: URI,
          moduleId: MODULE_ID,
        },
      );
      assert.strictEqual(messages.parseClassroomContinueArgs([URI]), undefined);
      assert.deepStrictEqual(
        messages.parseClassroomOpenArgs([URI, MODULE_ID]),
        {
          sourceUri: URI,
          moduleId: MODULE_ID,
        },
      );
      assert.deepStrictEqual(
        messages.parseClassroomOpenSourceArgs(['file:///m.md', MODULE_ID]),
        {
          moduleUri: 'file:///m.md',
          moduleId: MODULE_ID,
        },
      );
      assert.strictEqual(
        messages.parseClassroomOpenSourceArgs(['', MODULE_ID]),
        undefined,
      );
      assert.strictEqual(messages.parseClassroomOpenFolderArgs([URI]), URI);
      assert.strictEqual(messages.parseClassroomOpenFolderArgs([]), undefined);
      assert.strictEqual(
        messages.parseClassroomOpenFolderArgs([URI, 'x']),
        undefined,
      );
    });

    test('isSafeRelativePath', function () {
      assert.strictEqual(messages.isSafeRelativePath('docs/a b.md'), true);
      assert.strictEqual(messages.isSafeRelativePath('a/../b.md'), false);
      assert.strictEqual(messages.isSafeRelativePath('..'), false);
      assert.strictEqual(messages.isSafeRelativePath('/abs.md'), false);
      assert.strictEqual(
        messages.isSafeRelativePath('\\\\server\\share.md'),
        false,
      );
      assert.strictEqual(messages.isSafeRelativePath('https://x/y.md'), false);
      assert.strictEqual(messages.isSafeRelativePath(''), false);
      assert.strictEqual(messages.isSafeRelativePath('a\u0000b.md'), false);
    });
  });
  suite('classroom delete parsers (13 §11.4)', function () {
    const MODULE_ID = '20260905T173010Z-4c2e';
    test('parseClassroomDeleteArgs and parseClassroomUndoDeleteArgs take either uri and the module id', function () {
      for (const fn of [
        'parseClassroomDeleteArgs',
        'parseClassroomUndoDeleteArgs',
      ]) {
        assert.deepStrictEqual(messages[fn]([URI, MODULE_ID]), {
          sourceUri: URI,
          moduleId: MODULE_ID,
        });
        for (const args of [
          [URI],
          [URI, MODULE_ID, 'x'],
          [URI, 'note-1'],
          ['', MODULE_ID],
          [URI, 42],
          null,
        ]) {
          assert.strictEqual(
            messages[fn](args),
            undefined,
            fn + ' ' + JSON.stringify(args),
          );
        }
      }
    });
  });

  suite('retell parsers (15 §14.2)', function () {
    const EDITION_ID = '20260907T104512Z-9a3f';
    const anchor = () => ({
      block: 'b7c1a904',
      line: 208,
      exact: '7. Specs, ADRs, constitution',
      prefix: '',
      suffix: '',
      offset: 0,
      blocks: 1,
    });
    const fields = (overrides) =>
      Object.assign(
        {
          title: 'Agent-Ready Repos',
          breadcrumb: ['Agent-Ready Repos', '7. Specs, ADRs, constitution'],
          before: '',
          after: '',
          section: '',
          enclosing: '',
          mentions: '',
          contextMode: 'section',
        },
        overrides || {},
      );
    const range = (overrides) =>
      Object.assign(
        { startLine: 208, endLine: 377, scope: 'selection' },
        overrides || {},
      );

    test('parseRetellPrepareArgs takes the uri, the request id, the fields and the one-based range', function () {
      const request = messages.parseRetellPrepareArgs([
        URI,
        REQUEST_ID,
        fields(),
        range(),
      ]);
      assert.ok(request);
      assert.strictEqual(request.sourceUri, URI);
      assert.strictEqual(request.requestId, REQUEST_ID);
      assert.strictEqual(request.fields.title, 'Agent-Ready Repos');
      assert.strictEqual(request.startLine, 208);
      assert.strictEqual(request.endLine, 377);
      assert.strictEqual(request.scope, 'selection');
      const whole = messages.parseRetellPrepareArgs([
        URI,
        REQUEST_ID,
        fields(),
        range({ startLine: 1, endLine: 1, scope: 'document' }),
      ]);
      assert.ok(whole);
      assert.strictEqual(whole.scope, 'document');
      const same = messages.parseRetellPrepareArgs([
        URI,
        REQUEST_ID,
        fields(),
        range({ startLine: 40, endLine: 40 }),
      ]);
      assert.ok(same, 'startLine may equal endLine');
    });

    test('parseRetellPrepareArgs refuses every bad field', function () {
      for (const args of [
        [URI, REQUEST_ID, fields()],
        [URI, REQUEST_ID, fields(), range(), 'extra'],
        ['', REQUEST_ID, fields(), range()],
        [URI, 'bad id!', fields(), range()],
        [URI, REQUEST_ID, 'fields', range()],
        [URI, REQUEST_ID, fields({ contextMode: 'odd' }), range()],
        [URI, REQUEST_ID, fields(), range({ startLine: 377, endLine: 208 })],
        [URI, REQUEST_ID, fields(), range({ startLine: 0 })],
        [URI, REQUEST_ID, fields(), range({ startLine: 2.5 })],
        [URI, REQUEST_ID, fields(), range({ endLine: '377' })],
        [URI, REQUEST_ID, fields(), range({ endLine: 1000001 })],
        [URI, REQUEST_ID, fields(), range({ scope: 'block' })],
        [URI, REQUEST_ID, fields(), range({ scope: undefined })],
        [URI, REQUEST_ID, fields(), null],
        null,
      ]) {
        assert.strictEqual(
          messages.parseRetellPrepareArgs(args),
          undefined,
          JSON.stringify(args),
        );
      }
    });

    test('parseRetellBuildArgs takes the anchor and the edition id, null for a new edition', function () {
      const request = messages.parseRetellBuildArgs([
        URI,
        REQUEST_ID,
        fields(),
        anchor(),
        range({ editionId: null }),
      ]);
      assert.ok(request);
      assert.deepStrictEqual(request.anchor, anchor());
      assert.strictEqual(request.editionId, null);
      assert.strictEqual(request.startLine, 208);
      assert.strictEqual(request.scope, 'selection');
      const rebuild = messages.parseRetellBuildArgs([
        URI,
        REQUEST_ID,
        fields(),
        anchor(),
        range({ editionId: EDITION_ID }),
      ]);
      assert.ok(rebuild);
      assert.strictEqual(rebuild.editionId, EDITION_ID);
      const omitted = messages.parseRetellBuildArgs([
        URI,
        REQUEST_ID,
        fields(),
        anchor(),
        range(),
      ]);
      assert.ok(omitted, 'editionId may be omitted');
      assert.strictEqual(omitted.editionId, null);
      // The whole-document command has no selection: a null anchor is fine
      // in document scope only (§12.5).
      const document = messages.parseRetellBuildArgs([
        URI,
        REQUEST_ID,
        fields(),
        null,
        range({ startLine: 1, endLine: 1, scope: 'document' }),
      ]);
      assert.ok(document);
      assert.strictEqual(document.anchor, null);
      assert.strictEqual(document.scope, 'document');
    });

    test('parseRetellBuildArgs refuses every bad field', function () {
      for (const args of [
        [URI, REQUEST_ID, fields(), anchor()],
        [URI, REQUEST_ID, fields(), anchor(), range(), 'extra'],
        ['', REQUEST_ID, fields(), anchor(), range()],
        [URI, 'bad id!', fields(), anchor(), range()],
        [URI, REQUEST_ID, fields({ contextMode: 'odd' }), anchor(), range()],
        [URI, REQUEST_ID, fields(), null, range()],
        [URI, REQUEST_ID, fields(), { block: 'nope' }, range()],
        [URI, REQUEST_ID, fields(), anchor(), range({ startLine: 400 })],
        [URI, REQUEST_ID, fields(), anchor(), range({ startLine: -1 })],
        [URI, REQUEST_ID, fields(), anchor(), range({ scope: 'page' })],
        [URI, REQUEST_ID, fields(), anchor(), range({ editionId: 'x' })],
        [URI, REQUEST_ID, fields(), anchor(), range({ editionId: 5 })],
        [URI, REQUEST_ID, fields(), anchor(), 'range'],
      ]) {
        assert.strictEqual(
          messages.parseRetellBuildArgs(args),
          undefined,
          JSON.stringify(args),
        );
      }
    });

    test('cancel, continue, open, delete, undo delete, open source and open folder', function () {
      assert.deepStrictEqual(
        messages.parseRetellCancelArgs([URI, EDITION_ID, 'sheet']),
        { sourceUri: URI, editionId: EDITION_ID, reason: 'sheet' },
      );
      assert.deepStrictEqual(
        messages.parseRetellCancelArgs([URI, EDITION_ID]),
        { sourceUri: URI, editionId: EDITION_ID, reason: '' },
      );
      assert.strictEqual(
        messages.parseRetellCancelArgs([URI, EDITION_ID, 'x'.repeat(300)])
          .reason.length,
        200,
      );
      assert.strictEqual(
        messages.parseRetellCancelArgs([URI, 'nope', 'x']),
        undefined,
      );
      for (const fn of [
        'parseRetellContinueArgs',
        'parseRetellOpenArgs',
        'parseRetellDeleteArgs',
        'parseRetellUndoDeleteArgs',
      ]) {
        assert.deepStrictEqual(messages[fn]([URI, EDITION_ID]), {
          sourceUri: URI,
          editionId: EDITION_ID,
        });
        for (const args of [
          [URI],
          [URI, EDITION_ID, 'x'],
          [URI, 'note-1'],
          ['', EDITION_ID],
          [URI, 42],
          null,
        ]) {
          assert.strictEqual(
            messages[fn](args),
            undefined,
            fn + ' ' + JSON.stringify(args),
          );
        }
      }
      assert.deepStrictEqual(
        messages.parseRetellOpenSourceArgs(['file:///e.md', EDITION_ID, 3]),
        { editionUri: 'file:///e.md', editionId: EDITION_ID, n: 3 },
      );
      for (const args of [
        ['file:///e.md', EDITION_ID],
        ['file:///e.md', EDITION_ID, 0],
        ['file:///e.md', EDITION_ID, 1001],
        ['file:///e.md', EDITION_ID, 1.5],
        ['file:///e.md', EDITION_ID, '3'],
        ['', EDITION_ID, 1],
        ['file:///e.md', 'nope', 1],
      ]) {
        assert.strictEqual(
          messages.parseRetellOpenSourceArgs(args),
          undefined,
          JSON.stringify(args),
        );
      }
      assert.strictEqual(messages.parseRetellOpenFolderArgs([URI]), URI);
      assert.strictEqual(messages.parseRetellOpenFolderArgs([]), undefined);
      assert.strictEqual(
        messages.parseRetellOpenFolderArgs([URI, 'x']),
        undefined,
      );
    });

    test('the scopes, statuses and caps are the ones the spec names', function () {
      assert.deepStrictEqual(messages.RETELL_SCOPES, ['selection', 'document']);
      assert.deepStrictEqual(messages.RETELL_STATUSES, [
        'planning',
        'writing',
        'done',
        'stopped',
        'failed',
        'queued',
      ]);
      assert.deepStrictEqual(messages.RETELL_SECTION_STATUSES, [
        'queued',
        'writing',
        'done',
        'failed',
      ]);
      assert.strictEqual(messages.RETELL_LINE_MAX, 1000000);
      assert.strictEqual(messages.RETELL_UNIT_MAX, 1000);
    });
  });
});
