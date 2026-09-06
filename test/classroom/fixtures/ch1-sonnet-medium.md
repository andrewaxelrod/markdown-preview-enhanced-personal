## Module Introduction

You just read the passage about a ticket called RSK-142 going from an issue to a merge, and somewhere around the part with a maintainer, a risk-engineering code owner, developer platform, InfoSec, an environment reviewer, and something called OIDC, all showing up one after another, it probably stopped making sense as a sequence. You could follow each sentence. You just could not see why all those people needed to be in the room, or what order they actually stand in, or why a deployment job borrows a key instead of just having one.

That is exactly where this module picks up. We are not going to introduce new machinery. Every term in the passage you just read, code owner, required check, protected environment, OIDC, gets explained from zero here, using the same ticket, the same repository, the same pull request you already met. The mission is narrower than the last module's: not what the harness is built from, but who actually has to say yes, in what order, before RSK-142's small change to a risk-scoring module can go live, and why the very last step in that chain uses a borrowed, short-lived credential instead of a stored one.

We'll go roughly in the order the approvals happen, because that is the order that makes each one make sense: first the people, then the checks and the merge button itself, then the line between merging and deploying, and finally that borrowed key. And at the end we'll walk back through the original passage, sentence by sentence, so you can read it the second time and have it hold together.

So let's start with the people. Why does more than one of them have to sign off on the same pull request?

## Ledger

Promises made: none.

Examples used: RSK-142, the age-band factor ticket carried through from Module 1, reused here as the running example for the whole module.

Terms glossed: none in this chapter (framing only; terms are introduced starting next chapter).
