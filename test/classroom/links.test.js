/* global suite, test, suiteSetup, suiteTeardown */

/**
 * `src/classroom/links.ts` (`featrues/13-classroom/spec.md` §8.2): markdown
 * links, wikilinks with aliases and fragments, images and schemes ignored,
 * the section-first order, de-duplication, the four-target cap and the
 * resolver's refusals through an injected resolver.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { compileEntry } = require('./compile');

let links;
let tmpFile;

const SOURCE = [
  '# Title',
  '',
  'Intro with [a guide](docs/guide.md) and an image ![pic](img/pic.md).',
  '',
  '## First section',
  '',
  'See [the spec](./spec.md "The spec") and [[Notes Page|alias]] and [[Other#heading]].',
  'Also [web](https://example.com/x.md), [mail](mailto:a@b.c), [[x.pdf]] and [not md](file.txt).',
  '',
  '```md',
  '[inside a fence](fenced.md)',
  '```',
  '',
  '### Sub of first',
  '',
  'A [deeper link](deep.md) still inside the first section.',
  '',
  '## Second section',
  '',
  'Back to [a guide](docs/guide.md) again, and [encoded](my%20file.md) and [[Notes Page]].',
  '',
].join('\n');

suite('classroom/links', function () {
  this.timeout(30000);

  suiteSetup(async function () {
    tmpFile = path.join(__dirname, '.links.bundle.cjs');
    links = await compileEntry('src/classroom/links.ts', tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  test('sectionRangeFor runs from the heading line to the next heading of the same or a higher level', function () {
    const range = links.sectionRangeFor(SOURCE, ['Title', 'First section']);
    assert.ok(range);
    assert.strictEqual(
      SOURCE.slice(range.start, range.start + 16),
      '## First section',
    );
    assert.strictEqual(
      SOURCE.slice(range.end, range.end + 17),
      '## Second section',
    );
    assert.ok(
      SOURCE.slice(range.start, range.end).includes('### Sub of first'),
      'a lower heading stays inside',
    );
    const last = links.sectionRangeFor(SOURCE, ['Second section']);
    assert.strictEqual(last.end, SOURCE.length);
    assert.strictEqual(links.sectionRangeFor(SOURCE, ['Nowhere']), null);
    assert.strictEqual(links.sectionRangeFor(SOURCE, []), null);
  });

  test('findLinks: section first, then the rest, de-duplicated, fragments stripped, the rest ignored', function () {
    const range = links.sectionRangeFor(SOURCE, ['First section']);
    const found = links.findLinks(SOURCE, range, ['.md', '.markdown']);
    assert.deepStrictEqual(
      found.map((l) => [l.target, l.kind, l.inSection]),
      [
        ['./spec.md', 'path', true],
        ['Notes Page', 'wikilink', true],
        ['Other', 'wikilink', true],
        ['deep.md', 'path', true],
        ['docs/guide.md', 'path', false],
        ['my file.md', 'path', false],
      ],
    );
    const targets = found.map((l) => l.target);
    assert.ok(!targets.includes('img/pic.md'), 'images ignored');
    assert.ok(
      !targets.some((t) => /^https?:|^mailto:/.test(t)),
      'schemes ignored',
    );
    assert.ok(
      !targets.includes('x.pdf') && !targets.includes('file.txt'),
      'other extensions ignored',
    );
    assert.ok(!targets.includes('fenced.md'), 'fences masked');
    assert.strictEqual(
      targets.filter((t) => t === 'docs/guide.md').length,
      1,
      'de-duplicated',
    );
  });

  test('without a section range every link is in order of appearance', function () {
    const found = links.findLinks(SOURCE, null, ['.md']);
    assert.deepStrictEqual(
      found.map((l) => l.target),
      [
        'docs/guide.md',
        './spec.md',
        'Notes Page',
        'Other',
        'deep.md',
        'my file.md',
      ],
    );
    assert.ok(found.every((l) => l.inSection === false));
  });

  test('resolveLinks keeps what the resolver accepts, never the same file twice, up to the cap', async function () {
    const found = links.findLinks(SOURCE, null, ['.md']);
    const asked = [];
    const resolved = await links.resolveLinks(
      found,
      async (link) => {
        asked.push(link.target);
        if (link.target === 'deep.md') {
          return null; // outside the workspace, or missing
        }
        if (link.target === 'Other') {
          throw new Error('resolver blew up');
        }
        const fsPath =
          link.target === './spec.md'
            ? '/ws/spec.md'
            : `/ws/${link.target.replace(/^\.\//, '')}`;
        return {
          fsPath: link.target === 'Notes Page' ? '/ws/docs/guide.md' : fsPath,
          relativePath: fsPath.slice(4),
        };
      },
      4,
    );
    assert.deepStrictEqual(
      resolved.map((l) => [l.target, l.fsPath]),
      [
        ['docs/guide.md', '/ws/docs/guide.md'],
        ['./spec.md', '/ws/spec.md'],
        ['my file.md', '/ws/my file.md'],
      ],
      'deep.md refused, Other threw, Notes Page resolved to a file already kept',
    );
    const many = Array.from({ length: 8 }, (_, i) => ({
      target: `f${i}.md`,
      kind: 'path',
      index: i,
      inSection: false,
    }));
    const capped = await links.resolveLinks(
      many,
      async (l) => ({ fsPath: `/ws/${l.target}`, relativePath: l.target }),
      4,
    );
    assert.strictEqual(capped.length, 4);
    assert.strictEqual(
      links.CLASSROOM_CAPS === undefined,
      true,
      'the cap comes from plan-prompt, not exported here',
    );
    assert.strictEqual(asked.length, found.length);
  });

  test('titleOfSource is the first h1, else the fallback', function () {
    assert.strictEqual(links.titleOfSource(SOURCE, 'x.md'), 'Title');
    assert.strictEqual(
      links.titleOfSource('no heading\n```\n# in a fence\n```\n', 'x.md'),
      'x.md',
    );
  });
});
