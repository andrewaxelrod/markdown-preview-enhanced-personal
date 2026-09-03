/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// Click to read (spec F17): the caret -> text offset mapping, word snapping,
// map slicing and click resolution of media/read-aloud-core.js, run under
// jsdom like selection.test.js. The invariant the last suite guards: the
// reading decoration (pills, word spans) never changes the whole-unit text,
// so a start offset resolved on a decorated DOM is still right after the
// decoration is torn down and the unit is re-extracted.

const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const core = require('../../media/read-aloud-core.js');

const FIXTURE =
  '<h2 id="intro">Intro heading</h2>' +
  '<p id="p1">First   paragraph with <em id="em1">several</em> words.</p>' +
  '<p id="plink">Read the <a id="link" href="https://example.com">docs</a> now.</p>' +
  '<ul id="list">\n<li id="li1">Item one</li>\n' +
  '<li id="li2">Item two\n<ul>\n<li id="li3">Nested item</li>\n</ul>\n</li>\n</ul>' +
  '<ul id="tasks" class="contains-task-list"><li class="task-list-item">' +
  '<input id="cb" type="checkbox" disabled=""> task pending</li></ul>' +
  '<table id="grid"><thead><tr><th id="head1">Feature</th>' +
  '<th id="head2">Renders?</th></tr></thead><tbody>' +
  '<tr id="row1"><td id="cell1">Tables render fine</td><td id="cell2">yes</td></tr>' +
  '<tr><td id="mathcell">Math <span class="katex">x</span></td>' +
  '<td id="cell4">?</td></tr></tbody></table>' +
  '<p id="mathp">Inline: ' +
  '<span class="katex"><span class="katex-mathml"><math><mi>e</mi></math></span>' +
  '</span> and more.</p>' +
  '<pre id="fence" data-role="codeBlock" class="language-typescript">' +
  '<code>const answer = 42;</code></pre>' +
  '<div id="diagram" class="mermaid" data-source-line="37">graph LR</div>' +
  '<blockquote id="quote"><p id="qp">Quoted prose here.</p>' +
  '<pre id="qfence" data-role="codeBlock" class="language-js">' +
  '<code>let nested = 1;</code></pre></blockquote>' +
  '<div id="chunk" class="code-chunk"><table><tbody><tr>' +
  '<td id="chunkcell">output cell</td></tr></tbody></table></div>';

const PREVIEW_OPEN =
  '<!doctype html><body class="preview-container">' +
  '<div class="crossnote markdown-preview" data-for="preview">';
const PREVIEW_CLOSE = '</div></body>';

const P1_TEXT = 'First paragraph with several words.';

let dom;
let doc;
let root;

function textNodeOf(id) {
  return doc.getElementById(id).firstChild;
}

function click(node, offset) {
  return core.resolveClick(node, offset, root);
}

suite('read-aloud click to read: wordAt (F17)', function () {
  test('the word containing the caret, from its first letter', function () {
    assert.deepStrictEqual(core.wordAt(P1_TEXT, 2), { start: 0, end: 5 });
    assert.deepStrictEqual(core.wordAt(P1_TEXT, 0), { start: 0, end: 5 });
    assert.deepStrictEqual(core.wordAt(P1_TEXT, 6), { start: 6, end: 15 });
    assert.deepStrictEqual(core.wordAt(P1_TEXT, 14), { start: 6, end: 15 });
  });

  test('a caret right after a word (the right half of its last letter) is that word', function () {
    assert.deepStrictEqual(core.wordAt(P1_TEXT, 5), { start: 0, end: 5 });
    assert.deepStrictEqual(core.wordAt(P1_TEXT, 15), { start: 6, end: 15 });
    assert.deepStrictEqual(core.wordAt(P1_TEXT, P1_TEXT.length), {
      start: 29,
      end: 35,
    });
    assert.deepStrictEqual(
      core.wordAt(P1_TEXT, 999),
      { start: 29, end: 35 },
      'past the end clamps to the last word',
    );
  });

  test('no word when whitespace surrounds the caret or the text is empty', function () {
    assert.strictEqual(core.wordAt(' x', 0), null);
    assert.strictEqual(core.wordAt('a  b', 2), null);
    assert.strictEqual(core.wordAt('', 0), null);
  });
});

