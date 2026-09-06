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
  // ------------------------------------------------ §11.3–§11.4 watch, delete

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function fakeWatch() {
    const watchers = [];
    const watch = (dir, listener) => {
      const entry = { dir, listener, closed: false };
      watchers.push(entry);
      return {
        close() {
          entry.closed = true;
        },
      };
    };
    return { watch, watchers };
  }

  test('softDelete leaves the file for the window, then trashes it through the callback; undo keeps it', async function () {
    const trashed = [];
    const s = new store.ModuleStore({
      root,
      log: () => {},
      trash: async (filePath) => {
        trashed.push(filePath);
        fs.renameSync(filePath, filePath + '.trashed');
        return true;
      },
    });
    const a = await s.create(KEY, moduleOf('20260905T173010Z-0001'));
    const b = await s.create(KEY, moduleOf('20260905T173011Z-0002'));
    const done = s.softDelete(KEY, a.id, 40);
    assert.strictEqual(s.isDeleting(a.id), true);
    assert.deepStrictEqual(s.deletingIds(), [a.id]);
    assert.ok(fs.existsSync(a.filePath), 'still there for Undo');
    assert.strictEqual(await done, 'trash');
    assert.deepStrictEqual(trashed, [a.filePath]);
    assert.ok(!fs.existsSync(a.filePath));
    assert.strictEqual(s.isDeleting(a.id), false);
    const undo = s.softDelete(KEY, b.id, 200);
    assert.strictEqual(s.undoDelete(b.id), true);
    assert.strictEqual(await undo, 'undone');
    await sleep(250);
    assert.ok(fs.existsSync(b.filePath));
    assert.strictEqual(trashed.length, 1);
    assert.strictEqual(s.undoDelete(b.id), false);
  });

  test('no trash callback, or a refused one, deletes permanently; deleteNow skips the window', async function () {
    const logs = [];
    const s = new store.ModuleStore({
      root,
      log: (line) => logs.push(line),
      trash: async () => {
        throw new Error('EPERM: no trash here');
      },
    });
    const a = await s.create(KEY, moduleOf('20260905T173010Z-0001'));
    assert.strictEqual(await s.softDelete(KEY, a.id, 10), 'permanent');
    assert.ok(!fs.existsSync(a.filePath));
    assert.ok(logs.some((line) => line.includes('trash refused')));
    const bare = new store.ModuleStore({ root, log: () => {} });
    const b = await bare.create(KEY, moduleOf('20260905T173011Z-0002'));
    assert.strictEqual(await bare.deleteNow(KEY, b.id), 'permanent');
    assert.ok(!fs.existsSync(b.filePath));
    assert.strictEqual(await bare.deleteNow(KEY, b.id), 'missing');
  });

  test("the watcher debounces external changes and ignores the store's own writes and deletes", async function () {
    const fake = fakeWatch();
    const s = new store.ModuleStore({
      root,
      log: () => {},
      watch: fake.watch,
      trash: async (filePath) => {
        fs.rmSync(filePath);
        return true;
      },
    });
    const changes = [];
    const handle = s.watch(KEY, () => changes.push(1));
    assert.strictEqual(fake.watchers.length, 0, 'nothing to watch yet');
    const a = await s.create(KEY, moduleOf('20260905T173010Z-0001'));
    assert.strictEqual(fake.watchers.length, 1, 'attached on the first write');
    assert.strictEqual(fake.watchers[0].dir, s.documentDir(KEY));
    await s.update(KEY, a.id, (m) => ({ ...m, status: 'done' }));
    fake.watchers[0].listener('change', path.basename(a.filePath));
    await sleep(store.WATCH_DEBOUNCE_MS + 50);
    assert.strictEqual(changes.length, 0, 'own write not reported');
    fake.watchers[0].listener('change', '20260905T180000Z-aaaa-other.md');
    fake.watchers[0].listener('rename', '20260905T180000Z-aaaa-other.md');
    fake.watchers[0].listener('change', '20260905T180000Z-bbbb.md');
    await sleep(store.WATCH_DEBOUNCE_MS / 2);
    assert.strictEqual(changes.length, 0, 'inside the debounce');
    await sleep(store.WATCH_DEBOUNCE_MS);
    assert.strictEqual(changes.length, 1, 'one callback for three events');
    await s.softDelete(KEY, a.id, 10);
    fake.watchers[0].listener('rename', path.basename(a.filePath));
    await sleep(store.WATCH_DEBOUNCE_MS + 50);
    assert.strictEqual(changes.length, 1, 'the delete is our own');
    handle.dispose();
    assert.strictEqual(fake.watchers[0].closed, true);
    const refusing = new store.ModuleStore({
      root,
      log: (line) => changes.push(line),
      watch: () => {
        throw new Error('ENOSPC');
      },
    });
    fs.mkdirSync(refusing.documentDir(KEY), { recursive: true });
    refusing.watch(KEY, () => {}).dispose();
    assert.ok(
      changes.some(
        (c) => typeof c === 'string' && c.startsWith('classroom: watch failed'),
      ),
    );
  });
});
