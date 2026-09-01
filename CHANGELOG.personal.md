# Personal changelog

Local changes made on top of upstream **markdown-preview-enhanced 0.8.32**, tracked
separately from [CHANGELOG.md](CHANGELOG.md) so upstream's history stays conflict-free
when rebasing onto a newer release.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Record new work
under `[Unreleased]` as you go; when rebasing onto a new upstream version, close
`[Unreleased]` into a section named for that version and open a fresh one.

Categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

## [Unreleased]

Nothing yet.

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
