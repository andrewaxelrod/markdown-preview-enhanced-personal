/* global suite, test */
'use strict';

// The low-strain page's colour tokens (featrues/05-eye-strain.spec.md §5,
// §12): every pair of the requirement's acceptance table is computed here —
// WCAG 2.x for the light set and for the selection and mark tests in both
// sets, APCA-W3 0.1.9 for the dark set — so requirement P3 ("contrast is
// measured, not eyeballed") is a suite, not a checklist item. The test is the
// authority over media/read-aloud-page.css: adjust the hex, not the target.
//
// No dependency: the two formulas are forty lines, and the APCA one is pinned
// to APCA's own reference pairs before it judges a token.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud-page.css'),
  'utf8',
);

// ------------------------------------------------------------ the formulas

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `a six-digit hex colour, got ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 2.x relative luminance: piecewise sRGB, 0.2126 / 0.7152 / 0.0722. */
function wcagLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, ≥ 1. */
function wcag(fg, bg) {
  const a = wcagLuminance(fg);
  const b = wcagLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * APCA-W3 0.1.9 (SAPC-4g): simple 2.4 exponent, black soft clamp at 0.022
 * with exponent 1.414, normal polarity (Ybg^0.56 − Ytxt^0.57) × 1.14 and
 * reverse (Ybg^0.65 − Ytxt^0.62) × 1.14, low clip 0.1, offset 0.027, × 100.
 * Signed: negative for light text on a dark background.
 */
function apca(text, bg) {
  const toY = (hex) => {
    const [r, g, b] = hexToRgb(hex).map((c) => Math.pow(c / 255, 2.4));
    return 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  };
  const clamp = (y) => (y > 0.022 ? y : y + Math.pow(0.022 - y, 1.414));
  const yTxt = clamp(toY(text));
  const yBg = clamp(toY(bg));
  if (Math.abs(yBg - yTxt) < 0.0005) {
    return 0;
  }
  let sapc;
  let out;
  if (yBg > yTxt) {
    sapc = (Math.pow(yBg, 0.56) - Math.pow(yTxt, 0.57)) * 1.14;
    out = sapc < 0.1 ? 0 : sapc - 0.027;
  } else {
    sapc = (Math.pow(yBg, 0.65) - Math.pow(yTxt, 0.62)) * 1.14;
    out = sapc > -0.1 ? 0 : sapc + 0.027;
  }
  return out * 100;
}

function lc(text, bg) {
  return Math.abs(apca(text, bg));
}

// ---------------------------------------------------------- the stylesheet

/** The `--name: value` pairs of one `selector { … }` block, `var()` resolved. */
function tokenBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(CSS);
  assert.ok(m, `the stylesheet has a ${selector} block`);
  const tokens = {};
  const re = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
  let d = re.exec(m[1]);
  while (d) {
    tokens[d[1]] = d[2].trim();
    d = re.exec(m[1]);
  }
  for (const name of Object.keys(tokens)) {
    let guard = 0;
    while (/^var\(--/.test(tokens[name]) && guard++ < 5) {
      const ref = /^var\(--([a-z0-9-]+)\)$/.exec(tokens[name]);
      assert.ok(ref && tokens[ref[1]], `${name} references a known token`);
      tokens[name] = tokens[ref[1]];
    }
  }
  return tokens;
}

const UNCOMMENTED = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const LIGHT = tokenBlock("html[data-mpe-ra-page='light']");
const DARK = tokenBlock("html[data-mpe-ra-page='dark']");

const SEMANTIC = ['info', 'success', 'warning', 'error'];
const SYNTAX = [
  'syntax-comment',
  'syntax-keyword',
  'syntax-string',
  'syntax-number',
  'syntax-function',
  'syntax-tag',
  'syntax-attr',
  'syntax-punctuation',
];

function atLeast(actual, target, what) {
  assert.ok(
    actual >= target,
    `${what}: ${actual.toFixed(2)} is below the target ${target}`,
  );
}

suite('read-aloud low-strain page: the formulas', () => {
  test('WCAG 2.x reference pairs', () => {
    assert.ok(Math.abs(wcag('#000000', '#ffffff') - 21) < 0.01);
    assert.ok(Math.abs(wcag('#ffffff', '#ffffff') - 1) < 0.001);
    // WebAIM: #777777 on #ffffff is 4.48:1.
    assert.ok(Math.abs(wcag('#777777', '#ffffff') - 4.48) < 0.01);
    assert.ok(Math.abs(wcag('#ffffff', '#777777') - 4.48) < 0.01);
  });

  test('APCA-W3 0.1.9 reference pairs (±0.5 Lc)', () => {
    assert.ok(Math.abs(apca('#888888', '#ffffff') - 63.1) < 0.5);
    assert.ok(Math.abs(apca('#ffffff', '#888888') - -68.5) < 0.5);
    assert.ok(Math.abs(apca('#000000', '#aaaaaa') - 58.1) < 0.5);
    assert.ok(Math.abs(apca('#aaaaaa', '#000000') - -56.2) < 0.5);
  });
});

suite('read-aloud low-strain page: the light tokens (WCAG 2.x)', () => {
  test('every token of the acceptance table is declared', () => {
    for (const name of [
      'canvas',
      'surface',
      'text',
      'text-muted',
      'link',
      'selection-bg',
      'selection-text',
      'mark-bg',
      'mark-text',
      'mark-border',
      'focus',
      'rule',
      'code-surface',
      'quote-surface',
      'quote-border',
      'panel-surface',
    ]) {
      assert.ok(LIGHT[name], `light --${name}`);
    }
    for (const pair of SEMANTIC) {
      assert.ok(LIGHT[pair + '-surface'] && LIGHT[pair + '-text'], pair);
    }
    for (const name of SYNTAX) {
      assert.ok(LIGHT[name], `light --${name}`);
    }
  });

  test('body text is AAA on every surface it sits on', () => {
    atLeast(wcag(LIGHT.text, LIGHT.surface), 7, 'text on surface');
    atLeast(wcag(LIGHT.text, LIGHT.canvas), 7, 'text on canvas');
    atLeast(wcag(LIGHT.text, LIGHT['code-surface']), 7, 'text on code');
    atLeast(wcag(LIGHT.text, LIGHT['quote-surface']), 7, 'text on quote');
    atLeast(wcag(LIGHT.text, LIGHT['panel-surface']), 7, 'text on panel');
    for (const pair of SEMANTIC) {
      atLeast(
        wcag(LIGHT.text, LIGHT[pair + '-surface']),
        4.5,
        `text on ${pair} surface (callout body)`,
      );
    }
  });

  test('muted text, links and focus', () => {
    atLeast(wcag(LIGHT['text-muted'], LIGHT.surface), 4.5, 'muted on surface');
    atLeast(wcag(LIGHT.link, LIGHT.surface), 7, 'link on surface (1.11)');
    // A #tag is a link on the code surface (§8; crossnote's badge shape).
    atLeast(
      wcag(LIGHT.link, LIGHT['code-surface']),
      4.5,
      'tag on code surface',
    );
    atLeast(wcag(LIGHT.focus, LIGHT.surface), 3, 'focus ring on surface');
  });

  test('the selection dual test (4.2) and the mark (4.4)', () => {
    atLeast(
      wcag(LIGHT['selection-bg'], LIGHT.surface),
      3,
      'selection background on surface',
    );
    atLeast(
      wcag(LIGHT['selection-text'], LIGHT['selection-bg']),
      4.5,
      'selected text on the selection background',
    );
    atLeast(
      wcag(LIGHT['mark-text'], LIGHT['mark-bg']),
      4.5,
      'mark text on the mark background',
    );
    // No light amber reaches 3:1 on an off-white page, which is why the light
    // mark carries a bottom border; the border itself must be visible.
    atLeast(
      wcag(LIGHT['mark-border'], LIGHT.surface),
      3,
      'mark border on surface',
    );
  });

  test('every semantic text on its surface, and every syntax colour on code', () => {
    for (const pair of SEMANTIC) {
      atLeast(
        wcag(LIGHT[pair + '-text'], LIGHT[pair + '-surface']),
        4.5,
        `${pair} text on its surface`,
      );
    }
    for (const name of SYNTAX) {
      atLeast(
        wcag(LIGHT[name], LIGHT['code-surface']),
        4.5,
        `${name} on the code surface`,
      );
    }
  });
});

suite('read-aloud low-strain page: the dark tokens (APCA)', () => {
  test('body text reaches Lc 90 on the surface, Lc 75 on every other', () => {
    atLeast(lc(DARK.text, DARK.surface), 90, 'text on surface');
    atLeast(lc(DARK.text, DARK.canvas), 75, 'text on canvas');
    atLeast(lc(DARK.text, DARK['code-surface']), 75, 'text on code');
    atLeast(lc(DARK.text, DARK['quote-surface']), 75, 'text on quote');
    atLeast(lc(DARK.text, DARK['panel-surface']), 75, 'text on panel');
    for (const pair of SEMANTIC) {
      atLeast(
        lc(DARK.text, DARK[pair + '-surface']),
        75,
        `text on ${pair} surface (callout body)`,
      );
    }
  });

  test('muted text is Lc 75, the link is the body colour, focus is 3:1', () => {
    atLeast(lc(DARK['text-muted'], DARK.surface), 75, 'muted on surface');
    // D10: no colour that still reads as blue reaches Lc 90 on #181818, so
    // the underline is the affordance and the link is the text colour.
    assert.strictEqual(DARK.link, DARK.text);
    // A #tag is a link on the code surface (§8; crossnote's badge shape).
    atLeast(lc(DARK.link, DARK['code-surface']), 75, 'tag on code surface');
    atLeast(wcag(DARK.focus, DARK.surface), 3, 'focus ring on surface');
  });

  test('the selection dual test (4.2, WCAG as written) and the mark (4.4)', () => {
    atLeast(
      wcag(DARK['selection-bg'], DARK.surface),
      3,
      'selection background on surface',
    );
    atLeast(
      wcag(DARK['selection-text'], DARK['selection-bg']),
      4.5,
      'selected text on the selection background',
    );
    atLeast(
      wcag(DARK['mark-bg'], DARK.surface),
      3,
      'mark background on surface (MUST for dark)',
    );
    atLeast(
      wcag(DARK['mark-text'], DARK['mark-bg']),
      4.5,
      'mark text on the mark background',
    );
  });

  test('every semantic text on its surface, and every syntax colour on code', () => {
    for (const pair of SEMANTIC) {
      atLeast(
        lc(DARK[pair + '-text'], DARK[pair + '-surface']),
        75,
        `${pair} text on its surface`,
      );
    }
    for (const name of SYNTAX) {
      atLeast(
        lc(DARK[name], DARK['code-surface']),
        75,
        `${name} on the code surface`,
      );
    }
  });

  test('the two requirement values that failed their own targets are corrected', () => {
    assert.ok(lc('#c6c6c6', DARK.surface) < 75, '#c6c6c6 was below Lc 75');
    assert.ok(wcag('#7a6012', DARK.surface) < 3, '#7a6012 was below 3:1');
    assert.notStrictEqual(DARK['text-muted'], '#c6c6c6');
    assert.notStrictEqual(DARK['mark-bg'], '#7a6012');
  });
});

suite('read-aloud low-strain page: P1 and the non-goals', () => {
  test('no token is pure black or pure white', () => {
    for (const [name, value] of [
      ...Object.entries(LIGHT),
      ...Object.entries(DARK),
    ]) {
      assert.ok(
        !/^#(000000|ffffff|000|fff)$/i.test(value),
        `--${name} is ${value}`,
      );
    }
  });

  test('no weight below 400 or at 700+, no px font size, no justified text', () => {
    const weights = Array.from(CSS.matchAll(/font-weight:\s*([^;]+);/g)).map(
      (m) => m[1],
    );
    assert.ok(weights.length > 0);
    for (const declaration of weights) {
      for (const value of declaration.split(/\s+/)) {
        const n = parseInt(value, 10);
        assert.ok(
          Number.isFinite(n) && n >= 400 && n < 700,
          `font-weight ${declaration}`,
        );
      }
    }
    assert.strictEqual(
      Array.from(CSS.matchAll(/font-size:\s*[^;]*px/g)).length,
      0,
      'no px font size',
    );
    assert.strictEqual(CSS.indexOf('justify'), -1);
  });

  test('component styles reference tokens, never raw hex, outside print', () => {
    const withoutTokens = UNCOMMENTED.replace(
      /html\[data-mpe-ra-page='(light|dark)'\]\s*\{[^}]*\}/g,
      '',
    );
    const withoutPrint = withoutTokens.replace(
      /@media print\s*\{[\s\S]*?\n\}/,
      '',
    );
    const hexes = Array.from(withoutPrint.matchAll(/#[0-9a-f]{3,8}\b/gi)).map(
      (m) => m[0],
    );
    assert.deepStrictEqual(hexes, []);
  });

  test('the ink-on-paper print rules and the dark image dimming exist', () => {
    assert.ok(/@media print[\s\S]*background-color:\s*#fff/.test(CSS));
    assert.ok(
      /html\[data-mpe-ra-page='dark'\][^{]*img:not\(\[data-no-dim\]\)\s*\{\s*filter:\s*brightness\(0\.85\)\s*contrast\(1\.05\)/.test(
        CSS,
      ),
    );
    assert.ok(/prefers-reduced-motion: reduce/.test(CSS));
    assert.ok(/::selection\s*\{[^}]*background-color[^}]*color/.test(CSS));
  });

  test('every content rule is scoped away from presentation mode', () => {
    // A rule that reaches into the document must carry the body guard; the
    // `:has()` rule on <html> itself and the player's own chrome are the
    // exceptions.
    const selectors = Array.from(
      UNCOMMENTED.matchAll(/(?:^|\n)\s*([^@{}\n][^{}]*?)\s*\{/g),
    ).map((m) => m[1].replace(/\s+/g, ' ').trim());
    assert.ok(selectors.length > 40, 'the selectors were found');
    const content = selectors.filter(
      (sel) =>
        /\.markdown-preview|\.md-sidebar-toc/.test(sel) && !/:has\(/.test(sel),
    );
    const unguarded = content.filter(
      (sel) => !/body:not\(\[data-presentation-mode\]\)/.test(sel),
    );
    assert.deepStrictEqual(unguarded, []);
    // And every rule in the file is the page's: nothing matches with the
    // attribute absent.
    const foreign = selectors.filter(
      (sel) => !/^html\[data-mpe-ra-page/.test(sel),
    );
    assert.deepStrictEqual(foreign, []);
  });
});

suite('read-aloud low-strain page: the preview themes', () => {
  // Specificity is not the whole story (spec §4.3): three bundled themes —
  // night, gothic, medium — colour running text directly (`body p { color }`),
  // and a rule that matches an element beats any inherited value. The page
  // must therefore name every element a theme colours. The scan is over
  // crossnote's own theme files, so a crossnote upgrade that adds one fails
  // here rather than in the Dev Host.
  const THEME_DIR = path.join(
    __dirname,
    '..',
    '..',
    'node_modules',
    'crossnote',
    'out',
    'styles',
    'preview_theme',
  );

  // Elements that carry running text. Icon carriers (`span`, `svg`) and form
  // controls are not the page's to colour.
  const TEXT_ELEMENTS = new Set([
    'p',
    'li',
    'ul',
    'ol',
    'dl',
    'dt',
    'dd',
    'table',
    'tr',
    'td',
    'th',
    'blockquote',
    'figcaption',
    'caption',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'a',
    'strong',
    'b',
    'em',
    'i',
    'code',
    'pre',
    'kbd',
    'mark',
    'del',
    's',
    '.math',
    '.mathjax-exps',
  ]);

  function rules(css) {
    const out = [];
    for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
      const i = block.indexOf('{');
      if (i < 0) {
        continue;
      }
      out.push({
        selector: block.slice(0, i).replace(/\s+/g, ' ').trim(),
        declarations: block.slice(i + 1),
      });
    }
    return out;
  }

  const setsColour = (declarations) => /(^|;)\s*color\s*:/.test(declarations);

  /** The subject of a theme selector: `body blockquote p` → `p`. */
  function subject(selector) {
    return selector
      .split(/\s*[>+~]\s*|\s+/)
      .pop()
      .replace(/::?[a-z-]+(\([^)]*\))?/g, '');
  }

  /** Whether a page selector names `element` — in a list or an `:is()`. */
  function names(selector, element) {
    const token = element.replace('.', '\\.');
    return new RegExp('(^|[\\s(,])' + token + '(?=[\\s),:]|$)').test(selector);
  }

  test('every element a bundled theme colours directly is coloured by the page', () => {
    const themes = fs
      .readdirSync(THEME_DIR)
      .filter((file) => file.endsWith('.css'));
    assert.ok(themes.length >= 15, 'the bundled themes were found');

    const themed = new Map();
    for (const file of themes) {
      const css = fs.readFileSync(path.join(THEME_DIR, file), 'utf8');
      for (const rule of rules(css)) {
        if (!setsColour(rule.declarations)) {
          continue;
        }
        for (const selector of rule.selector.split(',')) {
          const element = subject(selector.trim());
          if (TEXT_ELEMENTS.has(element)) {
            themed.set(element, (themed.get(element) || new Set()).add(file));
          }
        }
      }
    }
    // The rule exists for these; if a crossnote upgrade drops them the list in
    // the stylesheet can shrink, and this says so.
    for (const element of ['p', 'li', 'table', 'dt', '.math']) {
      assert.ok(themed.has(element), `${element} is coloured by a theme`);
    }
    assert.ok(
      ['night.css', 'gothic.css', 'medium.css'].every((file) =>
        themed.get('p').has(file),
      ),
      'night, gothic and medium colour paragraphs directly',
    );

    const withoutPrint = UNCOMMENTED.replace(
      /@media print\s*\{[\s\S]*?\n\}/,
      '',
    );
    const page = rules(withoutPrint).filter(
      (rule) =>
        rule.selector.startsWith('html[data-mpe-ra-page') &&
        setsColour(rule.declarations),
    );
    const missing = [];
    for (const [element, files] of themed) {
      if (!page.some((rule) => names(rule.selector, element))) {
        missing.push(`${element} (${Array.from(files).sort().join(', ')})`);
      }
    }
    assert.deepStrictEqual(missing, []);
  });
});
