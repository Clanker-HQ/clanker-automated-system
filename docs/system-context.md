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

A `goals.yaml` at the repo root (`src/goals.ts`), once the operator commits
it, is the fixed reference point subsystem 2 measures the system against —
excluded from the merge pipeline the same as `grants.yaml`, since the
system may propose a revision but must never author one. A weekly metrics
job (`src/metrics.ts`, scheduled by `src/triggers/metrics.ts`) computes
revenue and instrumental metrics — net income, not-achieved rate per agent,
cost per completed task, novelty share, queue starvation — into
`data/state/metrics-<date>.json`, with the delta appended to the daily
digest the day a fresh snapshot lands.

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

## Vendor and infrastructure choices already made

These are live decisions, not open questions to re-derive from a fresh web
search. If a source contradicts one of these, that's a reason to flag the
conflict and say so — not to recommend switching.

- **Payments: Stripe (Managed Payments), not Lemon Squeezy.**
  `config.yaml`'s `revenue.provider: stripe` — Stripe acquired Lemon
  Squeezy, and new merchant signups now land on Stripe Managed Payments,
  not a standalone Lemon Squeezy account. `LemonSqueezyRevenueTransport`
  (`src/control/lemonsqueezy-revenue-transport.ts`) exists only for an
  account that predates the acquisition — do not recommend a fresh Lemon
  Squeezy signup for a new product. Rationale: `docs/decisions.md`.
- **Product source control: GitHub, org `AAS-Labs`.** Repo creation and
  pushes for anything the system builds to sell go through `AAS-Labs/*`-
  scoped grants backed by `GITHUB_PRODUCTS_TOKEN` — a separate GitHub
  identity from the one this project's own infrastructure repo uses.
- **This system's own control-plane host (the supervisor VPS) is not
  rented yet.** The operator is deliberately not spending on hosting or a
  domain until the system has proven itself running on `npm start`. When
  it is rented, the operator's stated provider preference is Contabo —
  this is not yet reflected in any design doc, since the deploy path
  (`docs/superpowers/specs/2026-09-01-deploy-path-design.md`) is
  deliberately host-agnostic. This is a different host from any
  individual product's own hosting below; don't conflate the two when
  reasoning about cost or provider choice.
- **Per-product hosting is not fixed to one provider.** `research` picks
  hosting per product based on that product's own traffic/cost shape —
  e.g. pilot-01 (a stateless, low-traffic sync API) landed on Cloudflare
  Workers + D1, not a VPS. Don't assume a new product should use the same
  host as the supervisor above, or as any other product.

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
