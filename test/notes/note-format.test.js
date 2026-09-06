/* global suite, test, suiteSetup, suiteTeardown */

/**
 * `src/notes/note-format.ts` (`featrues/12-notes/spec.md` §6, §17).
 *
 * The codec is the contract every other notes module writes to, so the two
 * round trips are the tests that matter: `parse(serialize(x))` equals `x` for
 * every field the codec owns, and `serialize(parse(t))` equals `t` for a file
 * the store wrote. Around them: the blockquote guard for a passage that looks
 * like structure, hand edits that survive, and the unreadable inputs.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let format;
let tmpFile;

function note(overrides) {
  const base = {
    id: '20260905T154210Z-7f3a',
    created: '2026-09-05T15:42:10Z',
    updated: '2026-09-05T15:42:16Z',
    shape: 'passage',
    titleEdited: false,
    document: {
      workspace: 'markdown-viewer',
      path: 'featrues/04-help-module.md',
      absolute: '/Users/andrew/x/featrues/04-help-module.md',
      title: '04 - Help: explain the selection with a headless LLM',
      headings: ['3. The prompt', '3.1 What is sent'],
      git: { remote: '', commit: '3f5a616196f9c66608422c5829b41f9e3ee33258' },
    },
    anchor: {
      block: 'b3f9a1c2',
      line: 76,
      exact: 'the eligible block before the first selected block',
      prefix: '| Before | ',
      suffix: ', extracted with `core.extractText`',
      offset: 11,
      blocks: 1,
      lastSeen: '2026-09-05T15:42:10Z',
    },
    generated: {
      status: 'done',
      source: 'engine',
      engine: 'claude',
      model: 'sonnet',
      effort: 'low',
      prompt: 1,
      at: '2026-09-05T15:42:16Z',
    },
    tags: ['help', 'context', 'prompt'],
    unknown: {},
    title: 'Before: the neighbouring block a passage travels with',
    passage: 'the eligible block before the first selected block',
    sections: new Map([
      [
        'Summary',
        'Every help request carries the readable block immediately before the selection.',
      ],
      [
        'Why it matters',
        'Without it the model answered about words it had never seen in their sentence.',
      ],
      [
        'Terms',
        '- **Eligible block**: a paragraph, list or quote the reader would read aloud.',
      ],
    ]),
    extras: [],
    myNote: '',
    context: {
      enclosing:
        '| Before | ⟦the eligible block before the first selected block⟧, extracted with `core.extractText` | 1,500 chars |',
      before:
        'The selection alone is not enough: the example passage leans on terms …',
      after:
        '`readAloudHelpContext = selection` sends title, breadcrumb and passage only.',
    },
  };
  return Object.assign(base, overrides || {});
}

suite('notes/note-format', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    const result = await esbuild.build({
      entryPoints: [
        path.join(__dirname, '..', '..', 'src', 'notes', 'note-format.ts'),
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      external: ['vscode', 'crossnote'],
    });
    tmpFile = path.join(__dirname, '.note-format.bundle.cjs');
    fs.writeFileSync(tmpFile, result.outputFiles[0].text);
    format = require(tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  suite('round trips', function () {
    test('parse(serialize(x)) equals x for every owned field', function () {
      const original = note();
      const text = format.serializeNoteFile(original);
      const parsed = format.parseNoteFile(text);
      assert.ok(!format.isParseError(parsed), JSON.stringify(parsed));
      assert.deepStrictEqual(parsed, original);
    });

    test('serialize(parse(t)) equals t for a file the store wrote', function () {
      const text = format.serializeNoteFile(note());
      const again = format.serializeNoteFile(format.parseNoteFile(text));
      assert.strictEqual(again, text);
    });

    test('the body is in the fixed order', function () {
      const text = format.serializeNoteFile(note({ myNote: 'Mine.' }));
      const order = [
        '\n# Before',
        '\n> the eligible',
        '\n## Summary',
        '\n## Why it matters',
        '\n## Terms',
        '\n## My note\n\nMine.',
        '\n## Context',
        '\n**Enclosing**',
        '\n**Before**',
        '\n**After**',
      ];
      let at = -1;
      for (const marker of order) {
        const next = text.indexOf(marker, at + 1);
        assert.ok(next > at, `${JSON.stringify(marker)} after ${at}`);
        at = next;
      }
      assert.ok(text.startsWith('---\nid: 20260905T154210Z-7f3a\n'));
    });

    test('the front matter is two-space YAML with the title and tags where the spec puts them', function () {
      const text = format.serializeNoteFile(note());
      assert.ok(!/^title:/m.test(text), 'title is the h1 only');
      assert.ok(/\ntags:\n  - help\n  - context\n  - prompt\n/.test(text));
      assert.ok(/\ndocument:\n  workspace: markdown-viewer\n/.test(text));
      assert.ok(/\n  headings:\n    - 3\. The prompt\n/.test(text));
      assert.ok(/\nanchor:\n  block: b3f9a1c2\n  line: 76\n/.test(text));
    });
  });

  suite('blockquotes guard the copied text', function () {
    for (const passage of [
      '# Not a heading',
      '---',
      '> already quoted',
      '## My note',
      'two\nlines',
    ]) {
      test(`a passage of ${JSON.stringify(passage)} comes back verbatim`, function () {
        const original = note({
          passage,
          anchor: { ...note().anchor, exact: passage },
        });
        const parsed = format.parseNoteFile(format.serializeNoteFile(original));
        assert.ok(!format.isParseError(parsed));
        assert.strictEqual(parsed.passage, passage);
        assert.strictEqual(parsed.title, original.title);
        assert.strictEqual(parsed.sections.size, 3);
      });
    }

    test('context strings beginning with # stay inside their quotes', function () {
      const original = note({
        context: { enclosing: '# fake\n## deeper', before: '---', after: '' },
      });
      const parsed = format.parseNoteFile(format.serializeNoteFile(original));
      assert.deepStrictEqual(parsed.context, original.context);
    });

    test('an empty passage still round-trips', function () {
      const original = note({ passage: '' });
      const parsed = format.parseNoteFile(format.serializeNoteFile(original));
      assert.strictEqual(parsed.passage, '');
      assert.strictEqual(
        parsed.sections.get('Summary'),
        original.sections.get('Summary'),
      );
    });
  });

  suite('sections', function () {
    test('the term shape has its two sections and no Why it matters', function () {
      const original = note({
        shape: 'term',
        sections: new Map([
          ['What it means here', 'Here it means the block.'],
          ['In general', 'In general, a block.'],
          ['Terms', 'None worth defining.'],
        ]),
      });
      const text = format.serializeNoteFile(original);
      assert.ok(text.includes('\n## What it means here\n'));
      assert.ok(text.includes('\n## In general\n'));
      assert.ok(!text.includes('Why it matters'));
      const parsed = format.parseNoteFile(text);
      assert.deepStrictEqual(parsed, original);
    });

    test('## Explanation is a known section and sorts after Terms', function () {
      const original = note({
        sections: new Map([['Explanation', '### What it says\nThe gates.']]),
        generated: { status: 'done', source: 'help' },
        tags: [],
      });
      const text = format.serializeNoteFile(original);
      assert.ok(
        text.includes('\n## Explanation\n\n### What it says\nThe gates.\n'),
      );
      const parsed = format.parseNoteFile(text);
      assert.deepStrictEqual(parsed, original);
    });

    test('an unknown h2 in the generated region is an extra and is written back', function () {
      const original = note({
        extras: [
          { heading: 'Open questions', markdown: 'Is it always one block?' },
        ],
      });
      const text = format.serializeNoteFile(original);
      assert.ok(
        text.includes(
          '\n## Open questions\n\nIs it always one block?\n\n## My note',
        ),
      );
      const parsed = format.parseNoteFile(text);
      assert.deepStrictEqual(parsed.extras, original.extras);
      assert.strictEqual(format.serializeNoteFile(parsed), text);
    });

    test('a hand-written extra between two known sections is kept', function () {
      const text = format
        .serializeNoteFile(note())
        .replace(
          '\n## Terms\n',
          '\n## Aside\n\nWritten by hand.\n\n## Terms\n',
        );
      const parsed = format.parseNoteFile(text);
      assert.deepStrictEqual(parsed.extras, [
        { heading: 'Aside', markdown: 'Written by hand.' },
      ]);
      assert.strictEqual(
        parsed.sections.get('Terms'),
        note().sections.get('Terms'),
      );
    });

    test('section headings match case-insensitively with a trailing colon', function () {
      const text = format
        .serializeNoteFile(note())
        .replace('## Summary', '## summary:')
        .replace('## Why it matters', '## WHY IT MATTERS');
      const parsed = format.parseNoteFile(text);
      assert.ok(parsed.sections.has('Summary'));
      assert.ok(parsed.sections.has('Why it matters'));
      assert.strictEqual(parsed.extras.length, 0);
    });
  });

  suite('My note and Context', function () {
    test('My note runs verbatim to ## Context, even when it contains ## lines', function () {
      const myNote =
        'First thought.\n\n## Not a section\n\nStill mine.\n\n- a list';
      const original = note({ myNote });
      const parsed = format.parseNoteFile(format.serializeNoteFile(original));
      assert.strictEqual(parsed.myNote, myNote);
      assert.strictEqual(parsed.extras.length, 0);
      assert.deepStrictEqual(parsed.context, original.context);
    });

    test('an empty My note is a heading with nothing under it', function () {
      const text = format.serializeNoteFile(note({ myNote: '' }));
      assert.ok(text.includes('\n## My note\n\n## Context\n'));
      assert.strictEqual(format.parseNoteFile(text).myNote, '');
    });

    test('a missing context part is absent, not an empty label', function () {
      const text = format.serializeNoteFile(
        note({ context: { enclosing: '', before: 'B', after: '' } }),
      );
      assert.ok(!text.includes('**Enclosing**'));
      assert.ok(!text.includes('**After**'));
      assert.ok(text.includes('**Before**\n\n> B\n'));
      assert.deepStrictEqual(format.parseNoteFile(text).context, {
        enclosing: '',
        before: 'B',
        after: '',
      });
    });
  });

  suite('front matter', function () {
    test('unknown keys are kept and written back unchanged', function () {
      const text = format
        .serializeNoteFile(note())
        .replace('\ntags:\n', '\ncolour: teal\nrating:\n  stars: 4\ntags:\n');
      const parsed = format.parseNoteFile(text);
      assert.deepStrictEqual(parsed.unknown, {
        colour: 'teal',
        rating: { stars: 4 },
      });
      const again = format.serializeNoteFile(parsed);
      assert.ok(again.includes('\ncolour: teal\n'));
      assert.ok(again.includes('\nrating:\n  stars: 4\n'));
      assert.deepStrictEqual(format.parseNoteFile(again), parsed);
    });

    test('anchor.current, missingSince and original survive', function () {
      const original = note({
        anchor: {
          ...note().anchor,
          current: { block: 'bdeadbeef', line: 80 },
          missingSince: '2026-09-06T10:00:00Z',
          original: { block: 'b3f9a1c2', line: 76 },
        },
      });
      const parsed = format.parseNoteFile(format.serializeNoteFile(original));
      assert.deepStrictEqual(parsed.anchor, original.anchor);
    });

    test('titleEdited is written only when true', function () {
      assert.ok(!format.serializeNoteFile(note()).includes('titleEdited'));
      const text = format.serializeNoteFile(note({ titleEdited: true }));
      assert.ok(text.includes('\ntitleEdited: true\n'));
      assert.strictEqual(format.parseNoteFile(text).titleEdited, true);
    });

    test('tags are normalised with the message caps', function () {
      const text = format
        .serializeNoteFile(note())
        .replace(
          '\ntags:\n  - help\n  - context\n  - prompt\n',
          '\ntags:\n  - Help\n  - "two words"\n  - "!!!"\n  - help\n  - ' +
            Array.from({ length: 40 }, () => 'x').join('') +
            '\n',
        );
      const parsed = format.parseNoteFile(text);
      assert.deepStrictEqual(parsed.tags, [
        'help',
        'two-words',
        Array.from({ length: 32 }, () => 'x').join(''),
      ]);
    });

    test('a hand-edited line that is negative or a string becomes null', function () {
      const text = format
        .serializeNoteFile(note())
        .replace('\n  line: 76\n', '\n  line: -3\n');
      assert.strictEqual(format.parseNoteFile(text).anchor.line, null);
    });
  });

  suite('unreadable inputs', function () {
    const cases = [
      ['no fence', '# Title\n\n> passage\n'],
      ['fence never closed', '---\nid: 20260905T154210Z-7f3a\n# Title\n'],
      ['bad YAML', '---\nid: [unclosed\n---\n\n# Title\n'],
      ['no id', '---\ncreated: 2026-09-05T15:42:10Z\n---\n\n# Title\n'],
      ['malformed id', '---\nid: note-1\n---\n\n# Title\n'],
      ['no h1', '---\nid: 20260905T154210Z-7f3a\n---\n\nJust prose.\n'],
      ['front matter is a list', '---\n- a\n- b\n---\n\n# Title\n'],
    ];
    for (const [name, text] of cases) {
      test(name, function () {
        const parsed = format.parseNoteFile(text);
        assert.ok(format.isParseError(parsed), name);
        assert.strictEqual(typeof parsed.error, 'string');
      });
    }

    test('a minimal readable file needs only an id and an h1', function () {
      const parsed = format.parseNoteFile(
        '---\nid: 20260905T154210Z-7f3a\n---\n\n# Title\n',
      );
      assert.ok(!format.isParseError(parsed));
      assert.strictEqual(parsed.title, 'Title');
      assert.strictEqual(parsed.passage, '');
      assert.strictEqual(parsed.generated.status, 'pending');
      assert.strictEqual(parsed.anchor.blocks, 1);
      assert.strictEqual(parsed.anchor.line, null);
      assert.deepStrictEqual(parsed.tags, []);
    });

    test('CRLF files parse like LF files', function () {
      const text = format.serializeNoteFile(note()).replace(/\n/g, '\r\n');
      const parsed = format.parseNoteFile(text);
      assert.ok(!format.isParseError(parsed));
      assert.strictEqual(parsed.title, note().title);
    });
  });

  suite('applyGenerated', function () {
    const parts = {
      title: 'A fresh title',
      titleFallback: false,
      sections: new Map([
        ['Summary', 'New summary.'],
        ['Why it matters', 'New why.'],
        ['Terms', '- **Block**: a block.'],
      ]),
      extras: [{ heading: 'Caveat', markdown: 'One caveat.' }],
      tags: ['fresh', 'Tags Here'],
    };

    test('replaces the title, the known sections and the tags', function () {
      const out = format.applyGenerated(note({ myNote: 'Mine' }), parts);
      assert.strictEqual(out.title, 'A fresh title');
      assert.strictEqual(out.sections.get('Summary'), 'New summary.');
      assert.strictEqual(out.sections.get('Terms'), '- **Block**: a block.');
      assert.deepStrictEqual(out.tags, ['fresh', 'tags-here']);
      assert.strictEqual(out.myNote, 'Mine', 'My note is kept');
      assert.deepStrictEqual(out.context, note().context, 'Context is kept');
      assert.deepStrictEqual(out.extras, parts.extras);
    });

    test('keeps a reader-edited title', function () {
      const out = format.applyGenerated(note({ titleEdited: true }), parts);
      assert.strictEqual(out.title, note().title);
    });

    test('keeps ## Explanation and drops the old term sections on a shape change', function () {
      const original = note({
        sections: new Map([
          ['What it means here', 'old'],
          ['In general', 'old'],
          ['Explanation', 'From help.'],
        ]),
      });
      const out = format.applyGenerated(original, parts);
      assert.strictEqual(out.sections.get('Explanation'), 'From help.');
      assert.ok(!out.sections.has('What it means here'));
      assert.ok(out.sections.has('Summary'));
    });

    test('a fallback title never overwrites a real one; empty tags keep the old ones', function () {
      const out = format.applyGenerated(note(), {
        ...parts,
        title: 'the eligible block before the first selected…',
        titleFallback: true,
        tags: [],
      });
      assert.strictEqual(out.title, note().title);
      assert.deepStrictEqual(out.tags, note().tags);
    });

    test('an existing extra with the same heading is replaced, others kept', function () {
      const original = note({
        extras: [
          { heading: 'Caveat', markdown: 'Old caveat.' },
          { heading: 'Aside', markdown: 'By hand.' },
        ],
      });
      const out = format.applyGenerated(original, parts);
      assert.deepStrictEqual(out.extras, [
        { heading: 'Aside', markdown: 'By hand.' },
        { heading: 'Caveat', markdown: 'One caveat.' },
      ]);
    });
  });

  suite('noteBodyForClipboard', function () {
    test('h1, passage, sections, My note when non-empty, then the location line', function () {
      const text = format.noteBodyForClipboard(note({ myNote: 'Mine.' }));
      assert.ok(
        text.startsWith(
          '# Before: the neighbouring block a passage travels with\n\n> the eligible',
        ),
      );
      assert.ok(text.includes('\n## Summary\n\nEvery help'));
      assert.ok(text.includes('\n## My note\n\nMine.\n'));
      assert.ok(!text.includes('## Context'));
      assert.ok(!text.includes('---\nid:'));
      assert.ok(
        text.endsWith(
          '— featrues/04-help-module.md › 3. The prompt › 3.1 What is sent\n',
        ),
      );
    });

    test('an empty My note is left out', function () {
      const text = format.noteBodyForClipboard(note());
      assert.ok(!text.includes('My note'));
    });
  });

  suite('helpers', function () {
    test('titleFromPassage takes eight words with an ellipsis when cut', function () {
      assert.strictEqual(
        format.titleFromPassage('one two three four five six seven eight nine'),
        'one two three four five six seven eight…',
      );
      assert.strictEqual(format.titleFromPassage('  a   b  '), 'a b');
      assert.strictEqual(format.titleFromPassage(''), 'Note');
    });

    test('summaryLineOf is the first sentence of the summary, unformatted', function () {
      assert.strictEqual(
        format.summaryLineOf({
          sections: new Map([
            ['Summary', '**Every** help request carries it. And more.'],
          ]),
        }),
        'Every help request carries it.',
      );
      assert.strictEqual(
        format.summaryLineOf({
          sections: new Map([['What it means here', 'Here it means x']]),
        }),
        'Here it means x',
      );
      assert.strictEqual(format.summaryLineOf({ sections: new Map() }), '');
    });

    test('normaliseTag rules', function () {
      assert.strictEqual(format.normaliseTag(' Two Words '), 'two-words');
      assert.strictEqual(format.normaliseTag('-lead'), 'lead');
      assert.strictEqual(format.normaliseTag('!!!'), null);
      assert.strictEqual(format.normaliseTag(42), null);
    });
  });
});
