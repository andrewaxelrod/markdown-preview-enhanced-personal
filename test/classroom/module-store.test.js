/* global suite, test, suiteSetup, suiteTeardown, setup, teardown */

/**
 * `src/classroom/module-store.ts` (`featrues/13-classroom/spec.md` §11): the
 * layout under a temp root, `isModulePath` and `moduleAt`, atomic writes with
 * no `.tmp` left behind, per-file serialisation, the list order, unreadable
 * files counted, the `listAll` cap and `personaDirs`.
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('path');
const fs = require('fs');
const { compileEntry } = require('./compile');

let store;
let format;
let tmpFiles = [];
let root;

const KEY = { folder: 'markdown-viewer', document: 'test-file.md' };

function moduleOf(id, overrides) {
  const base = {
    id,
    created: `2026-09-05T17:${id.slice(11, 13)}:10Z`,
    updated: `2026-09-05T17:${id.slice(11, 13)}:10Z`,
    finished: null,
    status: 'planning',
    stoppedAt: null,
    error: null,
    persona: { id: 'max', name: 'Max', version: 1 },
    level: 2,
    readerNote: '',
    audience: 'a reader',
    engine: { engine: 'claude', model: 'sonnet', effort: 'medium', prompt: 1 },
    document: {
      workspace: 'markdown-viewer',
      path: 'test-file.md',
      absolute: '/x/test-file.md',
      title: 'Doc',
      headings: [],
      headingId: null,
      words: 100,
      git: { remote: '', commit: '' },
      linked: [],
    },
    passage: {
      exact: 'Then the human path walks.',
      block: 'b1',
      line: 3,
      prefix: '',
      suffix: '',
      offset: 0,
      blocks: 1,
    },
    plan: null,
    chapters: [],
    ledger: { promises: [], examples: [], terms: [], analogies: [] },
    unknown: {},
    body: '',
  };
  const merged = Object.assign(base, overrides || {});
  merged.body =
    merged.body ||
    format.initialBody(merged, '/x/modules/markdown-viewer/test-file.md');
  return merged;
}

suite('classroom/module-store', function () {
  this.timeout(30000);

  suiteSetup(async function () {
    const a = path.join(__dirname, '.module-store.bundle.cjs');
    const b = path.join(__dirname, '.module-store-format.bundle.cjs');
    tmpFiles = [a, b];
    store = await compileEntry('src/classroom/module-store.ts', a);
    format = await compileEntry('src/classroom/module-format.ts', b);
  });

  suiteTeardown(function () {
    for (const file of tmpFiles) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  });

  let logs;
  let s;

  setup(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-classroom-store-'));
    logs = [];
    let hex = 0x1000;
    s = new store.ModuleStore({
      root,
      log: (line) => logs.push(line),
      now: () => new Date('2026-09-05T17:30:10Z'),
      randomHex: () => (hex++).toString(16),
    });
  });

  teardown(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('layout: modules and personas side by side under the root', async function () {
    assert.strictEqual(s.modulesRoot, path.join(root, 'modules'));
    assert.strictEqual(s.personasRoot, path.join(root, 'personas'));
    assert.strictEqual(
      s.documentDir(KEY),
      path.join(root, 'modules', 'markdown-viewer', 'test-file.md'),
    );
    const id = s.newId();
    assert.strictEqual(id, '20260905T173010Z-1000');
    const record = await s.create(KEY, moduleOf(id));
    assert.strictEqual(
      record.filePath,
      path.join(s.documentDir(KEY), `${id}-then-the-human.md`),
    );
    assert.ok(fs.existsSync(record.filePath));
    assert.deepStrictEqual(
      fs.readdirSync(s.documentDir(KEY)).filter((n) => n.endsWith('.tmp')),
      [],
      'no .tmp left behind',
    );
    assert.deepStrictEqual(record.key, KEY);
  });

  test('isModulePath, keyOf and moduleAt recognise a module file and nothing else', async function () {
    const id = s.newId();
    const record = await s.create(KEY, moduleOf(id));
    assert.strictEqual(s.isModulePath(record.filePath), true);
    assert.strictEqual(
      s.isModulePath(path.join(root, 'personas', 'max', 'persona.md')),
      false,
    );
    assert.strictEqual(
      s.isModulePath(
        path.join(
          root,
          'modules',
          'markdown-viewer',
          'test-file.md',
          'notes.md',
        ),
      ),
      false,
      'no id prefix',
    );
    assert.strictEqual(
      s.isModulePath('/elsewhere/20260905T173010Z-1000.md'),
      false,
    );
    assert.deepStrictEqual(s.keyOf(record.filePath), KEY);
    const nested = await s.create(
      { folder: 'ws', document: 'a/b/c.md' },
      moduleOf(s.newId()),
    );
    assert.deepStrictEqual(s.keyOf(nested.filePath), {
      folder: 'ws',
      document: 'a/b/c.md',
    });
    const at = s.moduleAt(record.filePath);
    assert.ok(at);
    assert.strictEqual(at.id, id);
    assert.deepStrictEqual(at.key, KEY);
    assert.strictEqual(s.moduleAt('/nowhere.md'), null);
  });

  test('update re-reads the file first and serialises concurrent rewrites', async function () {
    const id = s.newId();
    const record = await s.create(KEY, moduleOf(id));
    // A hand edit of the body between writes survives.
    const text = fs.readFileSync(record.filePath, 'utf8');
    fs.writeFileSync(
      record.filePath,
      text.replace(/\n$/, '\nA hand-written line.\n'),
    );
    const updated = await s.update(KEY, id, (m) => ({
      ...m,
      status: 'writing',
    }));
    assert.strictEqual(updated.status, 'writing');
    assert.ok(updated.body.endsWith('A hand-written line.\n'));
    // Ten appends at once, none lost.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        s.update(KEY, id, (m) => ({ ...m, body: m.body + `\nline ${i}\n` })),
      ),
    );
    const final = s.get(KEY, id);
    for (let i = 0; i < 10; i++) {
      assert.ok(final.body.includes(`line ${i}`), `line ${i}`);
    }
    assert.deepStrictEqual(
      fs.readdirSync(s.documentDir(KEY)).filter((n) => n.endsWith('.tmp')),
      [],
    );
    // null leaves the file alone.
    const before = fs.statSync(record.filePath).mtimeMs;
    await s.update(KEY, id, () => null);
    assert.strictEqual(fs.statSync(record.filePath).mtimeMs, before);
  });

  test('a missing module is a ModuleMissingError; an unreadable one a ModuleUnreadableError', async function () {
    await assert.rejects(
      s.update(KEY, '20260905T000000Z-dead', (m) => m),
      (error) => error.name === 'ModuleMissingError',
    );
    const id = s.newId();
    const record = await s.create(KEY, moduleOf(id));
    fs.writeFileSync(record.filePath, 'not a module');
    await assert.rejects(
      s.update(KEY, id, (m) => m),
      (error) => error.name === 'ModuleUnreadableError',
    );
    assert.strictEqual(
      fs.readFileSync(record.filePath, 'utf8'),
      'not a module',
      'left alone',
    );
    assert.strictEqual(s.get(KEY, id), null);
  });

  test('list is newest first and counts unreadable files apart; listAll walks the tree and caps', async function () {
    const a = await s.create(KEY, moduleOf('20260905T170010Z-0001'));
    const b = await s.create(KEY, moduleOf('20260905T170510Z-0002'));
    fs.writeFileSync(
      path.join(s.documentDir(KEY), '20260905T171010Z-0003-broken.md'),
      'broken',
    );
    fs.writeFileSync(
      path.join(s.documentDir(KEY), 'README.md'),
      'not a module',
    );
    const listing = s.list(KEY);
    assert.deepStrictEqual(
      listing.modules.map((m) => m.id),
      [b.id, a.id],
    );
    assert.strictEqual(listing.unreadable.length, 1);
    assert.ok(logs.some((line) => /1 unreadable module file/.test(line)));
    await s.create(
      { folder: 'other', document: 'deep/doc.md' },
      moduleOf('20260905T172010Z-0004'),
    );
    const all = s.listAll();
    assert.deepStrictEqual(
      all.modules.map((m) => m.id),
      ['20260905T172010Z-0004', b.id, a.id],
    );
    assert.strictEqual(all.truncated, false);
    assert.deepStrictEqual(all.modules[0].key, {
      folder: 'other',
      document: 'deep/doc.md',
    });
    assert.strictEqual(
      s.list({ folder: 'nobody', document: 'x.md' }).modules.length,
      0,
    );
    assert.strictEqual(store.LIST_ALL_CAP, 500);
  });

  test('a module that failed (a string error) is still found, read and updated', async function () {
    const id = s.newId();
    await s.create(
      KEY,
      moduleOf(id, {
        status: 'failed',
        stoppedAt: 1,
        error: 'claude exited with code 1',
      }),
    );
    const record = s.get(KEY, id);
    assert.ok(record, 'get finds it');
    assert.strictEqual(record.error, 'claude exited with code 1');
    assert.ok(s.moduleAt(record.filePath), 'moduleAt finds it');
    const continued = await s.update(KEY, id, (m) => ({
      ...m,
      status: 'writing',
      error: null,
    }));
    assert.strictEqual(continued.status, 'writing');
    assert.strictEqual(s.list(KEY).unreadable.length, 0);
  });

  test('personaDirs lists folders holding a persona.md, with the optional specimen', function () {
    assert.deepStrictEqual(s.personaDirs(), []);
    fs.mkdirSync(path.join(root, 'personas', 'ada'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'personas', 'ada', 'persona.md'),
      '---\nid: ada\n---\nbody',
    );
    fs.mkdirSync(path.join(root, 'personas', 'max'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'personas', 'max', 'persona.md'),
      '---\nid: max\n---\nbody',
    );
    fs.writeFileSync(path.join(root, 'personas', 'max', 'specimen.md'), 'spec');
    fs.mkdirSync(path.join(root, 'personas', 'empty'), { recursive: true });
    fs.writeFileSync(path.join(root, 'personas', 'stray.md'), 'x');
    const dirs = s.personaDirs();
    assert.deepStrictEqual(
      dirs.map((d) => [
        d.id,
        path.basename(d.personaFile),
        d.specimenFile ? path.basename(d.specimenFile) : null,
      ]),
      [
        ['ada', 'persona.md', null],
        ['max', 'persona.md', 'specimen.md'],
      ],
    );
  });
});
