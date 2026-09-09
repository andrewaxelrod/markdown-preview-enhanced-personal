/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// Retell (`featrues/15-convert-readable/spec.md` §17) — the retell layer of
// media/read-aloud.js under jsdom with fake <audio> elements: the fifth
// cluster button and its predicate, `Alt+T` with a selection, with a caret
// only and with neither, the Prepare on open with the two one-based line
// numbers, the whole-document scope, the states from `Prepared` and
// `Progress` messages, the section rows and their word lines, the widened
// line, the estimate, Rebuild, the Build payload, Cancel and Open, Escape
// keeping the build, `Retell the section` on the help sheet, the edition
// preview's bar button, badge and Edition sheet, the message line,
// `revealAnchor` with an edition id, one sheet at a time, and the `[hidden]`
// display rules.

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

// `p0` carries no source line and nothing before it does either (§6.1's
// refusal); every other block has crossnote's one-based `data-source-line`.
const FIXTURE =
  '<p id="p0">An unlined preface paragraph the source does not carry.</p>' +
  '<h1 id="h1" data-source-line="1">Reading on a screen</h1>' +
  '<h2 id="the-measure" data-source-line="3">The measure</h2>' +
  `<p id="p1" data-source-line="5">${P1}</p>` +
  `<p id="p2" data-source-line="7">${P2}</p>` +
  '<pre id="code"><code>not prose</code></pre>' +
  '<p id="p4" data-source-line="23">A closing paragraph with nothing in common with the others.</p>';

const SOURCE_URI = 'file:///doc.md';
const EDITION_ID = '20260907T104512Z-9a3f';
const EDITION_URI =
  'file:///home/x/.crossnote/retell/editions/ws/doc.md/20260907T104512Z-9a3f-7-specs-adrs.md';
const PREVIEW =
  '<!doctype html><html><body class="preview-container">' +
  `<div id="crossnote-data" data-config='{"sourceUri":"${SOURCE_URI}"}'></div>` +
  '<div class="crossnote markdown-preview" data-for="preview">' +
  FIXTURE +
  '</div></body></html>';

const ANSWER_HTML =
  '<h3>What it says</h3><p>The measure is the line length.</p>';
const ANSWER_MARKDOWN = '### What it says\nThe measure is the line length.';

