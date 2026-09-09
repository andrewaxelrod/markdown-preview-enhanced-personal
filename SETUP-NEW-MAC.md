# Setting up on another Mac — the runbook

The copy-paste version, as it was actually done on 2026-09-09 on a managed work Mac with no
administrator rights and a TLS-inspecting proxy. Every step installs under your home folder.
[`setup/GUIDE.md`](setup/GUIDE.md) is the longer walkthrough with the reasoning; this file is
the order of commands.

**You need:** an Apple Silicon Mac, macOS 11 or newer, VS Code already installed (in
`/Applications` or `~/Applications`), about 4 GB free, and a network connection. No `git`, no
Homebrew, no Xcode, no `sudo`.

---

## 1. Get the repo without git

`git` on a stock Mac triggers the Xcode Command Line Tools installer, which asks for an
administrator, and on a Mac where Xcode is present but its licence was never accepted it stops
with _You have not agreed to the Xcode license_. So take the zip. `curl` trusts the macOS
keychain, which is why it works behind a company proxy where other tools do not.

```bash
cd ~/Downloads
curl -fL https://github.com/andrewaxelrod/markdown-preview-enhanced-personal/archive/refs/heads/main.zip -o mpe.zip
unzip -q mpe.zip
cd markdown-preview-enhanced-personal-main
```

(Or GitHub → **Code** → **Download ZIP**, which lands in the same folder name.)

---

## 2. The speech server (Kokoro)

```bash
./setup/setup-new-mac.sh --server-only
```

Several minutes. It installs `uv` to `~/.local/bin`, unpacks the server at its pinned commit
into `~/.local/share/kokoro-fastapi`, builds a Python 3.12 environment, fetches the 312 MB voice
model, writes a login agent, starts the server on `127.0.0.1:8880`, and ends with a real
timestamped-speech request. Steps already done are skipped, so rerunning after a failure is
safe.

Behind a company proxy this is already handled: the script sets `UV_SYSTEM_CERTS=1` so `uv`
verifies through the macOS keychain instead of its bundled roots (the failure otherwise is
`invalid peer certificate: UnknownIssuer` while fetching torch), and it downloads the voice
model with `curl` and checks both files against their pinned SHA-256.

Use `--server-only`: a zip download carries no `.vsix`, so the plain run would finish the
server and then stop with _no .vsix found_.

Check:

```bash
curl -s http://127.0.0.1:8880/health
# {"status":"healthy"}
```

---

## 3. The extension (`.vsix`)

The build is not on the Marketplace, so the file has to reach the new Mac. Three ways.

**A. Send the file from the Mac that builds** (AirDrop, iCloud Drive, a USB stick). On the
building Mac, `./install.sh` leaves it at the repo root as
`markdown-preview-enhanced-personal-0.8.32.vsix`. On the new Mac:

```bash
./setup/setup-new-mac.sh --extension-only --vsix ~/Downloads/markdown-preview-enhanced-personal-0.8.32.vsix
```

**B. Build it on the new Mac.** Needs Node 24 through `nvm` (installs into your home folder,
no administrator) and pnpm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
exec zsh
nvm install 24
corepack enable pnpm
pnpm install --frozen-lockfile     # the "Ignored build scripts" warning is expected
./install.sh                       # build, package, install into VS Code
```

Behind a company proxy, `npm` needs the keychain roots too: see §7 and set
`NODE_EXTRA_CA_CERTS` first.

**C. The shared iCloud folder**, when both Macs are on your iCloud. On the building Mac,
`./setup/sync.sh release --no-build` puts the current build into `MarkdownViewer` in iCloud
Drive; on the new Mac, `./setup/sync.sh install` installs it and points `configPath` at the
shared reading data (notes, classroom modules, spoken editions).

Whichever way: run **Developer: Reload Window** in VS Code afterwards.

---

## 4. The help CLI

Read aloud needs only the server. **Help, notes, classroom and retell** shell out to a headless
CLI, and one Mac often has one CLI and not the other: the engine setting is per computer.

### Copilot CLI

The install script puts the real CLI in `~/.local/bin` with no administrator. Do not count on
the `copilot` that VS Code's Copilot Chat extension adds to the PATH: that is a launcher that
asks to run `npm install` on stdin, not the CLI, and the extension skips it.

```bash
curl -fsSL https://gh.io/copilot-install | bash
export PATH="$HOME/.local/bin:$PATH"      # new shells get it from the login profile
copilot --version                         # GitHub Copilot CLI 1.0.83 or newer
copilot login                             # browser flow; a gh CLI already logged in also works
copilot -p "Reply with exactly: pong" --model claude-sonnet-5 --silent
```

If `copilot login` fails with a certificate error, do §7 first.

### Claude Code CLI (the alternative)

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude                                    # sign in once, then quit
```

