#!/usr/bin/env bash
#
# Build, package and install this extension into your everyday VS Code.
#
#   ./install.sh              pnpm build, package the .vsix, install it
#   ./install.sh --no-build   package and install what is already in ./out
#                             (for when `pnpm watch` keeps it current)
#   ./install.sh --help
#
# Finish by running "Developer: Reload Window" in VS Code.
#
# The `code` CLI is taken from $CODE_BIN, then PATH, then the macOS app
# bundle (/Applications/Visual Studio Code.app), so the script works before
# "Shell Command: Install 'code' command in PATH" has been run.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

usage() {
  sed -n '3,14p' "${BASH_SOURCE[0]}" | sed -e 's/^# \{0,1\}//'
}

build=1
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "install.sh: unknown option: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

find_code() {
  if [[ -n "${CODE_BIN:-}" ]]; then
    printf '%s\n' "$CODE_BIN"
    return 0
  fi
  if command -v code > /dev/null 2>&1; then
    command -v code
    return 0
  fi
  local mac_app="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  if [[ -x "$mac_app" ]]; then
    printf '%s\n' "$mac_app"
    return 0
  fi
  echo "install.sh: VS Code CLI not found. In VS Code run \"Shell Command: Install 'code' command in PATH\", or set CODE_BIN=/path/to/code." >&2
  return 1
}

code_bin="$(find_code)"

if ((build)); then
  pnpm build
elif [[ ! -f out/native/extension.js ]]; then
  echo "install.sh: ./out has no build yet; run without --no-build." >&2
  exit 1
fi

# One .vsix at a time, so the install below never guesses between versions.
rm -f markdown-preview-enhanced-personal-*.vsix
npx @vscode/vsce package --no-dependencies

vsix=(markdown-preview-enhanced-personal-*.vsix)
if [[ ${#vsix[@]} -ne 1 || ! -f ${vsix[0]} ]]; then
  echo "install.sh: expected exactly one packaged .vsix, found: ${vsix[*]}" >&2
  exit 1
fi

"$code_bin" --install-extension "${vsix[0]}" --force

echo
echo "Installed ${vsix[0]}. Now run \"Developer: Reload Window\" in VS Code."
