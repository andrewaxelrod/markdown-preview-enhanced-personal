# Personal changelog

Local changes made on top of upstream **markdown-preview-enhanced 0.8.32**, tracked
separately from [CHANGELOG.md](CHANGELOG.md) so upstream's history stays conflict-free
when rebasing onto a newer release.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Record new work
under `[Unreleased]` as you go; when rebasing onto a new upstream version, close
`[Unreleased]` into a section named for that version and open a fresh one.

Categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

## [Unreleased]

### Added

- **Read aloud** in the preview (`resources/spec.md`; desktop VS Code only), spoken by the local
  **Kokoro** engine: the open-weight, Apache-licensed Kokoro-82M model served on this machine
  by a Kokoro-FastAPI server. Free, offline, no key, nothing leaves the machine.
  - A play button on every readable block (paragraphs, headings h1–h6, blockquotes, lists
    including task lists with the checkbox unspoken, admonition-style containers with visible
    text), a control panel with play/pause, ±10 s, volume and 0.25x–4x speed
    (`HTMLMediaElement.playbackRate`, never re-synthesised), and word-by-word
    highlighting from the server's own timestamps. Code fences, code chunks, diagrams (mermaid,
    PlantUML, WaveDrom, Vega, D2, …), display math, images, embeds, tables, the TOC and footnote
    definitions are skipped at any depth.
  - **Read to the end of the document** (spec F15): a play button or a click on a word reads
    from that point through every readable block that follows, in document order. The webview
    sends one request carrying the text and the block boundaries (`options.blocks`, each with
    the block's content hash and its range of the text); the host sanitises and chunks every
    block on its own, so no chunk ever crosses a block boundary, and every `readAloudAudio`
    carries its `blockIndex`. The pills and the button state hand over to the next block as its
    first chunk starts playing, the bar label follows, and the audio of finished blocks is
    released so a document-length read is never held in memory in full. On a re-render the
    read re-locates every block by its content hash in document order (two blocks with the
    same text stay apart); it stops when the block being read is gone, or when the next block
    is gone as its turn comes, and continues through edits anywhere else. The read ends at the
    last block with the _Finished_ state.
  - **Prefetch window** instead of a playback gate: the host keeps `PREFETCH_CHUNKS = 2` chunks
    synthesised ahead of the chunk the webview reports playing (`readAloudPlaying`) and requests
    the next as soon as the previous response is in — about 90 s of audio, which is what carries
    the read across block boundaries with no audible gap. Chunking stays sentence-based with a
    ~250-character first chunk (fast first sound) and ~700-character chunks after it; one
    request in flight at a time.
  - **Click to read** (spec F17): a plain left click anywhere inside a readable block starts at
    the nearest word — on the word, on a space, in the margin, between lines or past the end of
    a line (the caret the browser places at the point decides; there is no glyph-box test) — and
    reads to the end of the document. A click on a word whose audio is already synthesised
    (the current block or a prefetched one) seeks the audio; any other click starts a new read.
    Playable text shows a **pointer cursor** while `readAloudClickToRead` is on (class
    `mpe-ra-click` on the preview root, toggled live from `readAloudConfig`); excluded content
    keeps the default cursor, links and checkboxes their own. The 250 ms double-click wait and
    the drag, modifier, link and checkbox refusals are unchanged.
  - **Table cells are reading units and a cell read ends at the cell**: a click in a cell reads
    from that word to the end of the cell and stops; it does not continue to the end of the
    document. Tables are skipped by a continuous read. A selection within a single cell is read;
    one spanning two cells is refused with _Select text within a single table cell_.
  - **Inline math is skipped, not refused**: a paragraph (or list, blockquote, container, table
    cell) that contains `$…$` is read with the math left out, the same way a nested fence or
    table is skipped; a click or selection on the math itself is refused. Display math is its own
    block and stays skipped. LaTeX is never spoken.
  - Selection reading (spec F2): a floating _Read aloud_ affordance and `Alt+R` read the current
    preview selection, bounded to the selection, across as many readable blocks as it covers.
  - Speakable text only (spec F5, `src/read-aloud/speakable.ts`): letters, marks and digits of
    any script, whitespace and sentence punctuation reach the server; markdown residue, brackets,
    symbols and emoji are dropped with an offset map back to the preview text, and the HTTP
    client refuses any request that still carries an unspeakable character.
  - Kokoro transport and alignment: `POST /dev/captioned_speech`, non-streaming mp3 with word
    timestamps and the server's normaliser off (`kokoro-client.ts`, `kokoro-types.ts`);
    `kokoro-alignment.ts` aligns the server's per-token timestamps with the webview's words
    (punctuation dropped, hyphenated and dotted tokens split, contractions joined, untimed runs
    interpolated — which also covers the server dropping timestamps after a bare `$`).
  - On-disk LRU audio cache keyed by chunk text, voice and model (`readAloudCacheSizeMB`,
    default 100); a hit replays instantly and a neighbour edit never invalidates it. The _MPE
    Read Aloud_ output channel logs the plan of every read and one line per chunk (block, length,
    voice, status, duration, hit or miss), never more than 80 characters of text.
  - Errors (`error-mapping.ts`): server not running → inline, retryable _Could not reach the
    Kokoro server at … Start it and try again._; unknown voice → a short message naming the
    voice; _Input contains no speakable text_ → silent; 5xx → _Kokoro server error: …_; 429 →
    1 s / 2 s / 4 s backoff.
  - Reading decoration: every rendered line of the block being read sits on a rounded pill and
    the spoken word gets a darker box (`.mpe-ra-pill` / `.mpe-ra-word`, text nodes split and
    merged back so the offset map stays valid); `readAloudHighlightTheme` — `blue`
    (default), `pink`, `red`, `green`, `orange`, whose dark variants are the colours sampled
    from the reference reader in `enhancement/` — light or dark variant chosen from the
    preview background.
  - Settings: `markdown-preview-enhanced.readAloudEnabled` (default `true`),
    `readAloudClickToRead` (`true`), `kokoroVoice` (`af_heart`; `+` blends allowed),
    `kokoroBaseUrl` (`http://127.0.0.1:8880`, machine scope; plain http on localhost only),
    `readAloudSpeed` (0.25–4, default 1), `readAloudVolume` (0–1, default 1),
    `readAloudHighlightTheme` (`blue`, `pink`, `red`, `green`, `orange`), `readAloudFont`
    (`default`, `system`, `helvetica`, `verdana`, `trebuchet`, `georgia`, `palatino`,
    `baskerville`, `times`, `menlo`), `readAloudCacheSizeMB`; and for help
    `readAloudHelpEngine` (`claude`, `codex`, `custom`), `readAloudHelpClaudeModel`
    (`sonnet`), `readAloudHelpClaudeEffort` (`low`), `readAloudHelpCodexModel` (empty),
    `readAloudHelpCodexEffort` (`low`), `readAloudHelpCommand` (`[]`),
    `readAloudHelpContext` (`section`), `readAloudHelpAudience`, `readAloudHelpAutoPlay`
    (`true`), `readAloudHelpTimeoutSeconds` (90) and `readAloudHelpBinaryPath` (`{}`,
    machine scope, for the same reason as `kokoroBaseUrl`).
    Changes to any of them except `readAloudEnabled` apply live without reloading the preview.
  - Commands: `markdown-preview-enhanced.readAloud.readSelection` (`Alt+R`),
    `.togglePlayPause` (`Alt+Space`), `.stop` (`Alt+Esc`), `.chooseVoice` (QuickPick over
    `GET /v1/audio/voices` with grade, language and gender), `.clearCache`, `.showLog`,
    `.setup` (_Read aloud setup_ with **Check Kokoro Server**, `GET /health` plus the voice
    count).
  - Messages: webview → host `readAloudSynthesize` `[sourceUri, requestId, text, { kind,
blockId?, blocks? }]`, `readAloudCancel`, `readAloudPlaying`, `readAloudSetSpeed`,
    `readAloudSetVolume`, `readAloudSetHighlightTheme`, `readAloudSetFont`,
    `readAloudOpenSetup`; host → webview `readAloudAudio` (with
    `blockIndex`), `readAloudError`, `readAloudConfig` (which carries `font`),
    `readAloudControl`. Every payload is validated in
    `src/read-aloud/messages.ts` before the controller sees it.
  - Files: `src/read-aloud/*.ts` (controller, chunker, speakable, cache, messages, settings,
    error mapping, log, Kokoro client, types, voices, alignment, word spans),
    `media/read-aloud{,-core}.js` and `media/read-aloud.css` (webview, injected through the
    preview `head` like the lightbox), `src/types/intl-segmenter.d.ts`, `install.sh` (build,
    package and install the `.vsix` in one step), and fifteen mocha suites under
    `test/read-aloud/` wired into `test:unit`, among them `continuous-read.test.js` for the
    joined extraction and the re-render remap, `control-panel.test.js` for the panel and
    `theme-settings.test.js` for the theme sheet (the zoom bridge included, against a stub of
    crossnote's ctrl+wheel handler and against a page with no crossnote at all).
    devDependency `jsdom@23.2.0`.

  - **Control panel** (F3, revised 2026-09-03): the player bar is now a rounded panel floating
    at the bottom centre of the preview, on screen whenever read aloud is enabled, with seven
    controls — volume, theme settings, −10 s, a filled play/pause button, +10 s, the
    speed and a close ×. The progress of the read is traced along the top edge of the panel, and
    _Loading…_, _Paused_, _Finished_ and errors appear above it so the panel's shape never
    changes with the length of a message. Its light or dark palette comes from the preview
    background, like the reading decoration, not from the VS Code colour theme.
    - **Volume**: a slider popover, 0–100 %, applied to the audio element live and persisted in
      the new `markdown-preview-enhanced.readAloudVolume` setting (webview → host
      `readAloudSetVolume`, the mirror of `readAloudSetSpeed`). The glyph follows the level. The
      silent-wav unlock (see _Fixed_ below) is always played at full volume, because Chromium
      counts a volume of 0 as muted and a muted `play()` grants no permission.
    - **Speed**: a slider popover in the same style, replacing the select-plus-number-field pair;
      the button shows the current rate. `[` and `]` still step through the eleven stops. The
      speed label and both popover value boxes have a fixed width: the panel is centred on the
      viewport, so a label that grew with the value (`1×` → `1.15×`) shifted the whole pill on
      every tick of the slider. Neither slider has its value written back into it while it is
      being dragged, and neither carries a focus box — the focus ring sits on the thumb, and a
      popover opened with the mouse does not take focus at all.
    - **±10 s**: both skips stay inside the block being read, which is also the only block whose
      audio the memory rule keeps. A rewind that would land before the block's first word
      restarts the block; a forward that would land past its last synthesised word does nothing
      and the button greys out. A paused read stays paused at the new position.
    - **Play with nothing loaded** reads from the first block still on screen to the end of the
      document, so the panel — and `Alt+Space` — can start a read on their own.
    - **Close** stops the read and puts the panel away until the next one starts.
    - The voice button is gone with the rest of the bar; _Read aloud setup_ has its own palette
      command, **Markdown Preview Enhanced: Read Aloud Setup**.
  - **Theme settings** (`featrues/03-control-panel-addons.md`), behind the second button of
    the panel — a palette, in place of the voice-model placeholder — as a sheet in the panel's
    own palette anchored above it: the player font, the player font size and the highlight
    theme. _Global theme_ from the reference (`featrues/control2.png`) followed in 05, below.
    - **Player font**: an override for the preview theme's own family, applied to the preview
      root so code, diagrams and maths keep their own. Ten choices, each a stack that degrades
      to a generic family where the first name is missing, and every one a family a machine
      already has: the webview never fetches a font. Persisted in the new
      `markdown-preview-enhanced.readAloudFont` setting (webview → host `readAloudSetFont`,
      carrying the id only — the stacks live in `media/read-aloud-core.js`, so nothing the
      webview sends can become a `font-family` on the host).
    - **Player font size** _is_ the preview's zoom, the one behind crossnote's own Zoom In /
      Zoom Out: the slider moves in the same 0.1 steps, between 0.6 and 2, and drives them by
      dispatching the synthetic ctrl+wheel events crossnote's own capture-phase handler is
      listening for, so its `zoomLevel` state, the `Zoom (110%)` label of its context menu and
      the elements it un-zooms (the panel among them) all stay in step. The label names the
      resulting size in pixels, measured from the preview's own font size while the page is at
      zoom 1. On a page with no crossnote on it the sheet notices after the first change and
      sets `document.body.style.zoom` itself. Like crossnote's own zoom, it is not persisted.
    - **Player highlight theme**: the five palettes as cards, each painting three lines of
      sample text with one word spoken in the palette it offers, in the panel's own light or
      dark scheme. The choice is applied at once and persisted through
      `readAloudSetHighlightTheme`.
  - **Help** (`featrues/04-help-module.md`): a `?` button on the panel, between the speed and
    the close ×, enabled when a selection can be read or a selection read is playing. It
    pauses the read, asks a headless CLI — `claude -p` by default, `codex exec -` or a custom
    command (`readAloudHelpEngine`, `readAloudHelpCommand`), with the model and effort per
    engine (`readAloudHelpClaudeModel` + `readAloudHelpClaudeEffort`: `fable` / `opus` /
    `sonnet` × `low` … `max`; `readAloudHelpCodexModel` + `readAloudHelpCodexEffort`: a model
    id × `none` … `ultra`; or the _Choose Help Model_ quick pick, also behind the sheet's own
    label) — for a five-part explanation of the passage written for the ear (gist, terms,
    restatement, example, why it matters; about as long as the passage, never more than two
    minutes of audio), with the enclosing section as context (`readAloudHelpContext`) and the
    audience from `readAloudHelpAudience`. The answer is rendered through the preview engine
    into a sheet above the panel, read aloud at once (`readAloudHelpAutoPlay`) as a read
    bounded to the sheet, and the paused read resumes from the same word. _Simpler_,
    _Deeper_, _Example_ and a _What confused you?_ box ask follow-ups with the previous
    explanation attached. Answers are cached by content in `globalStorageUri`; the raw HTML of
    an answer is escaped before rendering; the binary is found through the login shell or
    `readAloudHelpBinaryPath` (machine scope). Desktop only. `Alt+H`. This is the first
    read-aloud feature that sends document text off the machine, and only on the button.
    - **The sheet is a second reading scope**: the same player, panel, highlighting and
      click-to-read, over the blocks of the sheet body instead of the preview root. A read in
      the sheet is `kind: 'help'` and ends at the sheet's last block, the way a table-cell
      read ends at its cell; the document's continuous read never enters the sheet and a help
      read never leaves it. The sheet body deliberately does not carry `.mpe-ra-ui`, so its
      rendered paragraphs, lists and headings are classified by the existing eligibility
      rules with no new code. Because the sheet lives outside the preview DOM, crossnote's
      `updateHtml` never replaces it and none of the re-render machinery applies to it.
    - **Pause and resume**: the help button remembers where the read was — a block read by the
      block's content hash and the word offset inside it, a selection read by its text, offset
      map and elements — cancels the job with reason `help` and releases its audio. _Resume_
      closes the sheet and continues from the same word, re-locating the block after an edit
      elsewhere in the document; once the paused block is gone, _Resume_ is disabled and its
      tooltip says why.
    - **The engine** is spawned with an argv array, never a shell, in a fresh empty directory
      under the temp dir, so no project's `CLAUDE.md` or `AGENTS.md` is auto-loaded into the
      prompt. `claude` gets `--tools ""`, `--no-session-persistence`, `--disable-slash-commands`
      and the explanation prompt as `--system-prompt` (`--bare` is deliberately not used: it
      would restrict auth to `ANTHROPIC_API_KEY` and break a subscription login); `codex exec -`
      gets `-s read-only`, `--ephemeral` and writes its answer to a file. Cancel and timeout
      send SIGTERM then SIGKILL after 3 s. The binary is resolved from
      `readAloudHelpBinaryPath`, then the current `PATH`, then the login shell.
    - **Untrusted output**: the document is untrusted input to the model and the answer is
      untrusted markdown, so every `<` is escaped and `javascript:`, `data:` and `vbscript:`
      link targets are neutralised before the preview engine renders it. The prompt also
      forbids HTML, but the escape is the guarantee.
    - Commands `markdown-preview-enhanced.readAloud.help` (`Alt+H`) and
      `.readAloud.help.chooseModel`; messages webview → host `readAloudHelp`,
      `readAloudHelpCancel`, `readAloudHelpChooseModel` and host → webview
      `readAloudHelpResult`, `readAloudHelpError` plus the new `help` action of
      `readAloudControl`; `readAloudConfig` now also carries `helpAvailable`, `helpEngine`,
      `helpModel`, `helpEffort`, `helpAutoPlay` and `helpContextMode`. `readAloud.clearCache`
      empties the help answers as well. One line per request in the _MPE Read Aloud_ channel:
      engine, model, effort, context mode, character counts, cache hit or miss and duration,
      never the text.
    - Files: `src/read-aloud/help-{prompt,engine,cache,answer}.ts`, the help section of
      `media/read-aloud.js` and `helpContext` in `media/read-aloud-core.js`, `§3d` of
      `media/read-aloud.css`, and the mocha suites `help-prompt.test.js`,
      `help-engine.test.js` and `help-sheet.test.js`.
  - **Low-strain reading page** (`featrues/05-eye-strain.spec.md`, from the requirement in
    `featrues/05-eye-strain.md`): a **Global theme** row at the top of the theme settings sheet —
    _Auto · Light · Dark_, the row the reference (`featrues/control2.png`) had and 03 left out —
    that replaces the preview theme with a reading page built to the requirement: the Atkinson
    Hyperlegible Next face bundled with the extension (`media/fonts/`, SIL OFL 1.1; the Latin
    subsets Google Fonts serves, one variable file for the 400 and 600 weights and one static
    italic, 48 KB in all), 20 px body text (18 px under 48 rem), a 66-character column centred
    on a darker canvas, weights 400 and 600 only, underlined links, and colour tokens for every
    surface a preview theme paints — text, canvas, rules, code, quotes, tables, admonitions,
    callouts, focus, the panel, a syntax palette for code blocks — in a light set checked at
    WCAG AAA and a dark set checked with APCA (`test/read-aloud/page-tokens.test.js` computes
    both formulas, pinned to APCA's reference pairs; two of the requirement's dark estimates
    failed its own targets and were corrected, `--text-muted` `#d0d0d0` and `--mark-bg`
    `#85691a`, and the test nudged two more, the light mark border `#b07f0a` and the dark error
    text `#f8d0d0`). `::selection` passes the dual test in both schemes; `<mark>` is amber with
    a bottom border on light. _Auto_ follows VS Code's colour theme kind live (the body classes,
    with `prefers-color-scheme` before the body exists), _Light_ and _Dark_ force one, and
    `off` — Settings only — is the pre-05 preview exactly. The page lives on
    `<html data-mpe-ra-page>`, written at script evaluation so a cold load never flashes the
    wrong theme, and everything that already keyed on `data-mpe-ra-scheme` (pills, panel,
    sheets, swatches) follows it. Two more sheet rows, **Line height** (1.4–1.8, default 1.6;
    the pill padding now derives from it so the lines of the block being read always fuse) and
    **Column width** (50–75 ch),
    a **Reset page settings** button that clears the page settings and the zoom, and a one-line
    reader guidance caption. Settings `markdown-preview-enhanced.readAloudGlobalTheme` (`auto`),
    `readAloudLineHeight` (`1.6`), `readAloudColumnWidth` (`66`), all live without a reload;
    messages `readAloudSetGlobalTheme`, `readAloudSetLineHeight`, `readAloudSetColumnWidth`,
    `readAloudResetPage`; `readAloudConfig` carries the three values. While the page is on,
    `previewTheme`, `previewColorScheme` and `codeBlockTheme` only affect exports; diagram
    themes are not overridden. Desktop only, live preview only, never in an export. Files:
    `media/read-aloud-page.css`, `media/fonts/*`, the page section of `media/read-aloud.js`,
    the resolver and normalisers in `media/read-aloud-core.js`, and the suites
    `page-tokens.test.js` and `page-theme.test.js`. Of the spec's manual acceptance checks
    (§13) only the stylesheet's rendering was checked in a browser against crossnote's own
    theme files; the Extension Development Host checks are still to be done. The first of them
    found the page's colour never reaching running text under the `night` preview theme (nor
    would it under `gothic` or `medium`): those themes colour `p`, `li`, `table`, `dt` and
    `.math` directly, which beats inheritance from `body` whatever the specificity, so on
    _Light_ paragraphs and list numbers stayed the theme's `#dedede` on the off-white column,
    and the sheet's caption — a `<p>` — with them. The page now names those elements (and `dd`,
    `td`, `.mathjax-exps`), the sheet's two paragraphs inherit the panel colour, and the token
    test scans the bundled themes for element-level colour rules and holds the page to them.
  - **One reading rhythm for the whole canvas** (`.mpe-ra-canvas`): the 2.0 line height that used
    to be applied to the block being read moved to the whole preview at 1.85, together with even
    spacing for paragraphs, lists, blockquotes, tables and headings. Starting a read no longer
    reflows the block or pushes the rest of the document down — the pill's padding is cancelled
    by a negative margin on both axes, so a decorated line occupies exactly the space the
    undecorated one did (measured: identical block height and identical position of the next
    heading). Everything is in `em`, so crossnote's zoom in / zoom out scales the canvas and its
    decoration proportionally; the panel carries Tailwind's `fixed`, which crossnote's zoom
    effect uses to keep it the same size on screen while the text zooms. The preview also gets
    bottom padding while the panel is up, so it never covers the last lines.

