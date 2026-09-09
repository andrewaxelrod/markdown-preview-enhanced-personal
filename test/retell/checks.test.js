/* global suite, test, suiteSetup, suiteTeardown */

/**
 * `src/retell/checks.ts` (`featrues/15-convert-readable/spec.md` §9.3): every
 * rule with a passing and a failing edition, heading lines exempt from the
 * content rules, the identifier leaks the phonemizer measured, the heading
 * fidelity of the experiment's runs and the level fix, the soft rules that
 * never block, and the five runs against their sections.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { compileEntry, fixture } = require('./compile');

let checks;
let tmpFile;

const SECTION_7 = [
  { level: 2, text: '7. Specs, ADRs, constitution' },
  { level: 3, text: 'Specs' },
  { level: 3, text: 'ADRs' },
  { level: 3, text: 'Linking code to specs' },
  { level: 3, text: 'Should source code link to specs?' },
  { level: 3, text: 'Constitution' },
];
const SECTION_9 = [
  { level: 2, text: '9. Enforcement ladder' },
  { level: 3, text: '1. Deterministic deny (no script)' },
  { level: 3, text: '2. PreToolUse hooks (one script, two registrations)' },
  { level: 3, text: '3. CI gate (the only layer neither agent can bypass)' },
  { level: 3, text: '4. Code review rules' },
  { level: 3, text: '5. Instructions' },
];
const SECTION_3 = [{ level: 2, text: '3. What goes where' }];

/** `n` words in short sentences, each starting with a capital. */
function words(n, seed) {
  const out = [];
  const base = seed || 'word';
  for (let i = 0; i < n; i++) {
    const word = i % 7 === 0 ? base[0].toUpperCase() + base.slice(1) : base;
    out.push(word + (i % 7 === 6 || i === n - 1 ? '.' : ''));
  }
  return out.join(' ');
}

const ONE_HEADING = [{ level: 2, text: 'A Section' }];

function edition(body, heading) {
  return `## ${heading || 'A Section'}\n\n${body}\n`;
}

function brief(overrides) {
  return Object.assign(
    {
      sourceWords: 500,
      ceiling: 900,
      under: 400,
      headings: ONE_HEADING,
    },
    overrides || {},
  );
}

function briefFor(sourceWords, headings) {
  return {
    sourceWords,
    ceiling: Math.round(1.8 * sourceWords),
    under: Math.round(0.8 * sourceWords),
    headings,
  };
}

function codes(result) {
  return result.failures.map((f) => f.code);
}

function hardCodes(result) {
  return result.failures.filter((f) => !f.soft).map((f) => f.code);
}