### Point the extension at it

1. Command palette → **Markdown Preview Enhanced: Choose Help Engine** → `copilot` (or
   `claude`). The pick shows the path each CLI was found at, or _not found on this computer_.
2. **Markdown Preview Enhanced: Choose Help Model** → `sonnet`. Copilot runs the same Claude
   model and effort as the claude engine; on the Copilot plan tested here every Fable and Opus
   id was refused as not available and `claude-sonnet-5` answered, so `fable` there only produces
   a message naming the models tried.
3. If VS Code was launched from the Dock and cannot see `~/.local/bin`, set the machine-scope
   path setting:

```json
"markdown-preview-enhanced.readAloudHelpBinaryPath": { "copilot": "/Users/<you>/.local/bin/copilot" }
```

---

## 5. Check it works

Open a markdown file, open the preview, hover a paragraph and press its play button; a click
in a paragraph reads from that word to the end of the document. Select a sentence and press
`⌥H`: the sheet's label should read `copilot · sonnet · low` (or `claude · …`) and the
explanation is read aloud when it arrives.

```bash
./setup/sync.sh status      # shared folder, configPath, installed build, server health
```

---

## 6. What stays per machine

The speech server, the audio cache, and every machine-scope setting: `readAloudHelpEngine`,
`readAloudHelpBinaryPath`, `kokoroBaseUrl`, `notesDirectory`, `classroomDirectory`,
`retellDirectory`, `chromePath`, `pandocPath`. VS Code's Settings Sync carries the rest of the
`markdown-preview-enhanced.*` settings but not the extension itself.

---

## 7. Behind a company proxy

A managed Mac often sits behind a proxy that re-signs every HTTPS connection with a company
root installed in the system keychain. Tools that trust the keychain (`curl`, Safari, VS Code)
are fine; tools that carry their own root list fail with `invalid peer certificate:
UnknownIssuer` or `certificate verify failed`.

The setup script handles the server (§2). The CLIs and `npm` are Node programs and read
`NODE_EXTRA_CA_CERTS`; export the keychain once:

```bash
security find-certificate -a -p /Library/Keychains/System.keychain \
  /System/Library/Keychains/SystemRootCertificates.keychain > ~/.local/share/mac-roots.pem
echo 'export NODE_EXTRA_CA_CERTS="$HOME/.local/share/mac-roots.pem"' >> ~/.zprofile
exec zsh
```

VS Code on macOS reads the login shell's environment at startup, so the extension host and the
CLIs it spawns see the variable after VS Code is next launched.

---

## 8. If something is wrong

| Symptom                                                         | What to do                                                                                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid peer certificate: UnknownIssuer` from `uv`             | You have an old copy of the script. Re-download the zip (§1) or refresh just the script with `curl` and rerun `--server-only`.                 |
| `certificate verify failed` from `copilot`, `claude` or `npm`   | §7.                                                                                                                                            |
| _no .vsix found_                                                | §3: send or build the `.vsix`, then `--extension-only --vsix PATH`.                                                                            |
| _You have not agreed to the Xcode license_                      | Something ran `git`. Use the zip route; nothing here needs git.                                                                                |
| `uv`: _Failed to patch the install name of the dynamic library_ | Harmless; nothing is compiled from source.                                                                                                     |
| Read aloud says it cannot reach the server                      | `launchctl kickstart -k gui/$(id -u)/com.andrew.kokoro-fastapi`, then `tail -30 ~/Library/Logs/kokoro-fastapi.log`.                            |
| Help says _Could not find the copilot command_                  | The message names the CLIs that are installed; install (§4) or switch with **Choose Help Engine**. The VS Code launcher is skipped on purpose. |
| Help says _… not available on this Copilot plan_                | **Choose Help Model** → `sonnet`.                                                                                                              |
| Port 8880 is taken                                              | `lsof -nP -iTCP:8880 -sTCP:LISTEN`; set `KOKORO_PORT` to move it.                                                                              |

The refresh-only-the-script line, for the first row:

```bash
curl -fsSL https://raw.githubusercontent.com/andrewaxelrod/markdown-preview-enhanced-personal/main/setup/setup-new-mac.sh -o setup/setup-new-mac.sh
```
