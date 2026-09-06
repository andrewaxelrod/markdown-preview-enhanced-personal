## Module Introduction

So you got to the part of the governed path where a human takes over, and it stopped making sense. That's a fair place to get stuck. The passage moves fast: a maintainer checks the diff, then approves workflow execution, then checks run, then Copilot code review leaves comments, then a risk-engineering code owner reviews the calculation, then developer platform, then InfoSec, then somebody merges, and then a separate deployment workflow waits for an environment reviewer, and somewhere in there a job gets its cloud access through something called OIDC. Every word in that is a word you know. What's missing is the shape.

And that's what this section is for. We'll slow that passage down to walking pace and answer one question at a time: who approves what, in what order, and why. Not tips. The behind-the-scenes version, so that when you read a governed path again, you can tell which step is a person exercising judgment, which step is GitHub refusing to move, and which step is just a comment that nobody has to act on.

We'll go in the order the work actually travels, because that's easier to hold than the order the settings appear in a console. First the reviewers, so you know why three different groups are looking at one pull request. Then what has to be true before the merge button becomes clickable at all. Then why merging is not the same as going live. Then, finally, the credentials question: why the deploy job borrows a key instead of keeping one. And we'll close by walking the original passage sentence by sentence, with all of that in hand.

We'll sit in both chairs, of course: the engineer whose pull request is waiting, and the person who designed the waiting.

So let's start with the reviewers. Why do three separate groups have to say yes to one change?

## Ledger

**Promises made**

- Explain who approves what and in what order, across chapters 2 through 6 of this section. Due: whole section.
- Explain why the merge button becomes clickable. Due: chapter 3.
- Explain why a merge is not a deploy. Due: chapter 4.
- Explain why the deploy job borrows a key rather than holding one, so OIDC. Due: chapter 5.
- Walk the original passage sentence by sentence. Due: chapter 6.
- Bridge handover: why three separate groups review one pull request. Due: chapter 2.

**Examples used**

- RSK-142, the age-band factor ticket: the running example, stands for one bounded piece of work traveling from issue to production.
- The human path passage in "The Governed Path: From Issue to Merge": stands for the reader's stuck point, the text this section unpacks.

**Terms glossed**

- None glossed in full yet. Terms named but deliberately deferred to their chapters: code owner, workflow execution approval, Copilot code review as advisory, merge button, environment reviewer, OIDC. Each is used here only as a signpost to its own chapter, not relied on for meaning.
