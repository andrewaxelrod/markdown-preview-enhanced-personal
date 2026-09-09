# 7. Specs, ADRs, constitution

## Specs

Keep one living spec per area or feature. Treat that as the current truth. Express changes as deltas. They merge into the living spec once they ship. This is the pattern used by a tool called OpenSpec. If instead you use numbered per-feature directories, the pattern used by a tool called Spec Kit, add a current-state index. That gives the retrieval subagent one authoritative place to look. Avoid ending up with ten isolated per-feature specs and no merged baseline. Nobody reads all ten. An agent will end up hallucinating a constraint from a spec that's actually been superseded.

## ADRs

Architecture decision records, or ADRs, live one per file. They sit under a documentation folder for ADRs. Each is named with a stable numeric ID and a slug. That ID is never renumbered. Reference them from code with the bare ID, at the one or two real decision points only, nowhere else. For example, a comment that just reads "ADR-0007." Don't use a path, since that breaks when things get reorganized. Don't paraphrase the decision either, since a paraphrase rots silently and nothing can check it. The reader is expected to open the ADR itself.

## Linking code to specs

A file called the drift lock file is the single authority for which code a spec governs. That's covered in section ten. Ordinary source files carry nothing themselves. When code and spec disagree, the spec plus the lock file wins. The code gets reported as stale, and a human makes the call. An agent should never be allowed to rewrite a spec to match the code.

Markers exist for the one relation the lock file can't express: requirement-level granularity. They go in exactly three places, always as a bare, stable ID. Never a path, never a paraphrase. First, at the ADR decision point, a comment reading "ADR-0007." A decision lives at one or two lines. Second, on the smallest stable symbol that enforces a non-obvious acceptance criterion, a comment reading "Implements: payments dot refund-window." The lock file binds spec to symbol, not requirement to symbol. Third, on the acceptance test for that criterion, a marker reading "Verifies: payments dot refund-window." Give this as runner metadata where the test framework supports it, otherwise as a comment. The test is where a criterion becomes falsifiable.

Never put these markers in file headers. That's an unbounded claim of governance nothing can check. Also skip ordinary unit tests, generated output, config, migrations, vendored code, dependency-injection wiring, and barrel re-export files. If generated code is itself the contract, as with protobuf stubs, mark the generator input instead. Mirroring your specs directory against your source directory is a useful discovery hint, but it is not a link. Cross-cutting specs like authentication, money, or idempotency will break that mirroring anyway.

Why bare IDs matter: a path breaks on every reorganization of the specs folder, and it duplicates what the lock file already says. A one-line summary is a paraphrase no tool can check against the actual requirement, so it rots silently. A stable ID survives moves and gives both agents and humans a high-precision grep target.

The discovery order for an agent holding a file is this. Run "drift refs" against the file path. Then look for "Implements" markers in the file. Then fall back to the root pointer table and the retrieval subagent.

Declaring IDs works like this. The format is spec slug, dot, requirement slug, all lowercase, and never renamed. Deprecate instead of renaming. Coverage is opt-in per requirement, so context-only items don't fail continuous integration. A requirement's "Needs" line must directly follow its heading with no blank line in between. Both the project's check-trace script and a tool called OpenFastTrace require this. As an example: under a Requirements heading, a sub-heading named "payments dot refund-window" is followed immediately by a line "Needs: impl, test." Then comes the requirement text. The system shall reject a refund requested more than thirty days after capture, with an error code "REFUND_WINDOW_EXPIRED."

On the code side, a function that checks this would carry the marker comment "Implements: payments dot refund-window" directly above it. On the test side, keep test names readable. Put the ID in runner metadata or a marker comment rather than in the test name itself. The exception is when you specifically want to filter tests by ID. A Python test might use a marker decorator reading "verifies: payments dot refund-window," registered in the project's pytest configuration file. A TypeScript test would carry a comment "Verifies: payments dot refund-window" above it.

Three continuous integration gates are required, and all three are cheap to run. The requirements traceability matrix, a document mapping requirements to their implementation and test coverage, is a build artifact produced by the third gate. If anyone hand-edits that matrix, the design has failed. Gate one, called "drift check," catches bound code that changed without its spec changing, as described in section ten. Gate two is ID resolution. Every marker must be a bare ID that resolves to a declared requirement or ADR. Paths, prose, or unknown IDs all fail this gate. Gate three is coverage. Every requirement declaring "Needs: impl, test" must have at least one "Implements" marker and one "Verifies" marker.

A script called check-trace-dot-py implements gates two and three, and it writes the traceability matrix as a build artifact. Here is what it does, step by step.

1. It scans specification files and ADR files to build a table of declared IDs and their coverage needs.
2. It scans all source and test files for marker comments.
3. For each marker found, it checks that the marker resolves to a declared ID and matches a strict format, with nothing else on the line.
4. It flags any marker that's a path or prose as an error, and flags any unknown ID as an error.
5. It checks that every requirement's declared needs are actually satisfied by markers found in the codebase, and reports any gaps.
6. It writes its results to a markdown report file, and exits with a failure status if any errors were found.

Escalation: adopt the stricter OpenFastTrace tooling only when a regulator or auditor is in the loop. There, IDs gain a revision suffix, so "payments dot refund-window" becomes "req tilde payments dot refund-window tilde one." Markers become bracketed tags, like "implemented by req tilde payments dot refund-window tilde one," and similarly for unit tests. A command called "oft trace" produces the report. Two real production users of this pattern are JabRef and Eclipse Ankaios. The revision suffix deliberately orphans every marker when a requirement changes. This forces a human to re-review each site. Adopt this only alongside a rule that an outdated-link failure requires a human re-read. Otherwise agents will simply bump revision numbers to make the build pass. Two adoption footguns to know about. A markdown linting rule, MD022, must be disabled for spec files, because it normally requires a blank line after headings, which conflicts with this format. And IDs can't start with a digit, so an ADR named for something like "integer cents" becomes "adr tilde integer-cents tilde one." If trace integrity is contractually required, skip comments entirely. Generate language-native requirement constants instead, so that removing a requirement breaks the build outright.

## Should source code link to specs?

No. The link runs from the document to the code, never the other way around, with ADR IDs as the one exception. Four directions are worth naming.

- Spec to code: yes, done through a "drift link" command pointing from a spec file to a source symbol, recorded in the drift lock file.
- Code to ADR: yes, but sparingly. A comment like "ADR-0007, colon, then description" at the decision point only, using the ID, never a path.
- Code to spec: no. The reverse lookup is done through "drift refs" on a file, or by grepping the lock file, and the retrieval subagent handles this. The one exception is a stable spec slug, never a path, in a module-level docblock, when a single module implements a single spec end to end.
- Root file to specs: only through a pointer table, with directory paths given as plain text, never actually imported.

The reasoning is this. Paths rot on every rename. Per-file references are exactly the bloat this approach is removing. A spec that governs a file is already discoverable through the lock file. Keeping the binding in one lock file also means continuous integration, humans, and agents are all reading the same source of truth.

## Constitution

Split constitutional clauses by how enforceable they are. A mechanically checkable clause, for instance never run a recursive force-remove command, or never edit a migration that's already shipped, belongs as a deny rule, a hook, or a continuous integration gate. A clause requiring judgment, such as preferring composition over inheritance, belongs as one of five to seven terse imperatives in the root agents file. Rationale and history belong in a separate constitution document, loaded through a constitution skill or the retrieval subagent. A constitution that isn't actually in context is a constitution the agent will violate. That's the argument for putting the imperatives themselves in the root file, not just a pointer to the document.