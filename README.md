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

**[`setup/GUIDE.md`](setup/GUIDE.md) does all of this in one run**, on a Mac where you have no
administrator rights, and covers the rest of a fresh machine too:

```bash
./setup/setup-new-mac.sh --server-only
```

It refuses early on an Intel Mac, because the server pins PyTorch 2.8.0 and that release
publishes macOS wheels for `arm64` only. The manual equivalent follows.

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
| **Theme settings** | Opens the theme settings sheet: the global theme, the player font, the text size, the word marker and the highlight theme.                             |
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
height (derived from the text size: 1.70 at 16 px down to 1.45 at 26 px and above, 1.6 at the
default 20 px; 1.85 with the page off) and even spacing between paragraphs, lists and headings —
and the pills of the block being read are drawn inside it, with
their padding cancelled by a negative margin. The pill padding is derived from the line height,
so the lines of the block always overlap and read as one shape. Starting a read therefore moves nothing: the text
keeps its size, its line breaks and its position. Every measurement is in `em`, so zooming the
preview scales the whole canvas, decoration included.

### While reading

- **The page follows the reading.** The spoken line is kept near the upper third of the
  viewport and the page is eased there a few pixels a frame, never jumped by half a screen.
  Any scroll of your own — a wheel, a touch, a scrollbar drag, a page key, a scroll-sync from
  the editor — suspends the following for as long as you like; a **Back to the reading** chip
  above the panel, a play, a skip, a click on a word, or scrolling until the spoken word is
  back where the page would keep it re-engages it. Under `prefers-reduced-motion` the page
  jumps instead of easing.
- **The rest is dimmed.** While a read plays, every other readable block of the low-strain
  page is dimmed by colour in two tiers — the next block a little, the rest to a measured
  floor — so the block being read stands out; code, tables, maths and images are never dimmed.
  `markdown-preview-enhanced.readAloudDimWhileReading` (default `true`); no effect with the
  page off.
- **The spoken word is underlined.** An underline sweep in the highlight theme's colour marks
  the word, so the glyphs keep their brightness; the filled box of the reader-app look and
  _Off_ are the other two choices (`readAloudWordMarker`, also a row on the sheet).
- **The panel fades.** After three seconds of playback with no mouse or keyboard activity the
  panel fades out and a thin progress strip at the bottom edge stands in for it; any movement,
  key, wheel, pause or message brings it back (`readAloudPanelAutoHide`, default `true`).
- **A breath between blocks.** The read pauses 400 ms between blocks and 900 ms after a
  heading, divided by the rate; chunks of the same block hand over gaplessly.

### Theme settings

The second button of the panel opens a sheet with five controls and a reset. Each takes effect
at once, also mid-playback, and none reloads the preview.

| Control                    | What it does                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Global theme**           | _Auto · Light · Dark_: the low-strain reading page (below), in place of the preview theme. _Auto_ follows the VS Code colour theme. Persists in `markdown-preview-enhanced.readAloudGlobalTheme`; `off` is a Settings value. |
| **Player font**            | Overrides the page's face (or, with the page off, the preview theme's font). Persists in `markdown-preview-enhanced.readAloudFont`.                                                                                          |
| **Text size**              | 16–28 px, default 20. The line height, the width of the column and the heading sizes derive from it. Persists in `markdown-preview-enhanced.readAloudTextSize`. No effect while the page is off.                             |
| **Word marker**            | _Underline · Box · Off_: how the spoken word is marked. Persists in `markdown-preview-enhanced.readAloudWordMarker`.                                                                                                         |
| **Player highlight theme** | Five palettes shown as sample cards, painting the chosen marker. Persists in `markdown-preview-enhanced.readAloudHighlightTheme`.                                                                                            |
| **Reset page settings**    | Clears the global theme, text size, font and word marker settings (so their defaults apply again). Speed, volume, the highlight palette, dimming, auto-hide and the preview's zoom are left alone.                           |

The foot of the sheet carries one line of reader guidance: match the screen's brightness to the
room, and every 20 minutes look 20 feet away for 20 seconds.

#### The low-strain reading page

