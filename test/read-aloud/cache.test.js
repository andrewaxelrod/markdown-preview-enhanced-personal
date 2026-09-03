/* global suite, test, suiteSetup, suiteTeardown */

/**
 * T-13 — `src/read-aloud/cache.ts` (F12).
 *
 * The class takes its directory as a constructor argument precisely so it can
 * be exercised against a temp directory with no `vscode` runtime.
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let cacheModule;
let tmpFile;
let dir;

function entry(audioBase64, spans) {
  return {
    audioBase64,
    spans: spans === undefined ? null : spans,
    mimeType: 'audio/mpeg',
    createdAt: 1756684800000,
  };
}

function parts(overrides) {
  return Object.assign(
    {
      text: 'Hello world',
      voiceId: 'af_heart',
      modelId: 'kokoro',
    },
    overrides,
  );
}

function setMtime(key, msAgo) {
  const file = path.join(dir, `${key}.json`);
  const when = new Date(Date.now() - msAgo);
  fs.utimesSync(file, when, when);
}

suite('read-aloud/cache', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    const result = await esbuild.build({
      entryPoints: [
        path.join(__dirname, '..', '..', 'src', 'read-aloud', 'cache.ts'),
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      external: ['vscode', 'crossnote'],
    });
    tmpFile = path.join(__dirname, '.cache.bundle.cjs');
    fs.writeFileSync(tmpFile, result.outputFiles[0].text);
    cacheModule = require(tmpFile);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-ra-cache-'));
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  suite('T-13 cacheKey', function () {
    test('is a stable sha256 hex digest', function () {
      const key = cacheModule.cacheKey(parts());
      assert.match(key, /^[0-9a-f]{64}$/);
      assert.strictEqual(key, cacheModule.cacheKey(parts()));
    });

    test('changes with every one of the three parts', function () {
      const base = cacheModule.cacheKey(parts());
      const changed = [
        { text: 'Goodbye world' },
        { voiceId: 'bm_george' },
        { modelId: 'kokoro-v2' },
      ].map((override) => cacheModule.cacheKey(parts(override)));
      for (const key of changed) {
        assert.notStrictEqual(key, base);
      }
      assert.strictEqual(new Set(changed).size, 3);
    });

    test('is separator-sensitive, so shifted boundaries do not collide (B5)', function () {
      assert.strictEqual(cacheModule.CACHE_KEY_SEPARATOR, '\u001f');
      const left = cacheModule.cacheKey(parts({ text: 'ab', voiceId: 'c' }));
      const right = cacheModule.cacheKey(parts({ text: 'a', voiceId: 'bc' }));
      assert.notStrictEqual(left, right);
    });

    test('the cache directory name is the F12 one', function () {
      assert.strictEqual(cacheModule.CACHE_DIR_NAME, 'read-aloud-cache');
    });
  });

  suite('T-13 get / set', function () {
    test('round-trips an entry, spans included', function () {
      const cache = new cacheModule.ReadAloudCache(dir, 10 * 1024 * 1024);
      const key = cacheModule.cacheKey(parts({ text: 'round trip' }));
      const spans = [
        { text: 'round', charStart: 0, charEnd: 5, start: 0, end: 0.5 },
      ];
      cache.set(key, entry('QUJD', spans));
      assert.deepStrictEqual(cache.get(key), entry('QUJD', spans));
    });

    test('misses on an unknown key and on a malformed file', function () {
      const cache = new cacheModule.ReadAloudCache(dir, 10 * 1024 * 1024);
      const unknown = cacheModule.cacheKey(parts({ text: 'never stored' }));
      assert.strictEqual(cache.get(unknown), undefined);

      const broken = cacheModule.cacheKey(parts({ text: 'broken json' }));
      fs.writeFileSync(path.join(dir, `${broken}.json`), '{not json', 'utf8');
      assert.strictEqual(cache.get(broken), undefined);

      assert.strictEqual(cache.get('../escape'), undefined);
      assert.strictEqual(cache.get('zz'), undefined);
    });

    test('a hit touches the file mtime so LRU order follows use', function () {
      const cache = new cacheModule.ReadAloudCache(dir, 10 * 1024 * 1024);
      const key = cacheModule.cacheKey(parts({ text: 'touch me' }));
      cache.set(key, entry('QUJD'));
      setMtime(key, 60 * 60 * 1000);
      const before = fs.statSync(path.join(dir, `${key}.json`)).mtimeMs;
      assert.ok(cache.get(key));
      const after = fs.statSync(path.join(dir, `${key}.json`)).mtimeMs;
      assert.ok(after > before, `${after} should be newer than ${before}`);
    });

    test('sizeBytes reports the directory total', function () {
      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-ra-cache-'));
      try {
        const cache = new cacheModule.ReadAloudCache(fresh, 10 * 1024 * 1024);
        assert.strictEqual(cache.sizeBytes(), 0);
        const key = cacheModule.cacheKey(parts({ text: 'sized' }));
        cache.set(key, entry('QUJD'));
        assert.strictEqual(
          cache.sizeBytes(),
          fs.statSync(path.join(fresh, `${key}.json`)).size,
        );
      } finally {
        fs.rmSync(fresh, { recursive: true, force: true });
      }
    });
  });

  suite('T-13 LRU eviction and clear', function () {
    test('evicts the oldest entries once the cap is exceeded', function () {
      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-ra-cache-'));
      try {
        const cache = new cacheModule.ReadAloudCache(fresh, 10 * 1024 * 1024);
        const keys = ['oldest', 'middle', 'newest'].map((label) =>
          cacheModule.cacheKey(parts({ text: label })),
        );
        const payload = 'Q'.repeat(400);
        for (const key of keys) {
          cache.set(key, entry(payload));
        }
        const each = fs.statSync(path.join(fresh, `${keys[0]}.json`)).size;
        for (let i = 0; i < keys.length; i++) {
          const when = new Date(Date.now() - (keys.length - i) * 60000);
          fs.utimesSync(path.join(fresh, `${keys[i]}.json`), when, when);
        }

        // Cap at two entries, then write a fourth: the two oldest must go.
        cache.setMaxBytes(each * 2);
        assert.strictEqual(fs.readdirSync(fresh).length, 2);
        assert.strictEqual(cache.get(keys[0]), undefined);
        assert.ok(cache.get(keys[2]));

        const extra = cacheModule.cacheKey(parts({ text: 'extra' }));
        cache.set(extra, entry(payload));
        assert.strictEqual(fs.readdirSync(fresh).length, 2);
        assert.ok(cache.get(extra), 'the just-written entry is never evicted');
        assert.ok(cache.sizeBytes() <= each * 2);
      } finally {
        fs.rmSync(fresh, { recursive: true, force: true });
      }
    });

    test('clear removes every entry and returns the count', function () {
      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-ra-cache-'));
      try {
        const cache = new cacheModule.ReadAloudCache(fresh, 10 * 1024 * 1024);
        assert.strictEqual(cache.clear(), 0);
        for (const label of ['a', 'b', 'c']) {
          cache.set(
            cacheModule.cacheKey(parts({ text: label })),
            entry('QUJD'),
          );
        }
        fs.writeFileSync(
          path.join(fresh, 'not-a-cache-file.txt'),
          'keep me',
          'utf8',
        );
        assert.strictEqual(cache.clear(), 3);
        assert.deepStrictEqual(fs.readdirSync(fresh), ['not-a-cache-file.txt']);
      } finally {
        fs.rmSync(fresh, { recursive: true, force: true });
      }
    });

    test('a missing directory is a miss, not a throw', function () {
      const gone = path.join(os.tmpdir(), 'mpe-ra-cache-does-not-exist-12345');
      const cache = new cacheModule.ReadAloudCache(gone, 1024);
      assert.strictEqual(cache.get(cacheModule.cacheKey(parts())), undefined);
      assert.strictEqual(cache.sizeBytes(), 0);
      assert.strictEqual(cache.clear(), 0);
    });
  });
});