### Changed

- `engines.vscode` raised from `^1.70.0` to `^1.82.0` and `@types/vscode` to `1.82.0`, so the
  extension host can use native `fetch` for the Kokoro calls (no SDK dependency).
- Changes to the read-aloud settings (all but `readAloudEnabled`) no longer reload every preview
  panel, so a speed or voice change does not interrupt playback. Every other
  `markdown-preview-enhanced.*` change still refreshes the previews as before.
- The reading canvas takes its line height from the low-strain page (1.6 by default, sliders
  1.4–1.8) while the page is on; the 1.85 rhythm of 02 remains for `readAloudGlobalTheme: off`.
- The reading decoration is one continuous shape again, as in the reference reader: the pill
  padding is derived from the line height so that adjacent line fragments overlap by the corner
  radius (0.4 em) at every rhythm, the horizontal padding grew to 0.4 em, and the spoken-word
  box stands a step proud of the pill on all four sides. The padding is shifted 0.08 em
  downwards, because the face's ascent stands far above its capitals while its descent sits
  close to its descenders, and equal padding left the last line looking cut off. Both paddings
  are still cancelled by negative margins, so starting a read moves nothing. On the dark page the canvas is the same
  colour as the column, so there is no darker band around it.
- Single-cell table selection is decided by the cells the range covers with text, not by the
  containers it starts and ends in (Chromium switches to cell-based ranges as soon as a drag
  brushes a cell border).
