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

## Read aloud (Kokoro or ElevenLabs)

The preview can speak any readable block, any text you select in it, or everything from a word
you click to the end of its block, with the spoken word highlighted as it is said. Playback runs entirely in the preview webview; the synthesis request
is made by the extension host. Two engines are available: a local **Kokoro** server (the
default) or the **ElevenLabs** API; see _Provider_ below.

### Provider

`markdown-preview-enhanced.readAloudProvider` selects the engine:

| Provider           | What it is                                                                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kokoro` (default) | The open-weight, Apache-licensed [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model, run on this machine by a [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) server. Free, offline, no account, and nothing leaves the machine. Word highlighting comes from the model's own timestamps. |
| `elevenlabs`       | The ElevenLabs cloud API. Needs an API key and credits; higher voice quality and more languages.                                                                                                                                                                                                                |

Everything else — play buttons, click to read, selection reading, highlighting, speed, the cache
and the keybindings — is identical for both.

#### Kokoro server setup (once)

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

In VS Code, the voice button in the player bar opens _Read aloud setup_, where **Check Kokoro
Server** confirms the server answers and reports its voice count, and **Markdown Preview
Enhanced: Choose Read Aloud Voice** lists every voice with its language and gender.

#### Kokoro settings and behaviour

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
- No API key, no cost guard, no character limit and no prosody context: Kokoro has none of
  these. The disk cache, the sent-text log and the output channel work exactly as for
  ElevenLabs, with `kokoro` as the model id.
- If the server is not running, play shows _Could not reach the Kokoro server at … Start it and
  try again._ inline; nothing is retried automatically.

### ElevenLabs setup

1. Run **Markdown Preview Enhanced: Set ElevenLabs API Key** from the command palette and paste
   a key from <https://elevenlabs.io/app/settings/api-keys>. The key is validated against
   `GET /v1/user/subscription` and, on success, stored in VS Code's **SecretStorage** under
   `mpe.elevenlabs.apiKey` — never in your settings, in the preview, in the output log, or in the
   packaged `.vsix`. **Markdown Preview Enhanced: Clear ElevenLabs API Key** removes it.
2. Open a preview and hover a paragraph. A play button appears in the left gutter; a plain
   click on any word starts reading from that word. The first play with no key stored opens the
   same prompt and then continues.

### ElevenLabs voice

`markdown-preview-enhanced.elevenLabsVoiceId` is empty by default. On first use the extension
calls `GET /v2/voices?page_size=1`, stores the first voice available to your account in the
setting, and shows a one-time _Reading with voice …_ notice with a **Change voice…** action. No
voice ID is hard-coded, because the voices used in ElevenLabs' own examples are being retired.
**Markdown Preview Enhanced: Choose Read Aloud Voice** opens a QuickPick of every voice on the
account and writes your pick to the setting.

### ElevenLabs model

`markdown-preview-enhanced.elevenLabsModelId` (default `eleven_flash_v2_5`):

| Model                    | Notes                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eleven_flash_v2_5`      | Half the per-character cost of Multilingual v2 and the lowest latency. Recommended. **Numbers and dates are not normalized on non-Enterprise plans** — "2026-09-01" and "$1,000" may be read literally. |
| `eleven_multilingual_v2` | Best pronunciation of numbers, dates and URLs, at twice the cost.                                                                                                                                       |
| `eleven_v3`              | Most expressive. 5,000-character limit. Timestamp support is still to be confirmed, so word highlighting may not work.                                                                                  |

### Speed

The player bar offers 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3 and 4, plus free entry of
any value in the range 0.25x–4x. Speed is applied with `HTMLMediaElement.playbackRate` and
`preservesPitch`, so it takes effect immediately mid-playback and **never** triggers
re-synthesis or another charge. The chosen value persists in
`markdown-preview-enhanced.readAloudSpeed`.

### Highlight theme

While a block is being read it is drawn the way the ElevenLabs Reader app draws text: every
line sits on a rounded pill and the spoken word gets a darker box inside it.
`markdown-preview-enhanced.readAloudHighlightTheme` picks one of the Reader's four palettes,
`blue` (default), `orange`, `yellow` or `green`. Each has a light and a dark variant; the
extension chooses the variant from the preview theme's background (`atom-dark.css` gets the
dark one, `github-light.css` the light one), not from the VS Code colour theme. A change applies
immediately, also mid-playback. The decoration is added when playback starts and removed when it
ends; nothing of it reaches exports.

### What can be read

Paragraphs, headings, blockquotes, and bullet/ordered/task lists get a play button; checkbox
markers are not spoken, only the item text. Code fences, code chunks, diagrams (mermaid,
PlantUML, WaveDrom, Vega, D2, …), math, images, embeds, the TOC and footnote definitions are
skipped, and a selection inside one of them is refused with a short inline hint. A code fence or
table nested inside a list item or blockquote is skipped too; the prose around it is read.

**Tables** have no play button; each cell is its own reading unit. Click a word in a cell to
read from there to the end of that cell, or select text **within a single cell** and use the
floating _Read aloud_ affordance or ⌥R. A selection spanning more than one cell is refused with
_Select text within a single table cell_.

