/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// Retell (`featrues/15-convert-readable/spec.md` §12.5, §11.3) — the edition
// markers and the delete path of media/read-aloud.js under jsdom: the
// `readAloudRetellEditions` list draws one ear marker per edition-bearing
// block with the count badge, third in the stack under a note marker and a
// module marker on the same block; an anchor with an empty block key finds
// its heading by text; an orphan has no marker and its sheet row carries the
// badge; the click opens the edition or the sheet; progress moves the `3/18`
// badge; Delete shows the chip with Undo; `retellMarker` off removes the
// markers and keeps the rows.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

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
  '<h2 id="the-measure" data-source-line="3">The measure</h2>' +
  `<p id="p1" data-source-line="5">${P1}</p>` +
  `<p id="p2" data-source-line="7">${P2}</p>` +
  '<h2 id="the-rhythm" data-source-line="13">The rhythm</h2>' +
  `<p id="p3" data-source-line="15">${P3}</p>` +
  '<p id="p4" data-source-line="23">A closing paragraph with nothing in common with the others.</p>';

const SOURCE_URI = 'file:///doc.md';
const PREVIEW =
  '<!doctype html><html><body class="preview-container">' +
  `<div id="crossnote-data" data-config='{"sourceUri":"${SOURCE_URI}"}'></div>` +
  '<div class="crossnote markdown-preview" data-for="preview">' +
  FIXTURE +
  '</div></body></html>';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

