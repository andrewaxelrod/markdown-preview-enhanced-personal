/* global suite, test, suiteSetup, suiteTeardown */

/**
 * `src/classroom/ledger.ts` (`featrues/13-classroom/spec.md` §9.4): the
 * tolerant parser over the three layouts the experiment returned and the
 * skeleton the request now asks for, a missing block, the merge (keys, first
 * gloss kept, `paid` on the due chapter) and `promisesDue`.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { compileEntry, fixture } = require('./compile');

let ledger;
let checks;
let tmpFiles = [];

function ledgerOf(name) {
  return checks.splitLedger(fixture(name)).ledger;
}

suite('classroom/ledger', function () {
  this.timeout(30000);

  suiteSetup(async function () {
    const a = path.join(__dirname, '.ledger.bundle.cjs');
    const b = path.join(__dirname, '.ledger-checks.bundle.cjs');
    tmpFiles = [a, b];
    ledger = await compileEntry('src/classroom/ledger.ts', a);
    checks = await compileEntry('src/classroom/checks.ts', b);
  });

  suiteTeardown(function () {
    for (const file of tmpFiles) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  });

  test('the prose layout: "Promises made: none." and one example', function () {
    const parsed = ledger.parseLedger(ledgerOf('ch1-sonnet-medium.md'));
    assert.strictEqual(parsed.found, true);
    assert.deepStrictEqual(parsed.promises, []);
    assert.strictEqual(parsed.examples.length, 1);
    assert.strictEqual(parsed.examples[0].name, 'RSK-142');
    assert.ok(
      parsed.examples[0].standsFor.startsWith('the age-band factor ticket'),
    );
    assert.deepStrictEqual(parsed.terms, [], '"none in this chapter" is none');
    assert.deepStrictEqual(parsed.analogies, []);
  });

  test('the prose layout with semicolons: three terms glossed', function () {
    const parsed = ledger.parseLedger(ledgerOf('ch2-sonnet-medium.md'));
    assert.deepStrictEqual(parsed.promises, []);
    assert.strictEqual(parsed.examples.length, 1);
    assert.strictEqual(parsed.examples[0].name, 'RSK-142');
    assert.deepStrictEqual(
      parsed.terms.map((t) => t.term),
      ['code owner', 'CODEOWNERS file', 'ruleset'],
    );
    assert.strictEqual(
      parsed.terms[0].gloss,
      'the person or team responsible for reviewing changes to a given path',
    );
    assert.ok(
      parsed.terms[2].gloss.startsWith(
        'the branch policy that can turn code-owner review',
      ),
    );
  });

  test('the bold-label layout with bullets: promises with due chapters', function () {
    const parsed = ledger.parseLedger(ledgerOf('ch1-opus-medium.md'));
    assert.strictEqual(parsed.promises.length, 6);
    const clickable = parsed.promises.find((p) => /merge button/.test(p.text));
    assert.ok(clickable);
    assert.strictEqual(clickable.due, 3);
    assert.strictEqual(
      clickable.text,
      'Explain why the merge button becomes clickable',
    );
    const whole = parsed.promises.find((p) => /who approves what/.test(p.text));
    assert.strictEqual(
      whole.due,
      null,
      '"Due: whole section" names no chapter',
    );
    assert.strictEqual(parsed.examples.length, 2);
    assert.strictEqual(
      parsed.examples[0].name,
      'RSK-142, the age-band factor ticket'.split(',')[0],
    );
    assert.deepStrictEqual(
      parsed.terms,
      [],
      '"None glossed in full yet…" is none',
    );
  });

  test('the requested skeleton with ### headings and | due:', function () {
    const block = [
      '## Ledger',
      '### Promises',
      '- why the merge button becomes clickable | due: 3',
      '- a promise with no destination | due: none',
      '### Examples',
      '- RSK-142: one ticket from issue to production',
      '### Terms',
      '- code owner: the person or team responsible for a path',
      '### Analogies',
      '- CODEOWNERS: a sign, not a lock',
      '### Unknown',
      '- ignored',
    ].join('\n');
    const parsed = ledger.parseLedger(block);
    assert.deepStrictEqual(parsed.promises, [
      { text: 'why the merge button becomes clickable', due: 3 },
      { text: 'a promise with no destination', due: null },
    ]);
    assert.deepStrictEqual(parsed.examples, [
      { name: 'RSK-142', standsFor: 'one ticket from issue to production' },
    ]);
    assert.deepStrictEqual(parsed.terms, [
      {
        term: 'code owner',
        gloss: 'the person or team responsible for a path',
      },
    ]);
    assert.deepStrictEqual(parsed.analogies, [
      { concept: 'CODEOWNERS', analogy: 'a sign, not a lock' },
    ]);
  });

  test('a missing block yields four empty lists and found false', function () {
    for (const value of [null, undefined, '', '   ']) {
      const parsed = ledger.parseLedger(value);
      assert.strictEqual(parsed.found, false);
      assert.deepStrictEqual(parsed.promises, []);
      assert.deepStrictEqual(parsed.examples, []);
      assert.deepStrictEqual(parsed.terms, []);
      assert.deepStrictEqual(parsed.analogies, []);
    }
  });

  test('mergeLedger keys examples and analogies by name, keeps the first gloss, appends promises', function () {
    const one = ledger.mergeLedger(
      ledger.emptyLedger(),
      {
        promises: [{ text: 'why the button', due: 3 }],
        examples: [{ name: 'RSK-142', standsFor: 'the ticket' }],
        terms: [{ term: 'Code Owner', gloss: 'first gloss' }],
        analogies: [{ concept: 'CODEOWNERS', analogy: 'a sign' }],
        found: true,
      },
      1,
    );
    const two = ledger.mergeLedger(
      one,
      {
        promises: [{ text: 'what OIDC does', due: 5 }],
        examples: [
          { name: 'rsk-142', standsFor: 'again' },
          { name: 'The refund', standsFor: 'money back' },
        ],
        terms: [
          { term: 'code owner', gloss: 'second gloss' },
          { term: 'ruleset', gloss: 'the policy' },
        ],
        analogies: [{ concept: 'CODEOWNERS', analogy: 'a fence' }],
        found: true,
      },
      2,
    );
    assert.deepStrictEqual(two.promises, [
      { text: 'why the button', made: 1, due: 3, paid: false },
      { text: 'what OIDC does', made: 2, due: 5, paid: false },
    ]);
    assert.deepStrictEqual(two.examples, [
      { name: 'RSK-142', standsFor: 'the ticket', chapters: [1, 2] },
      { name: 'The refund', standsFor: 'money back', chapters: [2] },
    ]);
    assert.deepStrictEqual(two.terms, [
      { term: 'Code Owner', gloss: 'first gloss', chapter: 1 },
      { term: 'ruleset', gloss: 'the policy', chapter: 2 },
    ]);
    assert.deepStrictEqual(two.analogies, [
      { concept: 'CODEOWNERS', analogy: 'a sign', chapter: 1 },
    ]);
    assert.deepStrictEqual(one.promises.length, 1, 'the input is not touched');
  });

  test('promisesDue lists the due and the earlier unpaid; markPaid pays them on the due chapter', function () {
    const base = ledger.mergeLedger(
      ledger.emptyLedger(),
      {
        promises: [
          { text: 'due in 3', due: 3 },
          { text: 'due in 5', due: 5 },
          { text: 'no destination', due: null },
        ],
        examples: [],
        terms: [],
        analogies: [],
        found: true,
      },
      1,
    );
    assert.deepStrictEqual(
      ledger.promisesDue(base, 2).map((p) => p.text),
      [],
    );
    assert.deepStrictEqual(
      ledger.promisesDue(base, 3).map((p) => p.text),
      ['due in 3'],
    );
    assert.deepStrictEqual(
      ledger.promisesDue(base, 4).map((p) => p.text),
      ['due in 3'],
      'unpaid carries forward',
    );
    const paid = ledger.markPaid(base, 3);
    assert.deepStrictEqual(
      paid.promises.map((p) => p.paid),
      [true, false, false],
    );
    assert.deepStrictEqual(
      ledger.promisesDue(paid, 5).map((p) => p.text),
      ['due in 5'],
    );
    // A promise made in the due chapter itself is not due there.
    const self = ledger.mergeLedger(
      ledger.emptyLedger(),
      {
        promises: [{ text: 'now', due: 2 }],
        examples: [],
        terms: [],
        analogies: [],
        found: true,
      },
      2,
    );
    assert.deepStrictEqual(ledger.promisesDue(self, 2), []);
  });
});
