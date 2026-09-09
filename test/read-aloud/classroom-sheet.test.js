/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// Classroom (`featrues/13-classroom/spec.md` §17) — the classroom layer of
// media/read-aloud.js under jsdom with fake <audio> elements: the fourth
// cluster button and its predicate, `Alt+C` and the no-selection hint, the
// Prepare on open, the four states from `Prepared` and `Progress` messages,
// the lever default, the sentence cap, the instructor select, the Build
// payload with an unticked link removed, Cancel and Open, Escape keeping the
// build, `Teach me this` on the help sheet, the module preview's bar button,
// badge and Module sheet, the message line, `revealAnchor`, one sheet at a
// time, and the `[hidden]` display rules.

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

const FIXTURE =
  '<h1 id="h1" data-source-line="1">Reading on a screen</h1>' +
  '<h2 id="the-measure" data-source-line="3">The measure</h2>' +
  `<p id="p1" data-source-line="5">${P1}</p>` +
  `<p id="p2" data-source-line="7">${P2}</p>` +
  '<pre id="code"><code>not prose</code></pre>' +
  '<p id="p4" data-source-line="23">A closing paragraph with nothing in common with the others.</p>';

const SOURCE_URI = 'file:///doc.md';
const MODULE_URI =
  'file:///home/x/.crossnote/classroom/modules/ws/doc.md/20260905T173010Z-4c2e-the-measure.md';
const MODULE_ID = '20260905T173010Z-4c2e';
const PREVIEW =
  '<!doctype html><html><body class="preview-container">' +
  `<div id="crossnote-data" data-config='{"sourceUri":"${SOURCE_URI}"}'></div>` +
  '<div class="crossnote markdown-preview" data-for="preview">' +
  FIXTURE +
  '</div></body></html>';

const ANSWER_HTML =
  '<h3>What it says</h3><p>The measure is the line length.</p>';
const ANSWER_MARKDOWN = '### What it says\nThe measure is the line length.';

