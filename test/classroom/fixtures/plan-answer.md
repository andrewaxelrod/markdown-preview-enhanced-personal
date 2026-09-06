# Approvals, Gates, and Borrowed Keys: Reading The Human Path

Mission: Give the reader every piece needed to see who approves what, in what order, and why a deployment job borrows its credentials instead of holding its own.
Chapters:

1. Module Introduction | Question: (framing, picks up from the reader's stuck point) | Type: framing | Words: 250 | Draws on: The Governed Path: From Issue to Merge
2. Who Is a Code Owner, And Why Do Several People Have to Say Yes | Question: Why do the risk-engineering owner, developer platform, and InfoSec each review the same pull request instead of just one person signing off? | Type: concept | Words: 500 | Draws on: The Lock: GitHub as the Enforcement Plane; The Governed Path: From Issue to Merge
3. Checks, Comments, and the Merge Button | Question: What has to be true before the merge button even becomes clickable, and why doesn't Copilot's own review count toward that? | Type: concept | Words: 550 | Draws on: The Lock: GitHub as the Enforcement Plane; The Day-One Settings and the Drift Poll; The Governed Path: From Issue to Merge
4. A Merge Is Not a Deploy | Question: Why does the code getting merged not mean it goes live, and what is a protected environment guarding? | Type: concept | Words: 500 | Draws on: The Lock: GitHub as the Enforcement Plane; The Governed Path: From Issue to Merge
5. Why the Deploy Job Doesn't Carry Its Own Keys | Question: What is OIDC doing in that deployment job, and why is a borrowed, short-lived token safer than giving the agent's setup a stored password? | Type: concept | Words: 550 | Draws on: The Governed Path: From Issue to Merge; What the Agent Can Reach
6. Walking the Passage | Question: (returns to the passage, sentence by sentence) | Type: concept | Words: 600 | Draws on: The Governed Path: From Issue to Merge

Terms to build from zero: code owner, CODEOWNERS file, ruleset, required check, approval versus a comment, advisory review, protected environment, environment reviewer, secret, OIDC (short-lived federated credentials), deploy role, setup workflow

Running example: The RSK-142 ticket, adding a deterministic age-band factor to the risk-scoring module, carried through from issue to pull request to merge to deployment.
