/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

/**
 * `src/read-aloud/kokoro-client.ts` — the Kokoro-FastAPI transport.
 *
 * Driven through a stubbed `fetchImpl`; no request ever leaves the test. The
 * module has no `vscode` import, so it is compiled on the fly with esbuild
 * like `test/read-aloud/chunker.test.js`.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let mod;
let tmpFile;

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Records the request and answers with `status` and a JSON `body`. */
function fetchRecording(status, body, calls) {
  return async function (url, init) {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(body)),
    };
  };
}

function fetchWithHangingBody(status) {
  return async function (_url, init) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(abortError()), {
            once: true,
          });
        }),
    };
  };
}

function fetchRefusing() {
  return async function () {
    const error = new TypeError('fetch failed');
    error.cause = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    throw error;
  };
}

function makeClient(fetchImpl, extra) {
  return new mod.KokoroClient(
    Object.assign({ baseUrl: 'http://127.0.0.1:8880/', fetchImpl }, extra),
  );
}

suite('read-aloud/kokoro-client', function () {
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
          'kokoro-client.ts',
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
    tmpFile = path.join(__dirname, '.kokoro-client.bundle.cjs');
    fs.writeFileSync(tmpFile, result.outputFiles[0].text);
    mod = require(tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  test('isAllowedKokoroBaseUrl: https anywhere, http on loopback only', function () {
    assert.strictEqual(
      mod.isAllowedKokoroBaseUrl('http://127.0.0.1:8880'),
      true,
    );
    assert.strictEqual(
      mod.isAllowedKokoroBaseUrl('http://localhost:8880'),
      true,
    );
    assert.strictEqual(mod.isAllowedKokoroBaseUrl('http://[::1]:8880'), true);
    assert.strictEqual(
      mod.isAllowedKokoroBaseUrl('https://tts.example.com'),
      true,
    );
    assert.strictEqual(
      mod.isAllowedKokoroBaseUrl('http://tts.example.com'),
      false,
    );
    assert.strictEqual(
      mod.isAllowedKokoroBaseUrl('http://192.168.1.10:8880'),
      false,
    );
    assert.strictEqual(mod.isAllowedKokoroBaseUrl('ftp://127.0.0.1'), false);
    assert.strictEqual(mod.isAllowedKokoroBaseUrl('not a url'), false);
    assert.strictEqual(mod.isAllowedKokoroBaseUrl(''), false);
  });

  test('describeKokoroVoice decodes language and gender, including blends', function () {
    assert.strictEqual(
      mod.describeKokoroVoice('af_heart'),
      'American English, female',
    );
    assert.strictEqual(
      mod.describeKokoroVoice('bm_george'),
      'British English, male',
    );
    assert.strictEqual(mod.describeKokoroVoice('jf_alpha'), 'Japanese, female');
    assert.strictEqual(
      mod.describeKokoroVoice('af_bella+af_sky'),
      'blend: American English, female',
    );
    assert.strictEqual(
      mod.describeKokoroVoice('af_bella+bm_lewis'),
      'blend: American English, female + British English, male',
    );
    assert.strictEqual(mod.describeKokoroVoice('custom'), '');
  });

  test('synthesize posts the non-streaming timestamped mp3 request with normalisation off', async function () {
    const calls = [];
    const c = makeClient(
      fetchRecording(
        200,
        {
          audio: 'QUJD',
          audio_format: 'audio/mpeg',
          timestamps: [
            { word: 'Hello', start_time: 0, end_time: 0.4 },
            { word: '.', start_time: 0.4, end_time: 0.5 },
          ],
        },
        calls,
      ),
    );
    const result = await c.synthesize({ voice: 'af_heart', text: 'Hello.' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      calls[0].url,
      'http://127.0.0.1:8880/dev/captioned_speech',
    );
    assert.strictEqual(calls[0].init.method, 'POST');
    assert.strictEqual(
      calls[0].init.headers['Content-Type'],
      'application/json',
    );
    assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
      model: 'kokoro',
      input: 'Hello.',
      voice: 'af_heart',
      speed: 1,
      response_format: 'mp3',
      stream: false,
      return_timestamps: true,
      normalization_options: { normalize: false },
    });
    assert.strictEqual(result.audioBase64, 'QUJD');
    assert.deepStrictEqual(result.words, [
      { word: 'Hello', start: 0, end: 0.4 },
      { word: '.', start: 0.4, end: 0.5 },
    ]);
    assert.strictEqual(result.meta.status, 200);
    assert.strictEqual(result.meta.requestId, null);
    assert.ok(typeof result.meta.durationMs === 'number');
  });

  test('synthesize refuses unspeakable text before any request (F5)', async function () {
    const calls = [];
    const c = makeClient(fetchRecording(200, { audio: 'QUJD' }, calls));
    await assert.rejects(
      c.synthesize({ voice: 'af_heart', text: 'see `code` **here**' }),
    );
    assert.strictEqual(calls.length, 0);
  });

  test('missing or malformed timestamps yield undefined words, and no audio is an error', async function () {
    const calls = [];
    let c = makeClient(fetchRecording(200, { audio: 'QUJD' }, calls));
    assert.strictEqual(
      (await c.synthesize({ voice: 'v', text: 'Hi' })).words,
      undefined,
    );
    c = makeClient(
      fetchRecording(
        200,
        {
          audio: 'QUJD',
          timestamps: [
            { word: 'x' },
            { word: 'y', start_time: '0', end_time: 1 },
          ],
        },
        calls,
      ),
    );
    assert.strictEqual(
      (await c.synthesize({ voice: 'v', text: 'Hi' })).words,
      undefined,
    );
    c = makeClient(fetchRecording(200, { audio: '', timestamps: [] }, calls));
    await assert.rejects(
      c.synthesize({ voice: 'v', text: 'Hi' }),
      /did not contain audio/,
    );
  });

  test('a 400 becomes a KokoroHttpError carrying the server detail', async function () {
    const c = makeClient(
      fetchRecording(
        400,
        {
          detail: {
            error: 'validation_error',
            message:
              "Voice 'xx_nope' not found. Available voices: af_alloy, af_heart",
            type: 'invalid_request_error',
          },
        },
        [],
      ),
    );
    await assert.rejects(
      c.synthesize({ voice: 'xx_nope', text: 'Hi' }),
      (error) =>
        error instanceof mod.KokoroHttpError &&
        error.status === 400 &&
        error.detail.error === 'validation_error' &&
        error.detail.type === 'invalid_request_error' &&
        /not found/.test(error.detail.message),
    );
  });

  test('parseKokoroError copes with a string detail, a bare string and nothing', function () {
    assert.deepStrictEqual(
      mod.parseKokoroError(500, { detail: 'boom' }, 'fallback'),
      {
        error: '',
        message: 'boom',
        type: '',
      },
    );
    assert.deepStrictEqual(
      mod.parseKokoroError(502, 'Bad Gateway', 'fallback'),
      {
        error: '',
        message: 'Bad Gateway',
        type: '',
      },
    );
    assert.deepStrictEqual(mod.parseKokoroError(503, undefined, 'fallback'), {
      error: '',
      message: 'fallback',
      type: '',
    });
  });

  test('a refused connection is a KokoroNetworkError naming the base URL', async function () {
    const c = makeClient(fetchRefusing());
    await assert.rejects(
      c.health(),
      (error) =>
        error instanceof mod.KokoroNetworkError &&
        error.timedOut === false &&
        error.baseUrl === 'http://127.0.0.1:8880' &&
        /Could not reach the Kokoro server at http:\/\/127\.0\.0\.1:8880/.test(
          error.message,
        ),
    );
  });

  test('the timeout firing while the body streams is a network timeout', async function () {
    const c = makeClient(fetchWithHangingBody(200), { timeoutMs: 20 });
    await assert.rejects(
      c.synthesize({ voice: 'v', text: 'Hello' }),
      (error) =>
        error instanceof mod.KokoroNetworkError && error.timedOut === true,
    );
  });

  test('the caller aborting while the body streams is a cancellation', async function () {
    const controller = new AbortController();
    const c = makeClient(fetchWithHangingBody(200), { timeoutMs: 10000 });
    const pending = c.listVoices(controller.signal);
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(
      pending,
      (error) => error instanceof mod.KokoroCancelledError,
    );
  });

  test('an already-aborted signal never issues the request', async function () {
    const calls = [];
    const controller = new AbortController();
    controller.abort();
    const c = makeClient(fetchRecording(200, { status: 'healthy' }, calls));
    await assert.rejects(c.health(controller.signal), mod.KokoroCancelledError);
    assert.strictEqual(calls.length, 0);
  });

  test('listVoices keeps ids and grades and drops malformed entries; health reports the status', async function () {
    const calls = [];
    let c = makeClient(
      fetchRecording(
        200,
        {
          voices: [
            { id: 'af_heart', name: 'af_heart', overall_grade: 'A' },
            { id: 'af_jadzia' },
            { name: 'no id' },
            null,
          ],
        },
        calls,
      ),
    );
    const { voices } = await c.listVoices();
    assert.strictEqual(calls[0].url, 'http://127.0.0.1:8880/v1/audio/voices');
    assert.strictEqual(calls[0].init.method, 'GET');
    assert.deepStrictEqual(voices, [
      { id: 'af_heart', grade: 'A' },
      { id: 'af_jadzia', grade: '' },
    ]);
    c = makeClient(fetchRecording(200, { status: 'healthy' }, calls));
    assert.strictEqual(await c.health(), 'healthy');
    assert.strictEqual(calls[1].url, 'http://127.0.0.1:8880/health');
  });
});