suite('read-aloud click to read: caret and slicing (F17)', function () {
  this.timeout(20000);

  suiteSetup(function () {
    dom = new JSDOM(PREVIEW_OPEN + FIXTURE + PREVIEW_CLOSE);
    doc = dom.window.document;
    root = doc.querySelector(core.ROOT_SELECTOR);
  });

  suiteTeardown(function () {
    if (dom) {
      dom.window.close();
    }
  });

  test('extraction collapses the fixture the way the tests assume', function () {
    assert.strictEqual(
      core.extractText(doc.getElementById('p1')).text,
      P1_TEXT,
    );
    assert.strictEqual(textNodeOf('p1').data, 'First   paragraph with ');
  });

  test('a caret inside a text node maps to its text offset, whitespace collapsed', function () {
    const map = core.extractText(doc.getElementById('p1')).map;
    const first = textNodeOf('p1');
    assert.strictEqual(core.caretToTextOffset(map, first, 2), 2);
    assert.strictEqual(core.caretToTextOffset(map, first, 5), 5, 'after First');
    assert.strictEqual(
      core.caretToTextOffset(map, first, 6),
      6,
      'inside the collapsed run: the next word',
    );
    assert.strictEqual(core.caretToTextOffset(map, first, 8), 6, 'paragraph');
    assert.strictEqual(core.caretToTextOffset(map, first, 12), 10);
  });

  test('a caret inside an inline element and at element boundaries', function () {
    const p1 = doc.getElementById('p1');
    const map = core.extractText(p1).map;
    const em = textNodeOf('em1');
    assert.strictEqual(
      core.caretToTextOffset(map, em, 3),
      P1_TEXT.indexOf('several') + 3,
    );
    assert.strictEqual(core.caretToTextOffset(map, p1, 0), 0);
    assert.strictEqual(
      core.caretToTextOffset(map, p1, p1.childNodes.length),
      P1_TEXT.length,
    );
    const last = p1.lastChild;
    assert.strictEqual(
      core.caretToTextOffset(map, last, last.data.length),
      P1_TEXT.length,
    );
  });

  test('sliceExtraction rebases the map and keeps the DOM nodes', function () {
    const whole = core.extractText(doc.getElementById('p1'));
    const at = P1_TEXT.indexOf('with');
    const sliced = core.sliceExtraction(whole, at);
    assert.strictEqual(sliced.text, 'with several words.');
    assert.strictEqual(sliced.map.text, sliced.text);
    assert.strictEqual(
      core
        .spanToRange(sliced.map, { charStart: 0, charEnd: 4 }, doc)
        .toString(),
      'with',
    );
    const several = sliced.text.indexOf('several');
    assert.strictEqual(
      core
        .spanToRange(
          sliced.map,
          { charStart: several, charEnd: several + 7 },
          doc,
        )
        .toString(),
      'several',
    );
    for (let k = 0; k < sliced.text.length; k++) {
      const a = core.offsetToDom(sliced.map, k);
      const b = core.offsetToDom(whole.map, k + at);
      assert.ok(a && b, `offset ${k} resolves`);
      assert.strictEqual(a.node, b.node);
      assert.strictEqual(a.offset, b.offset);
    }
  });

  test('sliceExtraction at 0 is the whole text; a cut on a space drops it', function () {
    const whole = core.extractText(doc.getElementById('p1'));
    const same = core.sliceExtraction(whole, 0);
    assert.strictEqual(same.text, P1_TEXT);
    assert.strictEqual(same.map.segments.length, whole.map.segments.length);
    const onSpace = core.sliceExtraction(whole, 5);
    assert.strictEqual(onSpace.text, 'paragraph with several words.');
    assert.strictEqual(onSpace.text, onSpace.text.trim());
  });
});