- Word highlighting does not use the CSS Custom Highlight API named in spec F4: `::highlight()`
  cannot draw padding or rounded corners, so the webview wraps the spoken word and each inline
  run in transient spans instead and removes them when the read ends.
- `README.md` gained the "Read aloud (Kokoro)" section (server setup, settings, reading to the
  end of the document, click to read, selection, speed, highlight theme, what is sent, privacy,
  cache and log, keybindings, limitations) and three rows in the shortcut table.

### Removed

- ElevenLabs support (client, key storage, voice and model resolution, cost guard, prosody
  context, the sent-text log and its `logs/` handling, the `readAloudProvider`,
  `elevenLabsVoiceId`, `elevenLabsModelId`, `elevenLabsBaseUrl` and `readAloudConfirmAbove`
  settings and the `readAloud.setApiKey` / `.clearApiKey` commands) was built and then removed
  before the first release; Kokoro is the only engine. The implementation remains in history
  (commit `3e25dc4`, _Read aloud: ElevenLabs + Kokoro, before cleanup_).

### Fixed

- **The player's root classes survive a crossnote render.** crossnote's React root rewrites
  the preview root's `class` attribute on every render, including renders that change no child
  node — the second render of an `updateHtml`, a zoom, a scroll-sync message — and the player
  only re-added its classes after a child-node mutation. So after the first edit of a document
  the reading canvas lost its rhythm and the pills their padding variables (which is why the
  block being read looked cut off at the bottom: the pill fell back to symmetric padding with
  no shift), click-to-read lost its pointer and the panel its clearance. A second observer on
  the root's `class` attribute now puts the classes back, and the pill's constants carry their
  canvas values as fallbacks so the decoration is right even between the render and the
  restore.
