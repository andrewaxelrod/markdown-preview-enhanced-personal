/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// Read to the end of the document (spec F15, decisions 5 and 6): the joined
// extraction the webview sends as one request with its block boundaries, and
// the re-render remap that rebinds it. Both live in media/read-aloud-core.js
// and run under jsdom like click-to-read.test.js.

const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const core = require('../../media/read-aloud-core.js');

const FIXTURE =
  '<h2 id="intro">Intro heading</h2>' +
  '<p id="p1">First paragraph with several words.</p>' +
  '<table id="grid"><tbody><tr><td id="cell1">Tables render</td>' +
  '<td id="cell2">yes</td></tr></tbody></table>' +
  '<p id="mathp">Inline: ' +
  '<span class="katex"><span class="katex-mathml"><math><mi>e</mi></math></span>' +
  '</span> and more.</p>' +
  '<pre id="fence" data-role="codeBlock" class="language-ts"><code>let x = 1;</code></pre>' +
  '<ul id="list">\n<li id="li1">Item one</li>\n<li id="li2">Item two</li>\n</ul>' +
  '<blockquote id="quote"><p id="qp">Quoted prose here.</p>' +
  '<pre id="qfence" data-role="codeBlock"><code>nested();</code></pre></blockquote>' +
  '<p id="p3">Last paragraph.</p>' +
  '<p id="empty"><img src="x.png" alt=""></p>';

const PREVIEW_OPEN =
  '<!doctype html><body class="preview-container">' +
  '<div class="crossnote markdown-preview" data-for="preview">';
const PREVIEW_CLOSE = '</div></body>';

const JOINED =
  'Intro heading\n' +
  'First paragraph with several words.\n' +
  'Inline: and more.\n' +
  'Item one Item two\n' +
  'Quoted prose here.\n' +
  'Last paragraph.';

function makeRoot(html) {
  const dom = new JSDOM(PREVIEW_OPEN + html + PREVIEW_CLOSE);
  return {
    dom,
    doc: dom.window.document,
    root: dom.window.document.querySelector(core.ROOT_SELECTOR),
  };
}

/** Whitespace-delimited words of `text` as `{ charStart, charEnd, text }`. */
function words(text) {
  const out = [];
  const re = /\S+/g;
  let match = re.exec(text);
  while (match) {
    out.push({
      text: match[0],
      charStart: match.index,
      charEnd: match.index + match[0].length,
    });
    match = re.exec(text);
  }
  return out;
}

function assertEveryWordResolves(map, text, doc) {
  for (const word of words(text)) {
    const range = core.spanToRange(map, word, doc);
    assert.ok(range, 'range for ' + JSON.stringify(word.text));
    assert.strictEqual(range.toString(), word.text);
  }
}

/** What read-aloud.js keeps per block of a read, from an extraction. */
function readBlocksOf(extracted, startOffset) {
  return extracted.blocks.map((block, i) => ({
    key: core.blockKey(block.el, core.extractText(block.el).text),
    el: block.el,
    start: block.start,
    end: block.end,
    startOffset: i === 0 ? startOffset : 0,
  }));
}

/** read-aloud.js's rebind: match keys in document order over fresh blocks. */
function rebind(readBlocks, root) {
  const fresh = core.collectBlocks(root).map((b) => ({
    el: b.el,
    key: core.blockKey(b.el, core.extractText(b.el).text),
  }));
  let cursor = 0;
  return readBlocks.map((rb) => {
    let el = null;
    for (let j = cursor; j < fresh.length; j++) {
      if (fresh[j].key === rb.key) {
        el = fresh[j].el;
        cursor = j + 1;
        break;
      }
    }
    return Object.assign({}, rb, { el });
  });
}

