/* global suite, test */
'use strict';

// Notes (`featrues/12-notes/spec.md` §9) — the anchor a capture records and
// the re-anchoring every render runs, over `media/read-aloud-core.js` in
// jsdom: `noteAnchorFor` on a paragraph, a list item, a table cell and a
// multi-block selection; `anchorNotes` steps 1–4 on a fixture edited in six
// ways; the duplicate-block rule; the fuzzy threshold; the reported anchors.

const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const core = require('../../media/read-aloud-core.js');

const P1 =
  'The measure is the number of characters on a line. Between forty-five and ' +
  'seventy-five characters is the range most typographers recommend, and ' +
  'sixty-six is the figure that appears most often.';
const P2 =
  'The reading page measures the face it is using. It lays out a sample ' +
  'passage, divides its width by its length and sets the column from that.';
const P3 =
  'Line height is the second decision. A line set too tight makes the eye ' +
  'skip; too loose and the lines drift apart.';

const FIXTURE =
  '<h1 id="h1" data-source-line="1">Reading on a screen</h1>' +
  '<h2 id="h2a" data-source-line="3">The measure</h2>' +
  `<p id="p1" data-source-line="5">${P1}</p>` +
  `<p id="p2" data-source-line="7">${P2}</p>` +
  '<ul id="list" data-source-line="9">' +
  '<li data-source-line="9">Forty-five to seventy-five characters is the comfortable band.</li>' +
  '<li data-source-line="10">Sixty-six is the classic figure, and the one this page uses.</li>' +
  '<li data-source-line="11">The count is measured in the face that is on, not assumed.</li>' +
  '</ul>' +
  '<h2 id="h2b" data-source-line="13">The rhythm</h2>' +
  `<p id="p3" data-source-line="15">${P3}</p>` +
  '<table id="table" data-source-line="17"><thead><tr data-source-line="17"><th>Term</th><th>Meaning</th></tr></thead>' +
  '<tbody><tr data-source-line="19"><td>Measure</td><td id="cell">The number of characters on a line.</td></tr>' +
  '<tr data-source-line="20"><td>Leading</td><td>The space between lines.</td></tr></tbody></table>' +
  '<pre id="code"><code>not prose</code></pre>' +
  '<p id="p4" data-source-line="23">A closing paragraph with nothing in common with the others.</p>';

const PREVIEW_OPEN =
  '<!doctype html><body class="preview-container">' +
  '<div class="crossnote markdown-preview" data-for="preview">';
const PREVIEW_CLOSE = '</div></body>';

function makeRoot(html) {
  const dom = new JSDOM(PREVIEW_OPEN + html + PREVIEW_CLOSE);
  const document = dom.window.document;
  return {
    dom,
    document,
    window: dom.window,
    root: document.querySelector(core.ROOT_SELECTOR),
  };
}

/** A Selection-like object over the `nth` occurrence of `needle` in `el`'s first text node. */
function selectWords(env, el, needle, nth) {
  const node = el.firstChild;
  let at = -1;
  for (let i = 0; i <= (nth || 0); i++) {
    at = node.data.indexOf(needle, at + 1);
    assert.ok(at >= 0, `"${needle}" occurrence ${i}`);
  }
  const range = env.document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + needle.length);
  const selection = env.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return { selection, range };
}

function selectAcross(env, fromEl, fromOffset, toEl, toOffset) {
  const range = env.document.createRange();
  range.setStart(fromEl.firstChild, fromOffset);
  range.setEnd(toEl.firstChild, toOffset);
  const selection = env.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return { selection, range };
}

function keyOf(el) {
  return core.blockKey(el, core.extractText(el).text);
}

/** A stored note over the anchor of a selection, as `readAloudNotes` carries it. */
function noteFrom(id, anchor, extra) {
  return Object.assign(
    {
      id,
      created: '2026-09-05T15:42:10Z',
      headings: [],
      passage: anchor.exact,
      anchor,
      context: { enclosing: '', before: '', after: '' },
    },
    extra || {},
  );
}

