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

- Local **Kokoro** read-aloud provider, now the default: the open-weight, Apache-licensed
  Kokoro-82M model served on this machine by a Kokoro-FastAPI server takes ElevenLabs' place in
  every read (spec F1–F14 unchanged: play buttons, click to read, selection, word highlighting,
  speed, cache, keybindings). Free, offline, no key; nothing leaves the machine.
  - Requests are `POST /dev/captioned_speech`, non-streaming, mp3, with word timestamps and the
    server's text normaliser **off** (`normalization_options.normalize: false`) so the words it
    times are the words on screen; Kokoro's own G2P still reads numbers, dates, currency and
    abbreviations. New pure module `src/read-aloud/kokoro-alignment.ts` aligns those per-token
    timestamps with the webview's word segmentation: punctuation tokens dropped, a hyphenated or
    dotted token (`read-aloud`, `2024-09-02`, `10,000-credit`, `U.S.`) split across the words
    it covers in proportion to their length, a contraction spanning several tokens joined,
    anything else resynced within a short window, and untimed runs interpolated between their
    timed neighbours. The interpolation also covers a Kokoro-FastAPI bug seen in practice: after
    a token with no phonemes (a bare `$` before a number) it stops timestamping the rest of the
    chunk although the audio is there.
  - New host modules: `src/read-aloud/kokoro-client.ts` (plain-`fetch` transport mirroring the
    ElevenLabs client, with `KokoroHttpError` / `KokoroNetworkError` / `KokoroCancelledError`,
    a 60 s timeout, the F5 speakable guard, `isAllowedKokoroBaseUrl`, `describeKokoroVoice`),
    `kokoro-types.ts` (wire shapes) and `kokoro-voices.ts` (QuickPick over
    `GET /v1/audio/voices`, language and gender decoded from the id). The controller branches
    per provider: no key step, no cost guard, no model limits and no `previous_text` /
    `next_text` for Kokoro; a fixed 5,000-character request bound keeps the chunker's targets;
    cache keys carry the model id `kokoro`, so entries never collide with ElevenLabs ones. The
    webview and the ElevenLabs path are untouched.
  - Settings: `markdown-preview-enhanced.readAloudProvider` (`kokoro` default | `elevenlabs`),
    `kokoroVoice` (default `af_heart`; `+` blends allowed), `kokoroBaseUrl` (default
    `http://127.0.0.1:8880`, machine scope; plain http accepted on localhost only, anything
    else must be https). `readAloudEnabled`'s description no longer names ElevenLabs.
  - _Read aloud setup_ (the voice button in the player bar) offers **Check Kokoro Server**
    (`GET /health` plus the voice count) instead of the API-key entry when the provider is
    Kokoro; **Choose Read Aloud Voice** lists Kokoro voices with their grade, language and
    gender and writes `kokoroVoice`.
  - Errors (`error-mapping.ts`: `kokoroErrorInfo`, `mapKokoroErrorToAction`, provider-aware
    `userMessageFor`): server not running → inline, retryable _Could not reach the Kokoro server
    at … Start it and try again._; unknown voice → a short message naming the voice instead of
    the server's list of all 68; _Input contains no speakable text_ → the silent `empty_text`;
    5xx → _Kokoro server error: …_; 429 → backoff.
  - Tests: `test/read-aloud/kokoro-alignment.test.js` (10, fixtures taken from real server
    output including the dropped-timestamps case), `test/read-aloud/kokoro-client.test.js`
    (12) and five Kokoro tests in `error-mapping.test.js` (289 total).
  - README: the read-aloud section gained a _Provider_ table, the one-time server setup (uv,
    clone, venv, model download, loopback start, launchd) and the Kokoro settings and behaviour;
    the ElevenLabs subsections are unchanged under provider-qualified headings.