**What exactly is sent.** The text comes from the rendered preview, so markdown syntax is
already gone, and before the request it is reduced to letters and digits (any script),
whitespace and sentence punctuation: `. , ; : ! ?`, quotes, parentheses, `…`, dashes, and
`% $ € £ ¥ ° & + = / @`. Anything else is dropped — `**`, `#`, `>`, `[x]`, backticks, `~~`,
brackets, backslashes, symbols, emoji — `_` and `|` become word separators, and a hyphen stays
only inside a word (`read-aloud`, `2024-09-02`). Word highlighting still lands on the original
text. The HTTP client refuses to send a request containing any other character, and the _MPE
Read Aloud_ log shows `tts sanitised … N -> M chars` when something was removed.

### Click to read

A plain left click on a word starts reading at that word and stops where the block's play
button would stop: the end of the paragraph, heading or blockquote, the end of the whole list
for a list item, the end of the cell for a table cell. Clicking inside the block that is already
loaded, playing or paused jumps the audio to that word without another request. The gesture
waits out the double-click interval, so double and triple clicks still select text, and it
ignores drags, clicks with a modifier key held, links and task-list checkboxes. Clicks in the
margin or between lines start nothing, because every new read is an ElevenLabs request. Set
`markdown-preview-enhanced.readAloudClickToRead` to `false` to keep the play buttons and the
selection affordance only.

### Privacy

With the Kokoro provider the text only ever travels to the local server on `kokoroBaseUrl`.
With ElevenLabs, selected or block text is sent to ElevenLabs when you press play. **Nothing is sent until you
click play** — opening a preview makes no request. ElevenLabs keeps request history by default
(`enable_logging` defaults to true, and zero-retention mode is Enterprise-only), so treat
confidential documents accordingly. Set `markdown-preview-enhanced.readAloudEnabled` to `false`
to remove the buttons and stop the scripts from being injected at all.

### Cost guard, cache and log

The cost guard and the quota notices apply to ElevenLabs only; Kokoro bills nothing. Chunking,
lazy synthesis, the cache and both logs work the same for either provider.

- Only the block (or selection) you asked for is ever sent, and not all at once: the text is
  split at sentence boundaries into a short first chunk (~250 characters, so audio starts after a
  one-or-two-sentence request) and ~700-character chunks after it, and the next chunk is only
  requested once the previous one has started playing. Stopping or pausing never pays for more
  than one chunk beyond what you heard. ElevenLabs bills every character of the `text` sent
  (the 300-character prosody context sent alongside it is free).
- Reads longer than `markdown-preview-enhanced.readAloudConfirmAbove` characters (default
  5,000) ask for confirmation first and show the characters remaining in your quota.
- Audio is cached on disk under `globalStorageUri/read-aloud-cache`, keyed by the chunk text,
  voice and model, and capped by `markdown-preview-enhanced.readAloudCacheSizeMB` (default 100,
  least-recently-used eviction). A cache hit replays instantly with no request and no charge, and
  editing a neighbouring paragraph does not invalidate it. **Markdown Preview Enhanced: Clear
  Read Aloud Cache** empties it.
- Audio is requested as `mp3_44100_64`, which needs no paid tier.
- Every string sent to ElevenLabs is appended, one per line and nothing else, to
  `logs/read-aloud-sent.log` in the workspace folder of the document being read (under the
  extension's global storage when the document has no workspace folder). It is exactly what is
  billed; cache hits never appear. The output channel names the file on first use.
- **Markdown Preview Enhanced: Show Read Aloud Log** opens the _MPE Read Aloud_ output channel:
  one line per request with text length, model, voice, `request-id`, `character-cost`,
  `x-region` and duration. It never contains the API key, and never more than the first 80
  characters of the text.
- `markdown-preview-enhanced.elevenLabsBaseUrl` pins a region, e.g.
  `https://api.eu.residency.elevenlabs.io`.

### Keybindings

| Action               | Chord                  | Active when                                  |
| -------------------- | ---------------------- | -------------------------------------------- |
| Read aloud selection | `⌥R` / `Alt+R`         | the preview panel or custom editor has focus |
| Play/pause           | `⌥Space` / `Alt+Space` | same                                         |
| Stop                 | `⌥Esc` / `Alt+Esc`     | same                                         |

With the player bar focused, <kbd>Space</kbd> plays/pauses, <kbd>Esc</kbd> stops and
<kbd>[</kbd>/<kbd>]</kbd> step through the speed stops.

**On Windows, `Alt+Space` opens the window menu and `Alt+Esc` cycles windows** — the OS wins.
Rebind those two commands in _Keyboard Shortcuts_ if you use Windows.

### Limitations (v1)

- Desktop VS Code only (`engines.vscode` `^1.82.0`, for the host's native `fetch`). The commands
  are disabled and nothing is injected in VS Code for the Web.
- Code, diagrams and math are never read — including a paragraph that contains inline `$…$`.
- One thing plays at a time across all preview panels.
- Kokoro: the server must be running; a stopped server is reported inline, not started for you.

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

Note: `.husky/pre-commit` runs `npx lint-staged`. It is dormant until the next
`pnpm install` wires up the hooks; after that, commits lint and reformat staged files.
`git commit --no-verify` skips it.

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