suite('read-aloud continuous read: extractBlocks (decision 5)', function () {
  this.timeout(20000);

  let fixture;
  let eligible;

  suiteSetup(function () {
    fixture = makeRoot(FIXTURE);
    eligible = core.collectBlocks(fixture.root).map((b) => b.el);
  });

  suiteTeardown(function () {
    fixture.dom.window.close();
  });

  test('the eligible blocks are joined with newlines and reported with their ranges', function () {
    assert.deepStrictEqual(
      eligible.map((el) => el.id),
      ['intro', 'p1', 'mathp', 'list', 'quote', 'p3'],
      'the table, the fence, the nested fence and the image-only paragraph are not blocks',
    );
    // An element with no text (here forced in) contributes nothing.
    const extracted = core.extractBlocks(
      eligible.concat([fixture.doc.getElementById('empty')]),
      0,
    );
    assert.strictEqual(extracted.text, JOINED);
    assert.deepStrictEqual(
      extracted.blocks.map((block) => [
        block.el.id,
        extracted.text.slice(block.start, block.end),
      ]),
      [
        ['intro', 'Intro heading'],
        ['p1', 'First paragraph with several words.'],
        ['mathp', 'Inline: and more.'],
        ['list', 'Item one Item two'],
        ['quote', 'Quoted prose here.'],
        ['p3', 'Last paragraph.'],
      ],
      'the empty block is dropped; every range is the block’s own text',
    );
    for (let i = 1; i < extracted.blocks.length; i++) {
      assert.strictEqual(
        extracted.blocks[i].start,
        extracted.blocks[i - 1].end + 1,
        'blocks are adjacent across one separator',
      );
      assert.strictEqual(extracted.text[extracted.blocks[i].start - 1], '\n');
    }
  });

  test('every word of the joined text maps back to its own DOM node', function () {
    const extracted = core.extractBlocks(eligible, 0);
    assertEveryWordResolves(extracted.map, extracted.text, fixture.doc);
    const separator = extracted.text.indexOf('\n');
    assert.strictEqual(
      core.offsetToDom(extracted.map, separator),
      null,
      'the separator maps to nothing',
    );
  });

  test('a start offset cuts the first block at a word and leaves the rest whole', function () {
    const from = eligible.slice(1); // from p1 on
    const at = 'First paragraph '.length;
    const extracted = core.extractBlocks(from, at);
    assert.strictEqual(
      extracted.text,
      'with several words.\n' +
        'Inline: and more.\n' +
        'Item one Item two\n' +
        'Quoted prose here.\n' +
        'Last paragraph.',
    );
    assert.strictEqual(extracted.blocks[0].el.id, 'p1');
    assert.strictEqual(extracted.blocks[0].start, 0);
    assert.strictEqual(extracted.blocks[0].end, 'with several words.'.length);
    assertEveryWordResolves(extracted.map, extracted.text, fixture.doc);
  });

  test('a first block with nothing left after the cut is dropped', function () {
    const extracted = core.extractBlocks(
      eligible.slice(0, 2),
      'Intro heading'.length,
    );
    assert.strictEqual(extracted.text, 'First paragraph with several words.');
    assert.strictEqual(extracted.blocks.length, 1);
    assert.strictEqual(extracted.blocks[0].el.id, 'p1');
    assert.deepStrictEqual(core.extractBlocks([], 0), {
      text: '',
      map: { text: '', segments: [] },
      blocks: [],
    });
  });

  test('the block ranges pass the host validator shape', function () {
    const extracted = core.extractBlocks(eligible, 0);
    let cursor = 0;
    for (const block of extracted.blocks) {
      assert.ok(Number.isInteger(block.start) && block.start >= cursor);
      assert.ok(block.end > block.start && block.end <= extracted.text.length);
      cursor = block.end;
    }
  });
});

