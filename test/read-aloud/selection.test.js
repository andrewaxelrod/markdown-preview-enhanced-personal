/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// Lane B / T-19 — selection resolution (spec F2, decision D3; contract §4 (j)).

const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const core = require('../../media/read-aloud-core.js');

const FIXTURE =
  '<h2 id="intro">Intro heading</h2>' +
  '<p id="p1">First paragraph with several words.</p>' +
  '<table id="grid"><thead><tr><th id="head1">Feature</th>' +
  '<th id="head2">Renders?</th></tr></thead><tbody><tr>' +
  '<td id="cell1">Tables render</td><td id="cell2">yes</td>' +
  '</tr></tbody></table>' +
  '<p id="mathp" data-source-line="29">Inline: ' +
  '<span class="katex"><span class="katex-mathml"><math><mi>e</mi></math></span>' +
  '</span> and more.</p>' +
  '<p id="p2">Second paragraph with more words.</p>' +
  '<pre id="fence" data-role="codeBlock" class="language-typescript">' +
  '<code>const answer = 42;</code></pre>' +
  '<div id="diagram" class="mermaid" data-source-line="37">graph LR</div>' +
  '<p id="p3">Third paragraph here.</p>' +
  '<blockquote id="quote"><p id="qp">Quoted prose here.</p>' +
  '<pre id="qfence" data-role="codeBlock" class="language-js">' +
  '<code>let nested = 1;</code></pre></blockquote>' +
  '<ul id="list"><li id="li1">Item text' +
  '<div id="ldiagram" class="mermaid" data-source-line="50">graph TD</div>' +
  '</li></ul>';

const PREVIEW_OPEN =
  '<!doctype html><body class="preview-container">' +
  '<div class="crossnote markdown-preview" data-for="preview">';
const PREVIEW_CLOSE = '</div></body>';

let dom;
let doc;
let win;
let root;

/** Put a range on the document selection and resolve it. */
function select(build) {
  const range = doc.createRange();
  build(range);
  const selection = win.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return core.resolveSelection(selection, root);
}

function textNodeOf(id) {
  return doc.getElementById(id).firstChild;
}

