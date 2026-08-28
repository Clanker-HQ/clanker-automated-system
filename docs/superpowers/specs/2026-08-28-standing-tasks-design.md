# Standing/Proactive Tasks — Design

**Date:** 2026-08-28
**Status:** Draft, pending review
**Scope:** The first slice of "the system acts on its own initiative," explicitly
deferred by the original task-queue-dispatcher design (§8 there: "Follows once
this slice is proven and a critic/filter step exists to gate what standing
directives produce"). This design covers two new cron-triggered agents that
each propose one thing worth doing and queue it as a real task — nothing about
how a queued task is routed, run, or reported changes.
**Builds on:** [`2026-08-27-task-queue-dispatcher-design.md`](2026-08-27-task-queue-dispatcher-design.md)
— reuses `TaskStore`, `Dispatcher`, `LlmRouter`, and the existing `research`
specialist verbatim. This design's only new execution-path code is one new
MCP tool; everything downstream of "a task exists" is unchanged.

---

## 1. Purpose

Every task in the queue today originates from a human typing `!task`. The
owner's stated goal is for the system to also generate its own work, across
two goals they named directly:

1. Find something the system (or its operator) could make money with.
2. Find what could be improved, fixed, or added in the system itself.

**Standing preference driving this design** (see `CLAUDE.md`): default to
maximum automation. Nothing in this design should require a human to approve
an individual proposal before it's queued or before the resulting research
runs — the human's role is reviewing outcomes after the fact (Discord
notifications, the daily digest, `!tasks`/`!result`), not gating each action.