- **The spoken-word box is no longer cut flat at the bottom by the line below.** Inline boxes
  are painted line by line, so the pill fragment of the next line — painted after the line the
  word is on — covered the part of the word box that stands below its line; the box kept its
  full height only where the next line was too short to reach it, which is what made its
  bottom edge uneven. `.mpe-ra-word` is now relatively positioned (no offset, so nothing
  moves), which paints it after every line of the block and above all the pill fragments, so
  it stands proud on all four sides as intended.
- **The floating _Read aloud_ affordance no longer disappears when a slow drag ends.** The
  mouseup that finishes a drag-selection also fires a `click`, and the click handler dismissed
  the affordance on any click outside its own UI. For a quick drag the 150 ms selection debounce
  put it straight back, which is why this went unnoticed; for a drag with a pause in it the
  affordance appeared during the drag and vanished on release. The click now dismisses it only
  when the click actually left no selection behind — a plain click has already collapsed the
  selection by the time the handler runs, so that case is unaffected. The help button follows
  the same predicate and had the same symptom, and like the affordance it now suppresses the
  default on its own `mousedown`, so pressing it cannot collapse the selection it is about to
  explain.
- **Reads no longer stop after the first chunk.** VS Code's webview iframe is not granted the
  `autoplay` permission, so Chromium lets a media element play only if `play()` was first called
  on it within about five seconds of a click or key press in the preview. The player used to
  create a fresh `<audio>` per chunk: the first chunk (~250 characters, "a few sentences")
  always played and every later one was refused with `NotAllowedError`, which is what made
  every read die after a sentence or two. The webview now keeps a pool of two `<audio>`
  elements, unlocks them on the user's own gesture (mousedown, click or keydown, by playing
  100 ms of silence) and reuses them for every chunk of every read, one playing while the other
  preloads the next chunk (`media/read-aloud.js` §11a). A chunk keeps its blob URL until its
  block is finished and hands its element back the moment it ends. If a read is started with
  no gesture in the preview at all (a command from the palette on a fresh preview), the bar
  says _Audio is blocked until you click in the preview_ instead of _Could not play the audio_.
  New mocha suite `test/read-aloud/player.test.js` (7 tests) drives the real player under jsdom
  with fake media elements through a multi-block read, the loading state between chunks, a
  re-render, the hand-off, the release of finished audio and a second read with no new gesture.