suite('read-aloud continuous read: remapBlocks (decision 6)', function () {
  this.timeout(20000);

  let before;
  let extracted;
  let readBlocks;

  suiteSetup(function () {
    before = makeRoot(FIXTURE);
    const eligible = core.collectBlocks(before.root).map((b) => b.el);
    const at = 'First paragraph '.length;
    extracted = core.extractBlocks(eligible.slice(1), at);
    readBlocks = readBlocksOf(extracted, at);
  });

  suiteTeardown(function () {
    before.dom.window.close();
  });

  test('after an identical re-render every block is found and every word resolves in the new DOM', function () {
    const after = makeRoot(FIXTURE);
    try {
      const rebound = rebind(readBlocks, after.root);
      assert.ok(
        rebound.every((rb) => rb.el && rb.el.ownerDocument === after.doc),
      );
      const remapped = core.remapBlocks(extracted.text, rebound);
      assert.deepStrictEqual(remapped.missing, []);
      assert.strictEqual(remapped.map.text, extracted.text);
      assertEveryWordResolves(remapped.map, extracted.text, after.doc);
      const first = core.offsetToDom(remapped.map, 0);
      assert.strictEqual(first.node.parentElement.id, 'p1');
      assert.strictEqual(
        first.node.data.slice(first.offset, first.offset + 4),
        'with',
        'the first block keeps its start offset',
      );
    } finally {
      after.dom.window.close();
    }
  });

  test('an edited block is reported missing; the others still resolve', function () {
    const after = makeRoot(FIXTURE.replace('Item two', 'Item two, now edited'));
    try {
      const rebound = rebind(readBlocks, after.root);
      assert.strictEqual(rebound[2].el, null, 'the list has a new key');
      const remapped = core.remapBlocks(extracted.text, rebound);
      assert.deepStrictEqual(remapped.missing, [2]);
      for (const word of words(extracted.text)) {
        const inList =
          word.charStart >= readBlocks[2].start &&
          word.charStart < readBlocks[2].end;
        const range = core.spanToRange(remapped.map, word, after.doc);
        if (inList) {
          assert.strictEqual(range, null, word.text);
        } else {
          assert.ok(range, word.text);
          assert.strictEqual(range.toString(), word.text);
        }
      }
    } finally {
      after.dom.window.close();
    }
  });

  test('a removed block, and a block bound to an element with other text, are missing', function () {
    const after = makeRoot(
      FIXTURE.replace('<p id="p3">Last paragraph.</p>', ''),
    );
    try {
      const rebound = rebind(readBlocks, after.root);
      assert.strictEqual(rebound[4].el, null);
      // Simulate a stale binding: point the quote at the intro heading.
      rebound[3] = Object.assign({}, rebound[3], {
        el: after.doc.getElementById('intro'),
      });
      const remapped = core.remapBlocks(extracted.text, rebound);
      assert.deepStrictEqual(remapped.missing, [3, 4]);
      assertEveryWordResolves(
        remapped.map,
        extracted.text.slice(0, readBlocks[2].end),
        after.doc,
      );
    } finally {
      after.dom.window.close();
    }
  });

  test('two blocks with the same text are matched in document order', function () {
    const twin = makeRoot(
      '<p id="a">Same text.</p><p id="b">Same text.</p><p id="c">Other.</p>',
    );
    try {
      const eligible = core.collectBlocks(twin.root).map((b) => b.el);
      const joined = core.extractBlocks(eligible, 0);
      const table = readBlocksOf(joined, 0);
      assert.strictEqual(table[0].key, table[1].key);
      const rebound = rebind(table, twin.root);
      assert.strictEqual(rebound[0].el.id, 'a');
      assert.strictEqual(rebound[1].el.id, 'b');
      assert.strictEqual(rebound[2].el.id, 'c');
      const remapped = core.remapBlocks(joined.text, rebound);
      assert.deepStrictEqual(remapped.missing, []);
      const second = core.offsetToDom(remapped.map, table[1].start);
      assert.strictEqual(second.node.parentElement.id, 'b');
    } finally {
      twin.dom.window.close();
    }
  });
});