- ElevenLabs read-aloud in the preview (`resources/spec.md` F1–F14, desktop VS Code only): a
  play button on every readable block (paragraphs, headings, blockquotes, lists), reading of the
  current preview selection with a floating affordance, a player bar with play/pause, stop and
  0.25x–4x speed (`HTMLMediaElement.playbackRate`, never re-synthesized), and word-by-word
  highlighting driven by ElevenLabs `with-timestamps` character alignment (CSS Custom Highlight
  API). Code fences, code chunks, diagrams, math, tables (except a single-cell selection),
  images, the TOC and footnote definitions are skipped. Long text is chunked by sentence with
  `previous_text`/`next_text` continuity, guarded by a confirmation above a character threshold,
  and cached on disk (LRU). The webview and host talk through the new `readAloudSynthesize`,
  `readAloudCancel`, `readAloudSetSpeed`, `readAloudOpenSetup` and `readAloudAudio`,
  `readAloudError`, `readAloudConfig`, `readAloudControl` messages.
  - Settings: `markdown-preview-enhanced.readAloudEnabled` (master switch, default `true`),
    `elevenLabsVoiceId` (empty; resolved at runtime from `GET /v2/voices`, no ID hard-coded),
    `elevenLabsModelId` (`eleven_multilingual_v2` | `eleven_flash_v2_5` | `eleven_v3`),
    `readAloudSpeed` (0.25–4, default 1), `readAloudConfirmAbove` (default 5000),
    `readAloudCacheSizeMB` (default 100), `elevenLabsBaseUrl` (default
    `https://api.elevenlabs.io`, machine scope).
  - Commands: `markdown-preview-enhanced.readAloud.setApiKey`, `.clearApiKey`, `.readSelection`,
    `.togglePlayPause`, `.stop`, `.chooseVoice`, `.clearCache`, `.showLog` (all disabled in VS
    Code for the Web).
  - Keybindings while a preview panel or custom editor has focus: `Alt+R` read selection,
    `Alt+Space` play/pause, `Alt+Esc` stop. On Windows the last two collide with OS window
    shortcuts; rebind them there.
  - The _MPE Read Aloud_ output channel: one line per request with text length, model, voice,
    `request-id`, `character-cost`, `x-region` and duration; never the API key and never more
    than the first 80 characters of the text.
  - New files: `src/read-aloud/*.ts` (host: client, chunker, word spans, cache, error mapping,
    controller), `media/read-aloud{,-core}.js` and `media/read-aloud.css` (webview, injected
    through the preview `head` like the lightbox), `src/types/intl-segmenter.d.ts`, and nine
    mocha suites under `test/read-aloud/` wired into `test:unit` (137 new tests; 195 total). The
    manual API smoke script `test/read-aloud/elevenlabs-smoke.mts` (R2 §15) is included but has
    not yet been run.