- `readAloudCancel` now carries a third argument, the webview's reason for giving the job up
  (`stop`, `superseded by a new read`, `audio: NotAllowedError: …`, `next block gone`, …), which
  the host writes into the _MPE Read Aloud_ channel as `tts cancelled … reason=webview (…)`; an
  audio failure also names the DOMException in the bar and in the webview console.
- A whole-block read of a blockquote or list item that contains a code fence, table, diagram,
  embed or code chunk does not speak that nested content: text extraction skips every nested
  exclusion, the same way the reading decoration leaves them undecorated. Prose beside the nested
  block is still read.

### Security

- Text is sent to the local Kokoro server only when the user presses play, clicks a word, uses
  the selection affordance or runs a read-aloud command; opening a preview makes no request.
- `kokoroBaseUrl` is declared with `"scope": "machine"` so a workspace's `.vscode/settings.json`
  cannot redirect the text of a document to another host, and the setting accepts plain `http`
  on the loopback interface only; anything else must be `https`.
- Every webview → host read-aloud message is validated for shape, and the ones that carry a
  `sourceUri` must match the panel's current target before they are dispatched.

## [0.8.32-personal] - 2026-09-01

Fork created from upstream `develop` at 0.8.32 (tag `baseline-0.8.32`).

### Changed

- Rebranded to a distinct extension identity — `name` →
  `markdown-preview-enhanced-personal`, `publisher` → `andrew`, `displayName` →
  `Markdown Preview Enhanced (Personal)`. Decouples this build from
  `shd101wyy.markdown-preview-enhanced` so a Marketplace release cannot auto-update over
  it. Configuration keys (`markdown-preview-enhanced.*`), command IDs, and the custom-editor
  `viewType` are deliberately unchanged, so existing settings and keybindings carry over.
- Replaced `README.md` with fork-specific documentation: identity, build/install commands,
  and the F5 development loop. The upstream README remains available at
  `git show baseline-0.8.32:README.md`.

### Added

- This changelog.
