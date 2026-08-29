# Task Lifecycle Hardening — Design

**Status:** Implemented — see [`docs/superpowers/plans/2026-08-28-task-lifecycle-hardening.md`](../plans/2026-08-28-task-lifecycle-hardening.md)
**Related:** [[2026-08-28-standing-tasks-design]] (introduced `queueTask`, `opportunity-scout`, `improvement-scout`)
**Sibling spec:** [[2026-08-28-builder-pipeline-design]] — the builder agent this
spec's failure-feedback loop and the standing-tasks scouts eventually feed.

## 1. Problem

The standing-tasks feature gave the system two daily cron agents
(`opportunity-scout`, `improvement-scout`) that queue their own work via
`queueTask`, and gave the dispatcher a queue to drain. Two gaps surfaced
once that ran for more than a single day:

1. **No memory.** Neither scout can see what it proposed yesterday. Nothing
   stops either one from queuing the same idea every single day forever —
   wasted specialist runs, wasted budget, and a `!tasks` list that fills
   with duplicates.
2. **No resilience or feedback.** `src/control/dispatcher.ts`'s
   `executeAndFinalize` gives a failed task exactly one silent retry, with
   no delay, before permanently failing it (`retryCount` capped at `1`).
   A transient failure (a flaky fetch, a momentary rate limit) gets one
   near-instant retry and then gives up. Worse, a *recurring* failure
   pattern — the same specialist failing the same way over and over — is
   invisible to the system itself; nothing feeds it back to
   `improvement-scout`, whose entire job is noticing exactly this kind of
   thing.

## 2. Goals / Non-goals

**Goals:**
- Give each cron scout visibility into its own prior proposals, scoped so
  it can never see another agent's or a human's task history.