suite('notes: noteAnchorFor (12 §9.1)', function () {
  test('a passage mid-paragraph: block key, line, exact, prefix, suffix, offset, one block', function () {
    const env = makeRoot(FIXTURE);
    const p1 = env.document.getElementById('p1');
    const { selection, range } = selectWords(
      env,
      p1,
      'the figure that appears most often',
    );
    const resolved = core.resolveSelection(selection, env.root);
    assert.ok(resolved.ok);
    const anchor = core.noteAnchorFor(resolved, env.root, range);
    assert.strictEqual(anchor.block, keyOf(p1));
    assert.strictEqual(anchor.line, 5);
    assert.strictEqual(anchor.exact, 'the figure that appears most often');
    assert.strictEqual(anchor.offset, P1.indexOf('the figure that appears'));
    assert.strictEqual(
      anchor.prefix,
      P1.slice(anchor.offset - 64, anchor.offset),
    );
    assert.strictEqual(anchor.suffix, '.');
    assert.strictEqual(anchor.blocks, 1);
  });

  test('a repeated phrase is anchored at the selected occurrence, not the first', function () {
    const env = makeRoot(FIXTURE);
    const p1 = env.document.getElementById('p1');
    // "characters" appears twice in P1.
    const { selection, range } = selectWords(env, p1, 'characters', 1);
    const resolved = core.resolveSelection(selection, env.root);
    const anchor = core.noteAnchorFor(resolved, env.root, range);
    assert.strictEqual(
      anchor.offset,
      P1.indexOf('characters', P1.indexOf('characters') + 1),
    );
    // Without a range the first occurrence is the best guess.
    const blind = core.noteAnchorFor(resolved, env.root, null);
    assert.strictEqual(blind.offset, P1.indexOf('characters'));
  });

  test("a list item: the block is the list, the line is the item's own", function () {
    const env = makeRoot(FIXTURE);
    const li = env.document.getElementById('list').children[1];
    const { selection, range } = selectWords(env, li, 'the classic figure');
    const resolved = core.resolveSelection(selection, env.root);
    const anchor = core.noteAnchorFor(resolved, env.root, range);
    assert.strictEqual(
      anchor.block,
      keyOf(env.document.getElementById('list')),
    );
    assert.strictEqual(anchor.line, 10);
    assert.strictEqual(anchor.exact, 'the classic figure');
    assert.ok(anchor.prefix.endsWith('Sixty-six is '));
  });

  test("a table cell: the block is the table, the line the row's, the text the cells joined", function () {
    const env = makeRoot(FIXTURE);
    const cell = env.document.getElementById('cell');
    const { selection, range } = selectWords(env, cell, 'characters on a line');
    const resolved = core.resolveSelection(selection, env.root);
    assert.ok(resolved.ok, resolved.reason);
    const anchor = core.noteAnchorFor(resolved, env.root, range);
    const table = env.document.getElementById('table');
    const searchText = core.tableSearchText(table);
    assert.strictEqual(anchor.block, core.blockKey(table, searchText));
    assert.strictEqual(anchor.line, 19);
    assert.strictEqual(
      anchor.offset,
      searchText.indexOf('characters on a line'),
    );
    assert.strictEqual(anchor.blocks, 1);
  });

  test("a selection across two paragraphs: the first block's part decides, blocks is 2", function () {
    const env = makeRoot(FIXTURE);
    const p1 = env.document.getElementById('p1');
    const p2 = env.document.getElementById('p2');
    const { selection, range } = selectAcross(
      env,
      p1,
      P1.indexOf('sixty-six'),
      p2,
      'The reading page'.length,
    );
    const resolved = core.resolveSelection(selection, env.root);
    assert.ok(resolved.ok);
    const anchor = core.noteAnchorFor(resolved, env.root, range);
    assert.strictEqual(anchor.block, keyOf(p1));
    assert.strictEqual(anchor.blocks, 2);
    assert.strictEqual(anchor.offset, P1.indexOf('sixty-six'));
    assert.ok(anchor.exact.startsWith('sixty-six is the figure'));
    assert.ok(anchor.exact.endsWith('\nThe reading page'));
    assert.strictEqual(
      anchor.suffix,
      '',
      'the first part runs to the end of its block',
    );
  });

  test('sourceLineOf walks up to the top-level block and stops there', function () {
    const env = makeRoot(FIXTURE);
    const li = env.document.getElementById('list').children[2];
    assert.strictEqual(
      core.sourceLineOf(li.firstChild, env.document.getElementById('list')),
      11,
    );
    const cellNode = env.document.getElementById('cell').firstChild;
    assert.strictEqual(
      core.sourceLineOf(cellNode, env.document.getElementById('table')),
      19,
    );
    const bare = makeRoot('<p id="x">no line</p>');
    assert.strictEqual(
      core.sourceLineOf(
        bare.document.getElementById('x').firstChild,
        bare.document.getElementById('x'),
      ),
      null,
    );
  });
});