suite('read-aloud: selection rules (F2, D3)', function () {
  this.timeout(20000);

  suiteSetup(function () {
    dom = new JSDOM(PREVIEW_OPEN + FIXTURE + PREVIEW_CLOSE);
    win = dom.window;
    doc = win.document;
    root = doc.querySelector(core.ROOT_SELECTOR);
  });

  suiteTeardown(function () {
    if (dom) {
      dom.window.close();
    }
  });

  // T-19
  test('T-19 a selection inside one table cell is read', function () {
    const result = select((range) => {
      range.setStart(textNodeOf('cell1'), 0);
      range.setEnd(textNodeOf('cell1'), 6);
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.text, 'Tables');
    assert.deepStrictEqual(
      result.blocks.map((el) => el.id),
      ['cell1'],
    );
    const span = { text: 'Tables', charStart: 0, charEnd: 6 };
    assert.strictEqual(
      core.spanToRange(result.map, span, doc).toString(),
      'Tables',
    );
  });

  // T-19
  test('T-19 a selection across two cells is refused with the hint', function () {
    const result = select((range) => {
      range.setStart(textNodeOf('cell1'), 0);
      range.setEnd(textNodeOf('cell2'), 3);
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'multi-cell');
    assert.strictEqual(result.hint, 'Select text within a single table cell');
    assert.strictEqual(result.hint, core.HINT_MULTI_CELL);
  });

  // T-19 — Chromium hands out cell-based ranges (anchored on the <tr>) as soon
  // as a drag brushes a cell border; the cells covered with text decide.
  test('T-19 a cell-based range that covers exactly one cell reads that cell', function () {
    const row = doc.getElementById('cell1').parentNode;
    const wholeCell = select((range) => {
      range.setStart(row, 0);
      range.setEnd(row, 1);
    });
    assert.strictEqual(wholeCell.ok, true);
    assert.strictEqual(wholeCell.text, 'Tables render');
    assert.deepStrictEqual(
      wholeCell.blocks.map((el) => el.id),
      ['cell1'],
    );

    const toRowBoundary = select((range) => {
      range.setStart(textNodeOf('cell1'), 7);
      range.setEnd(row, 1);
    });
    assert.strictEqual(toRowBoundary.ok, true);
    assert.strictEqual(toRowBoundary.text, 'render');
    assert.deepStrictEqual(
      toRowBoundary.blocks.map((el) => el.id),
      ['cell1'],
    );

    const twoCells = select((range) => {
      range.setStart(row, 0);
      range.setEnd(row, 2);
    });
    assert.strictEqual(twoCells.ok, false);
    assert.strictEqual(twoCells.reason, 'multi-cell');

    const spaceOnly = select((range) => {
      range.setStart(textNodeOf('cell1'), 6);
      range.setEnd(textNodeOf('cell1'), 7);
    });
    assert.strictEqual(spaceOnly.ok, false);
    assert.strictEqual(spaceOnly.reason, 'whitespace');
  });

  // T-19
  test('T-19 a selection across a header cell and a body cell is refused too', function () {
    const result = select((range) => {
      range.setStart(textNodeOf('head1'), 0);
      range.setEnd(textNodeOf('cell2'), 3);
    });
    assert.strictEqual(result.reason, 'multi-cell');
  });

  // T-19
  test('T-19 selections inside code, diagrams and inline math are refused', function () {
    const inCode = select((range) => {
      const code = doc.getElementById('fence').querySelector('code').firstChild;
      range.setStart(code, 0);
      range.setEnd(code, 5);
    });
    assert.strictEqual(inCode.ok, false);
    assert.strictEqual(inCode.reason, 'ineligible');
    assert.strictEqual(
      inCode.hint,
      'Read aloud is not available for code or diagrams',
    );

    const inDiagram = select((range) => {
      const diagram = textNodeOf('diagram');
      range.setStart(diagram, 0);
      range.setEnd(diagram, 5);
    });
    assert.strictEqual(inDiagram.reason, 'ineligible');
    assert.strictEqual(inDiagram.hint, core.HINT_INELIGIBLE);

    // Decision 8: the prose beside inline math is read, the math itself is
    // refused at any depth.
    const besideMath = select((range) => {
      const prose = textNodeOf('mathp');
      range.setStart(prose, 0);
      range.setEnd(prose, 7);
    });
    assert.strictEqual(besideMath.ok, true);
    assert.strictEqual(besideMath.text, 'Inline:');
    assert.strictEqual(
      core.classifyBlock(doc.getElementById('mathp')).kind,
      'paragraph',
    );
    const inMath = select((range) => {
      const mi = doc.querySelector('#mathp mi').firstChild;
      range.setStart(mi, 0);
      range.setEnd(mi, 1);
    });
    assert.strictEqual(inMath.ok, false);
    assert.strictEqual(inMath.reason, 'ineligible');
    assert.strictEqual(inMath.hint, core.HINT_INELIGIBLE);
  });

  // T-19
  test('T-19 whitespace-only and collapsed selections are silent', function () {
    const spaceAt = doc.getElementById('p1').textContent.indexOf(' ');
    const whitespace = select((range) => {
      range.setStart(textNodeOf('p1'), spaceAt);
      range.setEnd(textNodeOf('p1'), spaceAt + 1);
    });
    assert.strictEqual(whitespace.ok, false);
    assert.strictEqual(whitespace.reason, 'whitespace');
    assert.strictEqual(whitespace.hint, '');

    const selection = win.getSelection();
    selection.removeAllRanges();
    const collapsed = doc.createRange();
    collapsed.setStart(textNodeOf('p1'), 3);
    collapsed.collapse(true);
    selection.addRange(collapsed);
    const empty = core.resolveSelection(selection, root);
    assert.strictEqual(empty.reason, 'empty');
    assert.strictEqual(empty.hint, '');

    selection.removeAllRanges();
    assert.strictEqual(
      core.resolveSelection(selection, root).reason,
      'empty',
      'no range at all',
    );
  });

  // T-19
  test('T-19 a multi-block selection is clipped, joined and stripped of ineligible blocks', function () {
    const result = select((range) => {
      range.setStart(textNodeOf('p1'), 6);
      range.setEnd(textNodeOf('p2'), 6);
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(
      result.blocks.map((el) => el.id),
      ['p1', 'mathp', 'p2'],
      'the table is dropped; the inline-math paragraph reads its prose',
    );
    assert.strictEqual(
      result.text,
      'paragraph with several words.\nInline: and more.\nSecond',
    );
    assert.strictEqual(result.text, result.text.trim());
    assert.strictEqual(
      core
        .spanToRange(
          result.map,
          {
            text: 'Second',
            charStart: result.text.indexOf('Second'),
            charEnd: result.text.length,
          },
          doc,
        )
        .toString(),
      'Second',
    );
  });

  // T-19 (G-12)
  test('T-19 empty clipped blocks never produce a leading or trailing newline', function () {
    // Triple-click shape: the range ends at the start of the next block.
    const tripleClick = select((range) => {
      range.setStart(textNodeOf('p1'), 0);
      range.setEnd(doc.getElementById('mathp'), 0);
    });
    assert.strictEqual(tripleClick.ok, true);
    assert.strictEqual(tripleClick.text, 'First paragraph with several words.');
    assert.strictEqual(tripleClick.text, tripleClick.text.trim());
    assert.deepStrictEqual(
      tripleClick.blocks.map((el) => el.id),
      ['p1'],
    );

    // Drag shape: the range starts at the very end of a block's last text node.
    const fromBlockEnd = select((range) => {
      const first = textNodeOf('p1');
      range.setStart(first, first.data.length);
      range.setEnd(textNodeOf('p2'), 6);
    });
    assert.strictEqual(fromBlockEnd.ok, true);
    assert.strictEqual(fromBlockEnd.text, 'Inline: and more.\nSecond');
    assert.deepStrictEqual(
      fromBlockEnd.blocks.map((el) => el.id),
      ['mathp', 'p2'],
    );
  });

  // T-19
  test('T-19 a selection with no eligible block at all is refused', function () {
    const result = select((range) => {
      range.setStart(doc.getElementById('fence'), 0);
      range.setEnd(doc.getElementById('diagram'), 1);
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'ineligible');
    assert.strictEqual(result.hint, core.HINT_INELIGIBLE);
  });

  // T-19
  test('T-19 a selection longer than MAX_TEXT_CHARS is refused before any request', function () {
    const long = doc.createElement('p');
    long.id = 'long';
    long.textContent = 'word '.repeat(41000);
    root.appendChild(long);
    try {
      const result = select((range) => {
        range.selectNodeContents(long);
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'too-long');
      assert.strictEqual(result.hint, 'Selection is too long to read aloud');
      assert.strictEqual(result.hint, core.HINT_TOO_LONG);
      assert.ok(core.MAX_TEXT_CHARS === 200000);
    } finally {
      long.remove();
    }
  });

  // T-19 — F6 holds at every depth, not only for direct children of the root.
  test('T-19 a selection inside a code fence nested in a blockquote is refused', function () {
    const result = select((range) => {
      const code = doc
        .getElementById('qfence')
        .querySelector('code').firstChild;
      range.setStart(code, 0);
      range.setEnd(code, 6);
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'ineligible');
    assert.strictEqual(result.hint, core.HINT_INELIGIBLE);
    assert.strictEqual(
      core.classifyBlock(doc.getElementById('quote')).eligible,
      true,
      'the blockquote itself keeps its play button',
    );
  });

  // T-19
  test('T-19 a selection inside a diagram nested in a list item is refused', function () {
    const result = select((range) => {
      const diagram = textNodeOf('ldiagram');
      range.setStart(diagram, 0);
      range.setEnd(diagram, 5);
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'ineligible');
    assert.strictEqual(result.hint, core.HINT_INELIGIBLE);
  });

  // T-19
  test('T-19 prose beside a nested code fence or diagram is still read', function () {
    const quoted = select((range) => {
      range.setStart(textNodeOf('qp'), 0);
      range.setEnd(textNodeOf('qp'), 6);
    });
    assert.strictEqual(quoted.ok, true);
    assert.strictEqual(quoted.text, 'Quoted');

    const item = select((range) => {
      range.setStart(textNodeOf('li1'), 0);
      range.setEnd(textNodeOf('li1'), 4);
    });
    assert.strictEqual(item.ok, true);
    assert.strictEqual(item.text, 'Item');
  });

  // T-19
  test('T-19 a selection outside the preview root is ignored', function () {
    const outside = doc.createElement('p');
    outside.textContent = 'Not in the preview.';
    doc.body.appendChild(outside);
    try {
      const result = select((range) => {
        range.selectNodeContents(outside);
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'empty');
    } finally {
      outside.remove();
    }
  });
});
