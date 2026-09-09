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
    `readAloudHelpEngine` (`claude`, `codex`, `copilot`, `custom`; machine scope), `readAloudHelpClaudeModel`
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
    pauses the read, asks a headless CLI — `claude -p` by default, `codex exec -`, `copilot -p`
    (below) or a custom command (`readAloudHelpEngine`, `readAloudHelpCommand`), with the model and effort per
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
    `page-tokens.test.js` and `page-theme.test.js`. The spec's fifteen §13 acceptance checks were run on
    2026-09-04 in an Extension Development Host driven over the Chrome DevTools Protocol (an
    isolated profile, a `page-check.md` with every surface the page paints, `test-file.md`),
    all passed: 1 cold load — `dark` under a light VS Code and `light` under a dark one, the
    attribute written by the head script with the stylesheet linked before it; 2 _Auto_
    following a colour-theme switch in the same tick as VS Code's body classes, the 150 ms
    crossfade, the word cursor still advancing, no reload; 3 `atom-dark` and `github-light`
    rendering identically under the page (a computed-style fingerprint of 322 elements) and an
    offline HTML export carrying no page attribute, stylesheet, script or font; 4 `off` against
    a build of `0d2e7c9` on the same document, element for element (322 computed-style rows,
    zero differences, the 1.85 rhythm and 1.1 em gap) — only the pill padding differs, on
    purpose (see _Changed_); 5 the syntax palette on TypeScript, JSON and diff fences under
    _Dark_ over `github-light` with `auto.css`; 6 admonitions and callouts of every type on
    both schemes; 7 the WCAG 1.4.12 spacing overrides in and out of a read with nothing clipped
    (crossnote's callout title overflows its box by 3 px on its own, overrides or not); 8 zoom
    2 in a 752 px pane — no horizontal scrollbar, code and tables scrolling inside themselves,
    the panel at its 412 px and 13 px; 9 the font files renamed — `system-ui` at the same
    sizes and weights, the font row still _Default_; 10 `prefers-reduced-motion` removing every
    transition, the switch then instant; 11 print emulation black on white with the column
    released and the controls hidden; 12 every stop of the sheet — three segments, the select,
    three sliders, five swatches, reset — with a `--focus` ring (the sliders' on the thumb),
    Space choosing a segment, Escape closing the sheet with the read still running (a second
    Escape stops the read only while focus is inside the panel, as 03 built it; closing the
    sheet leaves focus on the body; arrow keys inside the group, a MAY, are not built); 13
    selection across a paragraph and inside the block being read on both schemes; 14 the help
    sheet in Atkinson with the pill text token, _Resume_ resuming; 15 `media/fonts` at 48 KB.
    Four things the checks found are fixed. Under the `night` preview theme (and `gothic` and
    `medium`) the page's colour never reached running text: those themes colour `p`, `li`,
    `table`, `dt` and `.math` directly, which beats inheritance from `body` whatever the
    specificity, so on _Light_ paragraphs and list numbers stayed the theme's `#dedede` on the
    off-white column, and the sheet's caption — a `<p>` — with them; the page now names those
    elements (and `dd`, `td`, `.mathjax-exps`), the sheet's two paragraphs inherit the panel
    colour, and the token test scans the bundled themes for element-level colour rules and
    holds the page to them. A `#tag` was the link blue on VS Code's badge background
    (`--vscode-badge-background`, which follows the editor's theme: `#616161` behind `#1f4e8c`
    on the light page under a dark VS Code); tags keep crossnote's badge shape on the page's
    `--code-surface` in `--link`, and the token test holds that pair. Code blocks under nine of
    the bundled prism themes (`atom-*`, `one-*`, `monokai`, `solarized-*`, `pen-paper-coffee`,
    which `codeBlockTheme: auto.css` selects from the preview theme) kept the prism theme's
    background, because those themes declare it `!important`; the page's `pre` background and
    padding (1 em) are now `!important` too — the two exceptions to the stylesheet's
    no-`!important` rule, with the TOC's the third: crossnote writes the sidebar TOC's
    background as an inline style from its own light/dark detection (`prefers-color-scheme`,
    which in the webview follows the OS, so the TOC was `#181818` on the light page), so the
    page's TOC background is `!important` and its links take `--link`.
  - **Eye strain 2** (`featrues/07-eye-strain-2/spec.md`, from the three-model analysis in
    `featrues/07-eye-strain-2/06-eye-strain-2.md`): the theme settings sheet's three typographic
    sliders become one, **Text size** (16–28 px, default 20,
    `markdown-preview-enhanced.readAloudTextSize`), from which the line height (1.70 at 16 px to
    1.45 at 26 px and above, 1.60 at 20), the heading sizes (now in `em`) and the reading column
    derive. The column is **66 characters of prose**, measured: the player lays out a sample
    passage in the face in use and sets the measure in `em` from its average advance, so 66 means
    66 in Atkinson, Georgia or Verdana (the 05 column, `66ch`, held 83–84 characters, because `ch`
    is the width of the digit zero). The reading page now **follows the reading**: the spoken line
    is kept near the upper third of the viewport and the page eased there continuously instead of
    jumped by half a screen; a wheel, a key, a scrollbar drag or a scroll-sync from the editor
    suspends the following until a _Back to the reading_ chip, a play, a skip or a scroll that
    brings the word back is seen; under `prefers-reduced-motion` the page jumps instead of easing.
    While a read plays every other readable block is **dimmed by colour** in two tiers — the next
    block less (`#626261` / `#c1c1c1`), the rest to a measured floor (`#858483` at 3.4:1 /
    `#a2a2a2` at Lc 51) — over a 220 ms ramp; code, tables, maths and images are never dimmed
    (`readAloudDimWhileReading`, default on). The spoken word is marked by an **underline sweep**
    in a per-palette stroke colour at 3:1 against its pill, in place of the filled box, which stays
    as _Box_ beside _Off_ (`readAloudWordMarker`, a segmented row on the sheet; the swatch cards
    paint the chosen style); the light blue box and the dark blue, pink, green and orange boxes are
    nudged so text on them reaches 4.5:1. The panel **fades after 3 s** of playback without
    activity, leaving a 3 px progress strip at the bottom edge, and returns on any movement, key,
    pause, message or hover (`readAloudPanelAutoHide`, default on); only keyboard focus
    (`:focus-visible`) inside the panel pins it, so the button the mouse clicked to start the read
    does not. The read takes a **400 ms breath between blocks and 900 ms after a heading**,
    divided by the rate; the rAF loop keeps running through the gap for the follow step alone, so
    an ease under way is not frozen. Light links are a low-chroma ink blue (`#33475f`, 8.7:1);
    prose gets `text-wrap: pretty`. The token test now parses the highlight palettes too.
    Validated on 2026-09-04 in Chrome through the Claude in Chrome tools against `test/harness/`
    (the real player and stylesheets, a host shim bundled from the chunker and the Kokoro
    alignment, Kokoro itself over CORS or a silent stand-in) — checks H1–H12 of the spec, all
    passed: H1 the slider at 16 and 28 gave computed body sizes of 16 and 28 px, line heights 1.7
    and 1.45, `h1` at 25.6 and 44.8 px (1.6×), one `readAloudSetTextSize` per drag, the panel at
    13 px throughout; H2 a median of 64 characters per full line at 20 px in Atkinson (measure
    29.07 em), 65 in Georgia (28.91 em) and 65 in Verdana (33.69 em), none above 72, the column
    `content-box` at the measure; H3 over 12 s of playback the spoken word's top stayed within
    0.383–0.413 of the viewport, no scroll step over 65 px, no `scrollIntoView`; H4 a wheel froze
    the page and showed the chip, the chip brought the word back into the band in 434 ms, a
    scroll back into the band re-engaged on its own; H5 near `#626261`, far `#858483`, the
    active block `#2b2b2b`, `pre` and `table` untouched, the classes moved at the hand-off and
    survived `mpeHarness.rerender()`; H6 the box `#788cf0` with no shadow, off transparent, the
    underline a `#697cd8` inset shadow at 3.12:1 on the pill, the block height (256 px) and the
    next heading's `offsetTop` (670 px) identical before and during the read under all three;
    H7 after 4 s the panel at opacity 0 and `pointer-events: none` with the strip at 36 %, back
    at opacity 1 within 200 ms of a mouse move, never while paused; H8 gaps of 402–403 ms after
    paragraphs and 903 ms after a heading at 1×, 202–203 and 451–452 ms at 2×, none inside a
    block; H9 the light link `#33475f`, underlined, focus ring `#1f4e8c` on Tab; H10 on the
    dark page every palette's text on the box 4.67–4.91:1 and stroke on the pill 3.05–3.09:1;
    H11 under `off` no page attribute or properties, the preview theme's font, the slider
    disabled with the hint shown, the marker still applied, no tier classes, the following and
    the fade working; H12 no console error, dropped message or unhandled rejection. Two
    observations from the run: an automated click with no preceding pointer movement, landing
    while the panel is faded, is hit-tested through the invisible panel (a real mouse moves first
    and wakes it); and the harness's per-line character count splits a line at an inline `code`
    or `mark` (the medians are unaffected). Then in the Extension Development Host over the
    DevTools Protocol (an isolated profile, `test.md` built from the fixture's prose, the preview
    beside the editor): the settings round trip applied `readAloudTextSize` and
    `readAloudWordMarker` from the profile's `settings.json` to the page in 318 ms with the read
    playing on; under emulated `prefers-reduced-motion: reduce` the page jumped to the anchor with
    no intermediate position and the tier ramp and the panel fade computed to 0 s, and with the
    preference off the same read eased in steps of 1–92 px; typing in the editor mid-read kept the
    47 tier classes, the pills and the marker on the re-rendered elements while the edit's scroll
    sync moved the preview and suspended the following with the chip shown; `readAloudGlobalTheme:
off` mid-read dropped the page, its properties and every tier class and kept the marker and
    the read, and `auto` brought them back; an offline HTML export carried no tier class, marker
    attribute, page attribute, pill or read-aloud reference. The `off` fingerprint against the 05
    §13.4 recording and a separate cursor-driven scroll-sync check were not run (the recording is
    not in the repository; the edit's sync covered the suspension). One defect surfaced there and
    is fixed: crossnote's preview root computes `overflow-y: auto` without ever scrolling, and
    the follow loop had taken it for the scroll container, so the page never moved in the real
    webview (it had in the harness, whose root has no such rule); an ancestor now counts only
    when it actually overflows. Messages
    `readAloudSetTextSize`, `readAloudSetWordMarker`; `readAloudConfig` carries `textSize`,
    `wordMarker`, `dimWhileReading`, `panelAutoHide`. Files: `media/read-aloud-page.css`,
    `media/read-aloud.css`, `media/read-aloud{,-core}.js`,
    `src/read-aloud/{messages,settings,controller}.ts`, `test/harness/`, and the suites
    `page-typography`, `follow-scroll`, `dim-tiers`, `word-marker`, `panel-autohide`.
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

- **Notes** (`featrues/12-notes/spec.md`, brief in `ui-brief.md`): a **Note** button on the
  selection cluster (`Alt+N`) that keeps a passage for later. The click writes a markdown
  file at once — the exact words, the block they sit in with the passage marked between ⟦
  and ⟧, the block before and after, the heading path, the document's title, path and git
  commit, and an anchor — and then asks the help engine, with help's own material, for a
  title, a two-sentence summary, why the passage matters, its terms and a few tags, written
  for the eye (`src/notes/note-prompt.ts`, §21). A five-word selection gets the term shape
  (_What it means here_, _In general_). **Save as note** on the Help sheet keeps the
  explanation on screen as a note with no second engine call. Notes show as a quiet marker
  in the **right margin** of their block (count badge, title tooltip) and a dotted mark under
  the words through the CSS Custom Highlight API — no DOM, so extraction and the offset map
  never see it — both dimming with the tiers and the mark stepping aside for the block being
  read. A marker or the words open the **Note sheet** (the help sheet's shape and the reader
  template): passage, generated sections, an editable _My note_ that saves as you type,
  editable tags, collapsed context, Regenerate, Open in editor, Copy as markdown, Delete
  with a six-second Undo before the file goes to the OS trash, a pager in reading order, and
  Play, which reads the sheet as a bounded `kind: 'note'` read and pauses a document read
  with Resume. A **Notes** button on the bar (`Alt+Shift+N`) lists the document's notes in
  reading order, orphans last; a **Notes** view in the Explorer lists every document's notes
  with counts, dates and tags, opens them in the preview, and _Search notes_ is a quick
  pick across all of them. Notes **re-anchor on every render**: by the block's content key,
  then by the exact passage with its prefix and suffix, then by a fuzzy match of the
  enclosing block; a note that cannot be found is **orphaned** — kept, badged _Not in this
  version_, its saved context shown, _Re-attach to selection_ offered — never dropped and
  never written into the document. **Storage** is one `.md` per note with YAML front matter
  under `~/.crossnote/notes/<workspace>/<relative path>/` (`notesDirectory`, machine scope,
  to move it): hand-editable, greppable, sync-friendly, no index, atomic writes, hand edits
  preserved on rewrite. Settings `notesEnabled`, `notesDirectory`, `notesGenerate`,
  `notesDecoration`; the engine, model and effort are the help settings. Desktop only. Notes
  copy document text outside the repository, said in the setting's description.
  - Messages: webview → host `readAloudNoteCreate`, `readAloudNoteUpdate`,
    `readAloudNoteDelete`, `readAloudNoteUndoDelete`, `readAloudNoteRegenerate`,
    `readAloudNoteReattach`, `readAloudNoteOpen`, `readAloudNoteCopy`,
    `readAloudNoteAnchors`, `readAloudNotesShowAll`; host → webview `readAloudNotes`,
    `readAloudNoteError`, `readAloudControl` actions `note`, `notesList`, `showNote`;
    `readAloudConfig` carries `notesAvailable` and `notesDecoration`. Every payload is
    validated in `messages.ts` first.
  - Files: `src/notes/{note-format,notes-store,note-prompt,notes-controller,notes-tree}.ts`,
    the notes layer of `media/read-aloud.js`, `noteAnchorFor` and `anchorNotes` in
    `media/read-aloud-core.js`, §3e of `media/read-aloud.css`, the note tokens in
    `media/read-aloud-page.css`, the view and commands in `package.json`; dependency
    `yaml@2.9.0`; suites `test/notes/{note-format,notes-store,note-prompt}.test.js`,
    `test/read-aloud/{note-anchor,notes-sheet}.test.js` and new cases in `messages.test.js`
    and `help-sheet.test.js`; `notes=1` in `test/harness/`.

- **Classroom** (`featrues/13-classroom/spec.md`, recommendation and measurements beside
  it): a **Classroom** button on the selection cluster (`Alt+C`) and **Teach me this** on the
  Help sheet, for the passage the explanation was not enough for. A sheet asks how lost the
  reader is, in three rows with an optional sentence in their own words, shows the
  instructor (**Max**, a patient practitioner whose voice and chapter structure come from an
  authoring guide shipped as a persona package), the audience line, the engine label and
  exactly which files will be sent, and **Build** has the help engine write a teaching
  **module** the way the guide says a course is written: one call for the plan, then one
  call per chapter in course order, each briefed with the previous chapter's closing bridge,
  the next chapter's question, the promises due and the running examples, each checked
  mechanically (no em dashes, tables, links, code or emoji; the pickup echoes the bridge;
  the length fits the chapter type) with one retry, and appended to a markdown file under
  `~/.crossnote/classroom/modules/<workspace>/<relative path>/` (`classroomDirectory`,
  machine scope). The module opens **beside** the source document as soon as its first
  chapter is on disk and is a document like any other from then on: read aloud, followed,
  dimmed, explained, noted. It opens by quoting the passage with a link back to its source
  line and closes with a chapter that walks the passage sentence by sentence. In a module's
  preview a bar button (`Alt+Shift+C`) opens the **Module sheet** with progress, the chapter
  list, Cancel, **Continue** for a stopped or failed build, and _Open the source passage_,
  which reveals the passage in the source preview through its anchor. The fuel is the whole
  document with the passage marked (120,000 characters) plus up to four linked workspace
  markdown files (`classroomFollowLinks`), all named and untickable before Build. Every call
  of a build runs from one working directory so the persona-and-fuel prefix is cached: a
  six-chapter module at `claude · sonnet` measured at about two minutes and thirty cents.
  _Open Classroom Module_ lists every module across documents. Personas are folders
  (`persona.md`, optional `specimen.md`); user personas under
  `~/.crossnote/classroom/personas/<id>/` are listed beside the built-in one and may replace
  it. Settings `classroomEnabled`, `classroomDirectory`, `classroomPersona`,
  `classroomAudience`, `classroomFollowLinks`, `classroomAutoOpen`; the engine, model and
  effort are the help settings. Desktop only. Classroom sends the whole document and the
  ticked linked files to the engine, on Build only, and copies document text outside the
  repository; both are said in the settings' descriptions.
  - **A small item gets a small module** (13 §6.1, D22): a selection of five words or fewer
    is a term, by the predicate Help and Notes use, and takes two chapters at the first lever
    row and four at the second, with concept and return chapters of 350 and 400 words; the
    third row is unchanged. A size line under the lever says what the checked row buys
    (_2 chapters · about 5 minutes_) before Build. `classroomShortTermModules` restores the
    full budgets; a persona may set `termLevels`.
  - **Modules in the margin, deletable** (13 §12.5, §11.4, D23–D24): every module is kept
    against its passage like a note and shows as a mortarboard marker in the right margin of
    its block, re-anchored on every render with the notes' anchoring, stacked under a note
    marker when both are there, with a count badge for several and a `3/6` badge while a
    build runs; a click opens the module, or the Classroom sheet with that block's rows first.
    Modules can be deleted from the sheet's rows, the Module sheet and _Delete Classroom
    Module_: a running build is cancelled, six seconds of _Module moved to Trash · Undo_, then
    the file goes to the OS trash. The module store gains the notes store's watcher and soft
    delete; `classroomMarker` turns the markers off.
  - Messages: webview → host `readAloudClassroomPrepare`, `readAloudClassroomBuild`,
    `readAloudClassroomCancel`, `readAloudClassroomContinue`, `readAloudClassroomOpen`,
    `readAloudClassroomOpenSource`, `readAloudClassroomOpenFolder`,
    `readAloudClassroomDelete`, `readAloudClassroomUndoDelete`; host → webview
    `readAloudClassroomPrepared` (with the budgets per shape), `readAloudClassroomProgress`,
    `readAloudClassroomError`, `readAloudClassroomModules`,
    `readAloudControl` actions `classroom`, `classroomModule`, `revealAnchor`;
    `readAloudConfig` carries `classroomAvailable` and, in a module preview,
    `classroomModule`. Every payload is validated in `messages.ts` first.
    `runHelpEngine` takes an optional `cwd` and reports the CLI's cache reads.
  - Files: `src/classroom/{persona,plan-prompt,chapter-prompt,ledger,checks,module-format,module-store,links,classroom-controller}.ts`,
    `src/classroom/personas/max/`, `src/read-aloud/git-info.ts` (lifted from the notes
    controller), the classroom layer of `media/read-aloud.js`, §3f of `media/read-aloud.css`,
    the tokens in `media/read-aloud-page.css`, the commands and settings in `package.json`;
    suites `test/classroom/*.test.js`, `test/read-aloud/classroom-sheet.test.js` and new
    cases in `messages.test.js`, `help-engine.test.js`, `help-sheet.test.js`,
    `control-panel.test.js`; `classroom=1` and `module=1` in `test/harness/`.

- **Retell** (`featrues/15-convert-readable/spec.md`, suggestions and measurements beside
  it): a **Retell** button on the selection cluster (`Alt+T`) and **Retell the section** on
  the Help sheet, for a section that reads well on the page and badly out loud. It writes a
  **spoken edition** of the section: the same content, in the same order, under the same
  headings, with every table said as sentences, every code block said as what the code does,
  and every identifier said as a spoken name. Nothing is added and no rule is dropped. A sheet
  names the sections that will be sent with their word counts by kind, the engine label, and
  the estimate (1.4 times the source's words, and the minutes at the measured 142 words a
  minute, against 150 for a classroom module), and **Build** runs one help-engine call per h2
  section, in order, each answer checked mechanically — no em dashes, tables, links, inline
  code, HTML, emoji or fences; no identifier with a dot, slash, tilde or angle bracket in it;
  the source's headings verbatim and in order (a uniform level shift is put back, never
  retried); sentences of twenty words on average and none over thirty-five; a runaway ceiling
  at 1.8 times the source — with one retry on a hard failure (the two sentence and length
  rules are soft: flagged, never retried on their own), then appended to a markdown file
  under `~/.crossnote/retell/editions/<workspace>/<relative path>/` (`retellDirectory`,
  machine scope). The edition opens **beside** the source document as soon as its first
  section is on disk and is a document like any other from then on: read aloud, followed,
  dimmed, explained, noted, taught. Every section carries a link back to its own source line,
  and the section's heading gets a quiet **ear marker** in the margin that opens the edition,
  stacked under the note and classroom markers. In an edition's preview a bar button
  (`Alt+Shift+T`) opens the **Edition sheet** with progress, the section list, Cancel,
  **Continue** for a stopped or failed build, and _Open the source section_. Each section
  records a content hash, so **Rebuild** re-calls only the sections that changed and
  re-running it after no edit costs nothing. _Retell Document for Listening_ runs the same
  loop over a whole document, section by section, into one edition (with a preview open the
  sheet shows all its rows first; with none, a modal confirms and a progress notification
  follows the build); _Open Spoken Edition_ lists every edition across documents. Settings
  `retellEnabled`, `retellDirectory`, `retellAutoOpen`, `retellMarker`; the engine, model and
  effort are the help settings, at `claude · sonnet · low` by default. Measured in the
  Extension Development Host on the experiment's document: section 7 in 67 seconds over two
  calls and 7 cents, its edition 1.40 times the source; the whole document (18 sections) in
  about four minutes of engine time and 31 cents, ratios 1.13 to 1.80; a Rebuild after no
  edit in 2 seconds and no call, after one edit one section re-called
  (`featrues/15-convert-readable/experiment/README.md` has the table). Desktop only. Retell sends the selected section, or every
  section of the document, to the engine on Build only, and copies document text outside the
  repository; both are said in the settings' descriptions.
  - Two numbers differ from the spec as written, measured while building. The sheet counts
    the section's **markdown source** (fence markers, table pipes, bullets and heading marks
    included, so the three kinds always sum), which makes section 7 of the experiment
    1,323 words (722 prose, 242 in 3 tables, 359 in 7 code blocks) rather than the 1,246 the
    experiment counted on the rendered text; the estimate follows (about 1,850 words · 13
    minutes, ceiling 2,381). And with heading lines excluded from the sentence rule (D19)
    the runs' averages are 25.7 / 27.0 / 13.1 / 21.6 / 22.6 words, so run 5 is flagged
    `sentence-length` (soft) rather than passing. The preamble unit — the text under a
    document's `h1`, before its first `h2` — is written one heading level deeper than the
    source, so an edition file keeps exactly one `h1`, the frame's. Three refinements came
    out of the Dev Host runs: an answer whose first heading is the document's title (the
    engine echoing the breadcrumb) loses that line (`title-heading` fix) before the headings
    are compared; headings whose texts line up but whose levels wander (an `h1` unit heading
    over `h3` sub-headings) pass fidelity and take the source's own levels (`heading-level`
    fix) instead of being flagged and written with two `h1`s; and the `empty` floor is half
    of a short unit's own words (never under 10, never over 50), because a 48-word section
    legitimately comes back at thirty. Two more from first use: the §6.3 cover check
    reduces both the preview's selection and the file's lines to letters and digits
    (`coverText`) rather than only dropping whitespace, because the selection is a render
    and the file is markdown — under the spec's rule any selection starting in `**bold**`,
    a link or a code span was refused as "out of step"; and a section a Rebuild re-calls is
    written back in its place (`placeSection`), not appended, since appending put the file
    out of order and made the next Rebuild re-call every section after it.
  - Messages: webview → host `readAloudRetellPrepare`, `readAloudRetellBuild`,
    `readAloudRetellCancel`, `readAloudRetellContinue`, `readAloudRetellOpen`,
    `readAloudRetellOpenSource`, `readAloudRetellOpenFolder`, `readAloudRetellDelete`,
    `readAloudRetellUndoDelete`; host → webview `readAloudRetellPrepared`,
    `readAloudRetellProgress`, `readAloudRetellError`, `readAloudRetellEditions`;
    `readAloudControl` actions `retell` (with `scope: 'document'` from the whole-document
    command) and `retellEdition`, `revealAnchor` with an `editionId`; `readAloudConfig`
    carries `retellAvailable`, `retellMarker` and, in an edition preview, `retellEdition`.
    Every payload is validated in `messages.ts` first. `backLink` in
    `classroom/module-format.ts` is generalised to `{ absolute, line }` with a label; the
    classroom's rule predicates and the heading parser of `links.ts` are exported.
  - Files: `src/retell/{sections,estimate,retell-prompt,checks,edition-format,edition-store,retell-controller}.ts`,
    the retell layer of `media/read-aloud.js`, §3g of `media/read-aloud.css`, the tokens in
    `media/read-aloud-page.css`, the commands and settings in `package.json`; suites
    `test/retell/*.test.js` (fixtures copied from the experiment),
    `test/read-aloud/{retell-sheet,retell-markers}.test.js` and new cases in
    `messages.test.js` and `control-panel.test.js`; `retell=1` and `edition=1` in
    `test/harness/`.

