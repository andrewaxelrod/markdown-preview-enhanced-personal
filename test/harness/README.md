# The Chrome validation harness

`featrues/07-eye-strain-2/spec.md` §18: the real player (`media/read-aloud.js`,
`read-aloud-core.js`) and both stylesheets on a plain page, with the extension host's part
played in memory by `dist/host-shim.js`, so the Claude in Chrome tools — or anyone with a
browser — can drive every reading behaviour without an install-and-reload loop.

## Build and serve

```bash
node test/harness/build.mjs                       # esbuild bundles host-shim.ts -> dist/host-shim.js
python3 -m http.server 8788 --bind 127.0.0.1 --directory "$(pwd)"   # from the repo root
open "http://127.0.0.1:8788/test/harness/index.html?theme=light&size=20"
```

`pnpm build` must have run once, so `./crossnote/` (the preview theme and prism styles the page
links) exists. Pick a fresh port and confirm the served `<title>` — a stale server from an
earlier session once answered on another port — and after a CSS edit re-set each stylesheet
`href` with a `?t=` query from the console, because Chromium caches it across reloads.

## Query parameters

| Parameter         | Values                               | Seeds                                                                                                         |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `theme`           | `light` `dark` `auto` `off`          | `readAloudGlobalTheme`                                                                                        |
| `size`            | `16`–`28`                            | `readAloudTextSize`                                                                                           |
| `marker`          | `underline` `box` `off`              | `readAloudWordMarker`                                                                                         |
| `dim`             | `0` `1`                              | `readAloudDimWhileReading`                                                                                    |
| `autohide`        | `0` `1`                              | `readAloudPanelAutoHide`                                                                                      |
| `font`            | a player font id                     | `readAloudFont`                                                                                               |
| `palette`         | `blue` `pink` `red` `green` `orange` | `readAloudHighlightTheme`                                                                                     |
| `speed`           | `0.25`–`4`                           | `readAloudSpeed`                                                                                              |
| `vscode`          | `light` `dark`                       | the body class `auto` follows                                                                                 |
| `audio`           | `kokoro` `silent`                    | Kokoro over CORS, or a silent WAV of 0.32 s per word                                                          |
| `kokoro`          | a base URL                           | the server (`http://127.0.0.1:8880` by default)                                                               |
| `help`            | `0` `1`                              | `helpAvailable`: the panel's `?` and the affordance's _Explain_                                               |
| `helpdelay`       | ms                                   | how long _Thinking…_ shows before the canned answer (default 400)                                             |
| `notes`           | `0` `1`                              | `notesAvailable`: the cluster's _Note_, the markers, the Notes button and both sheets (12 §18)                |
| `notesdelay`      | ms                                   | how long the pending sheet shows before the canned note fills in (default 1500)                               |
| `count`           | `0`                                  | with `notes=1`, seed no canned notes                                                                          |
| `decoration`      | `marker-and-mark` `marker` `none`    | `notesDecoration`                                                                                             |
| `generate`        | `0` `1`                              | `notesGenerate`: off saves the capture and writes no sections                                                 |
| `classroommarker` | `0` `1`                              | `classroomMarker`: the module markers in the margin (13 §12.5)                                                |
| `shortterm`       | `0` `1`                              | `classroomShortTermModules`: the smaller budgets for a term (13 §6.1)                                         |
| `classroom`       | `0` `1`                              | `classroomAvailable`: the cluster's _Classroom_, the Classroom sheet, canned Prepare and Build (13 §18)       |
| `classroomdelay`  | ms                                   | how long each canned build step takes (default 800)                                                           |
| `classroomfail`   | a chapter number                     | with `classroom=1`, that chapter fails with a canned reason; Continue resumes there                           |
| `module`          | `0` `1`                              | the fixture is a module preview: a canned `classroomModule` in the config, the bar button, the Module sheet   |
| `modulestatus`    | `writing` `done` `stopped` `failed`  | with `module=1`, the module's state (default `writing`)                                                       |
| `retell`          | `0` `1`                              | `retellAvailable`: the cluster's _Retell_, the Retell sheet, canned Prepare and Build (15 §18)                |
| `retellunits`     | `1`                                  | with `retell=1`, Prepare answers section 7 alone (1,740 words · 12 minutes, ceiling 2,243) instead of three   |
| `retellwidened`   | `0` `1`                              | with `retell=1`, Prepared says the selection was widened to the section                                       |
| `retellrebuild`   | `0` `1`                              | with `retell=1`, Prepared carries `rebuildOf`, so the footer is Rebuild and Build another                     |
| `retelldelay`     | ms                                   | how long each canned build step takes (default 800)                                                           |
| `retellfail`      | a section number                     | with `retell=1`, that section fails with a canned reason; Continue resumes there                              |
| `retellmarker`    | `0` `1`                              | `retellMarker`: the ear markers in the margin (15 §12.5)                                                      |
| `edition`         | `0` `1`                              | the fixture is an edition preview: a canned `retellEdition` in the config, the bar button, the Edition sheet  |
| `editionstatus`   | `writing` `done` `stopped` `failed`  | with `edition=1`, the edition's state (default `writing`); with `retell=1`, `stopped` also stops a seeded one |

