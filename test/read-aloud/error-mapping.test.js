/* global suite, test, suiteSetup, suiteTeardown */

/**
 * T-10, T-11 — `src/read-aloud/error-mapping.ts` (F10, R2 §9).
 *
 * Table-driven over every code in the F10 table plus the HTTP-status
 * fallbacks. The module is pure, so it is compiled on the fly with esbuild
 * exactly like `test/block-id-helpers.test.js`.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let mapping;
let tmpFile;

/** Spec F10, rows top to bottom; 21 codes. */
const F10_TABLE = [
  ['missing_api_key', 'promptApiKey'],
  ['invalid_api_key', 'promptApiKey'],
  ['unauthorized', 'promptApiKey'],
  ['voice_not_found', 'reresolveVoice'],
  ['invalid_voice_id', 'reresolveVoice'],
  ['voice_access_denied', 'reresolveVoice'],
  ['model_not_found', 'resetModel'],
  ['model_access_denied', 'resetModel'],
  ['unsupported_model', 'resetModel'],
  ['text_too_long', 'rechunk'],
  ['text_too_short', 'ignore'],
  ['empty_text', 'ignore'],
  ['insufficient_credits', 'quota'],
  ['feature_not_available', 'showVerbatim'],
  ['subscription_required', 'showVerbatim'],
  ['rate_limit_exceeded', 'backoff'],
  ['system_busy', 'backoff'],
  ['concurrent_limit_exceeded', 'backoff'],
  ['internal_error', 'serverError'],
  ['service_unavailable', 'serverError'],
  ['maintenance', 'serverError'],
];

function info(overrides) {
  return Object.assign(
    { status: 400, type: '', code: '', message: 'boom' },
    overrides,
  );
}

