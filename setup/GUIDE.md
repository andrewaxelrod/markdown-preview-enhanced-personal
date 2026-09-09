# Setting this up on another Mac

Everything here installs under your home folder. No step needs an administrator, no package
manager is installed, and nothing is written to `/usr`, `/Library` or `/Applications`.

## What you end up with

| Piece                | Where it lands                                                     | Needed for                      |
| -------------------- | ------------------------------------------------------------------ | ------------------------------- |
| The extension        | `~/.vscode/extensions/andrew.markdown-preview-enhanced-personal-*` | everything                      |
| Kokoro speech server | `~/.local/share/kokoro-fastapi` (~1.3 GB)                          | read aloud                      |
| Login agent          | `~/Library/LaunchAgents/com.andrew.kokoro-fastapi.plist`           | starting the server at login    |
| `uv`                 | `~/.local/bin/uv`                                                  | the server's Python             |
| Your reading data    | the shared folder, via `configPath`                                | notes, modules, spoken editions |
| A headless CLI       | `~/.local/bin/claude`, `copilot` or `codex`                        | help, notes, classroom, retell  |

## Before you start

**The Mac must be Apple Silicon.** This is not a preference. The speech server pins
PyTorch 2.8.0, and that release publishes macOS wheels for `arm64` only, so an Intel Mac cannot
install it. `setup-new-mac.sh` checks this first and stops with an explanation.

**VS Code must already be there.** If it is not, download it and drag it to `~/Applications`.
That needs no administrator either, and the scripts look for it in both `/Applications` and
`~/Applications`.

You also need macOS 11 or newer, about 4 GB free, and a network connection.

Two ordinary-looking commands quietly demand an administrator on a locked-down Mac: `git` and
`/usr/bin/python3` both trigger the Xcode Command Line Tools installer when the tools are
absent. These scripts avoid both, fetching source as a tarball and using the server's own
Python. If you take the GitHub route below you will need `git`, so check first whether
`git --version` answers without offering to install anything.

---

## Route 1: from the shared folder (recommended)

Fastest, and it needs no build tools at all, because the extension is already packaged.

The shared folder is `MarkdownViewer` in iCloud Drive, and it holds the scripts, this guide,
and the last five builds. Open it on the new Mac, wait for iCloud to bring it down, then:

```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/MarkdownViewer

./setup-new-mac.sh --server-only    # the Kokoro speech server, several minutes
./sync.sh install                   # the extension, and your reading data
```

Then run **Developer: Reload Window** in VS Code.

`setup-new-mac.sh --server-only` downloads the server at its pinned commit, builds a Python
3.12 environment, fetches the 312 MB voice model, writes the launch agent, and finishes with a
real timestamped-speech request so you know it works before you ever open VS Code.

`sync.sh install` installs the newest packaged build and points
`markdown-preview-enhanced.configPath` at the shared `data/` folder, so your notes, classroom
modules and spoken editions are the same ones you have on the other Mac. It never overwrites a
file already in the shared folder.

If you are not using iCloud, pass `--dir` to both, or set `MPE_SYNC_DIR`.

---

## Route 2: from GitHub

Use this when you want to build the extension yourself, or when the shared folder is not
available.

```bash
git clone https://github.com/andrewaxelrod/markdown-preview-enhanced-personal.git
cd markdown-preview-enhanced-personal
```

The default branch carries everything, including this folder, so the scripts are already
beside you at `setup/`. Install Node 24 with `nvm`, which installs into your home folder and
needs no administrator, then:

```bash
corepack enable pnpm
pnpm install --frozen-lockfile     # the "Ignored build scripts" warning is expected
./install.sh                       # build, package the .vsix, install it into VS Code

./setup/setup-new-mac.sh --server-only    # the speech server
```

`install.sh` builds, packages and installs in one go, so `setup-new-mac.sh` only has the
server left to do.

---

## Check it worked

```bash
curl -s http://127.0.0.1:8880/health
# {"status":"healthy"}
```

Open a markdown file in VS Code, open the preview, hover a paragraph and press its play button.
A click in a paragraph reads from the nearest word to the end of the document. In the player
bar, the voice button opens **Read aloud setup**, where **Check Kokoro Server** reports the
status and the voice count.

`../test/markdown/basics.md` is a reasonable document to try it on.

`./sync.sh status` prints the whole picture in one go: what the shared folder holds, whether
this Mac points at it, which build is installed, and whether the server is answering.

---

## The optional CLI

Read aloud needs only the speech server. **Help, notes, classroom and retell** additionally
shell out to a headless CLI, chosen by `markdown-preview-enhanced.readAloudHelpEngine`. Without
one, those four features are the only things that will not work.

