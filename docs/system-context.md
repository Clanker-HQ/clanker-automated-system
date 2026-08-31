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

An append-only **memory log** (`data/memory/log.jsonl`, gated by
`memory.enabled`) backs that self-queuing: a novelty gate refuses a proposal
close enough to work already recorded as achieved, a computed priority
(goal alignment, novelty, importance, recency) ranks what gets through below
any human-issued task, and a completed task can propose its own bounded
chain of successors. The log also feeds forward — a dispatched task's prompt
ends with whatever it already knows about the same subject, and a
cron scout can look the same thing up via a `recallMemory` tool — and a
periodic reflection pass synthesises recent entries into higher-level
conclusions. None of this changes what an agent is allowed to reach; it only
changes what gets proposed and what a run starts already knowing.

A run's `status: "success"` only ever means the SDK finished without
erroring — it says nothing about whether the agent's actual objective was
met. An `OutcomeVerifier` grades every successful run against its own
prompt with a second, cheap LLM call, and the verdict (`achieved` /
`not-achieved` / `unclear`) surfaces in the Discord report, `!runs`, and the
daily digest. For a dispatched task, `not-achieved` is treated as a real
failure: the dispatcher backs off and retries automatically (feeding the
verifier's reason into the retry's prompt), up to the same 3-attempt cap a
genuine error gets — no human step, same as everything else here. A
cron/webhook agent has no task to retry, so it just gets its next scheduled
fire, the same as any other run.

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

## Before proposing or designing something new

Check `agents/*/agent.yaml` and `grants.yaml` first — the actual, current
registry, not just this doc. "Possible future additions" below is exhaustive
for what's deliberately not built yet; it says nothing about what already
exists. Assuming a capability is missing without checking the live registry
is how a redundant agent or grant gets proposed, or worse, built.

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
- **A self-build flow.** An agent proposing a change to this system's own
  configuration (a new `agent.yaml`, a `grants.yaml` edit), with the
  supervisor validating it and asking to merge it. Would need its own
  deploy/approval path — `builder`'s current PR flow is deliberately
  barred from touching those files.
