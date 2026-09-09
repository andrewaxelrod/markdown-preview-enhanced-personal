## 7. Specs, ADRs, constitution

### Specs

Keep **one living spec per area or feature** that is the current truth. Express changes as deltas that merge into the living spec when they ship (the OpenSpec pattern). If you use numbered per-feature directories (the Spec Kit pattern), add a current-state index so the retrieval subagent has one authoritative place to look.

Avoid ten isolated per-feature specs with no merged baseline. Nobody reads all ten, and an agent will hallucinate a constraint from a superseded one.

### ADRs

- `docs/adr/NNNN-slug.md`, one decision per file, stable numeric ID, never renumbered.
- Reference from code with the **bare ID** at the one or two real decision points, nowhere else:

  ```ts
  // ADR-0007
  ```

  No path (breaks on reorganization) and no paraphrase of the decision (rots silently; nothing can check it). The reader opens the ADR.

### Linking code to specs

`drift.lock` is the single authority for which code a spec governs (Section 10). Ordinary source files carry **nothing**. When code and spec disagree, the spec plus lockfile wins: report the code as stale and get a human decision. Never let an agent rewrite a spec to match the code.

Markers exist for the one relation the lockfile cannot express, requirement-level granularity, and go in exactly three places, always as a **bare, stable ID**: no path, no paraphrase.

| Place | Marker | Why here |
|---|---|---|
| ADR decision point | `// ADR-0007` | A decision lives at one or two lines |
| Smallest stable symbol that enforces a non-obvious acceptance criterion | `// Implements: payments.refund-window` | The lockfile binds spec→symbol, not requirement→symbol |
| The acceptance test for that criterion | `Verifies: payments.refund-window` as runner metadata where supported, else a comment | The test is where a criterion becomes falsifiable |

Never mark: file headers (an unbounded claim of governance that nothing can check), ordinary unit tests, generated output, config, migrations, vendored code, DI wiring, barrel re-exports. If generated code *is* the contract (protobuf stubs), mark the generator input. Directory mirroring (`specs/<area>` ↔ `src/<area>`) is a discovery hint, not a link; cross-cutting specs (auth, money, idempotency) break it.

Why bare IDs: a path breaks on every `specs/` reorganization and duplicates the lockfile; a one-line summary is a paraphrase no tool can check against the requirement, so it rots silently. A stable ID survives moves and is a high-precision grep target for both agents.

Discovery order for an agent holding a file: `drift refs <path>` → `Implements:` markers in the file → the root pointer table and retrieval subagent.

**Declaring IDs.** `<spec-slug>.<requirement-slug>`, lowercase, never renamed (deprecate instead). Coverage is opt-in per requirement so context-only items don't fail CI. The `Needs:` line must directly follow the heading with no blank line (the script below and OpenFastTrace both require this):

```markdown
## Requirements

### payments.refund-window
Needs: impl, test
The system SHALL reject a refund requested more than 30 days after capture
with `REFUND_WINDOW_EXPIRED`.
```

**Code:**

```ts
// Implements: payments.refund-window
export function assertWithinRefundWindow(captured: Date, now: Date): void {
  if (daysBetween(captured, now) > 30) throw new PaymentError("REFUND_WINDOW_EXPIRED");
}
```

**Tests.** Keep names readable; put the ID in runner metadata or a marker comment, not the name (unless you want `pytest -k` filtering by ID):

```python
@pytest.mark.verifies("payments.refund-window")
def test_refund_on_day_31_is_rejected():
    ...
```

```toml
# pyproject.toml
[tool.pytest.ini_options]
markers = ["verifies(id): acceptance test for a spec requirement"]
```

```ts
// Verifies: payments.refund-window
it("rejects a refund on day 31", () => {
  expect(() => assertWithinRefundWindow(day(0), day(31))).toThrow("REFUND_WINDOW_EXPIRED");
});
```

**CI gates.** Three, all cheap. The requirements traceability matrix is a build artifact of gate 3; if anyone hand-edits a matrix, the design has failed.

1. `drift check` — bound code changed without its spec (Section 10).
2. ID resolution — every marker is a bare ID that resolves to a declared requirement or ADR. Paths, prose, and unknown IDs fail.
3. Coverage — every requirement declaring `Needs: impl, test` has at least one `Implements:` and one `Verifies:` marker.

`scripts/check_trace.py` implements gates 2 and 3 and writes `build/rtm.md`:

