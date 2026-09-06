/* global suite, test, suiteSetup, suiteTeardown */

/**
 * `src/classroom/checks.ts` (`featrues/13-classroom/spec.md` §9.5): every
 * rule with a passing and a failing chapter, fences masked, the heading fix,
 * the echo with a verbatim pickup, a paraphrase with a question and a miss,
 * and the experiment's chapters against their briefs.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { compileEntry, fixture } = require('./compile');

let checks;
let tmpFile;

const BRIDGE =
  "So let's start with the people. Why does more than one of them have to sign off on the same pull request?";

function words(n, seed) {
  // Short sentences of seven words, each starting with a capital, so the
  // sentence splitter of the echo rule sees them as sentences.
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = seed || 'word';
    const word = i % 7 === 0 ? base[0].toUpperCase() + base.slice(1) : base;
    out.push(word + (i % 7 === 6 || i === n - 1 ? '.' : ''));
  }
  return out.join(' ');
}

function chapter(body, title) {
  return `## ${title || 'A Chapter'}\n\n${body}\n\n## Ledger\n### Promises\n- none\n`;
}

function brief(overrides) {
  return Object.assign(
    {
      title: 'A Chapter',
      type: 'concept',
      target: 500,
      ceiling: 700,
      previousBridge: null,
    },
    overrides || {},
  );
}

function codes(result) {
  return result.failures.map((f) => f.code);
}

suite('classroom/checks', function () {
  this.timeout(30000);

  suiteSetup(async function () {
    tmpFile = path.join(__dirname, '.checks.bundle.cjs');
    checks = await compileEntry('src/classroom/checks.ts', tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  test('a clean concept chapter passes, and the ledger is split off', function () {
    const result = checks.checkChapter(chapter(words(500)), brief());
    assert.strictEqual(result.ok, true, codes(result).join(','));
    assert.deepStrictEqual(result.fixes, []);
    assert.deepStrictEqual(result.notes, []);
    assert.strictEqual(result.words, 500);
    assert.ok(result.markdown.startsWith('## A Chapter\n\nWord word'));
    assert.ok(!result.markdown.includes('## Ledger'));
    assert.ok(result.ledger.startsWith('## Ledger'));
  });

  test('em-dash, table, link, inline-code, html and emoji each fail', function () {
    const cases = [
      ['em-dash', words(500) + ' a pause — and on.'],
      [
        'table',
        words(490) + '\n\n| a | b |\n| - | - |\n\ncontinued ' + words(8),
      ],
      ['table', words(500) + ' cells x | y | z in prose.'],
      ['link', words(500) + ' see [the post](https://x.y).'],
      ['link', words(500) + ' see <https://x.y>.'],
      ['link', words(500) + ' see [[Other Note]].'],
      ['inline-code', words(500) + ' the `CODEOWNERS` file.'],
      ['html', words(500) + ' a <b>bold</b> word.'],
      ['emoji', words(500) + ' done ✅.'],
    ];
    for (const [code, body] of cases) {
      const result = checks.checkChapter(chapter(body), brief());
      assert.deepStrictEqual(
        codes(result),
        [code],
        code + ': ' + codes(result).join(','),
      );
    }
  });

  test('fences are masked: an ascii figure passes, another tag fails, three figures are a note', function () {
    const figure =
      '\n\n```ascii\n| a | b |\n<not html> — fine here `code`\n```\n\n';
    const ok = checks.checkChapter(
      chapter(words(250) + figure + words(250)),
      brief(),
    );
    assert.strictEqual(ok.ok, true, codes(ok).join(','));
    const bad = checks.checkChapter(
      chapter(words(250) + '\n\n```python\nprint(1)\n```\n\n' + words(250)),
      brief(),
    );
    assert.deepStrictEqual(codes(bad), ['fence']);
    assert.strictEqual(bad.failures[0].detail, 'python');
    const untagged = checks.checkChapter(
      chapter(words(250) + '\n\n```\nx\n```\n\n' + words(250)),
      brief(),
    );
    assert.deepStrictEqual(codes(untagged), ['fence']);
    const many = checks.checkChapter(
      chapter(
        words(150) +
          figure +
          words(150) +
          figure +
          words(150) +
          figure +
          words(50),
      ),
      brief(),
    );
    assert.strictEqual(many.ok, true);
    assert.deepStrictEqual(many.notes, ['figures']);
  });

  test('the heading fix prepends the planned title; a second chapter heading fails', function () {
    const missing = checks.checkChapter(
      words(500) + '\n\n## Ledger\n- none',
      brief({ title: 'Planned Title' }),
    );
    assert.strictEqual(missing.ok, true);
    assert.deepStrictEqual(missing.fixes, ['heading']);
    assert.ok(missing.markdown.startsWith('## Planned Title\n\nWord word'));
    const h1 = checks.checkChapter('# As An H1\n\n' + words(500), brief());
    assert.deepStrictEqual(h1.fixes, ['heading']);
    assert.ok(h1.markdown.startsWith('## As An H1'));
    const two = checks.checkChapter(
      chapter(words(250) + '\n\n## Another Chapter\n\n' + words(250)),
      brief(),
    );
    assert.deepStrictEqual(codes(two), ['extra-heading']);
    // A level-3 heading inside the chapter is not a second chapter.
    const h3 = checks.checkChapter(
      chapter(words(250) + '\n\n### A part\n\n' + words(250)),
      brief(),
    );
    assert.strictEqual(h3.ok, true, codes(h3).join(','));
  });

  test('echo: a verbatim pickup passes, a paraphrase with a question passes, a miss fails; the first chapter is exempt', function () {
    const withBridge = brief({ previousBridge: BRIDGE });
    const verbatim = checks.checkChapter(
      chapter(
        'So let’s start with the people. Why does more than one of them have to sign off? ' +
          words(490),
      ),
      withBridge,
    );
    assert.strictEqual(verbatim.ok, true, codes(verbatim).join(','));
    const question = checks.checkChapter(
      chapter(
        'Several people, then. What makes each of them necessary? ' +
          words(490),
      ),
      withBridge,
    );
    assert.strictEqual(question.ok, true, codes(question).join(','));
    const miss = checks.checkChapter(
      chapter('The plain answer is simple. ' + words(495)),
      withBridge,
    );
    assert.deepStrictEqual(codes(miss), ['echo']);
    const late = checks.checkChapter(
      chapter(words(490) + ' Why does more than one of them have to sign off?'),
      withBridge,
    );
    assert.deepStrictEqual(
      codes(late),
      ['echo'],
      'an echo past 300 characters does not count',
    );
    const first = checks.checkChapter(
      chapter('The plain answer is simple. ' + words(495)),
      brief(),
    );
    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual(checks.echoNeedle(BRIDGE), [
      'why',
      'does',
      'more',
      'than',
      'one',
      'of',
    ]);
  });

  test('length: over the ceiling, off the target either way, and empty', function () {
    assert.deepStrictEqual(
      codes(checks.checkChapter(chapter(words(720)), brief())),
      ['length-over', 'length-target'],
    );
    assert.deepStrictEqual(
      codes(checks.checkChapter(chapter(words(690)), brief())),
      [],
    );
    assert.deepStrictEqual(
      codes(checks.checkChapter(chapter(words(701)), brief())),
      ['length-over', 'length-target'],
    );
    assert.deepStrictEqual(
      codes(checks.checkChapter(chapter(words(299)), brief())),
      ['length-target'],
    );
    assert.deepStrictEqual(
      codes(checks.checkChapter(chapter(words(300)), brief())),
      [],
    );
    const empty = checks.checkChapter(chapter(words(20)), brief());
    assert.deepStrictEqual(codes(empty), ['empty']);
    assert.ok(
      checks.STOP_CODES.includes('empty') &&
        checks.STOP_CODES.includes('extra-heading'),
    );
    assert.strictEqual(
      checks.ruleText('length-target', { target: 500, ceiling: 700 }, 720),
      'is longer than the target of about 500 words',
    );
    assert.strictEqual(
      checks.ruleText('length-target', { target: 500, ceiling: 700 }, 200),
      'is shorter than the target of about 500 words',
    );
    assert.strictEqual(
      checks.ruleText('length-over', { target: 500, ceiling: 700 }),
      'is longer than 700 words',
    );
  });

  test('a missing ledger is a note, never a failure', function () {
    const result = checks.checkChapter('## T\n\n' + words(500), brief());
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.notes, ['ledger-missing']);
    assert.strictEqual(result.ledger, null);
  });

  test("the experiment's introduction passes as a framing chapter", function () {
    const result = checks.checkChapter(
      fixture('ch1-sonnet-medium.md'),
      brief({
        title: 'Module Introduction',
        type: 'framing',
        target: 250,
        ceiling: 350,
      }),
    );
    assert.strictEqual(result.ok, true, codes(result).join(','));
    assert.ok(result.words >= 280 && result.words <= 300, String(result.words));
    assert.ok(
      checks
        .lastParagraph(result.markdown)
        .startsWith("So let's start with the people."),
    );
  });

  test("the experiment's chapter 2 fails only on its length", function () {
    // 709 words without its heading and figure, against a 500 target and the
    // 700 ceiling: the two length rules, and nothing else (the echo of the
    // introduction's bridge is verbatim, the figure is an ascii fence).
    const result = checks.checkChapter(
      fixture('ch2-sonnet-medium.md'),
      brief({
        title: 'Who Is a Code Owner, And Why Do Several People Have to Say Yes',
        type: 'concept',
        target: 500,
        ceiling: 700,
        previousBridge: BRIDGE,
      }),
    );
    assert.deepStrictEqual(codes(result), ['length-over', 'length-target']);
    assert.strictEqual(result.words, 709);
    assert.ok(result.ledger.startsWith('## Ledger'));
  });

  test('splitLedger, maskFences and lastParagraph', function () {
    const split = checks.splitLedger(
      '## T\n\nbody\n\n## Ledger\n\nPromises made: none.',
    );
    assert.strictEqual(split.body, '## T\n\nbody');
    assert.strictEqual(split.ledger, '## Ledger\n\nPromises made: none.');
    const masked = checks.maskFences(
      'a\n\n```ascii\nx\n```\n\nb\n\n~~~\ny\n~~~\n',
    );
    assert.deepStrictEqual(masked.tags, ['ascii', '']);
    assert.ok(!masked.prose.includes('x'));
    assert.strictEqual(
      checks.lastParagraph(
        '## T\n\nfirst\n\nlast one.\n\n```ascii\nfig\n```\n',
      ),
      'last one.',
    );
  });
});
