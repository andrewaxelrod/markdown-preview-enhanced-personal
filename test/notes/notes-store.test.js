/* global suite, test, suiteSetup, suiteTeardown, setup, teardown */

/**
 * `src/notes/notes-store.ts` (`featrues/12-notes/spec.md` §7, §17).
 *
 * The store takes its root, its clock, its randomness, its `fs.watch` and its
 * trash as injected dependencies, so everything §7 promises is checked here
 * against a temp directory with no `vscode` runtime: document keys, ids and
 * slugs, atomic writes, per-file serialisation, the re-read before every
 * rewrite, listing, the soft delete and the watcher.
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let store;
let format;
let storeFile;
let formatFile;
let root;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function compile(entry, outFile) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
    logLevel: 'silent',
    external: ['vscode', 'crossnote'],
  });
  fs.writeFileSync(outFile, result.outputFiles[0].text);
  return require(outFile);
}

const KEY = {
  folder: 'markdown-viewer',
  document: 'featrues/04-help-module.md',
};

function note(id, overrides) {
  return Object.assign(
    {
      id,
      created: `2026-09-05T15:${id.slice(11, 13)}:10Z`,
      updated: `2026-09-05T15:${id.slice(11, 13)}:10Z`,
      shape: 'passage',
      titleEdited: false,
      document: {
        workspace: 'markdown-viewer',
        path: 'featrues/04-help-module.md',
        absolute: '/x/featrues/04-help-module.md',
        title: 'Help',
        headings: ['3. The prompt'],
        git: { remote: '', commit: '' },
      },
      anchor: {
        block: 'b3f9a1c2',
        line: 76,
        exact: 'the eligible block before',
        prefix: '',
        suffix: '',
        offset: 0,
        blocks: 1,
      },
      generated: { status: 'pending' },
      tags: [],
      unknown: {},
      title: 'A title',
      passage: 'the eligible block before',
      sections: new Map(),
      extras: [],
      myNote: '',
      context: { enclosing: '', before: '', after: '' },
    },
    overrides || {},
  );
}

function makeStore(overrides) {
  const logs = [];
  const trashed = [];
  const deps = Object.assign(
    {
      root,
      log: (line) => logs.push(line),
      trash: async (filePath) => {
        trashed.push(filePath);
        fs.renameSync(filePath, filePath + '.trashed');
        return true;
      },
      now: () => new Date('2026-09-05T15:42:10Z'),
      randomHex: () => '7f3a',
    },
    overrides || {},
  );
  const instance = new store.NotesStore(deps);
  return { store: instance, logs, trashed };
}

suite('notes/notes-store', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    storeFile = path.join(__dirname, '.notes-store.bundle.cjs');
    formatFile = path.join(__dirname, '.note-format-for-store.bundle.cjs');
    store = await compile(
      path.join(__dirname, '..', '..', 'src', 'notes', 'notes-store.ts'),
      storeFile,
    );
    format = await compile(
      path.join(__dirname, '..', '..', 'src', 'notes', 'note-format.ts'),
      formatFile,
    );
  });

  suiteTeardown(function () {
    for (const file of [storeFile, formatFile]) {
      if (file && fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  });

  setup(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-notes-'));
  });

  teardown(function () {
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  suite('identity (§7.2)', function () {
    test('a document key is the folder name plus the relative path', function () {
      const folder = { name: 'markdown-viewer', fsPath: '/a/markdown-viewer' };
      assert.deepStrictEqual(
        store.documentKeyFor({
          folder,
          relativePath: 'featrues/04-help-module.md',
          absolutePath: '/a/markdown-viewer/featrues/04-help-module.md',
          folders: [folder],
        }),
        KEY,
      );
    });

    test('no workspace: _no-workspace plus the absolute path without its leading separator', function () {
      assert.deepStrictEqual(
        store.documentKeyFor({
          folder: null,
          relativePath: '',
          absolutePath: '/Users/andrew/Documents/x.md',
          folders: [],
        }),
        { folder: '_no-workspace', document: 'Users/andrew/Documents/x.md' },
      );
      assert.deepStrictEqual(
        store.documentKeyFor({
          folder: null,
          relativePath: '',
          absolutePath: 'C:\\Users\\andrew\\x.md',
          folders: [],
        }),
        { folder: '_no-workspace', document: 'C/Users/andrew/x.md' },
      );
    });

    test('two folders with the same name: the second gets a short hash suffix', function () {
      const a = { name: 'repo', fsPath: '/one/repo' };
      const b = { name: 'repo', fsPath: '/two/repo' };
      assert.strictEqual(store.workspaceFolderKey(a, [a, b]), 'repo');
      assert.match(store.workspaceFolderKey(b, [a, b]), /^repo-[0-9a-f]{6}$/);
      assert.strictEqual(
        store.workspaceFolderKey(b, [a, b]),
        store.workspaceFolderKey(b, [a, b]),
        'stable',
      );
    });

    test('ids are the UTC stamp plus four hex characters', function () {
      assert.strictEqual(
        store.newNoteId(new Date('2026-09-05T15:42:10.123Z'), '7f3a'),
        '20260905T154210Z-7f3a',
      );
      assert.strictEqual(
        store.newNoteId(new Date('2026-01-02T03:04:05Z'), 'ZZ'),
        '20260102T030405Z-0000',
      );
      assert.strictEqual(makeStore().store.newId(), '20260905T154210Z-7f3a');
    });

    test('slugs: three words, lowercased, non-alphanumerics to hyphens, at most 40', function () {
      assert.strictEqual(
        store.slugFor('The Eligible block before the first'),
        'the-eligible-block',
      );
      assert.strictEqual(
        store.slugFor('  §14.2  “quoted”  X'),
        '14-2-quoted-x',
      );
      assert.strictEqual(store.slugFor('⟦⟧ ¶ ¶'), '');
      assert.ok(
        store.slugFor(
          'Supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopic',
        ).length <= 40,
      );
      assert.strictEqual(
        store.fileNameFor('20260905T154210Z-7f3a', 'the eligible block before'),
        '20260905T154210Z-7f3a-the-eligible-block.md',
      );
      assert.strictEqual(
        store.fileNameFor('20260905T154210Z-7f3a', '¶'),
        '20260905T154210Z-7f3a.md',
      );
    });

    test('a hand-renamed slug still resolves by id prefix', async function () {
      const s = makeStore().store;
      const record = await s.create(KEY, note('20260905T154210Z-7f3a'));
      const renamed = path.join(
        path.dirname(record.filePath),
        '20260905T154210Z-7f3a-my-own-name.md',
      );
      fs.renameSync(record.filePath, renamed);
      assert.strictEqual(s.find(KEY, '20260905T154210Z-7f3a'), renamed);
      assert.strictEqual(s.find(KEY, '20260905T154210Z-0000'), null);
    });
  });

  suite('writes (§7.4)', function () {
    test('create writes the file under <root>/<folder>/<document>/ and leaves no .tmp', async function () {
      const s = makeStore().store;
      const record = await s.create(KEY, note('20260905T154210Z-7f3a'));
      assert.strictEqual(
        record.filePath,
        path.join(
          root,
          'markdown-viewer',
          'featrues',
          '04-help-module.md',
          '20260905T154210Z-7f3a-the-eligible-block.md',
        ),
      );
      const dir = path.dirname(record.filePath);
      assert.deepStrictEqual(fs.readdirSync(dir), [
        '20260905T154210Z-7f3a-the-eligible-block.md',
      ]);
      const parsed = format.parseNoteFile(
        fs.readFileSync(record.filePath, 'utf8'),
      );
      assert.strictEqual(parsed.id, '20260905T154210Z-7f3a');
    });

    test('a .folder marker is written for a suffixed folder key', async function () {
      const s = makeStore().store;
      await s.create(
        { folder: 'repo-abc123', document: 'x.md' },
        note('20260905T154210Z-7f3a'),
        '/two/repo',
      );
      assert.strictEqual(
        fs.readFileSync(path.join(root, 'repo-abc123', '.folder'), 'utf8'),
        '/two/repo\n',
      );
      await s.create(KEY, note('20260905T154211Z-7f3a'), '/a/markdown-viewer');
      assert.ok(!fs.existsSync(path.join(root, 'markdown-viewer', '.folder')));
    });

    test('update re-reads the file first, so a hand edit survives', async function () {
      const s = makeStore().store;
      const record = await s.create(KEY, note('20260905T154210Z-7f3a'));
      // A hand edit in an editor between the capture and the generation.
      const edited = fs
        .readFileSync(record.filePath, 'utf8')
        .replace('\n## My note\n', '\n## My note\n\nTyped by hand.\n');
      fs.writeFileSync(record.filePath, edited);
      const updated = await s.update(
        KEY,
        '20260905T154210Z-7f3a',
        (current) => ({
          ...current,
          sections: new Map([['Summary', 'Generated.']]),
          generated: { status: 'done' },
        }),
      );
      assert.strictEqual(updated.myNote, 'Typed by hand.');
      const onDisk = format.parseNoteFile(
        fs.readFileSync(record.filePath, 'utf8'),
      );
      assert.strictEqual(onDisk.myNote, 'Typed by hand.');
      assert.strictEqual(onDisk.sections.get('Summary'), 'Generated.');
    });

    test('concurrent updates to one file are serialised and none is lost', async function () {
      const s = makeStore().store;
      await s.create(KEY, note('20260905T154210Z-7f3a'));
      await Promise.all(
        ['a', 'b', 'c', 'd', 'e'].map((tag) =>
          s.update(KEY, '20260905T154210Z-7f3a', (current) => ({
            ...current,
            tags: current.tags.concat([tag]),
          })),
        ),
      );
      const listing = s.list(KEY);
      assert.deepStrictEqual(listing.notes[0].tags, ['a', 'b', 'c', 'd', 'e']);
      assert.deepStrictEqual(
        fs
          .readdirSync(path.dirname(listing.notes[0].filePath))
          .filter((n) => n.endsWith('.tmp')),
        [],
      );
    });

    test('a mutate that returns null leaves the file untouched', async function () {
      const s = makeStore().store;
      const record = await s.create(KEY, note('20260905T154210Z-7f3a'));
      const before = fs.statSync(record.filePath).mtimeMs;
      await sleep(20);
      const result = await s.update(KEY, '20260905T154210Z-7f3a', () => null);
      assert.strictEqual(result.id, '20260905T154210Z-7f3a');
      assert.strictEqual(fs.statSync(record.filePath).mtimeMs, before);
    });

    test('a file that became unreadable is left alone and reported', async function () {
      const s = makeStore().store;
      const record = await s.create(KEY, note('20260905T154210Z-7f3a'));
      fs.writeFileSync(record.filePath, 'not a note any more');
      await assert.rejects(
        s.update(KEY, '20260905T154210Z-7f3a', (current) => current),
        (error) =>
          error.name === 'NoteUnreadableError' &&
          /could not be updated/.test(error.message),
      );
      assert.strictEqual(
        fs.readFileSync(record.filePath, 'utf8'),
        'not a note any more',
      );
    });

    test('updating a note that does not exist is a NoteMissingError', async function () {
      const s = makeStore().store;
      await assert.rejects(
        s.update(KEY, '20260905T154210Z-0000', (current) => current),
        (error) => error.name === 'NoteMissingError',
      );
    });
  });

  suite('listing (§7.5)', function () {
    test('list sorts by created and reports unreadable files apart', async function () {
      const s = makeStore().store;
      await s.create(KEY, note('20260905T154310Z-0002'));
      await s.create(KEY, note('20260905T154210Z-0001'));
      await s.create(KEY, note('20260905T154410Z-0003'));
      const dir = s.documentDir(KEY);
      fs.writeFileSync(
        path.join(dir, '20260905T154510Z-0004-broken.md'),
        '# no front matter\n',
      );
      fs.writeFileSync(path.join(dir, 'README.md'), '# not a note\n');
      fs.writeFileSync(path.join(dir, '.hidden.md'), '---\n');
      const listing = s.list(KEY);
      assert.deepStrictEqual(
        listing.notes.map((n) => n.id),
        [
          '20260905T154210Z-0001',
          '20260905T154310Z-0002',
          '20260905T154410Z-0003',
        ],
      );
      assert.deepStrictEqual(
        listing.unreadable.map((p) => path.basename(p)).sort(),
        ['20260905T154510Z-0004-broken.md', 'README.md'],
      );
    });

    test('an absent document folder lists nothing', function () {
      const s = makeStore().store;
      assert.deepStrictEqual(s.list(KEY), { notes: [], unreadable: [] });
    });

    test('listFolders, listDocuments and listAll walk the tree', async function () {
      const s = makeStore().store;
      await s.create(KEY, note('20260905T154210Z-0001'));
      await s.create(KEY, note('20260905T154310Z-0002'));
      await s.create(
        { folder: 'markdown-viewer', document: 'README.md' },
        note('20260905T154410Z-0003'),
      );
      await s.create(
        { folder: '_no-workspace', document: 'Users/a/x.md' },
        note('20260905T154510Z-0004'),
      );
      assert.deepStrictEqual(s.listFolders(), [
        '_no-workspace',
        'markdown-viewer',
      ]);
      const documents = s.listDocuments('markdown-viewer');
      assert.deepStrictEqual(
        documents.map((d) => [d.key.document, d.count]),
        [
          ['README.md', 1],
          ['featrues/04-help-module.md', 2],
        ],
      );
      const all = s.listAll();
      assert.strictEqual(all.notes.length, 4);
      assert.strictEqual(all.truncated, false);
    });
  });

  suite('soft delete, undo, trash (§7.7)', function () {
    test('the file is untouched during the window and goes to the trash after it', async function () {
      const made = makeStore();
      const record = await made.store.create(
        KEY,
        note('20260905T154210Z-7f3a'),
      );
      const done = made.store.softDelete(KEY, '20260905T154210Z-7f3a', 40);
      assert.strictEqual(made.store.isDeleting('20260905T154210Z-7f3a'), true);
      assert.deepStrictEqual(made.store.deletingIds(), [
        '20260905T154210Z-7f3a',
      ]);
      assert.ok(fs.existsSync(record.filePath), 'still there for Undo');
      assert.strictEqual(await done, 'trash');
      assert.deepStrictEqual(made.trashed, [record.filePath]);
      assert.ok(!fs.existsSync(record.filePath));
      assert.strictEqual(made.store.isDeleting('20260905T154210Z-7f3a'), false);
    });

    test('undo within the window keeps the file and resolves undone', async function () {
      const made = makeStore();
      const record = await made.store.create(
        KEY,
        note('20260905T154210Z-7f3a'),
      );
      const done = made.store.softDelete(KEY, '20260905T154210Z-7f3a', 200);
      assert.strictEqual(made.store.undoDelete('20260905T154210Z-7f3a'), true);
      assert.strictEqual(await done, 'undone');
      await sleep(250);
      assert.ok(fs.existsSync(record.filePath));
      assert.deepStrictEqual(made.trashed, []);
      assert.strictEqual(made.store.undoDelete('20260905T154210Z-7f3a'), false);
    });

    test('a refused trash deletes permanently', async function () {
      const made = makeStore({
        trash: async () => {
          throw new Error('EPERM: no trash here');
        },
      });
      const record = await made.store.create(
        KEY,
        note('20260905T154210Z-7f3a'),
      );
      assert.strictEqual(
        await made.store.softDelete(KEY, '20260905T154210Z-7f3a', 10),
        'permanent',
      );
      assert.ok(!fs.existsSync(record.filePath));
      assert.ok(made.logs.some((line) => line.includes('trash refused')));
    });

    test('deleteNow skips the window', async function () {
      const made = makeStore();
      const record = await made.store.create(
        KEY,
        note('20260905T154210Z-7f3a'),
      );
      assert.strictEqual(
        await made.store.deleteNow(KEY, '20260905T154210Z-7f3a'),
        'trash',
      );
      assert.ok(!fs.existsSync(record.filePath));
      assert.strictEqual(
        await made.store.deleteNow(KEY, '20260905T154210Z-7f3a'),
        'missing',
      );
    });
  });

  suite('watching (§7.6)', function () {
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

    test('external changes are debounced into one callback; own writes are ignored', async function () {
      const fake = fakeWatch();
      const made = makeStore({ watch: fake.watch });
      const changes = [];
      const record = await made.store.create(
        KEY,
        note('20260905T154210Z-7f3a'),
      );
      const handle = made.store.watch(KEY, () => changes.push(Date.now()));
      assert.strictEqual(fake.watchers.length, 1);
      assert.strictEqual(fake.watchers[0].dir, made.store.documentDir(KEY));

      // The store's own write, reported back by the platform: ignored.
      await made.store.update(KEY, '20260905T154210Z-7f3a', (c) => ({
        ...c,
        tags: ['x'],
      }));
      fake.watchers[0].listener('change', path.basename(record.filePath));
      await sleep(store.WATCH_DEBOUNCE_MS + 50);
      assert.strictEqual(changes.length, 0, 'own write not reported');

      // Three external events in quick succession: one callback.
      fake.watchers[0].listener('change', '20260905T160000Z-aaaa-other.md');
      fake.watchers[0].listener('rename', '20260905T160000Z-aaaa-other.md');
      fake.watchers[0].listener('change', '20260905T160000Z-bbbb.md');
      await sleep(store.WATCH_DEBOUNCE_MS / 2);
      assert.strictEqual(changes.length, 0, 'still inside the debounce');
      await sleep(store.WATCH_DEBOUNCE_MS);
      assert.strictEqual(changes.length, 1);

      // Files that are not notes are not changes.
      fake.watchers[0].listener('change', 'notes.txt');
      await sleep(store.WATCH_DEBOUNCE_MS + 50);
      assert.strictEqual(changes.length, 1);

      handle.dispose();
      assert.strictEqual(fake.watchers[0].closed, true);
      fake.watchers[0].listener('change', '20260905T160000Z-cccc.md');
      await sleep(store.WATCH_DEBOUNCE_MS + 50);
      assert.strictEqual(changes.length, 1, 'nothing after dispose');
    });

    test('a folder that does not exist yet is watched from the first write into it', async function () {
      const fake = fakeWatch();
      const made = makeStore({ watch: fake.watch });
      const handle = made.store.watch(KEY, () => {});
      assert.strictEqual(fake.watchers.length, 0, 'nothing to watch yet');
      await made.store.create(KEY, note('20260905T154210Z-7f3a'));
      assert.strictEqual(fake.watchers.length, 1);
      handle.dispose();
    });

    test('a platform that refuses the watch logs one line', function () {
      const made = makeStore({
        watch: () => {
          throw new Error('ENOSPC: watch limit');
        },
      });
      fs.mkdirSync(made.store.documentDir(KEY), { recursive: true });
      const handle = made.store.watch(KEY, () => {});
      assert.strictEqual(
        made.logs.filter((l) => l.startsWith('notes: watch failed')).length,
        1,
      );
      handle.dispose();
    });

    test('a trash delete is not reported back as an external change', async function () {
      const fake = fakeWatch();
      const made = makeStore({ watch: fake.watch });
      const changes = [];
      const record = await made.store.create(
        KEY,
        note('20260905T154210Z-7f3a'),
      );
      made.store.watch(KEY, () => changes.push(1));
      await made.store.softDelete(KEY, '20260905T154210Z-7f3a', 10);
      fake.watchers[0].listener('rename', path.basename(record.filePath));
      await sleep(store.WATCH_DEBOUNCE_MS + 50);
      assert.strictEqual(changes.length, 0);
    });
  });
});
