## 9. Enforcement ladder

From strongest to weakest. Put each constraint at the highest rung that can express it.

### 1. Deterministic deny (no script)

- **Claude Code:** `permissions.deny` in `.claude/settings.json`. Enforced by the client regardless of what the model decides.
- **Codex:** `.codex/rules/*.rules` using `prefix_rule`. Loads when the project `.codex/` layer is trusted. Marked experimental.

  ```python
  prefix_rule(
      pattern = ["git", "push", "--force"],
      decision = "forbidden",
      justification = "Force-push is blocked by repo policy. Use a new branch.",
      match = ["git push --force origin main"],
      not_match = ["git push origin feature"],
  )
  ```

  Test: `codex execpolicy check --pretty --rules .codex/rules/policy.rules -- git push --force origin main`

### 2. PreToolUse hooks (one script, two registrations)

Contract shared by both agents: JSON event on stdin; exit `2` with the reason on stderr to block. Codex also accepts `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..."}}` and can rewrite a call with `permissionDecision: "allow"` plus `updatedInput`.

`hooks/guard.py`:

```python
#!/usr/bin/env python3
import json, re, sys

FORBIDDEN = [
    (r"\brm\s+-rf\s+/", "Refusing recursive delete from root."),
    (r"migrations/\d+_.*\.(sql|ts|py)\b", "Shipped migrations are append-only (ADR-0003)."),
]

event = json.load(sys.stdin)
cmd = str(event.get("tool_input", {}).get("command", ""))
for pattern, reason in FORBIDDEN:
    if re.search(pattern, cmd):
        print(reason, file=sys.stderr)
        sys.exit(2)
sys.exit(0)
```

Claude Code — `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write",
        "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/hooks/guard.py\"" } ] }
    ]
  }
}
```

Codex — `.codex/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write",
        "hooks": [ { "type": "command",
                     "command": "python3 \"$(git rev-parse --show-toplevel)/hooks/guard.py\"",
                     "timeout": 30 } ] }
    ]
  }
}
```

Codex notes: run `/hooks` to review and trust the hook (trust is recorded against the hook's hash, so edits require re-trust); project hooks load only in trusted projects; `Edit`/`Write` are aliases for `apply_patch`; do **not** return `continue` or `stopReason` from a PreToolUse hook (unsupported: the hook is marked failed and the call proceeds). Both vendors say tool hooks are guardrails, not a complete enforcement boundary.

### 3. CI gate (the only layer neither agent can bypass)

- `drift check` for spec↔code drift (Section 10).
- `scripts/check_trace.py` for marker resolution and opt-in requirement coverage (Section 7).
- Optional: an ADR fitness check that runs each ADR's violation pattern against the PR diff.
- Set thresholds *below* the current score, not at the aspirational one, so the gate is green on day one and ratchets.

### 4. Code review rules

A `## Code Review Rules` section in the nearest `AGENTS.md` steers Codex's GitHub PR review. Keep formatting and lint in CI, not here.

### 5. Instructions

Everything else. Treat as advisory.

---