suite('retell/checks', function () {
  this.timeout(30000);

  suiteSetup(async function () {
    tmpFile = path.join(__dirname, '.checks.bundle.cjs');
    checks = await compileEntry('src/retell/checks.ts', tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  test('a clean edition passes with no fixes and its word count', function () {
    const result = checks.checkEdition(edition(words(500)), brief());
    assert.strictEqual(result.ok, true, codes(result).join(','));
    assert.deepStrictEqual(result.failures, []);
    assert.deepStrictEqual(result.fixes, []);
    assert.deepStrictEqual(result.notes, []);
    assert.strictEqual(result.words, 500);
    assert.strictEqual(result.offset, 0);
    assert.deepStrictEqual(result.headings, [{ level: 2, text: 'A Section' }]);
    assert.ok(result.markdown.startsWith('## A Section\n\nWord word'));
    assert.deepStrictEqual(checks.RETELL_SOFT_CODES, [
      'sentence-length',
      'length-under',
    ]);
    assert.strictEqual(checks.MIN_EDITION_WORDS, 50);
  });

  test('em-dash, table, link, inline-code, html, emoji and fence each fail hard', function () {
    const cases = [
      ['em-dash', words(500) + ' A pause — and on.'],
      [
        'table',
        words(490) + '\n\n| a | b |\n| - | - |\n\nContinued ' + words(8),
      ],
      ['table', words(500) + ' Cells x | y | z in prose.'],
      ['link', words(500) + ' See [the post](https://x.y).'],
      ['link', words(500) + ' See <https://x.y>.'],
      ['link', words(500) + ' See [[Other Note]].'],
      ['inline-code', words(500) + ' The `CODEOWNERS` file.'],
      ['html', words(500) + ' A <b>bold</b> word.'],
      ['emoji', words(500) + ' Done ✅.'],
      ['fence', words(250) + '\n\n```python\nprint(1)\n```\n\n' + words(250)],
      ['fence', words(250) + '\n\n```ascii\n| a | b |\n```\n\n' + words(250)],
      ['fence', words(250) + '\n\n```\nx\n```\n\n' + words(250)],
    ];
    for (const [code, body] of cases) {
      const result = checks.checkEdition(edition(body), brief());
      // A URL, or a tag, is an identifier the voice cannot say as well.
      const hard = hardCodes(result).filter(
        (c) =>
          !((code === 'link' || code === 'html') && c === 'identifier-leak'),
      );
      assert.deepStrictEqual(
        hard,
        [code],
        code + ': ' + codes(result).join(','),
      );
      assert.strictEqual(result.ok, false, code);
      assert.strictEqual(result.failures[0].soft, false);
    }
    const fence = checks.checkEdition(
      edition(words(250) + '\n\n```python\nprint(1)\n```\n\n' + words(250)),
      brief(),
    );
    assert.strictEqual(fence.failures[0].detail, 'python');
    const untagged = checks.checkEdition(
      edition(words(250) + '\n\n```\nx\n```\n\n' + words(250)),
      brief(),
    );
    assert.strictEqual(untagged.failures[0].detail, 'untagged');
  });

  test('heading lines are exempt from em-dash, inline-code and identifier-leak (D19)', function () {
    const result = checks.checkEdition(
      edition(words(500), 'The `drift.lock` file — and more'),
      brief({
        headings: [{ level: 2, text: 'The drift.lock file — and more' }],
      }),
    );
    assert.strictEqual(result.ok, true, codes(result).join(','));
    assert.deepStrictEqual(result.failures, []);
    assert.deepStrictEqual(
      checks.identifierLeaks('## drift.lock\n\nplain words'),
      [],
    );
    // A fence inside a fence-masked answer is not a heading either.
    const fenced = checks.checkEdition(
      '## A Section\n\n' +
        words(300) +
        '\n\n```\n# not a heading\n```\n\n' +
        words(200),
      brief(),
    );
    assert.deepStrictEqual(hardCodes(fenced), ['fence']);
    assert.deepStrictEqual(fenced.headings, [{ level: 2, text: 'A Section' }]);
  });

  test('identifier-leak flags the forms the voice cannot say and nothing else', function () {
    const leaks = (text) => checks.identifierLeaks('## H\n\n' + text);
    assert.deepStrictEqual(leaks('the drift.lock file'), ['drift.lock']);
    assert.deepStrictEqual(leaks('writes build/rtm.md there'), [
      'build/rtm.md',
    ]);
    assert.deepStrictEqual(leaks('under specs/‹area>'), ['specs/‹area>']);
    assert.deepStrictEqual(leaks('as req~x~1'), ['req~x~1']);
    assert.deepStrictEqual(leaks('spec->symbol'), ['spec->symbol']);
    assert.deepStrictEqual(leaks('a <tag> here'), []);
    assert.deepStrictEqual(
      leaks('REFUND_WINDOW_EXPIRED is heard as three words'),
      [],
    );
    assert.deepStrictEqual(leaks('a score of 90.2 percent'), []);
    assert.deepStrictEqual(
      leaks('for example, e.g. this one, i.e. that, etc.'),
      [],
    );
    assert.deepStrictEqual(leaks('at 9 a.m. and 5 p.m. in the U.S.'), []);
    assert.deepStrictEqual(leaks('"payments dot refund-window."'), []);
    assert.deepStrictEqual(leaks('ADR zero zero zero seven'), []);
    assert.deepStrictEqual(leaks('(the check_trace.py script)'), [
      'check_trace.py',
    ]);
    const result = checks.checkEdition(
      edition(words(500) + ' Then open drift.lock and build/rtm.md.'),
      brief(),
    );
    assert.deepStrictEqual(hardCodes(result), ['identifier-leak']);
    assert.strictEqual(result.failures[0].detail, 'drift.lock');
    assert.strictEqual(
      checks.retellRuleText('identifier-leak', brief(), 'drift.lock'),
      'contains drift.lock, which the voice cannot say; give it a spoken name',
    );
  });

  test('heading-fidelity: verbatim text in order at a constant offset; a rename, a missing or an extra heading fails', function () {
    const source = [
      { level: 2, text: '9. Enforcement ladder' },
      { level: 3, text: '1. Deterministic deny (no script)' },
      { level: 3, text: '2. Hooks' },
    ];
    const body = (levels) =>
      `${'#'.repeat(levels[0])} 9. Enforcement ladder\n\n${words(200)}\n\n` +
      `${'#'.repeat(levels[1])} 1. Deterministic deny (no script)\n\n${words(200)}\n\n` +
      `${'#'.repeat(levels[2])} 2. Hooks\n\n${words(200)}\n`;
    const same = checks.checkEdition(
      body([2, 3, 3]),
      brief({ headings: source }),
    );
    assert.strictEqual(same.ok, true, codes(same).join(','));
    assert.strictEqual(same.offset, 0);
    assert.deepStrictEqual(same.fixes, []);
    const up = checks.checkEdition(
      body([1, 2, 2]),
      brief({ headings: source }),
    );
    assert.strictEqual(up.ok, true, codes(up).join(','));
    assert.strictEqual(up.offset, -1);
    assert.deepStrictEqual(up.fixes, ['heading-level']);
    assert.ok(up.markdown.startsWith('## 9. Enforcement ladder\n'));
    assert.ok(
      up.markdown.includes('\n### 1. Deterministic deny (no script)\n'),
    );
    assert.ok(up.markdown.includes('\n### 2. Hooks\n'));
    const down = checks.checkEdition(
      body([3, 4, 4]),
      brief({ headings: source }),
    );
    assert.strictEqual(down.offset, 1);
    assert.ok(down.markdown.startsWith('## 9. Enforcement ladder\n'));
    // Emphasis around a heading and trailing hashes are not a change.
    const emphasised = checks.checkEdition(
      body([2, 3, 3]).replace(
        '## 9. Enforcement ladder',
        '## *9. Enforcement ladder* ##',
      ),
      brief({ headings: source }),
    );
    assert.strictEqual(emphasised.ok, true, codes(emphasised).join(','));
    // The texts line up but the levels wander (an h1 unit heading over h3
    // sub-headings, as the Dev Host produced): fidelity holds, and the fix
    // sets every level to the source's own.
    const uneven = checks.checkEdition(
      body([1, 3, 3]),
      brief({ headings: source }),
    );
    assert.deepStrictEqual(hardCodes(uneven), []);
    assert.deepStrictEqual(uneven.fixes, ['heading-level']);
    assert.strictEqual(uneven.offset, null);
    assert.deepStrictEqual(
      checks.headingsOf(uneven.markdown).map((h) => h.level),
      [2, 3, 3],
    );
    const far = checks.checkEdition(
      body([4, 5, 5]),
      brief({ headings: source }),
    );
    assert.deepStrictEqual(hardCodes(far), []);
    assert.deepStrictEqual(far.fixes, ['heading-level']);
    assert.deepStrictEqual(
      checks.headingsOf(far.markdown).map((h) => h.level),
      [2, 3, 3],
    );
    const renamed = checks.checkEdition(
      body([2, 3, 3]).replace(
        '### 1. Deterministic deny (no script)',
        '### One. Deterministic deny, no script needed',
      ),
      brief({ headings: source }),
    );
    assert.deepStrictEqual(hardCodes(renamed), ['heading-fidelity']);
    assert.strictEqual(
      renamed.failures.find((f) => f.code === 'heading-fidelity').detail,
      'expected "### 1. Deterministic deny (no script)", got "### One. Deterministic deny, no script needed"',
    );
    assert.strictEqual(renamed.offset, null);
    const missing = checks.checkEdition(
      `## 9. Enforcement ladder\n\n${words(200)}\n\n### 2. Hooks\n\n${words(200)}\n`,
      brief({ headings: source }),
    );
    assert.deepStrictEqual(hardCodes(missing), ['heading-fidelity']);
    assert.strictEqual(
      missing.failures[0].detail,
      '3 headings expected, 2 found',
    );
    const extra = checks.checkEdition(
      body([2, 3, 3]) + `\n### 3. Extra\n\n${words(60)}\n`,
      brief({ headings: source }),
    );
    assert.deepStrictEqual(hardCodes(extra), ['heading-fidelity']);
    assert.strictEqual(
      checks.retellRuleText(
        'heading-fidelity',
        brief(),
        '3 headings expected, 2 found',
      ),
      "changed a heading: the section's headings must appear word for word, in order (3 headings expected, 2 found)",
    );
  });

  test('headingsOf and normaliseHeadings work outside fences only', function () {
    const md =
      '# Top\n\n```md\n## inside a fence\n```\n\n## Second *one*\n\n### Third `x` ##\n';
    assert.deepStrictEqual(checks.headingsOf(md), [
      { level: 1, text: 'Top' },
      { level: 2, text: 'Second one' },
      { level: 3, text: 'Third x' },
    ]);
    const shifted = checks.normaliseHeadings(md, -1);
    assert.ok(shifted.startsWith('## Top\n'));
    assert.ok(
      shifted.includes('```md\n## inside a fence\n```'),
      'the fence is untouched',
    );
    assert.ok(shifted.includes('\n### Second *one*\n'));
    assert.ok(shifted.includes('\n#### Third `x` ##\n'));
    assert.strictEqual(checks.normaliseHeadings(md, 0), md);
    assert.ok(
      checks.normaliseHeadings('###### Deep\n', -1).startsWith('###### Deep'),
      'clamped at six',
    );
    assert.ok(
      checks.normaliseHeadings('# Top\n', 1).startsWith('# Top'),
      'clamped at one',
    );
    assert.strictEqual(
      checks.normaliseHeadingText('  *Bold*  _and_ `code`  ##  '),
      'Bold and code',
    );
  });

  test('sentence-length is soft: an average above twenty, or any sentence above thirty-five', function () {
    const long = Array.from(
      { length: 14 },
      () => words(30).replace(/\./g, '') + '.',
    ).join(' ');
    const average = checks.checkEdition(edition(long), brief());
    assert.strictEqual(average.ok, true, 'soft never blocks');
    assert.deepStrictEqual(codes(average), ['sentence-length']);
    assert.strictEqual(average.failures[0].soft, true);
    assert.strictEqual(average.failures[0].detail, '30.0');
    const oneLong = checks.checkEdition(
      edition(words(400) + ' ' + words(40).replace(/\./g, '') + '.'),
      brief(),
    );
    assert.deepStrictEqual(codes(oneLong), ['sentence-length']);
    const stats = checks.sentenceStats(
      '## H\n\n' + words(400) + ' ' + words(40).replace(/\./g, '') + '.',
    );
    assert.strictEqual(stats.longest, 40);
    assert.ok(stats.average < 20, String(stats.average));
    // A closing quote after the full stop still ends the sentence.
    const quoted = checks.sentenceStats(
      'A comment reading "ADR-0007." A decision lives at one or two lines. It is short.',
    );
    assert.strictEqual(quoted.count, 3);
    assert.strictEqual(quoted.longest, 8);
    // List markers are not words of the sentence.
    const list = checks.sentenceStats('- One two three.\n- Four five six.');
    assert.strictEqual(list.count, 2);
    assert.strictEqual(list.longest, 3);
    assert.strictEqual(
      checks.retellRuleText('sentence-length', brief(), '26.1'),
      'averages 26.1 words a sentence; keep to twenty or fewer and none above thirty-five',
    );
  });

  test('length: over the ceiling is hard, under the floor is soft, empty is hard', function () {
    const b = brief({ sourceWords: 500, ceiling: 900, under: 400 });
    assert.deepStrictEqual(codes(checks.checkEdition(edition(words(901)), b)), [
      'length-over',
    ]);
    assert.strictEqual(checks.checkEdition(edition(words(901)), b).ok, false);
    assert.deepStrictEqual(
      codes(checks.checkEdition(edition(words(900)), b)),
      [],
    );
    assert.deepStrictEqual(
      codes(checks.checkEdition(edition(words(800)), b)),
      [],
      '1.6 × does not fire',
    );
    const under = checks.checkEdition(edition(words(399)), b);
    assert.deepStrictEqual(codes(under), ['length-under']);
    assert.strictEqual(under.ok, true, 'a soft failure alone leaves ok true');
    assert.strictEqual(under.failures[0].soft, true);
    assert.deepStrictEqual(
      codes(checks.checkEdition(edition(words(400)), b)),
      [],
    );
    const empty = checks.checkEdition(edition(words(20)), b);
    assert.deepStrictEqual(codes(empty), ['empty']);
    assert.strictEqual(empty.failures[0].soft, false);
    assert.strictEqual(
      checks.retellRuleText('length-over', b, undefined, 920),
      'is 920 words against a ceiling of 900',
    );
    assert.strictEqual(
      checks.retellRuleText('length-under', b, undefined, 399),
      'is 399 words against a section of 500; a faithful edition is not shorter than the section',
    );
    assert.strictEqual(
      checks.retellRuleText('empty', b),
      'is too short to be an edition',
    );
    assert.strictEqual(
      checks.retellRuleText('table', b),
      'contains a table; narrate it as sentences, one per row',
    );
    assert.strictEqual(
      checks.retellRuleText('fence', b),
      'contains a fenced block; say what the code does instead',
    );
    assert.strictEqual(
      checks.retellRuleText('em-dash', b),
      'contains an em dash; punctuate with commas, colons or a new sentence',
    );
    assert.strictEqual(checks.retellRuleText('html', b), 'contains HTML');
  });

  test('a hard failure with a soft one: ok false, both named', function () {
    const result = checks.checkEdition(
      edition(words(390) + ' A pause — and on.'),
      brief({ under: 400 }),
    );
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(codes(result).sort(), ['em-dash', 'length-under']);
  });

  // ------------------------------------------------ the experiment's runs

  test('runs 1 and 3 keep every heading one level up: fidelity passes at −1 and the fix puts the source levels back', function () {
    for (const name of ['run-1-sonnet-low.md', 'run-3-retry-sonnet-low.md']) {
      const result = checks.checkEdition(
        fixture(name),
        briefFor(1246, SECTION_7),
      );
      assert.strictEqual(result.offset, -1, name);
      assert.deepStrictEqual(result.fixes, ['heading-level'], name);
      assert.ok(!codes(result).includes('heading-fidelity'), name);
      assert.ok(
        result.markdown.startsWith('## 7. Specs, ADRs, constitution\n'),
        name,
      );
      assert.ok(result.markdown.includes('\n### Specs\n'), name);
      assert.ok(result.markdown.includes('\n### Constitution\n'), name);
      assert.deepStrictEqual(
        checks.headingsOf(result.markdown),
        SECTION_7,
        name + ': the written body carries the source levels',
      );
    }
  });

  test("run 5 renamed its headings for the ear: heading-fidelity fails; run 2's title is not the source's either", function () {
    const five = checks.checkEdition(
      fixture('run-5-section-9-sonnet-low.md'),
      briefFor(426, SECTION_9),
    );
    assert.ok(
      hardCodes(five).includes('heading-fidelity'),
      codes(five).join(','),
    );
    assert.strictEqual(five.offset, null);
    assert.strictEqual(
      five.failures.find((f) => f.code === 'heading-fidelity').detail,
      'expected "## 9. Enforcement ladder", got "# Nine. Enforcement ladder"',
    );
    const two = checks.checkEdition(
      fixture('run-2-sonnet-medium.md'),
      briefFor(1246, SECTION_7),
    );
    assert.ok(
      hardCodes(two).includes('heading-fidelity'),
      codes(two).join(','),
    );
  });

  test('runs 1 to 5 have zero identifier leaks; runs 1, 3, 4 and 5 zero backticks, fences, tables and links', function () {
    const runs = [
      ['run-1-sonnet-low.md', SECTION_7, 1246],
      ['run-2-sonnet-medium.md', SECTION_7, 1246],
      ['run-3-retry-sonnet-low.md', SECTION_7, 1246],
      ['run-4-section-3-sonnet-low.md', SECTION_3, 304],
      ['run-5-section-9-sonnet-low.md', SECTION_9, 426],
    ];
    for (const [name, headings, sourceWords] of runs) {
      const text = fixture(name);
      assert.deepStrictEqual(checks.identifierLeaks(text), [], name);
      const result = checks.checkEdition(text, briefFor(sourceWords, headings));
      for (const code of ['identifier-leak', 'html', 'emoji']) {
        assert.ok(!codes(result).includes(code), name + ': ' + code);
      }
      if (name !== 'run-2-sonnet-medium.md') {
        for (const code of ['inline-code', 'fence', 'table', 'link']) {
          assert.ok(!codes(result).includes(code), name + ': ' + code);
        }
      }
    }
    // Every leak in the experiment folder is in a `.source.md`.
    assert.ok(
      checks.identifierLeaks(fixture('section-7.source.md')).length > 5,
    );
    assert.ok(
      checks.identifierLeaks(fixture('run-5-section-9.source.md')).length > 5,
    );
  });

  test('run 1 fails em-dash (13 of them); run 3, its retry, has none and passes', function () {
    const one = checks.checkEdition(
      fixture('run-1-sonnet-low.md'),
      briefFor(1246, SECTION_7),
    );
    assert.deepStrictEqual(hardCodes(one), ['em-dash']);
    assert.strictEqual(
      (fixture('run-1-sonnet-low.md').match(/—/g) || []).length,
      13,
    );
    const three = checks.checkEdition(
      fixture('run-3-retry-sonnet-low.md'),
      briefFor(1246, SECTION_7),
    );
    assert.strictEqual(three.ok, true, codes(three).join(','));
    assert.deepStrictEqual(three.failures, []);
    assert.ok(three.words >= 1500 && three.words <= 1560, String(three.words));
    assert.ok(three.words < 2243, 'under the ceiling');
  });

  test('sentence-length on the runs, heading lines excluded (D19)', function () {
    // The spec's figures (26.1, 26.6, 13.4, 20.9, 19.7) counted every heading
    // line as a sentence of a few words; with the headings excluded the
    // averages are these, and run 5's long quoted sentences keep it over.
    const expected = [
      ['run-1-sonnet-low.md', SECTION_7, 1246, 25.7, true],
      ['run-2-sonnet-medium.md', SECTION_7, 1246, 27.0, true],
      ['run-3-retry-sonnet-low.md', SECTION_7, 1246, 13.1, false],
      ['run-4-section-3-sonnet-low.md', SECTION_3, 304, 21.6, true],
      ['run-5-section-9-sonnet-low.md', SECTION_9, 426, 22.6, true],
    ];
    for (const [name, headings, sourceWords, average, fails] of expected) {
      const stats = checks.sentenceStats(fixture(name));
      assert.strictEqual(stats.average, average, name);
      const result = checks.checkEdition(
        fixture(name),
        briefFor(sourceWords, headings),
      );
      const failure = result.failures.find((f) => f.code === 'sentence-length');
      assert.strictEqual(!!failure, fails, name + ': ' + JSON.stringify(stats));
      if (failure) {
        assert.strictEqual(failure.soft, true, name);
        assert.strictEqual(failure.detail, average.toFixed(1), name);
      }
    }
    // Run 4 is 475 words for a section of 304: over 1.4 ×, under 1.8 ×.
    const four = checks.checkEdition(
      fixture('run-4-section-3-sonnet-low.md'),
      briefFor(304, SECTION_3),
    );
    assert.strictEqual(four.ok, true, codes(four).join(','));
    assert.deepStrictEqual(codes(four), ['sentence-length']);
  });

  test('a leading heading that is the document title is stripped (title-heading); a short unit has a lower empty floor', function () {
    const answer =
      '## Agent-Ready Repos\n\n## Storing specs alongside code\n\nThis is version one point one, from September twenty twenty-six. It targets two agents. The principles apply to any coding agent that reads an instruction file, and the mechanics sections are labeled.';
    const source = [{ level: 2, text: 'Storing specs alongside code' }];
    const stripped = checks.checkEdition(answer, {
      sourceWords: 48,
      ceiling: 86,
      under: 38,
      headings: source,
      title: 'Agent-Ready Repos',
    });
    assert.deepStrictEqual(
      stripped.failures.filter((f) => !f.soft).map((f) => f.code),
      [],
      JSON.stringify(stripped.failures),
    );
    assert.ok(stripped.fixes.includes('title-heading'));
    assert.ok(stripped.markdown.startsWith('## Storing specs alongside code'));
    assert.deepStrictEqual(
      checks.headingsOf(stripped.markdown).map((h) => h.text),
      ['Storing specs alongside code'],
    );
    // Without the title in the brief the extra heading still fails fidelity.
    const untitled = checks.checkEdition(answer, {
      sourceWords: 48,
      ceiling: 86,
      under: 38,
      headings: source,
    });
    assert.deepStrictEqual(
      untitled.failures.filter((f) => !f.soft).map((f) => f.code),
      ['heading-fidelity'],
    );
    // A unit whose own heading is the title keeps it.
    const own = checks.checkEdition(
      '## Agent-Ready Repos\n\n' + 'Word '.repeat(60).trim() + '.',
      {
        sourceWords: 100,
        ceiling: 180,
        under: 80,
        headings: [{ level: 2, text: 'Agent-Ready Repos' }],
        title: 'Agent-Ready Repos',
      },
    );
    assert.ok(!own.fixes.includes('title-heading'));
    assert.strictEqual(own.ok, true, JSON.stringify(own.failures));
    // The empty floor: half of a short unit, never under 10, never over 50.
    assert.strictEqual(checks.emptyFloor(48), 24);
    assert.strictEqual(checks.emptyFloor(12), 10);
    assert.strictEqual(checks.emptyFloor(1246), 50);
    assert.strictEqual(checks.emptyFloor(0), 50);
  });
});
