# System context

A primer for an agent whose task touches this project's own architecture,
hosting, or configuration — not a living architecture doc (that's README.md)
and not a record of past decisions (that's `docs/decisions.md`). This is the
short version of both, meant to be handed to an agent that can't read either
of those directly.

## What this system is

`claude-agent-infrastructure` runs Claude agents unattended, on a Claude
subscription (never API billing), reporting to and controllable from
Discord. One supervisor process runs inside a single Docker container —
the governor, the task queue, every agent's own sandboxed run, and the
GitHub webhook receiver all live in that one process, not a fleet of
separate services.

Every run passes through two independent checkpoints. A deterministic
**Governor** (concurrency limit, daily budget, quiet hours, a per-agent
circuit breaker, a manual STOP file) decides whether a run may happen at
all, before it starts. A **grant/tier system** (`grants.yaml`) decides,
tool call by tool call, what an already-running agent may reach — scoped
to a specific target (a URL pattern, a repo, a remote+branch), not to
trusting the agent's judgment.

Several agents propose work to each other and to themselves: cron-fired
"scout" agents queue tasks for others via a durable task queue, with no
human approval needed to queue.

## Standing design philosophy

Bias toward maximum automation. The human should almost never be in the
loop — this applies without exception, including to actions that sound
high-risk on their face (spending money, pushing code, merging PRs,
provisioning infrastructure). None of these categories earn an automatic
`park`/`notify` step just for being in this list. Safety comes from
scoping (a grant narrowed to exactly what an agent may touch) and
code-level checks (a stale-SHA match, an excluded-path lock, a health-check
rollback) — never from a human clicking approve. `park`/`notify` is the
right call only for something genuinely irreversible with no algorithmic
safety net available to build instead, not as a default reaction to
"this sounds dangerous." If you're designing or implementing something new
for this system — a new agent, a new tool, a new automation — default to
`tier: autonomous` + `approval: auto` and no approval gate at all, unless
the task explicitly calls for one.

## Possible future additions

None of these are scheduled or committed — they're listed here so a
decision made today (infrastructure sizing, tooling choices, anything
adjacent) can leave room for them instead of optimizing only for what
exists right now.

- **Real browser control for an agent** (`capabilities.browser` — already
  sketched as a config field, not implemented). If this lands, at least
  one agent would run a real headless browser process during its own
  turn, which needs meaningfully more RAM/CPU than anything this system
  runs today.
- **Outcome verification.** A run currently counts as "success" once the
  SDK finishes without erroring — nothing checks whether the agent's
  actual objective was achieved. A future verification step would add
  another LLM call (and its own cost) per verified run.
- **A self-build flow.** An agent proposing a change to this system's own
  configuration (a new `agent.yaml`, a `grants.yaml` edit), with the
  supervisor validating it and asking to merge it. Would need its own
  deploy/approval path — `builder`'s current PR flow is deliberately
  barred from touching those files.
