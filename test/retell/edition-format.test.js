/* global suite, test, suiteSetup, suiteTeardown */

/**
 * `src/retell/edition-format.ts` (`featrues/15-convert-readable/spec.md`
 * §10): the round trips, the frame for one section and for a document scope,
 * `editionTitle`, `appendSection` appending the back link and never
 * rewriting, `splitBody` for Rebuild, `writtenLevelOffset`, unknown keys kept,
 * the four parse errors, `previewSummary`, `minutesOf` at 142 and
 * `backLinkFor`'s relative destination with its one-based `#L`.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { compileEntry } = require('./compile');

let format;
let tmpFile;

const ABSOLUTE =
  '/Users/andrew/Documents/Github/job-prep/___fractal___/courses/markdown/agent-ready-repos.md';
/** Where the store puts this document's editions; the back link is relative to it. */
const EDITION_DIR =
  '/Users/andrew/.crossnote/retell/editions/job-prep/___fractal___/courses/markdown/agent-ready-repos.md';
/** Eight steps up from the edition's folder to `/Users/andrew`, then down. */
const BACK =
  '../../../../../../../../Documents/Github/job-prep/___fractal___/courses/markdown/agent-ready-repos.md';

function section(n, heading, overrides) {
  return Object.assign(
    {
      n,
      heading,
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
        exact: heading,
        block: 'b7c1a904',
        line: 208,
        prefix: '',
        suffix: '',
        offset: 0,
        blocks: 1,
      },
    },
    overrides || {},
  );
}

function edition(overrides) {
  const base = {
    id: '20260907T104512Z-9a3f',
    created: '2026-09-07T10:45:12Z',
    updated: '2026-09-07T10:45:12Z',
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
      absolute: ABSOLUTE,
      title: 'Agent-Ready Repos',
      headings: ['Agent-Ready Repos'],
      words: 4986,
      git: { remote: '', commit: '' },
    },
    sections: [section(1, '7. Specs, ADRs, constitution')],
    unknown: {},
    body: '',
  };
  const merged = Object.assign(base, overrides || {});
  if (!merged.body) {
    merged.body = format.initialBody(merged);
  }
  return merged;
}

