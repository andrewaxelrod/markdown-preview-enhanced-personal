## Module Introduction

You were reading about RSK-142, our age-band ticket, and you got to the passage where the agent stops at a draft pull request and a whole line of humans and machines takes over from there: a maintainer checking the diff, code owners reviewing, checks running, someone approving a deployment, and a job reading a token instead of a password. And you said, fairly, that you did not get who approves what, in what order, or why that token business, called OIDC, mattered at all.

So this section is all about slowing that passage down until every sentence in it is obvious. We'll take it from the human side, after the agent has already stopped, because that is where most of the unfamiliar words live: code owner, required check, protected environment, and that borrowed token.

We'll go in the order the pull request actually experiences it. First, why more than one person has to say yes to the same change, and who those people even are. Then what has to be true before the merge button will even respond to a click, and why a comment from Copilot's own reviewer does not count as one of those things. Then the line between a change being merged and a change actually running somewhere, which turns out to be a bigger gap than it sounds. Then that borrowed token, and why a deployment job is better off without keys of its own. And in the closing chapter, we'll walk the original passage again, sentence by sentence, and you'll be able to read every clause without stopping.

So let's start with the reviewers. Why does the same pull request need the risk-engineering owner, developer platform, and InfoSec to each say yes, instead of just one person signing off?

## Ledger

Promises made: none due before the section's own chapter 2.

Examples used: RSK-142, the age-band ticket carried through from issue to pull request to merge to deployment, registered as the section's running example.

Terms glossed: none yet, first-mention glosses for code owner, required check, protected environment, and OIDC are deferred to their named chapters (2 through 5).