- devDependency `jsdom@23.2.0` for the webview eligibility, extraction and selection tests.
- Sent-text log: every string sent to ElevenLabs is appended, one per line and nothing else, to
  `logs/read-aloud-sent.log` in the workspace folder of the document being read (the
  extension's global storage when there is none). Written at request time by the controller
  through the new `src/read-aloud/sent-log.ts`, so cache hits never appear; best effort, never
  blocks playback. `logs/` is git-ignored and excluded from the `.vsix`. New suite
  `test/read-aloud/sent-log.test.js` (4 tests).
- `install.sh` at the repo root: `pnpm build`, `vsce package --no-dependencies` and
  `code --install-extension … --force` in one step (`--no-build` skips the build when
  `pnpm watch` keeps `./out` current). Finds the `code` CLI via `$CODE_BIN`, PATH, or the macOS
  app bundle. Excluded from the `.vsix` through `.vscodeignore`.
- ElevenLabs Reader look for the block being read: every rendered line sits on a rounded pill
  (`.mpe-ra-pill` around each inline run, `box-decoration-break: clone`, 2em line pitch) and the
  spoken word gets a darker rounded box of the same height (`.mpe-ra-word`). Setting
  `markdown-preview-enhanced.readAloudHighlightTheme` (`blue` default, `orange`, `yellow`,
  `green`) selects one of the Reader's four "Player highlight theme" palettes, colours sampled
  from the app; the light or dark variant is chosen from the preview background's luminance
  (`data-mpe-ra-scheme` / `data-mpe-ra-theme` on the preview root), so `atom-dark.css` gets the
  dark palette regardless of the VS Code theme. The theme travels in the `readAloudConfig`
  message (`highlightTheme`) and switches live. New mocha suite
  `test/read-aloud/reading-decoration.test.js` (14 tests) covers the wrappers and the helpers, and
  `messages.test.js` gains two theme tests (211 total).
- Click to read (`resources/spec.md` F17): a plain left click on a word in a readable block starts
  reading at that word and stops where the block's play button would stop (end of the paragraph,
  heading, blockquote or whole list). A click inside the block that is already loaded, playing or
  paused seeks the audio to that word (no request). The gesture waits out a 250 ms double-click
  window, so double and triple clicks still select text; drags, modified clicks, links, task-list
  checkboxes and clicks in the margin or between lines start nothing. Code, diagrams, math and the
  other F6 exclusions are refused silently at any depth. The webview resolves the click with
  `caretPositionFromPoint`/`caretRangeFromPoint`, maps the caret into the block's offset map,
  snaps to the word and slices the extraction from there; the re-render rebind keeps the start
  offset. Partial block reads send the words before the cut as `previous_text`.
  - **Table cells are reading units**: a click in a cell reads from that word to the end of the
    cell (a cell containing math, or a table inside a code chunk, is refused). No per-cell button.
  - Setting `markdown-preview-enhanced.readAloudClickToRead` (default `true`), carried in the
    `readAloudConfig` message as `clickToRead` and applied live without a preview reload.
  - New core helpers `resolveClick`, `caretToTextOffset`, `wordAt`, `sliceExtraction` in
    `media/read-aloud-core.js`; new mocha suite `test/read-aloud/click-to-read.test.js` (17
    tests; 229 total). The webview traces every click decision at `console.debug` level
    (`read-aloud: click scheduled | refused | missed the word | seeked | starting`), visible in
    the webview developer tools with the Verbose level on.

### Changed

- ElevenLabs is no longer the default read-aloud engine; set
  `markdown-preview-enhanced.readAloudProvider` to `elevenlabs` to use it again. Its behaviour,
  settings and commands are unchanged.
- Read-aloud cost and latency pass (2026-09-02). A free-tier probe showed the whole 10,000-credit
  monthly quota gone after a day of use, and a several-second wait before every block: both came
  from synthesising an entire block (or selection) in one request on the most expensive model.
  - **Lazy synthesis inside a read.** The chunker now packs sentences towards a ~250-character
    first chunk and ~700-character chunks after it (`FIRST_CHUNK_TARGET_CHARS`,
    `CHUNK_TARGET_CHARS` in `src/read-aloud/chunker.ts`) instead of filling the model limit, and
    the host holds the request for chunk _k_ until the webview reports chunk _k−1_ playing
    (new webview → host message `readAloudPlaying` `[sourceUri, requestId, chunkIndex]`, posted
    from `playChunk`). Audio starts after a one-or-two-sentence request, a stop or pause never
    pays for more than one chunk beyond what was heard, and cache hits are posted without
    waiting. Nothing beyond the block (or selection) the user asked for is ever requested;
    auto-advance/prefetch (spec F15) stays unbuilt by design.
  - **Default model is now `eleven_flash_v2_5`** (half the per-character cost of Multilingual v2
    and the lowest latency). `eleven_multilingual_v2` remains one setting away for documents
    where number and date normalisation matters; `package.nls.json` descriptions updated.
  - **Cache key is content only** — SHA-256 of `text + voiceId + modelId`. The `previous_text`
    / `next_text` prosody context is no longer part of the key: it changed whenever a neighbour
    was edited or a click landed on a different word, turning most re-reads into billable
    misses. The context itself is still sent (ElevenLabs quoted the same credit cost for a
    request with and without 600 characters of context, so it is free).
  - **Audio format `mp3_44100_64`** instead of the endpoint default `mp3_44100_128`: half the
    base64 payload, `postMessage` and disk footprint, no paid tier needed.
  - The cache entry is written after the audio is posted to the webview, and eviction only
    re-scans the directory when a running size estimate crosses the cap (previously a stat of
    every entry on every write).
  - New mocha tests: chunk targets (6), `parsePlayingArgs` (3), content-only cache key (1);
    `cache.test.js` key test adjusted to three parts.