With the global theme at _Auto_, _Light_ or _Dark_ (the default is _Auto_) the live preview is
restyled as a reading page built to `featrues/05-eye-strain.md`: the Atkinson Hyperlegible Next
face, bundled with the extension (`media/fonts/`, SIL Open Font License 1.1, 48 KB, never
fetched), 20 px body text by default (the text size slider, 16–28 px), a column of 66 characters of
prose measured in the face in use (centred
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
  so a user `style.less` that wants to win must use the same prefix or `!important`. (The page itself uses `!important` in three declarations only — the `pre` background and padding, which nine bundled prism themes force with `!important`, and the sidebar TOC background, which crossnote sets as an inline style — so a `style.less` rule for those three needs `!important` as well.)
- A selection drawn over the pills of the block being read paints on the pill, not on the page's
  surface; it is still visible, but the dual test is defined against the surface.
- Presentation mode (reveal.js) is never restyled, and the page is desktop-only, like the rest of
  read aloud.

### Help: explain the selection

Select a passage you did not follow and press the **?** button (or <kbd>⌥H</kbd>). The read
pauses where it is, a sheet opens above the panel, and a headless LLM writes an explanation of
that passage in five parts — what it says, the terms, the passage in plain words, an example,
and why it matters — written for the ear and about as long as the passage itself, never more
than two minutes of audio. A selection of five words or fewer is a **term** and gets four parts
instead — what it means here, in the sentence it was taken from; what it means in general; an
example of it in the document's own setting; and why it is there — and for a term the document
uses without defining, the model may draw on general knowledge, saying so. The answer is
rendered through the preview's own markdown engine, so it looks like the document it explains,
and it is read aloud as soon as it arrives.

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
> the block it was taken from with the selection marked, the document title and the heading
> breadcrumb only; `section` (the default) adds the blocks either side, the rest of the
> enclosing section and, for a term, the document's other mentions of it, each under its heading
> (a glossary row comes with its column names); `document` sends the whole source. The
> _MPE Read Aloud_ output channel logs character counts, never text.

#### Which engine answers

| Setting                                | Default                             | What it does                                                                                               |
| -------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `readAloudHelpEngine`                  | `claude`                            | `claude -p`, `codex exec -`, `copilot -p`, or `custom`. Per computer (machine scope).                      |
| `readAloudHelpClaudeModel` / `…Effort` | `sonnet` / `low`                    | `--model` and `--effort` for claude (`fable`/`opus`/`sonnet`/`haiku`, `low`…`max`); copilot runs the same. |
| `readAloudHelpCodexModel` / `…Effort`  | empty / `low`                       | `-m` and `model_reasoning_effort` for codex; empty and `default` omit the flag.                            |
| `readAloudHelpCommand`                 | `[]`                                | For `custom`: argv, prompt on stdin, answer on stdout.                                                     |
| `readAloudHelpAudience`                | a capable reader new to the subject | Who the explanation is written for.                                                                        |
| `readAloudHelpAutoPlay`                | `true`                              | Read the explanation as soon as it arrives.                                                                |
| `readAloudHelpTimeoutSeconds`          | `90`                                | Kill the command after this.                                                                               |
| `readAloudHelpBinaryPath`              | `{}`                                | Absolute paths to `claude` / `codex` / `copilot`. Machine scope.                                           |

Effort is a trade you feel, because you are waiting with a read paused: `low` answers in a few
seconds, `high` and above think for longer and cost more per answer. **Markdown Preview
Enhanced: Choose Help Model** picks the model and the effort in two steps, and the sheet's own
`claude · sonnet · low` label opens the same quick pick without leaving the preview.

**Switching engines.** One computer often has one CLI and not the other, so the engine is a
per-computer setting: **Markdown Preview Enhanced: Choose Help Engine** lists the four engines
with each CLI marked _found at …_ or _not found on this computer_, the model list's last row,
_Switch engine…_, opens the same pick from the sheet, and Settings Sync leaves the choice alone
(machine scope). When the configured CLI is missing, the error names the ones that are
installed and the command that switches.

**Copilot** (`copilot -p`, the GitHub Copilot CLI) runs **the same Claude model and effort as
the claude engine**: `readAloudHelpClaudeModel` and `readAloudHelpClaudeEffort` are the only
model settings, mapped onto Copilot's own catalog ids (`sonnet` → `claude-sonnet-5`,
`claude-fable-5-1` → `claude-fable-5.1`; an id the catalog no longer lists gets the newest of
its family; the list comes from `copilot help config`). It signs in with `copilot login`, the
gh CLI's login it finds on its own, or a token in `GH_TOKEN`, and it runs with no tools, no
custom instructions, no GitHub MCP server and a throwaway `COPILOT_HOME` inside the run's own
directory, so the session store the CLI keeps never holds the document's text. VS Code's
Copilot Chat extension puts a `copilot` launcher on the PATH that is not the CLI; it is
skipped.

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