const CHAPTERS = [
  'Module Introduction',
  'Who Is a Code Owner',
  'Checks, Comments, and the Merge Button',
  'A Merge Is Not a Deploy',
  'Why the Deploy Job Borrows Its Keys',
  'Walking the Passage',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A posted payload as plain data: the jsdom realm's Array and Object differ from Node's. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function chapterStates(done, writing) {
  return CHAPTERS.map((title, i) => ({
    n: i + 1,
    title,
    status: i < done ? 'done' : i === writing ? 'writing' : 'queued',
    flagged: i === 1 && i < done ? ['length-target'] : [],
  }));
}

suite('read-aloud classroom layer (13-classroom)', function () {
  this.timeout(30000);

  let dom;
  let win;
  let doc;
  let posted;
  let logs;
  const windows = [];

  function boot(configOverrides) {
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
    win.Highlight = class {
      constructor() {
        this.ranges = new Set();
      }
      add() {
        return this;
      }
      delete() {
        return true;
      }
    };
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
    if (configOverrides) {
      enable(configOverrides);
    }
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
        },
        overrides || {},
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
    return q('.mpe-ra-classroom');
  }

  function moduleSheet() {
    return q('.mpe-ra-module');
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

  async function selectWords(id, needle) {
    const node = Array.from(doc.getElementById(id).childNodes).find(
      (child) => child.nodeType === 3 && child.data.includes(needle),
    );
    assert.ok(node, `a text node with "${needle}" in #${id}`);
    const at = node.data.indexOf(needle);
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

  function prepared(overrides) {
    const prepare = lastMessage('readAloudClassroomPrepare');
    assert.ok(prepare, 'a prepare was posted; logs: ' + logs.join('\n'));
    host(
      Object.assign(
        {
          command: 'readAloudClassroomPrepared',
          requestId: prepare.args[1],
          persona: {
            id: 'max',
            name: 'Max',
            tagline: 'A patient practitioner',
          },
          personas: [
            { id: 'max', name: 'Max', tagline: 'A patient practitioner' },
            { id: 'ada', name: 'Ada', tagline: 'Diagrams first' },
          ],
          audience: 'a professionally motivated reader',
          documentWords: 14000,
          linked: [
            {
              path: 'featrues/04-help-module.md',
              title: '04 — Help',
              words: 6100,
            },
            {
              path: 'featrues/12-notes/spec.md',
              title: '12 — Notes',
              words: 9000,
            },
          ],
          modules: [
            {
              id: '20260905T170000Z-aaaa',
              title: 'An Earlier Module',
              created: '2026-09-05T17:00:00Z',
              status: 'done',
              chapters: 6,
              done: 6,
              minutes: 20,
            },
          ],
          engine: { engine: 'claude', model: 'sonnet', effort: 'medium' },
          building: null,
        },
        overrides || {},
      ),
    );
    return prepare;
  }

  function progress(overrides) {
    host(
      Object.assign(
        {
          command: 'readAloudClassroomProgress',
          moduleId: MODULE_ID,
          documentUri: SOURCE_URI,
          moduleUri: MODULE_URI,
          status: 'writing',
          title: 'Approvals, Gates, and Borrowed Keys',
          chapter: 1,
          of: 6,
          chapterTitle: CHAPTERS[0],
          chapters: chapterStates(0, 0),
          elapsedMs: 1000,
          words: 0,
          queuePosition: 0,
          error: null,
          hasChapter: false,
        },
        overrides || {},
      ),
    );
  }

  async function openSheet() {
    await selectWords('p1', 'the figure that appears most often');
    click(q('.mpe-ra-float-classroom'));
    assert.ok(sheet() && !sheet().hidden, 'the sheet is open');
  }

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

  test('the cluster has a fourth button that follows classroomAvailable and the help predicate', async function () {
    boot();
    await sleep(60);
    enable({ classroomAvailable: false });
    await selectWords('p1', 'the figure that appears most often');
    const float = q('.mpe-ra-float');
    assert.ok(float && !float.hidden, 'the cluster is up');
    const buttons = qa('.mpe-ra-float > .mpe-ra-float-btn').map(
      (b) => b.className,
    );
    // 15 §5.1 adds Retell as the fifth; Classroom is still the fourth.
    assert.strictEqual(buttons.length, 5);
    assert.ok(buttons[3].includes('mpe-ra-float-classroom'), 'after Note');
    assert.strictEqual(
      q('.mpe-ra-float-classroom').hidden,
      true,
      'hidden without classroom',
    );
    enable();
    assert.strictEqual(q('.mpe-ra-float-classroom').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-float-classroom').getAttribute('title'),
      'Teach me this (Alt+C)',
    );
    assert.strictEqual(
      q('.mpe-ra-float-classroom').getAttribute('aria-haspopup'),
      'dialog',
    );
    assert.strictEqual(q('.mpe-ra-float-note').hidden, false, 'Note stays');
    enable({ notesAvailable: false });
    assert.strictEqual(
      q('.mpe-ra-float-classroom').hidden,
      false,
      'notes=0 keeps Classroom',
    );
    enable();
    await clearSelection();
  });

  test('Alt+C with nothing to teach shows the hint; with a selection it opens the sheet and posts Prepare', async function () {
    boot();
    await sleep(60);
    enable();
    control('classroom');
    const hint = q('.mpe-ra-hint');
    assert.ok(hint && !hint.hidden);
    assert.strictEqual(hint.textContent, 'Select text to open a classroom');
    assert.strictEqual(sheet().hidden, true);
    await selectWords('p1', 'the figure that appears most often');
    control('classroom');
    assert.strictEqual(sheet().hidden, false);
    assert.strictEqual(sheet().getAttribute('role'), 'dialog');
    assert.strictEqual(sheet().getAttribute('aria-label'), 'Classroom');
    const prepare = lastMessage('readAloudClassroomPrepare');
    assert.ok(prepare);
    assert.strictEqual(prepare.args[0], SOURCE_URI);
    assert.match(prepare.args[1], /^ra-/);
    assert.strictEqual(prepare.args[2].contextMode, 'document');
    assert.deepStrictEqual(plain(prepare.args[2].breadcrumb), [
      'Reading on a screen',
      'The measure',
    ]);
    assert.ok(
      prepare.args[2].enclosing.includes(
        '⟦the figure that appears most often⟧',
      ),
    );
    // Preparing: the chip, the quote under its path, Build disabled.
    assert.strictEqual(
      q('.mpe-ra-classroom-details').textContent,
      'Preparing…',
    );
    assert.strictEqual(
      q('.mpe-ra-classroom-path').textContent,
      'Reading on a screen › The measure',
    );
    assert.strictEqual(
      q('.mpe-ra-classroom-quote').textContent,
      'the figure that appears most often',
    );
    assert.strictEqual(action('classroomBuild').disabled, true);
    assert.strictEqual(
      action('classroomBuild').getAttribute('title'),
      'Preparing',
    );
    // The lever's second row is preselected.
    const rows = qa('.mpe-ra-lever-row');
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(
      rows.map((r) => r.getAttribute('aria-checked')),
      ['false', 'true', 'false'],
    );
    assert.strictEqual(rows[0].textContent, 'A few gaps: I follow most of it');
    assert.strictEqual(
      q('.mpe-ra-classroom-lever').getAttribute('role'),
      'radiogroup',
    );
    assert.strictEqual(
      q('.mpe-ra-classroom-note').getAttribute('maxlength'),
      '500',
    );
    assert.strictEqual(
      q('.mpe-ra-classroom-note').placeholder,
      'In your own words, what is confusing? Optional.',
    );
    // Alt+C again closes it.
    control('classroom');
    assert.strictEqual(sheet().hidden, true);
    await clearSelection();
  });

  // ------------------------------------------------------ §5.2–§5.3 Ready

  test('Prepared fills the sheet: the chip, the select, the audience, the ticked links, the module rows', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    assert.strictEqual(
      q('.mpe-ra-classroom-details').textContent,
      'This document · 14,000 words',
    );
    assert.strictEqual(action('classroomBuild').disabled, false);
    const select = q('.mpe-ra-classroom-persona-select');
    assert.deepStrictEqual(
      Array.from(select.options).map((o) => [
        o.value,
        o.textContent,
        o.selected,
      ]),
      [
        ['max', 'Max', true],
        ['ada', 'Ada', false],
      ],
    );
    assert.strictEqual(
      select.options[1].getAttribute('title'),
      'Diagrams first',
    );
    assert.strictEqual(
      q('.mpe-ra-classroom-audience-input').value,
      'a professionally motivated reader',
    );
    assert.strictEqual(
      q('.mpe-ra-classroom-audience-input').getAttribute('maxlength'),
      '300',
    );
    assert.strictEqual(
      q('.mpe-ra-classroom-engine').textContent,
      'claude · sonnet · medium',
    );
    assert.strictEqual(
      q('.mpe-ra-classroom-sending-line').textContent,
      'Sends this document (14,000 words) and 2 linked documents to claude',
    );
    const boxes = qa('.mpe-ra-classroom-link-box');
    assert.strictEqual(boxes.length, 2);
    assert.ok(
      boxes.every((b) => b.checked),
      'all ticked',
    );
    assert.ok(
      qa('.mpe-ra-classroom-link-text')[0].textContent.includes(
        '04 — Help · featrues/04-help-module.md · 6,100 words',
      ),
    );
    assert.strictEqual(q('.mpe-ra-classroom-modules').hidden, false);
    const rows = qa('.mpe-ra-classroom-module-row');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(
      rows[0].querySelector('.mpe-ra-classroom-module-title').textContent,
      'An Earlier Module',
    );
    assert.ok(
      rows[0]
        .querySelector('.mpe-ra-classroom-module-meta')
        .textContent.includes('6 chapters'),
    );
    assert.strictEqual(
      rows[0].querySelector('.mpe-ra-classroom-status').textContent,
      'done',
    );
    click(action('classroomOpenModule', rows[0]));
    assert.deepStrictEqual(plain(lastMessage('readAloudClassroomOpen').args), [
      SOURCE_URI,
      '20260905T170000Z-aaaa',
    ]);
    // The engine label opens the model quick pick, as the help sheet's does.
    click(q('.mpe-ra-classroom-engine'));
    assert.ok(lastMessage('readAloudHelpChooseModel'));
    // A stale Prepared is dropped.
    const before = q('.mpe-ra-classroom-details').textContent;
    host({
      command: 'readAloudClassroomPrepared',
      requestId: 'ra-stale',
      documentWords: 1,
      personas: [],
      linked: [],
      modules: [],
    });
    assert.strictEqual(q('.mpe-ra-classroom-details').textContent, before);
    click(action('classroomClose'));
    await clearSelection();
  });

  // ----------------------------------------------------------- §5.4 Build

  test('Build posts the payload: level, the sentence, the persona, the audience, the ticked links, the heading id', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    click(qa('.mpe-ra-lever-row')[2]);
    assert.deepStrictEqual(
      qa('.mpe-ra-lever-row').map((r) => r.getAttribute('aria-checked')),
      ['false', 'false', 'true'],
    );
    const note = q('.mpe-ra-classroom-note');
    note.value = 'x'.repeat(600);
    note.dispatchEvent(new win.Event('input', { bubbles: true }));
    const select = q('.mpe-ra-classroom-persona-select');
    select.value = 'ada';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
    const audience = q('.mpe-ra-classroom-audience-input');
    audience.value = 'a lawyer';
    audience.dispatchEvent(new win.Event('input', { bubbles: true }));
    const boxes = qa('.mpe-ra-classroom-link-box');
    boxes[1].checked = false;
    boxes[1].dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.strictEqual(
      q('.mpe-ra-classroom-sending-line').textContent,
      'Sends this document (14,000 words) and 1 linked document to claude',
    );
    click(action('classroomBuild'));
    const build = lastMessage('readAloudClassroomBuild');
    assert.ok(build, 'a build was posted');
    const [uri, requestId, passage, fields, anchor, options] = build.args;
    assert.strictEqual(uri, SOURCE_URI);
    assert.match(requestId, /^ra-/);
    assert.strictEqual(passage, 'the figure that appears most often');
    assert.strictEqual(fields.contextMode, 'document');
    assert.strictEqual(fields.title, 'Reading on a screen');
    assert.strictEqual(anchor.exact, 'the figure that appears most often');
    assert.match(anchor.block, /^b[0-9a-f]{1,8}$/);
    assert.deepStrictEqual(plain(options), {
      level: 3,
      readerNote: 'x'.repeat(500),
      persona: 'ada',
      audience: 'a lawyer',
      linked: ['featrues/04-help-module.md'],
      headingId: 'the-measure',
    });
    // Building: the form gives way to the card; Cancel is the footer.
    assert.strictEqual(q('.mpe-ra-classroom-form').hidden, true);
    assert.strictEqual(q('.mpe-ra-classroom-card').hidden, false);
    assert.strictEqual(action('classroomBuild').hidden, true);
    await clearSelection();
  });

  test('Progress drives the card: planning, writing with rows and elapsed, Open after a chapter, Done', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    click(action('classroomBuild'));
    progress({
      status: 'planning',
      chapter: 0,
      of: 0,
      chapterTitle: '',
      chapters: [],
      title: 'Classroom: the figure that…',
    });
    assert.strictEqual(
      q('.mpe-ra-classroom-details').textContent,
      'Planning the module…',
    );
    assert.strictEqual(action('classroomCancel').hidden, false);
    assert.strictEqual(action('classroomOpen').hidden, true);
    progress({ status: 'writing', chapter: 1, chapters: chapterStates(0, 0) });
    assert.strictEqual(
      q('.mpe-ra-classroom-details').textContent,
      'Writing chapter 1 of 6',
    );
    assert.strictEqual(
      q('.mpe-ra-classroom-card-title').textContent,
      'Approvals, Gates, and Borrowed Keys',
    );
    const rows = qa('.mpe-ra-classroom-card .mpe-ra-chapter-row');
    assert.strictEqual(rows.length, 6);
    assert.deepStrictEqual(
      rows.map((r) => r.getAttribute('data-state')),
      ['writing', 'queued', 'queued', 'queued', 'queued', 'queued'],
    );
    assert.strictEqual(rows[0].textContent, '1. Module Introduction');
    assert.strictEqual(q('.mpe-ra-classroom-elapsed').hidden, false);
    assert.match(
      q('.mpe-ra-classroom-elapsed').textContent,
      /^\d+ s · Module Introduction$/,
    );
    progress({
      status: 'writing',
      chapter: 3,
      chapterTitle: CHAPTERS[2],
      chapters: chapterStates(2, 2),
      hasChapter: true,
      words: 1043,
    });
    assert.strictEqual(
      q('.mpe-ra-classroom-details').textContent,
      'Writing chapter 3 of 6',
    );
    assert.deepStrictEqual(
      qa('.mpe-ra-classroom-card .mpe-ra-chapter-row').map((r) =>
        r.getAttribute('data-state'),
      ),
      ['done', 'flagged', 'writing', 'queued', 'queued', 'queued'],
    );
    assert.ok(
      qa('.mpe-ra-classroom-card .mpe-ra-chapter-row')[1]
        .getAttribute('title')
        .includes('length-target'),
    );
    assert.strictEqual(
      action('classroomOpen').hidden,
      false,
      'Open once a chapter exists',
    );
    assert.strictEqual(action('classroomCancel').hidden, false);
    click(action('classroomOpen'));
    assert.deepStrictEqual(plain(lastMessage('readAloudClassroomOpen').args), [
      SOURCE_URI,
      MODULE_ID,
    ]);
    progress({
      status: 'done',
      chapter: 0,
      chapterTitle: '',
      chapters: chapterStates(6, -1),
      hasChapter: true,
      words: 3000,
    });
    assert.strictEqual(
      q('.mpe-ra-classroom-details').textContent,
      'Ready · 6 chapters · about 20 minutes',
    );
    assert.strictEqual(action('classroomCancel').hidden, true);
    assert.strictEqual(action('classroomOpen').hidden, false);
    assert.strictEqual(action('classroomAnother').hidden, false);
    assert.strictEqual(q('.mpe-ra-classroom-elapsed').hidden, true);
    click(action('classroomAnother'));
    assert.strictEqual(
      q('.mpe-ra-classroom-form').hidden,
      false,
      'back to Ready',
    );
    assert.strictEqual(action('classroomBuild').hidden, false);
    click(action('classroomClose'));
    await clearSelection();
  });

  test('Cancel posts the cancel; stopped shows Continue; failed shows the reason and Continue; Continue posts', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    click(action('classroomBuild'));
    progress({
      status: 'writing',
      chapter: 2,
      chapterTitle: CHAPTERS[1],
      chapters: chapterStates(1, 1),
      hasChapter: true,
    });
    click(action('classroomCancel'));
    assert.deepStrictEqual(
      plain(lastMessage('readAloudClassroomCancel').args),
      [SOURCE_URI, MODULE_ID, 'sheet'],
    );
    progress({
      status: 'stopped',
      chapter: 0,
      chapterTitle: '',
      chapters: chapterStates(2, -1),
      hasChapter: true,
    });
    assert.strictEqual(
      q('.mpe-ra-classroom-details').textContent,
      'Stopped after chapter 2',
    );
    assert.strictEqual(action('classroomContinue').hidden, false);
    assert.strictEqual(action('classroomOpen').hidden, false);
    assert.strictEqual(action('classroomCancel').hidden, true);
    click(action('classroomContinue'));
    assert.deepStrictEqual(
      plain(lastMessage('readAloudClassroomContinue').args),
      [SOURCE_URI, MODULE_ID],
    );
    progress({
      status: 'failed',
      chapter: 0,
      chapterTitle: '',
      chapters: chapterStates(2, -1).map((c, i) =>
        i === 2 ? { ...c, status: 'failed' } : c,
      ),
      hasChapter: true,
      error: 'claude exited with code 1',
    });
    assert.strictEqual(
      q('.mpe-ra-classroom-details').textContent,
      'Failed: claude exited with code 1',
    );
    assert.ok(q('.mpe-ra-classroom-details').classList.contains('is-error'));
    assert.strictEqual(q('.mpe-ra-classroom-error').hidden, false);
    assert.strictEqual(action('classroomContinue').hidden, false);
    assert.strictEqual(
      qa('.mpe-ra-chapter-row')[2].getAttribute('data-state'),
      'failed',
    );
    click(action('classroomClose'));
    await clearSelection();
  });

  test('Escape keeps the build; reopening shows the card from a Prepared that carries building', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    click(action('classroomBuild'));
    progress({
      status: 'writing',
      chapter: 2,
      chapterTitle: CHAPTERS[1],
      chapters: chapterStates(1, 1),
      hasChapter: true,
    });
    const cancels = messages('readAloudClassroomCancel').length;
    sheet().dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    assert.strictEqual(sheet().hidden, true);
    assert.strictEqual(
      messages('readAloudClassroomCancel').length,
      cancels,
      'no cancel',
    );
    await openSheet();
    prepared({
      building: {
        moduleId: MODULE_ID,
        documentUri: SOURCE_URI,
        moduleUri: MODULE_URI,
        status: 'writing',
        title: 'Approvals, Gates, and Borrowed Keys',
        chapter: 3,
        of: 6,
        chapterTitle: CHAPTERS[2],
        chapters: chapterStates(2, 2),
        elapsedMs: 40000,
        words: 1000,
        queuePosition: 0,
        error: null,
        hasChapter: true,
      },
    });
    assert.strictEqual(q('.mpe-ra-classroom-card').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-classroom-details').textContent,
      'Writing chapter 3 of 6',
    );
    // A queued build says so.
    progress({
      status: 'queued',
      chapter: 0,
      chapterTitle: '',
      chapters: [],
      queuePosition: 1,
    });
    assert.strictEqual(
      q('.mpe-ra-classroom-details').textContent,
      'Waiting: another module is being written',
    );
    assert.strictEqual(action('classroomCancel').hidden, false);
    click(action('classroomClose'));
    await clearSelection();
  });

  test('a Progress for another document, or another module of this one, does not take the card over', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    progress({ documentUri: 'file:///other.md', status: 'writing' });
    assert.strictEqual(
      q('.mpe-ra-classroom-form').hidden,
      false,
      'still Ready',
    );
    progress({ moduleId: '20260905T000000Z-0000', status: 'writing' });
    assert.strictEqual(q('.mpe-ra-classroom-form').hidden, false);
    click(action('classroomClose'));
    await clearSelection();
  });

  test('an error for the request shows in the Error state with Retry and Build another', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    click(action('classroomBuild'));
    const build = lastMessage('readAloudClassroomBuild');
    host({
      command: 'readAloudClassroomError',
      requestId: build.args[1],
      message: 'Could not write the module file: EACCES',
      retryable: false,
    });
    assert.strictEqual(
      q('.mpe-ra-classroom-details').textContent,
      'Could not write the module file: EACCES',
    );
    assert.strictEqual(action('classroomRetry').hidden, false);
    assert.strictEqual(action('classroomAnother').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-classroom-error').textContent,
      'Could not write the module file: EACCES',
    );
    click(action('classroomRetry'));
    assert.strictEqual(
      messages('readAloudClassroomBuild').length,
      2,
      'Retry is a fresh Build with the same choices',
    );
    click(action('classroomClose'));
    await clearSelection();
  });

  // ------------------------------------------------------ §5.5 Teach me this

  test('Teach me this closes Help and opens Classroom with the help passage and the last typed question', async function () {
    boot();
    await sleep(60);
    enable();
    await selectWords('p2', 'a sample passage');
    click(q('.mpe-ra-bar-help'));
    const request = lastMessage('readAloudHelp');
    host({
      command: 'readAloudHelpResult',
      requestId: request.args[1],
      html: ANSWER_HTML,
      markdown: ANSWER_MARKDOWN,
      engine: 'claude',
      model: 'sonnet',
      effort: 'low',
      cached: false,
      durationMs: 1,
    });
    const input = q('.mpe-ra-help-input');
    input.value = 'why measure it';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    click(action('helpAsk'));
    const question = lastMessage('readAloudHelp');
    host({
      command: 'readAloudHelpResult',
      requestId: question.args[1],
      html: ANSWER_HTML,
      markdown: ANSWER_MARKDOWN,
      engine: 'claude',
      model: 'sonnet',
      effort: 'low',
      cached: false,
      durationMs: 1,
    });
    const teach = action('helpTeach');
    assert.strictEqual(teach.hidden, false);
    click(teach);
    assert.strictEqual(q('.mpe-ra-help').hidden, true);
    assert.strictEqual(sheet().hidden, false);
    assert.strictEqual(
      q('.mpe-ra-classroom-quote').textContent,
      'a sample passage',
    );
    assert.strictEqual(q('.mpe-ra-classroom-note').value, 'why measure it');
    const prepare = lastMessage('readAloudClassroomPrepare');
    assert.strictEqual(prepare.args[2].enclosing, request.args[3].enclosing);
    prepared();
    click(action('classroomBuild'));
    const build = lastMessage('readAloudClassroomBuild');
    assert.strictEqual(build.args[2], 'a sample passage');
    assert.strictEqual(build.args[5].readerNote, 'why measure it');
    assert.match(build.args[4].block, /^b[0-9a-f]{1,8}$/, "help's anchor");
    click(action('classroomClose'));
    await clearSelection();
  });

  // ------------------------------------------------- §4 one sheet at a time

  test('opening Classroom closes help, note and list sheets; each of those closes Classroom', async function () {
    boot();
    await sleep(60);
    enable();
    await selectWords('p2', 'a sample passage');
    click(q('.mpe-ra-bar-help'));
    assert.strictEqual(q('.mpe-ra-help').hidden, false);
    await selectWords('p1', 'the figure that appears most often');
    control('classroom');
    assert.strictEqual(q('.mpe-ra-help').hidden, true);
    assert.strictEqual(sheet().hidden, false);
    control('notesList');
    assert.strictEqual(sheet().hidden, true);
    assert.strictEqual(q('.mpe-ra-notes-list').hidden, false);
    await selectWords('p1', 'the figure that appears most often');
    control('classroom');
    assert.strictEqual(q('.mpe-ra-notes-list').hidden, true);
    assert.strictEqual(sheet().hidden, false);
    await selectWords('p2', 'a sample passage');
    click(q('.mpe-ra-bar-help'));
    assert.strictEqual(sheet().hidden, true);
    assert.strictEqual(q('.mpe-ra-help').hidden, false);
    click(action('helpClose'));
    // The selection cluster is not offered over an open Classroom sheet.
    await selectWords('p1', 'the figure that appears most often');
    control('classroom');
    await selectWords('p2', 'a sample passage');
    assert.strictEqual(
      q('.mpe-ra-float').hidden,
      true,
      'no cluster over the sheet',
    );
    click(action('classroomClose'));
    await clearSelection();
  });

  // --------------------------------------------- §12.2 the module preview

  test('a module preview: the bar button with its badge, the message line and the Module sheet', async function () {
    boot();
    await sleep(60);
    enable({
      classroomModule: {
        id: MODULE_ID,
        title: 'Approvals, Gates, and Borrowed Keys',
        status: 'writing',
        chapters: chapterStates(2, 2),
        documentTitle: 'Module 1: The Governed Harness',
        documentPath: 'test-file.md',
        documentHeading: 'The Governed Path: From Issue to Merge',
      },
    });
    const button = q('.mpe-ra-bar-classroom');
    assert.strictEqual(button.hidden, false);
    assert.strictEqual(
      button.getAttribute('title'),
      'This module (Alt+Shift+C)',
    );
    const badge = q('.mpe-ra-bar-classroom-badge');
    assert.strictEqual(badge.hidden, false);
    assert.strictEqual(badge.textContent, '3/6');
    // The bar order: help, notes, classroom, retell (15 §12.2), close.
    const order = qa('.mpe-ra-bar > .mpe-ra-bar-btn').map((b) =>
      b.getAttribute('data-mpe-ra-action'),
    );
    assert.deepStrictEqual(order.slice(-5), [
      'help',
      'notes',
      'classroomModule',
      'retellEdition',
      'close',
    ]);
    // Alt+Shift+C opens the Module sheet.
    control('classroomModule');
    assert.strictEqual(moduleSheet().hidden, false);
    assert.strictEqual(moduleSheet().getAttribute('aria-label'), 'This module');
    assert.ok(button.classList.contains('is-active'));
    assert.strictEqual(
      q('.mpe-ra-module-details').textContent,
      'Writing chapter 3 of 6',
    );
    assert.strictEqual(
      q('.mpe-ra-module-from').textContent,
      'From "Module 1: The Governed Harness", under "The Governed Path: From Issue to Merge"',
    );
    const rows = qa('.mpe-ra-module-rows .mpe-ra-chapter-row');
    assert.strictEqual(rows.length, 6);
    assert.deepStrictEqual(
      rows.map((r) => r.getAttribute('data-state')),
      ['done', 'flagged', 'writing', 'queued', 'queued', 'queued'],
    );
    assert.strictEqual(action('moduleCancel').hidden, false);
    assert.strictEqual(action('moduleContinue').hidden, true);
    click(action('moduleCancel'));
    assert.deepStrictEqual(
      plain(lastMessage('readAloudClassroomCancel').args),
      [SOURCE_URI, MODULE_ID, 'module sheet'],
    );
    click(action('moduleOpenSource'));
    assert.deepStrictEqual(
      plain(lastMessage('readAloudClassroomOpenSource').args),
      [SOURCE_URI, MODULE_ID],
    );
    click(action('moduleOpenFolder'));
    assert.deepStrictEqual(
      plain(lastMessage('readAloudClassroomOpenFolder').args),
      [SOURCE_URI],
    );
    // Progress for this module: the badge, the rows and the message line.
    progress({
      documentUri: 'file:///source.md',
      status: 'writing',
      chapter: 4,
      chapterTitle: CHAPTERS[3],
      chapters: chapterStates(3, 3),
      hasChapter: true,
    });
    assert.strictEqual(badge.textContent, '4/6');
    assert.strictEqual(
      q('.mpe-ra-bar-status').textContent,
      'Chapter 4 of 6 is being written',
    );
    assert.strictEqual(
      q('.mpe-ra-module-details').textContent,
      'Writing chapter 4 of 6',
    );
    progress({
      documentUri: 'file:///source.md',
      status: 'stopped',
      chapter: 0,
      chapterTitle: '',
      chapters: chapterStates(4, -1),
      hasChapter: true,
    });
    assert.ok(badge.classList.contains('is-warning'));
    assert.ok(badge.querySelector('svg'), 'the warning glyph');
    assert.strictEqual(
      q('.mpe-ra-bar-status').textContent,
      'Stopped after chapter 4 · Continue in the module sheet',
    );
    assert.strictEqual(action('moduleContinue').hidden, false);
    assert.strictEqual(action('moduleCancel').hidden, true);
    click(action('moduleContinue'));
    assert.deepStrictEqual(
      plain(lastMessage('readAloudClassroomContinue').args),
      [SOURCE_URI, MODULE_ID],
    );
    progress({
      documentUri: 'file:///source.md',
      status: 'done',
      chapter: 0,
      chapterTitle: '',
      chapters: chapterStates(6, -1),
      hasChapter: true,
      words: 3000,
    });
    assert.strictEqual(badge.hidden, true, 'no badge when done');
    assert.strictEqual(
      q('.mpe-ra-module-details').textContent,
      'Ready · 6 chapters · about 20 minutes',
    );
    // Escape closes the Module sheet and returns focus to the button.
    moduleSheet().dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    assert.strictEqual(moduleSheet().hidden, true);
    assert.strictEqual(doc.activeElement, button);
    // A broadcast config without the field leaves the module alone; null clears it.
    enable();
    assert.strictEqual(button.hidden, false, 'still a module preview');
    enable({ classroomModule: null });
    assert.strictEqual(button.hidden, true);
  });

  test('Alt+Shift+C elsewhere shows the chip; a done module shows no badge from the config', async function () {
    boot();
    await sleep(60);
    enable();
    control('classroomModule');
    assert.strictEqual(
      q('.mpe-ra-hint').textContent,
      'This preview is not a classroom module',
    );
    assert.strictEqual(moduleSheet().hidden, true);
    enable({
      classroomModule: {
        id: MODULE_ID,
        title: 'Done Module',
        status: 'done',
        chapters: chapterStates(6, -1),
        documentTitle: 'Doc',
        documentPath: 'doc.md',
      },
    });
    assert.strictEqual(q('.mpe-ra-bar-classroom').hidden, false);
    assert.strictEqual(q('.mpe-ra-bar-classroom-badge').hidden, true);
    enable({
      classroomModule: {
        id: MODULE_ID,
        title: 'Stopped Module',
        status: 'stopped',
        chapters: chapterStates(2, -1),
        documentTitle: 'Doc',
        documentPath: 'doc.md',
      },
    });
    assert.ok(
      q('.mpe-ra-bar-classroom-badge').classList.contains('is-warning'),
    );
    control('classroomModule');
    assert.strictEqual(
      q('.mpe-ra-module-details').textContent,
      'Stopped after chapter 2',
    );
    assert.strictEqual(action('moduleContinue').hidden, false);
  });

  // ------------------------------------------------- §12.4 revealAnchor

  test('revealAnchor flashes the anchored block; an anchor that cannot be found shows the chip', async function () {
    boot();
    await sleep(60);
    enable();
    const range = await selectWords('p1', 'sixty-six is the figure');
    const c = win.MpeReadAloudCore;
    const root = q(c.ROOT_SELECTOR);
    const resolved = c.resolveSelection(win.getSelection(), root);
    assert.ok(resolved.ok, resolved.reason);
    const anchor = c.noteAnchorFor(resolved, root, range);
    await clearSelection();
    control('revealAnchor', { anchor, moduleId: MODULE_ID });
    const p1 = doc.getElementById('p1');
    assert.ok(p1.classList.contains('mpe-ra-flash'), 'flashed');
    await sleep(1100);
    assert.ok(!p1.classList.contains('mpe-ra-flash'), 'for a second');
    control('revealAnchor', {
      anchor: {
        block: 'bdeadbeef',
        line: 99,
        exact: 'words that are nowhere in this document',
        prefix: '',
        suffix: '',
        offset: 0,
        blocks: 1,
      },
      moduleId: MODULE_ID,
    });
    assert.strictEqual(q('.mpe-ra-note-chip').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-note-chip-text').textContent,
      'The passage is not in this version of the document',
    );
  });

  // ----------------------------------------------------------- the CSS

  test('[hidden] resolves to display none for every new element (the 09 lesson)', function () {
    for (const selector of [
      '.mpe-ra-classroom[hidden]',
      '.mpe-ra-module[hidden]',
      '.mpe-ra-classroom-form[hidden]',
      '.mpe-ra-classroom-card[hidden]',
      '.mpe-ra-classroom-modules[hidden]',
      '.mpe-ra-classroom-sending[hidden]',
      '.mpe-ra-classroom-error[hidden]',
      '.mpe-ra-classroom-elapsed[hidden]',
      '.mpe-ra-classroom-path[hidden]',
      '.mpe-ra-classroom-link[hidden]',
      '.mpe-ra-chapter-row[hidden]',
      '.mpe-ra-module-from[hidden]',
      '.mpe-ra-bar .mpe-ra-bar-classroom[hidden]',
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
    assert.ok(
      /\.mpe-ra-float \{[^}]*flex-wrap: wrap/.test(CSS),
      'the cluster wraps rather than shrinks',
    );
    assert.ok(
      /prefers-reduced-motion: reduce\)\s*\{[^}]*\.mpe-ra-chapter-row\[data-state='writing'\]/.test(
        CSS,
      ),
      'the card is static under reduced motion',
    );
  });
});