suite('notes: anchorNotes (12 §9.2)', function () {
  /** Capture three notes on the pristine fixture: a paragraph, a list item, a cell. */
  function captured() {
    const env = makeRoot(FIXTURE);
    const p1 = env.document.getElementById('p1');
    const li = env.document.getElementById('list').children[1];
    const cell = env.document.getElementById('cell');
    const a = (() => {
      const { selection, range } = selectWords(
        env,
        p1,
        'the figure that appears most often',
      );
      return core.noteAnchorFor(
        core.resolveSelection(selection, env.root),
        env.root,
        range,
      );
    })();
    const b = (() => {
      const { selection, range } = selectWords(env, li, 'the classic figure');
      return core.noteAnchorFor(
        core.resolveSelection(selection, env.root),
        env.root,
        range,
      );
    })();
    const c = (() => {
      const { selection, range } = selectWords(
        env,
        cell,
        'characters on a line',
      );
      return core.noteAnchorFor(
        core.resolveSelection(selection, env.root),
        env.root,
        range,
      );
    })();
    return {
      notes: [
        noteFrom('20260905T154210Z-0001', a, {
          headings: ['Reading on a screen', 'The measure'],
          context: {
            enclosing: P1.replace(
              'the figure that appears most often',
              '⟦the figure that appears most often⟧',
            ),
            before: '',
            after: '',
          },
        }),
        noteFrom('20260905T154211Z-0002', b, {
          headings: ['Reading on a screen', 'The measure'],
        }),
        noteFrom('20260905T154212Z-0003', c, {
          headings: ['Reading on a screen', 'The rhythm'],
        }),
      ],
    };
  }

  test('untouched: every note is found by its block key (step 1) at its offset', function () {
    const { notes } = captured();
    const env = makeRoot(FIXTURE);
    const results = core.anchorNotes(env.root, notes);
    assert.strictEqual(results.length, 3);
    assert.deepStrictEqual(
      results.map((r) => [r.found, r.step, r.el && r.el.id]),
      [
        [true, 1, 'p1'],
        [true, 1, 'list'],
        [true, 1, 'table'],
      ],
    );
    assert.strictEqual(results[0].start, notes[0].anchor.offset);
    assert.strictEqual(
      results[0].end,
      notes[0].anchor.offset + notes[0].anchor.exact.length,
    );
    assert.strictEqual(results[0].spans.length, 1, 'one range to mark');
    assert.strictEqual(results[0].line, 5);
    assert.strictEqual(
      results[1].line,
      10,
      "the item's line, from the mapped node",
    );
    assert.strictEqual(
      results[2].spans.length,
      0,
      "a table gets a marker, no words' mark",
    );
  });

  test('the block edited around the passage: found by the exact passage (step 2)', function () {
    const { notes } = captured();
    const edited = FIXTURE.replace(
      `<p id="p1" data-source-line="5">${P1}</p>`,
      `<p id="p1" data-source-line="5">A sentence added before. ${P1}</p>`,
    );
    const env = makeRoot(edited);
    const results = core.anchorNotes(env.root, notes);
    assert.strictEqual(results[0].found, true);
    assert.strictEqual(results[0].step, 2);
    assert.strictEqual(results[0].el.id, 'p1');
    assert.strictEqual(
      results[0].start,
      ('A sentence added before. ' + P1).indexOf('the figure that appears'),
    );
    assert.notStrictEqual(
      results[0].block,
      notes[0].anchor.block,
      'the key moved',
    );
  });

  test('the passage moved to another section: found there (step 2)', function () {
    const { notes } = captured();
    const moved = FIXTURE.replace(
      `<p id="p1" data-source-line="5">${P1}</p>`,
      '',
    ).replace(
      `<p id="p3" data-source-line="15">${P3}</p>`,
      `<p id="p3" data-source-line="15">${P3}</p><p id="p1moved" data-source-line="16">Moved: ${P1}</p>`,
    );
    const env = makeRoot(moved);
    const results = core.anchorNotes(env.root, notes);
    assert.strictEqual(results[0].step, 2);
    assert.strictEqual(results[0].el.id, 'p1moved');
    assert.strictEqual(results[0].line, 16);
  });

  test('two identical blocks: the stored line tells them apart, then document order', function () {
    const { notes } = captured();
    const twin = FIXTURE.replace(
      `<p id="p3" data-source-line="15">${P3}</p>`,
      `<p id="p3" data-source-line="15">${P3}</p><p id="p1twin" data-source-line="30">${P1}</p>`,
    );
    const env = makeRoot(twin);
    const results = core.anchorNotes(env.root, notes);
    assert.strictEqual(results[0].el.id, 'p1', 'line 5 is nearer the original');
    // A second note on the same block, and a note remembered at line 30.
    const near = noteFrom('20260905T154213Z-0004', {
      ...notes[0].anchor,
      line: 6,
    });
    const far = noteFrom('20260905T154214Z-0005', {
      ...notes[0].anchor,
      line: 31,
    });
    const more = core.anchorNotes(env.root, [notes[0], near, far]);
    assert.deepStrictEqual(
      more.map((r) => r.el.id),
      ['p1', 'p1', 'p1twin'],
    );
    // With no lines at all the cursor rule applies, clamped to the last twin.
    const blind = [
      noteFrom('20260905T154215Z-0006', { ...notes[0].anchor, line: null }),
      noteFrom('20260905T154216Z-0007', { ...notes[0].anchor, line: null }),
      noteFrom('20260905T154217Z-0008', { ...notes[0].anchor, line: null }),
    ];
    assert.deepStrictEqual(
      core.anchorNotes(env.root, blind).map((r) => r.el.id),
      ['p1', 'p1twin', 'p1twin'],
    );
  });

  test('two occurrences of the passage: prefix and suffix decide, then the line', function () {
    const { notes } = captured();
    // The passage is added to a new paragraph with different surroundings, and
    // the original paragraph is edited so step 1 fails for both.
    const doubled = FIXTURE.replace(
      `<p id="p1" data-source-line="5">${P1}</p>`,
      `<p id="p1" data-source-line="5">Edited. ${P1}</p>`,
    ).replace(
      `<p id="p4" data-source-line="23">`,
      `<p id="decoy" data-source-line="22">Elsewhere, the figure that appears most often is quoted.</p><p id="p4" data-source-line="23">`,
    );
    const env = makeRoot(doubled);
    const results = core.anchorNotes(env.root, notes);
    assert.strictEqual(results[0].step, 2);
    assert.strictEqual(
      results[0].el.id,
      'p1',
      'the surroundings match the stored prefix and suffix',
    );
    // With no context stored, the nearer line wins.
    const bare = noteFrom('20260905T154218Z-0009', {
      ...notes[0].anchor,
      prefix: '',
      suffix: '',
      line: 22,
    });
    assert.strictEqual(core.anchorNotes(env.root, [bare])[0].el.id, 'decoy');
  });

  test('the passage deleted, the block otherwise kept: found by the fuzzy enclosing (step 3), marker only', function () {
    const { notes } = captured();
    const gone = FIXTURE.replace(
      `<p id="p1" data-source-line="5">${P1}</p>`,
      `<p id="p1" data-source-line="5">${P1.replace('the figure that appears most often', 'what most typographers use')}</p>`,
    );
    const env = makeRoot(gone);
    const results = core.anchorNotes(env.root, notes);
    assert.strictEqual(results[0].found, true);
    assert.strictEqual(results[0].step, 3);
    assert.strictEqual(results[0].el.id, 'p1');
    assert.strictEqual(results[0].start, -1, 'no words to mark');
    assert.strictEqual(results[0].spans.length, 0);
  });

  test('the whole section rewritten: an orphan (step 4)', function () {
    const { notes } = captured();
    const rewritten = FIXTURE.replace(
      `<p id="p1" data-source-line="5">${P1}</p>`,
      '<p id="p1" data-source-line="5">Something entirely different is said here, about nothing in particular, at some length so the ratio fits.</p>',
    );
    const env = makeRoot(rewritten);
    const results = core.anchorNotes(env.root, notes);
    assert.strictEqual(results[0].found, false);
    assert.strictEqual(results[0].step, 0);
    assert.strictEqual(results[0].el, null);
    // The others are untouched.
    assert.strictEqual(results[1].found, true);
    assert.strictEqual(results[2].found, true);
  });

  test('the fuzzy threshold is 0.75 and the length window is half to double', function () {
    assert.strictEqual(core.NOTE_FUZZY_THRESHOLD, 0.75);
    assert.strictEqual(core.bigramDice('abcd', 'abcd'), 1);
    assert.strictEqual(core.bigramDice('abcd', 'wxyz'), 0);
    assert.ok(
      core.bigramDice(P1, P1.replace('sixty-six', 'sixty-seven')) > 0.9,
    );
    assert.ok(core.bigramDice(P1, P3) < 0.5);
    const { notes } = captured();
    // The enclosing block, but doubled and more: outside the length window.
    const long = FIXTURE.replace(
      `<p id="p1" data-source-line="5">${P1}</p>`,
      `<p id="p1" data-source-line="5">${P1.replace('the figure that appears most often', 'x')} ${P1.replace('the figure that appears most often', 'y')} ${P1.replace('the figure that appears most often', 'z')}</p>`,
    );
    assert.strictEqual(
      core.anchorNotes(makeRoot(long).root, [notes[0]])[0].found,
      false,
    );
  });

  test('a passage spanning two blocks marks both while the text continues', function () {
    const env = makeRoot(FIXTURE);
    const p1 = env.document.getElementById('p1');
    const p2 = env.document.getElementById('p2');
    const { selection, range } = selectAcross(
      env,
      p1,
      P1.indexOf('sixty-six'),
      p2,
      'The reading page'.length,
    );
    const anchor = core.noteAnchorFor(
      core.resolveSelection(selection, env.root),
      env.root,
      range,
    );
    const note = noteFrom('20260905T154219Z-0010', anchor);
    const results = core.anchorNotes(makeRoot(FIXTURE).root, [note]);
    assert.strictEqual(results[0].found, true);
    assert.strictEqual(results[0].spans.length, 2);
    assert.strictEqual(results[0].spans[1].el.id, 'p2');
    assert.strictEqual(results[0].spans[1].start, 0);
    assert.strictEqual(results[0].spans[1].end, 'The reading page'.length);
    // The second block changed: the mark covers the first only.
    const changed = FIXTURE.replace(P2, 'Something else. ' + P2);
    const partial = core.anchorNotes(makeRoot(changed).root, [note]);
    assert.strictEqual(partial[0].found, true);
    assert.strictEqual(partial[0].spans.length, 1);
  });

  test('anchor.current is tried before anchor.block', function () {
    const { notes } = captured();
    const env = makeRoot(FIXTURE);
    const p3 = env.document.getElementById('p3');
    const moved = {
      ...notes[0],
      anchor: { ...notes[0].anchor, current: { block: keyOf(p3), line: 15 } },
    };
    const results = core.anchorNotes(env.root, [moved]);
    assert.strictEqual(results[0].el.id, 'p3');
    assert.strictEqual(results[0].step, 1);
    assert.strictEqual(
      results[0].start,
      -1,
      'the passage is not in that block: marker without a mark',
    );
  });

  test('results come back in the order of the notes given, whatever the stored lines', function () {
    const { notes } = captured();
    const env = makeRoot(FIXTURE);
    const results = core.anchorNotes(env.root, [notes[2], notes[0], notes[1]]);
    assert.deepStrictEqual(
      results.map((r) => r.noteId),
      [notes[2].id, notes[0].id, notes[1].id],
    );
    assert.deepStrictEqual(core.anchorNotes(env.root, []), []);
    assert.deepStrictEqual(core.anchorNotes(null, notes), []);
  });

  test('code blocks are never candidates; a table is', function () {
    const { notes } = captured();
    const env = makeRoot(
      FIXTURE.replace(
        '<pre id="code"><code>not prose</code></pre>',
        `<pre id="code"><code>${P1}</code></pre>`,
      ),
    );
    const moved = FIXTURE.replace(
      `<p id="p1" data-source-line="5">${P1}</p>`,
      '',
    );
    const codeOnly = makeRoot(
      moved.replace(
        '<pre id="code"><code>not prose</code></pre>',
        `<pre id="code"><code>${P1}</code></pre>`,
      ),
    );
    assert.strictEqual(
      core.anchorNotes(codeOnly.root, [notes[0]])[0].found,
      false,
      'a fence never anchors a note',
    );
    assert.strictEqual(
      core.anchorNotes(env.root, [notes[2]])[0].el.id,
      'table',
    );
  });

  test('headingPathOf gives the nearest heading of each level, outermost first', function () {
    const env = makeRoot(FIXTURE);
    const children = Array.from(env.root.children);
    const p3 = children.indexOf(env.document.getElementById('p3'));
    assert.deepStrictEqual(core.headingPathOf(children, p3), [
      'Reading on a screen',
      'The rhythm',
    ]);
    assert.deepStrictEqual(core.headingPathOf(children, 0), []);
  });
});