**Text size.** One slider, 16–28 px, from which everything else follows: the line height (1.70
at 16 px down to 1.45 at 26 px and above), the heading sizes (in em of the body) and the
reading column, which is always 66 characters of prose — the player lays out a sample passage
in the face in use and sets the column from its average advance, so 66 means 66 in Atkinson,
Georgia or Verdana, capped by the pane. The value is a real setting and survives a reload.
crossnote's own zoom is still available from the preview's context menu and ⌘-scroll; the
panel keeps its size on screen while the text scales.

**Player highlight theme.** While a block is being read every line sits on a rounded pill and
the spoken word gets a darker box inside it.
`markdown-preview-enhanced.readAloudHighlightTheme` picks one of five palettes: `blue`
(default), `pink`, `red`, `green` or `orange`. Each has a light and a dark variant; the
extension chooses the variant from the preview theme's background (`atom-dark.css` gets the
dark one, `github-light.css` the light one), not from the VS Code colour theme. The decoration
is added when playback starts and removed when it ends; nothing of it reaches exports.

### Notes: keep a passage for later

The third button of the selection cluster, **Note** (`Alt+N`), saves the selected passage
with enough context to understand it months later: the exact words, the block they sit in
with the passage marked between ⟦ and ⟧, the block before and after, the heading path, and
the document's title, path and git commit. The file is written at once; the help engine then
writes a title, a short summary, why the passage matters, its terms and a few tags into it
(`notesGenerate`; off keeps the capture only). **Save as note** on the Help sheet keeps an
explanation you already have. Saved notes show as a marker in the right margin of their block
and a dotted line under their words; either opens the **Note sheet**, where _My note_ and the
tags are yours to edit, and where the note can be regenerated, opened in the editor, copied,
played, or deleted (six seconds of Undo, then the OS trash). The **Notes** button on the panel
(`Alt+Shift+N`) lists this document's notes in reading order; the **Notes** view in the
Explorer lists every document's, and _Search notes_ (command palette) finds one by title,
path, passage or tag. Notes re-anchor on every render and survive edits around them; one
whose passage is gone is kept and marked _Not in this version_, with _Re-attach to selection_.

Notes live **outside the document**, one markdown file per note with YAML front matter, under
`~/.crossnote/notes/<workspace folder>/<relative path>/` by default (on Linux, under
`~/.local/state/crossnote/notes`). Nothing is ever written into the markdown you are reading,
and the default root is outside every repository. **Notes copy document text into your home
directory**: the passage, its block, its neighbours and the heading path. A root inside a
synced folder syncs that text; a confidential document's notes belong in a root that does not.
To move the root, set `markdown-preview-enhanced.notesDirectory` to an absolute path (`~` is
allowed; machine scope, so a workspace cannot redirect it). `notesDecoration` chooses between
the marker and the words' mark, the marker only, or nothing in the document.

### Classroom: a module that teaches the passage

The fourth button of the selection cluster, **Classroom** (`Alt+C`), and **Teach me this** on the
Help sheet open a sheet that asks one thing before anything is sent: how lost you are, in three
rows, with an optional sentence in your own words. It shows the instructor (**Max**, a patient
practitioner whose voice and chapter structure come from an authoring guide shipped as a persona
package), the audience line, the engine label and exactly which files will leave the machine.
**Build** has the help engine write a teaching module the way the guide says a course is written:
one call for the plan, then one call per chapter in course order, each briefed with the previous
chapter's closing bridge, the next chapter's question and the promises due, each checked
mechanically and appended to a markdown file. The module opens beside the document as soon as its
first chapter is on disk and is a document like any other from then on: read aloud, followed,
dimmed, explained, noted. In a module's preview the bar's Classroom button (`Alt+Shift+C`) opens
the **Module sheet**: progress, the chapter list, Cancel, Continue for a stopped or failed build,
and _Open the source passage_. _Open Classroom Module_ (command palette) lists every module.

**Classroom sends more than Help does**: the whole document (up to 120,000 characters, the
passage marked) and up to four linked workspace markdown files, to the configured engine, on
Build only. The sheet names every file and lets you untick the linked ones;
`markdown-preview-enhanced.classroomFollowLinks` turns link following off. Modules live under
`~/.crossnote/classroom/modules/<workspace folder>/<relative path>/` (`classroomDirectory`,
machine scope), so a module copies document text into your home directory, like a note. Every
call of a build runs from one working directory so the persona-and-fuel prefix is cached: a
six-chapter module at `claude · sonnet` measured at about two minutes and thirty cents.

