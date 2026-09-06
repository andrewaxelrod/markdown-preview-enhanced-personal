/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// Notes (`featrues/12-notes/spec.md` §17) — the notes layer of
// media/read-aloud.js under jsdom with fake <audio> elements and a stub of
// the CSS Custom Highlight API: the cluster's third button and its
// predicate, the capture payload, the pending sheet, markers and ranges,
// the sheet's states and fields, the pager, Play as a `note` read, the list
// sheet, the bar button, the control actions and the decoration settings.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const core = require('../../media/read-aloud-core.js');

const CORE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud-core.js'),
  'utf8',
);
const APP = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud.js'),
  'utf8',
);
const CSS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'media', 'read-aloud.css'),
  'utf8',
);

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
  '</ul>' +
  '<h2 id="h2b" data-source-line="13">The rhythm</h2>' +
  `<p id="p3" data-source-line="15">${P3}</p>` +
  '<pre id="code"><code>not prose</code></pre>' +
  '<p id="p4" data-source-line="23">A closing paragraph with nothing in common with the others.</p>';

const SOURCE_URI = 'file:///doc.md';
const PREVIEW =
  '<!doctype html><html><body class="preview-container">' +
  `<div id="crossnote-data" data-config='{"sourceUri":"${SOURCE_URI}"}'></div>` +
  '<div class="crossnote markdown-preview" data-for="preview">' +
  FIXTURE +
  '</div></body></html>';

const SUMMARY_HTML =
  '<h2>Summary</h2><p>Sixty-six characters is the classic measure.</p>' +
  '<h2>Why it matters</h2><p>The eye can sweep it.</p>' +
  '<h2>Terms</h2><ul><li><strong>Measure</strong>: characters per line.</li></ul>';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A posted payload as plain data: the jsdom realm's Array and Object differ from Node's. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function spansOf(text, base) {
  const out = [];
  const re = /\S+/g;
  let match = re.exec(text);
  let t = 0;
  while (match) {
    out.push({
      text: match[0],
      charStart: base + match.index,
      charEnd: base + match.index + match[0].length,
      start: t,
      end: t + 1,
    });
    t += 1;
    match = re.exec(text);
  }
  return out;
}

