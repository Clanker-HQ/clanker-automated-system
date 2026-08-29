# Task Queue & Dispatcher — Design

**Date:** 2026-08-27
**Status:** Implemented — see [`docs/superpowers/plans/2026-08-27-task-queue-dispatcher.md`](../plans/2026-08-27-task-queue-dispatcher.md)
**Scope:** Sub-project 3 of the roadmap — the first slice of turning this system
from "one agent per fixed cron schedule" into something that can be handed a
free-form request and figure out, on its own, what should handle it. This
design deliberately covers only the smallest provable loop: a durable task
queue, a dispatcher that routes a task to a specialist via a real reasoning
call, and exactly one specialist (research). Self-generating standing
directives, multiple specialists, a safety/critic review step, self-build, and
a dashboard are all named but explicitly deferred — see §8.
**Builds on:** [`2026-08-26-plan-b-governance-design.md`](2026-08-26-plan-b-governance-design.md)
— reuses the Governor, Orchestrator, `SdkRunner`, agent-definition schema, and
Discord bot verbatim. No new execution machinery; this adds a routing/backlog
layer in front of the existing pipeline, the same way the PR-review-gate
design added a webhook trigger in front of it without touching how a run
actually executes.

---

## 1. Purpose

Today, every agent runs on its own fixed cron schedule (or, since the
PR-review gate, a webhook event) — there is no path from "the owner has an
open-ended ask" to "the right agent handles it" that doesn't involve a human
hand-authoring a new `agent.yaml` first. The owner's stated goal for this
system is broader: submit a free-form request, and let the system determine
which specialist(s) are involved, without pre-wiring one agent per task by
hand — eventually with the system also acting on its own initiative, and
eventually able to extend its own capability set.

That full vision is multiple sub-projects (see the parent roadmap). This
design is deliberately the smallest one that proves the core mechanism end to
end: a task goes in, something decides who handles it, it runs under the
existing governance, and a result comes back — before betting on the two
riskiest surrounding pieces (an LLM deciding what work to generate on its own,
and an agent that can modify the system).

**Success criteria:**
1. The owner can submit a free-form task via Discord; it is durably queued
   and survives a restart.
2. A dispatcher picks the next task and decides which specialist handles it
   via a real reasoning call — not a hardcoded branch — even though today
   there is exactly one legal answer. Adding specialist #2 later requires no
   dispatcher rework, only a new agent definition.
3. The specialist runs under the exact same Governor as every other agent —
   same budget, concurrency, quiet hours, circuit breaker. Nothing about
   "dispatched" work gets a different blast radius than "scheduled" work.
4. A result reaches the owner in Discord, and the full artifact is saved to
   disk.
5. The whole pipeline is testable without consuming subscription quota,
   matching this project's existing convention (`FakeRunner`).

**Explicit non-goals for this design** (each is a real, later sub-project, not
an oversight — see §8 for why each is cut):
- Standing/self-generating directives ("always be researching money ideas").
- More than one specialist.
- A safety/critic review step before a specialist's output is trusted.
- The dashboard the owner wants eventually — Discord only, per their decision.
- Self-build (an agent proposing changes to this system itself).

---

## 2. Architecture — how a task moves

```
Discord: !task <free text>
  → TaskStore.add()  — writes data/tasks/<id>.json, status "pending"   [NEW]
  → Dispatcher loop                                                     [NEW]
      picks the highest-priority pending task
      → routing call: given the task text and a specialist registry
        (name + description, read from each agent's agent.yaml),
        an LLM decides which specialist agent should handle it
      → no specialist matches → task marked "failed", reason posted to
        Discord (fails loud — never a silent drop)
      → matched → task.specialistAgent set, status "running"
  → Orchestrator.executeRun(agent, now, taskText)     [existing, reused]
      → Governor.admit()                              [existing, reused —
        same budget/concurrency/quiet-hours/breaker as any other agent]
      → runs the specialist agent as normal
  → on completion: TaskStore marks the task "done"/"failed", result path
    recorded, summary posted to Discord                                [NEW]
```

