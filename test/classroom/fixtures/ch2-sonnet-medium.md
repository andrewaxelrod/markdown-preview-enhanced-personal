## Who Is a Code Owner, And Why Do Several People Have to Say Yes

So let's start with the people. Why does more than one of them have to sign off on the same pull request?

The plain answer is that different people are protecting different things, and none of them can see all of it alone. The risk-engineering owner knows whether the age-band math is right. Developer platform knows whether a change to the harness itself, an instruction file, a hook, a workflow, is safe to run. InfoSec knows whether a change touches something sensitive enough to need a second set of eyes regardless of who wrote it. One approval from one person only ever covers one of those three questions.

Let's take a closer look at how GitHub actually knows whom to ask. The mechanism is a file called CODEOWNERS, which lives in the repository and does one simple job: it maps paths, meaning folders and files, to the people or teams who own them. It says, in effect, if a change touches this path, these are the people who must review it. On its own, remember, that file is just a sign, the same as the instruction files from the chapter on files that shape a worker. It is a strong hint about who should look, but nothing stops a pull request from merging without them, unless something else backs it up.

That something else is the ruleset, the branch policy we met when we looked at GitHub as the enforcement plane. A ruleset can require code-owner review, and once it does, CODEOWNERS stops being a suggestion and becomes part of the lock. The pull request simply cannot merge until the owners of every path it touches have approved. That pairing, a CODEOWNERS file plus a ruleset that requires it, is the answer to most governance questions you will be asked in this course. Remember that pairing.

Now picture it as a tree, so the shape is clear.

```ascii
CODEOWNERS: who must approve, by path

src/RiskScoring/            risk engineers
tests/RiskScoring.Tests/    risk engineers
.github/                    developer platform (+ InfoSec on the sensitive files)
infrastructure/             cloud platform + InfoSec
```

What the tree shows is that a single pull request can cross several of these paths at once, and each one it crosses adds a required reviewer. Back to RSK-142, our running ticket: if the agent's pull request only touches the risk-scoring source file, its test, and the documentation page, as the issue specified, then only the risk-engineering owner is required. The moment a pull request strays into the dot github folder, developer platform is pulled in too, and if it touches the most sensitive of those files, InfoSec joins as well. The reviewers required are a direct readout of which paths actually changed, not a fixed list applied to everything.

This is crucial to understand: separate owners exist because a single reviewer, however careful, is being asked to judge things outside their expertise the moment a change crosses a boundary. The risk-engineering owner should not be the one deciding whether a workflow change is safe. Developer platform should not be the one deciding whether an age band is medically or actuarially sound. Splitting review by path is what makes each approval mean something specific, rather than one tired signature meaning everything.

Both chairs here. As the engineer working the ticket, this mostly shows up as more requested reviewers than you expected, and now you know why: your diff touched a path you did not think of as sensitive. As the person building the harness, CODEOWNERS is one of your first deliverables, and it is only as good as how narrowly you have drawn the paths. Draw them too broadly and everyone reviews everything, which is nearly the same as nobody reviewing anything carefully. Draw them too narrowly and a sensitive file slips through unowned.

So that is why several people say yes instead of one: each approval is scoped to a path, the CODEOWNERS file says who owns which path, and the ruleset is what turns that ownership from a sign into something the merge button actually obeys. But approval is only half of what stands between a pull request and the merge button. The other half is a set of automated checks, and one of those checks is Copilot's own review of the code, which, as it happens, does not count as an approval at all. Why not, and what does have to be true before that button turns clickable?

## Ledger

Promises made: none.

Examples used: RSK-142, the age-band factor ticket, used to show which paths trigger which required reviewers.

Terms glossed: code owner, the person or team responsible for reviewing changes to a given path; CODEOWNERS file, the file that maps paths to their owners; ruleset, the branch policy that can turn code-owner review from a suggestion into a requirement (recalled from an earlier module chapter, re-glossed here for a reader jumping in).