suite('read-aloud/error-mapping', function () {
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
          'error-mapping.ts',
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
    tmpFile = path.join(__dirname, '.error-mapping.bundle.cjs');
    fs.writeFileSync(tmpFile, result.outputFiles[0].text);
    mapping = require(tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  // T-10
  suite('T-10 every F10 code maps to its action', function () {
    test('the table covers all 21 documented codes', function () {
      assert.strictEqual(F10_TABLE.length, 21);
      assert.strictEqual(new Set(F10_TABLE.map((row) => row[0])).size, 21);
    });

    for (const [code, kind] of F10_TABLE) {
      test(`${code} -> ${kind}`, function () {
        const action = mapping.mapErrorToAction(info({ code }));
        assert.strictEqual(
          action.kind,
          kind,
          `${code} mapped to ${action.kind}`,
        );
      });
    }

    test('backoff carries the 1s / 2s / 4s delays', function () {
      assert.deepStrictEqual(mapping.RETRY_BACKOFF_MS, [1000, 2000, 4000]);
      const action = mapping.mapErrorToAction(
        info({ code: 'rate_limit_exceeded' }),
      );
      assert.deepStrictEqual(action.delaysMs, [1000, 2000, 4000]);
    });

    test('HTTP fallbacks apply when the body carries no code', function () {
      assert.strictEqual(
        mapping.mapErrorToAction(info({ status: 401 })).kind,
        'promptApiKey',
      );
      assert.strictEqual(
        mapping.mapErrorToAction(info({ status: 402 })).kind,
        'quota',
      );
      assert.strictEqual(
        mapping.mapErrorToAction(info({ status: 429 })).kind,
        'backoff',
      );
      assert.strictEqual(
        mapping.mapErrorToAction(info({ status: 500 })).kind,
        'serverError',
      );
      assert.strictEqual(
        mapping.mapErrorToAction(info({ status: 503 })).kind,
        'serverError',
      );
      assert.strictEqual(
        mapping.mapErrorToAction(info({ status: 599 })).kind,
        'serverError',
      );
    });

    test('status 0 is a transport failure, anything else is unknown', function () {
      assert.strictEqual(
        mapping.mapErrorToAction(info({ status: 0 })).kind,
        'network',
      );
      assert.strictEqual(
        mapping.mapErrorToAction(
          info({ code: mapping.NETWORK_ERROR_CODE, status: 0 }),
        ).kind,
        'network',
      );
      assert.strictEqual(
        mapping.mapErrorToAction(info({ status: 400 })).kind,
        'unknown',
      );
      assert.strictEqual(
        mapping.mapErrorToAction(info({ status: 404 })).kind,
        'unknown',
      );
      assert.strictEqual(
        mapping.mapErrorToAction(info({ status: 400, code: 'brand_new_code' }))
          .kind,
        'unknown',
      );
    });

    test('the code wins over the HTTP status', function () {
      assert.strictEqual(
        mapping.mapErrorToAction(info({ status: 429, code: 'text_too_long' }))
          .kind,
        'rechunk',
      );
    });

    test('the 30 s timeout constant is exported', function () {
      assert.strictEqual(mapping.TIMEOUT_MS, 30000);
    });
  });

  // T-11
  suite('T-11 parsing, messages, retryability and silent codes', function () {
    test('parseElevenLabsError reads a full { detail: { … } } body', function () {
      const parsed = mapping.parseElevenLabsError(400, {
        detail: {
          type: 'validation_error',
          code: 'invalid_parameters',
          message:
            "The 'keyterms' parameter is only supported with 'scribe_v2'.",
          status: 'invalid_parameters',
          request_id: '3c807fc4c3a1705f9638ecc764a91c01',
          param: 'keyterms',
        },
      });
      assert.deepStrictEqual(parsed, {
        status: 400,
        type: 'validation_error',
        code: 'invalid_parameters',
        message: "The 'keyterms' parameter is only supported with 'scribe_v2'.",
        requestId: '3c807fc4c3a1705f9638ecc764a91c01',
        param: 'keyterms',
      });
    });

    test('parseElevenLabsError reads a { detail: "string" } body', function () {
      const parsed = mapping.parseElevenLabsError(422, {
        detail: 'Unprocessable entity',
      });
      assert.strictEqual(parsed.message, 'Unprocessable entity');
      assert.strictEqual(parsed.code, '');
      assert.strictEqual(parsed.type, '');
      assert.strictEqual(parsed.status, 422);
      assert.strictEqual(parsed.requestId, undefined);
    });

    test('parseElevenLabsError copes with non-JSON and missing bodies', function () {
      const html = mapping.parseElevenLabsError(
        502,
        '<html>bad gateway</html>',
      );
      assert.strictEqual(html.message, '<html>bad gateway</html>');
      assert.strictEqual(html.code, '');

      const none = mapping.parseElevenLabsError(500, undefined);
      assert.strictEqual(
        none.message,
        'ElevenLabs request failed with status 500.',
      );

      const withFallback = mapping.parseElevenLabsError(
        500,
        undefined,
        'fallback text',
      );
      assert.strictEqual(withFallback.message, 'fallback text');

      const weird = mapping.parseElevenLabsError(500, { detail: 42 });
      assert.strictEqual(
        weird.message,
        'ElevenLabs request failed with status 500.',
      );

      const nonNumeric = mapping.parseElevenLabsError(Number.NaN, undefined);
      assert.strictEqual(nonNumeric.status, 0);
    });

    test('parseElevenLabsError never throws on hostile input', function () {
      for (const body of [
        null,
        [],
        0,
        true,
        { detail: null },
        { detail: [] },
      ]) {
        assert.doesNotThrow(() => mapping.parseElevenLabsError(400, body));
      }
    });

    test('userMessageFor produces the exact quota string', function () {
      const parsed = mapping.parseElevenLabsError(402, {
        detail: { code: 'insufficient_credits', message: 'no credits' },
      });
      const action = mapping.mapErrorToAction(parsed);
      assert.strictEqual(
        mapping.userMessageFor(parsed, action, { used: 9500, limit: 10000 }),
        'ElevenLabs quota exhausted (9500/10000).',
      );
      assert.strictEqual(
        mapping.userMessageFor(parsed, action),
        'ElevenLabs quota exhausted.',
      );
    });

    test('userMessageFor includes the request id for server errors', function () {
      const parsed = mapping.parseElevenLabsError(500, {
        detail: {
          code: 'internal_error',
          message: 'boom',
          request_id: 'req-42',
        },
      });
      assert.strictEqual(
        mapping.userMessageFor(parsed, mapping.mapErrorToAction(parsed)),
        'ElevenLabs error: boom (request id req-42)',
      );
      const noId = mapping.parseElevenLabsError(500, {
        detail: { code: 'internal_error', message: 'boom' },
      });
      assert.strictEqual(
        mapping.userMessageFor(noId, mapping.mapErrorToAction(noId)),
        'ElevenLabs error: boom',
      );
    });

    test('userMessageFor covers every remaining action', function () {
      const base = info({ message: 'verbatim message' });
      assert.strictEqual(
        mapping.userMessageFor(base, { kind: 'network' }),
        'Could not reach ElevenLabs.',
      );
      assert.strictEqual(
        mapping.userMessageFor(base, { kind: 'promptApiKey' }),
        'ElevenLabs API key missing or invalid.',
      );
      assert.strictEqual(
        mapping.userMessageFor(base, { kind: 'reresolveVoice' }),
        'ElevenLabs voice unavailable; resolving a default voice.',
      );
      assert.strictEqual(
        mapping.userMessageFor(base, { kind: 'resetModel' }),
        'ElevenLabs model unavailable; reset to eleven_multilingual_v2.',
      );
      assert.strictEqual(
        mapping.userMessageFor(base, { kind: 'rechunk' }),
        'Text too long for one request; splitting.',
      );
      assert.strictEqual(mapping.userMessageFor(base, { kind: 'ignore' }), '');
      assert.strictEqual(
        mapping.userMessageFor(base, { kind: 'showVerbatim' }),
        'verbatim message',
      );
      assert.strictEqual(
        mapping.userMessageFor(base, { kind: 'unknown' }),
        'verbatim message',
      );
    });

    test('isRetryable is true only for backoff, network and serverError', function () {
      assert.strictEqual(
        mapping.isRetryable({
          kind: 'backoff',
          delaysMs: mapping.RETRY_BACKOFF_MS,
        }),
        true,
      );
      assert.strictEqual(mapping.isRetryable({ kind: 'network' }), true);
      assert.strictEqual(mapping.isRetryable({ kind: 'serverError' }), true);
      for (const kind of [
        'promptApiKey',
        'reresolveVoice',
        'resetModel',
        'rechunk',
        'ignore',
        'quota',
        'showVerbatim',
        'unknown',
      ]) {
        assert.strictEqual(mapping.isRetryable({ kind }), false, kind);
      }
    });

    test('SILENT_CODES holds exactly the six codes with no inline UI', function () {
      assert.strictEqual(mapping.SILENT_CODES.size, 6);
      for (const code of [
        'text_too_short',
        'empty_text',
        'cancelled',
        'insufficient_credits',
        'feature_not_available',
        'subscription_required',
      ]) {
        assert.ok(mapping.SILENT_CODES.has(code), code);
      }
      for (const code of [
        'text_too_long',
        'network_error',
        'invalid_request',
        'unauthorized',
      ]) {
        assert.ok(!mapping.SILENT_CODES.has(code), code);
      }
      assert.strictEqual(mapping.CANCELLED_CODE, 'cancelled');
      assert.strictEqual(mapping.NETWORK_ERROR_CODE, 'network_error');
    });
  });
  // Kokoro provider: `kokoroErrorInfo` + `mapKokoroErrorToAction`.
  test('kokoroErrorInfo: transport failure is a provider-tagged network error', function () {
    const kinfo = mapping.kokoroErrorInfo(0, {
      message:
        'Could not reach the Kokoro server at http://127.0.0.1:8880. Start it and try again.',
    });
    assert.strictEqual(kinfo.provider, 'kokoro');
    assert.strictEqual(kinfo.status, 0);
    assert.strictEqual(kinfo.code, 'network_error');
    assert.strictEqual(kinfo.type, 'network');
    assert.deepStrictEqual(mapping.mapKokoroErrorToAction(kinfo), {
      kind: 'network',
    });
    assert.strictEqual(
      mapping.userMessageFor(kinfo, mapping.mapKokoroErrorToAction(kinfo)),
      'Could not reach the Kokoro server at http://127.0.0.1:8880. Start it and try again.',
    );
  });

  test('kokoroErrorInfo: "no speakable text" is the silent empty_text', function () {
    const kinfo = mapping.kokoroErrorInfo(400, {
      error: 'validation_error',
      message: 'Input contains no speakable text',
      type: 'invalid_request_error',
    });
    assert.strictEqual(kinfo.code, 'empty_text');
    assert.deepStrictEqual(mapping.mapKokoroErrorToAction(kinfo), {
      kind: 'ignore',
    });
    assert.ok(mapping.SILENT_CODES.has(kinfo.code));
  });

  test('kokoroErrorInfo: an unknown voice gets a short message, shown verbatim', function () {
    const kinfo = mapping.kokoroErrorInfo(400, {
      error: 'validation_error',
      message:
        "Voice 'xx_nope' not found. Available voices: af_alloy, af_aoede, af_bella",
      type: 'invalid_request_error',
    });
    assert.strictEqual(kinfo.code, 'voice_not_found');
    assert.strictEqual(
      kinfo.message,
      'Kokoro voice \'xx_nope\' not found. Run "Choose Read Aloud Voice" to pick one.',
    );
    const action = mapping.mapKokoroErrorToAction(kinfo);
    assert.deepStrictEqual(action, { kind: 'unknown' });
    assert.strictEqual(mapping.userMessageFor(kinfo, action), kinfo.message);
  });

  test('kokoroErrorInfo: 5xx is a retryable server error with a Kokoro message, 429 backs off', function () {
    const server = mapping.kokoroErrorInfo(500, {
      error: 'processing_error',
      message: 'Failed to generate audio',
      type: 'server_error',
    });
    assert.deepStrictEqual(mapping.mapKokoroErrorToAction(server), {
      kind: 'serverError',
    });
    assert.strictEqual(
      mapping.userMessageFor(server, { kind: 'serverError' }),
      'Kokoro server error: Failed to generate audio',
    );
    const busy = mapping.kokoroErrorInfo(429, { message: 'Too many requests' });
    assert.strictEqual(mapping.mapKokoroErrorToAction(busy).kind, 'backoff');
    const missing = mapping.kokoroErrorInfo(404, {});
    assert.strictEqual(
      missing.message,
      'Kokoro request failed with status 404.',
    );
    assert.deepStrictEqual(mapping.mapKokoroErrorToAction(missing), {
      kind: 'unknown',
    });
  });

  test('ElevenLabs messages are unchanged when no provider is set', function () {
    assert.strictEqual(
      mapping.userMessageFor(info({ status: 0 }), { kind: 'network' }),
      'Could not reach ElevenLabs.',
    );
    assert.strictEqual(
      mapping.userMessageFor(info({ status: 500, message: 'down' }), {
        kind: 'serverError',
      }),
      'ElevenLabs error: down',
    );
  });
});
