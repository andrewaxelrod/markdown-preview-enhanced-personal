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
    `baskerville`, `times`, `menlo`), `readAloudCacheSizeMB`.
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
    theme. _Global theme_ from the reference (`featrues/control2.png`) is deliberately not
    built yet.
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