Two new components, split the same way Governor and grants already are —
each owns one question and doesn't know about the other's:

- **TaskStore** owns *what work exists and in what order*. It has no idea
  what a specialist does, or whether one is even available right now.
- **Dispatcher** owns *which specialist handles a given task, and when to
  hand it to the existing run pipeline*. It has no idea about budgets or
  concurrency — that's still the Governor's job, untouched by this design.

---

## 3. Task queue (`TaskStore`)

**Storage:** one JSON file per task under `data/tasks/<id>.json` — the same
shape as `data/pending/<id>.json` already uses for parked approvals. No
database (see the reasoning below); this is a small, personal-scale, durable
list, and the repo already has a proven pattern for exactly this shape of
problem.

**Fields:**

```ts
interface Task {
  id: string;
  text: string;              // the free-form request
  priority: number;          // higher = more urgent; default e.g. 50
  status: "pending" | "running" | "done" | "failed" | "waiting";
                             // "waiting" = the run parked mid-execution on a
                             // human approve/deny/answer and is still alive;
                             // not finished, not failed.
  createdBy: string;         // "discord:<owner>" today — only DISCORD_OWNER_ID can submit
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  specialistAgent?: string;  // filled in once routed
  parentId?: string;         // present in the schema now, unused until standing
                              // directives (§8) exist — avoids a migration later,
                              // costs nothing today
  result?: { summary: string; path: string };
  failureReason?: string;
}
```

**Ordering:** by `priority` descending, ties broken by `createdAt` (FIFO).
With only user-submitted tasks in this slice, this mostly behaves as a plain
FIFO queue — the field exists now so a later standing-directive sub-project
doesn't need a schema change to start mattering.

**Boot reconciliation:** mirrors `PendingStore`'s existing pattern — on
startup, load every file under `data/tasks/`, rebuild an in-memory priority
index. Any task still marked `"running"` from before a restart is reset to
`"pending"`: its underlying agent run (if one was actually in flight) has its
own crash-recovery story via the Orchestrator already; the task-level record
just must not stay stuck "running" with nothing actually working it.

**Why not a database:** this is one supervisor process serving one person,
budget-capped by the Governor — realistically dozens-to-hundreds of tasks
over time, not a volume where file scans cost anything measurable. The repo
already has a proven durable-queue-of-JSON-files pattern (`data/pending/`)
for the same shape of problem, and a database would add a new service to
run, back up, and keep alive, for no capability this system needs yet. If
the task tree gets deep, or the future dashboard sub-project wants real
querying, **SQLite** is the natural upgrade — still a single file, no new
Docker service — but that is a storage-layer swap to make later, not
something to build now.

---

## 4. Discord commands

Extends the existing bot (owner-only, per the existing `DISCORD_OWNER_ID`
check — unchanged):

| | |
|---|---|
| `!task <text>` | Adds a task at default priority; replies with its id |
| `!tasks` | Lists pending/running tasks — id, truncated text, status — mirroring the existing `!runs` format |

A result is posted to the channel the same way a run report already is today
once the task completes or fails; no new reporting path.

---

## 5. Dispatcher

**Trigger:** a lightweight loop inside the existing supervisor process,
woken both reactively (whenever `!task` adds one, or whenever a run
completes and might free capacity) and on a periodic safety-net tick — the
latter is what makes boot reconciliation actually get worked, not just
loaded into memory. No new queuing logic beyond this: once the dispatcher
decides to attempt a task, it hands the run to `Governor.admit()` exactly
like any other trigger — if no concurrency slot is free, the Governor's
existing wait-for-a-slot behavior (Plan B §4.3) applies unchanged. The
dispatcher does not implement a second admission queue on top of the one
that already exists.

**Routing call:** a small, cheap LLM call (Haiku-tier, matching this
project's existing convention of using the cheapest model for
low-stakes/high-frequency calls) given the task's free text and a
**specialist registry** — each available agent's `name` plus a new
one-line `description` field on `agent.yaml` (this field does not exist
today; it is added by this design, purely for routing — it has no effect on
tiers, grants, or execution). The call returns which specialist should
handle the task.

