/* global suite, test, suiteSetup, suiteTeardown */
'use strict';

// The help sheet of media/read-aloud.js (`featrues/04-help-module.md`) under
// jsdom with fake <audio> elements: the enable predicate of the ? button, the
// pause-and-remember of §4 step 1, the material the request carries, the
// sheet as a second reading scope (§5), Resume, the follow-up chips and the
// question box.

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

// A document with two heading levels, so the breadcrumb and the section
// boundary of §3.1 both have something to find.
const FIXTURE =
  '<h1 id="h1">Module one: the governed harness</h1>' +
  '<p id="intro">This module is about the path a change walks.</p>' +
  '<h2 id="h2">The governed path</h2>' +
  '<p id="before">Now the run. A human selects the agent and assigns the issue.</p>' +
  '<p id="passage">Then the human path, and it is the same path a human author would walk.</p>' +
  '<p id="after">Both chairs, one last time on this. The path is the same one.</p>' +
  '<pre id="code"><code>not prose</code></pre>' +
  '<p id="tail">The package itself is the last module of the course.</p>' +
  '<h2 id="h2b">A later section</h2>' +
  '<p id="outside">This paragraph is past the section boundary.</p>';

const PREVIEW =
  '<!doctype html><html><body class="preview-container">' +
  '<div id="crossnote-data" data-config=\'{"sourceUri":"file:///doc.md"}\'></div>' +
  '<div class="crossnote markdown-preview" data-for="preview">' +
  FIXTURE +
  '</div></body></html>';

/** The explanation the host would render through the preview engine. */
const ANSWER_HTML =
  '<h3>What it says</h3>' +
  '<p>The change goes through the same gates as anyone else.</p>' +
  '<h3>Terms</h3>' +
  '<ul><li><strong>Maintainer</strong>: the person who reviews.</li></ul>';
const ANSWER_MARKDOWN =
  '### What it says\nThe change goes through the same gates as anyone else.\n\n' +
  '### Terms\n- **Maintainer**: the person who reviews.';

const CHUNK_SECONDS = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whitespace words of `text` as host word spans, spread over the chunk. */
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

