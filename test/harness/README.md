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

| Parameter  | Values                               | Seeds                                                |
| ---------- | ------------------------------------ | ---------------------------------------------------- |
| `theme`    | `light` `dark` `auto` `off`          | `readAloudGlobalTheme`                               |
| `size`     | `16`–`28`                            | `readAloudTextSize`                                  |
| `marker`   | `underline` `box` `off`              | `readAloudWordMarker`                                |
| `dim`      | `0` `1`                              | `readAloudDimWhileReading`                           |
| `autohide` | `0` `1`                              | `readAloudPanelAutoHide`                             |
| `font`     | a player font id                     | `readAloudFont`                                      |
| `palette`  | `blue` `pink` `red` `green` `orange` | `readAloudHighlightTheme`                            |
| `speed`    | `0.25`–`4`                           | `readAloudSpeed`                                     |
| `vscode`   | `light` `dark`                       | the body class `auto` follows                        |
| `audio`    | `kokoro` `silent`                    | Kokoro over CORS, or a silent WAV of 0.32 s per word |
| `kokoro`   | a base URL                           | the server (`http://127.0.0.1:8880` by default)      |

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

`fixture.html` is a rendered document of about sixty blocks in crossnote's markup; `index.html`
is the webview's skeleton with the head in the order `preview-provider.ts` injects it. Nothing
in this directory ships: `.vscodeignore` keeps `test/**` out of the `.vsix`, and `dist/` is
gitignored.
