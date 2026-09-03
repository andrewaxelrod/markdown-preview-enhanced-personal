/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// Lane B / T-14, T-15, T-16, T-20 — block eligibility (spec F6, F1).
//
// The fixture is rendered by crossnote itself (contract decision (c)): the
// preview HTML is a pure function of (markdown, config, crossnote version) and
// crossnote is pinned exactly, so the assertions below always run against the
// HTML the extension really sees. `mpe-test.md` lives at the workspace root,
// outside this git repo, so its 57 lines are embedded verbatim and T-20 checks
// the copy against the file when it is reachable (contract B10, G-04).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { Notebook } = require('crossnote');
const core = require('../../media/read-aloud-core.js');

const MPE_TEST_MD_LINES = [
  '---',
  'title: MPE smoke test',
  '---',
  '',
  '# Markdown Preview Enhanced — smoke test',
  '',
  'Preview: **⌘K V** (side) or **⌘⇧V** (full tab).',
  '',
  '[TOC]',
  '',
  '## Basics',
  '',
  '*Italic*, **bold**, ~~strike~~, `inline code`, [a link](https://shd101wyy.github.io/markdown-preview-enhanced/).',
  '',
  '- [x] task done',
  '- [ ] task pending',
  '',
  '| Feature | Renders? |',
  '| ------- | -------- |',
  '| Tables  | ✅       |',
  '| Math    | ?        |',
  '',
  '> Blockquote with a footnote.[^1]',
  '',
  '[^1]: Footnote text — should land at the bottom.',
  '',
  '## Math (KaTeX)',
  '',
  'Inline: $e^{i\\pi} + 1 = 0$',
  '',
  '$$',
  '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
  '$$',
  '',
  '## Mermaid',
  '',
  '```mermaid',
  'graph LR',
  '  A[Edit src/] --> B[pnpm build]',
  '  B --> C[vsce package]',
  '  C --> D[install vsix]',
  '  D --> A',
  '```',
  '',
  '## Code chunk (press ⇧⏎ on the line below)',
  '',
  '```js {cmd=node}',
  "console.log('code chunks work:', 2 + 2);",
  '```',
  '',
  '## Syntax highlighting',
  '',
  '```typescript',
  'export function activate(context: vscode.ExtensionContext) {',
  "  console.log('extension active');",
  '}',
  '```',
  '',
];
const MPE_TEST_MD = MPE_TEST_MD_LINES.join('\n');

// The F6 rows that `mpe-test.md` does not exercise.
const SECOND_FIXTURE_LINES = [
  '1. First ordered item',
  '2. Second ordered item',
  '',
  '- Outer item',
  '  - Nested item',
  '- Second outer',
  '',
  '![alt text](https://example.com/a.png)',
  '',
  '<iframe src="https://example.com" width="100"></iframe>',
  '',
  '<div class="note">Raw HTML prose block.</div>',
  '',
  '<h3 id="anchored"><a class="header-anchor" href="#anchored">#</a>Anchored heading</h3>',
  '',
  '```wavedrom',
  '{ signal: [{ name: "clk", wave: "p......" }] }',
  '```',
  '',
  '```vega-lite',
  '{ "mark": "bar" }',
  '```',
  '',
  '$$',
  'a^2 + b^2 = c^2',
  '$$',
  '',
];
const SECOND_FIXTURE_MD = SECOND_FIXTURE_LINES.join('\n');

const PREVIEW_OPEN =
  '<!doctype html><body class="preview-container">' +
  '<div class="crossnote markdown-preview" data-for="preview">';
const PREVIEW_CLOSE = '</div></body>';

let tempDir;
let notebook;

async function renderPreview(markdown, name) {
  const engine = notebook.getNoteMarkdownEngine(path.join(tempDir, name));
  const { html } = await engine.parseMD(markdown, {
    isForPreview: true,
    useRelativeFilePath: false,
    hideFrontMatter: false,
  });
  const dom = new JSDOM(PREVIEW_OPEN + html + PREVIEW_CLOSE);
  return {
    dom,
    root: dom.window.document.querySelector(core.ROOT_SELECTOR),
  };
}