suite('read-aloud retell markers (15 §12.5, §11.3)', function () {
  this.timeout(30000);

  let dom;
  let win;
  let doc;
  let posted;
  let logs;
  let sequence = 0;
  const windows = [];

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
      }
      play() {
        this.paused = false;
        return Promise.resolve();
      }
      pause() {
        this.paused = true;
      }
      load() {}
      removeAttribute() {}
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
          classroomAvailable: true,
          classroomMarker: true,
          classroomModule: null,
          retellAvailable: true,
          retellMarker: true,
          retellEdition: null,
        },
        overrides || {},
      ),
    );
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

  function action(name, within) {
    return (within || doc).querySelector('[data-mpe-ra-action="' + name + '"]');
  }

  function lastMessage(command) {
    return posted.filter((m) => m.command === command).pop();
  }

  function messages(command) {
    return posted.filter((m) => m.command === command);
  }

  /** The anchor of `needle` in `#id`, as the host stores a unit's anchor. */
  function anchorOn(id, needle) {
    const el = doc.getElementById(id);
    const c = win.MpeReadAloudCore;
    const text = c.extractText(el).text;
    const offset = text.indexOf(needle);
    assert.ok(offset >= 0, `"${needle}" in #${id}`);
    return {
      exact: needle,
      block: c.blockKey(el, text),
      line: Number(el.getAttribute('data-source-line')),
      prefix: text.slice(Math.max(0, offset - 64), offset),
      suffix: text.slice(offset + needle.length, offset + needle.length + 64),
      offset,
      blocks: 1,
    };
  }

  function nextId() {
    sequence++;
    const stamp = String(10 + sequence).padStart(2, '0');
    return {
      id: `20260907T1045${stamp}Z-${(0x9000 + sequence).toString(16).slice(-4)}`,
      created: `2026-09-07T10:45:${stamp}Z`,
    };
  }

  function editionOn(id, needle, overrides) {
    const next = nextId();
    return Object.assign(
      {
        id: next.id,
        title: 'Edition on ' + needle.split(' ').slice(0, 2).join(' '),
        created: next.created,
        status: 'done',
        sections: 3,
        done: 3,
        minutes: 12,
        anchors: [anchorOn(id, needle)],
        headings: ['Reading on a screen'],
        documentTitle: 'Reading on a screen',
        unitHeadings: [needle],
      },
      overrides || {},
    );
  }

  /** §12.5 — the whole-document command's anchor: the heading text, no block key. */
  function editionByHeading(heading, line, overrides) {
    const next = nextId();
    return Object.assign(
      {
        id: next.id,
        title: 'Reading on a screen: the spoken edition',
        created: next.created,
        status: 'done',
        sections: 18,
        done: 18,
        minutes: 49,
        anchors: [
          {
            exact: heading,
            block: '',
            line,
            prefix: '',
            suffix: '',
            offset: 0,
            blocks: 1,
          },
        ],
        headings: ['Reading on a screen'],
        documentTitle: 'Reading on a screen',
        unitHeadings: [heading],
      },
      overrides || {},
    );
  }

  function orphanEdition(overrides) {
    const next = nextId();
    return Object.assign(
      {
        id: next.id,
        title: 'An edition whose section is gone',
        created: next.created,
        status: 'done',
        sections: 1,
        done: 1,
        minutes: 3,
        anchors: [
          {
            exact: 'words that are no longer anywhere in this document at all',
            block: 'bdeadbeef',
            line: 40,
            prefix: '',
            suffix: '',
            offset: 0,
            blocks: 1,
          },
        ],
        headings: ['Reading on a screen', 'An old section'],
        documentTitle: 'Reading on a screen',
        unitHeadings: ['An old section'],
      },
      overrides || {},
    );
  }

  function noteOn(id, needle) {
    const anchor = anchorOn(id, needle);
    return {
      id: '20260905T154210Z-7f3a',
      title: 'A note',
      titleEdited: false,
      shape: 'passage',
      created: '2026-09-05T15:42:10Z',
      updated: '2026-09-05T15:42:10Z',
      headings: ['Reading on a screen', 'The measure'],
      passage: needle,
      anchor,
      generated: { status: 'done', source: 'engine', engine: 'claude' },
      tags: [],
      myNote: '',
      html: '<h2>Summary</h2><p>S.</p>',
      sectionsMarkdown: '## Summary\n\nS.',
      sectionNames: ['Summary'],
      context: { enclosing: '', before: '', after: '' },
      summaryLine: 'S.',
    };
  }

  function moduleOn(id, needle) {
    return {
      id: '20260905T173010Z-4c2e',
      title: 'A module',
      created: '2026-09-05T17:30:10Z',
      status: 'done',
      chapters: 6,
      done: 6,
      minutes: 20,
      anchor: anchorOn(id, needle),
      headings: ['Reading on a screen', 'The measure'],
      passage: needle,
    };
  }

  function sendEditions(list, extra) {
    host(
      Object.assign(
        {
          command: 'readAloudRetellEditions',
          sourceUri: SOURCE_URI,
          editions: list,
          deleting: [],
          deleteMode: 'trash',
        },
        extra || {},
      ),
    );
  }

  function sendNotes(list) {
    host({
      command: 'readAloudNotes',
      sourceUri: SOURCE_URI,
      notes: list,
      deleting: [],
      deleteMode: 'trash',
      generate: true,
    });
  }

  function sendModules(list) {
    host({
      command: 'readAloudClassroomModules',
      sourceUri: SOURCE_URI,
      modules: list,
      deleting: [],
      deleteMode: 'trash',
    });
  }

  function prepared(overrides) {
    const prepare = lastMessage('readAloudRetellPrepare');
    assert.ok(prepare, 'a prepare was posted; logs: ' + logs.join('\n'));
    host(
      Object.assign(
        {
          command: 'readAloudRetellPrepared',
          requestId: prepare.args[1],
          units: [
            {
              n: 1,
              heading: 'The measure',
              level: 2,
              line: 3,
              endLine: 12,
              words: 60,
              codeWords: 0,
              tableWords: 0,
              proseWords: 60,
            },
          ],
          sourceWords: 60,
          estimate: { words: 80, minutes: 1 },
          ceiling: 108,
          widened: true,
          shape: 'full',
          engine: { engine: 'claude', model: 'sonnet', effort: 'low' },
          editions: [],
          rebuildOf: null,
          building: null,
        },
        overrides || {},
      ),
    );
  }

  async function selectWords(id, needle) {
    const node = Array.from(doc.getElementById(id).childNodes).find(
      (child) => child.nodeType === 3 && child.data.includes(needle),
    );
    assert.ok(node, `text "${needle}" in #${id}`);
    const at = node.data.indexOf(needle);
    const range = doc.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    const selection = win.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new win.Event('selectionchange'));
    await sleep(220);
  }

  async function clearSelection() {
    win.getSelection().removeAllRanges();
    doc.dispatchEvent(new win.Event('selectionchange'));
    await sleep(220);
  }

  suiteSetup(async function () {
    boot();
    await sleep(60);
    enable();
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

  test('the list draws one marker per edition-bearing block, newest first, with a count badge and the gutter', function () {
    const a = editionOn('p1', 'the figure that appears most often', {
      title: 'Older on p1',
      created: '2026-09-07T10:00:00Z',
    });
    const b = editionOn('p1', 'the number of characters on a line', {
      title: 'Newer on p1',
      created: '2026-09-07T10:30:00Z',
    });
    const c = editionOn('p3', 'Line height is the second decision', {
      title: 'On p3',
    });
    sendEditions([a, b, c]);
    const markers = qa('.mpe-ra-retell-marker');
    assert.strictEqual(markers.length, 2, 'one marker per block');
    const onP1 = doc
      .getElementById('p1')
      .querySelector('.mpe-ra-retell-marker');
    assert.ok(onP1, 'inside its block');
    assert.strictEqual(onP1.getAttribute('data-mpe-ra-action'), 'retellMarker');
    assert.strictEqual(
      onP1.getAttribute('data-mpe-ra-edition'),
      b.id,
      'the newest names the marker',
    );
    assert.strictEqual(
      onP1.querySelector('.mpe-ra-retell-count').textContent,
      '2',
    );
    assert.strictEqual(
      onP1.getAttribute('title'),
      'Newer on p1 · 2 spoken editions',
    );
    assert.ok(
      onP1.classList.contains('mpe-ra-ui'),
      'chrome the reader never speaks',
    );
    assert.ok(onP1.querySelector('svg'), 'the ear glyph');
    assert.ok(
      !onP1.classList.contains('is-below-note'),
      'nothing above it on this block',
    );
    assert.strictEqual(onP1.getAttribute('data-mpe-ra-below'), null);
    const onP3 = doc
      .getElementById('p3')
      .querySelector('.mpe-ra-retell-marker');
    assert.strictEqual(onP3.getAttribute('title'), 'On p3');
    assert.strictEqual(onP3.querySelector('.mpe-ra-retell-count'), null);
    assert.ok(q('.markdown-preview').classList.contains('mpe-ra-notes-gutter'));
    // Extraction never sees the marker: the block key is unchanged.
    const c2 = win.MpeReadAloudCore;
    assert.strictEqual(
      c2.blockKey(
        doc.getElementById('p1'),
        c2.extractText(doc.getElementById('p1')).text,
      ),
      a.anchors[0].block,
    );
    assert.strictEqual(
      messages('readAloudNoteAnchors').length,
      0,
      'no anchors write-back for editions',
    );
  });

  test('the marker sits 1.6em under a note marker, under a module marker, and under both', function () {
    const e = editionOn('p1', 'the figure that appears most often');
    sendEditions([e]);
    const marker = () =>
      doc.getElementById('p1').querySelector('.mpe-ra-retell-marker');
    // Under a note marker only.
    sendNotes([noteOn('p1', 'the figure that appears most often')]);
    assert.ok(doc.getElementById('p1').querySelector('.mpe-ra-note-marker'));
    assert.ok(marker().classList.contains('is-below-note'));
    assert.ok(!marker().classList.contains('is-below-two'));
    // jsdom's style parser drops calc(); the attribute carries the base the
    // inline top is computed from in a real engine.
    assert.strictEqual(marker().getAttribute('data-mpe-ra-below'), '0.1em');
    // Under a module marker only.
    sendNotes([]);
    sendModules([moduleOn('p1', 'the figure that appears most often')]);
    assert.ok(
      doc.getElementById('p1').querySelector('.mpe-ra-classroom-marker'),
    );
    assert.strictEqual(qa('.mpe-ra-note-marker').length, 0);
    assert.ok(marker().classList.contains('is-below-note'));
    assert.ok(!marker().classList.contains('is-below-two'));
    assert.strictEqual(marker().getAttribute('data-mpe-ra-below'), '0.1em');
    // Under both: the module marker's own base plus its offset.
    sendNotes([noteOn('p1', 'the figure that appears most often')]);
    const moduleMarker = doc
      .getElementById('p1')
      .querySelector('.mpe-ra-classroom-marker');
    assert.strictEqual(moduleMarker.getAttribute('data-mpe-ra-below'), '0.1em');
    assert.ok(marker().classList.contains('is-below-note'));
    assert.ok(marker().classList.contains('is-below-two'));
    assert.strictEqual(
      marker().getAttribute('data-mpe-ra-below'),
      'calc(0.1em + 1.6em)',
    );
    // Notes and modules off: the retell marker keeps the gutter and stands alone.
    enable({ notesAvailable: false, classroomAvailable: false });
    assert.strictEqual(qa('.mpe-ra-note-marker').length, 0);
    assert.strictEqual(qa('.mpe-ra-classroom-marker').length, 0);
    assert.strictEqual(qa('.mpe-ra-retell-marker').length, 1);
    assert.ok(!marker().classList.contains('is-below-note'));
    assert.strictEqual(marker().getAttribute('data-mpe-ra-below'), null);
    assert.ok(q('.markdown-preview').classList.contains('mpe-ra-notes-gutter'));
    enable();
    sendNotes([]);
    sendModules([]);
  });

  test('an anchor with an empty block key finds its heading by text; a list for another document is dropped; a re-render brings markers back', async function () {
    const d = editionByHeading('The rhythm', 13);
    sendEditions([d]);
    assert.strictEqual(qa('.mpe-ra-retell-marker').length, 1);
    const onHeading = doc
      .getElementById('the-rhythm')
      .querySelector('.mpe-ra-retell-marker');
    assert.ok(onHeading, 'on the h2 the text names');
    assert.strictEqual(onHeading.getAttribute('data-mpe-ra-edition'), d.id);
    host({
      command: 'readAloudRetellEditions',
      sourceUri: 'file:///other.md',
      editions: [],
      deleting: [],
      deleteMode: 'trash',
    });
    assert.strictEqual(
      qa('.mpe-ra-retell-marker').length,
      1,
      'another document changes nothing',
    );
    q('.markdown-preview').innerHTML = FIXTURE;
    await sleep(80);
    assert.strictEqual(
      qa('.mpe-ra-retell-marker').length,
      1,
      'back on the new block',
    );
    assert.ok(
      doc.getElementById('the-rhythm').querySelector('.mpe-ra-retell-marker'),
    );
  });

  test('a click on a single-edition marker opens the edition; on a several-edition marker it opens the sheet with that block first', async function () {
    const a = editionOn('p1', 'the figure that appears most often', {
      title: 'First on p1',
    });
    const b = editionOn('p1', 'the number of characters on a line', {
      title: 'Second on p1',
      created: '2026-09-07T11:00:00Z',
    });
    const c = editionOn('p3', 'Line height is the second decision', {
      title: 'On p3',
    });
    sendEditions([a, b, c]);
    click(doc.getElementById('p3').querySelector('.mpe-ra-retell-marker'));
    assert.deepStrictEqual(plain(lastMessage('readAloudRetellOpen').args), [
      SOURCE_URI,
      c.id,
    ]);
    assert.strictEqual(q('.mpe-ra-retell').hidden, true, 'no sheet for one');
    const marker = doc
      .getElementById('p1')
      .querySelector('.mpe-ra-retell-marker');
    click(marker);
    const sheet = q('.mpe-ra-retell');
    assert.strictEqual(sheet.hidden, false, 'several: the sheet');
    assert.ok(marker.classList.contains('is-active'));
    const prepare = lastMessage('readAloudRetellPrepare');
    assert.ok(prepare, 'Prepare posted');
    assert.deepStrictEqual(plain(prepare.args[3]), {
      startLine: 5,
      endLine: 5,
      scope: 'selection',
    });
    prepared({ editions: [] });
    const rows = qa('.mpe-ra-retell-edition-row');
    assert.deepStrictEqual(
      rows.map(
        (r) => r.querySelector('.mpe-ra-retell-edition-title').textContent,
      ),
      ['Second on p1', 'First on p1', 'On p3'],
      "the block's rows first, newest first, then the rest",
    );
    assert.strictEqual(q('.mpe-ra-retell-editions').hidden, false);
    assert.ok(
      rows[0].querySelector('[data-mpe-ra-action="retellDeleteEdition"]'),
      'each row has Delete',
    );
    click(action('retellClose', sheet));
    assert.ok(!marker.classList.contains('is-active'));
  });

  test('progress on an edition moves the writing badge; stopped tints the marker', function () {
    const a = editionOn('p2', 'a sample passage', {
      status: 'writing',
      sections: 18,
      done: 2,
    });
    sendEditions([a]);
    const marker = doc
      .getElementById('p2')
      .querySelector('.mpe-ra-retell-marker');
    assert.ok(marker.classList.contains('is-writing'));
    assert.strictEqual(
      marker.querySelector('.mpe-ra-retell-progress').textContent,
      '2/18',
    );
    const sections = [];
    for (let i = 0; i < 18; i++) {
      sections.push({
        n: i + 1,
        heading: 'Section ' + (i + 1),
        status: i < 2 ? 'done' : i === 2 ? 'writing' : 'queued',
        flagged: [],
        cached: false,
      });
    }
    host({
      command: 'readAloudRetellProgress',
      editionId: a.id,
      documentUri: SOURCE_URI,
      editionUri: 'file:///e.md',
      status: 'writing',
      title: 'T',
      section: 3,
      of: 18,
      sectionHeading: 'Section 3',
      sections,
      elapsedMs: 100,
      words: 800,
      queuePosition: 0,
      hasSection: true,
      error: null,
    });
    assert.strictEqual(
      marker.querySelector('.mpe-ra-retell-progress').textContent,
      '3/18',
    );
    host({
      command: 'readAloudRetellProgress',
      editionId: a.id,
      documentUri: SOURCE_URI,
      editionUri: 'file:///e.md',
      status: 'stopped',
      title: 'T',
      section: 0,
      of: 18,
      sectionHeading: '',
      sections: [],
      elapsedMs: 100,
      words: 800,
      queuePosition: 0,
      hasSection: true,
      error: null,
    });
    assert.ok(marker.classList.contains('is-stopped'));
    assert.ok(!marker.classList.contains('is-writing'));
    assert.strictEqual(marker.querySelector('.mpe-ra-retell-progress'), null);
  });

  test('Delete from a row: the chip with Undo, the marker and the row go, Undo posts, a delete from elsewhere shows the chip too', async function () {
    const a = editionOn('p1', 'the figure that appears most often', {
      title: 'Gone soon',
    });
    const b = editionOn('p3', 'Line height is the second decision', {
      title: 'Stays',
    });
    sendEditions([a, b]);
    await selectWords('p4', 'A closing paragraph');
    click(q('.mpe-ra-float-retell'));
    prepared({ editions: [] });
    const row = qa('.mpe-ra-retell-edition-row').find(
      (r) => r.getAttribute('data-mpe-ra-edition') === a.id,
    );
    assert.ok(row);
    click(row.querySelector('[data-mpe-ra-action="retellDeleteEdition"]'));
    assert.deepStrictEqual(plain(lastMessage('readAloudRetellDelete').args), [
      SOURCE_URI,
      a.id,
    ]);
    assert.strictEqual(q('.mpe-ra-note-chip').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-note-chip-text').textContent,
      'Spoken edition moved to Trash',
    );
    assert.strictEqual(q('.mpe-ra-note-undo').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-note-undo').getAttribute('data-mpe-ra-kind'),
      'edition',
    );
    assert.strictEqual(
      doc.getElementById('p1').querySelector('.mpe-ra-retell-marker'),
      null,
      'the marker went at once',
    );
    assert.strictEqual(
      qa('.mpe-ra-retell-edition-row').length,
      1,
      'the row went',
    );
    sendEditions([b], { deleting: [a.id] });
    assert.strictEqual(qa('.mpe-ra-retell-marker').length, 1);
    click(q('.mpe-ra-note-undo'));
    assert.deepStrictEqual(
      plain(lastMessage('readAloudRetellUndoDelete').args),
      [SOURCE_URI, a.id],
    );
    assert.strictEqual(q('.mpe-ra-note-chip').hidden, true);
    sendEditions([a, b]);
    assert.strictEqual(
      qa('.mpe-ra-retell-marker').length,
      2,
      'back after Undo',
    );
    assert.strictEqual(qa('.mpe-ra-retell-edition-row').length, 2);
    // A delete from the palette or the Edition sheet: the chip shows here too.
    sendEditions([a], { deleting: [b.id], deleteMode: 'permanent' });
    assert.strictEqual(
      q('.mpe-ra-note-chip-text').textContent,
      'Spoken edition deleted',
    );
    sendEditions([a], { deleting: [] });
    assert.strictEqual(
      q('.mpe-ra-note-chip').hidden,
      true,
      'nothing left to undo',
    );
    click(action('retellClose', q('.mpe-ra-retell')));
    await clearSelection();
  });

  test('an orphaned edition keeps its row with the badge; retellMarker off removes markers and keeps rows', async function () {
    const a = editionOn('p1', 'the figure that appears most often');
    const o = orphanEdition({ title: 'Orphaned edition' });
    sendEditions([a, o]);
    assert.strictEqual(
      qa('.mpe-ra-retell-marker').length,
      1,
      'no marker for the orphan',
    );
    await selectWords('p4', 'A closing paragraph');
    click(q('.mpe-ra-float-retell'));
    prepared({ editions: [] });
    const rows = qa('.mpe-ra-retell-edition-row');
    assert.strictEqual(rows.length, 2);
    const orphanRow = rows.find(
      (r) => r.getAttribute('data-mpe-ra-edition') === o.id,
    );
    assert.strictEqual(
      orphanRow.querySelector('.mpe-ra-retell-orphan').textContent,
      'Not in this version',
    );
    assert.strictEqual(
      rows
        .find((r) => r.getAttribute('data-mpe-ra-edition') === a.id)
        .querySelector('.mpe-ra-retell-orphan'),
      null,
    );
    enable({ retellMarker: false });
    assert.strictEqual(qa('.mpe-ra-retell-marker').length, 0);
    assert.ok(
      !q('.markdown-preview').classList.contains('mpe-ra-notes-gutter'),
    );
    assert.strictEqual(
      qa('.mpe-ra-retell-edition-row').length,
      2,
      'the rows stay',
    );
    enable();
    assert.strictEqual(qa('.mpe-ra-retell-marker').length, 1);
    // Retell off altogether: the sheet closes and the markers go.
    enable({ retellAvailable: false });
    assert.strictEqual(q('.mpe-ra-retell').hidden, true);
    assert.strictEqual(qa('.mpe-ra-retell-marker').length, 0);
    enable();
    await clearSelection();
  });

  test('[hidden] resolves to display none for the marker rows; the marker and its states have rules', function () {
    for (const selector of [
      '.mpe-ra-retell-edition-row[hidden]',
      '.mpe-ra-retell-editions[hidden]',
    ]) {
      const at = CSS.indexOf(selector);
      assert.ok(at >= 0, selector + ' has a rule');
      const block = CSS.slice(at, CSS.indexOf('}', at));
      assert.ok(
        /display:\s*none/.test(block),
        selector + ' says display: none',
      );
    }
    assert.ok(CSS.includes('.mpe-ra-retell-marker {'));
    assert.ok(/\.mpe-ra-retell-marker \{[^}]*right: -1\.9em/.test(CSS));
    assert.ok(CSS.includes('.mpe-ra-retell-marker.is-stopped'));
    assert.ok(CSS.includes('.mpe-ra-retell-marker.is-below-note'));
    assert.ok(CSS.includes('.mpe-ra-retell-marker.is-below-two'));
    assert.ok(CSS.includes('.mpe-ra-retell-progress'));
  });
});
