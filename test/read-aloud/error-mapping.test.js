/* global suite, test, suiteSetup, suiteTeardown */

/**
 * T-10, T-11 — `src/read-aloud/error-mapping.ts` (F10).
 *
 * Every failure shape Kokoro-FastAPI produces, plus the transport cases, maps
 * to one user-facing action. The module is pure, so it is compiled on the fly
 * with esbuild exactly like `test/block-id-helpers.test.js`.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let mapping;
let tmpFile;

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
  suite('T-10 the action table', function () {
    test('a transport failure is a network error with the client message', function () {
      const info = mapping.kokoroErrorInfo(0, {
        message:
          'Could not reach the Kokoro server at http://127.0.0.1:8880. Start it and try again.',
      });
      assert.strictEqual(info.status, 0);
      assert.strictEqual(info.code, 'network_error');
      assert.strictEqual(info.type, 'network');
      assert.deepStrictEqual(mapping.mapKokoroErrorToAction(info), {
        kind: 'network',
      });
      assert.strictEqual(
        mapping.userMessageFor(info, mapping.mapKokoroErrorToAction(info)),
        'Could not reach the Kokoro server at http://127.0.0.1:8880. Start it and try again.',
      );
      assert.strictEqual(
        mapping.mapKokoroErrorToAction({
          status: 400,
          type: '',
          code: mapping.NETWORK_ERROR_CODE,
          message: 'x',
        }).kind,
        'network',
        'the code alone is enough',
      );
    });

    test('"no speakable text" is the silent empty_text', function () {
      const info = mapping.kokoroErrorInfo(400, {
        error: 'validation_error',
        message: 'Input contains no speakable text',
        type: 'invalid_request_error',
      });
      assert.strictEqual(info.code, 'empty_text');
      assert.deepStrictEqual(mapping.mapKokoroErrorToAction(info), {
        kind: 'ignore',
      });
      assert.ok(mapping.SILENT_CODES.has(info.code));
      assert.strictEqual(mapping.userMessageFor(info, { kind: 'ignore' }), '');
    });

    test('an unknown voice gets a short message, shown verbatim', function () {
      const info = mapping.kokoroErrorInfo(400, {
        error: 'validation_error',
        message:
          "Voice 'xx_nope' not found. Available voices: af_alloy, af_aoede, af_bella",
        type: 'invalid_request_error',
      });
      assert.strictEqual(info.code, 'voice_not_found');
      assert.strictEqual(
        info.message,
        'Kokoro voice \'xx_nope\' not found. Run "Choose Read Aloud Voice" to pick one.',
      );
      const action = mapping.mapKokoroErrorToAction(info);
      assert.deepStrictEqual(action, { kind: 'unknown' });
      assert.strictEqual(mapping.userMessageFor(info, action), info.message);
    });

    test('5xx is a retryable server error with a Kokoro message', function () {
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
      assert.strictEqual(
        mapping.mapKokoroErrorToAction(mapping.kokoroErrorInfo(503, {})).kind,
        'serverError',
      );
      assert.strictEqual(
        mapping.mapKokoroErrorToAction(mapping.kokoroErrorInfo(599, {})).kind,
        'serverError',
      );
    });

    test('429 backs off with the 1s / 2s / 4s delays', function () {
      assert.deepStrictEqual(mapping.RETRY_BACKOFF_MS, [1000, 2000, 4000]);
      const busy = mapping.kokoroErrorInfo(429, {
        message: 'Too many requests',
      });
      const action = mapping.mapKokoroErrorToAction(busy);
      assert.strictEqual(action.kind, 'backoff');
      assert.deepStrictEqual(action.delaysMs, [1000, 2000, 4000]);
      assert.strictEqual(
        mapping.userMessageFor(busy, action),
        'Too many requests',
      );
    });

    test('any other status is unknown and shown verbatim', function () {
      const missing = mapping.kokoroErrorInfo(404, {});
      assert.strictEqual(
        missing.message,
        'Kokoro request failed with status 404.',
      );
      assert.deepStrictEqual(mapping.mapKokoroErrorToAction(missing), {
        kind: 'unknown',
      });
      assert.strictEqual(
        mapping.userMessageFor(missing, { kind: 'unknown' }),
        missing.message,
      );
      const other = mapping.kokoroErrorInfo(400, {
        error: 'validation_error',
        message: 'speed must be between 0.25 and 4',
        type: 'invalid_request_error',
      });
      assert.strictEqual(other.code, 'validation_error');
      assert.strictEqual(other.type, 'invalid_request_error');
      assert.strictEqual(mapping.mapKokoroErrorToAction(other).kind, 'unknown');
    });

    test('kokoroErrorInfo never throws on a non-numeric status or empty detail', function () {
      const info = mapping.kokoroErrorInfo(Number.NaN, {});
      assert.strictEqual(info.status, 0);
      assert.strictEqual(info.code, 'network_error');
      assert.strictEqual(info.message, 'Kokoro request failed with status 0.');
    });
  });

  // T-11
  suite('T-11 retryability and silent codes', function () {
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
      assert.strictEqual(mapping.isRetryable({ kind: 'ignore' }), false);
      assert.strictEqual(mapping.isRetryable({ kind: 'unknown' }), false);
    });

    test('SILENT_CODES holds exactly the two codes with no inline UI', function () {
      assert.strictEqual(mapping.SILENT_CODES.size, 2);
      assert.ok(mapping.SILENT_CODES.has('empty_text'));
      assert.ok(mapping.SILENT_CODES.has('cancelled'));
      for (const code of [
        'network_error',
        'invalid_request',
        'voice_not_found',
        'rate_limit_exceeded',
      ]) {
        assert.ok(!mapping.SILENT_CODES.has(code), code);
      }
      assert.strictEqual(mapping.CANCELLED_CODE, 'cancelled');
      assert.strictEqual(mapping.NETWORK_ERROR_CODE, 'network_error');
    });
  });
});
