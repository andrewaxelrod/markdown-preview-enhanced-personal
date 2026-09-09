## 3. What goes where

| Content | Location | Rule of thumb |
|---|---|---|
| Build, test, lint, typecheck commands | root `AGENTS.md` | Exact commands, including single-test invocation |
| Invariants not derivable from code | root `AGENTS.md` | ≤10 lines. "Money is integer cents" belongs; "handlers live in src/api" does not (derivable) |
| Constitution imperatives | root `AGENTS.md` | 5–7 one-liners that require judgment to apply |
| Pointer table | root `AGENTS.md` | Where specs, ADRs, constitution, bindings live. Paths in backticks |
| Retrieval protocol | root `AGENTS.md` | One paragraph: delegate spec reads to a read-only subagent |
| Code review rules | root or nearest `AGENTS.md` | `## Code Review Rules` section; drives Codex PR review |
| Area-specific rules | `src/<area>/AGENTS.md` + `CLAUDE.md` shim | Anything only relevant inside one directory tree |
| Extension-shaped rules | `.claude/rules/*.md` with `paths:` | Rules keyed to `**/*.test.ts`, `**/migrations/*` etc. that don't map to one directory. Codex fallback: a skill whose description names the file types |
| Procedures and workflows | `.agents/skills/<name>/SKILL.md` | Multi-step, invoked when relevant. Front-load trigger words in `description` |
| Full constitution, specs, ADRs | `docs/`, `specs/` | Never imported. Read by the retrieval subagent |
| Spec↔code links | `drift.lock` (authority) plus bare-ID markers at acceptance criteria and acceptance tests | Never in file headers or ordinary source. See Section 7 |
| Source → doc references | Code comments | ADR IDs only, at real decision points. Never spec paths; the spec→code binding lives in `drift.lock` (Section 7) |
| "Never do X" that is mechanically checkable | deny rules, hooks, CI | See Section 9 |
| Maintainer notes | HTML comments in `CLAUDE.md` | Block-level `<!-- -->` is stripped before injection in Claude Code (zero token cost) |

---