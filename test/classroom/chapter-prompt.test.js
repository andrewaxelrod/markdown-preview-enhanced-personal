/* global suite, test, suiteSetup, suiteTeardown */

/**
 * `src/classroom/chapter-prompt.ts` (`featrues/13-classroom/spec.md` §9.3,
 * §9.6, §21.3–§21.5): the first chapter's brief (the reader's situation), a
 * middle chapter's (the previous bridge verbatim, the next question, the
 * promises due and the registries), the return chapter's, the retry with the
 * draft and the named rules, and the ledger skeleton present once.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { compileEntry, fixture } = require('./compile');

let chapter;
let planModule;
let ledgerModule;
let tmpFiles = [];

const PASSAGE =
  'Then the human path, and it is, in the end, the same path a human author would walk. A maintainer checks that the diff matches the issue. The pipeline and governance checks run.';

suite('classroom/chapter-prompt', function () {
  this.timeout(30000);

  let plan;

  suiteSetup(async function () {
    const a = path.join(__dirname, '.chapter-prompt.bundle.cjs');
    const b = path.join(__dirname, '.chapter-prompt-plan.bundle.cjs');
    const c = path.join(__dirname, '.chapter-prompt-ledger.bundle.cjs');
    tmpFiles = [a, b, c];
    chapter = await compileEntry('src/classroom/chapter-prompt.ts', a);
    planModule = await compileEntry('src/classroom/plan-prompt.ts', b);
    ledgerModule = await compileEntry('src/classroom/ledger.ts', c);
    plan = planModule.parsePlan(
      fixture('plan-answer.md'),
      2,
      [5, 6],
      PASSAGE,
    ).plan;
  });

  suiteTeardown(function () {
    for (const file of tmpFiles) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  });

  function brief(n, overrides) {
    const index = n - 1;
    return Object.assign(
      {
        plan,
        chapter: plan.chapters[index],
        level: 2,
        readerNote: "I don't get who approves what.",
        document: {
          title: 'Module 1: The Governed Harness',
          breadcrumb: ['The Governed Path: From Issue to Merge'],
        },
        passage: PASSAGE,
        previousBridge:
          index === 0
            ? null
            : 'So let us start with the people. Why does more than one have to sign?',
        next: plan.chapters[index + 1] || null,
        ledger: ledgerModule.emptyLedger(),
        promisesDue: [],
        target: plan.chapters[index].words,
        ceiling: planModule.ceilingFor(plan.chapters[index].type),
      },
      overrides || {},
    );
  }

  test("the first chapter's brief opens from the reader's situation", function () {
    const text = chapter.buildChapterRequest(brief(1));
    assert.ok(
      text.startsWith(
        'The module plan below was agreed. Write chapter 1 only, in full, as markdown prose',
      ),
    );
    assert.ok(text.includes('Follow the chapter template: the pickup,'));
    assert.ok(
      text.includes('Word target: about 250 words,\nnever more than 350.'),
    );
    assert.ok(
      text.includes('<plan>\n' + planModule.serializePlan(plan) + '\n</plan>'),
    );
    assert.ok(
      text.includes('This chapter: 1. Module Introduction | Question:'),
    );
    assert.ok(
      text.includes(
        'This is the first chapter. Open from the reader\'s situation: they were\nreading "Module 1: The Governed Harness" under "The Governed Path: From Issue to Merge", stopped at the passage that begins\n"Then the human path, and it is, in the end, the same path a human author would walk.", and said, in their words: "I don\'t get who approves what."',
      ),
    );
    assert.ok(
      text.includes(
        'level 2 of 3: I understand the words, not how it fits together. There is no previous section or module: this module stands\nalone.',
      ),
    );
    assert.ok(
      text.includes(
        "Next chapter's question, to hand over in the bridge: 2. Who Is a Code Owner, And Why Do Several People Have to Say Yes: Why do the risk-engineering owner",
      ),
    );
    assert.ok(text.includes('Promises due in this chapter: none'));
    assert.ok(
      text.includes(
        'Example registry (reuse before inventing; mark a callback when reusing): The RSK-142 ticket',
      ),
      'the plan example seeds the registry',
    );
    assert.ok(
      text.includes(
        'Terms glossed so far (gloss each again on first use in this chapter, in the same words):\nnone',
      ),
    );
    assert.ok(
      text.includes(
        'Analogy registry (one analogy per concept; never a second): none',
      ),
    );
    assert.ok(!text.includes('Previous chapter'));
    assert.strictEqual(
      text.split(chapter.LEDGER_SKELETON).length - 1,
      1,
      'the skeleton once',
    );
    assert.ok(text.endsWith(chapter.LEDGER_SKELETON));
  });

  test("a middle chapter's brief carries the bridge verbatim, the next question, the promises and the registries", function () {
    const ledger = ledgerModule.mergeLedger(
      ledgerModule.emptyLedger(),
      {
        promises: [
          { text: 'why the merge button becomes clickable', due: 3 },
          { text: 'what OIDC does', due: 5 },
        ],
        examples: [{ name: 'RSK-142', standsFor: 'one ticket end to end' }],
        terms: [{ term: 'code owner', gloss: 'the person who reviews a path' }],
        analogies: [{ concept: 'CODEOWNERS', analogy: 'a sign, not a lock' }],
        found: true,
      },
      2,
    );
    const due = ledgerModule.promisesDue(ledger, 3);
    assert.deepStrictEqual(
      due.map((p) => p.text),
      ['why the merge button becomes clickable'],
    );
    const text = chapter.buildChapterRequest(
      brief(3, { ledger, promisesDue: due }),
    );
    assert.ok(text.includes('Write chapter 3 only'));
    assert.ok(
      text.includes(
        "Previous chapter's closing bridge, verbatim; open by echoing it:\nSo let us start with the people. Why does more than one have to sign?",
      ),
    );
    assert.ok(
      text.includes(
        "Next chapter's question, to hand over in the bridge: 4. A Merge Is Not a Deploy: Why does the code getting merged",
      ),
    );
    assert.ok(
      text.includes(
        'Promises due in this chapter: why the merge button becomes clickable (made in chapter 2)',
      ),
    );
    assert.ok(
      text.includes(
        'Example registry (reuse before inventing; mark a callback when reusing): RSK-142: one ticket end to end',
      ),
    );
    assert.ok(text.includes('code owner: the person who reviews a path'));
    assert.ok(text.includes('CODEOWNERS: a sign, not a lock'));
    assert.ok(!text.includes('This is the first chapter'));
    assert.ok(!text.includes('This is the last chapter'));
  });

  test("the return chapter's brief replaces the template with §21.5 and repeats the passage", function () {
    const text = chapter.buildChapterRequest(brief(6));
    assert.ok(text.includes('Write chapter 6 only'));
    assert.ok(
      text.includes(
        'This is the return chapter. Open by picking up the previous bridge, then take the passage\nbelow one sentence at a time, in order.',
      ),
    );
    assert.ok(text.includes('Do not quote the passage verbatim.'));
    assert.ok(text.includes('<passage>\n' + PASSAGE + '\n</passage>'));
    assert.ok(!text.includes('Follow the chapter template'));
    assert.ok(
      text.includes('Word target: about 600 words,\nnever more than 900.'),
    );
    assert.ok(text.includes('This is the last chapter.'));
    assert.strictEqual(chapter.buildReturnRequest(brief(6)), text);
  });

  test('the retry request appends the draft and the named rules with their texts', function () {
    const draft =
      '## Who Is a Code Owner\n\nA draft — with an em dash and `code`.';
    const text = chapter.buildRetryRequest(
      brief(2),
      draft,
      [
        { code: 'em-dash' },
        { code: 'inline-code' },
        { code: 'length-target', detail: '720' },
      ],
      720,
    );
    assert.ok(text.startsWith(chapter.buildChapterRequest(brief(2))));
    assert.ok(
      text.includes(
        'Your previous draft of this chapter is below. It failed these checks:\n- em-dash: contains an em dash; punctuate with commas, colons or a new sentence\n- inline-code: contains inline code; say identifiers in words\n- length-target: is longer than the target of about 500 words\n',
      ),
    );
    assert.ok(
      text.includes(
        'Rewrite the whole chapter so that every check passes, keeping what was good.',
      ),
    );
    assert.ok(text.endsWith('<draft>\n' + draft + '\n</draft>'));
  });

  test('every field value has its < escaped before it is placed', function () {
    const text = chapter.buildChapterRequest(
      brief(2, {
        previousBridge: 'A bridge with <tag> inside.',
        readerNote: '<script>',
      }),
    );
    assert.ok(text.includes('A bridge with ‹tag> inside.'));
    assert.ok(!/<tag>/.test(text));
  });
});
