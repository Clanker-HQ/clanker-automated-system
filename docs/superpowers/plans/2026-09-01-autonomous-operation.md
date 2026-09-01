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

- [ ] **Step 1: Read the schema before writing the agent config**

`schema/capabilities.json` lists every legal value for `tier`, `approval`, and `permissions`. `src/registry.ts` rejects at boot any field the code cannot enforce. Confirm which `tier` permits `Write` with no grants before you write `agent.yaml` — do not assume.

- [ ] **Step 2: Write `agents/overseer/agent.yaml`**

`trigger.type: cron`, `schedule: "0 5 * * 1"` (Monday 05:00, one hour after the metrics pass at 04:00 so it reads a fresh snapshot), `timezone: Europe/Berlin`. `model: claude-sonnet-5`, `effort: high` — this is the one consequential judgment in the system and the one place not to economise. `maxTurns: 40`, `timeoutMinutes: 30`, `maxBudgetUsd: 3.00`. `grantRefs: []` — no outward reach at all. `outbox: { discord: ops, notifyOn: [success, failure] }`.

- [ ] **Step 3: Write `agents/overseer/prompt.md`**

It must state: what it reads (goals, world model, last strategy, verdicts, metrics); that its output is a strategy plus queued tasks and that it must **never** implement anything itself; that every expectation it records must be checkable by one of the three `Expectation.check` kinds in `src/world/strategy.ts`; that it must explain in `changeReason` why this cycle differs from the last; and that when a `means` constraint in `goals.yaml` blocks every available path, it must say so explicitly, because that is the one thing only the operator can resolve.

- [ ] **Step 4: Write the failing trigger test**

In `tests/overseer-trigger.test.ts`: assert `startOverseer` schedules on the configured cron and that a fire grades the previous cycle's expectations before the run starts, passing the verdicts into the prompt. Model the test on `tests/metrics-job.test.ts` and the existing trigger tests.

- [ ] **Step 5: Run it, watch it fail, implement `src/triggers/overseer.ts`**

Follow `src/triggers/metrics.ts` exactly — same croner options (`protect: true`), same boot log line, same `.catch` posture.

- [ ] **Step 6: Wire into `src/index.ts`**

Lazily imported and gated on a config flag, exactly like the metrics and reflection triggers.

- [ ] **Step 7: Verify and commit**

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

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run it, watch it fail, implement**

`EXPLORATION_INTERVAL = 5`. Persist the count of claims since the last exploration claim next to the other durable state, so a restart does not reset the floor.

- [ ] **Step 3: Thread `category` through `queueTask`**

Add it to the Zod schema as an optional field defaulting to `"exploitation"`, and document in the overseer's prompt that exploration work must be tagged as such.

- [ ] **Step 4: Verify and commit**

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
- Modify: `agents/overseer/prompt.md`

**Interfaces:**
- Consumes: `PortfolioEntry` from Task B1.
- Produces: `dueReviews(portfolio: PortfolioEntry[], now: Date): PortfolioEntry[]`, and `MAX_EXTENSIONS = 2`.

- [ ] **Step 1: Write the failing test**

Cover: an entry past `nextReviewAt` is returned; a future one is not; a `killed` entry is never returned however overdue; entries are returned most-overdue first.

- [ ] **Step 2: Run it, watch it fail, implement**

- [ ] **Step 3: Add the extension cap**

Add `extensionCount: number` to `PortfolioEntry` (default `0`) and a `canExtend(entry)` helper returning `entry.extensionCount < MAX_EXTENSIONS`. Update `tests/world-model.test.ts` for the new field.

- [ ] **Step 4: Update the overseer prompt**

Every due review ends in exactly one of: mark `killed` (and queue a deprovision task naming the product), or extend with a *new* bar, a *new* date, and an incremented `extensionCount` — and extending is refused once `canExtend` is false. State plainly that "give it more time" without a new bar is not an available answer.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/world/reviews.ts tests/reviews.test.ts src/world/world-model.ts tests/world-model.test.ts agents/overseer/prompt.md
git commit -m "feat: force a kill-or-justify decision on every portfolio review"
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

- [ ] **Step 1: Run the brainstorming skill on the questions above**

Use `superpowers:brainstorming`, architectural path. Do not skip to implementation.

- [ ] **Step 2: Write the design to `docs/superpowers/specs/YYYY-MM-DD-ship-and-operate-design.md`**

- [ ] **Step 3: Write its implementation plan with `superpowers:writing-plans`**

---

## Not in this plan, and why

- **A new idea supply.** The system's strategic ceiling is set by whatever proposes new revenue directions, which today is `opportunity-scout` — Haiku, `effort: low`, 15 turns, $0.50, one web search a day. No amount of good allocation fixes a weak idea supply, and this is the constraint most likely to bind after about six months. It is left out because the right fix depends on what the first few cycles actually produce, and guessing now would be premature. Revisit once three overseer cycles have been graded.
- **Editing `goals.yaml`.** Excluded permanently and deliberately. If its `means` constraints end up blocking every available path, the overseer reports that and stops — the one thing in this design that legitimately escalates to a human.
- **A skill library.** Already considered and rejected in [`2026-08-30-agent-loop-design.md`](../specs/2026-08-30-agent-loop-design.md); nothing here changes that reasoning.