With no `audio` parameter the shim probes `GET /health` for a second and falls back to the
silent stand-in: the visual behaviours need timing, not speech.

## Driving it

The first click in the page must be a trusted one on a play button (a JS `click()` cannot
unlock audio). Then:

- `window.mpeHarness.checks()` — a JSON report: the page attribute and the three `<html>`
  properties, computed body and `h1` sizes, the column's content width, characters per
  rendered line over the first ten paragraphs, the spoken word's computed colours with the
  text-on-box and stroke-on-pill ratios, the tier of every top-level block, the panel's idle
  state and the strip, the word's position as a fraction of the viewport, and the
  `scrollIntoView` count (which must stay 0).
- `window.mpeHarness.rerender()` — replace the root's children with a fresh copy of the
  fixture, as an `updateHtml` would.
- `window.mpeHarness.charsPerLine(el)` — characters per rendered line of a block.
- `window.mpeHarness.events` — every message, chunk, `play` and `ended` with a timestamp, the
  same lines the console shows with the `[harness]` prefix (check H8 reads the block gaps off
  them).

With `help=1` the shim answers `readAloudHelp` with a **canned five-part answer** in the shape
`src/read-aloud/help-prompt.ts` §14.1 asks for — _What it says_, _Terms_, _In plain words_, _An
example_, _Why it matters_ — rendered as the preview markup the host's engine would produce, and
answers `readAloudHelpCancel` by clearing its timer. Ten blocks, so the sheet is a real reading
scope with real block hand-offs. No CLI is spawned and no model is called: this is for the
sheet's typography and its reading behaviour (09 §14.2), not for the engine.

With `notes=1` the shim seeds **three canned notes** against the fixture — one mid-paragraph,
one on a list item, one whose passage is not in the fixture (an orphan) — and plays the host's
part for every note message from an in-memory store: `readAloudNoteCreate` writes a pending
note at once and fills it in after `notesdelay` ms from a canned skeleton in the shape of
`src/notes/note-prompt.ts` §21.1; update, delete (six seconds, then gone), undo, regenerate,
reattach and the anchors report are applied and echoed as `readAloudNotes`.
`window.mpeHarness.rerender('edited')` replaces the root with a copy in which the noted
paragraph has a sentence added before the passage and the first list item has moved to the next
list, so anchoring steps 2 and 3 run; `checks().notes` reports every marker's right offset and its
top against the passage's first line box, the gutter class, the highlight's range count, the
glyph's ink and its contrast against the surface, the badge contrast, the sheet's width and
measure, the list's rows, the last anchors report and the store.

