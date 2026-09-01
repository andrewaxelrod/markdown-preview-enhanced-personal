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
pnpm build          # gulp copies crossnote assets -> ./crossnote, esbuild bundles -> ./out
npx @vscode/vsce package --no-dependencies
code --install-extension markdown-preview-enhanced-personal-*.vsix --force
```

Then run **Developer: Reload Window** in VS Code.

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