suite('read-aloud notes layer (12-notes)', function () {
  this.timeout(30000);

  let dom;
  let win;
  let doc;
  let posted;
  let logs;
  let sequence = 0;
  const windows = [];

  /** A stub of the CSS Custom Highlight API: a registry of Highlight sets. */
  class FakeHighlight {
    constructor(...ranges) {
      this.ranges = new Set(ranges);
    }
    add(range) {
      this.ranges.add(range);
      return this;
    }
    delete(range) {
      return this.ranges.delete(range);
    }
    get size() {
      return this.ranges.size;
    }
  }

  function boot() {
    posted = [];
    logs = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => {
      logs.push('jsdomError: ' + (error.stack || error.message));
    });
    for (const level of ['debug', 'log', 'warn', 'error']) {
      virtualConsole.on(level, (...args) =>
        logs.push(level + ': ' + args.join(' ')),
      );
    }
    dom = new JSDOM(PREVIEW, {
      pretendToBeVisual: true,
      runScripts: 'outside-only',
      virtualConsole,
    });
    win = dom.window;
    doc = win.document;
    win.acquireVsCodeApi = function () {
      return { postMessage: (message) => posted.push(message) };
    };
    win.CSS = { highlights: new Map() };
    win.Highlight = FakeHighlight;
    let blobs = 0;
    win.URL.createObjectURL = () => 'blob:fake-' + ++blobs;
    win.URL.revokeObjectURL = () => {};
    win.Element.prototype.scrollIntoView = function () {};
    class FakeAudio extends win.EventTarget {
      constructor() {
        super();
        this._src = '';
        this.currentTime = 0;
        this.duration = 30;
        this.playbackRate = 1;
        this.preservesPitch = true;
        this.volume = 1;
        this.paused = true;
      }
      get src() {
        return this._src;
      }
      set src(value) {
        this._src = value;
        this.paused = true;
        this.currentTime = 0;
      }
      play() {
        this.paused = false;
        return Promise.resolve();
      }
      pause() {
        this.paused = true;
      }
      load() {
        this.paused = true;
      }
      removeAttribute(name) {
        if (name === 'src') {
          this._src = '';
        }
      }
    }
    win.Audio = FakeAudio;
    windows.push(win);
    win.eval(CORE);
    win.eval(APP);
  }

  function host(message) {
    win.dispatchEvent(new win.MessageEvent('message', { data: message }));
  }

  function enable(overrides) {
    host(
      Object.assign(
        {
          command: 'readAloudConfig',
          enabled: true,
          clickToRead: true,
          speed: 1,
          volume: 1,
          voiceName: 'af_heart',
          modelId: 'kokoro',
          highlightTheme: 'blue',
          font: 'default',
          helpAvailable: true,
          helpEngine: 'claude',
          helpModel: 'sonnet',
          helpEffort: 'low',
          helpAutoPlay: false,
          helpContextMode: 'section',
          notesAvailable: true,
          notesDecoration: 'marker-and-mark',
        },
        overrides || {},
      ),
    );
  }

  function sendNotes(list, extra) {
    host(
      Object.assign(
        {
          command: 'readAloudNotes',
          sourceUri: SOURCE_URI,
          notes: list,
          deleting: [],
          deleteMode: 'trash',
          generate: true,
        },
        extra || {},
      ),
    );
  }

  function control(action, extra) {
    host(Object.assign({ command: 'readAloudControl', action }, extra || {}));
  }

  function click(element) {
    assert.ok(element, 'element to click');
    element.dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  }

  function q(selector) {
    return doc.querySelector(selector);
  }

  function qa(selector) {
    return Array.from(doc.querySelectorAll(selector));
  }

  function sheet() {
    return q('.mpe-ra-note');
  }

  function listSheet() {
    return q('.mpe-ra-notes-list');
  }

  function action(name, within) {
    return (within || doc).querySelector('[data-mpe-ra-action="' + name + '"]');
  }

  function lastMessage(command) {
    return posted.filter((m) => m.command === command).pop();
  }

  function messages(command) {
    return posted.filter((m) => m.command === command);
  }

  async function selectWords(id, needle, nth) {
    const node = Array.from(doc.getElementById(id).childNodes).find(
      (child) => child.nodeType === 3 && child.data.includes(needle),
    );
    assert.ok(node, `a text node with "${needle}" in #${id}`);
    let at = -1;
    for (let i = 0; i <= (nth || 0); i++) {
      at = node.data.indexOf(needle, at + 1);
      assert.ok(at >= 0, `"${needle}" occurrence ${i} in #${id}`);
    }
    const range = doc.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    const selection = win.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new win.Event('selectionchange'));
    await sleep(220);
    return range;
  }

  async function clearSelection() {
    win.getSelection().removeAllRanges();
    doc.dispatchEvent(new win.Event('selectionchange'));
    await sleep(220);
  }

  /** A note summary anchored on `needle` in `#id`, as the host would post it. */
  function noteOn(id, needle, overrides) {
    const el = doc.getElementById(id);
    const node = Array.from(el.querySelectorAll('*'))
      .concat([el])
      .flatMap((e) => Array.from(e.childNodes))
      .find((child) => child.nodeType === 3 && child.data.includes(needle));
    assert.ok(node, `text "${needle}" in #${id}`);
    const at = node.data.indexOf(needle);
    const range = doc.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    const selection = win.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const c = win.MpeReadAloudCore;
    const root = q(c.ROOT_SELECTOR);
    const resolved = c.resolveSelection(selection, root);
    assert.ok(resolved.ok, resolved.reason);
    const anchor = c.noteAnchorFor(resolved, root, range);
    selection.removeAllRanges();
    sequence++;
    const stamp = String(10 + sequence).padStart(2, '0');
    return Object.assign(
      {
        id: `20260905T1542${stamp}Z-${(0x1000 + sequence).toString(16).slice(-4)}`,
        title: 'Note on ' + needle.split(' ').slice(0, 2).join(' '),
        titleEdited: false,
        shape: 'passage',
        created: `2026-09-05T15:42:${stamp}Z`,
        updated: `2026-09-05T15:42:${stamp}Z`,
        headings: ['Reading on a screen', 'The measure'],
        passage: needle,
        anchor,
        generated: {
          status: 'done',
          source: 'engine',
          engine: 'claude',
          model: 'sonnet',
          effort: 'low',
          at: `2026-09-05T15:42:${stamp}Z`,
        },
        tags: ['measure'],
        myNote: '',
        html: SUMMARY_HTML,
        sectionsMarkdown:
          '## Summary\n\nSixty-six characters is the classic measure.',
        sectionNames: ['Summary', 'Why it matters', 'Terms'],
        context: {
          enclosing: c.extractText(el).text.replace(needle, '⟦' + needle + '⟧'),
          before: '',
          after: '',
        },
        summaryLine: 'Sixty-six characters is the classic measure.',
      },
      overrides || {},
    );
  }

  function orphanNote(overrides) {
    sequence++;
    const stamp = String(10 + sequence).padStart(2, '0');
    return Object.assign(
      {
        id: `20260905T1542${stamp}Z-${(0x1000 + sequence).toString(16).slice(-4)}`,
        title: 'A note whose passage is gone',
        titleEdited: false,
        shape: 'passage',
        created: `2026-09-05T15:42:${stamp}Z`,
        updated: `2026-09-05T15:42:${stamp}Z`,
        headings: ['Reading on a screen', 'The old section'],
        passage: 'words that are no longer anywhere in this document at all',
        anchor: {
          block: 'bdeadbeef',
          line: 40,
          exact: 'words that are no longer anywhere in this document at all',
          prefix: '',
          suffix: '',
          offset: 0,
          blocks: 1,
        },
        generated: {
          status: 'done',
          source: 'engine',
          engine: 'claude',
          model: 'sonnet',
          effort: 'low',
        },
        tags: [],
        myNote: '',
        html: '<h2>Summary</h2><p>Gone.</p>',
        sectionsMarkdown: '## Summary\n\nGone.',
        sectionNames: ['Summary'],
        context: {
          enclosing:
            'A whole sentence of ⟦words that are no longer anywhere in this document at all⟧, once.',
          before: 'The paragraph before it.',
          after: '',
        },
        summaryLine: 'Gone.',
      },
      overrides || {},
    );
  }

  function highlightRanges() {
    const highlight = win.CSS.highlights.get('mpe-ra-note');
    return highlight ? Array.from(highlight.ranges) : [];
  }

  suiteSetup(async function () {
    boot();
    await sleep(60);
  });

  suiteTeardown(function () {
    for (const opened of windows) {
      try {
        opened.close();
      } catch (error) {
        /* already gone */
      }
    }
  });

  // -------------------------------------------------------- §5.1 the button

  test('the cluster has a third button that follows notesAvailable and the help predicate', async function () {
    enable({ notesAvailable: false });
    await selectWords('p1', 'the figure that appears most often');
    const float = q('.mpe-ra-float');
    assert.ok(float && !float.hidden, 'the cluster is up');
    assert.strictEqual(
      q('.mpe-ra-float-note').hidden,
      true,
      'hidden without notes',
    );
    enable();
    assert.strictEqual(q('.mpe-ra-float-note').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-float-note').getAttribute('title'),
      'Save a note (Alt+N)',
    );
    assert.strictEqual(q('.mpe-ra-float-help').hidden, false, 'Explain stays');
    enable({ helpAvailable: false });
    assert.strictEqual(
      q('.mpe-ra-float-help').hidden,
      true,
      'help=0 hides Explain',
    );
    assert.strictEqual(q('.mpe-ra-float-note').hidden, false, 'and keeps Note');
    enable();
    await clearSelection();
  });

  test('the bar has a Notes button between help and close, hidden without notes', function () {
    const buttons = qa('.mpe-ra-bar > .mpe-ra-bar-btn').map((b) => b.className);
    const help = buttons.findIndex((c) => c.includes('mpe-ra-bar-help'));
    const notes = buttons.findIndex((c) => c.includes('mpe-ra-bar-notes'));
    const classroom = buttons.findIndex((c) =>
      c.includes('mpe-ra-bar-classroom'),
    );
    const close = buttons.findIndex((c) => c.includes('mpe-ra-bar-close'));
    // 13 §12.2: the module preview's button sits between notes and the ×.
    assert.ok(
      help >= 0 &&
        notes === help + 1 &&
        classroom === notes + 1 &&
        close === classroom + 1,
      buttons.join(' | '),
    );
    assert.strictEqual(q('.mpe-ra-bar-notes').hidden, false);
    assert.strictEqual(q('.mpe-ra-bar-badge').hidden, true, 'no badge at 0');
    enable({ notesAvailable: false });
    assert.strictEqual(q('.mpe-ra-bar-notes').hidden, true);
    enable();
  });

  // ----------------------------------------------------------- §5.2 capture

  test('clicking Note posts readAloudNoteCreate and opens the pending sheet', async function () {
    const range = await selectWords('p1', 'the figure that appears most often');
    const c = win.MpeReadAloudCore;
    const expectedAnchor = c.noteAnchorFor(
      c.resolveSelection(win.getSelection(), q(c.ROOT_SELECTOR)),
      q(c.ROOT_SELECTOR),
      range,
    );
    click(q('.mpe-ra-float-note'));
    const create = lastMessage('readAloudNoteCreate');
    assert.ok(create, 'a create was posted; logs: ' + logs.join('\n'));
    const [uri, requestId, passage, fields, anchor, options] = create.args;
    assert.strictEqual(uri, SOURCE_URI);
    assert.match(requestId, /^ra-/);
    assert.strictEqual(passage, 'the figure that appears most often');
    assert.strictEqual(fields.contextMode, 'section');
    assert.strictEqual(fields.title, 'Reading on a screen');
    assert.deepStrictEqual(plain(fields.breadcrumb), [
      'Reading on a screen',
      'The measure',
    ]);
    assert.ok(
      fields.enclosing.includes('⟦the figure that appears most often⟧'),
    );
    assert.deepStrictEqual(plain(anchor), plain(expectedAnchor));
    assert.strictEqual(anchor.line, 5);
    assert.deepStrictEqual(plain(options), { source: 'selection' });

    assert.strictEqual(sheet().hidden, false, 'the Note sheet opens');
    assert.strictEqual(
      q('.mpe-ra-note-details').textContent,
      'Writing the note…',
    );
    assert.ok(
      q('.mpe-ra-note-body blockquote').textContent.includes(
        'the figure that appears most often',
      ),
    );
    assert.ok(
      qa('.mpe-ra-note-body .mpe-ra-note-skel').length >= 3,
      'skeletons, no text',
    );
    assert.strictEqual(
      q('.mpe-ra-note-path').textContent,
      'Reading on a screen › The measure',
    );
    assert.strictEqual(q('.mpe-ra-note-chip').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-note-chip-text').textContent,
      'Saved as note',
    );
    assert.strictEqual(q('.mpe-ra-note-undo').hidden, true);
    assert.strictEqual(
      action('noteRegenerate', sheet()).disabled,
      true,
      'Regenerate disabled while pending',
    );
    assert.strictEqual(
      action('noteRegenerate', sheet()).getAttribute('title'),
      'Being written',
    );
    assert.strictEqual(
      q('.mpe-ra-float').hidden,
      true,
      'the cluster went away',
    );
    assert.strictEqual(
      messages('readAloudCancel').length,
      0,
      'no read was touched',
    );
    click(action('noteClose', sheet()));
    assert.strictEqual(sheet().hidden, true);
  });

  test('Alt+N with nothing to note shows the hint; with a selection it saves', async function () {
    const before = messages('readAloudNoteCreate').length;
    await clearSelection();
    control('note');
    assert.strictEqual(messages('readAloudNoteCreate').length, before);
    const hint = q('.mpe-ra-hint');
    assert.ok(hint && !hint.hidden);
    assert.strictEqual(hint.textContent, 'Select text to save a note');
    await selectWords('p2', 'a sample passage');
    control('note');
    assert.strictEqual(messages('readAloudNoteCreate').length, before + 1);
    assert.strictEqual(
      lastMessage('readAloudNoteCreate').args[2],
      'a sample passage',
    );
    click(action('noteClose', sheet()));
    await clearSelection();
  });

  test('capture from a paused selection read does not stop the read', async function () {
    await selectWords('p3', 'Line height is the second decision');
    click(q('.mpe-ra-float-read'));
    const read = lastMessage('readAloudSynthesize');
    assert.ok(read && read.args[3].kind === 'selection');
    await clearSelection();
    const cancels = messages('readAloudCancel').length;
    control('note');
    const create = lastMessage('readAloudNoteCreate');
    assert.strictEqual(
      create.args[2],
      read.args[2],
      'the passage being read is the passage saved',
    );
    assert.strictEqual(
      messages('readAloudCancel').length,
      cancels,
      'the read goes on',
    );
    assert.strictEqual(
      q('.mpe-ra-bar-play').getAttribute('data-state'),
      'loading',
    );
    click(action('noteClose', sheet()));
    click(q('.mpe-ra-bar-close'));
    await sleep(20);
  });

  // ------------------------------------------------ §10 markers and marks

  test('readAloudNotes draws one marker per noted block, a count badge, ranges and the gutter', async function () {
    boot();
    await sleep(60);
    enable();
    const a = noteOn('p1', 'the figure that appears most often');
    const b = noteOn('p1', 'the number of characters on a line', {
      title: 'Second on p1',
    });
    const c = noteOn('list', 'the classic figure', { title: 'On the list' });
    sendNotes([a, b, c]);
    const markers = qa('.mpe-ra-note-marker');
    assert.strictEqual(markers.length, 2, 'one marker per block');
    const onP1 = doc.getElementById('p1').querySelector('.mpe-ra-note-marker');
    assert.ok(onP1, 'inside its block');
    assert.strictEqual(onP1.getAttribute('data-mpe-ra-action'), 'noteOpen');
    assert.strictEqual(
      onP1.getAttribute('data-mpe-ra-note'),
      b.id,
      'the first in reading order',
    );
    assert.strictEqual(
      onP1.querySelector('.mpe-ra-note-count').textContent,
      '2',
    );
    assert.strictEqual(onP1.getAttribute('title'), 'Second on p1 · 2 notes');
    const onList = doc
      .getElementById('list')
      .querySelector('.mpe-ra-note-marker');
    assert.ok(onList);
    assert.strictEqual(onList.querySelector('.mpe-ra-note-count'), null);
    assert.strictEqual(onList.getAttribute('title'), 'On the list');
    assert.ok(q('.markdown-preview').classList.contains('mpe-ra-notes-gutter'));
    assert.strictEqual(
      highlightRanges().length,
      3,
      'one range per located passage',
    );
    assert.ok(highlightRanges().every((r) => r.toString().length > 0));
    const report = lastMessage('readAloudNoteAnchors');
    assert.ok(report);
    assert.deepStrictEqual(
      plain(report.args[1].map((r) => [r.noteId, r.found])),
      [
        [a.id, true],
        [b.id, true],
        [c.id, true],
      ],
    );
    assert.strictEqual(report.args[1][2].line, 10, "the item's own line");
    // Extraction never sees the marker or its badge: the block key is unchanged.
    assert.strictEqual(
      win.MpeReadAloudCore.blockKey(
        doc.getElementById('p1'),
        win.MpeReadAloudCore.extractText(doc.getElementById('p1')).text,
      ),
      a.anchor.block,
    );
    assert.strictEqual(q('.mpe-ra-bar-badge').hidden, false);
    assert.strictEqual(q('.mpe-ra-bar-badge').textContent, '3');
  });

  test('the same list again posts no second anchors report; a changed one does', function () {
    const before = messages('readAloudNoteAnchors').length;
    const a = noteOn('p1', 'the figure that appears most often');
    const b = noteOn('p1', 'the number of characters on a line');
    const c = noteOn('list', 'the classic figure');
    sendNotes([a, b, c]);
    assert.strictEqual(
      messages('readAloudNoteAnchors').length,
      before + 1,
      'new ids: a new report',
    );
    sendNotes([a, b, c]);
    assert.strictEqual(
      messages('readAloudNoteAnchors').length,
      before + 1,
      'same result: coalesced',
    );
  });

  test('the ranges of the block being read step aside and come back at the end', async function () {
    const a = noteOn('p1', 'the figure that appears most often');
    const c = noteOn('list', 'the classic figure');
    sendNotes([a, c]);
    assert.strictEqual(highlightRanges().length, 2);
    // Start a block read on p1 from its play button.
    const button = doc.getElementById('p1').querySelector('.mpe-ra-btn');
    assert.ok(button, 'p1 has a play button');
    click(button);
    const read = lastMessage('readAloudSynthesize');
    assert.ok(read && read.args[3].kind === 'block');
    assert.strictEqual(
      highlightRanges().length,
      1,
      "p1's range is out while it is read",
    );
    assert.strictEqual(qa('.mpe-ra-note-marker').length, 2, 'the marker stays');
    click(q('.mpe-ra-bar-close'));
    await sleep(20);
    assert.strictEqual(
      highlightRanges().length,
      2,
      'restored when the read ends',
    );
  });

  test('notesDecoration marker keeps markers only; none removes both; a re-render brings them back', async function () {
    const a = noteOn('p1', 'the figure that appears most often');
    sendNotes([a]);
    enable({ notesDecoration: 'marker' });
    assert.strictEqual(qa('.mpe-ra-note-marker').length, 1);
    assert.strictEqual(highlightRanges().length, 0);
    enable({ notesDecoration: 'none' });
    assert.strictEqual(qa('.mpe-ra-note-marker').length, 0);
    assert.ok(
      !q('.markdown-preview').classList.contains('mpe-ra-notes-gutter'),
    );
    enable();
    assert.strictEqual(qa('.mpe-ra-note-marker').length, 1);
    assert.strictEqual(highlightRanges().length, 1);
    // A re-render: the root's children are replaced, as updateHtml does.
    const root = q('.markdown-preview');
    root.innerHTML = FIXTURE;
    await sleep(80);
    assert.strictEqual(
      qa('.mpe-ra-note-marker').length,
      1,
      'the marker is back on the new block',
    );
    assert.strictEqual(highlightRanges().length, 1);
    assert.ok(doc.getElementById('p1').querySelector('.mpe-ra-note-marker'));
  });

  test('a marker click opens the note; the sheet fills in from the list', async function () {
    const a = noteOn('p1', 'the figure that appears most often', {
      title: 'The classic measure',
    });
    sendNotes([a]);
    click(q('.mpe-ra-note-marker'));
    assert.strictEqual(sheet().hidden, false);
    assert.ok(q('.mpe-ra-note-marker').classList.contains('is-active'));
    assert.strictEqual(
      q('.mpe-ra-note-body h1').textContent,
      'The classic measure',
    );
    assert.strictEqual(q('.mpe-ra-note-body h2').textContent, 'Summary');
    assert.ok(
      q('.mpe-ra-note-details').textContent.includes('claude · sonnet'),
    );
    assert.strictEqual(q('.mpe-ra-note-banner').hidden, true);
    assert.strictEqual(action('noteOpenEditor', sheet()).hidden, false);
    assert.strictEqual(
      q('.mpe-ra-note-context-body').hidden,
      true,
      'context collapsed',
    );
    click(action('noteContext', sheet()));
    assert.strictEqual(q('.mpe-ra-note-context-body').hidden, false);
    assert.ok(
      q('.mpe-ra-note-context-quote').textContent.includes('⟦the figure'),
    );
    assert.strictEqual(
      action('noteContext', sheet()).textContent,
      'Hide context',
    );
    assert.deepStrictEqual(
      qa('.mpe-ra-note-tag').map((t) => t.getAttribute('data-tag')),
      ['measure'],
    );
    // Pending → complete: the second list fills the same sheet in.
    const pendingNote = Object.assign({}, a, {
      html: '',
      sectionNames: [],
      generated: { status: 'pending', source: 'engine' },
    });
    sendNotes([pendingNote]);
    assert.strictEqual(
      q('.mpe-ra-note-details').textContent,
      'Writing the note…',
    );
    assert.ok(qa('.mpe-ra-note-body .mpe-ra-note-skel').length >= 1);
    sendNotes([a]);
    assert.strictEqual(q('.mpe-ra-note-body h2').textContent, 'Summary');
    click(action('noteClose', sheet()));
    assert.ok(!q('.mpe-ra-note-marker').classList.contains('is-active'));
  });

  // ------------------------------------------------------ §11 the sheet

  test('My note saves 500 ms after the last keystroke and at once on blur', async function () {
    const a = noteOn('p1', 'the figure that appears most often');
    sendNotes([a]);
    click(q('.mpe-ra-note-marker'));
    const textarea = q('.mpe-ra-note-textarea');
    assert.strictEqual(
      textarea.placeholder,
      'Why did you save this? Optional.',
    );
    const before = messages('readAloudNoteUpdate').length;
    textarea.focus();
    textarea.value = 'Why I';
    textarea.dispatchEvent(new win.Event('input', { bubbles: true }));
    textarea.value = 'Why I saved this';
    textarea.dispatchEvent(new win.Event('input', { bubbles: true }));
    await sleep(200);
    assert.strictEqual(
      messages('readAloudNoteUpdate').length,
      before,
      'not yet',
    );
    await sleep(450);
    assert.strictEqual(messages('readAloudNoteUpdate').length, before + 1);
    assert.deepStrictEqual(plain(lastMessage('readAloudNoteUpdate').args), [
      SOURCE_URI,
      a.id,
      { myNote: 'Why I saved this' },
    ]);
    assert.strictEqual(q('.mpe-ra-note-details').textContent, 'Saved');
    textarea.value = 'Why I saved this, really';
    textarea.dispatchEvent(new win.Event('input', { bubbles: true }));
    textarea.dispatchEvent(new win.Event('blur'));
    assert.strictEqual(
      messages('readAloudNoteUpdate').length,
      before + 2,
      'blur writes at once',
    );
    assert.strictEqual(
      lastMessage('readAloudNoteUpdate').args[2].myNote,
      'Why I saved this, really',
    );
    // Closing within the debounce still writes.
    textarea.value = 'Final';
    textarea.dispatchEvent(new win.Event('input', { bubbles: true }));
    click(action('noteClose', sheet()));
    assert.strictEqual(
      lastMessage('readAloudNoteUpdate').args[2].myNote,
      'Final',
    );
    await sleep(1100);
  });

  test('tags: Enter and comma commit, lowercased; Backspace on empty removes the last; × removes', function () {
    const a = noteOn('p1', 'the figure that appears most often', {
      tags: ['measure'],
    });
    sendNotes([a]);
    click(q('.mpe-ra-note-marker'));
    const input = q('.mpe-ra-note-tag-input');
    assert.strictEqual(input.placeholder, '+ Add tag');
    input.value = 'Line Length';
    input.dispatchEvent(
      new win.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.deepStrictEqual(plain(lastMessage('readAloudNoteUpdate').args[2]), {
      tags: ['measure', 'line-length'],
    });
    input.value = 'Eyes';
    input.dispatchEvent(
      new win.KeyboardEvent('keydown', {
        key: ',',
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.deepStrictEqual(plain(lastMessage('readAloudNoteUpdate').args[2]), {
      tags: ['measure', 'line-length', 'eyes'],
    });
    assert.strictEqual(qa('.mpe-ra-note-tag').length, 3);
    input.value = '';
    input.dispatchEvent(
      new win.KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.deepStrictEqual(plain(lastMessage('readAloudNoteUpdate').args[2]), {
      tags: ['measure', 'line-length'],
    });
    click(qa('.mpe-ra-note-tag-remove')[0]);
    assert.deepStrictEqual(plain(lastMessage('readAloudNoteUpdate').args[2]), {
      tags: ['line-length'],
    });
    assert.strictEqual(qa('.mpe-ra-note-tag').length, 1);
    click(action('noteClose', sheet()));
  });

  test('the orphan: banner, context expanded, no Open in editor, Re-attach follows the selection', async function () {
    const a = noteOn('p1', 'the figure that appears most often');
    const o = orphanNote();
    sendNotes([a, o]);
    assert.strictEqual(
      qa('.mpe-ra-note-marker').length,
      1,
      'an orphan has no marker',
    );
    const report = lastMessage('readAloudNoteAnchors').args[1];
    assert.deepStrictEqual(plain(report.find((r) => r.noteId === o.id)), {
      noteId: o.id,
      found: false,
    });
    control('showNote', { noteId: o.id });
    assert.strictEqual(sheet().hidden, false);
    assert.strictEqual(q('.mpe-ra-note-banner').hidden, false);
    assert.ok(
      q('.mpe-ra-note-banner-text').textContent.startsWith(
        'This passage was not found',
      ),
    );
    assert.strictEqual(
      q('.mpe-ra-note-path').textContent,
      'Was under Reading on a screen › The old section',
    );
    assert.strictEqual(
      q('.mpe-ra-note-context-body').hidden,
      false,
      'context expanded for an orphan',
    );
    assert.strictEqual(action('noteOpenEditor', sheet()).hidden, true);
    const reattach = action('noteReattach', sheet());
    assert.strictEqual(reattach.disabled, true);
    assert.strictEqual(
      reattach.getAttribute('title'),
      'Select text to re-attach',
    );
    await selectWords('p3', 'Line height is the second decision');
    assert.strictEqual(reattach.disabled, false);
    const float = q('.mpe-ra-float');
    assert.ok(!float || float.hidden, 'no cluster while the sheet is open');
    click(reattach);
    const message = lastMessage('readAloudNoteReattach');
    assert.ok(message);
    assert.strictEqual(message.args[1], o.id);
    assert.strictEqual(
      message.args[2].block,
      win.MpeReadAloudCore.blockKey(doc.getElementById('p3'), P3),
    );
    assert.strictEqual(
      message.args[2].exact,
      'Line height is the second decision',
    );
    assert.deepStrictEqual(plain(message.args[3]), [
      'Reading on a screen',
      'The rhythm',
    ]);
    click(action('noteClose', sheet()));
    await clearSelection();
  });

  test('Copy, Delete with Undo, and the list without the note', async function () {
    const a = noteOn('p1', 'the figure that appears most often');
    const b = noteOn('list', 'the classic figure');
    sendNotes([a, b]);
    click(q('#p1 .mpe-ra-note-marker'));
    click(action('noteCopy', sheet()));
    assert.deepStrictEqual(plain(lastMessage('readAloudNoteCopy').args), [
      SOURCE_URI,
      a.id,
    ]);
    assert.strictEqual(q('.mpe-ra-note-details').textContent, 'Copied');
    click(action('noteDelete', sheet()));
    assert.deepStrictEqual(plain(lastMessage('readAloudNoteDelete').args), [
      SOURCE_URI,
      a.id,
    ]);
    assert.strictEqual(q('.mpe-ra-note-chip').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-note-chip-text').textContent,
      'Note moved to Trash',
    );
    assert.strictEqual(q('.mpe-ra-note-undo').hidden, false);
    // The host answers with the list without it: the sheet pages on.
    sendNotes([b], { deleting: [a.id] });
    assert.strictEqual(qa('.mpe-ra-note-marker').length, 1);
    assert.strictEqual(sheet().hidden, false, 'pages on to the next note');
    assert.strictEqual(q('.mpe-ra-note-body h1').textContent, b.title);
    click(q('.mpe-ra-note-undo'));
    assert.deepStrictEqual(plain(lastMessage('readAloudNoteUndoDelete').args), [
      SOURCE_URI,
      a.id,
    ]);
    assert.strictEqual(q('.mpe-ra-note-chip').hidden, true);
    sendNotes([a, b]);
    assert.strictEqual(qa('.mpe-ra-note-marker').length, 2);
    // A delete from elsewhere (the view) shows the chip here too; permanent reads honestly.
    sendNotes([a], { deleting: [b.id], deleteMode: 'permanent' });
    assert.strictEqual(q('.mpe-ra-note-chip-text').textContent, 'Note deleted');
    sendNotes([a], { deleting: [], deleteMode: 'trash' });
    assert.strictEqual(
      q('.mpe-ra-note-chip').hidden,
      true,
      'nothing left to undo',
    );
    // The last note deleted closes the sheet.
    sendNotes([], { deleting: [a.id] });
    assert.strictEqual(sheet().hidden, true);
    await sleep(20);
  });

  test('the pager walks reading order with orphans last', function () {
    const first = noteOn('p1', 'the number of characters on a line', {
      title: 'First',
    });
    const second = noteOn('p1', 'the figure that appears most often', {
      title: 'Second',
    });
    const third = noteOn('list', 'the classic figure', { title: 'Third' });
    const o = orphanNote({ title: 'Orphan' });
    // Given out of order: the pager sorts by block position, then offset.
    sendNotes([o, third, second, first]);
    control('showNote', { noteId: first.id });
    assert.strictEqual(q('.mpe-ra-note-pager-label').textContent, '1 of 4');
    assert.strictEqual(action('notePrev', sheet()).disabled, true);
    click(action('noteNext', sheet()));
    assert.strictEqual(q('.mpe-ra-note-body h1').textContent, 'Second');
    assert.strictEqual(q('.mpe-ra-note-pager-label').textContent, '2 of 4');
    click(action('noteNext', sheet()));
    assert.strictEqual(q('.mpe-ra-note-body h1').textContent, 'Third');
    click(action('noteNext', sheet()));
    assert.strictEqual(q('.mpe-ra-note-body h1').textContent, 'Orphan');
    assert.strictEqual(q('.mpe-ra-note-pager-label').textContent, '4 of 4');
    assert.strictEqual(action('noteNext', sheet()).disabled, true);
    assert.strictEqual(q('.mpe-ra-note-banner').hidden, false);
    click(action('notePrev', sheet()));
    assert.strictEqual(q('.mpe-ra-note-body h1').textContent, 'Third');
    click(action('noteClose', sheet()));
  });

  test('Play reads the sheet as a note read bounded to its body and pauses a document read with Resume', async function () {
    const a = noteOn('p1', 'the figure that appears most often', {
      title: 'Played',
      myNote: 'My own words here.',
    });
    sendNotes([a]);
    // A document read first.
    click(doc.getElementById('p2').querySelector('.mpe-ra-btn'));
    const docRead = lastMessage('readAloudSynthesize');
    assert.strictEqual(docRead.args[3].kind, 'block');
    const text = docRead.args[2];
    host({
      command: 'readAloudAudio',
      requestId: docRead.args[1],
      chunkIndex: 0,
      chunkCount: 1,
      blockIndex: 0,
      audioBase64: 'QUJD',
      mimeType: 'audio/mpeg',
      spans: spansOf(text.slice(0, 40), 0),
      durationHint: 30,
    });
    await sleep(20);
    control('showNote', { noteId: a.id });
    assert.strictEqual(
      q('.mpe-ra-bar-play').getAttribute('data-state'),
      'playing',
      'opening pauses nothing',
    );
    assert.strictEqual(action('noteResume', sheet()).hidden, true);
    click(action('notePlay', sheet()));
    const noteRead = lastMessage('readAloudSynthesize');
    assert.notStrictEqual(noteRead.args[1], docRead.args[1]);
    assert.strictEqual(noteRead.args[3].kind, 'note');
    assert.ok(noteRead.args[2].startsWith('Played'), 'from the title');
    assert.ok(
      noteRead.args[2].includes('the figure that appears most often'),
      'the passage',
    );
    assert.ok(
      noteRead.args[2].includes('Sixty-six characters is the classic measure.'),
      'the sections',
    );
    assert.ok(noteRead.args[2].includes('My note'), 'the My note heading');
    assert.ok(
      noteRead.args[2].endsWith('My own words here.'),
      'and the text, last',
    );
    assert.ok(!noteRead.args[2].includes('Why did you save this'), 'no chrome');
    assert.ok(noteRead.args[3].blocks.length >= 5);
    assert.strictEqual(
      action('noteResume', sheet()).hidden,
      false,
      'Resume offered',
    );
    assert.strictEqual(action('noteResume', sheet()).disabled, false);
    assert.strictEqual(
      q('.mpe-ra-bar-play').getAttribute('data-state'),
      'loading',
      'the note read took over',
    );
    click(action('noteResume', sheet()));
    assert.strictEqual(sheet().hidden, true, 'Resume closes the sheet');
    const resumed = lastMessage('readAloudSynthesize');
    assert.strictEqual(resumed.args[3].kind, 'block');
    assert.ok(
      resumed.args[2].startsWith(P2.slice(0, 20)) ||
        resumed.args[2].includes(P2.slice(20, 60)),
    );
    click(q('.mpe-ra-bar-close'));
    await sleep(20);
  });

  // ----------------------------------------------------- §12 the list sheet

  test('the list sheet: rows in reading order, orphan last with its badge, click opens, All notes', function () {
    const first = noteOn('p1', 'the number of characters on a line', {
      title: 'First',
    });
    const second = noteOn('list', 'the classic figure', { title: 'Second' });
    const o = orphanNote({ title: 'Orphan' });
    sendNotes([o, second, first]);
    control('notesList');
    assert.strictEqual(listSheet().hidden, false);
    assert.strictEqual(
      q('.mpe-ra-notes-list-title').textContent,
      'Notes in this document · 3',
    );
    assert.ok(q('.mpe-ra-bar-notes').classList.contains('is-active'));
    const rows = qa('.mpe-ra-notes-row');
    assert.deepStrictEqual(
      rows.map(
        (r) => r.querySelector('.mpe-ra-notes-row-title > span').textContent,
      ),
      ['First', 'Second', 'Orphan'],
    );
    assert.strictEqual(
      rows[0].querySelector('.mpe-ra-notes-row-summary').textContent,
      'Sixty-six characters is the classic measure.',
    );
    assert.strictEqual(
      rows[2].querySelector('.mpe-ra-notes-badge').textContent,
      'Not in this version',
    );
    assert.ok(
      rows[2]
        .querySelector('.mpe-ra-notes-row-meta')
        .textContent.startsWith('Was under The old section'),
    );
    assert.strictEqual(rows[0].querySelector('.mpe-ra-notes-badge'), null);
    click(action('notesShowAll', listSheet()));
    assert.deepStrictEqual(plain(lastMessage('readAloudNotesShowAll').args), [
      SOURCE_URI,
    ]);
    click(rows[1]);
    assert.strictEqual(listSheet().hidden, true, 'the list closes');
    assert.strictEqual(sheet().hidden, false, 'the note opens');
    assert.strictEqual(q('.mpe-ra-note-body h1').textContent, 'Second');
    // Alt+Shift+N toggles.
    control('notesList');
    assert.strictEqual(sheet().hidden, true, 'one sheet at a time');
    assert.strictEqual(listSheet().hidden, false);
    control('notesList');
    assert.strictEqual(listSheet().hidden, true);
    // Empty.
    sendNotes([]);
    control('notesList');
    assert.strictEqual(q('.mpe-ra-notes-list-empty').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-notes-list-empty').textContent,
      'No notes yet. Select text and choose Save a note.',
    );
    assert.strictEqual(
      q('.mpe-ra-notes-list-title').textContent,
      'Notes in this document',
    );
    assert.strictEqual(q('.mpe-ra-bar-badge').hidden, true);
    // Escape closes it.
    q('.mpe-ra-bar').dispatchEvent(
      new win.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.strictEqual(listSheet().hidden, true);
  });

  test('opening a note closes help; opening help closes the note; a list for another document is dropped', async function () {
    const a = noteOn('p1', 'the figure that appears most often');
    sendNotes([a]);
    await selectWords('p2', 'a sample passage');
    click(q('.mpe-ra-bar-help'));
    assert.strictEqual(q('.mpe-ra-help').hidden, false);
    control('showNote', { noteId: a.id });
    assert.strictEqual(q('.mpe-ra-help').hidden, true);
    assert.strictEqual(sheet().hidden, false);
    await selectWords('p2', 'a sample passage');
    click(q('.mpe-ra-bar-help'));
    assert.strictEqual(sheet().hidden, true);
    assert.strictEqual(q('.mpe-ra-help').hidden, false);
    click(action('helpClose', q('.mpe-ra-help')));
    await clearSelection();
    host({
      command: 'readAloudNotes',
      sourceUri: 'file:///other.md',
      notes: [],
      deleting: [],
      deleteMode: 'trash',
      generate: true,
    });
    assert.strictEqual(
      qa('.mpe-ra-note-marker').length,
      1,
      "another document's list changes nothing",
    );
  });

  test('a generation error and the generation-off line', function () {
    const failed = noteOn('p1', 'the figure that appears most often', {
      html: '',
      sectionNames: [],
      generated: {
        status: 'error',
        source: 'engine',
        engine: 'claude',
        model: 'sonnet',
        error: 'The model did not answer in 90 seconds.',
      },
    });
    sendNotes([failed]);
    control('showNote', { noteId: failed.id });
    assert.strictEqual(
      q('.mpe-ra-note-details').textContent,
      'The summary could not be written.',
    );
    assert.ok(q('.mpe-ra-note-details').classList.contains('is-error'));
    assert.strictEqual(
      q('.mpe-ra-note-body .mpe-ra-note-line').textContent,
      'The summary could not be written. The model did not answer in 90 seconds.',
    );
    assert.strictEqual(action('noteRegenerate', sheet()).disabled, false);
    click(action('noteRegenerate', sheet()));
    const regenerate = lastMessage('readAloudNoteRegenerate');
    assert.strictEqual(regenerate.args[1], failed.id);
    assert.strictEqual(
      regenerate.args[2].contextMode,
      'section',
      'fresh fields when anchored',
    );
    assert.ok(regenerate.args[2].enclosing.includes('⟦the figure'));
    host({
      command: 'readAloudNoteError',
      noteId: failed.id,
      message: 'The summary could not be written. Boom.',
    });
    assert.strictEqual(
      q('.mpe-ra-note-chip-text').textContent,
      'The summary could not be written. Boom.',
    );
    const off = noteOn('p1', 'the figure that appears most often', {
      html: '',
      sectionNames: [],
      generated: { status: 'done' },
    });
    sendNotes([off], { generate: false });
    control('showNote', { noteId: off.id });
    assert.strictEqual(
      q('.mpe-ra-note-body .mpe-ra-note-line').textContent,
      'Summaries are off in settings. The passage and your note are saved.',
    );
    assert.strictEqual(
      action('noteRegenerate', sheet()).disabled,
      false,
      'on demand',
    );
    // An orphan regenerates from the stored context.
    const o = orphanNote();
    sendNotes([o]);
    control('showNote', { noteId: o.id });
    click(action('noteRegenerate', sheet()));
    assert.strictEqual(lastMessage('readAloudNoteRegenerate').args[2], null);
    click(action('noteClose', sheet()));
  });

  test('Open in editor posts the editor target', function () {
    const a = noteOn('p1', 'the figure that appears most often');
    sendNotes([a]);
    control('showNote', { noteId: a.id });
    click(action('noteOpenEditor', sheet()));
    assert.deepStrictEqual(plain(lastMessage('readAloudNoteOpen').args), [
      SOURCE_URI,
      a.id,
      'editor',
    ]);
    click(action('noteClose', sheet()));
  });

  test('[hidden] resolves to display none for every new element (the 09 lesson)', function () {
    for (const selector of [
      '.mpe-ra-note[hidden]',
      '.mpe-ra-notes-list[hidden]',
      '.mpe-ra-bar .mpe-ra-note-chip[hidden]',
      '.mpe-ra-bar .mpe-ra-note-undo[hidden]',
      '.mpe-ra-note-banner[hidden]',
      '.mpe-ra-note-path[hidden]',
      '.mpe-ra-note-context-body[hidden]',
      '.mpe-ra-bar-badge[hidden]',
      '.mpe-ra-notes-list-empty[hidden]',
      '.mpe-ra-float-btn[hidden]',
    ]) {
      const at = CSS.indexOf(selector);
      assert.ok(at >= 0, selector + ' has a rule');
      const block = CSS.slice(at, CSS.indexOf('}', at));
      assert.ok(
        /display:\s*none/.test(block),
        selector + ' says display: none',
      );
    }
  });

  test('the words mark is a highlight, never DOM, and the marker is chrome the reader never speaks', function () {
    const a = noteOn('p1', 'the figure that appears most often');
    sendNotes([a]);
    const p1 = doc.getElementById('p1');
    assert.strictEqual(
      p1.querySelectorAll('span').length,
      0,
      'no spans in the text',
    );
    const extracted = win.MpeReadAloudCore.extractText(p1).text;
    assert.strictEqual(
      extracted,
      P1,
      "the marker adds nothing to the block's text",
    );
    assert.ok(
      p1.querySelector('.mpe-ra-note-marker').classList.contains('mpe-ra-ui'),
    );
  });
});