- **Only speakable characters are sent to ElevenLabs** (F5). New pure module
  `src/read-aloud/speakable.ts`: `sanitizeForSpeech` keeps letters, marks and digits of any
  script, whitespace and the sentence punctuation `.,;:!?` quotes `()…¿¡` dashes and
  `% $ € £ ¥ ° & + = / @`; drops markdown residue (`**`, `#`, `>`, `[x]`, backticks, `~~`),
  brackets, symbols and emoji; turns `_` and `|` into word separators; keeps `-` only between
  two letters or digits (`read-aloud`, `2024-09-02`), and collapses the result the way the
  webview collapses whitespace. The controller sanitises the text and the `previous_text` /
  `next_text` context of every job before chunking, keeps the offset map back to the text the
  webview sent, and maps every word span back through it, so highlighting is unchanged. The
  cost guard and the cache key see the sanitised (billed) text. As the last line of defence
  `ElevenLabsClient.synthesizeWithTimestamps` throws before any request when a field contains
  a character outside the set. Not `[a-z0-9]` on purpose: the punctuation carries the pauses
  and intonation, the apostrophe and decimal point carry "don't" and "3.5", and the preview is
  not English-only. New suite `test/read-aloud/speakable.test.js` (20 tests) plus a client test
  that the guard never issues a request.
- Single-cell table selection is decided by the cells the range covers with text, not by the
  containers it starts and ends in. Chromium switches to cell-based ranges (anchored on the row)
  as soon as a drag brushes a cell border, which made a selection inside one cell unreadable in
  practice; such a range now reads the one cell it covers, and still refuses two or more with the
  _Select text within a single table cell_ hint. `selection.test.js` gains a test for the four
  range shapes.
- Word highlighting no longer uses the CSS Custom Highlight API named in spec F4: `::highlight()`
  cannot draw padding or rounded corners, so it cannot produce the pill-and-box look. The webview
  now wraps the spoken word in transient `<span>`s (text nodes split with `splitText` and merged
  back into the original node on every change, so the offset map stays valid) and wraps each
  inline run of the block in a pill span while it is read. All wrappers are removed when the read
  ends; the script swallows its own MutationObserver records so decoration never triggers a
  re-decorate. Auto-scroll now targets the word span instead of a Range.
- `engines.vscode` raised from `^1.70.0` to `^1.82.0` and `@types/vscode` from `1.70.0` to
  `1.82.0`, so the extension host can use native `fetch` for the ElevenLabs calls (no SDK
  dependency).
- Changes to the read-aloud settings (all but `readAloudEnabled`) no longer reload every preview
  panel, so a speed or voice change does not interrupt playback. Every other
  `markdown-preview-enhanced.*` change still refreshes the previews as before.
- `README.md` gained a "Read aloud (ElevenLabs)" section (setup, voice, model, speed,
  eligibility, privacy, cost guard, keybindings, limitations) and three rows in the shortcut
  table.

### Fixed

- A whole-block read (play button, and now a click) of a blockquote or list item that contains a
  code fence, table, diagram, embed or code chunk no longer speaks that nested content: text
  extraction skips every nested F6 exclusion, the same way the reading decoration already left
  them undecorated. Prose beside the nested block is still read.

### Security

- The ElevenLabs API key is stored only in VS Code SecretStorage (`mpe.elevenlabs.apiKey`),
  entered through the Set ElevenLabs API Key prompt and validated against
  `GET /v1/user/subscription`; it is never written to settings, the webview, the output log or
  exports.
- Text is sent to ElevenLabs only when the user presses play, uses the selection affordance or
  runs a read-aloud command; opening a preview makes no request. ElevenLabs keeps request
  history by default (see the README privacy note).
- `elevenLabsBaseUrl` is declared with `"scope": "machine"` so a workspace's `.vscode/settings.json`
  cannot redirect the host that receives the key.
- `.env` and `.env.*` (local key for the smoke script) are ignored by git (`.gitignore`) and
  excluded from the packaged `.vsix` (`.vscodeignore`).

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