```python
#!/usr/bin/env python3
"""CI gate: spec/ADR markers must be bare, declared IDs; opt-in coverage; emits build/rtm.md."""
import re, sys, collections
from pathlib import Path

ROOTS = ["src", "tests"]
EXT = {".ts", ".tsx", ".js", ".py", ".go", ".rs", ".java", ".cs"}
ID = r"[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*"

declared, needs = {}, {}
for spec in Path("specs").rglob("spec.md"):
    for m in re.finditer(rf"^### ({ID})\n(?:Needs:\s*([\w, ]+))?", spec.read_text(), re.M):
        declared[m[1]] = spec
        needs[m[1]] = {n.strip() for n in (m[2] or "").split(",") if n.strip()}
for adr in Path("docs/adr").glob("[0-9][0-9][0-9][0-9]-*.md"):
    declared[f"ADR-{adr.name[:4]}"] = adr

STRICT = [  # a marker must be the whole comment; anything else on the line fails
    re.compile(rf"^\s*(?://|#|/\*|\*|<!--)?\s*(Implements|Verifies):\s*({ID})\s*(?:\*/|-->)?\s*$"),
    re.compile(rf"\.mark\.(verifies|implements)\(\s*[\"']({ID})[\"']\s*\)"),
    re.compile(r"^\s*(?://|#|/\*|\*)?\s*(ADR)-(\d{4})\s*(?:\*/)?\s*$"),
]
LOOSE = re.compile(r"\b(?:Implements|Verifies):|\bADR-\d{4}\b|\.mark\.(?:verifies|implements)\(")
KIND = {"implements": "impl", "verifies": "test", "adr": "adr"}

found, errors = collections.defaultdict(set), []
for root in ROOTS:
    for f in Path(root).rglob("*"):
        if not (f.is_file() and f.suffix in EXT):
            continue
        for n, line in enumerate(f.read_text(errors="ignore").splitlines(), 1):
            if not LOOSE.search(line):
                continue
            m = next((m for rx in STRICT if (m := rx.search(line))), None)
            if not m:
                errors.append(f"{f}:{n}: marker must be a bare declared ID, no path or prose: {line.strip()}")
                continue
            kind, id_ = m[1].lower(), (f"ADR-{m[2]}" if m[1] == "ADR" else m[2])
            if id_ not in declared:
                errors.append(f"{f}:{n}: unknown ID {id_}")
            else:
                found[id_].add(KIND[kind])

for id_, req in needs.items():
    if missing := req - found[id_]:
        errors.append(f"{declared[id_]}: {id_} needs {', '.join(sorted(req))} but lacks {', '.join(sorted(missing))}")

out = Path("build/rtm.md"); out.parent.mkdir(exist_ok=True)
out.write_text("| ID | impl | test | source |\n|---|---|---|---|\n" + "".join(
    f"| {i} | {'x' if 'impl' in found[i] else ''} | {'x' if 'test' in found[i] else ''} | {declared[i]} |\n"
    for i in sorted(declared)))
print("\n".join(errors) if errors else f"trace: ok ({len(declared)} IDs, RTM at {out})")
sys.exit(1 if errors else 0)
```

**Escalation.** Adopt OpenFastTrace only when a regulator or auditor is in the loop: IDs become `req~payments.refund-window~1`, markers become `[impl->req~payments.refund-window~1]` and `[utest->…]`, and `oft trace` produces the report. JabRef and Eclipse Ankaios run this in production. The revision suffix deliberately orphans every marker when a requirement changes, forcing per-site re-review; adopt it only with a rule that an outdated-link failure requires a human re-read, or agents will bump revisions to make CI green. Two adoption footguns: markdownlint MD022 must be disabled for spec files (no blank line after the heading), and IDs cannot start with a digit, so ADRs become `adr~integer-cents~1`. If trace integrity becomes contractual, skip comments and generate language-native requirement constants so removing a requirement breaks the build.

### Should source code link to specs?

No. The link runs from the doc to the code, never the other way, with ADR IDs as the one exception.

| Direction | Do it? | How |
|---|---|---|
| Spec → code | Yes | `drift link specs/<slug>/spec.md src/x.ts#Symbol`; recorded in `drift.lock` |
| Code → ADR | Yes, sparingly | `// ADR-0007: ...` at the decision point only; ID, never path |
| Code → spec | No | Reverse lookup is `drift refs <file>` or a grep of `drift.lock`; the retrieval subagent does this. Exception: a stable spec slug (never a path) in a module-level docblock when one module implements one spec end to end |
| Root file → specs | Pointer table only | Directory paths in backticks; never imported |

Why: paths rot on every rename, per-file references are the bloat being removed, and a spec that governs a file is already discoverable through `drift.lock`. Keeping the binding in one lockfile also means CI, humans, and agents all read the same source of truth.

### Constitution

Split by enforceability:

| Clause type | Where it lives |
|---|---|
| Mechanically checkable ("never run `rm -rf`", "never edit a shipped migration") | Deny rule, hook, or CI gate |
| Requires judgment ("prefer composition over inheritance") | 5–7 terse imperatives in root `AGENTS.md` |
| Rationale and history | `docs/constitution.md`, loaded via a `constitution` skill or the retrieval subagent |

A constitution that is not in context is a constitution the agent will violate. That argues for putting the *imperatives* in the root, not the *document*.

---