suite('read-aloud help sheet (04-help-module)', function () {
  this.timeout(20000);

  let dom;
  let win;
  let doc;
  let posted;
  let audios;
  let logs;
  // Every window this suite opens: the sheet's elapsed-seconds ticker is a
  // window interval, so an unclosed window would keep mocha running.
  const windows = [];

  function boot() {
    posted = [];
    audios = [];
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
    let blobs = 0;
    win.URL.createObjectURL = () => 'blob:fake-' + ++blobs;
    win.URL.revokeObjectURL = () => {};
    win.Element.prototype.scrollIntoView = function () {};
    class FakeAudio extends win.EventTarget {
      constructor() {
        super();
        this._src = '';
        this.currentTime = 0;
        this.duration = CHUNK_SECONDS;
        this.playbackRate = 1;
        this.preservesPitch = true;
        this.volume = 1;
        this.paused = true;
        audios.push(this);
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

  /** Turn the help feature on, the way the host's config message does. */
  function enableHelp(overrides) {
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
          helpAutoPlay: true,
          helpContextMode: 'section',
        },
        overrides || {},
      ),
    );
  }

  function bar() {
    return doc.querySelector('.mpe-ra-bar');
  }

  function helpButton() {
    return doc.querySelector('.mpe-ra-bar-help');
  }

  function sheet() {
    return doc.querySelector('.mpe-ra-help');
  }

  function sheetBody() {
    return doc.querySelector('.mpe-ra-help-body');
  }

  function action(name) {
    return sheet().querySelector('[data-mpe-ra-action="' + name + '"]');
  }

  function click(element) {
    element.dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  }

  function closeSheet() {
    if (sheet() && !sheet().hidden) {
      click(action('helpClose'));
    }
  }

  /** Select the whole text of `#id` and let the affordance settle. */
  async function selectParagraph(id) {
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById(id));
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

  /**
   * Select the `nth` occurrence of `needle` inside the single text node of
   * `#id` — a few words out of a sentence, the 11 case.
   */
  async function selectWords(id, needle, nth) {
    // The player prepends its play button to the block, so the prose is not
    // the first child: find the text node that carries the needle.
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
  }

  function lastMessage(command) {
    return posted.filter((m) => m.command === command).pop();
  }

  function lastHelpRequest() {
    return lastMessage('readAloudHelp');
  }

  /** Answer the help request in flight, the way the host would. */
  function answerHelp(overrides) {
    const request = lastHelpRequest();
    assert.ok(request, 'a help request was sent; logs: ' + logs.join('\n'));
    host(
      Object.assign(
        {
          command: 'readAloudHelpResult',
          requestId: request.args[1],
          html: ANSWER_HTML,
          markdown: ANSWER_MARKDOWN,
          engine: 'claude',
          model: 'sonnet',
          effort: 'low',
          cached: false,
          durationMs: 1200,
        },
        overrides || {},
      ),
    );
    return request;
  }

  function sendChunk(request, index, count, blockIndex, chunkText) {
    const text = request.args[2];
    const block = request.args[3].blocks[blockIndex];
    const base = text.indexOf(chunkText, block.start);
    assert.ok(base >= 0, 'chunk text is inside its block');
    host({
      command: 'readAloudAudio',
      requestId: request.args[1],
      chunkIndex: index,
      chunkCount: count,
      blockIndex,
      audioBase64: 'QUJD',
      mimeType: 'audio/mpeg',
      spans: spansOf(chunkText, base),
      durationHint: CHUNK_SECONDS,
    });
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

  // -------------------------------------------------------------- §2 button

  test('the button is absent until the host says help is available', function () {
    assert.ok(helpButton(), 'the ? button is built with the panel');
    assert.strictEqual(
      helpButton().hidden,
      true,
      'hidden while helpAvailable is false, as in the web build',
    );
    enableHelp();
    assert.strictEqual(helpButton().hidden, false);
  });

  test('with no selection the button is disabled and says why', async function () {
    await clearSelection();
    assert.strictEqual(helpButton().disabled, true);
    assert.strictEqual(
      helpButton().getAttribute('title'),
      'Select text to get help',
    );
  });

  test('selecting a readable paragraph enables it', async function () {
    await selectParagraph('passage');
    assert.strictEqual(helpButton().disabled, false);
    assert.strictEqual(
      helpButton().getAttribute('title'),
      'Explain the selection',
    );
  });

  test('a selection read keeps the button enabled after the selection collapses', async function () {
    boot();
    await sleep(60);
    enableHelp();
    await selectParagraph('passage');

    // Start the selection read from the floating affordance, which hides
    // itself and drops the resolved selection as it does.
    click(doc.querySelector('.mpe-ra-float-read'));
    const read = lastMessage('readAloudSynthesize');
    assert.ok(read, 'the selection is being read; logs: ' + logs.join('\n'));
    assert.strictEqual(read.args[3].kind, 'selection');

    // §2 — the passage is remembered on the job, so a collapsed browser
    // selection does not disable the button mid-read.
    await clearSelection();
    assert.strictEqual(helpButton().disabled, false);

    click(helpButton());
    assert.strictEqual(
      lastHelpRequest().args[2],
      read.args[2],
      'the passage being read is the passage explained',
    );
    closeSheet();
  });

  test('the mouseup that ends a drag does not disable the button', async function () {
    // A drag fires selectionchange while the mouse is down and a click on
    // mouseup. With a slow drag the affordance is already up by then, so the
    // click must not take it away again while the selection is still there.
    await selectParagraph('passage');
    assert.strictEqual(helpButton().disabled, false, 'enabled by the drag');
    click(doc.getElementById('passage'));
    assert.strictEqual(
      helpButton().disabled,
      false,
      'and still enabled after the mouseup that ended it',
    );
    assert.strictEqual(
      doc.querySelector('.mpe-ra-float').hidden,
      false,
      'the Read aloud affordance survives it too',
    );
  });

  test('pressing the button keeps the selection alive long enough to read it', function () {
    // A mousedown on a control collapses the document selection, so the help
    // button suppresses the default the way the float affordance does.
    const event = new win.MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    helpButton().dispatchEvent(event);
    assert.strictEqual(event.defaultPrevented, true);
    // And a mousedown anywhere else is left alone.
    const other = new win.MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    doc.getElementById('passage').dispatchEvent(other);
    assert.strictEqual(other.defaultPrevented, false);
  });

  test('a click that collapses the selection does disable it', async function () {
    await selectParagraph('passage');
    assert.strictEqual(helpButton().disabled, false);
    // A plain click elsewhere collapses the selection before `click` fires.
    await clearSelection();
    click(doc.getElementById('after'));
    assert.strictEqual(helpButton().disabled, true);
    assert.strictEqual(doc.querySelector('.mpe-ra-float').hidden, true);
  });

  test('a selection inside code does not enable it', async function () {
    await selectParagraph('code');
    assert.strictEqual(helpButton().disabled, true);
    await clearSelection();
  });

  // ------------------------------------------------- 09 §8, §9: the scroll

  test('a scroll does not disable the button', async function () {
    await selectParagraph('passage');
    assert.strictEqual(helpButton().disabled, false, 'enabled by the drag');

    // The follow-the-reading scroll (07 §7) writes the container's position
    // on every frame of a read, and `hideFloat` used to be bound straight to
    // this event and to drop the resolved selection with the affordance: the
    // button — and Alt+H, which shares the predicate — went dead within a
    // frame of any selection made while listening (09 §2.3).
    win.dispatchEvent(new win.Event('scroll'));
    await sleep(20);

    assert.strictEqual(
      helpButton().disabled,
      false,
      'the selection is still there, so the button still is',
    );
    assert.strictEqual(
      helpButton().getAttribute('title'),
      'Explain the selection',
    );
    assert.strictEqual(
      doc.querySelector('.mpe-ra-float').hidden,
      false,
      'and the affordance travels with the text instead of vanishing',
    );
    await clearSelection();
  });

  test('a scroll with no selection left takes the affordance away', async function () {
    await selectParagraph('passage');
    win.getSelection().removeAllRanges();
    win.dispatchEvent(new win.Event('scroll'));
    await sleep(20);
    assert.strictEqual(doc.querySelector('.mpe-ra-float').hidden, true);
    assert.strictEqual(helpButton().disabled, true);
  });

  test('the predicate resolves the live selection, with no selectionchange', function () {
    // No `selectionchange`, so the 150 ms settle never runs and
    // `floatSelection` is untouched: the button state comes from the live
    // selection alone (09 §8).
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById('passage'));
    const selection = win.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    host({ command: 'readAloudConfig', enabled: true, helpAvailable: true });
    assert.strictEqual(helpButton().disabled, false);
    selection.removeAllRanges();
  });

  test('Alt+H works after a scroll has been through', async function () {
    await selectParagraph('passage');
    win.dispatchEvent(new win.Event('scroll'));
    await sleep(20);
    host({ command: 'readAloudControl', action: 'help' });
    assert.strictEqual(sheet().hidden, false, 'the sheet opened');
    closeSheet();
    await clearSelection();
  });

  // ---------------------------------------- 09 §10: Explain on the affordance

  test('the affordance carries Read aloud and Explain', async function () {
    await selectParagraph('passage');
    const float = doc.querySelector('.mpe-ra-float');
    const read = float.querySelector('[data-mpe-ra-action="float"]');
    const explain = float.querySelector('[data-mpe-ra-action="floatHelp"]');
    assert.ok(read, 'the read button is still there with its own action');
    assert.ok(explain, 'and the new help button beside it');
    assert.strictEqual(explain.hidden, false, 'shown while help is available');
    assert.strictEqual(
      explain.getAttribute('title'),
      'Explain the selection',
      'the panel button’s wording',
    );

    click(explain);
    assert.strictEqual(sheet().hidden, false, 'it opens the sheet');
    assert.strictEqual(
      lastHelpRequest().args[2],
      doc.getElementById('passage').textContent,
      'with the passage that was selected',
    );
    closeSheet();
    await clearSelection();
  });

  test('with the sheet open the document selection has no affordance', async function () {
    // The sheet owns the reading, and the document selection left behind is
    // the passage being explained: an affordance there would offer to read or
    // re-explain it across the two scopes, and it would stand over the answer
    // (09 §10).
    await selectParagraph('passage');
    click(helpButton());
    answerHelp();
    doc.dispatchEvent(new win.Event('selectionchange'));
    await sleep(220);
    assert.strictEqual(doc.querySelector('.mpe-ra-float').hidden, true);
    closeSheet();
    await clearSelection();
  });

  test('Explain is hidden in the web build and for a selection in the sheet', async function () {
    // The web build cannot spawn a process, so there is no help at all.
    host({ command: 'readAloudConfig', enabled: true, helpAvailable: false });
    await selectParagraph('passage');
    assert.strictEqual(
      doc.querySelector('.mpe-ra-float-help').hidden,
      true,
      'no Explain without an engine',
    );
    enableHelp();
    await selectParagraph('passage');
    assert.strictEqual(doc.querySelector('.mpe-ra-float-help').hidden, false);

    // 04 D9: a selection inside the sheet is read, not explained — questions
    // about the explanation go through the sheet's own question box.
    click(helpButton());
    answerHelp();
    const range = doc.createRange();
    range.selectNodeContents(sheetBody().querySelector('p'));
    const selection = win.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new win.Event('selectionchange'));
    await sleep(220);
    assert.strictEqual(
      doc.querySelector('.mpe-ra-float').hidden,
      false,
      'the sheet still offers Read aloud',
    );
    assert.strictEqual(
      doc.querySelector('.mpe-ra-float-help').hidden,
      true,
      'but not Explain',
    );
    closeSheet();
    await clearSelection();
  });

  // ------------------------------------------------- §3.1 what is sent

  test('the request carries the title, breadcrumb, neighbours and section', async function () {
    await selectParagraph('passage');
    click(helpButton());
    const request = lastHelpRequest();
    assert.ok(request, 'help was requested; logs: ' + logs.join('\n'));

    const [uri, requestId, passage, fields] = request.args;
    assert.strictEqual(uri, 'file:///doc.md');
    assert.match(requestId, /^[A-Za-z0-9_-]{1,64}$/);
    assert.match(passage, /^Then the human path/);

    assert.strictEqual(fields.title, 'Module one: the governed harness');
    // Nearest heading of each level, outermost first — not every h2 above.
    // The array comes from the jsdom realm, so compare it as a plain one.
    assert.deepStrictEqual(Array.from(fields.breadcrumb), [
      'Module one: the governed harness',
      'The governed path',
    ]);
    assert.match(fields.before, /^Now the run\./);
    assert.match(fields.after, /^Both chairs/);
    assert.strictEqual(fields.contextMode, 'section');

    // The section is the rest of the enclosing h2, with the passage's place
    // marked and the code fence left out; the later section is not in it.
    assert.ok(
      fields.section.includes('[PASSAGE]'),
      'the passage marker is in the section: ' + fields.section,
    );
    assert.ok(fields.section.includes('The package itself'));
    assert.ok(!fields.section.includes('not prose'), 'the fence is skipped');
    assert.ok(
      !fields.section.includes('past the section boundary'),
      'the next h2 ends the section',
    );
    // Before, the passage and after are their own fields, not repeated here.
    assert.ok(!fields.section.includes('Now the run'));
    assert.ok(!fields.section.includes('Both chairs'));
    // 11 — the selection is the whole block, so there is nothing around it to
    // send, and a sentence of fourteen words is a passage, not a term.
    assert.strictEqual(fields.enclosing, '');
    assert.strictEqual(fields.mentions, '');
    // A first request carries no follow-up and no previous explanation.
    assert.strictEqual(fields.followUp, undefined);
    assert.strictEqual(fields.previous, undefined);
  });

  test('the sheet opens on Thinking… with the engine label and a Cancel', function () {
    assert.strictEqual(sheet().hidden, false);
    assert.strictEqual(sheet().getAttribute('role'), 'dialog');
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-help-model').textContent,
      'claude · sonnet · low',
    );
    const status = sheet().querySelector('.mpe-ra-help-status-text');
    assert.match(status.textContent, /^Thinking… \(claude · sonnet · low\)/);
    assert.strictEqual(action('helpCancel').hidden, false);
    assert.strictEqual(action('helpRetry').hidden, true);
    // The chips and the box wait for an explanation to follow up on.
    assert.strictEqual(action('helpSimpler').disabled, true);
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-help-input').disabled,
      true,
    );
  });

  // ----------------------------------------- §5 the sheet as a reading scope

  test('the answer renders into the body and is read bounded to the sheet', function () {
    answerHelp();
    assert.strictEqual(
      sheetBody().querySelectorAll('h3').length,
      2,
      'the preview markup is what the sheet shows',
    );
    // The body is not `.mpe-ra-ui`: it is a reading scope, so the reader sees
    // its blocks.
    assert.strictEqual(sheetBody().classList.contains('mpe-ra-ui'), false);

    const read = lastMessage('readAloudSynthesize');
    assert.ok(read, 'auto-play started a read; logs: ' + logs.join('\n'));
    assert.strictEqual(read.args[3].kind, 'help');
    // The sheet's four eligible blocks, and nothing of the document.
    assert.strictEqual(read.args[3].blocks.length, 4);
    assert.ok(read.args[2].includes('What it says'));
    assert.ok(
      !read.args[2].includes('Then the human path'),
      'a help read never leaves the sheet',
    );
    // No gutter play buttons are added inside the sheet.
    assert.strictEqual(sheetBody().querySelectorAll('.mpe-ra-btn').length, 0);
  });

  test('the panel drives the help read and its status says Help', async function () {
    const read = lastMessage('readAloudSynthesize');
    sendChunk(read, 0, 1, 0, 'What it says');
    await sleep(30);
    const play = doc.querySelector('.mpe-ra-bar-play');
    assert.strictEqual(play.getAttribute('data-state'), 'playing');
    assert.strictEqual(bar().hidden, false);
    // The pill decoration is painted inside the sheet, with the same palette.
    assert.ok(
      sheetBody().querySelector('.mpe-ra-reading'),
      'the block being read is decorated inside the sheet',
    );
    assert.strictEqual(sheet().getAttribute('data-mpe-ra-theme'), 'blue');
    click(play);
    assert.strictEqual(play.getAttribute('data-state'), 'paused');
  });

  // --------------------------------------------------------- §8 follow-ups

  test('a chip resends the same material with the previous explanation', function () {
    const first = lastHelpRequest();
    click(action('helpDeeper'));
    const followUp = lastHelpRequest();
    assert.notStrictEqual(followUp.args[1], first.args[1], 'a new request id');
    assert.strictEqual(followUp.args[2], first.args[2], 'the same passage');
    // §14.3 — the material is byte for byte the first request's.
    assert.strictEqual(followUp.args[3].title, first.args[3].title);
    assert.strictEqual(followUp.args[3].section, first.args[3].section);
    assert.strictEqual(followUp.args[3].followUp, 'deeper');
    assert.strictEqual(followUp.args[3].previous, ANSWER_MARKDOWN);
    assert.strictEqual(followUp.args[3].question, undefined);
  });

  test('a typed question carries the question and shows it above the answer', function () {
    answerHelp({
      markdown: '### Deeper\nMore detail.',
      html: '<h3>Deeper</h3><p>More detail.</p>',
    });
    const input = sheet().querySelector('.mpe-ra-help-input');
    input.value = '  What is a   code owner?  ';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.strictEqual(action('helpAsk').disabled, false);
    click(action('helpAsk'));

    const request = lastHelpRequest();
    assert.strictEqual(request.args[3].followUp, 'question');
    assert.strictEqual(
      request.args[3].question,
      'What is a code owner?',
      'whitespace is collapsed before it is sent',
    );
    assert.strictEqual(request.args[3].previous, '### Deeper\nMore detail.');
    assert.strictEqual(input.value, '', 'the box is emptied on send');

    answerHelp({
      markdown: 'A code owner reviews.',
      html: '<p>A code owner reviews.</p>',
    });
    // §14.5 — the heading sits inside the reading scope, as its first block,
    // so the listener hears what is being answered before the answer.
    const heading = sheetBody().firstElementChild;
    assert.ok(heading.classList.contains('mpe-ra-help-question'));
    assert.strictEqual(heading.textContent, 'What is a code owner?');
    const read = lastMessage('readAloudSynthesize');
    assert.ok(
      read.args[2].startsWith('What is a code owner?'),
      'the question is the first thing spoken: ' + read.args[2].slice(0, 40),
    );
  });

  test('Back restores the previous explanation', function () {
    assert.strictEqual(action('helpBack').disabled, false);
    click(action('helpBack'));
    assert.strictEqual(
      sheetBody().textContent.trim(),
      'DeeperMore detail.',
      'the explanation before the question is back',
    );
    click(action('helpBack'));
    assert.ok(sheetBody().textContent.includes('What it says'));
    assert.strictEqual(
      action('helpBack').disabled,
      true,
      'the stack is empty again',
    );
  });

  test('an error shows in the sheet with Retry, and Retry resends', function () {
    const before = posted.filter((m) => m.command === 'readAloudHelp').length;
    click(action('helpSimpler'));
    const request = lastHelpRequest();
    host({
      command: 'readAloudHelpError',
      requestId: request.args[1],
      message: 'Could not find the claude command.',
      retryable: false,
    });
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-help-status-text').textContent,
      'Could not find the claude command.',
    );
    assert.strictEqual(action('helpRetry').hidden, false);
    assert.strictEqual(action('helpCancel').hidden, true);
    // The same text is in the panel's own message line.
    assert.strictEqual(
      doc.querySelector('.mpe-ra-bar-status').textContent,
      'Could not find the claude command.',
    );
    click(action('helpRetry'));
    const after = posted.filter((m) => m.command === 'readAloudHelp').length;
    assert.strictEqual(after, before + 2, 'Retry sent the same request again');
    assert.strictEqual(lastHelpRequest().args[3].followUp, 'simpler');
  });

  test('Cancel and × stop the request in flight', function () {
    click(action('helpCancel'));
    const cancel = lastMessage('readAloudHelpCancel');
    assert.ok(cancel, 'the host was told to kill the child');
    assert.strictEqual(cancel.args[2], 'user');

    click(action('helpClose'));
    assert.strictEqual(sheet().hidden, true);
    assert.strictEqual(sheetBody().innerHTML, '', 'the scope is emptied');
  });

  // ------------------------------------------------ §4 pause, remember, resume

  test('help pauses a running read, remembers the word and Resume continues it', async function () {
    boot();
    await sleep(60);
    enableHelp();

    // A document read from the third paragraph, two words in.
    click(doc.querySelector('#before .mpe-ra-btn'));
    const read = lastMessage('readAloudSynthesize');
    assert.ok(read, 'a document read started; logs: ' + logs.join('\n'));
    assert.strictEqual(read.args[3].kind, 'block');
    // One chunk of two, so the host job is still running and the cancel of
    // §4 step 1 has something to kill.
    sendChunk(read, 0, 2, 0, 'Now the run.');
    await sleep(30);

    await selectParagraph('passage');
    click(helpButton());

    // §4 step 1: the job is cancelled with reason `help`, not stopped
    // silently, and the audio is released.
    const cancel = lastMessage('readAloudCancel');
    assert.ok(cancel, 'the read was cancelled');
    assert.strictEqual(cancel.args[2], 'help');
    assert.strictEqual(
      doc.querySelector('.mpe-ra-bar-play').getAttribute('data-state'),
      'idle',
    );

    answerHelp();
    assert.strictEqual(action('helpResume').disabled, false);

    const before = posted.filter(
      (m) => m.command === 'readAloudSynthesize',
    ).length;
    click(action('helpResume'));
    assert.strictEqual(sheet().hidden, true, 'Resume closes the sheet');
    const resumed = lastMessage('readAloudSynthesize');
    assert.strictEqual(
      posted.filter((m) => m.command === 'readAloudSynthesize').length,
      before + 1,
    );
    assert.strictEqual(resumed.args[3].kind, 'block');
    assert.ok(
      resumed.args[2].startsWith('Now the run.'),
      'the paused block is where it starts again: ' +
        resumed.args[2].slice(0, 40),
    );
  });

  test('Resume is disabled once the paused block is gone', async function () {
    boot();
    await sleep(60);
    enableHelp();

    click(doc.querySelector('#before .mpe-ra-btn'));
    const read = lastMessage('readAloudSynthesize');
    sendChunk(read, 0, 2, 0, 'Now the run.');
    await sleep(30);

    await selectParagraph('passage');
    click(helpButton());
    answerHelp();
    assert.strictEqual(action('helpResume').disabled, false);

    // The document is edited and the preview re-rendered without the paused
    // block, so there is nothing to come back to. Replacing the root's
    // contents is what crossnote's `updateHtml` does; deleting the one node
    // in place would look like our own decoration to the observer.
    doc.querySelector('.markdown-preview').innerHTML = FIXTURE.replace(
      '<p id="before">Now the run. A human selects the agent and assigns the issue.</p>',
      '',
    );
    await sleep(150);
    assert.strictEqual(doc.getElementById('before'), null);
    assert.strictEqual(action('helpResume').disabled, true);
    assert.strictEqual(
      action('helpResume').getAttribute('title'),
      'The paused text is no longer in the document',
    );
  });

  // --------------------------------------------------- §5 clicks and Escape

  test('a click inside the sheet starts the help read there', async function () {
    boot();
    await sleep(60);
    enableHelp({ helpAutoPlay: false });
    await selectParagraph('passage');
    click(helpButton());
    answerHelp();
    assert.strictEqual(
      posted.filter((m) => m.command === 'readAloudSynthesize').length,
      0,
      'auto-play off means nothing is read yet',
    );

    // Click to read resolves against the sheet, not the document.
    const target = sheetBody().querySelector('p');
    win.getSelection().removeAllRanges();
    doc.caretRangeFromPoint = function () {
      const range = doc.createRange();
      range.setStart(target.firstChild, 0);
      range.collapse(true);
      return range;
    };
    click(target);
    await sleep(300);
    const read = lastMessage('readAloudSynthesize');
    assert.ok(read, 'the click started a read; logs: ' + logs.join('\n'));
    assert.strictEqual(read.args[3].kind, 'help');
    assert.ok(read.args[2].includes('the same gates'));
    delete doc.caretRangeFromPoint;
  });

  test('Escape closes the sheet before it stops a read', function () {
    assert.strictEqual(sheet().hidden, false);
    bar().dispatchEvent(
      new win.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.strictEqual(sheet().hidden, true);
  });

  test('Alt+H reaches the sheet as the `help` control action', async function () {
    boot();
    await sleep(60);
    enableHelp();
    await selectParagraph('passage');
    host({ command: 'readAloudControl', action: 'help' });
    assert.strictEqual(sheet().hidden, false);
    assert.ok(lastHelpRequest(), 'the command asked for an explanation');
    // And again toggles it shut.
    host({ command: 'readAloudControl', action: 'help' });
    assert.strictEqual(sheet().hidden, true);
  });

  test('the sheet label opens the model quick pick', async function () {
    await selectParagraph('passage');
    click(helpButton());
    click(sheet().querySelector('.mpe-ra-help-model'));
    assert.ok(
      lastMessage('readAloudHelpChooseModel'),
      'the label asks the host for the quick pick',
    );
    // A settings change re-labels the open sheet at once (§7.1).
    enableHelp({ helpModel: 'opus', helpEffort: 'xhigh' });
    assert.strictEqual(
      sheet().querySelector('.mpe-ra-help-model').textContent,
      'claude · opus · xhigh',
    );
  });

  test('selection mode sends the passage, title and breadcrumb only', async function () {
    boot();
    await sleep(60);
    enableHelp({ helpContextMode: 'selection' });
    await selectParagraph('passage');
    click(helpButton());
    const fields = lastHelpRequest().args[3];
    assert.strictEqual(fields.contextMode, 'selection');
    assert.strictEqual(fields.before, '');
    assert.strictEqual(fields.after, '');
    assert.strictEqual(fields.section, '');
    assert.strictEqual(fields.enclosing, '');
    assert.strictEqual(fields.mentions, '');
    assert.strictEqual(fields.title, 'Module one: the governed harness');
    assert.strictEqual(fields.breadcrumb.length, 2);
  });

  // ------------------------------------------- 11: a few words, in context

  test('a few selected words carry their block with the selection marked, and the mentions elsewhere', async function () {
    boot();
    await sleep(60);
    enableHelp({ helpContextMode: 'section' });
    await selectWords('passage', 'path');
    click(helpButton());
    const [, , passage, fields] = lastHelpRequest().args;
    assert.strictEqual(passage, 'path');
    // The whole paragraph, with the selected word — the first "path" — in
    // the brackets; the section keeps the [PASSAGE] marker where the block was.
    assert.strictEqual(
      fields.enclosing,
      'Then the human \u27e6path\u27e7, and it is the same path a human author would walk.',
    );
    assert.ok(fields.section.includes('[PASSAGE]'));
    assert.ok(!fields.section.includes('Then the human path'));
    // One word is a term: the document's other uses of it, outside the
    // section (the intro sits above the h2), each under its heading. The
    // "after" block also says "path" but is already in the request.
    assert.strictEqual(
      fields.mentions,
      'Under "Module one: the governed harness": This module is about the path a change walks.',
    );
    closeSheet();
    await clearSelection();

    // The second "path" of the same sentence is the one marked when it is the
    // one selected: the live range gives the offset, not a text search.
    await selectWords('passage', 'path', 1);
    click(helpButton());
    const again = lastHelpRequest().args[3];
    assert.strictEqual(
      again.enclosing,
      'Then the human path, and it is the same \u27e6path\u27e7 a human author would walk.',
    );
    closeSheet();
    await clearSelection();

    // A phrase of more than five words gets its block but no mentions.
    await selectWords('passage', 'it is the same path a human author');
    click(helpButton());
    const phrase = lastHelpRequest().args[3];
    assert.ok(
      phrase.enclosing.startsWith('Then the human path, and \u27e6it is'),
    );
    assert.strictEqual(phrase.mentions, '');
  });

  test('selection mode still sends the enclosing block, and never the mentions', async function () {
    boot();
    await sleep(60);
    enableHelp({ helpContextMode: 'selection' });
    await selectWords('passage', 'path');
    click(helpButton());
    const fields = lastHelpRequest().args[3];
    assert.strictEqual(fields.contextMode, 'selection');
    assert.strictEqual(
      fields.enclosing,
      'Then the human \u27e6path\u27e7, and it is the same path a human author would walk.',
    );
    assert.strictEqual(fields.mentions, '');
    assert.strictEqual(fields.section, '');
  });
});