With `classroom=1` the shim answers `readAloudClassroomPrepare` at once with a **canned
`Prepared`** (Max and a second persona, two linked documents, one existing module, the fixture's
word count) and `readAloudClassroomBuild` with a **sequence of `Progress` messages** built from
the experiment's plan (`test/classroom/fixtures/plan-answer.md`): planning, then each of the six
chapters writing and done, one step every `classroomdelay` ms, then done; chapter 2 comes back
flagged `length-target`, as it did in the experiment. Cancel stops the sequence and posts
stopped; Continue resumes from the first chapter not done; `classroomfail=3` fails chapter 3.
With `module=1` the fixture is a module preview: the bar has the Classroom button with its
badge, `Alt+Shift+C` opens the Module sheet, and the message line follows `modulestatus`.
`checks().classroom` reports the cluster's width and row count, the two sheets' width and
measure, the lever row's contrast, the badge's contrast and the bar's visible button count.

The tab must be **visible** for the re-render checks (C8 and the player's own H-series): a
document re-render is picked up by a `MutationObserver` and decorated on the next animation
frame, and Chromium never delivers a frame to a hidden tab. A synchronous pass — every
`readAloudNotes`, which `window.mpeHarness.postNotes()` triggers — runs regardless, so the
anchoring itself can be checked in a background tab; the frame-scheduled redraw cannot.

With `classroom=1` the shim also seeds **two canned modules** (13 §12.5): one on the noted
paragraph, so its mortarboard marker sits 1.6em under the note marker, and one on a paragraph
with no note; `readAloudClassroomDelete` starts a six-second window and `UndoDelete` cancels
it, both echoed as `readAloudClassroomModules`. `Prepared` carries the §6.1 budgets per shape
and level, so the size line under the lever can be read at every row.

With `retell=1` the shim answers `readAloudRetellPrepare` at once with a **canned `Prepared`**
(three units — section 7 of `featrues/15-convert-readable/experiment/` with its real counts,
1,246 words as 655 prose, 242 in 3 tables and 349 in 7 code blocks, then the two smaller
sections of runs 4 and 5 — the estimate and the ceiling computed from their words the way
`src/retell/estimate.ts` does, the engine label, the document's seeded editions; `retellunits=1`
sends section 7 alone) and `readAloudRetellBuild` with a **sequence of `Progress` messages**:
starting, then each unit writing and done, one step every `retelldelay` ms, then done; the first
unit's words are those of the experiment's run 3 edition (`test/retell/fixtures/
run-3-retry-sonnet-low.md`, imported as text) and the second comes back flagged
`sentence-length`, as run 4 did. Cancel stops the sequence and posts stopped; Continue resumes
from the first unit not done; `retellfail=2` fails unit 2. The shim also seeds **two canned
editions** (15 §12.5): one on the fixture's first `h2`, anchored by its heading text alone with
no block key (the whole-document command's anchor, so `anchorNotes` finds the heading by text),
and one on the noted paragraph, so with `notes=1&classroom=1` its ear marker sits third in the
stack, 1.6em under the module marker which sits 1.6em under the note marker; Delete starts a
six-second window and UndoDelete cancels it, both echoed as `readAloudRetellEditions`. With
`edition=1` the fixture is an edition preview: the bar has the Retell button with its `3/18`
badge, `Alt+Shift+T` opens the Edition sheet with eighteen rows (each a button that opens its
section's source), and the message line follows `editionstatus`. `checks().retell` reports the
cluster's width, row count and button count, the two sheets' width and measure, the section
rows' and the estimate's contrast, every retell marker's block with the computed `top` and the
measured offset of the note, module and retell markers on it (and its `data-mpe-ra-below`
base), the bar's visible button count and the footer's visible buttons.

`fixture.html` is a rendered document of about sixty blocks in crossnote's markup; `index.html`
is the webview's skeleton with the head in the order `preview-provider.ts` injects it. Nothing
in this directory ships: `.vscodeignore` keeps `test/**` out of the `.vsix`, and `dist/` is
gitignored.
