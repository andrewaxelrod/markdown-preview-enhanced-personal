/* global suite, test */
'use strict';

// Eye strain 2 (featrues/07-eye-strain-2/spec.md §5, §6, §8, §11, §17): the
// pure helpers of media/read-aloud-core.js behind the text size slider —
// the line height table, the clamp, the measured advance, the dim tier and
// the block gap — and a parse of media/read-aloud-page.css for the rules the
// slider drives. No jsdom.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../media/read-aloud-core.js');

const PAGE_CSS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud-page.css'),
  'utf8',
);
// The sheet's page-off rules live in the player's own stylesheet (09 §6).
const SHEET_CSS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud.css'),
  'utf8',
);
const UNCOMMENTED = PAGE_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

suite('read-aloud text size (07 §5): the derivations', () => {
  test('deriveLineHeight follows the table of §5.2 exactly', () => {
    const table = {
      16: 1.7,
      17: 1.68,
      18: 1.65,
      19: 1.63,
      20: 1.6,
      21: 1.58,
      22: 1.55,
      23: 1.53,
      24: 1.5,
      25: 1.48,
      26: 1.45,
      27: 1.45,
      28: 1.45,
    };
    for (const [size, lineHeight] of Object.entries(table)) {
      assert.strictEqual(
        core.deriveLineHeight(Number(size)),
        lineHeight,
        `at ${size} px`,
      );
    }
    // Out of range is clamped first; nonsense is the default's 1.6.
    assert.strictEqual(core.deriveLineHeight(10), 1.7);
    assert.strictEqual(core.deriveLineHeight(40), 1.45);
    assert.strictEqual(core.deriveLineHeight(Number.NaN), 1.6);
    assert.strictEqual(core.deriveLineHeight('24'), 1.6);
    // The whole range is inside 05's 1.4–1.8 and 1.6 at 20 px stays the anchor.
    for (let size = 16; size <= 28; size++) {
      const value = core.deriveLineHeight(size);
      assert.ok(value >= 1.45 && value <= 1.7, `${size}: ${value}`);
    }
  });

  test('clampTextSize: whole pixels in 16–28, the default for anything else', () => {
    assert.strictEqual(core.TEXT_SIZE_MIN, 16);
    assert.strictEqual(core.TEXT_SIZE_MAX, 28);
    assert.strictEqual(core.TEXT_SIZE_STEP, 1);
    assert.strictEqual(core.DEFAULT_TEXT_SIZE, 20);
    assert.strictEqual(core.clampTextSize(20), 20);
    assert.strictEqual(core.clampTextSize(15.4), 16);
    assert.strictEqual(core.clampTextSize(28.6), 28);
    assert.strictEqual(core.clampTextSize(21.5), 22);
    assert.strictEqual(core.clampTextSize(21.49), 21);
    assert.strictEqual(core.clampTextSize(0), 16);
    assert.strictEqual(core.clampTextSize(100), 28);
    assert.strictEqual(core.clampTextSize('22'), 20);
    assert.strictEqual(core.clampTextSize(Number.NaN), 20);
    assert.strictEqual(core.clampTextSize(Number.POSITIVE_INFINITY), 20);
    assert.strictEqual(core.clampTextSize(undefined), 20);
    assert.strictEqual(core.clampTextSize(null), 20);
  });

  test('charEmFrom divides the font size and the zoom out; a missing layout is the default', () => {
    assert.strictEqual(core.DEFAULT_CHAR_EM, 0.5);
    assert.strictEqual(core.MEASURE_CHARS, 66);
    // 2000 px for 100 characters against a 100 em reference of 4000 px:
    // 20 px per character at 40 px per em is 0.5 em.
    assert.strictEqual(core.charEmFrom(2000, 4000, 100), 0.5);
    // At zoom 2 both widths double and the ratio holds.
    assert.strictEqual(core.charEmFrom(4000, 8000, 100), 0.5);
    // Atkinson at 20 px: about 9.4 px per character, 2000 px per 100 em.
    assert.strictEqual(core.charEmFrom(9.4 * 435, 2000, 435), 0.47);
    // Rounded to four decimals.
    assert.strictEqual(core.charEmFrom(1234, 2000, 435), 0.1418);
    // No layout: zero, negative or NaN widths.
    assert.strictEqual(core.charEmFrom(0, 2000, 435), 0.5);
    assert.strictEqual(core.charEmFrom(2000, 0, 435), 0.5);
    assert.strictEqual(core.charEmFrom(-5, 2000, 435), 0.5);
    assert.strictEqual(core.charEmFrom(Number.NaN, 2000, 435), 0.5);
    assert.strictEqual(core.charEmFrom(2000, Number.NaN, 435), 0.5);
    assert.strictEqual(core.charEmFrom(undefined, undefined, 435), 0.5);
    // The sample length defaults to the sample's own.
    assert.strictEqual(
      core.charEmFrom(core.MEASURE_SAMPLE.length * 10, 2000),
      0.5,
    );
  });

  test('the measuring sample is ordinary prose with no quotes or apostrophes', () => {
    const sample = core.MEASURE_SAMPLE;
    assert.ok(
      sample.length > 400 && sample.length < 500,
      String(sample.length),
    );
    assert.ok(!/["'‘’“”]/.test(sample));
    assert.ok(
      /^[A-Za-z ,.;]+$/.test(sample),
      'letters, spaces and punctuation',
    );
    assert.ok(!/\s{2}/.test(sample), 'single spacing');
  });

  test('tierFor: active, near, far', () => {
    assert.strictEqual(core.tierFor(3, 3, 4), 'active');
    assert.strictEqual(core.tierFor(4, 3, 4), 'near');
    assert.strictEqual(core.tierFor(2, 3, 4), 'far');
    assert.strictEqual(core.tierFor(5, 3, 4), 'far');
    // The last block has no next.
    assert.strictEqual(core.tierFor(0, 3, -1), 'far');
    assert.strictEqual(core.tierFor(3, 3, -1), 'active');
  });

  test('blockGapMs: 400 after a paragraph, 900 after a heading, divided by the rate', () => {
    assert.strictEqual(core.BLOCK_GAP_MS, 400);
    assert.strictEqual(core.HEADING_GAP_MS, 900);
    const p = { tagName: 'P' };
    const h2 = { tagName: 'H2' };
    assert.strictEqual(core.blockGapMs(p, 1), 400);
    assert.strictEqual(core.blockGapMs(p, 2), 200);
    assert.strictEqual(core.blockGapMs(p, 0.5), 800);
    assert.strictEqual(core.blockGapMs(h2, 1), 900);
    assert.strictEqual(core.blockGapMs(h2, 2), 450);
    assert.strictEqual(core.blockGapMs(h2, 0.5), 1800);
    assert.strictEqual(core.blockGapMs({ tagName: 'h6' }, 1), 900);
    assert.strictEqual(core.blockGapMs({ tagName: 'UL' }, 1.5), 267);
    // No element, or a nonsense rate, is a paragraph at 1×.
    assert.strictEqual(core.blockGapMs(null, 1), 400);
    assert.strictEqual(core.blockGapMs(p, 0), 400);
    assert.strictEqual(core.blockGapMs(p, Number.NaN), 400);
  });

  test('followStep: the band, the ease, reduced motion and the settle', () => {
    const base = {
      viewportHeight: 800,
      anchor: core.FOLLOW_ANCHOR,
      bandTop: core.FOLLOW_BAND_TOP,
      bandBottom: core.FOLLOW_BAND_BOTTOM,
      ease: core.FOLLOW_EASE,
      settlePx: core.FOLLOW_SETTLE_PX,
      reduced: false,
      moving: false,
    };
    assert.deepStrictEqual(
      [core.FOLLOW_ANCHOR, core.FOLLOW_BAND_TOP, core.FOLLOW_BAND_BOTTOM],
      [0.38, 0.34, 0.42],
    );
    // Inside the band (272–336 of 800) and not moving: untouched.
    assert.deepStrictEqual(
      core.followStep({ ...base, wordTop: 300, scrollTop: 1000 }),
      { scrollTop: 1000, moving: false },
    );
    // Below the band: 12 % of the way to the target (1000 + 600 − 304).
    const step = core.followStep({ ...base, wordTop: 600, scrollTop: 1000 });
    assert.ok(Math.abs(step.scrollTop - (1000 + 296 * 0.12)) < 1e-9);
    assert.strictEqual(step.moving, true);
    // Above the band: eases up.
    const up = core.followStep({ ...base, wordTop: 100, scrollTop: 1000 });
    assert.ok(up.scrollTop < 1000 && up.moving);
    // Once moving, the ease continues inside the band until it settles.
    const inside = core.followStep({
      ...base,
      wordTop: 310,
      scrollTop: 1000,
      moving: true,
    });
    assert.ok(inside.scrollTop !== 1000 && inside.moving);
    // Reduced motion lands at once.
    assert.deepStrictEqual(
      core.followStep({
        ...base,
        wordTop: 600,
        scrollTop: 1000,
        reduced: true,
      }),
      { scrollTop: 1296, moving: false },
    );
    // Within the settle distance: the target, and no longer moving.
    assert.deepStrictEqual(
      core.followStep({
        ...base,
        wordTop: 304.3,
        scrollTop: 1000,
        moving: true,
      }),
      { scrollTop: 1000.3, moving: false },
    );
  });
});

suite('read-aloud text size (07 §5–§6, §12): the page stylesheet', () => {
  // Selectors span lines in the stylesheet; they are matched with their
  // whitespace collapsed.
  const FLAT = UNCOMMENTED.replace(/\s+/g, ' ');

  function rule(selector) {
    const escaped = selector
      .replace(/\s+/g, ' ')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('(?:^|[}] )' + escaped + ' ?\\{([^}]*)\\}').exec(FLAT);
    assert.ok(m, `the stylesheet has a ${selector} rule`);
    return m[1].trim();
  }

  test('the body size is the slider’s, in rem, at every pane width', () => {
    const body = rule(
      'html[data-mpe-ra-page] body:not([data-presentation-mode])',
    );
    assert.ok(
      /font-size: calc\(var\(--mpe-ra-page-text-size, 20\) \* 1rem \/ 16\);/.test(
        body,
      ),
      body,
    );
    assert.ok(!/min-width:\s*48rem/.test(PAGE_CSS), 'the breakpoint is gone');
    assert.ok(!/font-size:\s*1\.125rem/.test(PAGE_CSS));
  });

  test('every heading size is in em of the body (07 §5.5)', () => {
    const expected = {
      h1: '1.6em',
      h2: '1.3em',
      h3: '1.2em',
      h4: '1.1em',
      h5: '1em',
      h6: '1em',
    };
    for (const [tag, size] of Object.entries(expected)) {
      const body = rule(
        `html[data-mpe-ra-page] body:not([data-presentation-mode]) .markdown-preview ${tag}`,
      );
      assert.ok(body.includes(`font-size: ${size};`), `${tag}: ${body}`);
    }
    assert.ok(
      !/font-size:\s*[\d.]+rem/.test(UNCOMMENTED),
      'no rem heading is left',
    );
  });

  test('the column is content-box with the measure in em (07 §6.3)', () => {
    const column = rule(
      "html[data-mpe-ra-page] body:not([data-presentation-mode]) .markdown-preview[data-for='preview']",
    );
    assert.ok(column.includes('box-sizing: content-box;'), column);
    assert.ok(
      column.includes('max-width: var(--mpe-ra-page-measure, 33em);'),
      column,
    );
    assert.ok(!/66ch/.test(UNCOMMENTED), 'no ch measure is left');
  });

  test('prose gets text-wrap: pretty, and the light link is the low-chroma ink (07 §12)', () => {
    assert.ok(/text-wrap:\s*pretty;/.test(UNCOMMENTED));
    const prose = rule(
      'html[data-mpe-ra-page] body:not([data-presentation-mode]) .markdown-preview :is(p, li, dd, dt, blockquote, figcaption)',
    );
    assert.ok(prose.includes('text-wrap: pretty;'));
    assert.ok(
      /html\[data-mpe-ra-page='light'\]\s*\{[^}]*--link:\s*#33475f;/.test(
        UNCOMMENTED,
      ),
    );
  });

  test('the tier rules override the ink tokens only, and ramp at 220 ms (07 §8.2)', () => {
    for (const tier of ['near', 'far']) {
      const body = rule(
        `html[data-mpe-ra-page] body:not([data-presentation-mode]) :is(.markdown-preview, .mpe-ra-help-body) .mpe-ra-tier-${tier}`,
      );
      assert.ok(body.includes(`--text: var(--text-${tier});`), body);
      assert.ok(body.includes(`--text-muted: var(--text-${tier});`), body);
      assert.ok(body.includes(`--link: var(--text-${tier});`), body);
      assert.ok(!/background|opacity|filter/.test(body), 'colour, not opacity');
    }
    assert.ok(/transition:\s*color 220ms ease;/.test(UNCOMMENTED));
    // The reduced-motion block covers the ramp: the prose selector appears
    // inside it too.
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(
        UNCOMMENTED,
      );
    assert.ok(
      reduced && /\bp,\s*li,\s*dt,\s*dd,/.test(reduced[1]),
      'reduced motion',
    );
    assert.ok(
      reduced && /mpe-ra-bar-idle/.test(reduced[1]),
      'and the panel fade',
    );
  });
});

// The help sheet renders the same preview markup the column does and is read
// by the same player, so its prose follows the same reader template. It was
// given a fixed 14 px in 04, before there was a template to follow.
suite('read-aloud help sheet typography (09 §6, §7)', () => {
  const FLAT = UNCOMMENTED.replace(/\s+/g, ' ');
  const SHEET_FLAT = SHEET_CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\s+/g,
    ' ',
  );

  function ruleIn(flat, selector) {
    const escaped = selector
      .replace(/\s+/g, ' ')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('(?:^|[}] )' + escaped + ' ?\\{([^}]*)\\}').exec(flat);
    assert.ok(m, `the stylesheet has a ${selector} rule`);
    return m[1].trim();
  }

  test('the sheet takes the size and line height of the slider, by the same expression as the body', () => {
    const body = ruleIn(
      FLAT,
      'html[data-mpe-ra-page] body:not([data-presentation-mode])',
    );
    const sheet = ruleIn(FLAT, 'html[data-mpe-ra-page] body .mpe-ra-help');
    const size = /font-size: (calc\([^;]*\));/.exec(body);
    const height = /line-height: (var\([^;]*\));/.exec(body);
    assert.ok(size && height, body);
    assert.ok(
      sheet.includes(`font-size: ${size[1]};`),
      'the same size expression as the column, so the two cannot drift',
    );
    assert.ok(sheet.includes(`line-height: ${height[1]};`), sheet);
  });

  test('the sheet body publishes the line height the pill padding derives from', () => {
    // Unset, the derivation in media/read-aloud.css ran at its 1.85 fallback
    // against a 1.6 line and the pill fragments overlapped by half again what
    // they should (09 §2.2). Wrong with the page off as well as on.
    const paged = ruleIn(FLAT, 'html[data-mpe-ra-page] body .mpe-ra-help-body');
    assert.ok(
      paged.includes(
        '--mpe-ra-line-height: var(--mpe-ra-page-line-height, 1.6);',
      ),
      paged,
    );
    const off = ruleIn(SHEET_FLAT, '.mpe-ra-help-body');
    assert.ok(off.includes('--mpe-ra-line-height: 1.6;'), off);
  });

  test('the block rhythm is the canvas’s, in both page states', () => {
    const paged = ruleIn(FLAT, 'html[data-mpe-ra-page] body .mpe-ra-help-body');
    assert.ok(paged.includes('--mpe-ra-block-gap: 1.25em;'), paged);
    const off = ruleIn(SHEET_FLAT, '.mpe-ra-help-body');
    assert.ok(off.includes('--mpe-ra-block-gap: 1.1em;'), off);
    const blocks = ruleIn(
      SHEET_FLAT,
      '.mpe-ra-help-body :is(p, blockquote, ul, ol, dl, table)',
    );
    assert.ok(blocks.includes('margin: 0 0 var(--mpe-ra-block-gap);'), blocks);
    assert.ok(ruleIn(SHEET_FLAT, '.mpe-ra-help-body li').includes('0.2em'));
    assert.ok(
      !/\.mpe-ra-help-body :is\(p, ul, ol, blockquote\)/.test(SHEET_FLAT),
      'the old 0.5em rule is gone',
    );
  });

  test('the heading scale is the canvas’s, and the colour is named', () => {
    const expected = {
      h1: '1.6em',
      h2: '1.3em',
      h3: '1.2em',
      h4: '1.1em',
    };
    for (const [tag, size] of Object.entries(expected)) {
      assert.ok(
        ruleIn(SHEET_FLAT, `.mpe-ra-help-body ${tag}`).includes(
          `font-size: ${size};`,
        ),
        tag,
      );
    }
    assert.ok(
      ruleIn(SHEET_FLAT, '.mpe-ra-help-body :is(h5, h6)').includes(
        'font-size: 1em;',
      ),
    );
    const shape = ruleIn(
      SHEET_FLAT,
      '.mpe-ra-help-body :is(h1, h2, h3, h4, h5, h6)',
    );
    assert.ok(shape.includes('margin: 1.6em 0 0.55em;'), shape);
    // The page-off colour: the sheet's own foreground, which applyBarScheme
    // keeps in step with the panel surface (09 §5.2).
    assert.ok(shape.includes('color: inherit;'), shape);
  });

  test('the answer wraps at the measure, and the sheet is that wide', () => {
    const sheet = ruleIn(FLAT, 'html[data-mpe-ra-page] body .mpe-ra-help');
    assert.ok(
      sheet.includes('width: calc(var(--mpe-ra-page-measure, 33em) + 40px);'),
      sheet,
    );
    assert.ok(sheet.includes('max-height: 70vh;'), sheet);
    const body = ruleIn(FLAT, 'html[data-mpe-ra-page] body .mpe-ra-help-body');
    assert.ok(
      body.includes('max-width: var(--mpe-ra-page-measure, 33em);'),
      body,
    );
    assert.ok(body.includes('margin-inline: auto;'), body);
    // With the page off there is no template to follow, so the sheet keeps
    // 04's own 680 px and 60 vh (09 D2); the page rules above override them.
    const off = ruleIn(SHEET_FLAT, '.mpe-ra-help');
    assert.ok(off.includes('width: 680px;'), off);
    assert.ok(off.includes('max-height: 60vh;'), off);
  });

  test('the player font reaches the sheet, with its fallback inside the var()', () => {
    const body = ruleIn(FLAT, 'html[data-mpe-ra-page] body .mpe-ra-help-body');
    // A var() on an undefined property makes the whole declaration invalid at
    // computed-value time, so the fallback cannot follow the var() in the
    // list — the sheet would inherit the panel's UI font.
    assert.ok(
      /font-family: var\( --mpe-ra-font-family, 'Atkinson Hyperlegible Next',/.test(
        body,
      ),
      body,
    );
    assert.ok(
      !/font-family: var\(--mpe-ra-font-family\),/.test(FLAT),
      'never a bare var() followed by a fallback list',
    );
  });

  test('every element with a `display` still honours [hidden]', () => {
    // The UA's `[hidden] { display: none }` loses to any author `display`,
    // so each of these has to say it again. The affordance grew a
    // `display: flex` when it became a two-button cluster (09 §10) and went
    // on rendering over the open sheet until this rule was added.
    for (const selector of [
      '.mpe-ra-float',
      '.mpe-ra-float-btn',
      '.mpe-ra-help',
      '.mpe-ra-help-btn',
      '.mpe-ra-help-status',
    ]) {
      assert.ok(
        new RegExp(
          selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '\\[hidden\\] \\{ display: none; \\}',
        ).test(SHEET_FLAT),
        `${selector}[hidden] is display: none`,
      );
    }
  });

  test('the sheet’s prose wraps for the eye like the column’s', () => {
    const prose = ruleIn(
      FLAT,
      'html[data-mpe-ra-page] body .mpe-ra-help-body :is(p, li, dd, dt, blockquote, figcaption)',
    );
    assert.ok(prose.includes('text-wrap: pretty;'), prose);
  });
});