**Success criteria:**
1. Two new agents, each on its own daily cron schedule, each look at
   something (the open web; this repo's own source) and queue up to a
   handful of concrete tasks via a new tool — no human approval step in
   between proposing and queuing.
2. A queued task from either scout is indistinguishable, once queued, from
   one a human typed — same routing, same Governor admission, same
   `!tasks`/`!result`/digest visibility, same completion reporting.
3. Neither scout can do anything beyond proposing: no code changes, no
   spending, no outward network effect (beyond the already-ungated
   `WebSearch`) is possible from either agent, by construction — not just by
   omission from its prompt.
4. The whole pipeline is testable with `FakeRunner`, zero real subscription
   spend, matching this project's existing convention.

**Explicit non-goal:** a critic/quality-filter step reviewing a scout's
proposal before it's queued. See §5 for why this slice ships without one.

---

## 2. Architecture — how a proposal becomes a task

```
cron fires (opportunity-scout, daily)          cron fires (improvement-scout, daily)
  → agent runs with WebSearch + queueTask         → agent runs with Read/Glob/Grep + queueTask
  → decides on ONE plausible way to make money     → reads src/, README.md, CONFIGURING.md,
    (no deep research — that's research's job)       docs/superpowers/{specs,plans}/
  → calls queueTask({text, ...})            [NEW]  → finds ONE concrete gap/improvement/idea
                                                     → calls queueTask({text, ...})       [NEW]
         \_______________________  ________________/
                                 \/
                    TaskStore.create() + Dispatcher.wake()   [existing — identical
                                                               to what !task does]
                                 |
                    routed by LlmRouter, admitted by Governor,
                    run under the same pipeline as any other task
                                 |
                    result reported to Discord, visible via
                    !tasks / !result / the daily digest — same as always
```

One new component:

- **`queueTask`** — an MCP tool, registered unconditionally for every agent
  run (same pattern as the existing `askHuman` tool), that durably queues a
  task the same way `!task` does. It owns *"an agent can ask for more work
  to exist"* and nothing else — it has no idea what a specialist does, what
  routes to it, or whether the proposal is any good. That's still entirely
  the existing `TaskStore`/`Dispatcher`/`LlmRouter`'s job, untouched.

---

## 3. The `queueTask` tool

**Shape:** `queueTask({ text: string, priority?: number })` → confirms the
task id back to the model (mirroring `AskHuman`'s response shape).

**Validation:** `text` is required, non-empty, capped at the same 4000
characters `!task` already enforces (`MAX_TASK_TEXT_LENGTH` in
`src/control/bot.ts`) — reused, not duplicated.

**Attribution:** `createdBy: "agent:<agent.name>"` (vs. `"discord:<id>"` for a
human-issued task) — so `!result`/`!tasks` output and the digest can show at
a glance that a task was self-generated, without adding a new field.

**Default priority:** a self-queued task defaults to **30**, not the human
default of 50 — so a real human ask, submitted at any time, is never queued
behind a scout's own speculative proposal. A scout may still request a
specific `priority` if it has reason to (kept as an option for symmetry with
`!task -p`, not expected to be used much in practice).

**Default `wantsDetail`:** `true`. A human-issued task defaults to a short
completion summary because the person is usually right there to ask a
follow-up; a self-generated task's owner finds out about it later (the
digest, or `!result`), so the richer summary is the only chance to make the
result immediately useful without a round trip.

**Per-run cap:** at most 3 calls per agent run (an in-memory counter scoped
to that one `execute()` invocation, the same lifetime `terminalEvent`/
`sessionIdPromise` already have in `sdk-runner.ts`) — a fourth call in the
same run returns an error message to the model instead of queuing anything.
This bounds worst-case queue growth from one misbehaving run without
touching the model's actual instructions, matching this project's existing
"the code enforces the boundary, the prompt is not the safety mechanism"
posture (compare: `detectOutwardEffect`, not agent instructions, is what
gates outward effects).

**Gating:** none. `queueTask` has no outward effect in `grants.ts`'s sense
(no network call, no push, no provisioning — it writes to this process's own
task queue, the same file `TaskStore.create()` already writes for `!task`),
so it is available at every tier with no grant, exactly like `AskHuman` and
`postReviewComment` today. Per the automation preference, this is a feature,
not a gap: proposing work should never need a human's permission slip.

**Wiring:** `SdkRunner` currently takes `{grants, pending, github?}`.
`queueTask` needs a `TaskStore` and a way to wake the dispatcher, so this
adds `tasks: TaskStore` and `wake: () => Promise<void>` as new required
constructor deps (same non-optional treatment `pending` already gets, since
`queueTask` — like `AskHuman` — is registered unconditionally for every
run). Exact call sites to update (`src/index.ts`, `SdkRunner`'s own
zero-arg default, existing `sdk-runner.test.ts` fixtures) are implementation-plan
detail.

---

## 4. The two scouts

Both are `agent.yaml` + `prompt.md` only — no new execution code beyond
`queueTask` above, the same "config only" shape the original `research`
agent shipped as.

### `opportunity-scout`

- **Trigger:** `cron`, daily (exact time an implementation-plan/config
  detail — offset from `improvement-scout` so they don't compete for the
  same admission slot).
- **Tools:** `WebSearch` only. `WebSearch` isn't a recognized outward effect
  in `detectOutwardEffect` at all (only `Bash`/`WebFetch`/`mergePR` are), so
  it needs no grant at any tier — confirmed against `src/grants.ts`, not
  assumed.
- **Tier:** `readonly`. `WebSearch` is in `READONLY_TOOLS`
  (`src/agent-schema.ts`), so this is the most restrictive tier that still
  lets the agent do its job — structurally forbids `Write`/`Bash`/`WebFetch`
  even if a future prompt edit asked for them, rather than relying on the
  prompt alone to stay narrow.
- **`grantRefs`:** none — `readonly` forbids any grant from being listed at
  all (`agent-schema.ts`'s own validation), and none is needed.
- **Job:** propose, don't research. Its prompt asks it to identify ONE (up
  to a few) concrete, plausible way this system or its operator could earn
  money, informed by a quick web search for current context — then queue
  each as a well-scoped research question via `queueTask`, precise enough
  for the `research` specialist to actually investigate. It never does the
  deep research itself; that would just be `research`'s job done worse, at
  the wrong tier, without `research`'s own `web-read` grant.

### `improvement-scout`

- **Trigger:** `cron`, daily.
- **Tools:** `Read`, `Glob`, `Grep`. All three are in `READONLY_TOOLS`.
- **Tier:** `readonly` — same reasoning as above, and here it matters more:
  this agent reads this project's own source, so a structural inability to
  reach `Bash`/`WebFetch`/`Write` even under a confused or adversarial
  prompt is the whole point, not a nicety.
- **`grantRefs`:** none.
- **Reads:** its prompt names absolute paths — `/app/src`, `/app/README.md`,
  `/app/CONFIGURING.md`, `/app/docs/superpowers/specs/`,
  `/app/docs/superpowers/plans/` — matching `/app` as `APP_ROOT` in every
  real deployment (the same path the README's own operating instructions
  already assume, e.g. `docker compose exec supervisor touch /app/data/STOP`).
  Reading the specs/plans directories specifically is what lets it recognize
  "already deliberately deferred" (a second specialist, self-build, the
  dashboard — all named in prior specs) rather than re-proposing something
  already tracked and intentionally not yet built.
- **Job:** find ONE (up to a few) concrete gap, bug, or valuable capability
  and queue it via `queueTask`, described precisely enough that whoever
  picks it up later — a human, or a future coding agent, if one ever exists
  — knows exactly what to do and why. It cannot write or edit anything
  itself; its only externally-visible action is the `queueTask` call.

---

## 5. Why no critic/quality-filter step

The prior design flagged this as the risk with standing directives:
"generating plausible-sounding but low-value busywork with nothing checking
whether a generated task is worth doing." This design ships without one
anyway, for reasons specific to how small the resulting blast radius is:

- **Frequency is capped hard.** Once per scout per day, up to 3 tasks per
  run — at most 6 self-generated tasks a day, worst case, not an
  unbounded stream.
- **Cost is capped by the existing Governor**, exactly like every other
  task: `dailyBudgetUsd` and `maxConcurrent` don't know or care whether a
  task came from a human or a scout.
- **A low-value proposal costs one `research` run** (itself budget-capped at
  `maxBudgetUsd: 2.00`) or sits as a `!result`-visible suggestion nobody
  acts on — not a standing liability, not a repeating cost, not something
  that compounds.
- Building a critic well requires the same thing the original design
  deferred it for: a real second opinion mechanism worth trusting, which is
  more machinery than this slice needs to prove the core loop. If scout
  output quality turns out to be a real problem in practice, a critic step
  is a natural, isolated follow-up — it slots in between `queueTask` being
  called and the task actually persisting, without touching anything else
  built here.

---

## 6. Error handling

Matches the existing task-queue design's posture; nothing new to invent:

- **`queueTask` called with empty/oversized text** → tool returns an error
  message to the model (not a thrown exception that would abort the whole
  run) — same shape as `AskHuman`/`mergePR`'s own refusal responses.
- **4th+ `queueTask` call in one run** → refused with a message, run
  continues normally otherwise.
- **The resulting task fails to route, or the specialist run fails** →
  handled entirely by the existing dispatcher/task machinery (§7 of the
  prior design) — a self-generated task is not a special case anywhere
  downstream of `TaskStore.create()`.
- **A scout's own run fails or times out** → recorded and reported exactly
  like any other agent's failed run; the circuit breaker counts it the same
  way. Three consecutive failures disables further triggers until
  `!enable`, same as any agent.

---

## 7. Testing

Matching this project's established conventions:

- **`queueTask` tool logic**: unit-testable the way `AskHuman`'s handler
  already is in `sdk-runner.test.ts` — text validation, the 4000-char cap,
  the per-run call cap, `createdBy`/priority/`wantsDetail` defaults.
- **Two new `agent.yaml` files**: covered for free by `registry.test.ts`'s
  existing schema/semantic validation (cron validity, tool/tier
  consistency, `dispatched`-requires-description — N/A here since both are
  `cron`-triggered) once they exist on disk.
- **End-to-end**: `FakeRunner` scripted to call `queueTask` (or the
  equivalent fake path), proving a scout's proposal reaches `TaskStore` as a
  real pending task with the right `createdBy`/priority/`wantsDetail` —
  zero real subscription spend, same bar every prior plan in this repo has
  held to.

---

## 8. Open items for the implementation plan

- Exact `queueTask` zod input schema and MCP server registration shape
  (its own server, or folded into the existing `askHumanServer`).
- Exact cron schedule times for each scout (config detail, not a design
  decision).
- Whether `SdkRunner`'s zero-arg default constructor needs a real no-op
  `TaskStore`/`wake` or whether every call site is updated to pass real
  ones (existing tests construct `SdkRunner` directly in a few places and
  need auditing either way).