To add an instructor, make a folder `~/.crossnote/classroom/personas/<id>/` with a `persona.md`
(YAML front matter `name`, `id`, `tagline`, `audience`, `version`, an optional `levels` override
of the chapter budgets, then the persona's own notes as the body) and an optional `specimen.md`
(a transcript of the instructor speaking). A folder whose `id` is `max` replaces the built-in
Max, which is how the built-in guide is edited without a rebuild. `classroomPersona` names the
instructor in force and `classroomAudience` the audience line; the sheet writes both.

A five-word selection gets a **small module** (two chapters at the first lever row, four at the second); the size line under the lever says what a row buys, and `markdown-preview-enhanced.classroomShortTermModules` restores the full budgets. Every module shows as a **mortarboard marker** in the right margin of the paragraph it was built from, under a note marker when both are there; a click opens it, and the marker, the sheet's rows, the Module sheet and _Delete Classroom Module_ can **delete** it, with six seconds of Undo before the file goes to the OS trash (`classroomMarker` hides the markers).

### Retell: a spoken edition of the section

The fifth button of the selection cluster, **Retell** (`Alt+T`), and **Retell the section** on
the Help sheet are for a section that reads well on the page and badly out loud: tables, code
blocks and identifiers the voice skips or mangles. They make a **spoken edition** of the h2
section the selection sits in (the request is always widened to whole sections; the sheet says
when it widened): the same content, in the same order, under the same headings, with every
table said as sentences, every code block said as what the code does, and every identifier said
as a spoken name. Nothing is added and no rule is dropped. The sheet names the sections that will
be sent with their word counts by kind, the engine label and the estimate (1.4 times the source's
words, at the measured 142 words a minute), and **Build** runs one help-engine call per section,
in order, each answer checked mechanically (no em dashes, tables, links, inline code, HTML, emoji
or fences; no identifier with a dot, slash, tilde or angle bracket in it; the source's headings
verbatim and in order; a runaway ceiling at 1.8 times the source) with one retry, then appended
to a markdown file. The edition opens beside the document as soon as its first section is on
disk and is a document like any other from then on: read aloud, followed, dimmed, explained,
noted, taught. Every section ends with a link back to its own source line, and the section's
heading gets an **ear marker** in the margin, under the note and classroom markers, that opens
the edition. In an edition's preview the bar's ear button (`Alt+Shift+T`) opens the **Edition
sheet**: progress, the section list, Cancel, Continue for a stopped or failed build, _Open the
source section_ and Delete (six seconds of Undo, then the OS trash). Each section records a
content hash, so **Rebuild** re-calls only what changed. _Retell Document for Listening_ runs
the same loop over the whole document into one edition; _Open Spoken Edition_ lists every
edition. Measured on a 1,246-word section at `claude · sonnet · low`: 10 to 35 seconds and 1.5
to 6.3 cents a section, the edition 1.24 to 1.6 times the source.

**Retell sends the section's markdown source** — the selected section, or every section of the
document — plus the title, the heading breadcrumb and the document's outline, to the configured
engine, on Build only; nothing is sent by selecting, by opening the sheet or by Prepare. Editions
live under `~/.crossnote/retell/editions/<workspace folder>/<relative path>/`
(`retellDirectory`, machine scope), so an edition copies document text into your home directory,
like a note. `retellAutoOpen` turns the opening beside off (the sheet shows Open instead), and
`retellMarker` hides the markers. The engine, model and effort are the help settings.

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
| Retell this section   | `⌥T` / `Alt+T`         | same                                         |
| This spoken edition   | `⌥⇧T` / `Alt+Shift+T`  | same, in a spoken edition's preview          |

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
- Help needs a `claude`, `codex` or `copilot` CLI already signed in on this machine; it spawns a process,
  so it is desktop-only too, and the **?** button is not there in VS Code for the Web.
- Help explains a **selection**. Explaining the block being read without selecting it first is
  not built yet, and neither is asking for help on the explanation itself — use the question
  box for that.
- The low-strain page restyles the live preview only; exports keep the preview theme. Diagram
  themes are not overridden, and a selection over the block being read paints on its pills.
- A manual scroll stops the page following the reading until the _Back to the reading_ chip, a
  play, a skip or a scroll back into place; there is no timed auto-resume.

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
