#!/usr/bin/env bash
#
# setup-new-mac.sh — install the Markdown Preview Enhanced read-aloud stack on a
# second Mac WITHOUT administrator rights.
#
# Everything it creates lives under $HOME:
#
#   ~/.local/bin/uv                                   Python toolchain manager
#   ~/.local/share/kokoro-fastapi                     the speech server + model (~1.3 GB)
#   ~/Library/LaunchAgents/com.andrew.kokoro-fastapi.plist   starts it at login
#   ~/Library/Logs/kokoro-fastapi.log                 its log
#   ~/.vscode/extensions/andrew.markdown-preview-enhanced-personal-*  the extension
#
# Nothing is written to /usr, /Library or /Applications, no package manager is
# installed, and no step calls sudo. The launch agent is registered in the
# per-user GUI domain, and port 8880 is unprivileged.
#
# Usage:
#   ./setup-new-mac.sh                    server + extension
#   ./setup-new-mac.sh --vsix PATH        use a specific .vsix
#   ./setup-new-mac.sh --server-only      skip the VS Code extension
#   ./setup-new-mac.sh --extension-only   skip the speech server
#   ./setup-new-mac.sh --help
#
# Requires: Apple Silicon, macOS 11+, and a network connection. Apple Silicon is
# not a preference: PyTorch 2.8.0 publishes macOS wheels for arm64 only, so an
# Intel Mac cannot install the version this server pins.

set -euo pipefail

KOKORO_COMMIT=d2aae102c0c6ba46770a1cf9c7b86bc0c64342a8
KOKORO_DIR="$HOME/.local/share/kokoro-fastapi"
LABEL=com.andrew.kokoro-fastapi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGFILE="$HOME/Library/Logs/kokoro-fastapi.log"
PORT="${KOKORO_PORT:-8880}"
EXT_ID=andrew.markdown-preview-enhanced-personal

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The extension repo, one level up: these scripts live in its setup/ folder.
root="$(cd "$here/.." && pwd)"
do_server=1
do_extension=1
vsix=""

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

usage() { sed -n '3,28p' "${BASH_SOURCE[0]}" | sed -e 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vsix) vsix="${2:-}"; shift 2 || die "--vsix needs a path" ;;
    --server-only) do_extension=0; shift ;;
    --extension-only) do_server=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------- preflight --

say "Preflight"

[[ "$(uname -s)" == Darwin ]] || die "this script is macOS only."

arch="$(uname -m)"
if [[ "$arch" != arm64 ]]; then
  die "this Mac reports '$arch'. The server pins torch 2.8.0, which publishes
       macOS wheels for arm64 only, so an Intel Mac cannot install it. Options:
       run the server on an Apple Silicon machine and point the extension at it
       with markdown-preview-enhanced.kokoroBaseUrl, or pin an older torch
       (2.2.2 was the last Intel-Mac release) and expect other pins to move too."
fi

macos_major="$(sw_vers -productVersion | cut -d. -f1)"
(( macos_major >= 11 )) || die "macOS 11 or newer is required (found $(sw_vers -productVersion))."

free_kb="$(df -k "$HOME" | awk 'NR==2 {print $4}')"
free_gb=$(( free_kb / 1024 / 1024 ))
(( free_gb >= 4 )) || die "only ${free_gb} GB free in \$HOME; about 4 GB is needed (1.3 GB installed plus download cache)."
info "arm64, macOS $(sw_vers -productVersion), ${free_gb} GB free. No admin rights needed."

if [[ $do_server -eq 1 ]] && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    info "a Kokoro server is already answering on port $PORT."
  else
    die "port $PORT is taken by something that is not Kokoro. Free it, or re-run with KOKORO_PORT set."
  fi
fi

# ------------------------------------------------------------------ server --