suite('read-aloud click to read: resolveClick (F17)', function () {
  this.timeout(20000);

  suiteSetup(function () {
    dom = new JSDOM(PREVIEW_OPEN + FIXTURE + PREVIEW_CLOSE);
    doc = dom.window.document;
    root = doc.querySelector(core.ROOT_SELECTOR);
  });

  suiteTeardown(function () {
    if (dom) {
      dom.window.close();
    }
  });

  test('a click in the middle of a word reads from that word to the end of the block', function () {
    const result = click(textNodeOf('p1'), 10);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.unit, 'block');
    assert.strictEqual(result.el.id, 'p1');
    assert.strictEqual(result.wholeText, P1_TEXT);
    assert.strictEqual(result.start, 6);
    assert.strictEqual(result.wordEnd, 15);
    assert.strictEqual(
      core.sliceExtraction(
        { text: result.wholeText, map: result.wholeMap },
        result.start,
      ).text,
      'paragraph with several words.',
    );
  });

  test('a click on the first word reads the whole block', function () {
    const result = click(textNodeOf('p1'), 0);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.start, 0);
    const heading = click(textNodeOf('intro'), 3);
    assert.strictEqual(heading.ok, true);
    assert.strictEqual(heading.el.id, 'intro');
    assert.strictEqual(heading.wholeText, 'Intro heading');
  });

  test('a click inside a nested list item reads to the end of the whole list', function () {
    const result = click(textNodeOf('li3'), 2);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.unit, 'block');
    assert.strictEqual(result.el.id, 'list');
    assert.strictEqual(result.wholeText, 'Item one Item two Nested item');
    assert.strictEqual(result.start, result.wholeText.indexOf('Nested'));
  });

  test('a table cell is its own reading unit', function () {
    const result = click(textNodeOf('cell1'), 8);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.unit, 'cell');
    assert.strictEqual(result.el.id, 'cell1');
    assert.strictEqual(result.wholeText, 'Tables render fine');
    assert.strictEqual(result.start, 7);
    assert.strictEqual(result.wordEnd, 13);

    const other = click(textNodeOf('cell2'), 1);
    assert.strictEqual(other.ok, true);
    assert.strictEqual(other.el.id, 'cell2');
    assert.strictEqual(other.wholeText, 'yes');

    const header = click(textNodeOf('head2'), 0);
    assert.strictEqual(header.ok, true);
    assert.strictEqual(header.unit, 'cell');
    assert.strictEqual(header.el.id, 'head2');
  });

  test('links and checkboxes keep their own click; the task text is read', function () {
    const onLink = click(textNodeOf('link'), 1);
    assert.strictEqual(onLink.ok, false);
    assert.strictEqual(onLink.reason, 'interactive');

    const onCheckbox = click(doc.getElementById('cb'), 0);
    assert.strictEqual(onCheckbox.ok, false);
    assert.strictEqual(onCheckbox.reason, 'interactive');

    const taskText = doc.getElementById('cb').nextSibling;
    const onTask = click(taskText, 3);
    assert.strictEqual(onTask.ok, true);
    assert.strictEqual(onTask.el.id, 'tasks');
    assert.strictEqual(onTask.wholeText, 'task pending');
    assert.strictEqual(onTask.start, 0);

    const besideLink = click(textNodeOf('plink'), 1);
    assert.strictEqual(besideLink.ok, true);
    assert.strictEqual(besideLink.wholeText, 'Read the docs now.');
  });

  test('code, diagrams and math are refused at any depth', function () {
    const code = doc.getElementById('fence').querySelector('code').firstChild;
    const inCode = click(code, 2);
    assert.strictEqual(inCode.ok, false);
    assert.strictEqual(inCode.reason, 'ineligible');
    assert.strictEqual(inCode.hint, core.HINT_INELIGIBLE);

    assert.strictEqual(click(textNodeOf('diagram'), 2).reason, 'ineligible');

    // Decision 8: a click on the prose beside inline math reads the prose,
    // a click on the math itself is refused.
    const besideMath = click(textNodeOf('mathp'), 2);
    assert.strictEqual(besideMath.ok, true);
    assert.strictEqual(besideMath.el.id, 'mathp');
    assert.strictEqual(besideMath.wholeText, 'Inline: and more.');
    const onMath = click(doc.querySelector('#mathp mi').firstChild, 0);
    assert.strictEqual(onMath.ok, false);
    assert.strictEqual(onMath.reason, 'ineligible');

    const nested = doc
      .getElementById('qfence')
      .querySelector('code').firstChild;
    assert.strictEqual(click(nested, 2).reason, 'ineligible');

    const prose = click(textNodeOf('qp'), 2);
    assert.strictEqual(prose.ok, true);
    assert.strictEqual(prose.el.id, 'quote');
    assert.strictEqual(
      prose.wholeText,
      'Quoted prose here.',
      'the nested code fence contributes no text to the blockquote read',
    );
    assert.strictEqual(
      core.extractText(doc.getElementById('li2').parentNode).text,
      'Item one Item two Nested item',
    );
  });

  test('math inside a cell is skipped, a table inside a code chunk is refused', function () {
    const mathCell = click(textNodeOf('mathcell'), 1);
    assert.strictEqual(mathCell.ok, true);
    assert.strictEqual(mathCell.unit, 'cell');
    assert.strictEqual(mathCell.wholeText, 'Math');
    const onCellMath = click(
      doc.getElementById('mathcell').querySelector('.katex').firstChild,
      0,
    );
    assert.strictEqual(onCellMath.ok, false);
    assert.strictEqual(onCellMath.reason, 'ineligible');

    const plainCell = click(textNodeOf('cell4'), 0);
    assert.strictEqual(plainCell.ok, true);
    assert.strictEqual(plainCell.wholeText, '?');

    const chunkCell = click(textNodeOf('chunkcell'), 2);
    assert.strictEqual(chunkCell.ok, false);
    assert.strictEqual(chunkCell.reason, 'ineligible');
  });

  test('a caret outside the preview, or on the root itself, is ignored', function () {
    const outside = doc.createElement('p');
    outside.textContent = 'Not in the preview.';
    doc.body.appendChild(outside);
    try {
      assert.strictEqual(click(outside.firstChild, 2).reason, 'outside');
    } finally {
      outside.remove();
    }
    assert.strictEqual(click(root, 0).reason, 'outside');
    assert.strictEqual(core.resolveClick(null, 0, root).reason, 'outside');
  });

  test('the reading decoration does not move the start offset', function () {
    const p1 = doc.getElementById('p1');
    const first = textNodeOf('p1');
    const before = click(first, 10);
    assert.strictEqual(before.start, 6);

    core.decorateReadingBlock(p1);
    const decorated = click(first, 10);
    assert.strictEqual(decorated.ok, true);
    assert.strictEqual(decorated.el, p1, 'the pill is not the unit');
    assert.strictEqual(decorated.wholeText, P1_TEXT);
    assert.strictEqual(decorated.start, 6);

    // Box the word "paragraph": the first text node is split around it.
    const wordRange = core.spanToRange(
      decorated.wholeMap,
      { charStart: 6, charEnd: 15 },
      doc,
    );
    const spans = core.wrapRange(wordRange, core.WORD_CLASS);
    assert.strictEqual(spans.length, 1);
    const boxed = spans[0].firstChild;
    assert.strictEqual(boxed.data, 'paragraph');
    const onBoxed = click(boxed, 3);
    assert.strictEqual(onBoxed.ok, true);
    assert.strictEqual(onBoxed.el, p1);
    assert.strictEqual(onBoxed.wholeText, P1_TEXT);
    assert.strictEqual(onBoxed.start, 6);
    const onNext = click(boxed.parentNode.nextSibling, 3);
    assert.strictEqual(onNext.start, P1_TEXT.indexOf('with'));

    // Teardown, then the slice the preview app builds resolves the same DOM.
    core.unwrapSpans(spans);
    core.undecorateReadingBlock(p1);
    assert.strictEqual(p1.firstChild, first, 'the original node survives');
    assert.strictEqual(first.data, 'First   paragraph with ');
    const sliced = core.sliceExtraction(core.extractText(p1), onBoxed.start);
    assert.strictEqual(sliced.text, 'paragraph with several words.');
    assert.strictEqual(
      core
        .spanToRange(sliced.map, { charStart: 0, charEnd: 9 }, doc)
        .toString(),
      'paragraph',
    );
  });
});