- **Copilot as a help engine** (2026-09-09): `readAloudHelpEngine: copilot` runs the GitHub
  Copilot CLI (`copilot -p`, verified against 1.0.83) for help, notes, classroom and retell, on
  a Copilot subscription, with **the same Claude model and effort as the `claude` engine**:
  `readAloudHelpClaudeModel` and `readAloudHelpClaudeEffort` are the only model settings, so
  the model is chosen once and either CLI answers with it. Copilot names models in its own
  catalog (`claude-sonnet-5`, `claude-fable-5.1`, `claude-opus-4.8-fast`), so
  `src/read-aloud/copilot-models.ts` reads the list `copilot help config` prints (local, no
  sign-in, about 200 ms, cached per binary for the host's life) and maps the setting onto it:
  an alias to the newest plain model of its family (`sonnet` → `claude-sonnet-5`, never a
  `-fast` variant), a Claude Code id to its dotted form (`claude-fable-5-1` →
  `claude-fable-5.1`, a date suffix dropped), an id the catalog lacks to the newest of its
  family, anything else through for the CLI to judge; a built-in copy of the 2026-09-09 list
  stands in when the help text cannot be read. `--effort` takes the same five names.
  - **The switch**: a new palette command **Markdown Preview Enhanced: Choose Help Engine**
    (`readAloud.help.chooseEngine`) lists the four engines, each CLI marked with the path it
    was found at or _not found on this computer_ (looked up while the pick is open), and the
    model quick pick — the sheet's engine label — ends with a _Switch engine…_ row that opens
    it; a `custom` engine goes straight there. `readAloudHelpEngine` is now **machine scope**:
    which CLI a computer has is a fact about that computer, so the choice is neither synced
    nor settable by a workspace. When the configured CLI is missing, the error names the
    CLIs that _are_ installed and the command that switches, plus the install line for the
    missing one.
  - **Invocation**: `-p` takes the prompt as its own argument (this version ignores piped
    stdin, and the docs' `copilot -p < file` form is refused), so the one document codex gets
    goes there as a single argv element; `--silent` makes stdout the answer;
    `--no-custom-instructions`, `--disable-builtin-mcps`, `--no-auto-update`, `--no-color`,
    `--no-ask-user`; tools cut to the CLI's irreducible core by `--available-tools=` with a
    name no tool has (an empty value is no filter at all), then `shell` and `write` denied
    outright and the temp dir taken out of the readable paths — a prompt asking for a shell
    command, a file and a read produced no tool event; `--usage-output-file` for the cache
    column and the premium-request count. An `E2BIG` from the OS (the prompt too long for
    one argument: about 1 MiB on macOS, 128 KiB on Linux) is reported as such and not
    retried; a 200 KB prompt ran on macOS.
  - **A throwaway `COPILOT_HOME`**: the CLI writes every session's prompt and answer into
    `session-store.db` (a `turns` table) and `session-state/<id>/events.jsonl` under its home
    and has no flag against it, so each run gets `copilot-home/` inside its own working
    directory (removed with it; a build keeps it for the build's calls), seeded with the
    user's `config.json` alone — the file the CLI says a login it could not put in the
    credential store is kept in as plain text — and nothing else: the user's `settings.json`,
    MCP servers and hooks do not apply. The keychain, the gh CLI's login and a token in
    `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` are found without it (on this Mac
    the CLI signed in through the gh CLI's login with nothing else configured).
  - **The launcher is not the CLI**: VS Code's Copilot Chat extension puts a `copilot` shell
    script on the login PATH (`…/github.copilot-chat/copilotCli/copilot`) that, when the CLI
    is absent, asks _Install GitHub Copilot CLI? [y/N]_ on stdin and runs `npm install -g` on
    a yes. The binary lookup never takes it — on the PATH, from the login shell or as the
    `readAloudHelpBinaryPath.copilot` override — and says so in the not-found report. The
    login-shell lookup now asks `which -a` and reads the trailing run of paths, so a shim
    ahead of the real CLI does not hide it.
  - The classroom and retell logs' cache column and cost now come from whichever engine
    reports them (`cache hit/miss`; `cost $` for claude, `premium n` for copilot); the notes
    controller builds its engine config through `helpEngineConfig` like the others.
  - Files: `src/read-aloud/copilot-models.ts`, the copilot paths of `help-engine.ts`,
    `settings.ts` (`writeHelpEngineSetting`, `CLI_ENGINES`), the two quick picks in
    `controller.ts`, the command in `extension-common.ts` and `package.json`; suites
    `test/read-aloud/copilot-models.test.js` and new cases in `help-engine.test.js`
    (99 tests between them). `setup/GUIDE.md` and `README.md` name the second CLI, and
    `SETUP-NEW-MAC.md` at the repo root is the copy-paste runbook for a fresh Mac — zip
    instead of git, the server behind a company proxy (`UV_SYSTEM_CERTS`, the model by
    `curl` with pinned checksums), the `.vsix` three ways, the CLI, `NODE_EXTRA_CA_CERTS`.
  - **The catalog is not the plan.** `copilot help config` lists what the CLI declares, and
    the plan may refuse a listed model before any request is made (`Model "…" from --model
flag is not available`): on this Mac on 2026-09-09 it refused `claude-fable-5.1`,
    `claude-fable-5`, `claude-opus-5`, `claude-opus-4.8` and `claude-sonnet-4.6` and served
    `claude-sonnet-5`; `claude-haiku-4.5` answered but refused `--effort` outright. So a
    refused model is taken out of the catalog and the mapping asked again — the next model of
    the same family, never another family — up to three times, then the sheet names the models
    tried and says to pick another with _Choose Help Model_ (not retryable); a model that
    "does not support reasoning effort configuration" gets the prompt once more without the
    flag. Each refusal costs a CLI start of about two seconds, not a request.
  - Measured through the bundled engine against Copilot CLI 1.0.83 from the scratchpad (the
    real CLI is not installed on this Mac; the `copilot` on its login PATH is the launcher
    above): the real help prompt (3,818 + 783 characters) answered in 8.5 s on
    `claude-sonnet-5` at `low` with the four-part shape, cache write 4,997 tokens, one
    premium request; the run directory was removed and nothing was written under
    `~/.copilot`; `detectHelpBinaries` found claude and codex and refused the launcher in
    359 ms; a 200 KB prompt ran; a prompt asking for a shell command, a file and a read
    produced no tool event in the CLI's own log.

### Changed

- `readAloudHelpEngine` is machine scope (see _Copilot as a help engine_ above): a value in a
  workspace's `.vscode/settings.json` is ignored, and Settings Sync leaves it alone.
- `engines.vscode` raised from `^1.70.0` to `^1.82.0` and `@types/vscode` to `1.82.0`, so the
  extension host can use native `fetch` for the Kokoro calls (no SDK dependency).
- Changes to the read-aloud settings (all but `readAloudEnabled`) no longer reload every preview
  panel, so a speed or voice change does not interrupt playback. Every other
  `markdown-preview-enhanced.*` change still refreshes the previews as before.
- The reading canvas takes its line height from the low-strain page (derived from the text
  size, 1.6 at the default 20 px) while the page is on; the 1.85 rhythm of 02 remains for
  `readAloudGlobalTheme: off`.
- The light highlight palettes are the reference reader's light mode (`featrues/08-highlight/`,
  sampled 2026-09-04): pill and word box per palette — blue `#e0e4fd` / `#aab5f9`, pink
  `#f6dcfc` / `#e69bf7`, red `#fce1dd` / `#f47e74`, green `#cffbe9` / `#7be5aa`, orange
  `#fcead1` / `#f5b768` — in place of 03's lighter tints and 07's darker boxes. The underline
  strokes are re-derived from the new boxes (`#6f7cd0`, `#b35fc7`, `#de5448`, `#3c9b66`,
  `#b57b32`) at 3.05–3.10:1 on their pills, and the page's text is 5.4–9.2:1 on the boxes. The
  dark palettes are unchanged; the structure of the decoration is unchanged.
- Reset page settings no longer touches crossnote's zoom, which is no longer a sheet control;
  the zoom stays available from the preview's context menu and ctrl+wheel. The 18 px size below
  48 rem is gone: the text size is the slider's at every pane width, and the column caps at the
  pane.
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

- The Player font size (zoom) slider, the Line height and Column width sliders, and the settings
  `markdown-preview-enhanced.readAloudLineHeight` and `readAloudColumnWidth` with their messages
  `readAloudSetLineHeight` and `readAloudSetColumnWidth`; both values now derive from
  `readAloudTextSize`. A stale key in `settings.json` is ignored.
- ElevenLabs support (client, key storage, voice and model resolution, cost guard, prosody
  context, the sent-text log and its `logs/` handling, the `readAloudProvider`,
  `elevenLabsVoiceId`, `elevenLabsModelId`, `elevenLabsBaseUrl` and `readAloudConfirmAbove`
  settings and the `readAloud.setApiKey` / `.clearApiKey` commands) was built and then removed
  before the first release; Kokoro is the only engine. The implementation remains in history
  (commit `3e25dc4`, _Read aloud: ElevenLabs + Kokoro, before cleanup_).

### Fixed

- **`setup/setup-new-mac.sh` on a managed Mac** (2026-09-09, run for real on one): behind a
  TLS-inspecting proxy `uv` failed with _invalid peer certificate: UnknownIssuer_ fetching
  torch, so the script sets `UV_SYSTEM_CERTS=1` and fetches the voice model with `curl`
  (which trusts the keychain) against the pinned SHA-256 of both files instead of through uv's
  Python; and with no working C compiler (Xcode's licence unaccepted, which takes an
  administrator) the source-only `pyopenjtalk` failed to build, so it is removed through the
  project's own `tool.uv` override marker — a `--override` on the command line is merged with
  that, not put in its place — and `pyopenjtalk-plus`, upstream's own Windows answer, is
  installed from its arm64 wheel; verified on a fresh copy with `CC=/usr/bin/false`.
  `SETUP-NEW-MAC.md` and `setup/GUIDE.md` say so.

- **The spoken word was painted in the wrong block after a click into a cached read**
  (`featrues/14-bug-placement/bug.md`, the screenshot: pills on the numbered list, the marked
  word in the bullet list above it). The webview shifted every chunk's word
  spans onto the read's timeline as the chunk arrived, using the lengths of the chunks before
  it — and a cache hit carried no `durationHint`, so a burst of cached chunks all landed at
  zero and their spans overlapped in time. That was harmless until a re-render's rebind reset
  the word cursor to the top of the read: the next frame then walked the overlapping spans
  from the start and found the _first_ chunk's word for the current time, in a block whose
  pills had long moved on. With the sidebar TOC open, crossnote's highlight of the current
  heading is such a re-render, on every scroll. Two changes: every chunk's spans now keep the
  chunk's own clock and the cursor is confined to the chunk being played (`spanEndOf`,
  `offsetOf` computed when asked, `syncSpansTo(index, local)`; the rebind puts the cursor at
  the playing chunk's first span), so the chunks' lengths can no longer misplace a word; and
  the host posts a `durationHint` for a cache hit too (`cachedDurationHint`: the hint stored
  with the entry since this change, else the end of its last span), so the time display and
  the ±10 s bounds of a cached read are right. `test/read-aloud/chunk-timeline.test.js`.

- **Help never saw the sentence a short selection came from** (`featrues/11-help-fixes/`). For a
  selection shorter than its block, the request carried the selected words as the passage and
  put the `[PASSAGE]` marker where the _whole block_ had been, so the sentence the words sat in
  was the one part of the document the model was not shown. Asked about "the metrics" in a
  lesson that lists them among the seven parts of a harness, `sonnet` and `opus` both reported,
  correctly for what they were given, that the phrase did not appear in the lesson. The material
  now carries an `<enclosing>` block in every context mode — the block (in a table, the row with
  its column headers) the passage was taken from, with the passage marked between ⟦ and ⟧ at the
  live selection's own offset, so a repeated word is marked where it was selected; empty when the
  selection is the whole block — and, in `section` mode for a selection of five words or fewer, a
  `<mentions>` block: up to six other places in the document that use those words (articles
  dropped, plural tolerated, whole words only, table rows read with their headers, code and
  diagrams never), each under the heading it sits beneath, outside the section that is already
  sent. Such a selection is a **term** and gets its own request, _Explain the term_, with four
  parts — _What it means here_, _In general_, _An example_ (of the term itself, in the document's
  setting), _Why it is here_ — a 100/130-word target instead of 80/100 (four parts at eighty
  words were captions), term variants of _Simpler_, _Deeper_ and _Example_, and one licence the
  passage shape does not have: a term the document uses without defining may be explained from
  general knowledge, said as such. The system prompt names the brackets and forbids reading the
  passage "as a stray fragment"; `HELP_PROMPT_VERSION` is 2, so no cached answer written to the
  old prompt is served, and the cache key and the _MPE Read Aloud_ log line carry the shape and
  the two new fields' lengths. Caps: 3,000 characters for the enclosing block, trimmed evenly
  around ⟦ the way the section is around `[PASSAGE]`, and 2,400 for the mentions (12,000 and
  4,000 at the message boundary). `help-context.test.js` drives the builder over a render of the
  report's document: the lesson, the glossary table and the sources list.
- **Read aloud, the help sheet's titles.** The sheet's section headings were invisible whenever
  the low-strain page forced one scheme and the preview theme carried the other: every bundled
  preview theme colours headings with an unscoped `html body h1,…,h6 { color: … }`, and
  `media/read-aloud-page.css` neutralised it for the preview root and not for
  `.mpe-ra-help-body`, so an `h2` came out `#fff` on the light panel at **1.19:1** — and `#000`
  on the dark panel at 1.35:1 in the mirror case. Headings and `hr` now take the page's `--text`
  in the sheet as well, so they also dim with the tiers around them; with the page off they take
  the panel's own foreground, which `applyBarScheme` already keeps in step with the surface.
  Measured after the fix: **11.88:1** on the light page and 12.44:1 on the dark, across
  `github-light`, `github-dark`, `night`, `solarized-dark` and `vue`. The token test's theme
  sentinel — which passed all along, because it asked only that _some_ page rule name the
  element — grew a second pass requiring every element a theme colours to be named for the sheet
  too.
- **The help sheet reads like the page.** Its prose was a fixed 14 px against the column's 20 px,
  with every heading level at `1em`, half the block gap, no list rhythm and 97 characters to the
  line: 04 gave the sheet a size of its own before there was a reader template to follow. It now
  takes the text size and derived line height of the slider, the canvas's heading scale
  (1.6 / 1.3 / 1.2 / 1.1 / 1 / 1 em) and margins, the 1.25 em block gap, 0.2 em list items,
  `text-wrap: pretty`, the chosen player font — `--mpe-ra-font-family` is published on the sheet
  as well as on the preview root — and the measured 66-character measure, which puts the sheet at
  621 px and its answer at 62 characters a line. `--mpe-ra-line-height` is published on the sheet
  body in both page states, so the pill and word padding is derived from the sheet's real line
  height instead of falling back to 1.85 against a 1.6 line (the fragments overlapped by half
  again what they should). The sheet's own chrome keeps its px sizes; `max-height` goes from
  60 vh to 70 vh to hold the larger type. With the page off the sheet keeps 04's 13/14 px, 680 px
  and 60 vh — there is no template to follow there — but the same shape and the same pill
  geometry.
- **The help button went dead during a read.** `hideFloat` was bound to every window `scroll` and
  discarded the resolved selection along with the affordance, while `helpPassage` read that
  discarded value as its only source for a live selection — and the follow-the-reading scroll
  writes the container's position on every frame, so the `?`, and `Alt+H` with it, was disabled
  within a frame of any selection made while listening. The predicate now resolves the live
  selection on demand through `core.resolveSelection`, and a scroll repositions the affordance
  (one `rAF`, `getClientRects` only, never a re-resolve) instead of forgetting it. Selecting
  inside the block being read was never the problem and always worked.
- **Help is reachable with the panel faded.** The selection affordance is now a cluster of two,
  _Read aloud_ and **Explain**, the second hidden in the web build and for a selection inside the
  sheet (questions about the explanation go through the sheet's own question box). The panel no
  longer fades while the affordance is on screen, and a selection wakes it; the next plain click
  collapses the selection, takes the affordance down and starts the countdown again. While the
  sheet is open a document selection gets no affordance at all: the sheet owns the reading, and
  the selection behind it is the passage being explained. Making the affordance a flex container
  also gave it a `display` declaration, which beats the UA's `[hidden] { display: none }`: the
  hidden affordance went on rendering over the open sheet until `.mpe-ra-float[hidden]` said so
  again, and `page-typography.test.js` now asserts that line for all five elements that need it.
  `test/harness/` answers `readAloudHelp` with a canned five-part answer (`help=1`,
  `helpdelay=<ms>`) so the sheet can be driven in Chrome without a CLI; validated there on
  2026-09-04 against five preview themes on both page schemes, checks H1–H14 of
  `featrues/09-helper-fix/spec.md` §14.3, then in the Extension Development Host over CDP with
  VS Code's Dark Modern, `previewTheme: github-dark.css` and `readAloudGlobalTheme: light` — the
  combination the report was made on — driving the real `claude -p` engine (§19.1).
- Text on the dark blue, green and orange word boxes was 4.0–4.3:1, under the 4.5:1 the
  highlight promised, and the dark pink box 4.44:1 against the page's real text colour
  (`#e6e6e6`; the spec had estimated against `#f2f2f2`); the four boxes are a step darker and the
  token test asserts all ten pairs against the page's tokens.
- **Punctuation next to the spoken word stays visible.** The word box overhangs its word by its
  horizontal padding (0.35 em) on each side and is relatively positioned so that it paints above
  the pill fragment of the line below (see the entry after next), which also paints it above all
  of the block's text; any glyph standing in that overhang was hidden under it: the hyphen of
  _read-only_ while _only_ was spoken, the full stop after _firewall_, the comma after _hook_,
  all but the tip of the question mark after _hold_, a closing quote or bracket, the _d_ of
  _boldfaced_ when _face_ sat inside a `<strong>`. CSS alone cannot put the box between the
  pill's background and the block's text — an inline stacking context paints its own background
  after its negative-z-index descendants, so a `::before` at z-index −1 lands under the pill, and
  an unpositioned box is painted over by the next line's pill fragment — so the player now
  wraps the characters touching the word on either side in `.mpe-ra-word-edge` spans positioned
  one step above the box (`core.wrapWord`, `core.wordEdges`; the non-whitespace run next to the
  word, at most `WORD_EDGE_CHARS = 3` characters, never across whitespace and so never across a
  block). They have no offset and no background, are split out and merged back with the same
  `splitText` machinery as the word so node identity and the offset map survive, and are cleared
  with the word. Hit testing is unchanged: the word span is still the topmost element over its
  own glyphs. Six new tests in `test/read-aloud/reading-decoration.test.js`.
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
