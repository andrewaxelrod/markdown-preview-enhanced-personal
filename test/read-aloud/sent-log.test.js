/* global suite, test, suiteSetup, suiteTeardown */

/**
 * T-31 — `src/read-aloud/sent-log.ts`: the one-line-per-request record of
 * what is sent to ElevenLabs. Node `fs` only, so it is compiled on the fly
 * with esbuild and exercised against a temp directory.
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let sentLog;
let tmpFile;
let dir;

suite('read-aloud/sent-log', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    const result = await esbuild.build({
      entryPoints: [
        path.join(__dirname, '..', '..', 'src', 'read-aloud', 'sent-log.ts'),
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      external: ['vscode', 'crossnote'],
    });
    tmpFile = path.join(__dirname, '.sent-log.bundle.cjs');
    fs.writeFileSync(tmpFile, result.outputFiles[0].text);
    sentLog = require(tmpFile);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-ra-sent-'));
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T-31 the file is logs/read-aloud-sent.log under the base directory', function () {
    assert.strictEqual(
      sentLog.SENT_LOG_RELATIVE_PATH,
      path.join('logs', 'read-aloud-sent.log'),
    );
    assert.strictEqual(
      sentLog.sentLogPath('/base'),
      path.join('/base', 'logs', 'read-aloud-sent.log'),
    );
  });

  test('T-31 creates the directory and appends one line per sent text', async function () {
    const base = path.join(dir, 'ws');
    await sentLog.appendSentText(base, 'First chunk, sent as is.');
    await sentLog.appendSentText(base, 'Second chunk.');
    const file = sentLog.sentLogPath(base);
    assert.strictEqual(
      fs.readFileSync(file, 'utf8'),
      'First chunk, sent as is.\nSecond chunk.\n',
    );
  });

  test('T-31 line breaks inside a text are flattened so each request stays on one line', async function () {
    const base = path.join(dir, 'lines');
    await sentLog.appendSentText(base, 'one\ntwo\r\nthree');
    assert.strictEqual(
      fs.readFileSync(sentLog.sentLogPath(base), 'utf8'),
      'one two three\n',
    );
  });

  test('T-31 a base that cannot hold a directory is ignored, never thrown', async function () {
    const blocked = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocked, 'x');
    await assert.doesNotReject(sentLog.appendSentText(blocked, 'text'));
  });
});
