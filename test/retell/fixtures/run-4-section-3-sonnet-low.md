## 3. What goes where

This section walks through a list of content types and says, for each one, where it should live and what the rule of thumb is for putting it there.

Build, test, lint, and typecheck commands go in the root file called AGENTS dot M D. The rule of thumb: give the exact commands, including how to invoke a single test.

Invariants that can't be derived just from reading the code also go in the root AGENTS dot M D, kept to ten lines or fewer. For example, "money is integer cents" belongs there, but "handlers live in source slash A P I" does not, because that's derivable from the code itself.

Constitution imperatives go in the same root file, as five to seven one-line statements, each one requiring judgment to apply.

A pointer table goes in root AGENTS dot M D too, showing where specs, ADRs, the constitution, and bindings live, with paths given in backtick style, meaning shown as plain file references.

The retrieval protocol also belongs in root AGENTS dot M D, written as one paragraph that delegates spec reads to a read-only subagent.

Code review rules go in the root file or the nearest AGENTS dot M D, under a heading called Code Review Rules; this is what drives Codex pull request review.

Area-specific rules go in an AGENTS dot M D file inside the relevant source area directory, paired with a CLAUDE dot M D shim; this covers anything relevant only within one directory tree.

Extension-shaped rules, meaning rules keyed to file patterns rather than one directory, like all test dot T S files or everything under migrations, go into markdown files under dot claude slash rules, each with a paths field. The Codex fallback is a skill whose description names the relevant file types.

Procedures and workflows go into a SKILL dot M D file under dot agents slash skills, named for the procedure; these are multi-step and invoked when relevant, and the description field should front-load trigger words.

The full constitution, specs, and ADRs live under docs and specs directories. They're never imported directly; they're read only by the retrieval subagent.

Spec-to-code links live in a file called drift dot lock, which is the authority, plus bare ID markers placed at acceptance criteria and acceptance tests. These never go in file headers or ordinary source code; see section seven for more.

Source-to-doc references live in code comments, and should contain ADR IDs only, placed at real decision points, never spec paths. The spec-to-code binding itself lives in drift dot lock, again covered in section seven.

Any "never do X" rule that's mechanically checkable belongs in deny rules, hooks, or continuous integration; see section nine.

Maintainer notes go in HTML comments inside CLAUDE dot M D. Block-level comment markers are stripped before injection in Claude Code, at zero token cost.