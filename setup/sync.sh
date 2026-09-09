#!/usr/bin/env bash
#
# sync.sh — keep this personal build, and the reading it produces, the same on
# every Mac you use. Nothing is published anywhere; the extension stays yours.
#
#   ./sync.sh release [--no-build]   on the Mac you build on: put a new build
#                                    into the shared folder
#   ./sync.sh install                on any Mac: install the newest build and
#                                    point it at the shared reading data
#   ./sync.sh status                 what the shared folder holds and what this
#                                    Mac is currently on
#
# The shared folder defaults to iCloud Drive:
#
#   ~/Library/Mobile Documents/com~apple~CloudDocs/MarkdownViewer
#
# Override it with MPE_SYNC_DIR, or --dir PATH. Any folder that syncs itself
# works: Dropbox, a mounted share, or a git clone you pull by hand.
#
# What follows you between machines, and what does not:
#
#   follows      the built .vsix, your notes, classroom modules, spoken
#                editions, and the crossnote config files (config.js,
#                style.less, head.html, parser.js)
#   per machine  the Kokoro speech server, the read-aloud audio cache, and
#                every machine-scoped setting: kokoroBaseUrl, the CLI paths,
#                chromePath, pandocPath
#
# Deliberately no interpreter beyond the shell: /usr/bin/python3 on a stock Mac
# triggers the Xcode Command Line Tools installer, which asks for an admin.

set -euo pipefail

DEFAULT_SYNC="$HOME/Library/Mobile Documents/com~apple~CloudDocs/MarkdownViewer"
sync_dir="${MPE_SYNC_DIR:-$DEFAULT_SYNC}"
KEEP_BUILDS=5
SETTING_KEY="markdown-preview-enhanced.configPath"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The extension repo, one level up: these scripts live in its setup/ folder.
root="$(cd "$here/.." && pwd)"
repo="$root"
vscode_settings="$HOME/Library/Application Support/Code/User/settings.json"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    \033[33m! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

usage() { sed -n '3,32p' "${BASH_SOURCE[0]}" | sed -e 's/^# \{0,1\}//'; }

cmd="${1:-}"; [[ $# -gt 0 ]] && shift || true
no_build=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) sync_dir="${2:-}"; shift 2 || die "--dir needs a path" ;;
    --no-build) no_build=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ "$cmd" == -h || "$cmd" == --help ]] && { usage; exit 0; }

builds_dir="$sync_dir/builds"
data_dir="$sync_dir/data"

# The extension's own default location for notes, modules and editions.
local_data="$HOME/.local/state/crossnote"