```bash
curl -fsSL https://claude.ai/install.sh | bash     # Claude Code: installs to ~/.local/bin, no admin
npm install -g @github/copilot                     # or GitHub Copilot CLI (needs a Copilot plan)
```

Then log in once (`claude`, or `copilot login`; Copilot also uses a `gh auth login` the Mac
already has). Pick the one this Mac has with **Markdown Preview Enhanced: Choose Help
Engine** — the setting is per computer, so each Mac keeps its own — and Copilot runs the same
Claude model and effort the claude engine is set to. The Codex CLI works too. Each needs its
own paid account.

If VS Code cannot find the CLI, set `markdown-preview-enhanced.readAloudHelpBinaryPath` to its
absolute path. VS Code launched from the Dock inherits a bare environment and often cannot see
`~/.local/bin`.

---

## On a managed Mac (corporate TLS proxy)

A work Mac often sits behind a proxy that re-signs every HTTPS connection with a company
root certificate installed in the system keychain. Tools that trust the keychain (`curl`,
Safari, VS Code) are fine; tools that carry their own root list fail with a message such as
`invalid peer certificate: UnknownIssuer` or `certificate verify failed`.

`setup-new-mac.sh` already handles the two places this bites the speech server: it sets
`UV_SYSTEM_CERTS=1` so `uv` uses the macOS verifier, and it fetches the voice model with
`curl` and checks the pinned SHA-256 of both files.

The headless CLIs are Node programs and read `NODE_EXTRA_CA_CERTS`. If `claude` or
`copilot login` fails with a certificate error, export the keychain once and point them at it:

```bash
security find-certificate -a -p /Library/Keychains/System.keychain \
  /System/Library/Keychains/SystemRootCertificates.keychain > ~/.local/share/mac-roots.pem
echo 'export NODE_EXTRA_CA_CERTS="$HOME/.local/share/mac-roots.pem"' >> ~/.zprofile
```

VS Code on macOS reads your login shell's environment at startup, so the extension host and
the CLIs it spawns see the variable after the next launch of VS Code.

Two side notes from a managed Mac: `uv`'s warning _Failed to patch the install name of the
dynamic library_ while it installs its Python is harmless here, because nothing is compiled;
and if Xcode is installed but its licence was never accepted, `git` prints _You have not
agreed to the Xcode license_ and stops, which is one more reason the scripts fetch tarballs.

---

## What does not follow you between Macs

Deliberately, because these describe a machine rather than a person:

- **The speech server.** Each Mac runs its own. It cannot be shared over your network as
  configured, because a `kokoroBaseUrl` that is not loopback has to be `https`.
- **The read-aloud audio cache.** It rebuilds itself as you read.
- **Every machine-scoped setting**, which VS Code's own Settings Sync also excludes:
  `kokoroBaseUrl`, `readAloudHelpBinaryPath`, `chromePath`, `pandocPath`, `notesDirectory`,
  `classroomDirectory`, `retellDirectory` and the other tool paths.

Turning on VS Code's Settings Sync is worth doing alongside this, for the rest of the
`markdown-preview-enhanced.*` settings. It will not carry the extension itself, because it
restores extensions from the Marketplace and this build is not published there.

---

## If something is wrong

**Read aloud says it cannot reach the server.**

```bash
launchctl print gui/$(id -u)/com.andrew.kokoro-fastapi | grep -E "state|pid|last exit"
tail -30 ~/Library/Logs/kokoro-fastapi.log
launchctl kickstart -k gui/$(id -u)/com.andrew.kokoro-fastapi
```

**The agent is not loaded at all**, for example after editing the plist:

```bash
launchctl bootout gui/$(id -u)/com.andrew.kokoro-fastapi 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.andrew.kokoro-fastapi.plist
```

**Port 8880 is taken:** `lsof -nP -iTCP:8880 -sTCP:LISTEN`. Set `KOKORO_PORT` to move it.

**`uv` is missing from a new shell:** it lives in `~/.local/bin`. Open a new shell, or
`export PATH="$HOME/.local/bin:$PATH"`.

**The server checkout must stay outside `~/Documents`, `~/Desktop` and `~/Downloads`.** macOS
privacy protection blocks a launchd agent from reading those folders, and the agent then fails
in a loop with "Operation not permitted". The default location is already safe.

---

## The scripts in this folder

| Script             | What it does                                                               |
| ------------------ | -------------------------------------------------------------------------- |
| `setup-new-mac.sh` | installs the server and the extension on a Mac with no admin rights        |
| `sync.sh`          | `release`, `install`, `status` — one build and one set of data across Macs |

Both take `--help`. They resolve the repo root as `$root`, one level up from here, so they
keep working from the shared folder and the transfer bundle where there is no repo above them.