/** Section 7's real counts (§7.2), then two smaller units. */
const UNITS = [
  {
    n: 1,
    heading: '7. Specs, ADRs, constitution',
    level: 2,
    line: 208,
    endLine: 377,
    words: 1246,
    codeWords: 349,
    tableWords: 242,
    proseWords: 655,
    tables: 3,
    fences: 7,
  },
  {
    n: 2,
    heading: '3. What goes where',
    level: 2,
    line: 60,
    endLine: 80,
    words: 304,
    codeWords: 0,
    tableWords: 290,
    proseWords: 14,
    tables: 1,
    fences: 0,
  },
  {
    n: 3,
    heading: '9. Enforcement ladder',
    level: 2,
    line: 420,
    endLine: 500,
    words: 426,
    codeWords: 200,
    tableWords: 0,
    proseWords: 226,
    tables: 0,
    fences: 5,
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A posted payload as plain data: the jsdom realm's Array and Object differ from Node's. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function sectionStates(done, writing, extra) {
  return UNITS.map((unit, i) =>
    Object.assign(
      {
        n: i + 1,
        heading: unit.heading,
        status: i < done ? 'done' : i === writing ? 'writing' : 'queued',
        flagged: i === 1 && i < done ? ['sentence-length'] : [],
        cached: false,
      },
      extra && extra[i] ? extra[i] : {},
    ),
  );
}

function manySections(done, writing, total) {
  const out = [];
  for (let i = 0; i < total; i++) {
    out.push({
      n: i + 1,
      heading: 'Section ' + (i + 1),
      status: i < done ? 'done' : i === writing ? 'writing' : 'queued',
      flagged: [],
      cached: false,
    });
  }
  return out;
}

suite('read-aloud retell layer (15-convert-readable)', function () {
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
          classroomMarker: true,
          retellAvailable: true,
          retellMarker: true,
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
    return q('.mpe-ra-retell');
  }

  function editionSheet() {
    return q('.mpe-ra-edition');
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

  /** A caret inside `#id`: a collapsed selection, no cluster (§6.1). */
  async function placeCaret(id, offset) {
    const node = Array.from(doc.getElementById(id).childNodes).find(
      (child) => child.nodeType === 3,
    );
    const range = doc.createRange();
    range.setStart(node, offset || 3);
    range.collapse(true);
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

  function prepared(overrides) {
    const prepare = lastMessage('readAloudRetellPrepare');
    assert.ok(prepare, 'a prepare was posted; logs: ' + logs.join('\n'));
    host(
      Object.assign(
        {
          command: 'readAloudRetellPrepared',
          requestId: prepare.args[1],
          units: [UNITS[0]],
          sourceWords: 1246,
          estimate: { words: 1740, minutes: 12 },
          ceiling: 2243,
          widened: false,
          shape: 'full',
          engine: { engine: 'claude', model: 'sonnet', effort: 'low' },
          editions: [],
          rebuildOf: null,
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
          command: 'readAloudRetellProgress',
          editionId: EDITION_ID,
          documentUri: SOURCE_URI,
          editionUri: EDITION_URI,
          status: 'writing',
          title: '"7. Specs, ADRs, constitution": the spoken edition',
          section: 1,
          of: 3,
          sectionHeading: UNITS[0].heading,
          sections: sectionStates(0, 0),
          elapsedMs: 1000,
          words: 0,
          queuePosition: 0,
          hasSection: false,
          error: null,
        },
        overrides || {},
      ),
    );
  }

  function editionSummary(overrides) {
    return Object.assign(
      {
        id: EDITION_ID,
        title: '"7. Specs, ADRs, constitution": the spoken edition',
        created: '2026-09-07T10:45:12Z',
        status: 'done',
        sections: 18,
        done: 7,
        minutes: 12,
        anchors: [
          {
            exact: 'The measure',
            block: '',
            line: 3,
            prefix: '',
            suffix: '',
            offset: 0,
            blocks: 1,
          },
        ],
        headings: ['Reading on a screen'],
        documentTitle: 'Reading on a screen',
        unitHeadings: ['The measure'],
      },
      overrides || {},
    );
  }

  async function openSheet() {
    await selectWords('p1', 'the figure that appears most often');
    click(q('.mpe-ra-float-retell'));
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

  test('the cluster has a fifth button that follows retellAvailable and the help predicate', async function () {
    boot();
    await sleep(60);
    enable({ retellAvailable: false });
    await selectWords('p1', 'the figure that appears most often');
    const float = q('.mpe-ra-float');
    assert.ok(float && !float.hidden, 'the cluster is up');
    const buttons = qa('.mpe-ra-float > .mpe-ra-float-btn').map(
      (b) => b.className,
    );
    assert.strictEqual(buttons.length, 5);
    assert.ok(buttons[4].includes('mpe-ra-float-retell'), 'after Classroom');
    assert.strictEqual(
      q('.mpe-ra-float-retell').hidden,
      true,
      'hidden without retell',
    );
    enable();
    assert.strictEqual(q('.mpe-ra-float-retell').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-float-retell').getAttribute('title'),
      'Retell this for listening (Alt+T)',
    );
    assert.strictEqual(
      q('.mpe-ra-float-retell').getAttribute('aria-label'),
      'Retell this for listening (Alt+T)',
    );
    assert.strictEqual(
      q('.mpe-ra-float-retell').getAttribute('aria-haspopup'),
      'dialog',
    );
    assert.ok(q('.mpe-ra-float-retell').querySelector('svg'), 'the ear glyph');
    assert.strictEqual(
      q('.mpe-ra-float-classroom').hidden,
      false,
      'Classroom stays',
    );
    enable({ classroomAvailable: false, notesAvailable: false });
    assert.strictEqual(
      q('.mpe-ra-float-retell').hidden,
      false,
      'the others off keeps Retell',
    );
    enable();
    await clearSelection();
  });

  // ----------------------------------------------- §5.1, §6.1 Alt+T, Prepare

  test('Alt+T with neither a selection nor a caret shows the chip; with a selection it opens the sheet and posts Prepare with the two lines', async function () {
    boot();
    await sleep(60);
    enable();
    control('retell');
    const hint = q('.mpe-ra-hint');
    assert.ok(hint && !hint.hidden);
    assert.strictEqual(
      hint.textContent,
      'Put the cursor in a section, or select one',
    );
    assert.strictEqual(sheet().hidden, true);
    await selectWords('p1', 'the figure that appears most often');
    control('retell');
    assert.strictEqual(sheet().hidden, false);
    assert.strictEqual(sheet().getAttribute('role'), 'dialog');
    assert.strictEqual(sheet().getAttribute('aria-label'), 'Retell');
    assert.strictEqual(sheet().getAttribute('tabindex'), '-1');
    assert.ok(sheet().classList.contains('mpe-ra-ui'), 'chrome, never read');
    const prepare = lastMessage('readAloudRetellPrepare');
    assert.ok(prepare);
    assert.strictEqual(prepare.args.length, 4);
    assert.strictEqual(prepare.args[0], SOURCE_URI);
    assert.match(prepare.args[1], /^ra-/);
    assert.strictEqual(prepare.args[2].contextMode, 'section');
    assert.strictEqual(prepare.args[2].title, 'Reading on a screen');
    assert.deepStrictEqual(plain(prepare.args[2].breadcrumb), [
      'Reading on a screen',
      'The measure',
    ]);
    assert.deepStrictEqual(plain(prepare.args[3]), {
      startLine: 5,
      endLine: 5,
      scope: 'selection',
    });
    // Preparing: the chip, the skeleton rows, Build disabled.
    assert.strictEqual(q('.mpe-ra-retell-details').textContent, 'Preparing…');
    assert.strictEqual(action('retellBuild').disabled, true);
    assert.strictEqual(
      action('retellBuild').getAttribute('title'),
      'Preparing',
    );
    assert.strictEqual(action('retellRebuild').hidden, true);
    assert.strictEqual(
      q('.mpe-ra-retell-shape').textContent,
      'Full: the same content, in the same order, under the same headings.',
    );
    assert.strictEqual(q('.mpe-ra-retell-widened').hidden, true);
    assert.strictEqual(q('.mpe-ra-retell-estimate').hidden, true);
    assert.strictEqual(q('.mpe-ra-retell-sending').textContent, 'Preparing…');
    // Alt+T again closes it.
    control('retell');
    assert.strictEqual(sheet().hidden, true);
    await clearSelection();
  });

  test('a selection across two blocks sends the first and the last line; a caret alone sends its block; an unlined block is refused', async function () {
    boot();
    await sleep(60);
    enable();
    // Across p1 and p2 (the text nodes: the play button is the first child).
    const textOf = (id) =>
      Array.from(doc.getElementById(id).childNodes).find(
        (child) => child.nodeType === 3,
      );
    const start = textOf('p1');
    const end = textOf('p2');
    const range = doc.createRange();
    range.setStart(start, 4);
    range.setEnd(end, 20);
    const selection = win.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new win.Event('selectionchange'));
    await sleep(220);
    control('retell');
    assert.deepStrictEqual(
      plain(lastMessage('readAloudRetellPrepare').args[3]),
      {
        startLine: 5,
        endLine: 7,
        scope: 'selection',
      },
    );
    control('retell');
    await clearSelection();
    // A caret in p2: no cluster, but the block around it is offered.
    await placeCaret('p2', 10);
    assert.strictEqual(q('.mpe-ra-float').hidden, true, 'no cluster');
    control('retell');
    assert.strictEqual(sheet().hidden, false);
    const prepare = lastMessage('readAloudRetellPrepare');
    assert.deepStrictEqual(plain(prepare.args[3]), {
      startLine: 7,
      endLine: 7,
      scope: 'selection',
    });
    assert.deepStrictEqual(plain(prepare.args[2].breadcrumb), [
      'Reading on a screen',
      'The measure',
    ]);
    control('retell');
    await clearSelection();
    // A caret in the unlined preface: nothing before it carries a line.
    await placeCaret('p0', 3);
    const prepares = messages('readAloudRetellPrepare').length;
    control('retell');
    assert.strictEqual(sheet().hidden, true);
    assert.strictEqual(
      q('.mpe-ra-hint').textContent,
      "This block is not in the document's source",
    );
    assert.strictEqual(messages('readAloudRetellPrepare').length, prepares);
    await clearSelection();
  });

  test('the whole-document scope opens the sheet with no selection, posts lines 1/1, shows every row and builds with no anchor', async function () {
    boot();
    await sleep(60);
    enable();
    control('retell', { scope: 'document' });
    assert.strictEqual(sheet().hidden, false);
    const prepare = lastMessage('readAloudRetellPrepare');
    assert.deepStrictEqual(plain(prepare.args[3]), {
      startLine: 1,
      endLine: 1,
      scope: 'document',
    });
    assert.strictEqual(prepare.args[2].title, 'Reading on a screen');
    const units = [];
    for (let i = 0; i < 18; i++) {
      units.push(
        Object.assign({}, UNITS[i % 3], {
          n: i + 1,
          heading: 'Section ' + (i + 1),
        }),
      );
    }
    prepared({
      units,
      sourceWords: 4986,
      estimate: { words: 6980, minutes: 49 },
      ceiling: 8975,
    });
    assert.strictEqual(
      q('.mpe-ra-retell-details').textContent,
      '18 sections · 4,986 words',
    );
    assert.strictEqual(qa('.mpe-ra-retell-row').length, 6, 'the first six');
    assert.strictEqual(q('.mpe-ra-retell-more').hidden, false);
    assert.strictEqual(q('.mpe-ra-retell-more').textContent, 'and 12 more');
    assert.strictEqual(
      q('.mpe-ra-retell-sending').textContent,
      'Sends all 18 sections (4,986 words) to claude.',
    );
    assert.strictEqual(
      q('.mpe-ra-retell-estimate').textContent,
      'About 6,980 words · about 49 minutes',
    );
    click(action('retellBuild'));
    const build = lastMessage('readAloudRetellBuild');
    assert.ok(build, 'a build was posted');
    assert.strictEqual(build.args.length, 5);
    assert.strictEqual(build.args[3], null, 'no anchor in document scope');
    assert.deepStrictEqual(plain(build.args[4]), {
      startLine: 1,
      endLine: 1,
      scope: 'document',
      editionId: null,
    });
    click(action('retellClose'));
  });

  // ------------------------------------------------------ §5.2–§5.3 Ready

  test('Prepared fills the sheet: the chip, the row with its word line, the estimate, the engine, the sending line, the editions', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared({ editions: [editionSummary()] });
    assert.strictEqual(
      q('.mpe-ra-retell-details').textContent,
      '1 section · 1,246 words',
    );
    assert.strictEqual(action('retellBuild').disabled, false);
    assert.strictEqual(action('retellBuild').hidden, false);
    assert.strictEqual(
      action('retellBuild').getAttribute('title'),
      'Build the spoken edition',
    );
    const rows = qa('.mpe-ra-retell-row');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(
      rows[0].querySelector('.mpe-ra-retell-row-heading').textContent,
      '7. Specs, ADRs, constitution',
    );
    assert.strictEqual(
      rows[0].querySelector('.mpe-ra-retell-row-words').textContent,
      '1,246 words: 655 prose, 242 in 3 tables, 349 in 7 code blocks',
    );
    assert.strictEqual(q('.mpe-ra-retell-more').hidden, true);
    assert.strictEqual(q('.mpe-ra-retell-widened').hidden, true);
    assert.strictEqual(
      q('.mpe-ra-retell-estimate').textContent,
      'About 1,740 words · about 12 minutes',
    );
    assert.strictEqual(
      q('.mpe-ra-retell-estimate').getAttribute('title'),
      'the build retries once above 2,243 words',
    );
    assert.strictEqual(
      q('.mpe-ra-retell-engine').textContent,
      'claude · sonnet · low',
    );
    assert.strictEqual(
      q('.mpe-ra-retell-sending').textContent,
      'Sends 1 section of this document (1,246 words) to claude.',
    );
    assert.strictEqual(q('.mpe-ra-retell-editions').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-retell-editions-title').textContent,
      'Spoken editions of this document',
    );
    const editionRows = qa('.mpe-ra-retell-edition-row');
    assert.strictEqual(editionRows.length, 1);
    assert.strictEqual(
      editionRows[0].querySelector('.mpe-ra-retell-edition-title').textContent,
      '"7. Specs, ADRs, constitution": the spoken edition',
    );
    assert.ok(
      editionRows[0]
        .querySelector('.mpe-ra-retell-edition-meta')
        .textContent.includes('7/18 sections'),
    );
    assert.strictEqual(
      editionRows[0].querySelector('.mpe-ra-retell-status').textContent,
      'done',
    );
    click(action('retellOpenEdition', editionRows[0]));
    assert.deepStrictEqual(plain(lastMessage('readAloudRetellOpen').args), [
      SOURCE_URI,
      EDITION_ID,
    ]);
    // The engine label opens the model quick pick, as the help sheet's does.
    click(q('.mpe-ra-retell-engine'));
    assert.ok(lastMessage('readAloudHelpChooseModel'));
    // A stale Prepared is dropped.
    const before = q('.mpe-ra-retell-details').textContent;
    host({
      command: 'readAloudRetellPrepared',
      requestId: 'ra-stale',
      units: [],
      sourceWords: 1,
      estimate: { words: 10, minutes: 1 },
      ceiling: 2,
    });
    assert.strictEqual(q('.mpe-ra-retell-details').textContent, before);
    click(action('retellClose'));
    await clearSelection();
  });

  test('the word line names only the kinds a unit has; the widened line shows only when widened', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared({
      units: [
        UNITS[1],
        UNITS[2],
        Object.assign({}, UNITS[0], {
          n: 3,
          tables: undefined,
          fences: undefined,
        }),
      ],
      sourceWords: 1976,
      widened: true,
    });
    const lines = qa('.mpe-ra-retell-row-words').map((el) => el.textContent);
    assert.deepStrictEqual(lines, [
      '304 words: 14 prose, 290 in 1 table',
      '426 words: 226 prose, 200 in 5 code blocks',
      '1,246 words: 655 prose, 242 in tables, 349 in code blocks',
    ]);
    assert.strictEqual(q('.mpe-ra-retell-widened').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-retell-widened').textContent,
      'Your selection is part of this section; the whole section is retold.',
    );
    assert.strictEqual(
      q('.mpe-ra-retell-details').textContent,
      '3 sections · 1,976 words',
    );
    assert.strictEqual(
      q('.mpe-ra-retell-sending').textContent,
      'Sends 3 sections of this document (1,976 words) to claude.',
    );
    click(action('retellClose'));
    await clearSelection();
  });

  test('a Prepared with rebuildOf offers Rebuild and Build another; Rebuild carries the id, Build another does not', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared({ rebuildOf: EDITION_ID, editions: [editionSummary()] });
    assert.strictEqual(action('retellBuild').hidden, true);
    assert.strictEqual(action('retellRebuild').hidden, false);
    assert.strictEqual(action('retellRebuild').disabled, false);
    assert.strictEqual(action('retellAnother').hidden, false);
    click(action('retellRebuild'));
    const rebuild = lastMessage('readAloudRetellBuild');
    assert.strictEqual(rebuild.args[4].editionId, EDITION_ID);
    assert.strictEqual(rebuild.args[4].scope, 'selection');
    click(action('retellClose'));
    await clearSelection();
    await openSheet();
    prepared({ rebuildOf: EDITION_ID, editions: [editionSummary()] });
    click(action('retellAnother'));
    const another = lastMessage('readAloudRetellBuild');
    assert.notStrictEqual(another, rebuild);
    assert.strictEqual(another.args[4].editionId, null);
    assert.strictEqual(q('.mpe-ra-retell-card').hidden, false, 'building');
    click(action('retellClose'));
    await clearSelection();
  });

  // ----------------------------------------------------------- §5.4 Build

  test('Build posts the payload: the fields, the anchor, the lines, the scope and a null edition id', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    click(action('retellBuild'));
    const build = lastMessage('readAloudRetellBuild');
    assert.ok(build, 'a build was posted');
    const [uri, requestId, fields, anchor, options] = build.args;
    assert.strictEqual(uri, SOURCE_URI);
    assert.match(requestId, /^ra-/);
    assert.strictEqual(fields.contextMode, 'section');
    assert.strictEqual(fields.title, 'Reading on a screen');
    assert.strictEqual(anchor.exact, 'the figure that appears most often');
    assert.match(anchor.block, /^b[0-9a-f]{1,8}$/);
    assert.strictEqual(anchor.line, 5);
    assert.deepStrictEqual(plain(options), {
      startLine: 5,
      endLine: 5,
      scope: 'selection',
      editionId: null,
    });
    // Building: the form gives way to the card; Cancel is the footer.
    assert.strictEqual(q('.mpe-ra-retell-form').hidden, true);
    assert.strictEqual(q('.mpe-ra-retell-card').hidden, false);
    assert.strictEqual(action('retellBuild').hidden, true);
    assert.strictEqual(action('retellRebuild').hidden, true);
    await clearSelection();
  });

  test('Progress drives the card: starting, retelling with rows and elapsed, Open after a section, an unchanged row, Done, Build another', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    click(action('retellBuild'));
    progress({ status: 'planning', section: 0, sectionHeading: '' });
    assert.strictEqual(
      q('.mpe-ra-retell-details').textContent,
      'Starting the edition…',
    );
    assert.strictEqual(action('retellCancel').hidden, false);
    assert.strictEqual(action('retellOpen').hidden, true);
    progress({ status: 'writing', section: 1, sections: sectionStates(0, 0) });
    assert.strictEqual(
      q('.mpe-ra-retell-details').textContent,
      'Retelling section 1 of 3',
    );
    assert.strictEqual(
      q('.mpe-ra-retell-card-title').textContent,
      '"7. Specs, ADRs, constitution": the spoken edition',
    );
    const rows = qa('.mpe-ra-retell-card .mpe-ra-chapter-row');
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(
      rows.map((r) => r.getAttribute('data-state')),
      ['writing', 'queued', 'queued'],
    );
    assert.strictEqual(rows[0].textContent, '1. 7. Specs, ADRs, constitution');
    assert.strictEqual(q('.mpe-ra-retell-elapsed').hidden, false);
    assert.match(
      q('.mpe-ra-retell-elapsed').textContent,
      /^\d+ s · 7\. Specs, ADRs, constitution$/,
    );
    progress({
      status: 'writing',
      section: 3,
      sectionHeading: UNITS[2].heading,
      sections: sectionStates(2, 2, [null, null, null]).map((s, i) =>
        i === 0 ? Object.assign({}, s, { cached: true }) : s,
      ),
      hasSection: true,
      words: 1545,
    });
    assert.strictEqual(
      q('.mpe-ra-retell-details').textContent,
      'Retelling section 3 of 3',
    );
    const states = qa('.mpe-ra-retell-card .mpe-ra-chapter-row');
    assert.deepStrictEqual(
      states.map((r) => r.getAttribute('data-state')),
      ['cached', 'flagged', 'writing'],
    );
    assert.strictEqual(states[0].getAttribute('title'), 'unchanged');
    assert.ok(
      states[1].getAttribute('title').includes('sentence-length'),
      'the flagged codes are in the tooltip',
    );
    assert.strictEqual(
      action('retellOpen').hidden,
      false,
      'Open once a section exists',
    );
    click(action('retellOpen'));
    assert.deepStrictEqual(plain(lastMessage('readAloudRetellOpen').args), [
      SOURCE_URI,
      EDITION_ID,
    ]);
    progress({
      status: 'done',
      section: 0,
      sectionHeading: '',
      sections: sectionStates(3, -1),
      hasSection: true,
      words: 4544,
    });
    assert.strictEqual(
      q('.mpe-ra-retell-details').textContent,
      'Ready · 3 sections · about 32 minutes',
    );
    assert.strictEqual(action('retellCancel').hidden, true);
    assert.strictEqual(action('retellOpen').hidden, false);
    assert.strictEqual(action('retellAnother').hidden, false);
    assert.strictEqual(q('.mpe-ra-retell-elapsed').hidden, true);
    const prepares = messages('readAloudRetellPrepare').length;
    click(action('retellAnother'));
    assert.strictEqual(
      q('.mpe-ra-retell-form').hidden,
      false,
      'back to the form',
    );
    assert.strictEqual(
      messages('readAloudRetellPrepare').length,
      prepares + 1,
      'a fresh Prepare, so the rows and the editions are current',
    );
    assert.strictEqual(q('.mpe-ra-retell-details').textContent, 'Preparing…');
    click(action('retellClose'));
    await clearSelection();
  });

  test('Cancel posts the cancel; stopped shows Continue; failed shows the reason and Continue; Continue posts', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    click(action('retellBuild'));
    progress({
      status: 'writing',
      section: 2,
      sectionHeading: UNITS[1].heading,
      sections: sectionStates(1, 1),
      hasSection: true,
    });
    click(action('retellCancel'));
    assert.deepStrictEqual(plain(lastMessage('readAloudRetellCancel').args), [
      SOURCE_URI,
      EDITION_ID,
      'sheet',
    ]);
    progress({
      status: 'stopped',
      section: 0,
      sectionHeading: '',
      sections: sectionStates(2, -1),
      hasSection: true,
    });
    assert.strictEqual(
      q('.mpe-ra-retell-details').textContent,
      'Stopped after section 2',
    );
    assert.ok(q('.mpe-ra-retell-details').classList.contains('is-error'));
    assert.strictEqual(action('retellContinue').hidden, false);
    assert.strictEqual(action('retellOpen').hidden, false);
    assert.strictEqual(action('retellCancel').hidden, true);
    assert.strictEqual(action('retellAnother').hidden, false);
    click(action('retellContinue'));
    assert.deepStrictEqual(plain(lastMessage('readAloudRetellContinue').args), [
      SOURCE_URI,
      EDITION_ID,
    ]);
    progress({
      status: 'failed',
      section: 0,
      sectionHeading: '',
      sections: sectionStates(2, -1).map((c, i) =>
        i === 2 ? Object.assign({}, c, { status: 'failed' }) : c,
      ),
      hasSection: true,
      error: 'claude exited with code 1',
    });
    assert.strictEqual(
      q('.mpe-ra-retell-details').textContent,
      'Failed: claude exited with code 1',
    );
    assert.strictEqual(q('.mpe-ra-retell-error').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-retell-error').textContent,
      'Failed: claude exited with code 1',
    );
    assert.strictEqual(action('retellContinue').hidden, false);
    assert.strictEqual(
      qa('.mpe-ra-chapter-row')[2].getAttribute('data-state'),
      'failed',
    );
    click(action('retellClose'));
    await clearSelection();
  });

  test('Escape keeps the build; reopening shows the card from a Prepared that carries building; queued says so', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    click(action('retellBuild'));
    progress({
      status: 'writing',
      section: 2,
      sectionHeading: UNITS[1].heading,
      sections: sectionStates(1, 1),
      hasSection: true,
    });
    const cancels = messages('readAloudRetellCancel').length;
    sheet().dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    assert.strictEqual(sheet().hidden, true);
    assert.strictEqual(
      messages('readAloudRetellCancel').length,
      cancels,
      'no cancel',
    );
    await openSheet();
    prepared({
      building: {
        editionId: EDITION_ID,
        documentUri: SOURCE_URI,
        editionUri: EDITION_URI,
        status: 'writing',
        title: '"7. Specs, ADRs, constitution": the spoken edition',
        section: 3,
        of: 3,
        sectionHeading: UNITS[2].heading,
        sections: sectionStates(2, 2),
        elapsedMs: 40000,
        words: 2000,
        queuePosition: 0,
        hasSection: true,
        error: null,
      },
    });
    assert.strictEqual(q('.mpe-ra-retell-card').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-retell-details').textContent,
      'Retelling section 3 of 3',
    );
    progress({
      status: 'queued',
      section: 0,
      sectionHeading: '',
      sections: sectionStates(0, -1),
      queuePosition: 1,
    });
    assert.strictEqual(
      q('.mpe-ra-retell-details').textContent,
      'Waiting: another edition is being written',
    );
    assert.strictEqual(action('retellCancel').hidden, false);
    click(action('retellClose'));
    await clearSelection();
  });

  test('a Progress for another document, or another edition of this one, does not take the card over', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    progress({ documentUri: 'file:///other.md', status: 'writing' });
    assert.strictEqual(q('.mpe-ra-retell-form').hidden, false, 'still Ready');
    progress({ editionId: '20260907T000000Z-0000', status: 'writing' });
    assert.strictEqual(q('.mpe-ra-retell-form').hidden, false);
    click(action('retellClose'));
    await clearSelection();
  });

  test('an error for the request shows in the Error state with Retry and Build another; Retry is a fresh Build', async function () {
    boot();
    await sleep(60);
    enable();
    await openSheet();
    prepared();
    click(action('retellBuild'));
    const build = lastMessage('readAloudRetellBuild');
    host({
      command: 'readAloudRetellError',
      requestId: build.args[1],
      message: 'Could not write the edition file: EACCES',
      retryable: false,
    });
    assert.strictEqual(
      q('.mpe-ra-retell-details').textContent,
      'Could not write the edition file: EACCES',
    );
    assert.ok(q('.mpe-ra-retell-details').classList.contains('is-error'));
    assert.strictEqual(action('retellRetry').hidden, false);
    assert.strictEqual(action('retellAnother').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-retell-error').textContent,
      'Could not write the edition file: EACCES',
    );
    assert.strictEqual(
      q('.mpe-ra-bar-status').textContent,
      'Could not write the edition file: EACCES',
      "the panel's message line",
    );
    click(action('retellRetry'));
    assert.strictEqual(
      messages('readAloudRetellBuild').length,
      2,
      'Retry is a fresh Build with the same choices',
    );
    click(action('retellClose'));
    await clearSelection();
  });

  // ------------------------------------------------ §5.5 Retell the section

  test('Retell the section closes Help and opens Retell with the help passage, its material and its section', async function () {
    boot();
    await sleep(60);
    enable();
    await selectWords('p2', 'a sample passage');
    click(q('.mpe-ra-bar-help'));
    const request = lastMessage('readAloudHelp');
    assert.strictEqual(
      action('helpRetell').hidden,
      true,
      'nothing to retell before the answer',
    );
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
    const chip = action('helpRetell');
    assert.strictEqual(chip.hidden, false);
    assert.strictEqual(chip.textContent, 'Retell the section');
    const actions = qa('.mpe-ra-help-actions > button').map((b) =>
      b.getAttribute('data-mpe-ra-action'),
    );
    assert.ok(
      actions.indexOf('helpRetell') === actions.indexOf('helpTeach') + 1,
      'after Teach me this',
    );
    // The browser selection has collapsed by now: the sheet still knows the section.
    await clearSelection();
    click(chip);
    assert.strictEqual(q('.mpe-ra-help').hidden, true);
    assert.strictEqual(sheet().hidden, false);
    const prepare = lastMessage('readAloudRetellPrepare');
    assert.strictEqual(prepare.args[2].enclosing, request.args[3].enclosing);
    assert.deepStrictEqual(plain(prepare.args[3]), {
      startLine: 7,
      endLine: 7,
      scope: 'selection',
    });
    prepared();
    click(action('retellBuild'));
    const build = lastMessage('readAloudRetellBuild');
    assert.strictEqual(
      build.args[3].exact,
      'a sample passage',
      "help's anchor",
    );
    assert.match(build.args[3].block, /^b[0-9a-f]{1,8}$/);
    click(action('retellClose'));
    // With Retell off the chip is not offered.
    enable({ retellAvailable: false });
    await selectWords('p2', 'a sample passage');
    click(q('.mpe-ra-bar-help'));
    host({
      command: 'readAloudHelpResult',
      requestId: lastMessage('readAloudHelp').args[1],
      html: ANSWER_HTML,
      markdown: ANSWER_MARKDOWN,
      engine: 'claude',
      model: 'sonnet',
      effort: 'low',
      cached: false,
      durationMs: 1,
    });
    assert.strictEqual(action('helpRetell').hidden, true);
    click(action('helpClose'));
    await clearSelection();
  });

  // ------------------------------------------------- §4 one sheet at a time

  test('opening Retell closes the help, note, list, classroom and module sheets; each of those closes Retell', async function () {
    boot();
    await sleep(60);
    enable();
    await selectWords('p2', 'a sample passage');
    click(q('.mpe-ra-bar-help'));
    assert.strictEqual(q('.mpe-ra-help').hidden, false);
    await selectWords('p1', 'the figure that appears most often');
    control('retell');
    assert.strictEqual(q('.mpe-ra-help').hidden, true);
    assert.strictEqual(sheet().hidden, false);
    control('notesList');
    assert.strictEqual(sheet().hidden, true);
    assert.strictEqual(q('.mpe-ra-notes-list').hidden, false);
    await selectWords('p1', 'the figure that appears most often');
    control('retell');
    assert.strictEqual(q('.mpe-ra-notes-list').hidden, true);
    assert.strictEqual(sheet().hidden, false);
    await selectWords('p2', 'a sample passage');
    control('classroom');
    assert.strictEqual(sheet().hidden, true);
    assert.strictEqual(q('.mpe-ra-classroom').hidden, false);
    await selectWords('p1', 'the figure that appears most often');
    control('retell');
    assert.strictEqual(q('.mpe-ra-classroom').hidden, true);
    assert.strictEqual(sheet().hidden, false);
    await selectWords('p2', 'a sample passage');
    click(q('.mpe-ra-bar-help'));
    assert.strictEqual(sheet().hidden, true);
    assert.strictEqual(q('.mpe-ra-help').hidden, false);
    click(action('helpClose'));
    // The theme sheet's popover closes too.
    await selectWords('p1', 'the figure that appears most often');
    click(q('.mpe-ra-bar-theme'));
    assert.strictEqual(q('.mpe-ra-sheet').hidden, false);
    control('retell');
    assert.strictEqual(q('.mpe-ra-sheet').hidden, true);
    // The selection cluster is not offered over an open Retell sheet.
    await selectWords('p2', 'a sample passage');
    assert.strictEqual(q('.mpe-ra-float').hidden, true, 'no cluster');
    // The panel's × closes it.
    click(q('.mpe-ra-bar-close'));
    assert.strictEqual(sheet().hidden, true);
    await clearSelection();
  });

  // --------------------------------------------- §12.2 the edition preview

  test('an edition preview: the bar button with its badge, the Edition sheet, its rows and footer, the message line', async function () {
    boot();
    await sleep(60);
    enable({
      retellEdition: {
        id: EDITION_ID,
        title: 'Agent-Ready Repos: the spoken edition',
        status: 'writing',
        sections: manySections(2, 2, 18),
        documentTitle: 'Agent-Ready Repos',
        documentPath: '___fractal___/courses/markdown/agent-ready-repos.md',
      },
    });
    const button = q('.mpe-ra-bar-retell');
    assert.strictEqual(button.hidden, false);
    assert.strictEqual(
      button.getAttribute('title'),
      'This spoken edition (Alt+Shift+T)',
    );
    assert.strictEqual(button.getAttribute('aria-haspopup'), 'dialog');
    const badge = q('.mpe-ra-bar-retell-badge');
    assert.strictEqual(badge.hidden, false);
    assert.strictEqual(badge.textContent, '3/18');
    // The bar order: help, notes, classroom, retell, close.
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
    // Alt+Shift+T opens the Edition sheet.
    control('retellEdition');
    assert.strictEqual(editionSheet().hidden, false);
    assert.strictEqual(
      editionSheet().getAttribute('aria-label'),
      'This spoken edition',
    );
    assert.strictEqual(editionSheet().getAttribute('role'), 'dialog');
    assert.ok(button.classList.contains('is-active'));
    assert.strictEqual(button.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(
      q('.mpe-ra-edition-details').textContent,
      'Retelling section 3 of 18',
    );
    assert.strictEqual(
      q('.mpe-ra-edition-from').textContent,
      'From "Agent-Ready Repos"',
    );
    assert.strictEqual(
      q('.mpe-ra-edition-name').textContent,
      'Agent-Ready Repos: the spoken edition',
    );
    const rows = qa('.mpe-ra-edition-rows .mpe-ra-chapter-row');
    assert.strictEqual(rows.length, 18);
    assert.deepStrictEqual(
      rows.slice(0, 4).map((r) => r.getAttribute('data-state')),
      ['done', 'done', 'writing', 'queued'],
    );
    assert.strictEqual(rows[0].textContent, '1. Section 1');
    assert.strictEqual(action('editionCancel').hidden, false);
    assert.strictEqual(action('editionContinue').hidden, true);
    click(action('editionCancel'));
    assert.deepStrictEqual(plain(lastMessage('readAloudRetellCancel').args), [
      SOURCE_URI,
      EDITION_ID,
      'edition sheet',
    ]);
    click(action('editionOpenSource'));
    assert.deepStrictEqual(
      plain(lastMessage('readAloudRetellOpenSource').args),
      [SOURCE_URI, EDITION_ID, 1],
    );
    // Every row opens its own section's source.
    click(rows[6]);
    assert.deepStrictEqual(
      plain(lastMessage('readAloudRetellOpenSource').args),
      [SOURCE_URI, EDITION_ID, 7],
    );
    click(action('editionOpenFolder'));
    assert.deepStrictEqual(
      plain(lastMessage('readAloudRetellOpenFolder').args),
      [SOURCE_URI],
    );
    // Progress for this edition: the badge, the rows and the message line.
    progress({
      documentUri: 'file:///source.md',
      status: 'writing',
      section: 4,
      of: 18,
      sectionHeading: 'Section 4',
      sections: manySections(3, 3, 18),
      hasSection: true,
    });
    assert.strictEqual(badge.textContent, '4/18');
    assert.strictEqual(
      q('.mpe-ra-bar-status').textContent,
      'Section 4 of 18 is being retold',
    );
    assert.strictEqual(
      q('.mpe-ra-edition-details').textContent,
      'Retelling section 4 of 18',
    );
    progress({
      documentUri: 'file:///source.md',
      status: 'stopped',
      section: 0,
      of: 18,
      sectionHeading: '',
      sections: manySections(4, -1, 18),
      hasSection: true,
    });
    assert.ok(badge.classList.contains('is-warning'));
    assert.ok(badge.querySelector('svg'), 'the warning glyph');
    assert.strictEqual(
      q('.mpe-ra-bar-status').textContent,
      'Stopped after section 4 · Continue in the edition sheet',
    );
    assert.strictEqual(
      q('.mpe-ra-edition-details').textContent,
      'Stopped after section 4',
    );
    assert.strictEqual(action('editionContinue').hidden, false);
    assert.strictEqual(action('editionCancel').hidden, true);
    click(action('editionContinue'));
    assert.deepStrictEqual(plain(lastMessage('readAloudRetellContinue').args), [
      SOURCE_URI,
      EDITION_ID,
    ]);
    progress({
      documentUri: 'file:///source.md',
      status: 'failed',
      section: 0,
      of: 18,
      sectionHeading: '',
      sections: manySections(4, -1, 18),
      hasSection: true,
      error: 'No answer after 90 s.',
    });
    assert.strictEqual(
      q('.mpe-ra-bar-status').textContent,
      'Failed: No answer after 90 s.',
    );
    assert.strictEqual(q('.mpe-ra-edition-error').hidden, false);
    progress({
      documentUri: 'file:///source.md',
      status: 'done',
      section: 0,
      of: 18,
      sectionHeading: '',
      sections: manySections(18, -1, 18),
      hasSection: true,
      words: 6980,
    });
    assert.strictEqual(badge.hidden, true, 'no badge when done');
    assert.strictEqual(
      q('.mpe-ra-edition-details').textContent,
      'Ready · 18 sections · about 49 minutes',
    );
    assert.strictEqual(q('.mpe-ra-bar-status').textContent, '');
    // Delete edition: the chip with Undo, no dialog.
    click(action('editionDelete'));
    assert.deepStrictEqual(plain(lastMessage('readAloudRetellDelete').args), [
      SOURCE_URI,
      EDITION_ID,
    ]);
    assert.strictEqual(
      q('.mpe-ra-note-chip-text').textContent,
      'Spoken edition moved to Trash',
    );
    assert.strictEqual(
      q('.mpe-ra-note-undo').getAttribute('data-mpe-ra-kind'),
      'edition',
    );
    click(q('.mpe-ra-note-undo'));
    assert.deepStrictEqual(
      plain(lastMessage('readAloudRetellUndoDelete').args),
      [SOURCE_URI, EDITION_ID],
    );
    // Escape closes the Edition sheet and returns focus to the button.
    editionSheet().dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    assert.strictEqual(editionSheet().hidden, true);
    assert.strictEqual(doc.activeElement, button);
    // A broadcast config without the field leaves the edition alone; null clears it.
    enable();
    assert.strictEqual(button.hidden, false, 'still an edition preview');
    enable({ retellEdition: null });
    assert.strictEqual(button.hidden, true);
  });

  test('Alt+Shift+T elsewhere shows the chip; a done edition shows no badge; a stopped one the warning and Continue', async function () {
    boot();
    await sleep(60);
    enable();
    control('retellEdition');
    assert.strictEqual(
      q('.mpe-ra-hint').textContent,
      'This preview is not a spoken edition',
    );
    assert.strictEqual(editionSheet().hidden, true);
    enable({
      retellEdition: {
        id: EDITION_ID,
        title: 'Done Edition',
        status: 'done',
        sections: sectionStates(3, -1),
        documentTitle: 'Doc',
        documentPath: 'doc.md',
      },
    });
    assert.strictEqual(q('.mpe-ra-bar-retell').hidden, false);
    assert.strictEqual(q('.mpe-ra-bar-retell-badge').hidden, true);
    control('retellEdition');
    assert.strictEqual(
      q('.mpe-ra-edition-details').textContent,
      'Ready · 3 sections',
    );
    control('retellEdition');
    enable({
      retellEdition: {
        id: EDITION_ID,
        title: 'Stopped Edition',
        status: 'stopped',
        sections: sectionStates(2, -1),
        documentTitle: 'Doc',
        documentPath: 'doc.md',
      },
    });
    assert.ok(q('.mpe-ra-bar-retell-badge').classList.contains('is-warning'));
    control('retellEdition');
    assert.strictEqual(
      q('.mpe-ra-edition-details').textContent,
      'Stopped after section 2',
    );
    assert.strictEqual(action('editionContinue').hidden, false);
    // Opening the Edition sheet closes the Retell sheet, and the reverse.
    await selectWords('p1', 'the figure that appears most often');
    control('retell');
    assert.strictEqual(editionSheet().hidden, true);
    assert.strictEqual(sheet().hidden, false);
    control('retellEdition');
    assert.strictEqual(sheet().hidden, true);
    assert.strictEqual(editionSheet().hidden, false);
    click(action('editionClose'));
    await clearSelection();
  });

  // ------------------------------------------------- §12.4 revealAnchor

  test('revealAnchor with an edition id flashes the anchored block; an anchor that cannot be found shows the chip', async function () {
    boot();
    await sleep(60);
    enable();
    control('revealAnchor', {
      anchor: {
        block: '',
        line: 3,
        exact: 'The measure',
        prefix: '',
        suffix: '',
        offset: 0,
        blocks: 1,
      },
      editionId: EDITION_ID,
    });
    const heading = doc.getElementById('the-measure');
    assert.ok(heading.classList.contains('mpe-ra-flash'), 'flashed by text');
    await sleep(1100);
    assert.ok(!heading.classList.contains('mpe-ra-flash'), 'for a second');
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
      editionId: EDITION_ID,
    });
    assert.strictEqual(q('.mpe-ra-note-chip').hidden, false);
    assert.strictEqual(
      q('.mpe-ra-note-chip-text').textContent,
      'That section is not in this version of the document',
    );
  });

  // ----------------------------------------------------------- the CSS

  test('[hidden] resolves to display none for every new element (the 09 lesson)', function () {
    for (const selector of [
      '.mpe-ra-retell[hidden]',
      '.mpe-ra-edition[hidden]',
      '.mpe-ra-retell-form[hidden]',
      '.mpe-ra-retell-sections[hidden]',
      '.mpe-ra-retell-row[hidden]',
      '.mpe-ra-retell-more[hidden]',
      '.mpe-ra-retell-widened[hidden]',
      '.mpe-ra-retell-shape[hidden]',
      '.mpe-ra-retell-estimate[hidden]',
      '.mpe-ra-retell-engine-field[hidden]',
      '.mpe-ra-retell-sending[hidden]',
      '.mpe-ra-retell-editions[hidden]',
      '.mpe-ra-retell-edition-row[hidden]',
      '.mpe-ra-retell-card[hidden]',
      '.mpe-ra-retell-card-title[hidden]',
      '.mpe-ra-retell-elapsed[hidden]',
      '.mpe-ra-retell-error[hidden]',
      '.mpe-ra-edition-from[hidden]',
      '.mpe-ra-edition-error[hidden]',
      '.mpe-ra-bar .mpe-ra-bar-retell[hidden]',
      '.mpe-ra-bar .mpe-ra-help-btn[hidden]',
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
      'the cluster wraps rather than shrinks (§4)',
    );
    assert.ok(
      /prefers-reduced-motion: reduce\)\s*\{[^}]*\.mpe-ra-retell-marker/.test(
        CSS,
      ),
      'the marker is static under reduced motion',
    );
    assert.ok(CSS.includes(".mpe-ra-chapter-row[data-state='cached']"));
  });
});