find_code() {
  local c
  for c in "${CODE_BIN:-}" "$(command -v code 2>/dev/null || true)" \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  do
    [[ -n "$c" && -x "$c" ]] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

# Read one string setting out of VS Code's settings.json without an interpreter.
read_setting() {
  [[ -f "$vscode_settings" ]] || return 0
  sed -n "s/.*\"${SETTING_KEY//./\\.}\"[[:space:]]*:[[:space:]]*\"\(.*\)\".*/\1/p" \
    "$vscode_settings" | head -1
}

# Insert or replace one string setting, preserving every other line verbatim.
write_setting() {
  local value="$1"
  case "$value" in
    *'"'*|*'\'*) die "the sync path contains a quote or backslash, which this cannot escape safely: $value" ;;
  esac

  if [[ ! -f "$vscode_settings" ]]; then
    mkdir -p "$(dirname "$vscode_settings")"
    printf '{\n    "%s": "%s"\n}\n' "$SETTING_KEY" "$value" > "$vscode_settings"
    info "created $vscode_settings with $SETTING_KEY"
    return
  fi

  cp "$vscode_settings" "$vscode_settings.bak"
  local current; current="$(read_setting)"
  if [[ "$current" == "$value" ]]; then
    info "$SETTING_KEY already points at the shared folder"
    rm -f "$vscode_settings.bak"
    return
  fi

  local tmp; tmp="$(mktemp)"
  if [[ -n "$current" ]]; then
    KEY="$SETTING_KEY" VALUE="$value" awk '
      index($0, "\"" ENVIRON["KEY"] "\"") && !done {
        match($0, /^[ \t]*/); indent = substr($0, 1, RLENGTH)
        comma = ($0 ~ /,[ \t]*$/) ? "," : ""
        printf "%s\"%s\": \"%s\"%s\n", indent, ENVIRON["KEY"], ENVIRON["VALUE"], comma
        done = 1; next
      } { print }
    ' "$vscode_settings" > "$tmp"
    info "updated $SETTING_KEY (was $current)"
  else
    KEY="$SETTING_KEY" VALUE="$value" awk '
      !done && /\{/ {
        print
        printf "    \"%s\": \"%s\",\n", ENVIRON["KEY"], ENVIRON["VALUE"]
        done = 1; next
      } { print }
    ' "$vscode_settings" > "$tmp"
    info "added $SETTING_KEY"
  fi

  # Refuse to leave a settings file that lost or gained more than the one line.
  local before after
  before="$(wc -l < "$vscode_settings")"; after="$(wc -l < "$tmp")"
  if (( after < before )); then
    rm -f "$tmp"
    die "the edit would have dropped lines from settings.json; the original is untouched."
  fi
  mv "$tmp" "$vscode_settings"
  info "previous file kept at $(basename "$vscode_settings").bak"
}

# ------------------------------------------------------------------ release --

do_release() {
  [[ -d "$repo" ]] || die "the extension repo is not next to this script: $repo"

  say "Building and packaging"
  if (( no_build )); then
    "$repo/install.sh" --no-build
  else
    "$repo/install.sh"
  fi

  local vsix
  vsix="$(ls -t "$repo"/markdown-preview-enhanced-personal-*.vsix 2>/dev/null | head -1)" \
    || die "install.sh produced no .vsix"
  [[ -f "$vsix" ]] || die "install.sh produced no .vsix"

  say "Copying into the shared folder"
  mkdir -p "$builds_dir"
  local stamp base target
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  base="$(basename "$vsix" .vsix)"
  target="$builds_dir/$base-$stamp.vsix"
  cp "$vsix" "$target"
  cp "$vsix" "$builds_dir/latest.vsix"     # a copy, not a symlink: iCloud is unreliable with links
  info "$(basename "$target")"

  # The scripts and the guide travel with the builds, so a new Mac needs
  # nothing but this folder.
  local item
  for item in setup-new-mac.sh sync.sh GUIDE.md; do
    if [[ -f "$here/$item" ]]; then
      cp "$here/$item" "$sync_dir/$item"
      [[ "$item" == *.sh ]] && chmod +x "$sync_dir/$item"
      info "$item refreshed alongside it"
    fi
  done

  # Keep the last few builds so a bad one can be rolled back by hand.
  local old
  old="$(ls -t "$builds_dir"/markdown-preview-enhanced-personal-*-*.vsix 2>/dev/null | tail -n +$((KEEP_BUILDS + 1)) || true)"
  if [[ -n "$old" ]]; then
    printf '%s\n' "$old" | while IFS= read -r f; do rm -f "$f"; info "pruned $(basename "$f")"; done
  fi

  write_readme
  say "Done"
  info "On your other Mac: ./sync.sh install"
}

# ------------------------------------------------------------------ install --

do_install() {
  [[ -d "$sync_dir" ]] || die "no shared folder at:
       $sync_dir
       Run './sync.sh release' on the Mac you build on first, or point this at
       an existing folder with --dir PATH."

  # iCloud keeps files as placeholders until something reads them. Pull the
  # whole folder down before the extension tries to open a note.
  if command -v brctl >/dev/null 2>&1 && [[ "$sync_dir" == *"Mobile Documents"* ]]; then
    say "Materialising the iCloud folder"
    brctl download "$sync_dir" 2>/dev/null || warn "brctl download did not run; files will download on first read"
  fi

  say "Reading data"
  mkdir -p "$data_dir"
  if [[ -d "$local_data" ]]; then
    local copied
    copied="$(cd "$local_data" && find . -type f ! -name '.DS_Store' | wc -l | tr -d ' ')"
    # -n never overwrites, so whichever machine wrote a file first keeps it and
    # nothing already in the shared folder is lost.
    (cd "$local_data" && cp -Rn . "$data_dir/" 2>/dev/null || true)
    info "merged $copied local file(s) in; the originals stay at ${local_data/#$HOME/~}"
  fi
  local total
  total="$(find "$data_dir" -type f ! -name '.DS_Store' 2>/dev/null | wc -l | tr -d ' ')"
  info "shared folder now holds $total file(s)"

  say "Pointing VS Code at it"
  write_setting "$data_dir"

  say "Extension"
  local vsix="$builds_dir/latest.vsix"
  if [[ ! -f "$vsix" ]]; then
    vsix="$(ls -t "$builds_dir"/*.vsix 2>/dev/null | head -1 || true)"
  fi
  if [[ -z "$vsix" || ! -f "$vsix" ]]; then
    warn "no build in $builds_dir yet. Run './sync.sh release' on your build Mac."
  else
    local code_bin
    if code_bin="$(find_code)"; then
      "$code_bin" --install-extension "$vsix" --force
      info "installed $(basename "$vsix")"
    else
      warn "VS Code's command line was not found. Install by hand:"
      info "  Extensions -> the ... menu -> Install from VSIX..."
      info "  $vsix"
    fi
  fi

  say "Done"
  cat <<'NEXT'
    Run "Developer: Reload Window" in VS Code.

    Still per machine, by design:
      - the Kokoro speech server            ./setup-new-mac.sh --server-only
      - the headless CLI for help and retell  curl -fsSL https://claude.ai/install.sh | bash
      - the read-aloud audio cache, which rebuilds itself
NEXT
}

# ------------------------------------------------------------------- status --

do_status() {
  say "Shared folder"
  info "$sync_dir"
  if [[ -d "$sync_dir" ]]; then
    local n; n="$(find "$data_dir" -type f ! -name '.DS_Store' 2>/dev/null | wc -l | tr -d ' ')"
    info "reading data: ${n:-0} file(s)"
    if [[ -d "$builds_dir" ]]; then
      info "builds:"
      ls -t "$builds_dir"/*.vsix 2>/dev/null | head -6 | while IFS= read -r f; do
        printf '      %s  %s\n' "$(basename "$f")" "$(date -r "$f" '+%Y-%m-%d %H:%M')"
      done
    else
      warn "no builds yet"
    fi
  else
    warn "does not exist yet"
  fi

  say "This Mac"
  local current; current="$(read_setting)"
  if [[ -z "$current" ]]; then
    info "configPath: unset, so reading data goes to ${local_data/#$HOME/~}"
  elif [[ "$current" == "$data_dir" ]]; then
    info "configPath: pointed at the shared folder"
  else
    warn "configPath: $current (not the shared folder)"
  fi

  local installed
  installed="$(ls -d "$HOME/.vscode/extensions/andrew.markdown-preview-enhanced-personal-"* 2>/dev/null | head -1 || true)"
  if [[ -n "$installed" ]]; then
    info "extension: $(basename "$installed")"
  else
    warn "extension: not installed"
  fi

  if curl -fsS --max-time 2 http://127.0.0.1:8880/health >/dev/null 2>&1; then
    info "kokoro server: healthy on 127.0.0.1:8880"
  else
    warn "kokoro server: not answering (./setup-new-mac.sh --server-only)"
  fi
}

write_readme() {
  cat > "$sync_dir/README.md" <<'SYNCREADME'
# Markdown viewer, shared between my Macs

This folder is not a distribution channel. It is how one personal build and one
set of reading data reach every Mac I use.

## On a Mac that already has this set up

```bash
./sync.sh install
```

Installs the newest build from `builds/` and points VS Code at `data/`.
Then run **Developer: Reload Window**.

## On a brand-new Mac

```bash
./setup-new-mac.sh --server-only    # the Kokoro speech server, no admin needed
./sync.sh install                   # the extension and the reading data
```

The speech server is per machine and cannot be shared over the network as
configured, because a non-loopback `kokoroBaseUrl` has to be https.

## After changing the extension source

On the Mac with the repo:

```bash
./sync.sh release
```

Builds, installs locally, and drops the new `.vsix` here. The last five builds
are kept so a bad one can be rolled back by installing an older file by hand.

## What is in here

| Path      | What                                                          |
| --------- | ------------------------------------------------------------- |
| `builds/` | packaged extensions, newest also copied to `latest.vsix`       |
| `data/`   | notes, classroom modules, spoken editions, crossnote config    |

`data/` is the value of `markdown-preview-enhanced.configPath`. Notes, modules
and editions default to folders underneath it, so that one setting moves all of
them together.

## What stays on each machine

The Kokoro server, the read-aloud audio cache, and every machine-scoped setting:
`kokoroBaseUrl`, `readAloudHelpBinaryPath`, `chromePath`, `pandocPath` and the
other tool paths. That is deliberate. Those describe a machine, not a person.
SYNCREADME
  info "README.md written into the shared folder"
}

case "$cmd" in
  release) do_release ;;
  install) do_install ;;
  status)  do_status ;;
  "")      usage; exit 2 ;;
  *)       die "unknown command: $cmd (try --help)" ;;
esac
