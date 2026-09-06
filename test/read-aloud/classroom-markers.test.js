/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// Classroom (`featrues/13-classroom/spec.md` §6.1, §11.4, §12.5) — the module
// markers and the delete path of media/read-aloud.js under jsdom: the
// `readAloudClassroomModules` list draws one marker per module-bearing block
// with the count badge, stacked under a note marker on the same block; an
// orphan has no marker and its sheet row carries the badge; the click opens
// the module or the sheet; progress moves the `3/6` badge; Delete shows the
// chip with Undo; `classroomMarker` off removes the markers; the size line
// under the lever follows the shape and the row.

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

suite('read-aloud classroom markers (13 §12.5, §11.4, §6.1)', function () {
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

  /** The anchor of `needle` in `#id`, as the host stores a module's passage. */
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

  function moduleOn(id, needle, overrides) {
    sequence++;
    const stamp = String(10 + sequence).padStart(2, '0');
    return Object.assign(
      {
        id: `20260905T1730${stamp}Z-${(0x4000 + sequence).toString(16).slice(-4)}`,
        title: 'Module on ' + needle.split(' ').slice(0, 2).join(' '),
        created: `2026-09-05T17:30:${stamp}Z`,
        status: 'done',
        chapters: 6,
        done: 6,
        minutes: 20,
        anchor: anchorOn(id, needle),
        headings: ['Reading on a screen', 'The measure'],
        passage: needle,
      },
      overrides || {},
    );
  }

  function orphanModule(overrides) {
    sequence++;
    const stamp = String(10 + sequence).padStart(2, '0');
    return Object.assign(
      {
        id: `20260905T1730${stamp}Z-${(0x4000 + sequence).toString(16).slice(-4)}`,
        title: 'A module whose passage is gone',
        created: `2026-09-05T17:30:${stamp}Z`,
        status: 'done',
        chapters: 6,
        done: 6,
        minutes: 20,
        anchor: {
          exact: 'words that are no longer anywhere in this document at all',
          block: 'bdeadbeef',
          line: 40,
          prefix: '',
          suffix: '',
          offset: 0,
          blocks: 1,
        },
        headings: ['Reading on a screen', 'An old section'],
        passage: 'words that are no longer anywhere in this document at all',
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

  function sendModules(list, extra) {
    host(
      Object.assign(
        {
          command: 'readAloudClassroomModules',
          sourceUri: SOURCE_URI,
          modules: list,
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

  function budgets() {
    return {
      passage: {
        1: { chapters: [3, 3], words: 1500, minutes: 10 },
        2: { chapters: [5, 6], words: 3000, minutes: 20 },
        3: { chapters: [7, 8], words: 4500, minutes: 30 },
      },
      term: {
        1: { chapters: [2, 2], words: 750, minutes: 5 },
        2: { chapters: [4, 4], words: 1350, minutes: 9 },
        3: { chapters: [7, 8], words: 4500, minutes: 30 },
      },
    };
  }

  function prepared(overrides) {
    const prepare = lastMessage('readAloudClassroomPrepare');
    assert.ok(prepare, 'a prepare was posted; logs: ' + logs.join('\n'));
    host(
      Object.assign(
        {
          command: 'readAloudClassroomPrepared',
          requestId: prepare.args[1],
          persona: { id: 'max', name: 'Max', tagline: 'Patient' },
          personas: [{ id: 'max', name: 'Max', tagline: 'Patient' }],
          audience: 'a reader',
          documentWords: 400,
          linked: [],
          modules: [],
          engine: { engine: 'claude', model: 'sonnet', effort: 'medium' },
          building: null,
          budgets: budgets(),
          shortTerm: true,
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

  test('the list draws one marker per module-bearing block, newest first, with a count badge and the gutter', function () {
    const a = moduleOn('p1', 'the figure that appears most often', {
      title: 'Older on p1',
      created: '2026-09-05T17:00:00Z',
    });
    const b = moduleOn('p1', 'the number of characters on a line', {
      title: 'Newer on p1',
      created: '2026-09-05T17:30:00Z',
    });
    const c = moduleOn('p3', 'Line height is the second decision', {
      title: 'On p3',
    });
    sendModules([a, b, c]);
    const markers = qa('.mpe-ra-classroom-marker');
    assert.strictEqual(markers.length, 2, 'one marker per block');
    const onP1 = doc
      .getElementById('p1')
      .querySelector('.mpe-ra-classroom-marker');
    assert.ok(onP1, 'inside its block');
    assert.strictEqual(
      onP1.getAttribute('data-mpe-ra-action'),
      'classroomMarker',
    );
    assert.strictEqual(
      onP1.getAttribute('data-mpe-ra-module'),
      b.id,
      'the newest names the marker',
    );
    assert.strictEqual(
      onP1.querySelector('.mpe-ra-classroom-count').textContent,
      '2',
    );
    assert.strictEqual(onP1.getAttribute('title'), 'Newer on p1 · 2 modules');
    assert.ok(
      onP1.classList.contains('mpe-ra-ui'),
      'chrome the reader never speaks',
    );
    assert.ok(onP1.querySelector('svg'), 'the mortarboard glyph');
    const onP3 = doc
      .getElementById('p3')
      .querySelector('.mpe-ra-classroom-marker');
    assert.strictEqual(onP3.getAttribute('title'), 'On p3');
    assert.strictEqual(onP3.querySelector('.mpe-ra-classroom-count'), null);
    assert.ok(q('.markdown-preview').classList.contains('mpe-ra-notes-gutter'));
    const highlight = win.CSS.highlights.get('mpe-ra-note');
    assert.strictEqual(
      highlight ? highlight.ranges.size : 0,
      0,
      'no words mark for a module',
    );
    // Extraction never sees the marker: the block key is unchanged.
    const c2 = win.MpeReadAloudCore;
    assert.strictEqual(
      c2.blockKey(
        doc.getElementById('p1'),
        c2.extractText(doc.getElementById('p1')).text,
      ),
      a.anchor.block,
    );
    assert.strictEqual(
      messages('readAloudNoteAnchors').length,
      0,
      'no anchors write-back for modules',
    );
  });

  test('a module marker sits under a note marker on the same block', function () {
    sendNotes([noteOn('p1', 'the figure that appears most often')]);
    const noteMarker = doc
      .getElementById('p1')
      .querySelector('.mpe-ra-note-marker');
    assert.ok(noteMarker, 'the note marker is there');
    const moduleMarker = doc
      .getElementById('p1')
      .querySelector('.mpe-ra-classroom-marker');
    assert.ok(moduleMarker, 'and the module marker is back after the pass');
    assert.ok(moduleMarker.classList.contains('is-below-note'));
    // jsdom's style parser drops calc(); the attribute carries the base the
    // inline top is computed from in a real engine.
    assert.strictEqual(moduleMarker.getAttribute('data-mpe-ra-below'), '0.1em');
    const onP3 = doc
      .getElementById('p3')
      .querySelector('.mpe-ra-classroom-marker');
    assert.ok(!onP3.classList.contains('is-below-note'));
    // Notes off: the module markers keep the gutter.
    enable({ notesAvailable: false });
    assert.strictEqual(qa('.mpe-ra-note-marker').length, 0);
    assert.strictEqual(qa('.mpe-ra-classroom-marker').length, 2);
    assert.ok(q('.markdown-preview').classList.contains('mpe-ra-notes-gutter'));
    enable();
    sendNotes([]);
  });

  test('an orphan has no marker; a list for another document is dropped; a re-render brings markers back', async function () {
    const a = moduleOn('p1', 'the figure that appears most often');
    const o = orphanModule();
    sendModules([a, o]);
    assert.strictEqual(qa('.mpe-ra-classroom-marker').length, 1);
    host({
      command: 'readAloudClassroomModules',
      sourceUri: 'file:///other.md',
      modules: [],
      deleting: [],
      deleteMode: 'trash',
    });
    assert.strictEqual(
      qa('.mpe-ra-classroom-marker').length,
      1,
      'another document changes nothing',
    );
    q('.markdown-preview').innerHTML = FIXTURE;
    await sleep(80);
    assert.strictEqual(
      qa('.mpe-ra-classroom-marker').length,
      1,
      'back on the new block',
    );
    assert.ok(
      doc.getElementById('p1').querySelector('.mpe-ra-classroom-marker'),
    );
  });

  test('a click on a single-module marker opens the module; on a several-module marker it opens the sheet with that block first', async function () {
    const a = moduleOn('p1', 'the figure that appears most often', {
      title: 'First on p1',
    });
    const b = moduleOn('p1', 'the number of characters on a line', {
      title: 'Second on p1',
      created: '2026-09-05T18:00:00Z',
    });
    const c = moduleOn('p3', 'Line height is the second decision', {
      title: 'On p3',
    });
    sendModules([a, b, c]);
    click(doc.getElementById('p3').querySelector('.mpe-ra-classroom-marker'));
    assert.deepStrictEqual(plain(lastMessage('readAloudClassroomOpen').args), [
      SOURCE_URI,
      c.id,
    ]);
    assert.strictEqual(
      q('.mpe-ra-classroom').hidden,
      true,
      'no sheet for one module',
    );
    const marker = doc
      .getElementById('p1')
      .querySelector('.mpe-ra-classroom-marker');
    click(marker);
    const sheet = q('.mpe-ra-classroom');
    assert.strictEqual(sheet.hidden, false, 'several: the sheet');
    assert.ok(marker.classList.contains('is-active'));
    assert.ok(
      q('.mpe-ra-classroom-quote').textContent.includes(
        'the number of characters',
      ),
    );
    const prepare = lastMessage('readAloudClassroomPrepare');
    assert.ok(prepare, 'Prepare posted');
    prepared({ modules: [] });
    const rows = qa('.mpe-ra-classroom-module-row');
    assert.deepStrictEqual(
      rows.map(
        (r) => r.querySelector('.mpe-ra-classroom-module-title').textContent,
      ),
      ['First on p1', 'Second on p1', 'On p3'],
      "the block's rows first, then the rest",
    );
    assert.strictEqual(q('.mpe-ra-classroom-modules').hidden, false);
    assert.ok(
      rows[0].querySelector('[data-mpe-ra-action="classroomDeleteModule"]'),
      'each row has Delete',
    );
    click(action('classroomClose', sheet));
    assert.ok(!marker.classList.contains('is-active'));
  });

  test('progress on a module moves the writing badge; stopped tints the marker', function () {
    const a = moduleOn('p2', 'a sample passage', {
      status: 'writing',
      done: 1,
    });
    sendModules([a]);
    const marker = doc
      .getElementById('p2')
      .querySelector('.mpe-ra-classroom-marker');
    assert.ok(marker.classList.contains('is-writing'));
    host({
      command: 'readAloudClassroomProgress',
      moduleId: a.id,
      documentUri: SOURCE_URI,
      moduleUri: 'file:///m.md',
      status: 'writing',
      title: 'T',
      chapter: 3,
      of: 6,
      chapterTitle: 'Three',
      chapters: [
        { n: 1, title: 'a', status: 'done', flagged: [] },
        { n: 2, title: 'b', status: 'done', flagged: [] },
        { n: 3, title: 'c', status: 'writing', flagged: [] },
      ],
      elapsedMs: 100,
      words: 800,
      queuePosition: 0,
      error: null,
      hasChapter: true,
    });
    assert.strictEqual(
      marker.querySelector('.mpe-ra-classroom-progress').textContent,
      '3/6',
    );
    host({
      command: 'readAloudClassroomProgress',
      moduleId: a.id,
      documentUri: SOURCE_URI,
      moduleUri: 'file:///m.md',
      status: 'stopped',
      title: 'T',
      chapter: 0,
      of: 6,
      chapterTitle: '',
      chapters: [],
      elapsedMs: 100,
      words: 800,
      queuePosition: 0,
      error: null,
      hasChapter: true,
    });
    assert.ok(marker.classList.contains('is-stopped'));
    assert.ok(!marker.classList.contains('is-writing'));
    assert.strictEqual(
      marker.querySelector('.mpe-ra-classroom-progress'),
      null,
    );
  });

  test('Delete from a row: the chip with Undo, the marker and the row go, Undo posts, a delete from elsewhere shows the chip too', async function () {
    const a = moduleOn('p1', 'the figure that appears most often', {
      title: 'Gone soon',
    });
    const b = moduleOn('p3', 'Line height is the second decision', {
      title: 'Stays',
    });
    sendModules([a, b]);
    await selectWords('p4', 'A closing paragraph');
    click(q('.mpe-ra-float-classroom'));
    prepared({ modules: [] });
    const row = qa('.mpe-ra-classroom-module-row').find(
      (r) => r.getAttribute('data-mpe-ra-module') === a.id,
    );
    assert.ok(row);
    click(row.querySelector('[data-mpe-ra-action="classroomDeleteModule"]'));
    assert.deepStrictEqual(
      plain(lastMessage('readAloudClassroomDelete').args),
      [SOURCE_URI, a.id],
    );
    assert.strictEqual(q('.mpe-ra-note-chip').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-note-chip-text').textContent,
      'Module moved to Trash',
    );
    assert.strictEqual(q('.mpe-ra-note-undo').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-note-undo').getAttribute('data-mpe-ra-kind'),
      'module',
    );
    assert.strictEqual(
      doc.getElementById('p1').querySelector('.mpe-ra-classroom-marker'),
      null,
      'the marker went at once',
    );
    assert.strictEqual(
      qa('.mpe-ra-classroom-module-row').length,
      1,
      'the row went',
    );
    sendModules([b], { deleting: [a.id] });
    assert.strictEqual(qa('.mpe-ra-classroom-marker').length, 1);
    click(q('.mpe-ra-note-undo'));
    assert.deepStrictEqual(
      plain(lastMessage('readAloudClassroomUndoDelete').args),
      [SOURCE_URI, a.id],
    );
    assert.strictEqual(q('.mpe-ra-note-chip').hidden, true);
    sendModules([a, b]);
    assert.strictEqual(
      qa('.mpe-ra-classroom-marker').length,
      2,
      'back after Undo',
    );
    assert.strictEqual(qa('.mpe-ra-classroom-module-row').length, 2);
    // A delete from the palette or the Module sheet: the chip shows here too.
    sendModules([a], { deleting: [b.id], deleteMode: 'permanent' });
    assert.strictEqual(
      q('.mpe-ra-note-chip-text').textContent,
      'Module deleted',
    );
    sendModules([a], { deleting: [] });
    assert.strictEqual(
      q('.mpe-ra-note-chip').hidden,
      true,
      'nothing left to undo',
    );
    click(action('classroomClose', q('.mpe-ra-classroom')));
    await clearSelection();
  });

  test('an orphaned module keeps its row with the badge; classroomMarker off removes markers and keeps rows', async function () {
    const a = moduleOn('p1', 'the figure that appears most often');
    const o = orphanModule({ title: 'Orphaned module' });
    sendModules([a, o]);
    await selectWords('p4', 'A closing paragraph');
    click(q('.mpe-ra-float-classroom'));
    prepared({ modules: [] });
    const rows = qa('.mpe-ra-classroom-module-row');
    assert.strictEqual(rows.length, 2);
    const orphanRow = rows.find(
      (r) => r.getAttribute('data-mpe-ra-module') === o.id,
    );
    assert.strictEqual(
      orphanRow.querySelector('.mpe-ra-classroom-orphan').textContent,
      'Not in this version',
    );
    assert.strictEqual(
      rows
        .find((r) => r.getAttribute('data-mpe-ra-module') === a.id)
        .querySelector('.mpe-ra-classroom-orphan'),
      null,
    );
    enable({ classroomMarker: false });
    assert.strictEqual(qa('.mpe-ra-classroom-marker').length, 0);
    assert.ok(
      !q('.markdown-preview').classList.contains('mpe-ra-notes-gutter'),
    );
    assert.strictEqual(
      qa('.mpe-ra-classroom-module-row').length,
      2,
      'the rows stay',
    );
    enable();
    assert.strictEqual(qa('.mpe-ra-classroom-marker').length, 1);
    click(action('classroomClose', q('.mpe-ra-classroom')));
    await clearSelection();
  });

  test('the Module sheet of a module preview offers Delete module', async function () {
    boot();
    await sleep(60);
    enable({
      classroomModule: {
        id: '20260905T173010Z-4c2e',
        title: 'This one',
        status: 'done',
        chapters: [],
        documentTitle: 'Doc',
        documentPath: 'doc.md',
        documentHeading: '',
      },
    });
    host({ command: 'readAloudControl', action: 'classroomModule' });
    const sheet = q('.mpe-ra-module');
    assert.strictEqual(sheet.hidden, false);
    const remove = action('moduleDelete', sheet);
    assert.ok(remove);
    assert.strictEqual(remove.textContent, 'Delete module');
    click(remove);
    assert.deepStrictEqual(
      plain(lastMessage('readAloudClassroomDelete').args),
      [SOURCE_URI, '20260905T173010Z-4c2e'],
    );
    assert.strictEqual(
      q('.mpe-ra-note-chip-text').textContent,
      'Module moved to Trash',
    );
  });

  test('the size line under the lever follows the shape and the row (13 §6.1)', async function () {
    boot();
    await sleep(60);
    enable();
    // A term: five words or fewer.
    await selectWords('p3', 'Line height is the');
    click(q('.mpe-ra-float-classroom'));
    assert.strictEqual(
      q('.mpe-ra-classroom-size').hidden,
      true,
      'nothing before Prepared',
    );
    prepared();
    const size = q('.mpe-ra-classroom-size');
    assert.strictEqual(size.hidden, false);
    assert.strictEqual(
      size.textContent,
      '4 chapters · about 9 minutes',
      'level 2 is preselected',
    );
    click(qa('.mpe-ra-lever-row')[0]);
    assert.strictEqual(size.textContent, '2 chapters · about 5 minutes');
    click(qa('.mpe-ra-lever-row')[2]);
    assert.strictEqual(
      size.textContent,
      '7 or 8 chapters · about 30 minutes',
      'level 3 keeps the ladder',
    );
    click(action('classroomClose', q('.mpe-ra-classroom')));
    await clearSelection();
    // A passage: the level's full budget.
    await selectWords('p1', 'the figure that appears most often');
    click(q('.mpe-ra-float-classroom'));
    prepared();
    assert.strictEqual(
      q('.mpe-ra-classroom-size').textContent,
      '5 or 6 chapters · about 20 minutes',
    );
    click(qa('.mpe-ra-lever-row')[0]);
    assert.strictEqual(
      q('.mpe-ra-classroom-size').textContent,
      '3 chapters · about 10 minutes',
    );
    click(action('classroomClose', q('.mpe-ra-classroom')));
    await clearSelection();
    // The setting off: a term takes the full budget.
    await selectWords('p3', 'Line height is the');
    click(q('.mpe-ra-float-classroom'));
    prepared({ shortTerm: false });
    assert.strictEqual(
      q('.mpe-ra-classroom-size').textContent,
      '5 or 6 chapters · about 20 minutes',
    );
    click(action('classroomClose', q('.mpe-ra-classroom')));
    await clearSelection();
  });

  test('[hidden] resolves to display none for the new elements (the 09 lesson)', function () {
    for (const selector of ['.mpe-ra-classroom-size[hidden]']) {
      const at = CSS.indexOf(selector);
      assert.ok(at >= 0, selector + ' has a rule');
      const block = CSS.slice(at, CSS.indexOf('}', at));
      assert.ok(
        /display:\s*none/.test(block),
        selector + ' says display: none',
      );
    }
    assert.ok(CSS.includes('.mpe-ra-classroom-marker {'));
    assert.ok(CSS.includes('.mpe-ra-classroom-marker.is-stopped'));
  });
});
