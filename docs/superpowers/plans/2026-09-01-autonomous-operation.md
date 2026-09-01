# Autonomous Operation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the system a decision layer, a shared memory of what it knows, and the mechanical guards that let it run unattended for months without stalling, looping, or quietly going nowhere.

**Architecture:** Three tiers of decision-making. **Tier 1 (code)** — the Governor, grant matching, and the new mechanical guards in Part A; deterministic, safety-critical, frequent. **Tier 2 (cheap local judgment)** — routing, outcome verification, the existing scouts; narrow input, no big picture. **Tier 3 (the overseer)** — one periodic agent that reads the world model and decides what the system should be doing; it queues tasks and writes strategy, and never executes work or gates a run. A **world model** (`data/world/`) is the shared substrate all three read and the overseer maintains.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 22, Zod for schema validation, Vitest for tests, croner for scheduling, YAML for config. No new runtime dependencies are introduced by this plan.

**Spec:** This file. The design was settled in conversation on 2026-09-01 and the reasoning is captured in "Design" below; there is no separate spec document. Existing related specs worth reading: [`docs/superpowers/specs/2026-08-30-agent-loop-design.md`](../specs/2026-08-30-agent-loop-design.md) (whose "Non-goals" section rejects a *manager agent in the execution path* — Part C is compatible with that, see Design §3), [`docs/superpowers/specs/2026-08-30-self-build-design.md`](../specs/2026-08-30-self-build-design.md), and [`docs/superpowers/specs/2026-08-30-self-evaluation-design.md`](../specs/2026-08-30-self-evaluation-design.md).

---

## How to use this file

**Each task is designed to be executed in a fresh session with no memory of the conversation that produced this plan.** To run one:

1. Read this header, "Global Constraints", and "Design" below — about 5 minutes.
2. Read the single task you are doing, top to bottom, including its **Interfaces** block.
3. Do the task's steps in order. Do not start the next task.
4. Tick the checkboxes as you go and commit at the end of the task.

Tasks within a Part are ordered and may depend on earlier tasks in the same Part. Parts A, B, and C must be done in order — Part B depends on nothing from A but Part C depends on B. Part A tasks are independent of each other and of everything else, so they can be done in any order, at any time, including first.

---

## Global Constraints

- **Node 22, TypeScript ESM.** Every relative import ends in `.js`, even when the source file is `.ts`. Match the surrounding file.
- **TDD is mandatory.** Write the failing test, run it, watch it fail for the right reason, then implement. A test that passes the first time you run it is testing nothing — fix the test.
- **Verification before completion.** `npm run typecheck` and `npx vitest run` must both pass before any commit. There is no lint script.
- **`EXCLUDED_PATHS` (`src/control/excluded-paths.ts`) blocks the *self-build PR pipeline*, not this plan.** Those files — `governor.ts`, `grants.ts`, `grants.yaml`, `goals.yaml`, `config.yaml`'s governor caps, `sdk-runner.ts`, `git-pusher.ts`, `webhook-*.ts`, `credentials.ts`, `index.ts`, `excluded-paths.ts`, `agent-schema.ts`, `.github/workflows/ci.yml`, `bot.ts` — are the system's own safety rails, and the system may never edit them *autonomously through builder → pr-reviewer → mergePR*. **A local interactive session executing this plan at the operator's direction is not that pipeline and should edit them normally where a task calls for it** (B2, B3, C3 and C4 all legitimately touch `src/index.ts` or `src/sdk-runner.ts` — wiring a feature into boot is the whole point of those steps). Only stop and report if you are running unattended as part of the self-build flow. What nobody changes, in any context: the *substance* of the caps themselves — do not widen a budget, a concurrency limit, or a grant while wiring something up.
- **Comments explain why, not what.** This codebase's convention is a doc comment on anything non-obvious, explaining the reasoning and what would break otherwise. Match that density — read a neighbouring file first.
- **Cost discipline.** Any new LLM call states its model, `effort`, and `maxBudgetUsd`. Default to `claude-haiku-4-5` / `effort: low` unless the task says otherwise.
- **Never commit secrets.** `.env` is gitignored. `.env.example` carries documentation only, never values.

---

## Design

### 1. What the system is supposed to be

Four properties, from which everything below is derived:

1. **It works toward the goal in `goals.yaml` forever** — meaning it makes progress, not merely that the process stays up.
2. **It never stalls.** Four distinct failure modes: *idle* (nothing to do), *loop* (proposing the same thing), *stuck* (work that can't complete), and *thrash* (constant successful activity, zero movement toward the goal). Thrash is the likely one and nothing currently detects it.
3. **It recovers from anything.** Infrastructure recovery is already good (crash handlers, task reconcile, breaker, auto-deploy rollback). *Semantic* recovery — the strategy is wrong, the research was a dead end — has no detection and therefore no recovery.
4. **It improves itself.** Today the improvement agents read `src/` only. They are structurally blind to the system's own *behaviour* and to what other agents have learned. Research findings terminate in a Discord message and are never read again.

### 2. The world model

A set of documents under `data/world/` that agents read before working and write after. Not the memory log — that answers *"have we seen something like this?"* via similarity search over short records. The world model answers *"what is true right now?"*, which a similarity search structurally cannot, because current state is the accumulation and resolution of many records.

**Bounded by construction, not by summarisation.** `reflection.ts` already warns that LLM-rewritten memory degrades over successive rewrites, so periodic re-summarising is a known-bad approach here. Instead each document's *current state* has a shape whose size is bounded by the number of real things it describes, with history appended below and read only on demand.

### 3. The overseer, and why it is not the rejected manager agent

[`2026-08-30-agent-loop-design.md`](../specs/2026-08-30-agent-loop-design.md) rejects a "CEO-agent-over-manager-agents-over-workers" hierarchy. Its objections are token multiplication, orchestrator context overflow past ~4 workers, hallucination cascade, and blurring into the Governor's job. **Every one of those is an objection to a manager in the execution path.** The overseer is not in any path: nothing waits on it, no run routes through it, and its only outputs are queued tasks (which compete in the normal queue on normal terms) and written documents. The Governor's "may this run" stays deterministic and untouched.

What checks the overseer, since it decides alone:
- It cannot execute. A wrong call costs a wasted task, not an outage.
- It records **machine-checkable expectations**, graded by code next cycle (Task C2). Being wrong is detectable, which is the whole difference between judgment and drift.
- The Governor's caps bind it regardless of what it decided.
- It cannot edit its own limits — `governor.ts`, `grants.ts`, `config.yaml` stay excluded.
- Every strategy change posts to Discord, so the operator reviews outcomes without gating actions.

### 4. Audit findings this plan closes

Verified against the repo on 2026-09-01:

| # | Finding | Status | Closed by |
|---|---|---|---|
| 1 | `goals.yaml` is parsed by `src/goals.ts` and read by no running code — only tests | Confirmed | C3 |
| 2 | `MetricsStore` is written weekly and read only by `digest.ts` — measurement terminates in a human notification | Confirmed | C2, A1 |
| 3 | `notAchievedByAgent` is computed at `metrics.ts` and consumed by **nothing**; the breaker trips only on 3 consecutive *hard failures*, so an agent that completes cleanly while achieving nothing never trips anything | Confirmed, worse than first assessed | A1 |
| 4 | No liveness check on any scheduled job — if the weekly passes stop, nothing notices | Confirmed | A2 |
| 5 | Exploration is weighted in *proposal ranking* (`weights.novelty`, `stalenessDays`) but nothing reserves *effort* for it, so exploitation can take everything | Confirmed, narrower than first assessed | C4 |
| 6 | Nothing forces a kill decision; no review dates exist anywhere | Confirmed | C5 |
| 7 | Agents cannot see each other's findings | Confirmed | B1–B3 |
| 8 | No path from "code in a repo" to "live service earning money" — zero `provision` grants exist, and the `provision` grant kind only classifies `npm publish` and `gh` | Confirmed | D1 (design first) |
| 9 | Negative revenue deltas render as `$-30.00` instead of `-$30.00` | Confirmed, cosmetic | A3 |

Already adequate, do not rebuild: `maxChainDepth: 3` and `maxAgentTasksPerDay: 20` bound runaway self-propagation; two-cutoff retention (90d raw / 365d reflections) bounds the memory log; `OutcomeVerifier` is existing precedent for independent grading — Task C2 follows its shape.

---

# Part A — Mechanical guards

Independent of each other and of Parts B and C. Each is small and closes a confirmed audit finding. Do these first; they make everything after them observable.

---

### Task A1: Auto-disable an agent that succeeds without achieving anything

**Why:** `notAchievedByAgent` has been computed weekly since the metrics job shipped and is read by nothing. The circuit breaker only counts hard failures (`src/state/breaker.ts` — `FAILURE_STATUSES`, 3 consecutive), so an agent whose runs all complete cleanly while the verifier grades every one `not-achieved` runs forever, costing money and producing nothing. This is the "thrash" failure mode at the agent level.

**Files:**
- Create: `src/state/agent-probation.ts`
- Create: `tests/agent-probation.test.ts`
- Modify: `src/metrics.ts` (call the new check at the end of `runMetricsJob`)
- Modify: `tests/metrics-job.test.ts` (one integration test)

**Interfaces:**
- Consumes: `Metrics` and `NotAchievedByAgent` from `src/state/metrics-store.js`; the disable API in `src/config-overrides.ts` (read that file, and how `!disable` uses it in `src/control/bot.ts`, for the exact method name and shape — do not guess it).
- Produces: `evaluateProbation(metrics: Metrics, opts: ProbationOptions): string[]` — returns the agent names that should be disabled, pure, no I/O. `ProbationOptions = { minRuns: number; maxNotAchievedRate: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent-probation.test.ts
import { describe, expect, it } from "vitest";
import { evaluateProbation } from "../src/state/agent-probation.js";
import type { Metrics } from "../src/state/metrics-store.js";

function metrics(notAchievedByAgent: Metrics["notAchievedByAgent"]): Metrics {
  return {
    computedAt: "2026-09-07T04:00:00.000Z",
    windowDays: 7,
    netIncomeUsd: 0,
    notAchievedRate: null,
    notAchievedByAgent,
    costPerCompletedTaskUsd: null,
    noveltySharePercent: null,
    suppressedProposalCount: 0,
    queueStarvationHours: null,
  };
}

const OPTS = { minRuns: 5, maxNotAchievedRate: 0.6 };

describe("evaluateProbation", () => {
  it("names an agent whose successful runs mostly achieve nothing", () => {
    const names = evaluateProbation(metrics([{ agent: "cleanup-scout", rate: 0.8, successRunCount: 10 }]), OPTS);
    expect(names).toEqual(["cleanup-scout"]);
  });

  // Without this, one bad week on a brand-new agent disables it before its
  // rate means anything — the sample size IS the evidence.
  it("spares an agent with too few runs to judge", () => {
    const names = evaluateProbation(metrics([{ agent: "new-scout", rate: 1, successRunCount: 2 }]), OPTS);
    expect(names).toEqual([]);
  });

  it("spares an agent under the rate threshold", () => {
    const names = evaluateProbation(metrics([{ agent: "research", rate: 0.5, successRunCount: 20 }]), OPTS);
    expect(names).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-probation.test.ts`
Expected: FAIL — `Cannot find module '../src/state/agent-probation.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/state/agent-probation.ts
import type { Metrics } from "./metrics-store.js";

export interface ProbationOptions {
  /** Below this many graded runs, the rate is noise rather than evidence. */
  minRuns: number;
  /** At or above this not-achieved rate, the agent is not doing its job. */
  maxNotAchievedRate: number;
}

/**
 * Which agents have earned an automatic disable. Pure — the caller does the
 * writing, so this stays trivially testable and the policy stays in one place.
 *
 * This is deliberately a different signal from the circuit breaker
 * (src/state/breaker.ts), which counts consecutive HARD failures. An agent
 * whose every run finishes "success" while the verifier grades it
 * "not-achieved" never trips the breaker, and before this function existed
 * nothing else looked at that case either.
 */
export function evaluateProbation(metrics: Metrics, opts: ProbationOptions): string[] {
  return metrics.notAchievedByAgent
    .filter((a) => a.successRunCount >= opts.minRuns && a.rate >= opts.maxNotAchievedRate)
    .map((a) => a.agent);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent-probation.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing integration test**

Add to `tests/metrics-job.test.ts`. Read the existing `fixtures()` helper at the top of that file and reuse it. The test must: record 6 runs for one agent that all close `status: "success"` with a `verifiedOutcome` of `{ verdict: "not-achieved", reason: "..." }`, run `runMetricsJob`, and assert the agent is now disabled in the overrides store. Read `src/config-overrides.ts` first for the exact read/write API, and add `overrides` to `fixtures()` if it isn't there.

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run tests/metrics-job.test.ts`
Expected: FAIL — the agent is not disabled.

- [ ] **Step 7: Wire it into the metrics job — all the way to boot**

In `src/metrics.ts`, add a **required** `overrides: ConfigOverridesStore` dep to `MetricsJobDeps` and, after `await deps.metricsStore.write(metrics)`, call `evaluateProbation` and disable each returned agent. Post a Discord alert naming each disabled agent and its rate — a silent disable is the same silent-failure class this whole plan exists to remove. Thresholds: `minRuns: 5`, `maxNotAchievedRate: 0.6`.

**Required, not optional.** An optional dep is what makes this task fail silently: the guard reads `if (deps.overrides)`, the scheduled path never passes one, and the check ends up fully implemented, fully tested, and never executed — the exact "computed by something, consumed by nothing" shape the task exists to fix. Making it required turns the omission into a `npm run typecheck` error, which is what points you at the two call sites below. Yes, this means updating the existing `runMetricsJob` calls in `tests/metrics-job.test.ts` to pass `f.overrides`; that is the point.

Then follow the compiler to the end of the wire:
1. `src/triggers/metrics.ts` — add `overrides` to `startMetrics`'s options and forward it. Also convert its callback from `void runMetricsJob(...).then().catch()` to `async`/`await` with a `try`/`catch`: croner awaits an async callback, so `protect: true` then genuinely prevents an overlapping run, and `job.trigger()` becomes awaitable, which is the only way to test this path.
2. `src/index.ts` — pass the `overrides` it already constructs for the Governor. **This file is an excluded path; a human runs this step** (see Global Constraints).
3. Add `tests/metrics-trigger.test.ts` covering the scheduled path end to end: seed six `success` runs carrying a `not-achieved` verdict, call `startMetrics` with a cron that never fires naturally (`"0 0 29 2 *"`), `await job.trigger()`, and assert the agent appears in `overrides.read()`'s `disabledAgents`. There was no test for this trigger before, which is how the gap survived.

- [ ] **Step 8: Verify everything passes**

Run: `npm run typecheck && npx vitest run`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/state/agent-probation.ts tests/agent-probation.test.ts src/metrics.ts tests/metrics-job.test.ts
git commit -m "feat: auto-disable agents that succeed without achieving anything"
```

---

### Task A2: Alert when a scheduled pass stops running

**Why:** If the weekly metrics or reflection pass stops firing — a bug, a crash loop, a budget exhaustion — the system silently reverts to its old behaviour and nothing says so. "Forever" requires the meta-level to have its own liveness check, and it must be code, not an agent, because an agent that has stopped running cannot report that it stopped running.

**Files:**
- Create: `src/state/liveness.ts`
- Create: `tests/liveness.test.ts`
- Modify: `src/digest.ts` (append a staleness warning to the daily digest)
- Modify: `tests/digest.test.ts`

**Interfaces:**
- Consumes: `MetricsStore.listAll()` from `src/state/metrics-store.js`.
- Produces: `stalePasses(input: { latestMetricsAt: string | null; now: Date; maxAgeDays: number }): string[]` — human-readable warning strings, empty when everything is fresh.

- [ ] **Step 1: Write the failing test**

```ts
// tests/liveness.test.ts
import { describe, expect, it } from "vitest";
import { stalePasses } from "../src/state/liveness.js";

const NOW = new Date("2026-09-30T08:00:00.000Z");

describe("stalePasses", () => {
  it("warns when the newest metrics snapshot is older than the limit", () => {
    const warnings = stalePasses({ latestMetricsAt: "2026-09-01T04:00:00.000Z", now: NOW, maxAgeDays: 14 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/metrics/i);
  });

  it("is silent when the snapshot is recent", () => {
    expect(stalePasses({ latestMetricsAt: "2026-09-29T04:00:00.000Z", now: NOW, maxAgeDays: 14 })).toEqual([]);
  });

  // A system that has never run the pass is not "fresh" — this is the state a
  // broken deploy leaves behind, and it must not read as healthy.
  it("warns when no snapshot has ever been written", () => {
    expect(stalePasses({ latestMetricsAt: null, now: NOW, maxAgeDays: 14 })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/liveness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/state/liveness.ts
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the system's periodic self-assessment is actually still happening.
 *
 * Deliberately code and not an agent: the failure this detects is "the
 * scheduled pass stopped running", and an agent that has stopped running
 * cannot report that it has stopped running. Read by the daily digest, which
 * runs on its own schedule and so survives the weekly ones dying.
 */
export function stalePasses(input: { latestMetricsAt: string | null; now: Date; maxAgeDays: number }): string[] {
  if (input.latestMetricsAt === null) {
    return ["⚠️ No metrics snapshot has ever been written — the weekly metrics pass has never completed."];
  }
  const ageDays = (input.now.getTime() - new Date(input.latestMetricsAt).getTime()) / DAY_MS;
  if (ageDays > input.maxAgeDays) {
    return [`⚠️ The newest metrics snapshot is ${Math.floor(ageDays)} days old — the weekly metrics pass has stopped running.`];
  }
  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/liveness.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing digest test**

In `tests/digest.test.ts`, reusing its `stores()` and `metricsSnapshot()` helpers: write a snapshot dated 30 days before the digest window and assert the digest text contains "stopped running". Note that `buildDigestText` currently omits the metrics section entirely for a stale snapshot — the staleness warning must appear *instead of* that section, not be swallowed with it.

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run tests/digest.test.ts`
Expected: FAIL — no such text.

- [ ] **Step 7: Wire into the digest**

In `src/digest.ts`, call `stalePasses` with `maxAgeDays: 14` (twice the weekly cadence, so one missed run is not an alarm) and push each warning onto `lines`. A stale-metrics warning must also count as "something happened", so the empty-digest early return does not swallow it.

- [ ] **Step 8: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/state/liveness.ts tests/liveness.test.ts src/digest.ts tests/digest.test.ts
git commit -m "feat: warn in the daily digest when the weekly metrics pass stops running"
```

---

### Task A3: Fix the negative revenue delta sign

**Why:** `formatMetricsLine` renders a negative delta as `$-30.00` because the sign is applied inside the template after the dollar sign. Cosmetic, but this line is the primary revenue signal a human reads.

**Files:**
- Modify: `src/digest.ts` (`formatMetricsLine`)
- Modify: `tests/digest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("renders a revenue drop with the sign before the currency symbol", async () => {
  const { store, tasks } = stores();
  const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
  const metricsStore = new MetricsStore(dataDir);
  await metricsStore.write(metricsSnapshot({ computedAt: BEFORE_WINDOW.toISOString(), netIncomeUsd: 30 }));
  await metricsStore.write(metricsSnapshot({ computedAt: WITHIN_WINDOW.toISOString(), netIncomeUsd: 0 }));

  const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

  expect(text).toContain("-$30.00");
  rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/digest.test.ts`
Expected: FAIL — received `$-30.00`.

- [ ] **Step 3: Fix the formatting**

In `formatMetricsLine`, compute the delta once, then build the string as sign, then `$`, then the absolute value: `` `${delta >= 0 ? "+" : "-"}$${Math.abs(delta).toFixed(2)}` ``.

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/digest.ts tests/digest.test.ts
git commit -m "fix: render negative revenue deltas as -\$30.00, not \$-30.00"
```

---

# Part B — The world model

The substrate. Part C depends on all of it. Do B1 → B2 → B3 in order.

---

### Task B1: The world model store

**Why:** Agents currently cannot see each other's work. Research findings terminate in a run transcript and a Discord message; `improvement-scout` reads `src/` and will never learn what `research` concluded. The memory log does not fix this — it answers "have we seen something like this?" by similarity over short records, not "what is true right now?".

**Design of the documents** — each is bounded by the number of real things it describes, not by summarisation:

- `data/world/portfolio.md` — one `## <slug>` section per live thing. Sections are **replaced in place**, never appended, so the file's size tracks the number of live products.
- `data/world/shelf.md` — one bullet per set-aside idea: what it was, why it was shelved, and what would make it worth revisiting.
- `data/world/findings/<topic>.md` — a fixed-size `## Current conclusion` block at the top (what we believe now, and how confident), with `## History` appended below. Readers get the conclusion; the history is read only on demand.
- `data/world/strategy.md` — written by the overseer in Part C. Created here so the shape is defined in one place.

**Files:**
- Create: `src/world/world-model.ts`
- Create: `tests/world-model.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic` from `src/atomic-write.js` (every durable write in this codebase goes through it — read `src/state/metrics-store.ts` for the pattern).
- Produces:
  - `class WorldModel { constructor(dataDir: string) }`
  - `readPortfolio(): Promise<PortfolioEntry[]>`
  - `upsertPortfolioEntry(entry: PortfolioEntry): Promise<void>` — replaces the section with the same `slug`, appends when new
  - `readShelf(): Promise<ShelfItem[]>`
  - `addShelfItem(item: ShelfItem): Promise<void>`
  - `readFinding(topic: string): Promise<Finding | null>`
  - `writeFinding(topic: string, finding: Finding): Promise<void>` — replaces the conclusion, appends the old one to history
  - `summaryForPrompt(): Promise<string>` — the bounded digest injected into agent prompts in B2
- Types (define these exactly; C1–C5 rely on the names):

```ts
export interface PortfolioEntry {
  slug: string;
  purpose: string;
  status: "building" | "live" | "paused" | "killed";
  /** ISO date. The next time this must justify itself — see Task C5. */
  nextReviewAt: string;
  /** What it must show by nextReviewAt to survive. Prose, graded by a human-readable bar. */
  bar: string;
  monthlyCostUsd: number;
  /** Leading indicators, newest last, e.g. "2026-09-01: 3 signups". */
  notes: string[];
}

export interface ShelfItem {
  summary: string;
  shelvedAt: string;
  reason: string;
  /** What would make this worth reconsidering. Empty string means "nothing — this is dead". */
  revisitWhen: string;
}

export interface Finding {
  topic: string;
  conclusion: string;
  confidence: "low" | "medium" | "high";
  updatedAt: string;
  sources: string[];
}
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/world-model.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldModel, type PortfolioEntry } from "../src/world/world-model.js";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-world-"));
  return { dataDir, world: new WorldModel(dataDir) };
}

function entry(overrides: Partial<PortfolioEntry> = {}): PortfolioEntry {
  return {
    slug: "widget-api",
    purpose: "Paid API for widget conversion",
    status: "live",
    nextReviewAt: "2026-10-01",
    bar: "at least one paying customer",
    monthlyCostUsd: 12,
    notes: ["2026-09-01: launched"],
    ...overrides,
  };
}

describe("WorldModel portfolio", () => {
  it("round-trips an entry", async () => {
    const f = fixture();
    await f.world.upsertPortfolioEntry(entry());
    expect(await f.world.readPortfolio()).toEqual([entry()]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  // The bound on this file is the number of live products. If upsert appended
  // instead of replacing, every review would grow it forever and the overseer
  // would eventually be unable to read its own portfolio.
  it("replaces a section with the same slug rather than appending", async () => {
    const f = fixture();
    await f.world.upsertPortfolioEntry(entry());
    await f.world.upsertPortfolioEntry(entry({ status: "killed", monthlyCostUsd: 0 }));

    const all = await f.world.readPortfolio();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("killed");
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("keeps entries with different slugs side by side", async () => {
    const f = fixture();
    await f.world.upsertPortfolioEntry(entry({ slug: "a" }));
    await f.world.upsertPortfolioEntry(entry({ slug: "b" }));
    expect((await f.world.readPortfolio()).map((e) => e.slug)).toEqual(["a", "b"]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("returns an empty portfolio before anything has been written", async () => {
    const f = fixture();
    expect(await f.world.readPortfolio()).toEqual([]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/world-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the portfolio half**

Store `portfolio.md` as Markdown with a fenced JSON block per section, so the file is readable by a human and by an agent's `Read` tool while parsing exactly. Write via `writeFileAtomic`. A missing file reads as empty, never throws — match `MetricsStore.listAll`'s posture. A section that fails to parse is logged and skipped, not thrown; one corrupt entry must never make the whole portfolio unreadable.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/world-model.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write failing tests for the shelf and findings**

Cover, one test each: a shelf item round-trips; `readFinding` returns `null` for an unknown topic; `writeFinding` replaces the current conclusion; `writeFinding` moves the superseded conclusion into `## History` rather than discarding it (the reason we can distinguish "we rejected this" from "we rejected this, but the world has changed").

- [ ] **Step 6: Run them and watch them fail, then implement**

Run: `npx vitest run tests/world-model.test.ts`

- [ ] **Step 7: Write the failing test for `summaryForPrompt`**

It must include every live portfolio entry's slug and status, every shelf item's summary, and each finding's topic and current conclusion — and must *not* include finding history. Assert on a fixture with two products, one shelf item and one finding with history.

- [ ] **Step 8: Implement, verify, commit**

```bash
npm run typecheck && npx vitest run
git add src/world/world-model.ts tests/world-model.test.ts
git commit -m "feat: add the world model store"
```

---

### Task B2: Inject the world model into agent prompts

**Why:** A store nothing reads changes nothing. This is the task that actually fixes agent blindness.

**Files:**
- Modify: `src/control/dispatcher.ts` (append the summary to a dispatched task's prompt)
- Modify: `src/index.ts` (construct one `WorldModel` and pass it in — see the Global Constraints note about `index.ts`)
- Modify: `tests/dispatcher.test.ts`

**Interfaces:**
- Consumes: `WorldModel.summaryForPrompt()` from Task B1.
- Produces: nothing new; dispatched runs simply start knowing what the system knows.

- [ ] **Step 1: Read how memory is already injected**

`src/control/dispatcher.ts` already appends recalled memory to a dispatched task's prompt. Find that code. The world-model summary goes in the same place, under its own heading, so there is one mechanism and one ordering rather than two competing ones.

- [ ] **Step 2: Write the failing test**

In `tests/dispatcher.test.ts`, following its existing fixture style: seed a `WorldModel` with one live portfolio entry, dispatch a task, and assert the prompt the orchestrator received contains that entry's slug.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/dispatcher.test.ts`
Expected: FAIL — the slug is absent.

- [ ] **Step 4: Implement**

Add a **required** `world: WorldModel` dep to the dispatcher.

Required for the reason Task A1 had to be fixed after the fact: an optional dep here degrades to "the world model is silently never injected", which is invisible in exactly the same way A1's `if (deps.overrides)` was — the tests pass, the runs succeed, and the feature does nothing. Making it required means `npm run typecheck` names every call site that has not been wired, including `src/index.ts`. Yes, this means updating existing dispatcher tests to construct a `WorldModel` over their temp dir; that is the point, and it is mechanical.

- [ ] **Step 5: Wire it in `src/index.ts`**

Construct `const world = new WorldModel(DATA_DIR)` next to `memory`, and pass it to the `Dispatcher`.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/control/dispatcher.ts src/index.ts tests/dispatcher.test.ts
git commit -m "feat: give dispatched tasks the world model as context"
```

---

### Task B2b: Give cron agents the world model too

**Why:** Task B2 injects the world model into *dispatched* tasks only — `src/triggers/cron.ts` calls `orchestrator.executeRun(agent)` with no `promptContext`, so every cron agent gets nothing. That is the wrong half. The motivating example for this whole subsystem is that `improvement-scout` reads only `src/` and will never see what `research` concluded, and `improvement-scout` is cron-fired. The scouts are the system's proposers; they are precisely the agents that need to know what has already been found, tried, and shelved.

This task was added on 2026-09-01 after B2 landed and the gap was found by tracing the wire. It is small.

**Files:**
- Modify: `src/triggers/cron.ts`
- Create: `tests/cron-trigger.test.ts`
- Modify: `src/index.ts` (pass the `WorldModel` it already constructs)

**Interfaces:**
- Consumes: `WorldModel.summaryForPrompt()` from Task B1; `Orchestrator.executeRun(agent, now?, promptContext?)`.
- Produces: `startCron(agents: AgentDef[], orchestrator: Orchestrator, world: WorldModel): Cron[]` — `world` **required**, same reasoning as B2.

- [ ] **Step 1: Write the failing test**

There is no test file for this trigger at all, which is how the gap survived. Create one. Use a cron expression that never fires naturally (`"0 0 29 2 *"`, Feb 29 on a non-leap year) and drive the job with `await job.trigger()`, exactly as `tests/metrics-trigger.test.ts` does — read that file first, it solved this same problem in Task A2.

The test: seed a `WorldModel` with one live portfolio entry, call `startCron` with a stub orchestrator that records the `promptContext` it receives, trigger the job, and assert the recorded context contains that entry's slug.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/cron-trigger.test.ts`
Expected: FAIL — the orchestrator received `undefined` for `promptContext`.

- [ ] **Step 3: Implement**

Add the required `world` parameter, make the croner callback `async`, and pass `await world.summaryForPrompt()` as `promptContext`. Wrap the summary read in its own `try`/`catch` that logs and falls back to no context — a world-model read failure must never stop a scheduled run, which is the same posture `dispatcher.ts` already takes.

- [ ] **Step 4: Run it and watch it pass**

- [ ] **Step 5: Wire it at boot**

`src/index.ts` already constructs `const world = new WorldModel(DATA_DIR)` for the dispatcher. Pass it to `startCron`. Typecheck will point at the call site.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/triggers/cron.ts tests/cron-trigger.test.ts src/index.ts
git commit -m "feat: give cron agents the world model as context"
```

---

### Task B3: Let agents write findings back

**Why:** Reading is half of it. Until `research` can record a conclusion where `improvement-scout` will find it, every research run still terminates.

**Files:**
- Modify: `src/runner/sdk-runner.ts` — **read the Global Constraints note first; this file is on `EXCLUDED_PATHS`, so a human runs this task**
- Modify: `tests/sdk-runner.test.ts`
- Modify: `agents/research/prompt.md`

**Interfaces:**
- Consumes: `WorldModel.writeFinding` and `WorldModel.upsertPortfolioEntry` from Task B1.
- Produces: two MCP tools available to agents, `recordFinding` and `updatePortfolioEntry`, modelled exactly on the existing `queueTask` tool in `sdk-runner.ts` — read that tool's definition, Zod schema, and return shape and follow it.

- [ ] **Step 1: Read the existing `queueTask` tool**

In `src/runner/sdk-runner.ts`. Note how its Zod schema is declared, how it returns `{ content: [{ type: "text", text: ... }] }`, and how its dependency is threaded through `buildRunner`.

Thread `world` the same way, then **trace it from boot and confirm a real run gets the tools**. If the dep never arrives the tools are simply not registered, and the only symptom is an agent reporting a tool it cannot find — which looks like a prompt problem, not a wiring one. Task A1 shipped dead for the same reason.

- [ ] **Step 2: Write the failing test**

In `tests/sdk-runner.test.ts`, following the existing tool tests: invoke `recordFinding` with a topic, conclusion, confidence and sources, and assert the `WorldModel` now returns that finding.

- [ ] **Step 3: Run it and watch it fail, then implement both tools**

`recordFinding({ topic, conclusion, confidence, sources })` and `updatePortfolioEntry(entry)`. Validate with Zod exactly as `queueTask` does — an agent passing a bad `status` must get a tool error, not a corrupt portfolio.

- [ ] **Step 4: Update the research agent's prompt**

Add to `agents/research/prompt.md`: it must end every run by calling `recordFinding` with what it concluded, including when the conclusion is "this is not worth pursuing" and why — a recorded dead end is what stops the same ground being covered again in three months.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/runner/sdk-runner.ts tests/sdk-runner.test.ts agents/research/prompt.md
git commit -m "feat: let agents record findings and portfolio state in the world model"
```

---

# Part C — The overseer

Depends on all of Part B. Do C1 → C5 in order.

---

### Task C1: The strategy record

**Why:** "Works toward a goal forever" requires the system to hold, between cycles, what it is currently trying to do and why. Nothing does today — every cron tick starts from nothing.

**Files:**
- Create: `src/world/strategy.ts`
- Create: `tests/strategy.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Expectation {
  id: string;
  /** ISO date by which this should be true. */
  dueAt: string;
  check:
    | { kind: "netIncomeUsd"; atLeast: number }
    | { kind: "productRevenueUsd"; product: string; atLeast: number }
    | { kind: "portfolioStatus"; slug: string; is: "live" };
}

export interface Strategy {
  writtenAt: string;
  /** What the system is trying to do about goals.yaml this cycle, in prose. */
  intent: string;
  /** Effort split for the cycle. Must sum to 100. */
  allocation: { research: number; build: number; maintain: number };
  expectations: Expectation[];
  /** Why this differs from the previous cycle. Empty on the first ever cycle. */
  changeReason: string;
}
```
  - `class StrategyStore { constructor(dataDir: string) }` with `latest(): Promise<Strategy | null>`, `all(): Promise<Strategy[]>`, `write(s: Strategy): Promise<void>`

- [ ] **Step 1: Write the failing test**

Cover: a strategy round-trips; `latest()` returns the newest by `writtenAt`; `latest()` is `null` before anything is written; `all()` is ordered oldest-first; an allocation not summing to 100 is rejected by `write` with a clear error (a silently renormalised allocation is a decision nobody made).

- [ ] **Step 2: Run it, watch it fail, implement**

Append-only, one JSON file per cycle under `data/world/strategy/`, written with `writeFileAtomic`. Never rewrite a past strategy — the history is the only evidence of whether the overseer's judgment is improving.

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/world/strategy.ts tests/strategy.test.ts
git commit -m "feat: add the persistent strategy record"
```

---

### Task C2: Grade the previous cycle's expectations

**Why:** This is the single most important task in the plan. An overseer that grades itself in prose will drift, and drift is invisible by definition. Expectations that code can check make being wrong *detectable*, which is the entire difference between judgment and drift. Follow the shape of the existing `OutcomeVerifier` (`src/control/outcome-verifier.ts`): an independent grader whose verdict is data.

**Files:**
- Create: `src/world/grade-expectations.ts`
- Create: `tests/grade-expectations.test.ts`

**Interfaces:**
- Consumes: `Expectation` from Task C1; `Metrics` from `src/state/metrics-store.js`; `PortfolioEntry` from Task B1; `Sale` from `src/control/revenue-transport.js`.
- Produces: `gradeExpectations(input: GradeInput): Verdict[]` — pure, no I/O.

```ts
export interface GradeInput {
  expectations: Expectation[];
  metrics: Metrics | null;
  salesInWindow: Sale[];
  portfolio: PortfolioEntry[];
  now: Date;
}
export interface Verdict {
  expectationId: string;
  outcome: "met" | "missed" | "not-yet-due" | "ungradeable";
  detail: string;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/grade-expectations.test.ts — abbreviated; write all six cases
import { describe, expect, it } from "vitest";
import { gradeExpectations } from "../src/world/grade-expectations.js";

const NOW = new Date("2026-10-02T00:00:00.000Z");

describe("gradeExpectations", () => {
  it("marks a met revenue expectation", () => {
    const [v] = gradeExpectations({
      expectations: [{ id: "e1", dueAt: "2026-10-01", check: { kind: "netIncomeUsd", atLeast: 50 } }],
      metrics: { netIncomeUsd: 75 } as never,
      salesInWindow: [],
      portfolio: [],
      now: NOW,
    });
    expect(v?.outcome).toBe("met");
  });

  it("marks a missed revenue expectation", () => {
    const [v] = gradeExpectations({
      expectations: [{ id: "e1", dueAt: "2026-10-01", check: { kind: "netIncomeUsd", atLeast: 50 } }],
      metrics: { netIncomeUsd: 10 } as never,
      salesInWindow: [],
      portfolio: [],
      now: NOW,
    });
    expect(v?.outcome).toBe("missed");
  });

  it("does not grade an expectation that is not due yet", () => {
    const [v] = gradeExpectations({
      expectations: [{ id: "e1", dueAt: "2026-12-01", check: { kind: "netIncomeUsd", atLeast: 50 } }],
      metrics: { netIncomeUsd: 0 } as never,
      salesInWindow: [],
      portfolio: [],
      now: NOW,
    });
    expect(v?.outcome).toBe("not-yet-due");
  });

  // A revenue-read outage must never be scored as a miss — that would teach
  // the overseer that a working strategy failed. See Metrics.revenueUnavailable.
  it("marks a revenue expectation ungradeable when revenue could not be read", () => {
    const [v] = gradeExpectations({
      expectations: [{ id: "e1", dueAt: "2026-10-01", check: { kind: "netIncomeUsd", atLeast: 50 } }],
      metrics: { netIncomeUsd: 0, revenueUnavailable: true } as never,
      salesInWindow: [],
      portfolio: [],
      now: NOW,
    });
    expect(v?.outcome).toBe("ungradeable");
  });
});
```

Also write: a `productRevenueUsd` expectation graded from `salesInWindow` filtered by `Sale.product`; a `portfolioStatus` expectation graded from `portfolio`.

- [ ] **Step 2: Run them, watch them fail, implement**

Run: `npx vitest run tests/grade-expectations.test.ts`

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/world/grade-expectations.ts tests/grade-expectations.test.ts
git commit -m "feat: grade the overseer's expectations mechanically"
```

---

### Task C3: The overseer agent

**Why:** Everything above is inert without something that reads it and decides. This is the tier-3 decision-maker: it reads `goals.yaml`, the world model, the last strategy and its graded verdicts, and writes the next strategy plus queued tasks. It cannot execute, cannot merge, cannot spend, and holds no outward grants.

**Files:**
- Create: `agents/overseer/agent.yaml`
- Create: `agents/overseer/prompt.md`
- Create: `src/triggers/overseer.ts`
- Create: `tests/overseer-trigger.test.ts`
- Modify: `src/index.ts` (schedule it — see the Global Constraints note)

**Interfaces:**
- Consumes: `StrategyStore` (C1), `gradeExpectations` (C2), `WorldModel` (B1), `loadGoals` from `src/goals.js` — **this is the first code in the system to actually call `loadGoals`**, closing audit finding #1.
- Produces: a weekly run that writes one `Strategy` and queues tasks.

- [ ] **Step 1: Write `agents/overseer/agent.yaml`**

```yaml
name: overseer
enabled: true
authoredBy: claude-local
description: >-
  Reads goals.yaml, the world model, and the previous cycle's graded
  expectations, then writes the next strategy and queues the work it implies.
  Decides only — never implements, merges, or spends.

trigger:
  type: cron
  schedule: "0 5 * * 1"   # Monday 05:00 — after reflection (03:00) and metrics (04:00), so both are fresh
  timezone: Europe/Berlin

run:
  model: claude-opus-5
  effort: high
  maxTurns: 40
  timeoutMinutes: 30
  maxBudgetUsd: 5.00

permissions:
  allowedTools: [Read, Glob, Grep]
  disallowedTools: []

tier: readonly
approval: notify
grantRefs: []

outbox:
  discord: ops
  notifyOn: [success, failure]
```

Three of these are settled, not defaults to reconsider:

**`tier: readonly` is correct, and the tool list above is exactly what it permits.** Two separate layers matter here and it is easy to conflate them:

- The **schema** (`src/agent-schema.ts`) restricts `permissions.allowedTools` by tier. `READONLY_TOOLS` is `[Read, Glob, Grep, WebSearch, WebFetch, TodoWrite]` — **`Write` and `Edit` are rejected at boot on a `readonly` agent.** That is why this agent does all of its writing through the MCP tools in Steps 2 and 3 rather than the `Write` tool. Do not "fix" a schema error here by adding `Write` and bumping the tier to `sandboxed`; the tools are the design.
- The **grant layer** (`decide()` in `src/grants.ts`) returns `allow` immediately when `detectOutwardEffect` finds nothing, and that function only fires on Bash (`git push`, `curl`/`wget`, `npm publish`, `gh`), `WebFetch`, and the git/GitHub MCP tools. So MCP tools like `queueTask` are never outward effects and need no grant.

Together: `readonly` denies every outward effect with a clear reason, the schema keeps the raw filesystem out of reach, and the validated MCP tools are the only way this agent changes anything. `approval: notify`, not `auto` — the schema rejects `auto` on a non-autonomous tier, and the other three scouts already pair `readonly` with `notify`.

**`model: claude-opus-5`.** This is the one decision in the system that every other decision inherits from, it runs 52 times a year, and its job is cross-cutting synthesis — noticing that flat revenue, a tripping breaker, and three dead ends are one problem. Its output also *commissions* research directions rather than only ranking existing ones, so a better model raises the system's idea-supply ceiling instead of being capped by it. The cost difference at this cadence is rounding error against the primary goal.

**`maxBudgetUsd: 5.00`, not 3.00.** A cycle truncated at the ceiling produces no strategy at all, which is strictly worse than a more expensive one.

**`governor.dailyBudgetUsd` must be raised before this ships, and it is an operator decision, not part of this task.** It is currently `10`, and Monday already runs reflection, metrics, `improvement-scout` and `opportunity-scout` — a $5 overseer on top of that will be refused, surfacing only as a Governor refusal alert and producing no strategy that week. Note what this number actually is: the system authenticates with a **Claude subscription**, so `costUsd` is token usage priced at API rates, not money charged to anyone. `dailyBudgetUsd` is a runaway tripwire wearing a budget's clothes. Set it high enough never to bind in normal operation (~40) while still catching a genuine loop.

**Scheduling note — revisit once the weekly reset time is known.** Opus usage draws from the same weekly subscription pool as everything else, so this run is a fixed capacity cost taken once per week. It should therefore fire as soon as possible *after* the subscription's weekly reset, so the maximum remaining capacity is available to adapt around it — spend on the decision first, then execute within what is left. `0 5 * * 1` is a placeholder chosen to follow the metrics job, not because Monday is known to be the reset day. The `resetsAt` field on `RateLimitSnapshot` (`src/state/rate-limit.ts`) carries the real answer; realign this cron once something has actually observed it.

- [ ] **Step 2: Add the `writeStrategy` tool**

**Files:** `src/runner/sdk-runner.ts`, `tests/` (extend the world-tools test file from Task B3).

The agent must not hand-author strategy JSON with the `Write` tool. `StrategyStore.write` rejects an allocation that does not sum to 100 (Task C1), so a hand-written file that is off by three produces *no strategy for that cycle* — and the next cycle then has nothing to grade, silently. Expose a `writeStrategy` MCP tool instead, built exactly like `recordFinding` from Task B3: Zod-validated input, `StrategyStore.write` behind it, and a tool error returned to the agent when validation fails, so it can correct itself mid-run.

Same for clearing a disable — see Step 3.

- [ ] **Step 3: Add the `setAgentEnabled` tool**

**Files:** `src/runner/sdk-runner.ts`, tests alongside `writeStrategy`.

Task A1 auto-disables an agent whose successful runs mostly achieve nothing. Nothing in the system can undo that except the operator typing `!enable`, so one bad week for `builder` halts every build task indefinitely, and the overseer can see the resulting queue starvation while being unable to act on it.

Give the overseer a Zod-validated `setAgentEnabled({ agent, enabled, reason })` tool that writes the same `disabledAgents` override `!disable`/`!enable` use (`src/config-overrides.ts`). Post the change and its reason to Discord, exactly as A1's auto-disable does.

**Re-enabling must also reset the circuit breaker**, the way `!enable` does — see how `src/control/bot.ts` handles `!enable` and follow it. An agent can be halted by *two* independent mechanisms (the `disabledAgents` override and a tripped breaker in `src/state/breaker.ts`), and clearing only one leaves it just as stuck while looking fixed. Refuse an unknown agent name, naming the agents that do exist, as `!disable` already does.

This is deliberately a **configuration** capability, not a code one. Config changes are bounded, reversible, and still capped by the Governor; the overseer is the one agent whose reasoning nobody reviews, so it must not also be the one making unreviewed code changes. What to do when an agent is broken rather than merely disabled is Task C6, not this.

- [ ] **Step 4: Write `agents/overseer/prompt.md`**

It must state: what it reads (goals, world model, last strategy, verdicts, metrics); that its output is a strategy plus queued tasks, written with the `writeStrategy` tool — never by hand-editing a file; that it must **never** implement anything itself; that every expectation it records must be checkable by one of the three `Expectation.check` kinds in `src/world/strategy.ts`; that it must explain in `changeReason` why this cycle differs from the last; that `setAgentEnabled` exists for re-enabling an agent auto-disabled by the probation check, and is for that case only, with a stated reason; and that when a `means` constraint in `goals.yaml` blocks every available path, it must say so explicitly, because that is the one thing only the operator can resolve.

- [ ] **Step 5: Write the failing trigger test**

In `tests/overseer-trigger.test.ts`: assert `startOverseer` schedules on the configured cron and that a fire grades the previous cycle's expectations before the run starts, passing the verdicts into the prompt. Model the test on `tests/metrics-trigger.test.ts` (Task A1's fix) — it solved driving a cron job deterministically with a never-firing schedule and `await job.trigger()`.

- [ ] **Step 6: Run it, watch it fail, implement `src/triggers/overseer.ts`**

Follow `src/triggers/metrics.ts` exactly — same croner options (`protect: true`), same async callback, same boot log line, same catch posture.

- [ ] **Step 7: Wire into `src/index.ts`**

Lazily imported and gated on a config flag, exactly like the metrics and reflection triggers. Then **trace it from boot and confirm the overseer actually receives `StrategyStore`, `WorldModel` and the new tools** — three tasks in this plan have shipped or nearly shipped features that nothing reachable ever called.

- [ ] **Step 8: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add agents/overseer src/triggers/overseer.ts tests/overseer-trigger.test.ts src/index.ts
git commit -m "feat: add the overseer agent"
```

---

### Task C4: Code-enforced exploration floor

**Why:** Once one product earns anything, every allocation decision looks better spent on it than on a speculative new direction. The system converges on a local optimum and stays there — busy forever, never growing. `weights.novelty` biases *proposal ranking* but reserves no *effort*, so it cannot prevent this. The floor must be code, because the whole point is that it binds the overseer's judgment rather than expressing it.

**Files:**
- Modify: `src/control/task-store.ts` (add `category` to `Task`; enforce the floor in the claim path)
- Modify: `tests/task-store.test.ts`
- Modify: `src/runner/sdk-runner.ts` (`queueTask` accepts `category`) — **human-run, see Global Constraints**

**Interfaces:**
- Consumes: the existing `Task` type and claim path in `src/control/task-store.ts` — read `claimNext`/`nextPending` (around line 144, "Highest priority first, ties broken by creation order") before changing anything.
- Produces: `Task.category: "exploration" | "exploitation" | "maintenance"`, defaulting to `"exploitation"` for every task that does not set one, including human `!task` requests.

- [x] **Step 1: Write the failing test**

```ts
// The floor: if the last EXPLORATION_INTERVAL claims contained no exploration
// task and one is pending, it is claimed next regardless of priority.
it("claims a pending exploration task once the interval has elapsed without one", async () => {
  // ...seed 1 exploration task at priority 1 and several exploitation tasks at
  // priority 90; claim EXPLORATION_INTERVAL times; assert the exploration task
  // was claimed despite always being the lowest priority.
});

it("does not starve the queue when no exploration task is pending", async () => {
  // ...only exploitation tasks pending; every claim still succeeds.
});
```

- [x] **Step 2: Run it, watch it fail, implement**

`EXPLORATION_INTERVAL = 5`. Persist the count of claims since the last exploration claim next to the other durable state, so a restart does not reset the floor.

- [x] **Step 3: Thread `category` through `queueTask`**

Add it to the Zod schema as an optional field defaulting to `"exploitation"`, and document in the overseer's prompt that exploration work must be tagged as such.

- [x] **Step 4: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/control/task-store.ts tests/task-store.test.ts src/runner/sdk-runner.ts
git commit -m "feat: reserve queue capacity for exploration work"
```

---

### Task C5: Forced review dates

**Why:** An agent asked "should we kill this?" almost always says "give it more time" — continuing has no cost in its own reasoning. Without a forcing function the portfolio accumulates zombies, each quietly consuming hosting money under the spend ceiling. This inverts the burden: failing the bar kills it *unless* the overseer writes a specific reason, a new bar, and a new date.

**Files:**
- Create: `src/world/reviews.ts`
- Create: `tests/reviews.test.ts`
- Modify: `src/world/world-model.ts` and `tests/world-model.test.ts` (the `extensionCount` field)
- Modify: `src/triggers/overseer.ts` and `tests/overseer-trigger.test.ts` (Step 3b — render due reviews into the prompt)
- Modify: `src/runner/sdk-runner.ts` (Step 3b — `extensionCount` on the portfolio tool's schema) — **human-run, see Global Constraints**
- Modify: `agents/overseer/prompt.md`

**Interfaces:**
- Consumes: `PortfolioEntry` from Task B1.
- Produces: `dueReviews(portfolio: PortfolioEntry[], now: Date): PortfolioEntry[]`, and `MAX_EXTENSIONS = 2`.

- [ ] **Step 1: Write the failing test**

Cover: an entry past `nextReviewAt` is returned; a future one is not; a `killed` entry is never returned however overdue; entries are returned most-overdue first.

- [ ] **Step 2: Run it, watch it fail, implement**

- [ ] **Step 3: Add the extension cap**

Add `extensionCount: number` to `PortfolioEntry` (default `0`) and a `canExtend(entry)` helper returning `entry.extensionCount < MAX_EXTENSIONS`. Update `tests/world-model.test.ts` for the new field.

- [ ] **Step 3b: Make both of them reachable — added after C3 shipped**

As originally written this task would have produced the fifth "computed by something, consumed by nothing" instance in this codebase. Two separate breaks, both must be closed here:

**The overseer cannot see what is due.** `src/triggers/overseer.ts`'s `buildPromptContext` already calls `world.readPortfolio()` (for grading), but renders only `world.summaryForPrompt()`, which prints each entry as `- <slug> (<status>)` and nothing else — no `nextReviewAt`, no `bar`, no `extensionCount`. So `dueReviews()` would sit in `src/world/reviews.ts` uncalled while the agent it exists to bind never learns a review is overdue. Add a `## Due reviews` section to that prompt context, built from `dueReviews(portfolio, now)` on the portfolio it already read. Render each one with its slug, its `bar`, how overdue it is, its `extensionCount`, and whether `canExtend` is still true. When none are due, say so explicitly — an empty section reads as a rendering bug. Test it in `tests/overseer-trigger.test.ts` against a seeded overdue entry.

**The overseer cannot write the field.** The portfolio MCP tool's Zod schema in `src/runner/sdk-runner.ts` (near line 847, alongside `nextReviewAt`) has no `extensionCount`, so an entry written through the tool would silently lose it and `canExtend` would be permanently true — the cap would never bind. Add it to that schema, optional and defaulting to `0` so existing callers and the existing tool tests keep working. Add a test that an entry written with `extensionCount: 2` reads back with it.

- [ ] **Step 4: Update the overseer prompt**

Every due review ends in exactly one of: mark `killed` (and queue a deprovision task naming the product), or extend with a *new* bar, a *new* date, and an incremented `extensionCount` — and extending is refused once `canExtend` is false. State plainly that "give it more time" without a new bar is not an available answer.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/world/reviews.ts tests/reviews.test.ts src/world/world-model.ts tests/world-model.test.ts \
        src/triggers/overseer.ts tests/overseer-trigger.test.ts src/runner/sdk-runner.ts \
        tests/sdk-runner-world-tools.test.ts agents/overseer/prompt.md
git commit -m "feat: force a kill-or-justify decision on every portfolio review"
```

---

### Task C6: Break the single-builder deadlock

**Why:** `builder` is the only agent that can originate a code change. If it stops working, nothing can fix it — including itself. Three distinct ways it stops:

1. **Auto-disabled** by Task A1's probation check after a bad week. Closed by C3's `setAgentEnabled`.
2. **Breaker tripped** by three consecutive hard failures. Also closed by C3, *provided* `setAgentEnabled` resets the breaker the way `!enable` does.
3. **Genuinely broken** — its prompt or the code it depends on is wrong. Nothing closes this. The overseer can queue "fix builder", the router sends it to `builder`, and the task fails or sits forever while queue starvation climbs.

Case 3 is the real hole, and it is the reason not to solve this by giving the overseer code access: the fix is a second pair of hands, not fewer checks on the one agent nobody reviews.

**Files:**
- Create: `agents/repair/agent.yaml`, `agents/repair/prompt.md`
- Modify: `src/control/dispatcher.ts` and its tests, if the investigation in Step 1 shows routing needs it

**Interfaces:**
- Consumes: the existing `builder-push` grant — **reuse it, do not add a grant or a credential.** A second agent holding the same narrowly-scoped push grant adds no reach the system did not already have. (`infra-repo`, named here in an earlier draft, is `pr-reviewer`'s read grant; `builder` holds `builder-push` alone. `grantRefs: [builder-push]` is what Step 2 mirrors.)

**The branch namespace is not negotiable, and that is the point.** `builder-push` is scoped to `branches: ["agent/builder/*"]`, and `pushBranch`/`openPR` in `src/runner/sdk-runner.ts` additionally enforce that same `agent/builder/` prefix with a hardcoded regex the comment there describes as one "no grant or tier can override". So `repair` pushes into `agent/builder/*` like everything else. Do **not** widen `builder-push`'s `branches`, add an `agent/repair/*` pattern, or touch that regex to make the branch name read nicer — the namespace is really "the one namespace agent-authored branches live in", and a cosmetic rename would trade the system's only enforced push boundary for a tidier branch name. `pushBranch` is registered for any agent whose runner has a `gitPusher` (wired once at `src/index.ts:144`), so the grant check is the actual gate and no wiring change is needed.

- [ ] **Step 1: Investigate before designing**

Answer these against the code and write the answers into the commit message:
- Does the LLM router (`src/control/llm-router.ts`) see disabled agents in its specialist menu, and does `src/control/dispatcher.ts` skip an agent that is disabled or breaker-tripped when claiming a task? Read `Dispatcher.claimAndStart` and `Governor.admit`.
- What happens today to a dispatched task whose routed agent is disabled — does it fail, retry, or sit `pending` forever? This decides whether C6 needs a routing change or only a second agent.

- [ ] **Step 2: Write `agents/repair/agent.yaml`**

`trigger.type: dispatched`. Same `permissions.allowedTools` and `grantRefs` as `agents/builder/agent.yaml` — read that file and mirror it. A `description` that makes the router pick it *only* for repairing the system's own agents and infrastructure, never for ordinary feature work, so it does not simply become a second builder competing for every task.

`tier: autonomous`, `approval: auto`, per this project's standing preference in `CLAUDE.md` — its containment is the branch-scoped push grant and `pr-reviewer` gating the merge, exactly as `builder`'s is.

- [ ] **Step 3: Write `agents/repair/prompt.md`**

Narrow: diagnose why a named agent is failing, make the smallest change that fixes it, open a PR. It must never widen a grant, a budget, or an `EXCLUDED_PATHS` entry — and it cannot, since `mergePR` refuses those paths regardless, but the prompt should say so rather than letting it waste a run discovering it.

- [ ] **Step 4: Make the routing actually reach it**

Whatever Step 1 established. At minimum, add a test proving a repair task routes to `repair` and not to a disabled `builder`.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add agents/repair src/control/dispatcher.ts tests/
git commit -m "feat: add a repair agent so a broken builder is not a dead end"
```

---

### Task C7: Let the allocation actually pause a phase of work

**Why:** `Strategy.allocation` — `{ research, build, maintain }`, validated to sum to 100 (Task C1) — is written by the overseer and **read by nothing**. It is the fourth "computed by something, consumed by nothing" instance in this codebase, and closing it is what makes the system's workload *phased* rather than continuous.

The system does not need every agent firing every day. There are weeks that are mostly research and weeks that are mostly building on research already done. Right now `opportunity-scout` fires at 06:00 daily regardless of whether the system has any capacity to act on another opportunity, and `improvement-scout` at 07:00 daily regardless of whether a build phase is even underway. That is wasted subscription capacity in one direction and starved capacity in the other.

This also changes the hosting-plan question materially: the sustained load of a phased system is far below that of a continuously-firing one, so measure the phased design before concluding a subscription tier is too small.

**Files:**
- Modify: `src/agent-schema.ts` — **read the note below before touching this file**
- Modify: `schema/capabilities.json` (regenerate with `npm run schema`)
- Modify: `src/triggers/cron.ts` and `tests/cron-trigger.test.ts`
- Modify: each cron agent's `agent.yaml` to declare its category

**Interfaces:**
- Consumes: `StrategyStore.latest()` (C1); `WorldModel` already threaded into `startCron` by Task B2b.
- Produces: `AgentDef.category?: "research" | "build" | "maintain"`, and a cron trigger that skips a firing whose category has zero allocation in the current strategy.

- [ ] **Step 1: Add `category` to the agent schema**

Optional, and only meaningful on `trigger.type: cron`. An agent with no `category` is never skipped — absent means "always runs", so this change cannot silently pause anything that does not opt in. Regenerate `schema/capabilities.json` with `npm run schema` in the same commit; the two are generated together and a drifted pair is its own bug.

`src/agent-schema.ts` is on `EXCLUDED_PATHS` — see the Global Constraints. An operator-directed session edits it normally; only the autonomous self-build pipeline must not.

- [ ] **Step 2: Write the failing test**

In `tests/cron-trigger.test.ts` (created by Task B2b — read it first, it already solves driving a cron job deterministically). Three cases:
- An agent whose category has zero allocation in the latest strategy does **not** run when its cron fires.
- The same agent **does** run when its category has non-zero allocation.
- An agent with **no** category always runs, whatever the allocation says.

- [ ] **Step 3: Run them and watch them fail, then implement**

In `src/triggers/cron.ts`, read `StrategyStore.latest()` inside the callback — not at schedule time, since the strategy changes weekly while the jobs are created once at boot. Zero allocation means skip and log why; anything non-zero means run on the agent's normal cadence. **No strategy yet, or an unreadable one, means run** — the same fail-open posture the world-model summary already takes there. A system that silently stops scheduling because the overseer has not run yet is worse than one that over-runs.

- [ ] **Step 4: Guard the overseer against pausing itself**

The overseer must never be skippable by this mechanism: it is the only thing that writes the allocation, so an allocation that paused it would be unrecoverable without operator intervention, forever. Give `agents/overseer/agent.yaml` no `category` (Step 1 makes that mean "always runs") **and** add an explicit test that the overseer runs under an all-zero allocation. Belt and braces, because the failure is permanent.

**Amended after C3 shipped:** C3 gave the overseer a bespoke trigger, `startOverseer` in `src/triggers/overseer.ts`, and `src/index.ts:429` filters it out of `startCron` entirely, so it is already structurally unreachable by this skip. That makes the guard stronger than planned, not weaker — but it moves where the test belongs. Put the all-zero-allocation test on `startOverseer`, asserting it fires regardless of what the strategy says, since that is the code path the overseer actually runs on. Do **not** add allocation-reading to `startOverseer` in order to then test skipping it. Keeping `agents/overseer/agent.yaml` uncategorised is still worth doing as the second belt.

The same reasoning applies to `setAgentEnabled` from Task C3 — **already done there**: `src/runner/sdk-runner.ts:956` refuses `agent: "overseer"` when `enabled: false`, and `tests/sdk-runner-world-tools.test.ts` covers both that refusal and the breaker reset on re-enable. Verify both still hold; add nothing if they do.

- [ ] **Step 5: Categorise the existing cron agents**

`opportunity-scout` → `research`. `improvement-scout` → `build`. `cleanup-scout` and `dependency-scout` → `maintain`. Leave `overseer` uncategorised per Step 4.

- [ ] **Step 6: Teach the overseer what allocation now does**

Update `agents/overseer/prompt.md`: allocation is no longer advisory prose, it gates whether whole categories of agent fire this cycle. Setting a category to 0 pauses it entirely until the next strategy. Say plainly that this is the intended way to run a research-heavy week followed by a build-heavy one, and that pausing everything is not a valid strategy.

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/agent-schema.ts schema/capabilities.json src/triggers/cron.ts tests/cron-trigger.test.ts agents/
git commit -m "feat: let the strategy's allocation pause a phase of work"
```

---

# Part D — Ship and operate

### Task D1: Design the path from repo to live service

**This task produces a design document, not code.** It is deliberately not specified as implementation steps, because the decisions it depends on have not been made and inventing steps for them would produce a plan that reads as authoritative while being guesswork.

**Why it matters more than anything else here:** the system can create repos in the AAS-Labs org, push branches, open PRs and merge them — and then it stops. There is no hosting, no domain, no deploy, no way to know whether a deployed thing is alive. `grants.yaml` contains **zero** `provision` grants, and the `provision` grant kind in `src/grants.ts` only classifies `npm publish` and `gh` commands. The primary goal in `goals.yaml` is therefore currently unreachable by construction, not merely difficult.

**What is already decided:**
- **Spending:** a dedicated prepaid card, operator-owned and KYC'd, auto-topup **off**, so the ceiling is enforced by the bank rather than by code. Documented at `.env.example` under `SPEND_*`.
- **Receiving:** the operator's merchant-of-record account, read via `REVENUE_API_TOKEN` / `REVENUE_API_BASE` and `revenue.provider` in `config.yaml`. **Set to `stripe`:** Stripe acquired Lemon Squeezy and new signups land on Stripe Managed Payments — Stripe's own dashboard and API (an ordinary secret key and the Charges API), not Lemon Squeezy's separate JSON:API. `StripeRevenueTransport` reads Charges, which is the same underlying object under classic Stripe and Managed Payments alike. `LemonSqueezyRevenueTransport` exists and is tested but is currently unused; it stays for an account that predates the acquisition.
- **Capability acquisition is in scope and should be as automated as possible** — the system may sign up for services itself. This replaces self-build's rule 3 (which requires a human to provision any new credential, `src/control/self-build-gate.ts:171-185`) with algorithmic checks instead.

**Open questions the design must answer:**
1. Where does a built product run? Same VPS, or a separate host per product? What deploys it?
2. How does a newly obtained API key become usable without a redeploy? There is no runtime secret store today; grants name env vars (`Grant.secret`), which are read at boot.
3. What replaces self-build rule 3? Sketch: a `provision` grant scoped by service pattern, plus the bank-enforced ceiling, plus `goals.yaml`'s `means` as standing policy on *how* to sign up. Needs to be made concrete.
4. **Deprovisioning.** Killing a product must cancel its services, or the spend continues under the ceiling forever. This is the failure mode most likely to survive every other guard in this plan.
5. Paying at a checkout needs browser capability, which is not built (see `.env.example`'s `SPEND_CARD_*` note and README's "Not built yet"). Is that in scope, or is the system limited to services with a payment API?

**Verified against the repo on 2026-09-01, after C6 shipped.** Three things the questions above do not reflect:

1. **A working unattended deploy path already exists — for this system.** `scripts/auto-deploy.sh`, `Dockerfile`'s `HEALTHCHECK` and `docker-compose.yml` already close the loop from "PR merged" to "live": fetch, fast-forward, `docker compose up --build -d`, poll Docker's health status, `git reset --hard` back to the previous commit if it does not go healthy within 90s, and a Discord line either way. `docs/decisions.md:88-118` records why it is host-side rather than an agent tool (mounting the Docker socket into an agent's container is close to host-root, for a step that needs no judgment) and why it is safe to run unattended. So question 1 is not "invent a deploy path", it is "generalise this one to a repo an agent wrote" — and the hard parts are specific:
   - a product's healthcheck is **agent-authored**, so `HEALTHCHECK CMD exit 0` silently defeats rollback. This system's own healthcheck is protected by `EXCLUDED_PATHS`; a product's cannot be.
   - one published port behind a tunnel is enough for a webhook receiver, not for N products on public URLs. Routing and DNS are genuinely unbuilt.
   - nothing feeds "is it actually up" back anywhere. `src/state/liveness.ts` is about stale metrics passes, not deployed products, and `PortfolioEntry` has no liveness field — so a `status: "live"` entry that has been 502ing for a week still reads as live to the overseer. This is the same "computed by something, consumed by nothing" shape as the five instances already closed in this plan, inverted: an observable fact with nothing observing it.

2. **`docs/decisions.md:31-40` contradicts this task's premise and must be resolved in the design, not footnoted.** It grounds the subscription-billing choice on "no user-facing product is planned", because Anthropic does not permit offering claude.ai login or rate limits to a third-party product's *end users* without prior approval. `goals.yaml`'s `means` forbid violating any service's terms, so a product that calls Claude on behalf of its own end users using the operator's subscription token is excluded by the goals themselves. The design must state plainly which path it takes: products that do not call Claude at all, or `ALLOW_API_BILLING=true` with API billing as a product cost line separate from the subscription. Silence is the failure mode here, because the obvious implementation is the forbidden one.

3. **Rule 3's replacement has a narrower job than it appears.** `evaluateSelfBuildChange`'s rule 3 (`src/control/self-build-gate.ts:171-185`) gates exactly one thing: a self-build PR that adds a grant naming an unprovisioned secret. It is not what stops the system signing up for a service — nothing does, because no agent has a tool that could. So "what replaces rule 3" is downstream of "what does provisioning look like at all", not a prerequisite for it.

**This is three designs, not one.** Recommended split and order:

- **D1a — the deploy path.** Repo → running service → public URL → liveness observed and written back into the portfolio. Needs no new credential, no new grant kind, and no capability the system lacks: it runs on the VPS that already exists, using the pattern that already works. Buildable immediately, and it is what makes the primary goal reachable at all rather than merely difficult.
- **D1b — provisioning and deprovisioning.** A `provision` grant scoped by service pattern, what replaces rule 3, the runtime secret store (a key obtained at runtime is worthless if it needs a redeploy, so the store belongs to this design rather than its own), the bank-enforced ceiling, and the kill → cancel-services path. The riskiest of the three, and the one whose failure mode — spend continuing forever under the ceiling on a killed product — survives every other guard in this plan.
- **D1c — paid checkouts that need a browser.** Last, and possibly never. It is the only one of the five open questions whose answer may legitimately be "out of scope", and D1b can ship restricted to services with a payment API.

Each sub-design gets its own spec, its own implementation plan, and its own execution pass. Do not brainstorm all three at once.

- [ ] **Step 1: Brainstorm D1a with `superpowers:brainstorming`, architectural path**

Do not skip to implementation. Read this whole task, `docs/decisions.md:88-118`, `scripts/auto-deploy.sh`, `docker-compose.yml`, `Dockerfile` and `src/world/world-model.ts` before the first question.

- [ ] **Step 2: Write the design to `docs/superpowers/specs/YYYY-MM-DD-deploy-path-design.md`**

- [ ] **Step 3: Write its implementation plan with `superpowers:writing-plans`, then execute it task-per-session as this plan was**

- [ ] **Step 4: Repeat Steps 1-3 for D1b, and decide whether D1c is in scope at all**

---

## Not in this plan, and why

- **A new idea supply.** The system's strategic ceiling is set by whatever proposes new revenue directions, which today is `opportunity-scout` — Haiku, `effort: low`, 15 turns, $0.50, one web search a day. No amount of good allocation fixes a weak idea supply, and this is the constraint most likely to bind after about six months. It is left out because the right fix depends on what the first few cycles actually produce, and guessing now would be premature. Revisit once three overseer cycles have been graded.
- **Editing `goals.yaml`.** Excluded permanently and deliberately. If its `means` constraints end up blocking every available path, the overseer reports that and stops — the one thing in this design that legitimately escalates to a human.
- **A skill library.** Already considered and rejected in [`2026-08-30-agent-loop-design.md`](../specs/2026-08-30-agent-loop-design.md); nothing here changes that reasoning.
