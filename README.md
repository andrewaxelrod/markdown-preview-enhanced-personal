# Markdown Preview Enhanced (Personal)

A personal fork of [shd101wyy/vscode-markdown-preview-enhanced](https://github.com/shd101wyy/vscode-markdown-preview-enhanced),
branched from upstream `develop` at **v0.8.32**. It is published under its own extension
identity so a Marketplace release of the original can never auto-update over local changes.

Upstream feature documentation still applies in full:
**[markdown-preview-enhanced docs](https://shd101wyy.github.io/markdown-preview-enhanced/)**.
The original project README is preserved in git at `git show baseline-0.8.32:README.md`.

## Usage

| Action                           | Shortcut |
| -------------------------------- | -------- |
| Open preview to the side         | `⌘K V`   |
| Open preview in a full tab       | `⌘⇧V`    |
| Open locked preview to the side  | `⌘K ⇧L`  |
| Run the code chunk at the cursor | `⇧⏎`     |
| Run all code chunks              | `⌃⇧⏎`    |
| Read aloud the preview selection | `⌥R`     |
| Read aloud play/pause            | `⌥Space` |
| Stop read aloud                  | `⌥Esc`   |
| Explain the selection (help)     | `⌥H`     |

## Read aloud (Kokoro)

The preview can read itself aloud. Press the play button of any readable block, or click a
word, and a voice reads from there to the **end of the document** with the spoken word
highlighted as it is said; select text and only the selection is read. The voice is the
open-weight, Apache-licensed [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model,
run on this machine by a [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) server:
free, offline, no account, and nothing leaves the machine. Playback runs entirely in the
preview webview; the synthesis requests are made by the extension host.

### Kokoro server setup (once)

[`uv`](https://docs.astral.sh/uv/) downloads its own Python and every dependency (espeak is
bundled), so nothing else needs to be installed. Keep the checkout **outside** `~/Documents`,
`~/Desktop` and `~/Downloads`: macOS privacy protection stops a launchd agent from reading
those folders, so a server started at login from there fails with _Operation not permitted_.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
git clone https://github.com/remsky/Kokoro-FastAPI.git ~/.local/share/kokoro-fastapi
cd ~/.local/share/kokoro-fastapi
uv venv --python 3.12
uv pip install -e ".[cpu]"
uv run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0
```

Start it bound to the loopback interface (Apple Silicon uses MPS automatically; `USE_GPU=false`
forces the CPU):

```bash
PYTHONPATH="$PWD:$PWD/api" MODEL_DIR=src/models VOICES_DIR=src/voices/v1_0 WEB_PLAYER_PATH="$PWD/web" \
  uv run --no-sync uvicorn api.src.main:app --host 127.0.0.1 --port 8880
```

The repository's own `start-cpu.sh` does the same on `0.0.0.0`. To keep it running across
logins, put that command in a launchd agent (this machine uses
`~/Library/LaunchAgents/com.andrew.kokoro-fastapi.plist` with `KeepAlive`). The first request
after a start takes a few seconds while the model warms up; after that a one-or-two-sentence
first chunk is synthesised in well under a second on an M-series Mac and a ~700-character chunk
in about a second and a half.

In VS Code, **Markdown Preview Enhanced: Read Aloud Setup** opens _Read aloud setup_, where
**Check Kokoro Server** confirms the server answers and reports its voice count, and **Markdown
Preview Enhanced: Choose Read Aloud Voice** lists every voice with its language and gender.

### Settings and server behaviour

- `markdown-preview-enhanced.kokoroBaseUrl` (default `http://127.0.0.1:8880`, machine scope).
  Plain `http` is accepted on localhost only; any other host must be `https`.
- `markdown-preview-enhanced.kokoroVoice` (default `af_heart`). The first letter of a voice id
  is its language (`a` American English, `b` British English, `e` Spanish, `f` French, `h` Hindi,
  `i` Italian, `j` Japanese, `p` Brazilian Portuguese, `z` Mandarin) and the second its gender;
  blends such as `af_bella+af_sky` work.
- Requests go to `POST /dev/captioned_speech` (non-streaming, mp3, word timestamps) with the
  server's text normaliser **off**, so the words it times are the words on screen. Kokoro's own
  G2P still reads numbers, dates, currency and abbreviations ("$12.50" → "twelve dollars and
  fifty cents", "Dr." → "doctor").
- Kokoro times its own tokens, not characters: punctuation tokens are dropped, a hyphenated or
  dotted token such as `read-aloud` or `2024-09-02` is split across the words it covers in
  proportion to their length, and any word the server left untimed is interpolated between its
  timed neighbours. (Kokoro-FastAPI stops timestamping the rest of a chunk after a token with
  no phonemes, typically a bare `$` before a number; the interpolation covers it.) Japanese and
  Mandarin voices return no word timing, so those play without highlighting.
- If the server is not running, play shows _Could not reach the Kokoro server at … Start it and
  try again._ inline; nothing is retried automatically.
- Audio in a VS Code webview may only start on the heels of a user gesture, so the preview
  unlocks its two media elements on your first click or key press and reuses them for every
  chunk. A read started from the command palette on a preview you have never clicked in shows
  _Audio is blocked until you click in the preview_; click a word or a play button once and it
  works from then on.

### Reading to the end of the document

A play button or a click on a word starts a read that continues through every readable block
that follows — paragraphs, headings, lists, blockquotes — until the end of the document, in
document order. Code fences, code chunks, diagrams, display math, images, embeds, tables, the
TOC and footnote definitions are passed over. A paragraph that contains inline `$…$` math is
read with the math left out; the LaTeX is never spoken.

- The whole read is **one request**: the webview sends the text of every block from the start
  point on, with the block boundaries, and the host splits each block on its own into
  sentence-packed chunks (a ~250-character first chunk so audio starts fast, ~700 characters
  after that). No chunk ever spans two blocks, so the pause between a heading and its paragraph
  is real silence between two pieces of audio.
- The host keeps **two chunks synthesised ahead** of the one playing (about 90 s of audio) and
  requests the next as soon as the previous response is in, so the next block's audio is ready
  before the current one ends and there is no gap at the boundary. One request is in flight at
  a time; Kokoro serialises on one GPU or CPU anyway.
- The highlight pills and the play-button state move to the next block as its first chunk starts
  playing, the panel's progress advances with it, and auto-scroll follows. The audio of a
  block that has finished is released; a 20-minute document is never held in memory in full.
- Editing the document: if the block being read, or the next one when its turn comes, no longer
  exists with the same text, the read stops. An edit anywhere else does not interrupt it.
- At the last block the read stops and the bar shows _Finished_.

### Click to read

A plain left click anywhere inside a readable block — on a word, in the margin, between lines
or past the end of a line — starts reading at the nearest word and continues to the end of the
document; playable text shows a pointer cursor. A click on a word whose audio is already
synthesised (the current block, or a prefetched one) jumps the audio there without a request;
a click further away starts a new read. The gesture waits out the double-click interval, so
double and triple clicks still select text, and it ignores drags, clicks with a modifier key
held, links and task-list checkboxes. Set `markdown-preview-enhanced.readAloudClickToRead` to
`false` to keep the play buttons and the selection affordance only; the pointer goes with it.

**Table cells are reading units.** Tables have no play button and are skipped by a continuous
read; click a word in a cell to read from there to the end of that cell, and playback stops
there. Selecting text **within a single cell** and using the floating _Read aloud_ affordance or
⌥R reads the selection; a selection spanning more than one cell is refused with _Select text
within a single table cell_.

### Selection

Select text in the preview and press the floating _Read aloud_ affordance or ⌥R: only the
selection is read, across as many readable blocks as it covers. A selection inside code, a
diagram or math is refused with a short inline hint.

### The control panel

A rounded panel floats at the bottom centre of the preview whenever read aloud is enabled, with
eight controls, left to right:

| Control            | What it does                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Volume**         | Opens a slider, 0–100 %. Applies to the audio straight away and persists in `markdown-preview-enhanced.readAloudVolume`. The glyph follows the level.  |
| **Theme settings** | Opens the theme settings sheet: the global theme, the player font, the player font size, the line height, the column width and the highlight theme.    |
| **−10 s**          | Skips back ten seconds **inside the block being read**. Landing before its first word restarts the block rather than going back into the previous one. |
| **Play / pause**   | With nothing loaded, reads from the first block still on screen to the end of the document — the same read a play button in the gutter starts.         |
| **+10 s**          | Skips forward ten seconds. Landing past the last synthesised word of the block does nothing, and the button greys out when that is the case.           |
| **Speed**          | Shows the current rate and opens a slider, 0.25×–4×.                                                                                                   |
| **Help (?)**       | Explains the selected passage with a headless LLM, in a sheet above the panel (below). Disabled until there is a selection to explain.                 |
| **Close**          | Stops the read and puts the panel away. The next read brings it back.                                                                                  |

Progress through the read is traced along the top edge of the panel, and _Loading…_, _Paused_,
_Finished_ and any error appear above it so the panel's own shape never changes. The panel keeps
its size on screen when the preview is zoomed in or out; only the text scales.

Speed is applied with `HTMLMediaElement.playbackRate` and `preservesPitch`, so it takes effect
immediately mid-playback and never triggers re-synthesis. The chosen value persists in
`markdown-preview-enhanced.readAloudSpeed`; <kbd>[</kbd> and <kbd>]</kbd> step through the stops
0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3 and 4.

### Reading rhythm

While read aloud is on, the preview is set to one vertical rhythm — the low-strain page's line
height (1.6 by default, 1.4–1.8 from the sheet; 1.85 with the page off) and even spacing between
paragraphs, lists and headings — and the pills of the block being read are drawn inside it, with
their padding cancelled by a negative margin. The pill padding is derived from the line height,
so the lines of the block always overlap and read as one shape. Starting a read therefore moves nothing: the text
keeps its size, its line breaks and its position. Every measurement is in `em`, so zooming the
preview scales the whole canvas, decoration included.

### Theme settings

The second button of the panel opens a sheet with six controls and a reset. Each takes effect at
once, also mid-playback, and none reloads the preview.

| Control                    | What it does                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Global theme**           | _Auto · Light · Dark_: the low-strain reading page (below), in place of the preview theme. _Auto_ follows the VS Code colour theme. Persists in `markdown-preview-enhanced.readAloudGlobalTheme`; `off` is a Settings value. |
| **Player font**            | Overrides the page's face (or, with the page off, the preview theme's font). Persists in `markdown-preview-enhanced.readAloudFont`.                                                                                          |
| **Player font size**       | The preview's zoom — the same one behind _Zoom In_ / _Zoom Out_ in the preview's context menu. Not persisted, like that zoom.                                                                                                |
| **Line height**            | 1.4–1.8 in 0.1 steps. Persists in `markdown-preview-enhanced.readAloudLineHeight`. No effect while the page is off.                                                                                                          |
| **Column width**           | 50–75 characters of the body font. Persists in `markdown-preview-enhanced.readAloudColumnWidth`. No effect while the page is off.                                                                                            |
| **Player highlight theme** | Five palettes shown as sample cards. Persists in `markdown-preview-enhanced.readAloudHighlightTheme`.                                                                                                                        |
| **Reset page settings**    | Clears the global theme, line height, column width and font settings (so their defaults apply again) and puts the zoom back to 1. Speed, volume and the highlight palette are left alone.                                    |

The foot of the sheet carries one line of reader guidance: match the screen's brightness to the
room, and every 20 minutes look 20 feet away for 20 seconds.

#### The low-strain reading page

With the global theme at _Auto_, _Light_ or _Dark_ (the default is _Auto_) the live preview is
restyled as a reading page built to `featrues/05-eye-strain.md`: the Atkinson Hyperlegible Next
face, bundled with the extension (`media/fonts/`, SIL Open Font License 1.1, 48 KB, never
fetched), 20 px body text (18 px in a pane narrower than 48 rem), a 66-character column (centred
on a slightly darker canvas in the light scheme), weights 400 and 600 only, underlined links, and colour tokens for every
surface a preview theme paints — text, rules, code, quotes, tables, admonitions, callouts, focus
rings, a syntax palette for code blocks — in a light set checked at WCAG AAA and a dark set
checked with APCA (`test/read-aloud/page-tokens.test.js` computes both). Selections and `==marks==`
pass the requirement's dual contrast test in both schemes.

What it overrides, and what it does not:

- While the page is on, `previewTheme`, `previewColorScheme` and `codeBlockTheme` have no visible
  effect in the live preview; they still decide every **export**, which never loads the page.
  Set `markdown-preview-enhanced.readAloudGlobalTheme` to `off` in Settings to get the preview
  theme back exactly as it was; on the sheet `off` shows as no segment selected, and choosing one
  turns the page on again.
- Diagram themes are not overridden: a `default` mermaid diagram stays a light box on the dark
  page. Set `mermaidTheme: dark` alongside _Dark_.
- The player, its popovers, both sheets and the reading pills follow the page's scheme, and the
  prose inside a pill is the page's text colour rather than pure black or white.
- The page lives on the `<html>` element (`data-mpe-ra-page`), which crossnote never rewrites, and
  is applied before the body is parsed, so a cold load never flashes the wrong theme. The
  stylesheet is `media/read-aloud-page.css`; its rules are prefixed with `html[data-mpe-ra-page]`,
  so a user `style.less` that wants to win must use the same prefix or `!important`.
- A selection drawn over the pills of the block being read paints on the pill, not on the page's
  surface; it is still visible, but the dual test is defined against the surface.
- Presentation mode (reveal.js) is never restyled, and the page is desktop-only, like the rest of
  read aloud.

### Help: explain the selection

Select a passage you did not follow and press the **?** button (or <kbd>⌥H</kbd>). The read
pauses where it is, a sheet opens above the panel, and a headless LLM writes an explanation of
that passage in five parts — what it says, the terms, the passage in plain words, an example,
and why it matters — written for the ear and about as long as the passage itself, never more
than two minutes of audio. The answer is rendered through the preview's own markdown engine, so
it looks like the document it explains, and it is read aloud as soon as it arrives.

**The sheet is a second reading scope.** The same panel drives it: play/pause, ±10 s, speed,
volume, the progress line and the word-by-word highlight all work there, a click on a word in
the sheet starts or seeks the read, and a selection inside the sheet reads just that. A read in
the sheet ends at the end of the sheet; the document's own read never wanders into it.

**Resume** closes the sheet and continues the paused read from the same word. It survives an
edit elsewhere in the document, because the paused block is remembered by its content rather
than its position; if that block is gone, _Resume_ is disabled and says so.

**Follow-ups.** _Simpler_, _Deeper_ and _Example_ ask again with the explanation on screen
attached, and the _What confused you?_ box asks a question of your own. _Back_ walks the stack
of explanations back up. Answers are cached by content, so a repeat is instant, and
**Markdown Preview Enhanced: Clear Read Aloud Cache** empties them along with the audio.

> **This is the only part of read aloud that sends text off this machine.** Kokoro is local;
> help is not. It happens only when you press the help button, <kbd>⌥H</kbd>, a follow-up chip
> or _Ask_ — never on opening a preview and never on selecting text. How much goes with the
> passage is `markdown-preview-enhanced.readAloudHelpContext`: `selection` sends the passage,
> the document title and the heading breadcrumb only; `section` (the default) adds the blocks
> either side and the rest of the enclosing section; `document` sends the whole source. The
> _MPE Read Aloud_ output channel logs character counts, never text.

#### Which engine answers

| Setting                                | Default                             | What it does                                                                        |
| -------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| `readAloudHelpEngine`                  | `claude`                            | `claude -p`, `codex exec -`, or `custom`.                                           |
| `readAloudHelpClaudeModel` / `…Effort` | `sonnet` / `low`                    | `--model` and `--effort` for claude (`fable`/`opus`/`sonnet`/`haiku`, `low`…`max`). |
| `readAloudHelpCodexModel` / `…Effort`  | empty / `low`                       | `-m` and `model_reasoning_effort` for codex; empty and `default` omit the flag.     |
| `readAloudHelpCommand`                 | `[]`                                | For `custom`: argv, prompt on stdin, answer on stdout.                              |
| `readAloudHelpAudience`                | a capable reader new to the subject | Who the explanation is written for.                                                 |
| `readAloudHelpAutoPlay`                | `true`                              | Read the explanation as soon as it arrives.                                         |
| `readAloudHelpTimeoutSeconds`          | `90`                                | Kill the command after this.                                                        |
| `readAloudHelpBinaryPath`              | `{}`                                | Absolute paths to `claude` / `codex`. Machine scope.                                |

Effort is a trade you feel, because you are waiting with a read paused: `low` answers in a few
seconds, `high` and above think for longer and cost more per answer. **Markdown Preview
Enhanced: Choose Help Model** picks the model and the effort in two steps, and the sheet's own
`claude · sonnet · low` label opens the same quick pick without leaving the preview.

The command is spawned with an argv array — never a shell — in a fresh empty directory, so no
project's `CLAUDE.md` or `AGENTS.md` is pulled into the prompt. If the binary is not on the
extension host's `PATH` (it often is not, when VS Code is launched from the Dock) the login
shell is asked; failing that, set `readAloudHelpBinaryPath`. The model's answer is treated as
untrusted markdown: raw HTML is escaped and executable link targets are neutralised before
anything is rendered.

**Player font.** Ten choices — the default (the low-strain page's Atkinson Hyperlegible Next, or
the preview theme's own font with the page off), the system UI font, Helvetica, Verdana,
Trebuchet MS, Georgia, Palatino, Baskerville, Times New Roman and Menlo. Each is a stack that
degrades to a generic family where the first name is missing, and every family is one the
machine already has or ships with the extension: no font is ever fetched over the network. The
override is applied to the preview root, so code, diagrams and maths keep their own font.

**Player font size** is not a font setting at all — it is the preview's zoom, in the same 0.1
steps the context menu's _Zoom In_ and _Zoom Out_ use, between 0.6 and 2. The label names the
size in pixels the prose ends up at. Because it drives crossnote's own zoom, the context menu's
`Zoom (110%)` label, ⌘-scroll and the slider all agree, and the panel keeps its size on screen
while the text scales.

**Player highlight theme.** While a block is being read every line sits on a rounded pill and
the spoken word gets a darker box inside it.
`markdown-preview-enhanced.readAloudHighlightTheme` picks one of five palettes: `blue`
(default), `pink`, `red`, `green` or `orange`. Each has a light and a dark variant; the
extension chooses the variant from the preview theme's background (`atom-dark.css` gets the
dark one, `github-light.css` the light one), not from the VS Code colour theme. The decoration
is added when playback starts and removed when it ends; nothing of it reaches exports.

### What exactly is sent

The text comes from the rendered preview, so markdown syntax is already gone, and before the
request it is reduced to letters and digits (any script), whitespace and sentence punctuation:
`. , ; : ! ?`, quotes, parentheses, `…`, dashes, and `% $ € £ ¥ ° & + = / @`. Anything else is
dropped — `**`, `#`, `>`, `[x]`, backticks, `~~`, brackets, backslashes, symbols, emoji — `_`
and `|` become word separators, and a hyphen stays only inside a word (`read-aloud`,
`2024-09-02`). Task-list checkbox markers are never spoken. Word highlighting still lands on the
original text. The HTTP client refuses to send a request containing any other character, and
the _MPE Read Aloud_ log shows `tts sanitised … N -> M chars` when something was removed.

### Privacy

The text only ever travels to the local server on `kokoroBaseUrl`, and only when you press
play, click a word or run a read-aloud command — opening a preview makes no request. Set
`markdown-preview-enhanced.readAloudEnabled` to `false` to remove the buttons and stop the
scripts from being injected at all.

### Cache and log

- Audio is cached on disk under `globalStorageUri/read-aloud-cache`, keyed by the chunk text,
  voice and model, and capped by `markdown-preview-enhanced.readAloudCacheSizeMB` (default 100,
  least-recently-used eviction). A cache hit replays instantly with no request, and editing a
  neighbouring paragraph does not invalidate it. **Markdown Preview Enhanced: Clear Read Aloud
  Cache** empties it.
- **Markdown Preview Enhanced: Show Read Aloud Log** opens the _MPE Read Aloud_ output channel:
  the plan of every read (blocks, chunks, characters), one line per chunk with its block, text
  length, voice, HTTP status, duration and whether it was a cache hit, and the webview's reason
  whenever it gives a read up (`reason=webview (stop)`, `(audio: …)`, `(next block gone …)`).
  Never more than the first 80 characters of the text.

### Keybindings

| Action                | Chord                  | Active when                                  |
| --------------------- | ---------------------- | -------------------------------------------- |
| Read aloud selection  | `⌥R` / `Alt+R`         | the preview panel or custom editor has focus |
| Play/pause            | `⌥Space` / `Alt+Space` | same                                         |
| Stop                  | `⌥Esc` / `Alt+Esc`     | same                                         |
| Explain the selection | `⌥H` / `Alt+H`         | same                                         |

With the control panel focused, <kbd>Space</kbd> plays/pauses, <kbd>Esc</kbd> closes an open
slider and otherwise stops, and <kbd>[</kbd>/<kbd>]</kbd> step through the speed stops.

**On Windows, `Alt+Space` opens the window menu and `Alt+Esc` cycles windows** — the OS wins.
Rebind those two commands in _Keyboard Shortcuts_ if you use Windows.

### Limitations (v1)

- Desktop VS Code only (`engines.vscode` `^1.82.0`, for the host's native `fetch`). The commands
  are disabled and nothing is injected in VS Code for the Web.
- Code, diagrams and math are never read; a read of the whole document skips them.
- One thing plays at a time across all preview panels.
- The server must be running; a stopped server is reported inline, not started for you.
- A read is bounded by a 200,000-character request; a longer document is read up to the last
  block that fits.
- Help needs a `claude` or `codex` CLI already signed in on this machine; it spawns a process,
  so it is desktop-only too, and the **?** button is not there in VS Code for the Web.
- Help explains a **selection**. Explaining the block being read without selecting it first is
  not built yet, and neither is asking for help on the explanation itself — use the question
  box for that.
- The low-strain page restyles the live preview only; exports keep the preview theme. Diagram
  themes are not overridden, and a selection over the block being read paints on its pills.

## Identity

|                    |                                                                                |
| ------------------ | ------------------------------------------------------------------------------ |
| Extension ID       | `andrew.markdown-preview-enhanced-personal`                                    |
| Upstream ID        | `shd101wyy.markdown-preview-enhanced`                                          |
| Baseline           | tag `baseline-0.8.32`                                                          |
| Settings namespace | `markdown-preview-enhanced.*` — **unchanged**, so existing settings carry over |

Only `name`, `displayName`, and `publisher` differ from upstream. Nothing in `src/` resolves
its own extension ID, and `build.js` does not embed the name or version, so the rebrand is
inert at runtime.

Do not install the upstream extension alongside this one — identical command IDs and the
`markdown-preview-enhanced` custom-editor `viewType` would collide.

## What's different from upstream

See [CHANGELOG.personal.md](CHANGELOG.personal.md). Upstream's own history is in
[CHANGELOG.md](CHANGELOG.md), left untouched so it never conflicts on a rebase.

To see every local change as a diff:

```bash
git diff baseline-0.8.32          # full diff against pristine upstream 0.8.32
git diff --stat baseline-0.8.32   # just the file list
```

## Prerequisites

- Node.js (developed against v24) and pnpm 10.28.0, activated by `corepack enable pnpm`
  (the version is pinned by the `packageManager` field — do not use npm or yarn)
- VS Code. If the `code` CLI is not on your PATH, run
  _Shell Command: Install 'code' command in PATH_ from the command palette, or use the
  full path: `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`

## Build and install

```bash
pnpm install --frozen-lockfile
./install.sh        # pnpm build, package the .vsix, install it into VS Code
```

Then run **Developer: Reload Window** in VS Code. `./install.sh --no-build` packages and
installs what is already in `./out` (handy while `pnpm watch` is running). The script finds the
`code` CLI via `$CODE_BIN`, then PATH, then the macOS app bundle. It is equivalent to:

```bash
pnpm build          # gulp copies crossnote assets -> ./crossnote, esbuild bundles -> ./out
npx @vscode/vsce package --no-dependencies
code --install-extension markdown-preview-enhanced-personal-*.vsix --force
```

`pnpm install` warns about _Ignored build scripts_ (esbuild, sharp, fsevents, …) — expected
under pnpm 10; those packages ship prebuilt platform binaries.

## Development loop

Press **F5** in VS Code to launch an Extension Development Host running the working tree
directly (via `--extensionDevelopmentPath`), with `pnpm watch` rebuilding on save. Reload the
host window to pick up a rebuild. Repackage and reinstall only when you want the change in
your everyday editor.

```bash
pnpm watch          # esbuild in watch mode
pnpm test           # mocha unit tests
pnpm check:all      # eslint + prettier
pnpm fix:all        # autofix both
```

Note: `.husky/pre-commit` runs `npx lint-staged` (`pnpm install` wires the hook up through
`core.hooksPath`), so commits lint and reformat staged files. `git commit --no-verify` skips it.

## Where things live

| Path                      | Purpose                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `src/extension.ts`        | Entry point for desktop VS Code (Node)                            |
| `src/extension-web.ts`    | Entry point for VS Code for the Web                               |
| `src/extension-common.ts` | Activation logic shared by both entry points                      |
| `src/preview-provider.ts` | Webview panel provider for the live preview                       |
| `src/config.ts`           | Maps VS Code settings onto crossnote's `NotebookConfig`           |
| `build.js`                | esbuild config for both bundles, plus WASM/worker asset copying   |
| `gulpfile.js`             | Copies crossnote's styles/webview/dependencies into `./crossnote` |

Rendering itself lives in the [crossnote](https://github.com/shd101wyy/crossnote) dependency,
not here — this repo is the VS Code wrapper around it. [AGENTS.md](AGENTS.md) has deeper
architecture notes, including how to add a new setting and how to work against a local
crossnote build.

## License

Upstream code is under the
[University of Illinois/NCSA Open Source License](LICENSE.md); local changes inherit it.
If this fork is ever published, it must not reuse upstream's Marketplace identity or branding.
