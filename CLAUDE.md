# Working preferences for this project

**Bias toward maximum automation. The human should almost never be in the
loop.** Default every agent to `tier: autonomous` + `approval: auto` with a
properly scoped grant. This applies without exception — including actions
that sound "high-risk" on their face, like spending money, pushing code,
merging PRs, or provisioning infrastructure. None of these categories earn
an automatic `park`/`notify` step just by being in this list. Read-only
work, research, and proposing/queuing tasks obviously never need a human
approval step either. The human's involvement should be reviewing outcomes
after the fact (Discord notifications, the daily digest, `!tasks`/`!result`),
not gating individual actions before they run.

**Safety comes from scoping and algorithmic checks, not from a human
clicking approve.** A `park`/`notify` step that just waits for a human to
rubber-stamp something they were never actually going to review isn't
safety, it's theater — the human has been explicit that they will not be
that rubber stamp, so a design that depends on them being one is a design
that doesn't work. The real safety mechanisms available here are: a grant
narrowly scoped to exactly what an agent may touch (a branch pattern, a
repo allowlist, a budget ceiling, an excluded-path list), and code-level
checks that run automatically as part of the pipeline (e.g. `mergePR`'s
head-SHA match and excluded-path lock, an automated reviewer agent gating
a merge, Governor's budget/concurrency/quiet-hours caps). Put the safety
into the grant and the pipeline, never into a human approval click.

**When `park`/`notify` is still the right call:** only for something
genuinely irreversible that has no meaningful algorithmic safety net to
build in its place — not as the default reaction to "this category of
action sounds dangerous." Reaching for `park` because an action sounds
risky is the signal to instead design a narrower grant or an automated
check, not to insert a human click.

This is a standing preference — don't ask again whether to reduce approval
friction, and don't propose `park`/`notify` as the default for a whole
category of action (spend, push, merge, provisioning) without first
explaining what specific algorithmic safety net replaces it. Only raise
something back to the human when there is truly no way to bound or check
it in code.