if [[ $do_server -eq 1 ]]; then

  say "1/6  uv (downloads its own Python; no system Python or Homebrew)"
  export PATH="$HOME/.local/bin:$PATH"
  # A managed Mac often sits behind a TLS-inspecting proxy whose root lives in
  # the system keychain. uv verifies against bundled Mozilla roots by default and
  # then fails with "invalid peer certificate: UnknownIssuer" on pytorch.org;
  # this makes it use the platform verifier instead (uv 0.12+). Harmless elsewhere.
  export UV_SYSTEM_CERTS=1
  if command -v uv >/dev/null 2>&1; then
    info "already installed: $(command -v uv)"
  else
    curl -LsSf https://astral.sh/uv/install.sh | sh
    hash -r
    command -v uv >/dev/null 2>&1 || die "uv did not land on the PATH; expected ~/.local/bin/uv."
    info "installed $(command -v uv)"
  fi

  say "2/6  Kokoro-FastAPI source at the pinned commit"
  if [[ -e "$KOKORO_DIR/pyproject.toml" ]]; then
    info "already present at $KOKORO_DIR (leaving it alone)"
  else
    # A tarball rather than git clone: git on a stock Mac pulls in the Xcode
    # Command Line Tools, whose installer can ask for an administrator.
    mkdir -p "$KOKORO_DIR"
    info "downloading ${KOKORO_COMMIT:0:8} ..."
    curl -fsSL "https://github.com/remsky/Kokoro-FastAPI/archive/${KOKORO_COMMIT}.tar.gz" \
      | tar xz --strip-components=1 -C "$KOKORO_DIR"
    info "unpacked into $KOKORO_DIR"
  fi

  say "3/6  Python 3.12 virtual environment and dependencies (several minutes)"
  cd "$KOKORO_DIR"
  [[ -x .venv/bin/python ]] || uv venv --python 3.12
  # Every compiled dependency (torch, spacy, av, soundfile, unicode-segmentation-rs,
  # espeakng-loader) ships a macOS arm64 wheel, so nothing is built from source and
  # no C compiler is required. espeak-ng arrives inside its wheel, not from Homebrew.
  #
  # The one exception is pyopenjtalk (Japanese phonemes, required by misaki[ja]):
  # source-only on PyPI, it needs cmake and a C compiler, and on a Mac without the
  # Xcode tools — or with an Xcode whose licence was never accepted, which takes an
  # administrator — the build dies with "/usr/bin/cc is broken". Upstream sidesteps
  # this on Windows with pyopenjtalk-plus, a fork that ships wheels and installs the
  # same `pyopenjtalk` module; this does the same on macOS. The requirement is
  # misaki's, so it is removed the one place uv honours, the project's own override
  # marker (a --override on the command line is merged with it, not put in its
  # place), and the fork is installed after. The server imports it only for Japanese.
  if grep -q "\"pyopenjtalk ; sys_platform != 'win32'\"" pyproject.toml; then
    sed -i '' "s/\"pyopenjtalk ; sys_platform != 'win32'\"/\"pyopenjtalk ; sys_platform == 'never'\"/" pyproject.toml
    info "pyopenjtalk (source-only) left out; pyopenjtalk-plus takes its place"
  fi
  uv pip install -e ".[cpu]"
  if ! .venv/bin/python -c 'import pyopenjtalk' >/dev/null 2>&1; then
    uv pip install --only-binary pyopenjtalk-plus "pyopenjtalk-plus>=0.4.1"
  fi

  say "4/6  Voice model (~312 MB)"
  model_dir=api/src/models/v1_0
  if [[ -f "$model_dir/kokoro-v1_0.pth" ]]; then
    info "already downloaded"
  else
    # curl rather than the repo's docker/scripts/download_model.py: curl trusts
    # the macOS keychain, so a proxy's root is honoured, while uv's Python reads
    # /etc/ssl/cert.pem alone and fails behind one with "certificate verify
    # failed". The URLs and the checksums are the ones that script pins at
    # KOKORO_COMMIT; the checksum is what rejects an error page saved as a model.
    mkdir -p "$model_dir"
    base_url="https://github.com/remsky/Kokoro-FastAPI/releases/download/v0.1.4"
    for f in kokoro-v1_0.pth config.json; do
      info "downloading $f ..."
      curl -fL --retry 3 --progress-bar -o "$model_dir/$f.download" "$base_url/$f"
    done
    (
      cd "$model_dir"
      printf '%s  %s\n' \
        "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4" kokoro-v1_0.pth.download \
        "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f" config.json.download \
        | shasum -a 256 -c --status
    ) || die "voice model checksum mismatch; delete $KOKORO_DIR/$model_dir and run again"
    mv "$model_dir/kokoro-v1_0.pth.download" "$model_dir/kokoro-v1_0.pth"
    mv "$model_dir/config.json.download" "$model_dir/config.json"
    info "verified and in place"
  fi

  say "5/6  Start script and login agent"
  cat > "$KOKORO_DIR/start-local.sh" <<'STARTSH'
