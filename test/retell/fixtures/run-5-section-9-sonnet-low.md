# Nine. Enforcement ladder

This is a ladder from strongest to weakest. The rule is: put each constraint at the highest rung that can express it.

## One. Deterministic deny, no script needed

For Claude Code, this is the deny list under permissions deny, set in the file dot claude slash settings dot json. It's enforced by the client itself, regardless of what the model decides to do.

For Codex, this lives in rule files under dot codex slash rules, using something called a prefix rule. These load only when the project's dot codex layer is trusted, and the feature is marked experimental. As an example, you could write a prefix rule that matches the command git push dash dash force, sets the decision to forbidden, and gives the justification that force-pushing is blocked by repo policy and a new branch should be used instead. That rule would match a call like git push force to origin main, but not match git push to origin feature. You can test such a rule with the Codex exec policy check command, pointing it at your rules file and the specific command you want to verify.

## Two. Pre tool use hooks, one script, two registrations

Both agents share a contract here: a JSON event arrives on standard input, and the hook script exits with status two, printing its reason to standard error, in order to block the action. Codex additionally accepts a structured response, essentially a hook-specific output block naming the pre tool use event, a permission decision of deny with a reason, and it can even rewrite a call by returning an allow decision along with updated input.

The pattern is one script named guard dot p y, placed under a hooks folder. It defines forbidden patterns, for example, refusing a recursive delete from root, or blocking edits to already-shipped migration files, citing architecture decision record zero zero zero three, which says shipped migrations are append-only. The script reads the event, checks the command against these patterns, and if one matches, prints the reason and exits with status two; otherwise it exits clean.

This same script gets registered twice: once in Claude Code's settings file, under pre tool use hooks matching bash, edit, or write, running the guard script; and once in Codex's hooks file, dot codex slash hooks dot json, with the same matcher, running the same script, with a thirty-second timeout.

A few Codex notes: run the slash hooks command to review and trust the hook, since trust is recorded against the hook's hash, so any edit requires re-trusting it. Project-level hooks only load in trusted projects. The edit and write tool names are just aliases for apply patch. And importantly, a pre tool use hook should not return continue or a stop reason, because that's unsupported. If it does, the hook gets marked failed and the call proceeds anyway. Both vendors are clear that these tool hooks are guardrails, not a complete enforcement boundary.

## Three. The C I gate, the only layer neither agent can bypass

This includes a drift check for spec-to-code drift, covered in section ten; a check trace script for marker resolution and opt-in requirement coverage, covered in section seven; and optionally, an architecture decision record fitness check that runs each decision record's violation pattern against the pull request diff. Set your thresholds below the current score, not at the aspirational one, so the gate starts green on day one and ratchets upward over time.

## Four. Code review rules

A section titled Code Review Rules in the nearest agents dot m d file steers Codex's GitHub pull request review. Keep formatting and linting rules in continuous integration, not here.

## Five. Instructions

Everything else falls here, and should be treated as advisory only.