With one specialist registered, the routing call has exactly one legal
answer today — building it as a real reasoning call anyway, rather than
hardcoding `research`, means specialist #2 requires no dispatcher rework,
only a new `agent.yaml` with its own `description`. (Its routing *quality*
genuinely can't be evaluated yet with only one candidate — that's expected,
and is exactly why this design doesn't try to prove routing intelligence,
only the mechanism.)

**No match / low-confidence routing:** the task is marked `"failed"` with
the reason recorded and posted to Discord — never silently dropped or
retried forever, matching this project's existing "fail loud" posture.

**New trigger variant:** `agent.yaml`'s `trigger` field is currently a
discriminated union of `cron` and `webhook` (the latter added by the
PR-review-gate design). A dispatcher-invoked agent isn't self-triggering on
a schedule or an external event — it's invoked ad hoc, only when the
dispatcher routes a task to it. This needs a third sibling variant (call it
`type: "dispatched"`; exact schema shape is an implementation-plan detail,
same as the webhook trigger's shape was left to the PR-gate's implementation
plan rather than fixed here).

**Per-task prompt context:** the PR-review-gate plan already added
`Orchestrator.executeRun`'s optional `promptContext` parameter, for exactly
this reason (a webhook-triggered run needs per-event content the agent's
static prompt file can't carry). This design reuses that parameter
unmodified — the dispatcher passes the task's `text` as `promptContext` when
triggering the specialist's run.

---

## 6. Research specialist agent

`agents/research/agent.yaml` + `agents/research/prompt.md` — a new agent,
config only, no new execution code.

**Tier:** `autonomous`, **not** `readonly` and **not** `granted`. Checked
directly against `src/grants.ts` rather than assumed: `WebFetch` is a
recognized outward effect (`detectOutwardEffect`, `src/grants.ts:170`), and
`tier: readonly` denies **any** recognized outward effect outright, with no
grant possible (`src/grants.ts:268`). `WebSearch` isn't in the
recognized-effect list at all, so it would work at `readonly` — but a
research agent restricted to search-result snippets, never able to fetch and
actually read a page, isn't a real research agent. So this agent needs a
grant: a new `http` grant in `grants.yaml` scoped broadly for reads
(`urlPattern: "*"`).

`granted` is not enough to make that grant auto-allow, which is the trap
here. `decide()` short-circuits a matched grant to `{kind: "allow"}` only for
`agent.tier === "autonomous" && agent.approval === "auto"`
(`src/grants.ts:277`); at `tier: granted`, a matched grant still returns
`{kind: "park"}`, so the agent would stop for a human Discord approval on its
very first `WebFetch`, on every single run. That is the opposite of the
intent. The agent is therefore `tier: autonomous` with `approval: auto` and
`grantRefs: [web-read]`.

Reading public web pages carries none of the "spending money or doing
something big/dangerous" risk the owner wants to personally approve — it's a
deliberately low-risk, broad grant, unlike the narrow single-endpoint
`test-echo` grant or a future git-push/provision grant. `autonomous` here
does **not** mean unrestricted: containment comes from the grant's own family
(`http` only — no git-push, no provision, no github-pr, since `matchGrant`
requires the kinds to line up) and from the tool list, which is
`[WebSearch, WebFetch, Write]` with `Read` deliberately omitted. Local file
reads plus a `urlPattern: "*"` fetch grant would be a direct exfiltration
path; without `Read` there is nothing local to exfiltrate.

**Output:** the full research writeup is saved to disk under `data/`
(exact path an implementation-plan detail); a short summary is what's
posted to Discord, with the file path noted for anyone who wants the full
artifact — matching how run transcripts already work today (`data/runs/`,
summarized in Discord, full detail on disk).

---

## 7. Error handling

Fails safe throughout, matching the rest of this system's posture:

- **No specialist matches a task** → `"failed"`, reason posted, task stays
  on record (not deleted) so the owner can see what was asked and why
  nothing handled it.
- **The specialist's run itself fails or times out** → recorded as a failed
  run like any other agent failure; the task is marked `"failed"` with the
  run's own failure reason; the circuit breaker counts it exactly as it
  would for a cron-triggered failure of the same agent.
- **Supervisor restarts mid-task** → boot reconciliation (§3) resets any
  `"running"` task to `"pending"`; it's picked up again on the next
  dispatcher tick. No task is silently lost, and none double-runs, since a
  reset-to-pending task re-enters routing rather than resuming a stale run.
- **Governor refuses admission** (quiet hours, budget, breaker, STOP file)
  → the task simply stays `"pending"`; the dispatcher's periodic tick
  retries it later, the same way a refused cron trigger just waits for its
  next scheduled fire. Only `maxConcurrent` is a genuine wait per Plan B
  §4.2 — every other refusal here means "try again on the next tick," not
  "drop it," since (unlike a cron agent, which gets another fire tomorrow
  regardless) a queued task has nowhere else to go. A refusal must also
  *stop the current drain*: the refused task is still the head of the queue,
  so continuing would immediately re-pick it and spin. The routing decision
  is cached on the task (`specialistAgent`) across the refusal, so the retry
  costs no second routing call.

---

## 8. What this design deliberately does not build, and why

- **Standing/self-generating directives** ("always be researching ways to
  earn money"). This is the highest-value long-term piece of the owner's
  vision, but it's also where autonomous task-queue systems are known to go
  wrong — generating plausible-sounding but low-value busywork with nothing
  checking whether a generated task is worth doing. Building it before the
  basic queue→dispatch→specialist→result loop is proven means debugging two
  hard problems at once. Follows once this slice is proven and a
  critic/filter step (next bullet) exists to gate what standing directives
  produce.
- **A safety/critic review step.** Not needed by this slice specifically —
  its one specialist is read-only by nature (research), so there's no
  action to review before it's trusted. Becomes necessary the moment a
  specialist with real-world effects (a builder, a publisher) is added;
  the existing PR-reviewer's adversarial-verification pattern is the
  obvious template to generalize when that happens.
- **More than one specialist.** The routing mechanism is built for it, but
  proving routing *quality* needs a real second candidate to route between
  — premature to fake with only one.
- **The dashboard.** Explicitly wanted eventually, per the owner, but out of
  scope here — Discord `!command` only, matching how the rest of this
  system already works.
- **Self-build.** Depends on this slice, a critic/reviewer pattern, and a
  builder agent (already named and explicitly deferred in the
  PR-review-gate design) all existing and being trustworthy first.

---

## 9. Testing

Matching this project's established conventions:

- **`TaskStore`**: pure logic over a temp directory (`mkdtempSync`) — add,
  reconcile-on-load, priority ordering, the running→pending reset on
  reconciliation.
- **Dispatcher routing**: a fake/stubbed routing call (no real LLM spend in
  tests) — table-driven over (task text, specialist registry) →
  routed-agent-or-none, plus the "no match → failed, not dropped" path.
- **End-to-end**: `FakeRunner`, extended if needed, drives a task from
  `!task` through routing through a completed run to a posted Discord
  result, with zero real subscription spend — the same "prove the whole
  pipeline without consuming quota" bar every prior plan in this repo has
  held to.
- **Discord commands**: reuse the existing `FakeBotTransport` pattern for
  `!task`/`!tasks` command parsing, same as the control bot's other
  commands are already tested.

---

## 10. Open items for the implementation plan

- Exact `dispatched` trigger schema shape (§5).
- Exact `data/` path for a research result artifact, and its filename
  convention.
- Dispatcher tick interval / exact reactive-wake wiring into the existing
  supervisor event loop.
- Whether `!task` needs a priority argument in v1, or whether default
  priority for every task is fine until standing directives (§8) exist and
  priority actually starts mattering.
