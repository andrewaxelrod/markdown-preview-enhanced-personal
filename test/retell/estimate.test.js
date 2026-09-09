/* global suite, test, suiteSetup, suiteTeardown */

/**
 * `src/retell/estimate.ts` (`featrues/15-convert-readable/spec.md` §7): the
 * estimate on the three measured sections and the whole document, the
 * ceiling, the soft lower bound, the minutes never 0, and the estimate
 * within 15 % of every low-effort run's actual length.
 */

const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { compileEntry } = require('./compile');

let estimate;
let tmpFile;

suite('retell/estimate', function () {
  this.timeout(30000);

  suiteSetup(async function () {
    tmpFile = path.join(__dirname, '.estimate.bundle.cjs');
    estimate = await compileEntry('src/retell/estimate.ts', tmpFile);
  });

  suiteTeardown(function () {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  test('the four constants are the measurements of §7', function () {
    assert.strictEqual(estimate.RETELL_ESTIMATE_RATIO, 1.4);
    assert.strictEqual(estimate.RETELL_CEILING_RATIO, 1.8);
    assert.strictEqual(estimate.RETELL_UNDER_RATIO, 0.8);
    assert.strictEqual(estimate.RETELL_WORDS_PER_MINUTE, 142);
  });

  test('estimateFor on the three measured sections and the whole document', function () {
    assert.deepStrictEqual(estimate.estimateFor(1246), {
      words: 1740,
      minutes: 12,
    });
    assert.deepStrictEqual(estimate.estimateFor(304), {
      words: 430,
      minutes: 3,
    });
    assert.deepStrictEqual(estimate.estimateFor(426), {
      words: 600,
      minutes: 4,
    });
    assert.deepStrictEqual(estimate.estimateFor(4986), {
      words: 6980,
      minutes: 49,
    });
  });

  test('ceilingFor and underFor', function () {
    assert.strictEqual(estimate.ceilingFor(1246), 2243);
    assert.strictEqual(estimate.ceilingFor(304), 547);
    assert.strictEqual(estimate.ceilingFor(426), 767);
    assert.strictEqual(estimate.underFor(1246), 997);
    assert.strictEqual(estimate.underFor(304), 243);
    assert.strictEqual(estimate.ceilingFor(0), 0);
    assert.strictEqual(estimate.ceilingFor(-5), 0);
    assert.strictEqual(estimate.ceilingFor(NaN), 0);
  });

  test('the estimate is within 15 % of every low-effort run, and the ceiling above every run', function () {
    const runs = [
      [1246, 1539],
      [1246, 1545],
      [304, 480],
      [426, 630],
    ];
    for (const [source, actual] of runs) {
      const { words } = estimate.estimateFor(source);
      const off = Math.abs(words - actual) / actual;
      assert.ok(off <= 0.15, `${source} → ${words} against ${actual}: ${off}`);
      assert.ok(
        estimate.ceilingFor(source) > actual,
        `${source}: ceiling above ${actual}`,
      );
      assert.ok(
        estimate.underFor(source) < actual,
        `${source}: floor below ${actual}`,
      );
    }
    // The highest run measured (run 2, medium: 1,755) is under the ceiling too.
    assert.ok(estimate.ceilingFor(1246) > 1755);
  });

  test('minutes are never 0, and the words round to ten', function () {
    assert.deepStrictEqual(estimate.estimateFor(0), { words: 0, minutes: 1 });
    assert.deepStrictEqual(estimate.estimateFor(3), { words: 0, minutes: 1 });
    assert.deepStrictEqual(estimate.estimateFor(20), { words: 30, minutes: 1 });
    assert.deepStrictEqual(estimate.estimateFor(NaN), { words: 0, minutes: 1 });
    assert.strictEqual(estimate.minutesFor(0), 1);
    assert.strictEqual(estimate.minutesFor(70), 1);
    assert.strictEqual(estimate.minutesFor(142), 1);
    assert.strictEqual(estimate.minutesFor(212), 1);
    assert.strictEqual(estimate.minutesFor(213), 2);
    assert.strictEqual(estimate.minutesFor(1545), 11);
    assert.strictEqual(estimate.minutesFor(6980), 49);
    assert.strictEqual(estimate.estimateFor(1246).words % 10, 0);
    assert.strictEqual(estimate.estimateFor(4986).words % 10, 0);
  });
});
