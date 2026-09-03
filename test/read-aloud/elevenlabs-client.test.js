/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

/**
 * T-22 — `src/read-aloud/elevenlabs-client.ts` transport (F10, decision (k)).
 *
 * The 30 s timer and the caller's AbortSignal stay armed while the response
 * body streams, so an abort during `response.text()` must surface as the F10
 * `network` row (timeout) or as a cancellation — never as the generic
 * "response did not contain audio". The module has no `vscode` import, so it
 * is compiled on the fly with esbuild like `test/block-id-helpers.test.js`
 * and driven through a stubbed `fetchImpl`; no request ever leaves the test.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let client;
let tmpFile;

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * A fetch stub whose body read never settles on its own: it rejects with an
 * AbortError when the request signal fires, as undici does mid-stream.
 */
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

function fetchWithBody(status, body, failBody) {
  return async function () {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (name === 'request-id' ? 'req-1' : null) },
      text: () =>
        failBody
          ? Promise.reject(new Error('socket hang up'))
          : Promise.resolve(body),
    };
  };
}

function makeClient(fetchImpl, extra) {
  return new client.ElevenLabsClient(
    Object.assign(
      {
        baseUrl: 'https://example.invalid',
        apiKey: 'not-a-real-key',
        fetchImpl,
      },
      extra,
    ),
  );
}

suite('read-aloud/elevenlabs-client', function () {
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
          'elevenlabs-client.ts',
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
    tmpFile = path.join(__dirname, '.elevenlabs-client.bundle.cjs');
    fs.writeFileSync(tmpFile, result.outputFiles[0].text);
    client = require(tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  // T-22
  test('T-22 the timeout firing while the body streams is a network timeout, not "no audio"', async function () {
    const c = makeClient(fetchWithHangingBody(200), { timeoutMs: 20 });
    await assert.rejects(
      c.synthesizeWithTimestamps({
        voiceId: 'voice',
        modelId: 'eleven_multilingual_v2',
        text: 'Hello',
      }),
      (error) =>
        error instanceof client.ElevenLabsNetworkError &&
        error.timedOut === true,
    );
  });

  // T-22
  test('T-22 the caller aborting while the body streams is a cancellation', async function () {
    const controller = new AbortController();
    const c = makeClient(fetchWithHangingBody(200), { timeoutMs: 10000 });
    const pending = c.getSubscription(controller.signal);
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(
      pending,
      (error) => error instanceof client.ElevenLabsCancelledError,
    );
  });

  // T-22
  test('T-22 a body read failure on a 2xx is a network failure', async function () {
    const c = makeClient(fetchWithBody(200, '', true));
    await assert.rejects(
      c.listModels(),
      (error) =>
        error instanceof client.ElevenLabsNetworkError &&
        error.timedOut === false,
    );
  });

  // T-22
  test('T-22 a body read failure on a non-2xx still classifies by status', async function () {
    const c = makeClient(fetchWithBody(401, '', true));
    await assert.rejects(
      c.listModels(),
      (error) =>
        error instanceof client.ElevenLabsHttpError &&
        error.info.status === 401 &&
        error.meta.requestId === 'req-1',
    );
  });

  // T-22
  test('T-22 a complete 2xx body is parsed and the transport meta is kept', async function () {
    const body = JSON.stringify({
      audio_base64: 'QUJD',
      alignment: {
        characters: ['H', 'i'],
        character_start_times_seconds: [0, 0.1],
        character_end_times_seconds: [0.1, 0.2],
      },
      normalized_alignment: null,
    });
    const c = makeClient(fetchWithBody(200, body, false));
    const result = await c.synthesizeWithTimestamps({
      voiceId: 'voice',
      modelId: 'eleven_multilingual_v2',
      text: 'Hi',
    });
    assert.strictEqual(result.audioBase64, 'QUJD');
    assert.strictEqual(result.meta.status, 200);
    assert.strictEqual(result.meta.requestId, 'req-1');
    assert.ok(result.alignment, 'alignment parsed from `alignment`');
  });

  // T-22
  test('T-22 an already-aborted signal never issues a request', async function () {
    let calls = 0;
    const c = makeClient(async () => {
      calls++;
      throw new Error('unreachable');
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      c.listModels(controller.signal),
      (error) => error instanceof client.ElevenLabsCancelledError,
    );
    assert.strictEqual(calls, 0);
  });

  // T-30
  test('T-30 text with markdown residue or symbols never issues a request', async function () {
    let calls = 0;
    const c = makeClient(async () => {
      calls++;
      throw new Error('unreachable');
    });
    for (const params of [
      { text: '**bold** text' },
      { text: 'fine text', previousText: '# heading' },
      { text: 'fine text', nextText: '[x] done 🚀' },
    ]) {
      await assert.rejects(
        c.synthesizeWithTimestamps(
          Object.assign(
            { voiceId: 'voice', modelId: 'eleven_flash_v2_5' },
            params,
          ),
        ),
        (error) =>
          error instanceof Error &&
          /must not be sent to ElevenLabs/.test(error.message),
        JSON.stringify(params),
      );
    }
    assert.strictEqual(calls, 0);
  });
});