#!/bin/bash
# Loopback-only start of Kokoro-FastAPI for the Markdown Preview Enhanced read-aloud feature.
# Mirrors start-cpu.sh but binds to 127.0.0.1 and lets the server auto-detect MPS
# (set USE_GPU=false to force CPU).
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
export USE_GPU="${USE_GPU:-true}"
export PYTHONPATH="$PWD:$PWD/api"
export MODEL_DIR=src/models
export VOICES_DIR=src/voices/v1_0
export WEB_PLAYER_PATH="$PWD/web"
exec uv run --no-sync uvicorn api.src.main:app --host 127.0.0.1 --port "${KOKORO_PORT:-8880}"
STARTSH
  chmod +x "$KOKORO_DIR/start-local.sh"

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${KOKORO_DIR}/start-local.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${KOKORO_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>KOKORO_PORT</key>
    <string>${PORT}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOGFILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOGFILE}</string>
</dict>
</plist>
PLISTEOF
  plutil -lint "$PLIST" >/dev/null || die "the generated plist is malformed: $PLIST"

  # gui/<uid> is the per-user domain. This is not the system domain, so it needs
  # no administrator and touches nothing outside this account.
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  info "agent $LABEL loaded (RunAtLoad + KeepAlive)"

  say "6/6  Waiting for the server, then a timestamped-speech smoke test"
  if ! curl -fsS --retry 40 --retry-delay 3 --retry-connrefused --max-time 200 \
       "http://127.0.0.1:$PORT/health" >/dev/null; then
    die "the server never became healthy. Look at $LOGFILE, then:
       launchctl print gui/$(id -u)/$LABEL | grep -E 'state|pid|last exit'"
  fi
  info "health: $(curl -fsS "http://127.0.0.1:$PORT/health")"

  # The venv's own python, not /usr/bin/python3, which would trigger the Xcode
  # Command Line Tools prompt on a machine that has never had them.
  curl -fsS -X POST "http://127.0.0.1:$PORT/dev/captioned_speech" \
    -H 'Content-Type: application/json' \
    -d '{"model":"kokoro","input":"Hello from Kokoro.","voice":"af_heart","stream":false,"response_format":"mp3","return_timestamps":true,"normalization_options":{"normalize":false}}' \
    | "$KOKORO_DIR/.venv/bin/python" -c \
      'import sys,json; j=json.load(sys.stdin); print("    words:", [t["word"] for t in j["timestamps"]])' \
    || die "the /dev/captioned_speech endpoint did not answer with timestamps. See $LOGFILE."
fi

# --------------------------------------------------------------- extension --

if [[ $do_extension -eq 1 ]]; then
  say "VS Code extension"

  if [[ -z "$vsix" ]]; then
    for candidate in \
      "$here"/markdown-preview-enhanced-personal-*.vsix \
      "$root"/markdown-preview-enhanced-personal-*.vsix
    do
      [[ -f "$candidate" ]] && { vsix="$candidate"; break; }
    done
  fi
  [[ -n "$vsix" && -f "$vsix" ]] || die "no .vsix found. Copy markdown-preview-enhanced-personal-*.vsix
       next to this script, or pass --vsix /path/to/file.vsix."

  code_bin=""
  for candidate in \
    "${CODE_BIN:-}" \
    "$(command -v code 2>/dev/null || true)" \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  do
    [[ -n "$candidate" && -x "$candidate" ]] && { code_bin="$candidate"; break; }
  done

  if [[ -n "$code_bin" ]]; then
    "$code_bin" --install-extension "$vsix" --force
    info "installed $(basename "$vsix") into ~/.vscode/extensions"
  else
    info "VS Code's command line was not found, so install the file by hand:"
    info "  VS Code -> Extensions -> the ... menu -> Install from VSIX..."
    info "  $vsix"
    info "(VS Code itself installs without admin: drag the app to ~/Applications.)"
  fi
fi

# ------------------------------------------------------------------ finish --

say "Done"
[[ $do_server -eq 1 ]] && cat <<SUMMARY
    Speech server  http://127.0.0.1:$PORT   (starts at login, restarts if it dies)
    Log            $LOGFILE
    Restart        launchctl kickstart -k gui/$(id -u)/$LABEL
SUMMARY
cat <<'NEXT'
    In VS Code run "Developer: Reload Window", open a markdown file, open the
    preview, then hover a paragraph and press its play button.

    Read aloud needs only the server above. The help, notes, classroom and
    retell features additionally shell out to a headless CLI, chosen by the
    setting markdown-preview-enhanced.readAloudHelpEngine. Install Claude Code
    without admin with:  curl -fsSL https://claude.ai/install.sh | bash
NEXT
