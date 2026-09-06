/* global suite, test, suiteSetup, suiteTeardown */

/**
 * `src/classroom/module-format.ts` (`featrues/13-classroom/spec.md` §10): the
 * round trips, the frame with and without a line, the provisional title then
 * the plan's, append then `bridgeOf`, unknown keys kept, the parse errors and
 * `previewSummary`.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { compileEntry } = require('./compile');

let format;
let tmpFile;

const PASSAGE =
  'Then the human path, and it is, in the end, the same path a human author would walk. A maintainer checks the diff.';
/** Where the store puts this document's modules; the back link is relative to it. */
const MODULE_DIR =
  '/Users/andrew/.local/state/crossnote/classroom/modules/markdown-viewer/test-file.md';
const BACK =
  '../../../../../../../Documents/Github/genai-tools/markdown-viewer/test-file.md';

function module(overrides) {
  const base = {
    id: '20260905T173010Z-4c2e',
    created: '2026-09-05T17:30:10Z',
    updated: '2026-09-05T17:30:10Z',
    finished: null,
    status: 'planning',
    stoppedAt: null,
    error: null,
    persona: { id: 'max', name: 'Max', version: 1 },
    level: 2,
    readerNote: "I don't get who approves what.",
    audience: 'a professionally motivated reader',
    engine: { engine: 'claude', model: 'sonnet', effort: 'medium', prompt: 1 },
    document: {
      workspace: 'markdown-viewer',
      path: 'test-file.md',
      absolute:
        '/Users/andrew/Documents/Github/genai-tools/markdown-viewer/test-file.md',
      title: 'Module 1: The Governed Harness',
      headings: ['The Governed Path: From Issue to Merge'],
      headingId: 'the-governed-path-from-issue-to-merge',
      words: 13061,
      git: { remote: '', commit: 'abc1234' },
      linked: [
        { path: 'featrues/04-help-module.md', title: '04 — Help', words: 6100 },
      ],
    },
    passage: {
      exact: PASSAGE,
      block: 'b3f9a1c2',
      line: 393,
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
  if (!merged.body) {
    merged.body = format.initialBody(merged, MODULE_DIR);
  }
  return merged;
}

function planned(overrides) {
  return module(
    Object.assign(
      {
        status: 'writing',
        plan: {
          title: 'Approvals, Gates, and Borrowed Keys',
          mission: 'Give the reader every piece.',
          chapters: [],
          terms: ['code owner', 'OIDC'],
          example: 'RSK-142',
        },
        chapters: [
          {
            n: 1,
            title: 'Module Introduction',
            question: 'Module Introduction?',
            type: 'framing',
            words: 250,
            drawsOn: ['A'],
            status: 'done',
            actual: 292,
            flagged: [],
            ms: 10200,
          },
          {
            n: 2,
            title: 'Who Is a Code Owner',
            question: 'Why several?',
            type: 'concept',
            words: 500,
            drawsOn: ['B', 'C'],
            status: 'done',
            actual: 751,
            flagged: ['length-target'],
            ms: 21100,
          },
          {
            n: 3,
            title: 'Walking the Passage',
            question: 'Walking the Passage?',
            type: 'return',
            words: 600,
            drawsOn: [],
            status: 'queued',
            actual: null,
            flagged: [],
            ms: null,
          },
        ],
        ledger: {
          promises: [
            {
              text: 'why the merge button becomes clickable',
              made: 1,
              due: 3,
              paid: false,
            },
          ],
          examples: [
            { name: 'RSK-142', standsFor: 'one ticket', chapters: [1, 2] },
          ],
          terms: [
            { term: 'code owner', gloss: 'the reviewer of a path', chapter: 2 },
          ],
          analogies: [
            {
              concept: 'CODEOWNERS',
              analogy: 'a sign, not a lock',
              chapter: 2,
            },
          ],
        },
      },
      overrides || {},
    ),
  );
}

suite('classroom/module-format', function () {
  this.timeout(30000);

  suiteSetup(async function () {
    tmpFile = path.join(__dirname, '.module-format.bundle.cjs');
    format = await compileEntry('src/classroom/module-format.ts', tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  test('the initial body is the frame: provisional title, the where line with its link, the quote', function () {
    const m = module();
    const expected =
      '# Classroom: Then the human path, and it…\n\n' +
      'You were reading "Module 1: The Governed Harness", under "The Governed Path: From Issue to Merge", and stopped at this passage. ' +
      '[Back to the passage](' +
      BACK +
      '#L393)\n\n' +
      '> ' +
      PASSAGE +
      '\n';
    assert.strictEqual(m.body, expected);
    const noLine = module({
      passage: Object.assign({}, module().passage, { line: null }),
    });
    assert.ok(
      noLine.body.includes('](' + BACK + ')\n\n'),
      'no fragment without a line',
    );
    const noHeading = module({
      document: Object.assign({}, module().document, { headings: [] }),
    });
    assert.ok(
      noHeading.body.includes(
        'You were reading "Module 1: The Governed Harness" and stopped at this passage.',
      ),
    );
    assert.strictEqual(format.fileUriFor('/a b/c.md'), 'file:///a%20b/c.md');
    assert.strictEqual(format.fileUriFor('C:\\x\\y.md'), 'file:///C:/x/y.md');
  });

  test('parse ∘ serialize is the identity for every field the codec owns', function () {
    const m = planned();
    const text = format.serializeModuleFile(m);
    assert.ok(
      text.startsWith(
        '---\nid: 20260905T173010Z-4c2e\ncreated: 2026-09-05T17:30:10Z\n',
      ),
    );
    const parsed = format.parseModuleFile(text);
    assert.strictEqual(format.isModuleParseError(parsed), false);
    assert.deepStrictEqual(parsed, m);
    assert.strictEqual(
      format.serializeModuleFile(parsed),
      text,
      'serialize ∘ parse is stable',
    );
  });

  test('the plan rewrite replaces the h1 only; appends never touch earlier text', function () {
    const m = module();
    const body1 = format.replaceTitle(
      m.body,
      'Approvals, Gates, and Borrowed Keys',
    );
    assert.ok(
      body1.startsWith(
        '# Approvals, Gates, and Borrowed Keys\n\nYou were reading',
      ),
    );
    assert.strictEqual(
      body1.slice(body1.indexOf('\n\n')),
      m.body.slice(m.body.indexOf('\n\n')),
    );
    const chapter1 =
      '## Module Introduction\n\nFirst paragraph.\n\nSo let us start with the people. Why does more than one have to sign?';
    const body2 = format.appendChapter(body1, chapter1);
    assert.strictEqual(
      body2,
      body1.replace(/\s+$/, '') + '\n\n' + chapter1 + '\n',
    );
    assert.strictEqual(
      format.bridgeOf(body2),
      'So let us start with the people. Why does more than one have to sign?',
    );
    const chapter2 =
      '## Who Is a Code Owner\n\nBody.\n\nHere is a figure.\n\n```ascii\nx | y\n```\n\nThe last paragraph is the bridge.';
    const body3 = format.appendChapter(body2, chapter2);
    assert.ok(body3.startsWith(body2.replace(/\s+$/, '')), 'append only');
    assert.strictEqual(
      format.bridgeOf(body3),
      'The last paragraph is the bridge.',
    );
    assert.deepStrictEqual(format.chapterHeadingsIn(body3), [
      'Module Introduction',
      'Who Is a Code Owner',
    ]);
    const closed = format.appendClosingLink(body3, m, MODULE_DIR);
    assert.ok(closed.endsWith('[Back to the passage](' + BACK + '#L393)\n'));
    assert.strictEqual(
      format.appendClosingLink(closed, m, MODULE_DIR),
      closed,
      'idempotent',
    );
    assert.strictEqual(
      format.bridgeOf(closed),
      'The last paragraph is the bridge.',
      'the closing link is not a bridge',
    );
    assert.strictEqual(format.bridgeOf(m.body), '', 'no chapter, no bridge');
  });

  test('a module with no plan serialises without plan, chapters and ledger', function () {
    const text = format.serializeModuleFile(module());
    assert.ok(!/^plan:/m.test(text));
    assert.ok(!/^chapters:/m.test(text));
    assert.ok(!/^ledger:/m.test(text));
    const parsed = format.parseModuleFile(text);
    assert.strictEqual(parsed.plan, null);
    assert.deepStrictEqual(parsed.chapters, []);
    assert.deepStrictEqual(parsed.ledger, {
      promises: [],
      examples: [],
      terms: [],
      analogies: [],
    });
  });

  test('unknown front-matter keys and a hand-edited body survive a round trip', function () {
    const text = format
      .serializeModuleFile(planned())
      .replace('---\nid:', '---\nreviewed: true\ncolour: blue\nid:');
    const parsed = format.parseModuleFile(text);
    assert.deepStrictEqual(parsed.unknown, { reviewed: true, colour: 'blue' });
    const edited = {
      ...parsed,
      body: parsed.body + '\nA line the reader added.\n',
    };
    const again = format.parseModuleFile(format.serializeModuleFile(edited));
    assert.deepStrictEqual(again.unknown, { reviewed: true, colour: 'blue' });
    assert.ok(again.body.endsWith('A line the reader added.\n'));
  });

  test('a failed module, whose error field is a string, is not a parse error', function () {
    const failed = planned({
      status: 'failed',
      stoppedAt: 1,
      error: 'No answer after 90 s.',
    });
    const parsed = format.parseModuleFile(format.serializeModuleFile(failed));
    assert.strictEqual(format.isModuleParseError(parsed), false);
    assert.strictEqual(parsed.status, 'failed');
    assert.strictEqual(parsed.error, 'No answer after 90 s.');
    assert.strictEqual(
      format.isModuleParseError({ error: 'no front matter' }),
      true,
    );
  });

  test('the parse errors: no front matter, bad YAML, no id, no status', function () {
    assert.strictEqual(
      format.parseModuleFile('# Just a title\n').error,
      'no front matter',
    );
    assert.match(
      format.parseModuleFile('---\nid: [\n---\n').error,
      /does not parse/,
    );
    assert.strictEqual(
      format.parseModuleFile('---\nstatus: done\n---\n# T\n').error,
      'no module id',
    );
    assert.strictEqual(
      format.parseModuleFile('---\nid: 20260905T173010Z-4c2e\n---\n# T\n')
        .error,
      'no status',
    );
    assert.strictEqual(
      format.parseModuleFile(
        '---\nid: 20260905T173010Z-4c2e\nstatus: odd\n---\n',
      ).error,
      'no status',
    );
    assert.strictEqual(
      format.parseModuleFile('---\nid: 20260905T173010Z-4c2e\nstatus: done\n')
        .error,
      'front matter is not closed',
    );
  });

  test('previewSummary: title, counts and minutes from the actual word counts', function () {
    const m = planned();
    m.body = format.replaceTitle(m.body, m.plan.title);
    const { anchor, headings, passage, ...summary } = format.previewSummary(m);
    assert.deepStrictEqual(summary, {
      id: '20260905T173010Z-4c2e',
      title: 'Approvals, Gates, and Borrowed Keys',
      created: '2026-09-05T17:30:10Z',
      status: 'writing',
      chapters: 3,
      done: 2,
      minutes: 7,
    });
    // 13 §12.5 — the marker's anchor, the heading path and the passage's head.
    assert.deepStrictEqual(anchor, m.passage);
    assert.deepStrictEqual(headings, m.document.headings);
    assert.strictEqual(
      passage,
      m.passage.exact.replace(/\s+/g, ' ').trim().slice(0, 160),
    );
    assert.strictEqual(
      format.titleOf(module()),
      'Classroom: Then the human path, and it…',
    );
    assert.strictEqual(
      format.backLink(m, MODULE_DIR),
      '[Back to the passage](' + BACK + '#L393)',
    );
    // A module beside its document links down; a space is percent-encoded.
    assert.strictEqual(
      format.relativeLink('/ws/notes', '/ws/docs/my file.md'),
      '../docs/my%20file.md',
    );
    assert.strictEqual(format.relativeLink('/ws', '/ws/a.md'), './a.md');
  });
});