suite('retell/edition-format', function () {
  this.timeout(30000);

  suiteSetup(async function () {
    tmpFile = path.join(__dirname, '.edition-format.bundle.cjs');
    format = await compileEntry('src/retell/edition-format.ts', tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  test('the frame for one section: the h1 and the You were reading line, one-based line in no link yet', function () {
    const e = edition();
    const body = format.initialBody(e);
    assert.strictEqual(
      body,
      '# "7. Specs, ADRs, constitution": the spoken edition\n\n' +
        'You were reading "Agent-Ready Repos", section "7. Specs, ADRs, constitution". ' +
        'This is its spoken edition: the same content, in the same order, said to be heard.\n',
    );
    assert.strictEqual(
      format.editionTitle('Agent-Ready Repos', e.sections, 'selection'),
      '"7. Specs, ADRs, constitution": the spoken edition',
    );
    // Quotes inside a heading become typographic ones, so the h1 stays one string.
    assert.strictEqual(
      format.editionTitle('D', [{ heading: 'The "lock" file' }], 'selection'),
      '"The ”lock” file": the spoken edition',
    );
  });

  test('the frame for a document scope, or several sections, names the document', function () {
    const two = edition({
      sections: [
        section(1, '7. Specs, ADRs, constitution'),
        section(2, '8. Retrieval', { line: 378, endLine: 420 }),
      ],
    });
    assert.strictEqual(
      format.editionTitle(two.document.title, two.sections, 'selection'),
      'Agent-Ready Repos: the spoken edition',
    );
    assert.ok(
      format
        .frameFor(two)
        .includes(
          'You were reading "Agent-Ready Repos". This is its spoken edition, section by section: the same content, in the same order, said to be heard.',
        ),
    );
    const doc = edition({ scope: 'document' });
    assert.strictEqual(
      format.frameFor(doc).split('\n')[0],
      '# Agent-Ready Repos: the spoken edition',
    );
    assert.strictEqual(
      format.editionTitle('', [], 'document'),
      'Document: the spoken edition',
    );
  });

  test('parse ∘ serialize is the identity for every field the codec owns; unknown keys kept', function () {
    const e = edition({
      status: 'writing',
      unknown: { reviewer: 'andrew', stars: 3 },
      sections: [
        section(1, '7. Specs, ADRs, constitution', {
          status: 'done',
          actual: 1545,
          flagged: ['sentence-length'],
          ms: 25400,
        }),
        section(2, '8. Retrieval', { line: 378, endLine: 420, words: 300 }),
      ],
    });
    const text = format.serializeEditionFile(e);
    assert.ok(text.startsWith('---\nid: 20260907T104512Z-9a3f\n'));
    assert.ok(text.includes('\nshape: full\nscope: selection\n'));
    assert.ok(text.includes('reviewer: andrew'));
    const parsed = format.parseEditionFile(text);
    assert.ok(!format.isEditionParseError(parsed), parsed.error);
    assert.deepStrictEqual(parsed, e);
    assert.strictEqual(format.serializeEditionFile(parsed), text, 'stable');
    // The §10.2 key order.
    const keys = text
      .split('\n---')[0]
      .split('\n')
      .filter((line) => /^[a-zA-Z]+:/.test(line))
      .map((line) => line.split(':')[0]);
    assert.deepStrictEqual(keys, [
      'id',
      'created',
      'updated',
      'finished',
      'status',
      'stoppedAt',
      'error',
      'shape',
      'scope',
      'engine',
      'estimate',
      'document',
      'sections',
      'reviewer',
      'stars',
    ]);
  });

  test('the four parse errors, and the defaults for an odd shape, scope or status', function () {
    assert.deepStrictEqual(format.parseEditionFile('# no front matter\n'), {
      error: 'no front matter',
    });
    assert.ok(
      /does not parse/.test(
        format.parseEditionFile('---\nid: [\n---\nbody\n').error,
      ),
    );
    assert.deepStrictEqual(
      format.parseEditionFile('---\nid: nope\nstatus: done\n---\n'),
      { error: 'no edition id' },
    );
    assert.deepStrictEqual(
      format.parseEditionFile('---\nid: 20260907T104512Z-9a3f\n---\n'),
      { error: 'no status' },
    );
    assert.deepStrictEqual(
      format.parseEditionFile('---\nid: 20260907T104512Z-9a3f\n'),
      { error: 'front matter is not closed' },
    );
    const parsed = format.parseEditionFile(
      '---\nid: 20260907T104512Z-9a3f\nstatus: done\nshape: brief\nscope: odd\nsections:\n  - { heading: A, status: odd, level: 9 }\n  - { n: 2 }\n---\n\n# T\n',
    );
    assert.strictEqual(parsed.shape, 'full', 'brief is reserved, not built');
    assert.strictEqual(parsed.scope, 'selection');
    assert.strictEqual(parsed.sections.length, 1, 'a section needs a heading');
    assert.strictEqual(parsed.sections[0].status, 'queued');
    assert.strictEqual(parsed.sections[0].level, 2);
    assert.strictEqual(parsed.body, '# T\n');
    assert.strictEqual(
      format.EDITION_ID_RE.test('20260907T104512Z-9a3f'),
      true,
    );
    assert.ok(format.isEditionParseError({ error: 'x' }));
    assert.ok(!format.isEditionParseError(parsed));
  });

  test('appendSection appends the unit and its own back link, never rewriting; the back link is relative and one-based', function () {
    const e = edition();
    const link = format.backLinkFor(e, e.sections[0], EDITION_DIR);
    assert.strictEqual(link, '[Back to the section](' + BACK + '#L208)');
    assert.strictEqual(
      format.backLinkFor(e, { line: null }, EDITION_DIR),
      '[Back to the section](' + BACK + ')',
    );
    assert.strictEqual(format.BACK_LINK_TEXT, 'Back to the section');
    const unit =
      '## 7. Specs, ADRs, constitution\n\n### Specs\n\nKeep one spec.\n';
    const body1 = format.appendSection(e.body, unit, link);
    assert.ok(body1.startsWith(e.body.replace(/\s+$/, '')), 'append only');
    assert.ok(
      body1.endsWith(
        '\n\n## 7. Specs, ADRs, constitution\n\n### Specs\n\nKeep one spec.\n\n' +
          link +
          '\n',
      ),
    );
    const link2 = format.backLinkFor(e, { line: 378 }, EDITION_DIR);
    const body2 = format.appendSection(
      body1,
      '## 8. Retrieval\n\nRead less.',
      link2,
    );
    assert.ok(body2.startsWith(body1.replace(/\s+$/, '')), 'append only');
    assert.deepStrictEqual(format.sectionHeadingsIn(body2), [
      '7. Specs, ADRs, constitution',
      '8. Retrieval',
    ]);
    // A `##` inside a fence is not a unit heading.
    const fenced = format.appendSection(
      body2,
      '## 9. Ladder\n\n```md\n## not a heading\n```\n',
      link2,
    );
    assert.deepStrictEqual(format.sectionHeadingsIn(fenced), [
      '7. Specs, ADRs, constitution',
      '8. Retrieval',
      '9. Ladder',
    ]);
  });

  test('splitBody gives the frame and each done section without its back link (§9.8 Rebuild)', function () {
    const e = edition({
      sections: [
        section(1, '7. Specs, ADRs, constitution', { status: 'done' }),
        section(2, '8. Retrieval', { status: 'queued', line: 378 }),
        section(3, '9. Enforcement ladder', { status: 'done', line: 421 }),
      ],
    });
    const link1 = format.backLinkFor(e, e.sections[0], EDITION_DIR);
    const link3 = format.backLinkFor(e, e.sections[2], EDITION_DIR);
    const part1 =
      '## 7. Specs, ADRs, constitution\n\n### Specs\n\nKeep one spec.\n\n```md\n## 8. Retrieval\n```';
    const part3 = '## 9. Enforcement ladder\n\nFrom strongest to weakest.';
    let body = format.appendSection(e.body, part1, link1);
    body = format.appendSection(body, part3, link3);
    const split = format.splitBody(body, e.sections);
    assert.strictEqual(split.frame, e.body.replace(/\s+$/, ''));
    assert.deepStrictEqual(split.parts, [part1, null, part3]);
    // The heading is matched without emphasis or case; a missing one is null.
    const shifted = format.splitBody(
      body.replace('## 9. Enforcement ladder', '## *9. Enforcement LADDER*'),
      e.sections,
    );
    assert.strictEqual(
      shifted.parts[2],
      '## *9. Enforcement LADDER*\n\nFrom strongest to weakest.',
    );
    const missing = format.splitBody(
      body.replace('## 9. Enforcement ladder', '## 9. Something else'),
      e.sections,
    );
    assert.strictEqual(missing.parts[2], null);
    assert.strictEqual(missing.parts[0].startsWith(part1), true);
    // With nothing written yet the whole body is the frame.
    const empty = format.splitBody(e.body, e.sections);
    assert.strictEqual(empty.frame, e.body.replace(/\s+$/, ''));
    assert.deepStrictEqual(empty.parts, [null, null, null]);
  });

  test('placeSection puts a re-called section back in its place, and appends when nothing done follows (§9.8 Rebuild)', function () {
    const e = edition({
      sections: [
        section(1, '7. Specs, ADRs, constitution', { status: 'done' }),
        section(2, '8. Retrieval', { status: 'writing', line: 378 }),
        section(3, '9. Enforcement ladder', { status: 'done', line: 421 }),
      ],
    });
    const linkOf = (index) =>
      format.backLinkFor(e, e.sections[index], EDITION_DIR);
    const part1 =
      '## 7. Specs, ADRs, constitution\n\n### Specs\n\nKeep one spec.\n\n```md\n## 8. Retrieval\n```';
    const part2 = '## 8. Retrieval\n\nRead less.';
    const part3 = '## 9. Enforcement ladder\n\nFrom strongest to weakest.';
    let body = format.appendSection(e.body, part1, linkOf(0));
    body = format.appendSection(body, part3, linkOf(2));
    // Section 2 between two done sections goes between them, every part
    // keeping its own back link.
    const placed = format.placeSection(body, e.sections, 2, part2, linkOf);
    let expected = format.appendSection(e.body, part1, linkOf(0));
    expected = format.appendSection(expected, part2, linkOf(1));
    expected = format.appendSection(expected, part3, linkOf(2));
    assert.strictEqual(placed, expected);
    assert.deepStrictEqual(format.sectionHeadingsIn(placed), [
      '7. Specs, ADRs, constitution',
      '8. Retrieval',
      '9. Enforcement ladder',
    ]);
    // The next Rebuild finds all three in order.
    const done = e.sections.map((s) => ({ ...s, status: 'done' }));
    assert.deepStrictEqual(format.splitBody(placed, done).parts, [
      part1,
      part2,
      part3,
    ]);
    // With no done section after it, a plain append (the first build's path).
    const first = format.appendSection(e.body, part1, linkOf(0));
    const appended = format.placeSection(
      first,
      [e.sections[0], e.sections[1], { ...e.sections[2], status: 'queued' }],
      2,
      part2,
      linkOf,
    );
    assert.strictEqual(appended, format.appendSection(first, part2, linkOf(1)));
    // A done section whose heading is not in the body: nothing is dropped,
    // the section is appended instead.
    const broken = body.replace('## 9. Enforcement ladder', '## 9. Elsewhere');
    const kept = format.placeSection(broken, e.sections, 2, part2, linkOf);
    assert.strictEqual(kept, format.appendSection(broken, part2, linkOf(1)));
  });

  test('the preamble unit is written one level deeper, so the file has one h1', function () {
    assert.strictEqual(format.writtenLevelOffset({ level: 1 }), 1);
    assert.strictEqual(format.writtenLevelOffset({ level: 2 }), 0);
    assert.strictEqual(format.writtenLevelOffset({ level: 3 }), 0);
    assert.strictEqual(format.writtenLevelOf({ level: 1 }), 2);
    assert.strictEqual(format.writtenLevelOf({ level: 2 }), 2);
    const e = edition({
      sections: [
        section(1, 'Agent-Ready Repos', { level: 1, line: 1, status: 'done' }),
        section(2, '1. Why', { status: 'done', line: 20 }),
      ],
    });
    let body = format.appendSection(
      e.body,
      '## Agent-Ready Repos\n\nThe preamble.',
      format.backLinkFor(e, e.sections[0], EDITION_DIR),
    );
    body = format.appendSection(
      body,
      '## 1. Why\n\nBecause.',
      format.backLinkFor(e, e.sections[1], EDITION_DIR),
    );
    const split = format.splitBody(body, e.sections);
    assert.deepStrictEqual(split.parts, [
      '## Agent-Ready Repos\n\nThe preamble.',
      '## 1. Why\n\nBecause.',
    ]);
    assert.strictEqual((body.match(/^# /gm) || []).length, 1, 'one h1');
  });

  test('previewSummary, minutesOf at 142 and unitStates', function () {
    const e = edition({
      status: 'done',
      sections: [
        section(1, '7. Specs, ADRs, constitution', {
          status: 'done',
          actual: 1545,
          flagged: ['sentence-length'],
        }),
        section(2, '8. Retrieval', { status: 'queued', line: 378 }),
      ],
    });
    assert.strictEqual(format.minutesOf(e), 11, '1545 / 142');
    assert.strictEqual(format.minutesOf({ sections: [] }), 0);
    assert.strictEqual(
      format.minutesOf({ sections: [section(1, 'x', { actual: 10 })] }),
      1,
      'never 0 once something is written',
    );
    const summary = format.previewSummary(e);
    assert.deepStrictEqual(summary, {
      id: e.id,
      // Two sections in selection scope: the document names the edition.
      title: 'Agent-Ready Repos: the spoken edition',
      created: e.created,
      status: 'done',
      sections: 2,
      done: 1,
      minutes: 11,
      anchors: [e.sections[0].anchor, e.sections[1].anchor],
      headings: ['Agent-Ready Repos'],
      documentTitle: 'Agent-Ready Repos',
      unitHeadings: ['7. Specs, ADRs, constitution', '8. Retrieval'],
    });
    // The title follows the body's h1 when one is there.
    const renamed = format.previewSummary(
      edition({ body: '# My own title\n\nText.\n' }),
    );
    assert.strictEqual(renamed.title, 'My own title');
    assert.deepStrictEqual(format.unitStates(e, new Set([1])), [
      {
        n: 1,
        heading: '7. Specs, ADRs, constitution',
        status: 'done',
        flagged: ['sentence-length'],
        cached: true,
      },
      {
        n: 2,
        heading: '8. Retrieval',
        status: 'queued',
        flagged: [],
        cached: false,
      },
    ]);
    assert.strictEqual(format.unitStates(e)[0].cached, false);
  });

  test("the classroom's own backLink cases stay green over the generalisation", async function () {
    const classroom = await compileEntry(
      'src/classroom/module-format.ts',
      path.join(__dirname, '.edition-format-classroom.bundle.cjs'),
    );
    try {
      assert.strictEqual(
        classroom.backLink({ absolute: ABSOLUTE, line: 393 }, EDITION_DIR),
        '[Back to the passage](' + BACK + '#L393)',
      );
      assert.strictEqual(
        classroom.backLink(
          { absolute: ABSOLUTE, line: 208 },
          EDITION_DIR,
          'Back to the section',
        ),
        '[Back to the section](' + BACK + '#L208)',
      );
      assert.strictEqual(
        classroom.relativeLink('/ws/notes', '/ws/docs/my file.md'),
        '../docs/my%20file.md',
      );
    } finally {
      fs.unlinkSync(
        path.join(__dirname, '.edition-format-classroom.bundle.cjs'),
      );
    }
  });
});