- Replace the single-retry-no-delay policy with a small bounded backoff.
- Surface aggregate failure patterns to `improvement-scout` without
  exposing raw task text (which may contain a human's `!task` content).

**Non-goals:**
- No change to how tasks are routed (`Router`) or how `queueTask` itself
  is capped/clamped (both settled in the standing-tasks spec).
- No UI/Discord command changes — `!tasks`/`!result` already suffice for
  a human checking outcomes after the fact, per `CLAUDE.md`.
- No cross-agent history (an agent seeing another agent's proposals) —
  out of scope and not needed for dedup.

## 3. Design

### 3.1 `listMyTasks` — scout self-history

A new ungated MCP tool, added to the existing `taskQueue` server in
`src/runner/sdk-runner.ts` (alongside `queueTask`). No input parameters.

Handler behavior: reads `agent.name` from the *currently executing run's*
`AgentDef` (the same closure variable every other tool in that server
already uses — never a client-supplied value, so an agent cannot ask for
another agent's history), filters `tasksDep.list()` to
`createdBy === "agent:" + agent.name`, sorts by `createdAt` descending,
takes the most recent **20**, and returns each as
`{ id, text (truncated to 200 chars), status, createdAt }`. Truncation
guards against a tool result ballooning if a past self-queued task's text
was near the 4000-char `MAX_TASK_TEXT_LENGTH` ceiling.

Registration: today, `queueTask`'s server is built only when
**both** `tasksDep` and `wakeDep` are present, because `queueTask` itself
needs `wake()`. `listMyTasks` needs only `tasksDep` — it never wakes the
dispatcher. The server-construction condition changes from
`tasksDep && wakeDep` to `tasksDep` alone; `queueTask` is included in the
tool list only when `wakeDep` is *also* present, `listMyTasks` (and
`recentFailures`, below) whenever `tasksDep` is present regardless of
`wakeDep`. In production both are always wired together, so this only
matters for tests/scripts that construct `SdkRunner` with `tasks` but no
`wake`.

### 3.2 `recentFailures` — aggregate failure signal

A second new ungated tool in the same server, also no input parameters.
Available under the same `tasksDep`-only condition as `listMyTasks`.

Handler behavior: reads all tasks, filters to `status === "failed"` with
`finishedAt` within the last **14 days**, and groups them into buckets
keyed by `(specialistAgent ?? "unrouted", failureReason?.slice(0, 80) ??
"(no reason recorded)")`. Each bucket reports `{ specialistAgent, reason,
count, exampleTaskId }` (one representative id, not the full list — this
tool answers "is there a pattern", not "give me every failure"). Buckets
are sorted by `count` descending and capped at the top **10**. This
deliberately never returns raw task `text` — only operational metadata
(which specialist, why, how often) that isn't tied to whatever a human or
another agent originally asked for.

### 3.3 Scout prompt changes

- `agents/opportunity-scout/prompt.md` gains a step: call `listMyTasks`
  before proposing anything, and skip any idea already present there
  unless there's a concrete reason circumstances changed.
- `agents/improvement-scout/prompt.md` gains the same `listMyTasks`
  instruction, plus a new step: call `recentFailures` and, if a bucket
  shows a real recurring pattern (not a one-off), consider proposing a
  fix for it alongside its usual source-reading pass.

No `agent.yaml` / `allowedTools` changes are needed for either tool: as
established by `queueTask` (already callable by both scouts despite
neither's `allowedTools` listing it), custom MCP-server tools are gated by
server *registration*, not by the SDK's `tools` allowlist — see the
comment at the `query()` call site in `sdk-runner.ts` ("`tools` ... still
controls what's loaded/available [for built-ins] ... unrelated to
[MCP server tools]").

### 3.4 Dispatcher backoff

`src/control/task-store.ts`'s `Task` interface gains one new optional
field: `nextRetryAt?: string` (ISO timestamp) — the earliest time this
task is eligible to be claimed again after a failure.

`nextPending` (and therefore `claimNextPending`) adds one filter
condition alongside the existing `status === "pending"` check: a task
with `nextRetryAt` set is excluded until `now() >= new Date(nextRetryAt)`.

`executeAndFinalize`'s failure branch changes from:

```
if (previousRetries < 1) { ... retryCount: previousRetries + 1 ... }
```

to a 3-attempt exponential schedule:

```ts
const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000]; // 1min, 5min, 15min
const MAX_RETRIES = RETRY_BACKOFF_MS.length; // 3

if (previousRetries < MAX_RETRIES) {
  const delay = RETRY_BACKOFF_MS[previousRetries];
  await deps.tasks.update(task.id, {
    status: "pending",
    retryCount: previousRetries + 1,
    startedAt: undefined,
    nextRetryAt: new Date(now().getTime() + delay).toISOString(),
  });
  return { ran: true, taskId: task.id, deferred: true };
}
// unchanged: mark "failed" with failureReason once MAX_RETRIES is exhausted
```

`Dispatcher.wake()`'s existing `deferredIds` exclusion (skip a deferred
task for the *rest of this same drain*) still applies and is now purely a
same-call optimization — `nextRetryAt` is what actually gates re-claiming
across dispatcher ticks, regardless of which tick or `wake()` call asks.

`TaskStore.reconcile()` needs no change: it only resets tasks still stuck
in `"running"` after a crash, and a task backing off after a failure is
already `"pending"` (with `nextRetryAt` in the future) by the time any
crash could occur — reconcile's contract ("a `running` task has nothing
actually working it") is untouched.

## 4. Data flow

```
opportunity-scout (cron) --listMyTasks--> own last 20 proposals
                          --queueTask--> TaskStore (existing)

improvement-scout (cron) --listMyTasks--> own last 20 proposals
                          --recentFailures--> failure buckets (14d, top 10)
                          --queueTask--> TaskStore (existing)

dispatcher tick/wake --claimNextPending--> excludes future nextRetryAt
  on failure --> nextRetryAt = now + backoff[retryCount], retryCount++
  after 3 retries (4th total execution) --> status: "failed" (unchanged terminal behavior)
```

## 5. Testing

- `listMyTasks`: registration gated on `tasksDep` alone (present without
  `wakeDep`); returns only tasks whose `createdBy` matches the calling
  agent's own name; respects the 20-item cap and descending order;
  truncates `text` at 200 chars.
- `recentFailures`: bucketing groups correctly by
  `(specialistAgent, reason-prefix)`; respects the 14-day window and
  top-10 cap; never includes raw task `text` in its output.
- Dispatcher backoff: `nextRetryAt` is computed correctly per attempt
  index; `claimNextPending` skips a task whose `nextRetryAt` is still in
  the future and picks it up once `now()` passes it; a task fails
  permanently only after the 3rd attempt, not the 1st (this replaces,
  rather than adds to, the existing single-retry test in
  `dispatcher.test.ts`, which asserted the now-superseded 1-retry cap).
- `bot.test.ts` / any test asserting `!tasks`/`!result` output should be
  checked for the (unchanged) shape of `retryCount`/`failureReason` —
  `nextRetryAt` is new but not surfaced in any Discord-facing text.

## 6. Global Constraints (for the implementation plan)

- `listMyTasks` cap: 20 most recent tasks, `text` truncated to 200 chars.
- `recentFailures` window: 14 days; cap: top 10 buckets by count;
  `reason` bucket key truncated to 80 chars; never includes raw task text.
- Retry backoff schedule: `[60_000, 300_000, 900_000]` ms (1/5/15 min);
  `MAX_RETRIES = 3` (up from today's `1`).
- No `agent.yaml`/`allowedTools` changes required for either new tool.
