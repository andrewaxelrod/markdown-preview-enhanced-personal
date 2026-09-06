/* global suite, test, suiteSetup, suiteTeardown */

/**
 * `src/notes/note-prompt.ts` (`featrues/12-notes/spec.md` §8, §21).
 *
 * The prompt is help's material with a different system prompt and task line,
 * so the first test pins the material byte for byte to `buildMaterial`. The
 * rest drive the tolerant skeleton parser: the file is written whatever the
 * model returns, so every fallback of §8.3 has a case.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

let prompt;
let help;
let promptFile;
let helpFile;

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

function fields(overrides) {
  return Object.assign(
    {
      title: 'The Title',
      breadcrumb: ['Chapter', 'Section'],
      before: 'before text',
      after: 'after text',
      section: 'section [PASSAGE] text',
      enclosing: 'the ⟦passage text⟧ in its sentence',
      mentions: '',
      passage: 'passage text that runs to more than five words',
      contextMode: 'section',
    },
    overrides,
  );
}

const PASSAGE = 'the eligible block before the first selected block';

const WELL_FORMED = [
  '# Before: the neighbouring block',
  '',
  '## Summary',
  'Every help request carries the readable block immediately before the selection.',
  '',
  '## Why it matters',
  'Without it the model answered about words it had never seen.',
  '',
  '## Terms',
  '- **Eligible block**: a paragraph, list or quote the reader would read aloud.',
  '- **Selection**: the words the reader marked.',
  '',
  'Tags: help, context, prompt',
].join('\n');

suite('notes/note-prompt', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    promptFile = path.join(__dirname, '.note-prompt.bundle.cjs');
    helpFile = path.join(__dirname, '.help-prompt.bundle.cjs');
    prompt = await compile(
      path.join(__dirname, '..', '..', 'src', 'notes', 'note-prompt.ts'),
      promptFile,
    );
    help = await compile(
      path.join(__dirname, '..', '..', 'src', 'read-aloud', 'help-prompt.ts'),
      helpFile,
    );
  });

  suiteTeardown(function () {
    for (const file of [promptFile, helpFile]) {
      if (file && fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  });

  suite('the request', function () {
    test("the material is exactly help's for the same fields", function () {
      const f = fields();
      const request = prompt.buildNoteRequest(f);
      const material = help.buildMaterial(f);
      assert.ok(
        request.startsWith(material + '\n\n'),
        'material first, byte for byte',
      );
      assert.ok(
        request.includes(
          '<enclosing>\nthe ⟦passage text⟧ in its sentence\n</enclosing>',
        ),
      );
    });

    test('a passage gets "Write the note." at 100 / 130 words', function () {
      const request = prompt.buildNoteRequest(fields());
      assert.ok(
        request.endsWith(
          'Write the note. About 100 words, never more than 130.',
        ),
        request.slice(-80),
      );
    });

    test('a term gets "Write the note for the term." at 90 / 120 words', function () {
      const request = prompt.buildNoteRequest(
        fields({ passage: 'the metrics' }),
      );
      assert.ok(
        request.endsWith(
          'Write the note for the term. About 90 words, never more than 120.',
        ),
        request.slice(-80),
      );
    });

    test('selection mode sends title, headings, enclosing and passage only', function () {
      const request = prompt.buildNoteRequest(
        fields({ contextMode: 'selection' }),
      );
      assert.ok(!request.includes('<before>'));
      assert.ok(!request.includes('<section>'));
      assert.ok(request.includes('<enclosing>'));
      assert.ok(request.includes('<passage>'));
    });

    test('the system prompt names the audience and the two shapes, and escapes <', function () {
      const system = prompt.buildNoteSystemPrompt('a <reader> of specs');
      assert.ok(system.includes('The audience is a ‹reader> of specs.'));
      assert.ok(
        system.includes(
          'When the request says "Write the note", answer in exactly this shape',
        ),
      );
      assert.ok(
        system.includes('When the request says "Write the note for the term"'),
      );
      assert.ok(system.includes('## What it means here'));
      assert.ok(system.includes('Tags: two to five lowercase tags'));
      assert.ok(system.includes('write for the eye'));
      assert.ok(!system.includes('{audience}'));
    });

    test("an empty audience falls back to help's default", function () {
      assert.ok(
        prompt
          .buildNoteSystemPrompt('   ')
          .includes(`The audience is ${help.DEFAULT_HELP_AUDIENCE}.`),
      );
    });

    test('NOTE_PROMPT_VERSION is 1', function () {
      assert.strictEqual(prompt.NOTE_PROMPT_VERSION, 1);
    });
  });

  suite('parseNoteAnswer', function () {
    test('a well-formed answer', function () {
      const parts = prompt.parseNoteAnswer(WELL_FORMED, PASSAGE);
      assert.strictEqual(parts.title, 'Before: the neighbouring block');
      assert.strictEqual(parts.titleFallback, false);
      assert.strictEqual(
        parts.sections.get('Summary'),
        'Every help request carries the readable block immediately before the selection.',
      );
      assert.strictEqual(
        parts.sections.get('Why it matters'),
        'Without it the model answered about words it had never seen.',
      );
      assert.ok(parts.sections.get('Terms').startsWith('- **Eligible block**'));
      assert.deepStrictEqual(parts.tags, ['help', 'context', 'prompt']);
      assert.deepStrictEqual(parts.extras, []);
    });

    test('the term shape', function () {
      const parts = prompt.parseNoteAnswer(
        [
          '# Metrics: the numbers the harness collects',
          '## What it means here',
          'In this sentence, the metrics are the counts the harness keeps.',
          '## In general',
          'The document does not define it; in general it means measured quantities.',
          '## Terms',
          'None.',
          'Tags: metrics, harness',
        ].join('\n'),
        'the metrics',
      );
      assert.strictEqual(
        parts.title,
        'Metrics: the numbers the harness collects',
      );
      assert.ok(parts.sections.has('What it means here'));
      assert.ok(parts.sections.has('In general'));
      assert.ok(
        !parts.sections.has('Terms'),
        'a lone None. is an absent section',
      );
      assert.ok(!parts.sections.has('Summary'));
      assert.deepStrictEqual(parts.tags, ['metrics', 'harness']);
    });

    test('Tags: variants — bold, capitals, hashes, semicolons, more than five', function () {
      for (const line of [
        '**Tags:** Help, Context; #prompt, Two Words, five, six, seven',
        'TAGS: help, context, prompt, two words, five, six',
        'tags - help, context, prompt, two-words, five, six',
      ]) {
        const parts = prompt.parseNoteAnswer(
          `# T\n\n## Summary\nS.\n\n${line}`,
          PASSAGE,
        );
        assert.strictEqual(parts.tags.length, 5, line);
        assert.deepStrictEqual(
          parts.tags.slice(0, 4),
          ['help', 'context', 'prompt', 'two-words'],
          line,
        );
      }
    });

    test('the last Tags: line wins and is never part of a section', function () {
      const parts = prompt.parseNoteAnswer(
        '# T\n\n## Summary\nTags: not, these\nReal text.\n\n## Terms\nNone\n\nTags: real, ones',
        PASSAGE,
      );
      assert.deepStrictEqual(parts.tags, ['real', 'ones']);
      assert.strictEqual(
        parts.sections.get('Summary'),
        'Tags: not, these\nReal text.',
      );
    });

    test('no tags line means no tags', function () {
      const parts = prompt.parseNoteAnswer('# T\n\n## Summary\nS.', PASSAGE);
      assert.deepStrictEqual(parts.tags, []);
    });

    test('a missing title falls back to the first eight words of the passage', function () {
      const parts = prompt.parseNoteAnswer(
        '## Summary\nS.\n\nTags: a',
        PASSAGE,
      );
      assert.strictEqual(
        parts.title,
        'the eligible block before the first selected block',
      );
      assert.strictEqual(parts.titleFallback, true);
      assert.strictEqual(parts.sections.get('Summary'), 'S.');
      const long = prompt.parseNoteAnswer(
        '## Summary\nS.',
        'one two three four five six seven eight nine ten',
      );
      assert.strictEqual(
        long.title,
        'one two three four five six seven eight…',
      );
    });

    test('title hygiene: trailing punctuation off, bold off, 120 characters', function () {
      const parts = prompt.parseNoteAnswer(
        `# **${'Long '.repeat(40).trim()}.**\n\n## Summary\nS.`,
        PASSAGE,
      );
      assert.ok(!parts.title.endsWith('.'));
      assert.ok(!parts.title.includes('*'));
      assert.ok(parts.title.length <= 120);
    });

    test('a missing section is absent, not empty', function () {
      const parts = prompt.parseNoteAnswer(
        '# T\n\n## Summary\nS.\n\nTags: a',
        PASSAGE,
      );
      assert.ok(!parts.sections.has('Why it matters'));
      assert.ok(!parts.sections.has('Terms'));
    });

    test('an unknown h2 is an extra, in order; headings tolerate case and colons', function () {
      const parts = prompt.parseNoteAnswer(
        [
          '# T',
          '## summary:',
          'S.',
          '## Open questions',
          'Q?',
          '## WHY IT MATTERS',
          'W.',
          '## Sources',
          'None known.',
          'Tags: a',
        ].join('\n'),
        PASSAGE,
      );
      assert.ok(parts.sections.has('Summary'));
      assert.ok(parts.sections.has('Why it matters'));
      assert.deepStrictEqual(parts.extras, [
        { heading: 'Open questions', markdown: 'Q?' },
        { heading: 'Sources', markdown: 'None known.' },
      ]);
    });

    test('a bold line standing for a heading is accepted', function () {
      const parts = prompt.parseNoteAnswer(
        '# T\n\n**Summary**\nS.\n\n**Why it matters:**\nW.',
        PASSAGE,
      );
      assert.strictEqual(parts.sections.get('Summary'), 'S.');
      assert.strictEqual(parts.sections.get('Why it matters'), 'W.');
    });

    test('a fenced whole answer is unwrapped by normaliseHelpAnswer before parsing', async function () {
      const answerFile = path.join(__dirname, '.help-answer.bundle.cjs');
      const answer = await compile(
        path.join(__dirname, '..', '..', 'src', 'read-aloud', 'help-answer.ts'),
        answerFile,
      );
      try {
        const raw = '```markdown\n' + WELL_FORMED + '\n```';
        const parts = prompt.parseNoteAnswer(
          answer.normaliseHelpAnswer(raw),
          PASSAGE,
        );
        assert.strictEqual(parts.title, 'Before: the neighbouring block');
        assert.deepStrictEqual(parts.tags, ['help', 'context', 'prompt']);
      } finally {
        fs.unlinkSync(answerFile);
      }
    });

    test('nothing parsed: the whole answer becomes Summary and the title falls back', function () {
      const parts = prompt.parseNoteAnswer(
        'The passage says the block before the selection travels with it.\n\nTags: block',
        PASSAGE,
      );
      assert.strictEqual(parts.titleFallback, true);
      assert.strictEqual(
        parts.sections.get('Summary'),
        'The passage says the block before the selection travels with it.',
      );
      assert.deepStrictEqual(parts.tags, ['block']);
      assert.deepStrictEqual(parts.extras, []);
    });

    test('an empty answer yields the fallback title and no sections', function () {
      const parts = prompt.parseNoteAnswer('', PASSAGE);
      assert.strictEqual(parts.titleFallback, true);
      assert.strictEqual(parts.sections.size, 0);
    });
  });
});