suite('read-aloud: block eligibility (F6)', function () {
  this.timeout(20000);

  let smoke;
  let extra;

  suiteSetup(async function () {
    this.timeout(20000);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-ra-fixture-'));
    notebook = await Notebook.init({ notebookPath: tempDir, config: {} });
    smoke = await renderPreview(MPE_TEST_MD, 'mpe-test.md');
    extra = await renderPreview(SECOND_FIXTURE_MD, 'extra.md');
  });

  suiteTeardown(function () {
    if (smoke && smoke.dom) {
      smoke.dom.window.close();
    }
    if (extra && extra.dom) {
      extra.dom.window.close();
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // T-14
  test('T-14 mpe-test.md: 20 direct children, 11 eligible blocks in order', function () {
    const children = smoke.root.children;
    assert.strictEqual(
      children.length,
      20,
      'direct children of the preview root',
    );

    const blocks = core.collectBlocks(smoke.root);
    const shape = blocks.map((b) => b.el.tagName + ':' + b.kind);
    assert.deepStrictEqual(shape, [
      'H1:heading',
      'P:paragraph',
      'H2:heading',
      'P:paragraph',
      'UL:list',
      'BLOCKQUOTE:blockquote',
      'H2:heading',
      'P:paragraph', // "Inline: $…$": the prose is read, the math skipped
      'H2:heading',
      'H2:heading',
      'H2:heading',
    ]);
    assert.deepStrictEqual(
      blocks.map((b) => b.index),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      'index is the ordinal among eligible blocks',
    );

    // The eligible blocks are exactly the F1 acceptance list.
    assert.strictEqual(
      blocks[0].el.id,
      'markdown-preview-enhanced--smoke-test',
    );
    assert.match(core.extractText(blocks[1].el).text, /^Preview:/);
    assert.strictEqual(blocks[2].el.id, 'basics');
    assert.strictEqual(
      core.extractText(blocks[3].el).text,
      'Italic, bold, strike, inline code, a link.',
    );
    assert.strictEqual(
      core.extractText(blocks[4].el).text,
      'task done task pending',
    );
    assert.strictEqual(
      core.extractText(blocks[5].el).text,
      'Blockquote with a footnote.',
    );
    assert.strictEqual(blocks[6].el.id, 'math-katex');
    assert.strictEqual(
      core.extractText(blocks[7].el).text,
      'Inline:',
      'decision 8: the paragraph with inline math reads its prose only',
    );
    assert.ok(blocks[7].el.querySelector('.katex'), 'the math is still there');
    assert.strictEqual(blocks[8].el.id, 'mermaid');
    assert.strictEqual(blocks[9].el.id, 'code-chunk-press--on-the-line-below');
    assert.strictEqual(blocks[10].el.id, 'syntax-highlighting');
  });

  // T-14
  test('T-14 mpe-test.md: every ineligible child reports its F6 kind', function () {
    const children = smoke.root.children;
    const expected = [
      [2, 'DIV', 'toc'],
      [6, 'TABLE', 'table'],
      [10, 'SPAN', 'math'], // display math
      [12, 'DIV', 'diagram'], // mermaid
      [14, 'DIV', 'code-chunk'],
      [16, 'PRE', 'code'],
      [17, 'P', 'empty'],
      [18, 'HR', 'footnotes'],
      [19, 'SECTION', 'footnotes'],
    ];
    for (const [index, tag, kind] of expected) {
      const el = children[index];
      const info = core.classifyBlock(el);
      assert.strictEqual(el.tagName, tag, 'tag at child ' + index);
      assert.strictEqual(info.kind, kind, 'kind at child ' + index);
      assert.strictEqual(info.eligible, false, 'eligible at child ' + index);
    }

    // The two blocks under "## Math (KaTeX)": the inline-math paragraph is
    // read with the math skipped (decision 8), the display math never is.
    assert.strictEqual(children[9].getAttribute('data-source-line'), '29');
    assert.ok(children[9].querySelector('.katex'), 'inline KaTeX span present');
    assert.strictEqual(core.classifyBlock(children[9]).kind, 'paragraph');
    assert.strictEqual(core.classifyBlock(children[9]).eligible, true);
    assert.ok(children[10].classList.contains('katex-display'));
    assert.ok(children[2].querySelector('.md-toc'), 'TOC container');
    assert.ok(children[12].classList.contains('mermaid'));
    assert.ok(children[14].classList.contains('code-chunk'));
    assert.strictEqual(children[16].getAttribute('data-role'), 'codeBlock');
    assert.ok(children[18].classList.contains('footnotes-sep'));
    assert.ok(children[19].classList.contains('footnotes'));
  });

  // T-15
  test('T-15 remaining F6 rows: lists, media, containers, diagrams, math', function () {
    const children = extra.root.children;
    const kinds = Array.prototype.map.call(children, (el) => {
      const info = core.classifyBlock(el);
      return (
        el.tagName + ':' + info.kind + ':' + (info.eligible ? 'yes' : 'no')
      );
    });
    assert.deepStrictEqual(kinds, [
      'OL:list:yes',
      'UL:list:yes',
      'P:empty:no', // image-only paragraph
      'IFRAME:media:no',
      'DIV:container:yes', // raw HTML prose
      'H3:heading:yes',
      'DIV:diagram:no', // wavedrom
      'P:diagram:no', // vega-lite (crossnote renders it into a <p>)
      'SPAN:math:no', // display math
      'P:empty:no',
    ]);

    assert.strictEqual(
      core.extractText(children[0]).text,
      'First ordered item Second ordered item',
    );
    assert.strictEqual(
      core.extractText(children[1]).text,
      'Outer item Nested item Second outer',
      'nested lists are read in document order',
    );
    assert.strictEqual(
      core.extractText(children[4]).text,
      'Raw HTML prose block.',
    );
    assert.strictEqual(
      core.extractText(children[5]).text,
      'Anchored heading',
      'the heading anchor link is not spoken',
    );

    const eligible = core.collectBlocks(extra.root);
    assert.deepStrictEqual(
      eligible.map((b) => b.el.tagName),
      ['OL', 'UL', 'DIV', 'H3'],
    );
  });

  // T-16
  test('T-16 performance guard: 2,000 blocks classified in under 250 ms', function () {
    const document_ = smoke.dom.window.document;
    const big = document_.createElement('div');
    big.className = 'crossnote markdown-preview';
    big.setAttribute('data-for', 'preview');
    let html = '';
    for (let i = 0; i < 2000; i++) {
      html +=
        '<p data-source-line="' +
        i +
        '">Paragraph number ' +
        i +
        ' with <em>emphasis</em> and <code>code</code> plus a ' +
        '<a href="#x">link</a>.</p>';
    }
    big.innerHTML = html;
    document_.body.appendChild(big);

    const started = Date.now();
    const blocks = core.collectBlocks(big);
    for (const block of blocks) {
      core.blockKey(block.el, core.extractText(block.el).text);
    }
    const elapsed = Date.now() - started;
    big.remove();

    assert.strictEqual(blocks.length, 2000);
    assert.ok(
      elapsed <= 250,
      'collectBlocks + blockKey over 2,000 blocks took ' + elapsed + ' ms',
    );
  });

  // T-20
  test('T-20 fixture parity with the workspace copy of mpe-test.md', function () {
    const onDisk = path.resolve(__dirname, '..', '..', '..', 'mpe-test.md');
    if (!fs.existsSync(onDisk)) {
      this.skip();
      return;
    }
    assert.strictEqual(
      MPE_TEST_MD,
      fs.readFileSync(onDisk, 'utf8'),
      'embedded fixture drifted from ' + onDisk,
    );
  });
});
