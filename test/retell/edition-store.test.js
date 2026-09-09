/* global suite, test, suiteSetup, suiteTeardown, setup, teardown */

/**
 * `src/retell/edition-store.ts` (`featrues/15-convert-readable/spec.md`
 * §11): the layout under a temp root, `isEditionPath`, `keyOf` and
 * `editionAt`, atomic writes with no `.tmp` left behind, per-file
 * serialisation, the list order, unreadable files counted, the `listAll`
 * cap, an edition path is not a module path and vice versa, the soft delete
 * through an injected `trash()`, Undo, a refused trash, `deleteNow`, the
 * recent-writes filter and the watcher debounce with an injected `fs.watch`.
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('path');
const fs = require('fs');
const { compileEntry } = require('./compile');

let store;
let format;
let moduleStore;
let tmpFiles = [];
let root;

const KEY = {
  folder: 'job-prep',
  document: '___fractal___/courses/markdown/agent-ready-repos.md',
};

function editionOf(id, overrides) {
  const base = {
    id,
    created: `2026-09-07T10:${id.slice(11, 13)}:12Z`,
    updated: `2026-09-07T10:${id.slice(11, 13)}:12Z`,
    finished: null,
    status: 'planning',
    stoppedAt: null,
    error: null,
    shape: 'full',
    scope: 'selection',
    engine: { engine: 'claude', model: 'sonnet', effort: 'low', prompt: 1 },
    estimate: { sourceWords: 1246, words: 1740, minutes: 12, ceiling: 2243 },
    document: {
      workspace: 'job-prep',
      path: '___fractal___/courses/markdown/agent-ready-repos.md',
      absolute: '/x/agent-ready-repos.md',
      title: 'Agent-Ready Repos',
      headings: ['Agent-Ready Repos'],
      words: 4986,
      git: { remote: '', commit: '' },
    },
    sections: [
      {
        n: 1,
        heading: '7. Specs, ADRs, constitution',
        level: 2,
        line: 208,
        endLine: 377,
        words: 1246,
        codeWords: 349,
        tableWords: 242,
        hash: '3f9a1c2e5b7d0a41',
        status: 'queued',
        actual: null,
        flagged: [],
        ms: null,
        anchor: {
          exact: '7. Specs, ADRs, constitution',
          block: 'b7c1a904',
          line: 208,
          prefix: '',
          suffix: '',
          offset: 0,
          blocks: 1,
        },
      },
    ],
    unknown: {},
    body: '',
  };
  const merged = Object.assign(base, overrides || {});
  merged.body = merged.body || format.initialBody(merged);
  return merged;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('retell/edition-store', function () {
  this.timeout(30000);

  suiteSetup(async function () {
    const a = path.join(__dirname, '.edition-store.bundle.cjs');
    const b = path.join(__dirname, '.edition-store-format.bundle.cjs');
    const c = path.join(__dirname, '.edition-store-modules.bundle.cjs');
    tmpFiles = [a, b, c];
    store = await compileEntry('src/retell/edition-store.ts', a);
    format = await compileEntry('src/retell/edition-format.ts', b);
    moduleStore = await compileEntry('src/classroom/module-store.ts', c);
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-retell-store-'));
    logs = [];
    let hex = 0x1000;
    s = new store.EditionStore({
      root,
      log: (line) => logs.push(line),
      now: () => new Date('2026-09-07T10:45:12Z'),
      randomHex: () => (hex++).toString(16),
    });
  });

  teardown(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('layout: editions/ one level under the root, the first unit gives the slug, no .tmp left', async function () {
    assert.strictEqual(s.editionsRoot, path.join(root, 'editions'));
    assert.strictEqual(
      s.documentDir(KEY),
      path.join(
        root,
        'editions',
        'job-prep',
        '___fractal___',
        'courses',
        'markdown',
        'agent-ready-repos.md',
      ),
    );
    const id = s.newId();
    assert.strictEqual(id, '20260907T104512Z-1000');
    const record = await s.create(KEY, editionOf(id));
    assert.strictEqual(
      record.filePath,
      path.join(s.documentDir(KEY), `${id}-7-specs-adrs.md`),
    );
    assert.ok(fs.existsSync(record.filePath));
    assert.deepStrictEqual(
      fs.readdirSync(s.documentDir(KEY)).filter((n) => n.endsWith('.tmp')),
      [],
      'no .tmp left behind',
    );
    assert.deepStrictEqual(record.key, KEY);
    // With no unit yet the document's title gives the slug.
    const bare = await s.create(KEY, editionOf(s.newId(), { sections: [] }));
    assert.ok(bare.filePath.endsWith('-1001-agent-ready-repos.md'));
    assert.strictEqual(store.EDITIONS_DIR_NAME, 'editions');
  });

  test('isEditionPath, keyOf and editionAt recognise an edition file and nothing else; never a module path', async function () {
    const id = s.newId();
    const record = await s.create(KEY, editionOf(id));
    assert.strictEqual(s.isEditionPath(record.filePath), true);
    assert.strictEqual(
      s.isEditionPath(path.join(s.documentDir(KEY), 'notes.md')),
      false,
      'no id prefix',
    );
    assert.strictEqual(s.isEditionPath('/elsewhere/' + id + '.md'), false);
    assert.strictEqual(
      s.isEditionPath(path.join(root, 'modules', 'ws', 'a.md', id + '.md')),
      false,
      'not under editions/',
    );
    assert.deepStrictEqual(s.keyOf(record.filePath), KEY);
    const nested = await s.create(
      { folder: 'ws', document: 'a/b/c.md' },
      editionOf(s.newId()),
    );
    assert.deepStrictEqual(s.keyOf(nested.filePath), {
      folder: 'ws',
      document: 'a/b/c.md',
    });
    const at = s.editionAt(record.filePath);
    assert.ok(at);
    assert.strictEqual(at.id, id);
    assert.deepStrictEqual(at.key, KEY);
    assert.strictEqual(s.editionAt('/nowhere.md'), null);
    // D15 — the classroom's store under a sibling root never claims an
    // edition, and this store never claims a module.
    const classroomRoot = path.join(root, '..', path.basename(root) + '-cls');
    const m = new moduleStore.ModuleStore({
      root: classroomRoot,
      log: () => {},
    });
    assert.strictEqual(m.isModulePath(record.filePath), false);
    const modulePath = path.join(
      classroomRoot,
      'modules',
      'ws',
      'a.md',
      id + '-x.md',
    );
    assert.strictEqual(s.isEditionPath(modulePath), false);
    // Even under the same root, modules/ is not editions/.
    const sameRootModule = path.join(root, 'modules', 'ws', 'a.md', id + '.md');
    assert.strictEqual(s.isEditionPath(sameRootModule), false);
  });

  test('update re-reads the file first and serialises concurrent rewrites', async function () {
    const id = s.newId();
    const record = await s.create(KEY, editionOf(id));
    const text = fs.readFileSync(record.filePath, 'utf8');
    fs.writeFileSync(
      record.filePath,
      text.replace(/\n$/, '\nA hand-written line.\n'),
    );
    const updated = await s.update(KEY, id, (e) => ({
      ...e,
      status: 'writing',
    }));
    assert.strictEqual(updated.status, 'writing');
    assert.ok(updated.body.endsWith('A hand-written line.\n'));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        s.update(KEY, id, (e) => ({ ...e, body: e.body + `\nline ${i}\n` })),
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
    const before = fs.statSync(record.filePath).mtimeMs;
    await s.update(KEY, id, () => null);
    assert.strictEqual(fs.statSync(record.filePath).mtimeMs, before);
    await assert.rejects(
      s.update(KEY, '20260907T000000Z-dead', (e) => e),
      (error) => error.name === 'EditionMissingError',
    );
    fs.writeFileSync(record.filePath, 'not an edition');
    await assert.rejects(
      s.update(KEY, id, (e) => e),
      (error) => error.name === 'EditionUnreadableError',
    );
    assert.strictEqual(
      fs.readFileSync(record.filePath, 'utf8'),
      'not an edition',
      'left alone',
    );
    assert.strictEqual(s.get(KEY, id), null);
  });

  test('list is newest first and counts unreadable files apart; listAll walks the tree and caps', async function () {
    const a = await s.create(KEY, editionOf('20260907T100012Z-0001'));
    const b = await s.create(KEY, editionOf('20260907T100512Z-0002'));
    fs.writeFileSync(
      path.join(s.documentDir(KEY), '20260907T101012Z-0003-broken.md'),
      'broken',
    );
    fs.writeFileSync(
      path.join(s.documentDir(KEY), 'README.md'),
      'not an edition',
    );
    const listing = s.list(KEY);
    assert.deepStrictEqual(
      listing.editions.map((e) => e.id),
      [b.id, a.id],
    );
    assert.strictEqual(listing.unreadable.length, 1);
    assert.ok(
      logs.some((line) => /retell: 1 unreadable edition file/.test(line)),
    );
    await s.create(
      { folder: 'other', document: 'deep/doc.md' },
      editionOf('20260907T102012Z-0004'),
    );
    const all = s.listAll();
    assert.deepStrictEqual(
      all.editions.map((e) => e.id),
      ['20260907T102012Z-0004', b.id, a.id],
    );
    assert.strictEqual(all.truncated, false);
    assert.deepStrictEqual(all.editions[0].key, {
      folder: 'other',
      document: 'deep/doc.md',
    });
    assert.strictEqual(
      s.list({ folder: 'nobody', document: 'x.md' }).editions.length,
      0,
    );
    assert.strictEqual(store.LIST_ALL_CAP, 500);
    assert.deepStrictEqual(
      new store.EditionStore({ root: '/nope', log() {} }).listAll(),
      {
        editions: [],
        unreadable: [],
        truncated: false,
      },
    );
  });

  test('a failed edition (a string error) is still found, read and continued', async function () {
    const id = s.newId();
    await s.create(
      KEY,
      editionOf(id, {
        status: 'failed',
        stoppedAt: 1,
        error: 'claude exited with code 1',
      }),
    );
    const record = s.get(KEY, id);
    assert.ok(record);
    assert.strictEqual(record.error, 'claude exited with code 1');
    assert.ok(s.editionAt(record.filePath));
    const continued = await s.update(KEY, id, (e) => ({
      ...e,
      status: 'writing',
      error: null,
    }));
    assert.strictEqual(continued.status, 'writing');
    assert.strictEqual(s.list(KEY).unreadable.length, 0);
  });

  // ------------------------------------------------ §11.2–§11.3 watch, delete

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
    const t = new store.EditionStore({
      root,
      log: () => {},
      trash: async (filePath) => {
        trashed.push(filePath);
        fs.renameSync(filePath, filePath + '.trashed');
        return true;
      },
    });
    const a = await t.create(KEY, editionOf('20260907T104512Z-0001'));
    const b = await t.create(KEY, editionOf('20260907T104513Z-0002'));
    const done = t.softDelete(KEY, a.id, 40);
    assert.strictEqual(t.isDeleting(a.id), true);
    assert.deepStrictEqual(t.deletingIds(), [a.id]);
    assert.ok(fs.existsSync(a.filePath), 'still there for Undo');
    assert.strictEqual(await done, 'trash');
    assert.deepStrictEqual(trashed, [a.filePath]);
    assert.ok(!fs.existsSync(a.filePath));
    assert.strictEqual(t.isDeleting(a.id), false);
    const undo = t.softDelete(KEY, b.id, 200);
    assert.strictEqual(t.undoDelete(b.id), true);
    assert.strictEqual(await undo, 'undone');
    await sleep(250);
    assert.ok(fs.existsSync(b.filePath));
    assert.strictEqual(trashed.length, 1);
    assert.strictEqual(t.undoDelete(b.id), false);
    // A second softDelete of the same id undoes the first window.
    const first = t.softDelete(KEY, b.id, 500);
    const second = t.softDelete(KEY, b.id, 20);
    assert.strictEqual(await first, 'undone');
    assert.strictEqual(await second, 'trash');
  });

  test('no trash callback, or a refused one, deletes permanently; deleteNow skips the window', async function () {
    const lines = [];
    const t = new store.EditionStore({
      root,
      log: (line) => lines.push(line),
      trash: async () => {
        throw new Error('EPERM: no trash here');
      },
    });
    const a = await t.create(KEY, editionOf('20260907T104512Z-0001'));
    assert.strictEqual(await t.softDelete(KEY, a.id, 10), 'permanent');
    assert.ok(!fs.existsSync(a.filePath));
    assert.ok(lines.some((line) => line.includes('retell: trash refused')));
    const bare = new store.EditionStore({ root, log: () => {} });
    const b = await bare.create(KEY, editionOf('20260907T104513Z-0002'));
    assert.strictEqual(await bare.deleteNow(KEY, b.id), 'permanent');
    assert.ok(!fs.existsSync(b.filePath));
    assert.strictEqual(await bare.deleteNow(KEY, b.id), 'missing');
    const gone = bare.softDelete(KEY, '20260907T104514Z-0003', 10);
    assert.strictEqual(await gone, 'missing');
  });

  test("the watcher debounces external changes and ignores the store's own writes and deletes", async function () {
    const fake = fakeWatch();
    const t = new store.EditionStore({
      root,
      log: () => {},
      watch: fake.watch,
      trash: async (filePath) => {
        fs.rmSync(filePath);
        return true;
      },
    });
    const changes = [];
    const handle = t.watch(KEY, () => changes.push(1));
    assert.strictEqual(fake.watchers.length, 0, 'nothing to watch yet');
    const a = await t.create(KEY, editionOf('20260907T104512Z-0001'));
    assert.strictEqual(fake.watchers.length, 1, 'attached on the first write');
    assert.strictEqual(fake.watchers[0].dir, t.documentDir(KEY));
    await t.update(KEY, a.id, (e) => ({ ...e, status: 'done' }));
    fake.watchers[0].listener('change', path.basename(a.filePath));
    await sleep(store.WATCH_DEBOUNCE_MS + 50);
    assert.strictEqual(changes.length, 0, 'own write not reported');
    fake.watchers[0].listener('change', '20260907T180000Z-aaaa-other.md');
    fake.watchers[0].listener('rename', '20260907T180000Z-aaaa-other.md');
    fake.watchers[0].listener('change', '20260907T180000Z-bbbb.md');
    fake.watchers[0].listener('change', 'unrelated.txt');
    await sleep(store.WATCH_DEBOUNCE_MS / 2);
    assert.strictEqual(changes.length, 0, 'inside the debounce');
    await sleep(store.WATCH_DEBOUNCE_MS);
    assert.strictEqual(changes.length, 1, 'one callback for three events');
    await t.softDelete(KEY, a.id, 10);
    fake.watchers[0].listener('rename', path.basename(a.filePath));
    await sleep(store.WATCH_DEBOUNCE_MS + 50);
    assert.strictEqual(changes.length, 1, 'the delete is our own');
    handle.dispose();
    assert.strictEqual(fake.watchers[0].closed, true);
    const refusing = new store.EditionStore({
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
        (c) => typeof c === 'string' && c.startsWith('retell: watch failed'),
      ),
    );
    assert.strictEqual(store.RECENT_WRITE_MS, 1000);
    // dispose carries a pending soft delete out rather than losing it.
    const d = new store.EditionStore({ root, log: () => {} });
    const b = await d.create(KEY, editionOf('20260907T104513Z-0002'));
    const pending = d.softDelete(KEY, b.id, 100000);
    d.dispose();
    assert.strictEqual(await pending, 'permanent');
    assert.ok(!fs.existsSync(b.filePath));
  });
});
