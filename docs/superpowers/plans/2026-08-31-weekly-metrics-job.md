# Weekly metrics job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the weekly deterministic metrics job named in subsystem 2's
build order step 3 — arithmetic over existing stores (`RunStore`,
`TaskStore`, `MemoryStore`, `RevenueTransport`) into
`data/state/metrics-<date>.json`, with the delta posted in the daily digest.
No LLM in the computation path.

**Architecture:** Five small pieces, each mirroring an already-established
pattern in this codebase: `src/state/metrics-store.ts` mirrors
`src/state/spend-store.ts`'s read/write-JSON shape (dated files instead of
one file, since metrics need history for a delta); `src/metrics.ts` mirrors
`src/spend/spend-accounting.ts`'s pure-function-plus-thin-I/O-wrapper split
(`computeMetrics` is pure, `runMetricsJob` gathers real data and persists
it); `src/triggers/metrics.ts` mirrors `src/triggers/reflection.ts`'s cron
wrapper (untested directly, same as `triggers/reflection.ts` and
`triggers/digest.ts` — the pure/I/O functions they call carry the test
coverage); `src/digest.ts` gains an optional metrics section, the same way
it already has an optional memory section; `src/config.ts` gains a
`MetricsSchema` mirroring `DigestSchema`.

**Tech Stack:** TypeScript, zod, `croner`, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-self-evaluation-design.md`
(read in full — "Metrics (system-owned, seeded not fixed)" and "Testing"
are what this plan implements; "Sequencing", build order step 3, is why
this is the next piece).

## Global Constraints

- No new npm dependencies. `croner` and `zod` are already dependencies.
- Every new/modified `.ts` file uses ESM `.js` import specifiers
  (`from "./foo.js"`), matching every existing file in `src/`.
- Money amounts are plain `number` (USD), matching the convention already
  set by `SpendState.balanceUsd` and `Sale.amountUsd` — the spec's own
  wording ("revenue per euro") is informal, not a currency requirement.
- **Scope ruling — three of the spec's named metrics are deferred, not
  built here, because no code anywhere in this repo currently produces the
  data they need:**
  - *Revenue per euro of external spend.* `recordSpend`
    (`src/spend/spend-accounting.ts`, already shipped) appends a memory
    record for every spend but never writes the amount into it — only
    `SpendStore`'s current balance is persisted, not a timestamped log of
    individual spends. There is no way to answer "how much was spent in the
    last 7 days" from what exists today without first adding that logging,
    which is its own small, separate change. Deferred.
  - *Funnel counts and time from prospect to first revenue
    (prospect → validated → built → shipped → earning).* No code
    anywhere tracks a proposal through named funnel stages — `MemoryKind`
    has exactly four values (`finding` / `proposal` / `outcome` /
    `reflection`), none of which map cleanly onto five funnel stages.
    Building this requires a real design decision (a new field? a new
    memory kind? a separate store?) that the spec does not resolve, and is
    not something to invent silently inside an implementation plan.
    Deferred.
  - *Rework rate (PRs bounced by `pr-reviewer`).* Nothing persists a
    `pr-reviewer` verdict anywhere — `agents/pr-reviewer` runs as an
    ordinary agent turn inside `mergePR`'s gate, and its outcome is never
    written to a store `grep`-able by this plan. Deferred.

  Every other named metric — net income, not-achieved rate per agent, cost
  per completed task, novelty share / suppression rate, queue starvation —
  **is** built here, from data that already exists. This mirrors the
  precedent already set by
  `docs/superpowers/plans/2026-08-31-goal-file-and-spend-accounting.md`,
  which deferred the real revenue transport out of its own scope for the
  same reason (nothing existed yet to build it against). Task 7 records
  this scoping in the spec's status line, same as that plan did.
- Every task: `npm test` and `npm run typecheck` must both pass before
  committing.
- Cited line numbers below are accurate as of this plan's writing but may
  drift — locate insertion points by matching the surrounding code shown,
  not by trusting the number alone.

---

### Task 1: MetricsStore — persisted metrics snapshots

**Files:**
- Create: `src/state/metrics-store.ts`
- Test: `tests/metrics-store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export interface NotAchievedByAgent { agent: string; rate: number; successRunCount: number }`, `export interface Metrics { computedAt: string; windowDays: number; netIncomeUsd: number; notAchievedRate: number | null; notAchievedByAgent: NotAchievedByAgent[]; costPerCompletedTaskUsd: number | null; noveltySharePercent: number | null; suppressedProposalCount: number; queueStarvationHours: number | null }`, `export class MetricsStore { constructor(dataDir: string); write(metrics: Metrics): Promise<void>; listAll(): Promise<Metrics[]>; latestTwo(): Promise<{ latest: Metrics | null; previous: Metrics | null }> }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/metrics-store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Metrics } from "../src/state/metrics-store.js";
import { MetricsStore } from "../src/state/metrics-store.js";

function makeStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-metrics-store-"));
  return { dataDir, store: new MetricsStore(dataDir) };
}

function metrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    computedAt: "2026-09-07T04:00:00.000Z",
    windowDays: 7,
    netIncomeUsd: 42,
    notAchievedRate: 0.1,
    notAchievedByAgent: [],
    costPerCompletedTaskUsd: 1.5,
    noveltySharePercent: 90,
    suppressedProposalCount: 1,
    queueStarvationHours: 2,
    ...overrides,
  };
}

describe("MetricsStore", () => {
  it("round-trips a written snapshot", async () => {
    const { dataDir, store } = makeStore();
    const m = metrics();
    await store.write(m);
    expect(await store.listAll()).toEqual([m]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns an empty list when nothing has been written yet", async () => {
    const { dataDir, store } = makeStore();
    expect(await store.listAll()).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("lists multiple snapshots oldest first, regardless of write order", async () => {
    const { dataDir, store } = makeStore();
    const later = metrics({ computedAt: "2026-09-14T04:00:00.000Z", netIncomeUsd: 100 });
    const earlier = metrics({ computedAt: "2026-09-07T04:00:00.000Z", netIncomeUsd: 42 });
    await store.write(later);
    await store.write(earlier);
    expect((await store.listAll()).map((m) => m.computedAt)).toEqual([earlier.computedAt, later.computedAt]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("overwrites rather than duplicates when two snapshots share the same date", async () => {
    const { dataDir, store } = makeStore();
    await store.write(metrics({ computedAt: "2026-09-07T04:00:00.000Z", netIncomeUsd: 1 }));
    await store.write(metrics({ computedAt: "2026-09-07T09:00:00.000Z", netIncomeUsd: 2 }));
    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.netIncomeUsd).toBe(2);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("latestTwo returns nulls when nothing has been written", async () => {
    const { dataDir, store } = makeStore();
    expect(await store.latestTwo()).toEqual({ latest: null, previous: null });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("latestTwo returns a null previous when only one snapshot exists", async () => {
    const { dataDir, store } = makeStore();
    const only = metrics({ computedAt: "2026-09-07T04:00:00.000Z" });
    await store.write(only);
    expect(await store.latestTwo()).toEqual({ latest: only, previous: null });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("latestTwo returns the two most recent snapshots when three or more exist", async () => {
    const { dataDir, store } = makeStore();
    const first = metrics({ computedAt: "2026-08-24T04:00:00.000Z", netIncomeUsd: 1 });
    const second = metrics({ computedAt: "2026-08-31T04:00:00.000Z", netIncomeUsd: 2 });
    const third = metrics({ computedAt: "2026-09-07T04:00:00.000Z", netIncomeUsd: 3 });
    await store.write(first);
    await store.write(second);
    await store.write(third);
    expect(await store.latestTwo()).toEqual({ latest: third, previous: second });
    rmSync(dataDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- metrics-store`
Expected: FAIL — `Cannot find module '../src/state/metrics-store.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/state/metrics-store.ts
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface NotAchievedByAgent {
  agent: string;
  /** 0-1. */
  rate: number;
  successRunCount: number;
}

export interface Metrics {
  computedAt: string;
  windowDays: number;
  netIncomeUsd: number;
  /** null when no run graded "success" fell in the window — the rate has no denominator. */
  notAchievedRate: number | null;
  notAchievedByAgent: NotAchievedByAgent[];
  /** null when no task finished "done" in the window. */
  costPerCompletedTaskUsd: number | null;
  /** null when no proposal was attempted in the window. */
  noveltySharePercent: number | null;
  suppressedProposalCount: number;
  /** null when no task is currently pending. */
  queueStarvationHours: number | null;
}

const FILENAME = /^metrics-\d{4}-\d{2}-\d{2}\.json$/;

/**
 * One file per calendar date (UTC, taken from `computedAt`), not one file
 * overwritten in place like SpendStore — a delta needs history, and the
 * weekly cadence means one file per run is naturally bounded (retention is
 * out of scope for this plan; nothing here prunes old snapshots).
 */
export class MetricsStore {
  constructor(private readonly dataDir: string) {}

  private dir(): string {
    return join(this.dataDir, "state");
  }

  private path(dateStamp: string): string {
    return join(this.dir(), `metrics-${dateStamp}.json`);
  }

  async write(metrics: Metrics): Promise<void> {
    await mkdir(this.dir(), { recursive: true });
    const dateStamp = metrics.computedAt.slice(0, 10);
    await writeFile(this.path(dateStamp), JSON.stringify(metrics, null, 2) + "\n");
  }

  /** Every persisted snapshot, oldest first. */
  async listAll(): Promise<Metrics[]> {
    const names = await readdir(this.dir()).catch(() => [] as string[]);
    const all: Metrics[] = [];
    for (const name of names.filter((n) => FILENAME.test(n))) {
      all.push(JSON.parse(await readFile(join(this.dir(), name), "utf8")) as Metrics);
    }
    all.sort((a, b) => (a.computedAt < b.computedAt ? -1 : a.computedAt > b.computedAt ? 1 : 0));
    return all;
  }

  /** The most recent snapshot and the one before it. Either or both are null when fewer exist. */
  async latestTwo(): Promise<{ latest: Metrics | null; previous: Metrics | null }> {
    const all = await this.listAll();
    return { latest: all[all.length - 1] ?? null, previous: all[all.length - 2] ?? null };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- metrics-store`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/state/metrics-store.ts tests/metrics-store.test.ts
git commit -m "feat: add MetricsStore for persisted weekly metrics snapshots"
```

---

### Task 2: computeMetrics — pure metric arithmetic

**Files:**
- Create: `src/metrics.ts`
- Test: `tests/metrics.test.ts`

**Interfaces:**
- Consumes: `Metrics`, `NotAchievedByAgent` from `./state/metrics-store.js` (Task 1); `RunResult` from `./run-store.js` (existing); `Task` from `./control/task-store.js` (existing); `MemoryRecord` from `./memory/types.js` (existing); `Sale` from `./control/revenue-transport.js` (existing).
- Produces: `export interface ComputeMetricsInput { computedAt: Date; windowDays: number; runsInWindow: RunResult[]; memoryRecordsInWindow: MemoryRecord[]; salesInWindow: Sale[]; doneTasksInWindow: Task[]; pendingTasksNow: Task[] }`, `export function computeMetrics(input: ComputeMetricsInput): Metrics`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/metrics.test.ts
import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/metrics.js";
import type { RunResult } from "../src/run-store.js";
import type { Task } from "../src/control/task-store.js";
import type { MemoryRecord } from "../src/memory/types.js";
import type { Sale } from "../src/control/revenue-transport.js";

const COMPUTED_AT = new Date("2026-09-07T04:00:00.000Z");

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: "r1", agent: "builder", status: "success",
    startedAt: "2026-09-05T00:00:00.000Z", endedAt: "2026-09-05T00:01:00.000Z",
    durationMs: 60_000, costUsd: 1, inputTokens: 1, outputTokens: 1, turns: 1,
    summary: "", ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1", text: "do a thing", priority: 50, status: "done",
    createdBy: "system", createdAt: "2026-09-01T00:00:00.000Z", ...overrides,
  };
}

function memoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1", ts: "2026-09-05T00:00:00.000Z", domain: "revenue", kind: "proposal",
    subject: "a proposal", body: "do the thing", importance: 5, createdBy: "system",
    chainDepth: 0, ...overrides,
  };
}

function sale(overrides: Partial<Sale> = {}): Sale {
  return { id: "s1", product: "widget", timestampIso: "2026-09-05T00:00:00.000Z", amountUsd: 10, ...overrides };
}

function baseInput() {
  return {
    computedAt: COMPUTED_AT, windowDays: 7,
    runsInWindow: [] as RunResult[], memoryRecordsInWindow: [] as MemoryRecord[],
    salesInWindow: [] as Sale[], doneTasksInWindow: [] as Task[], pendingTasksNow: [] as Task[],
  };
}

describe("computeMetrics", () => {
  it("sums sale amounts into netIncomeUsd, zero when there are none", () => {
    expect(computeMetrics(baseInput()).netIncomeUsd).toBe(0);
    const withSales = computeMetrics({ ...baseInput(), salesInWindow: [sale({ amountUsd: 10 }), sale({ id: "s2", amountUsd: 5 })] });
    expect(withSales.netIncomeUsd).toBe(15);
  });

  it("computes an overall not-achieved rate across success runs only", () => {
    const runs = [
      run({ runId: "r1", agent: "builder", verifiedOutcome: { verdict: "not-achieved", reason: "x" } }),
      run({ runId: "r2", agent: "builder", verifiedOutcome: { verdict: "achieved", reason: "x" } }),
      run({ runId: "r3", agent: "builder", status: "failed", verifiedOutcome: undefined }),
    ];
    const result = computeMetrics({ ...baseInput(), runsInWindow: runs });
    // Only the two "success" runs count: 1 of 2 not-achieved.
    expect(result.notAchievedRate).toBe(0.5);
  });

  it("returns a null not-achieved rate when there are no success runs in the window", () => {
    const result = computeMetrics({ ...baseInput(), runsInWindow: [run({ status: "failed", verifiedOutcome: undefined })] });
    expect(result.notAchievedRate).toBeNull();
  });

  it("breaks the not-achieved rate down per agent, sorted by agent name, excluding agents with no success runs", () => {
    const runs = [
      run({ runId: "r1", agent: "builder", verifiedOutcome: { verdict: "not-achieved", reason: "x" } }),
      run({ runId: "r2", agent: "builder", verifiedOutcome: { verdict: "achieved", reason: "x" } }),
      run({ runId: "r3", agent: "researcher", verifiedOutcome: { verdict: "achieved", reason: "x" } }),
      run({ runId: "r4", agent: "researcher", status: "failed", verifiedOutcome: undefined }),
    ];
    const result = computeMetrics({ ...baseInput(), runsInWindow: runs });
    expect(result.notAchievedByAgent).toEqual([
      { agent: "builder", rate: 0.5, successRunCount: 2 },
      { agent: "researcher", rate: 0, successRunCount: 1 },
    ]);
  });

  it("computes cost per completed task as total run cost over the window divided by done-task count", () => {
    const runs = [run({ runId: "r1", costUsd: 4 }), run({ runId: "r2", costUsd: 6 })];
    const done = [task({ id: "t1" }), task({ id: "t2" })];
    const result = computeMetrics({ ...baseInput(), runsInWindow: runs, doneTasksInWindow: done });
    expect(result.costPerCompletedTaskUsd).toBe(5);
  });

  it("returns a null cost per completed task when no task finished in the window", () => {
    const result = computeMetrics({ ...baseInput(), runsInWindow: [run({ costUsd: 4 })] });
    expect(result.costPerCompletedTaskUsd).toBeNull();
  });

  it("computes novelty share and suppressed count from proposal records only", () => {
    const records = [
      memoryRecord({ id: "m1", kind: "proposal", body: "build a widget" }),
      memoryRecord({ id: "m2", kind: "proposal", body: "suppressed as a duplicate of m1" }),
      memoryRecord({ id: "m3", kind: "finding", body: "irrelevant, not a proposal" }),
    ];
    const result = computeMetrics({ ...baseInput(), memoryRecordsInWindow: records });
    expect(result.suppressedProposalCount).toBe(1);
    expect(result.noveltySharePercent).toBe(50);
  });

  it("returns a null novelty share when no proposal was attempted in the window", () => {
    const result = computeMetrics({ ...baseInput(), memoryRecordsInWindow: [memoryRecord({ kind: "finding" })] });
    expect(result.noveltySharePercent).toBeNull();
    expect(result.suppressedProposalCount).toBe(0);
  });

  it("computes queue starvation from the oldest pending task's age, ignoring newer pending tasks", () => {
    const pending = [
      task({ id: "t1", status: "pending", createdAt: "2026-09-06T04:00:00.000Z" }), // 24h before computedAt
      task({ id: "t2", status: "pending", createdAt: "2026-09-05T04:00:00.000Z" }), // 48h before computedAt — oldest
    ];
    const result = computeMetrics({ ...baseInput(), pendingTasksNow: pending });
    expect(result.queueStarvationHours).toBe(48);
  });

  it("returns a null queue starvation when nothing is pending", () => {
    expect(computeMetrics(baseInput()).queueStarvationHours).toBeNull();
  });

  it("stamps computedAt and windowDays straight through from the input", () => {
    const result = computeMetrics({ ...baseInput(), windowDays: 14 });
    expect(result.computedAt).toBe(COMPUTED_AT.toISOString());
    expect(result.windowDays).toBe(14);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- metrics.test`
Expected: FAIL — `Cannot find module '../src/metrics.js'`. (Use `metrics.test` rather than `metrics` so vitest's filter does not also pick up `tests/metrics-store.test.ts`.)

- [ ] **Step 3: Write the implementation**

```ts
// src/metrics.ts
import type { Sale } from "./control/revenue-transport.js";
import type { Task } from "./control/task-store.js";
import type { MemoryRecord } from "./memory/types.js";
import type { RunResult } from "./run-store.js";
import type { Metrics, NotAchievedByAgent } from "./state/metrics-store.js";

export interface ComputeMetricsInput {
  computedAt: Date;
  windowDays: number;
  /** Every run with startedAt in the window — already filtered by the caller. */
  runsInWindow: RunResult[];
  /** Every memory record with ts in the window — already filtered by the caller. */
  memoryRecordsInWindow: MemoryRecord[];
  /** Every completed sale in the window — already filtered by the caller (RevenueTransport.listSales does this itself). */
  salesInWindow: Sale[];
  /** Tasks with status "done" and finishedAt in the window — already filtered by the caller. */
  doneTasksInWindow: Task[];
  /**
   * Tasks with status "pending" right now — NOT windowed. A stale task
   * started starving long before this window began; the caller passes a
   * live snapshot, not a time-bounded slice.
   */
  pendingTasksNow: Task[];
}

const HOUR_MS = 60 * 60 * 1000;
const SUPPRESSED_PREFIX = "suppressed as a duplicate";

/**
 * Pure arithmetic over already-gathered data — no I/O, no LLM. See
 * docs/superpowers/specs/2026-08-30-self-evaluation-design.md, "Metrics
 * (system-owned, seeded not fixed)". runMetricsJob (below) is the thin I/O
 * wrapper that gathers the real inputs and persists the result.
 */
export function computeMetrics(input: ComputeMetricsInput): Metrics {
  const netIncomeUsd = input.salesInWindow.reduce((sum, s) => sum + s.amountUsd, 0);

  const successRuns = input.runsInWindow.filter((r) => r.status === "success");
  const notAchievedRuns = successRuns.filter((r) => r.verifiedOutcome?.verdict === "not-achieved");
  const notAchievedRate = successRuns.length === 0 ? null : notAchievedRuns.length / successRuns.length;

  const byAgent = new Map<string, { success: number; notAchieved: number }>();
  for (const r of successRuns) {
    const entry = byAgent.get(r.agent) ?? { success: 0, notAchieved: 0 };
    entry.success += 1;
    if (r.verifiedOutcome?.verdict === "not-achieved") entry.notAchieved += 1;
    byAgent.set(r.agent, entry);
  }
  const notAchievedByAgent: NotAchievedByAgent[] = [...byAgent.entries()]
    .map(([agent, e]) => ({ agent, rate: e.notAchieved / e.success, successRunCount: e.success }))
    .sort((a, b) => a.agent.localeCompare(b.agent));

  const totalRunCostUsd = input.runsInWindow.reduce((sum, r) => sum + r.costUsd, 0);
  const costPerCompletedTaskUsd = input.doneTasksInWindow.length === 0 ? null : totalRunCostUsd / input.doneTasksInWindow.length;

  const proposals = input.memoryRecordsInWindow.filter((r) => r.kind === "proposal");
  const suppressedProposalCount = proposals.filter((r) => r.body.startsWith(SUPPRESSED_PREFIX)).length;
  const noveltySharePercent =
    proposals.length === 0 ? null : ((proposals.length - suppressedProposalCount) / proposals.length) * 100;

  const queueStarvationHours =
    input.pendingTasksNow.length === 0
      ? null
      : (input.computedAt.getTime() - Math.min(...input.pendingTasksNow.map((t) => new Date(t.createdAt).getTime()))) / HOUR_MS;

  return {
    computedAt: input.computedAt.toISOString(),
    windowDays: input.windowDays,
    netIncomeUsd,
    notAchievedRate,
    notAchievedByAgent,
    costPerCompletedTaskUsd,
    noveltySharePercent,
    suppressedProposalCount,
    queueStarvationHours,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- metrics.test`
Expected: PASS, all 11 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/metrics.ts tests/metrics.test.ts
git commit -m "feat: add computeMetrics, pure arithmetic over runs/tasks/memory/sales"
```

---

### Task 3: runMetricsJob — gather real data and persist a snapshot

**Files:**
- Modify: `src/metrics.ts`
- Test: `tests/metrics-job.test.ts`

**Interfaces:**
- Consumes: `computeMetrics` (Task 2, same file); `RunStore` from `./run-store.js`; `TaskStore` from `./control/task-store.js`; `MemoryStore` from `./memory/memory-store.js`; `RevenueTransport` from `./control/revenue-transport.js`; `MetricsStore` from `./state/metrics-store.js` (all existing/Task 1).
- Produces: `export interface MetricsJobDeps { runStore: RunStore; taskStore: TaskStore; memory: MemoryStore; revenue: RevenueTransport; metricsStore: MetricsStore; windowDays: number; now?: Date }`, `export async function runMetricsJob(deps: MetricsJobDeps): Promise<Metrics>`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/metrics-job.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMetricsJob } from "../src/metrics.js";
import { FakeRevenueTransport } from "../src/control/revenue-transport.js";
import { TaskStore } from "../src/control/task-store.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { RunStore, newRunId } from "../src/run-store.js";
import { MetricsStore } from "../src/state/metrics-store.js";

function fixtures() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-metrics-job-"));
  return {
    dataDir,
    runStore: new RunStore(dataDir),
    taskStore: new TaskStore(dataDir),
    memory: new MemoryStore(dataDir),
    revenue: new FakeRevenueTransport(),
    metricsStore: new MetricsStore(dataDir),
  };
}

/** Mirrors tests/digest.test.ts's recordRun helper: RunWriter.close() stamps startedAt from the real clock. */
async function recordRun(store: RunStore, at: Date, agent: string, costUsd: number) {
  const writer = await store.open(newRunId(agent, at), agent);
  await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, costUsd, durationMs: 1 });
  await writer.close({ status: "success", summary: "" });
}

const NOW = new Date("2026-09-07T04:00:00.000Z");
const WITHIN_WINDOW = new Date("2026-09-05T00:00:00.000Z");
const BEFORE_WINDOW = new Date("2026-08-01T00:00:00.000Z");

describe("runMetricsJob", () => {
  it("gathers data from every store and the revenue transport, computes and persists one snapshot", async () => {
    const f = fixtures();
    await recordRun(f.runStore, WITHIN_WINDOW, "builder", 3);
    const created = await f.taskStore.create({ text: "ship it", createdBy: "system" });
    await f.taskStore.update(created.id, {
      status: "done", finishedAt: WITHIN_WINDOW.toISOString(), result: { summary: "done", path: "x" },
    });
    await f.memory.append({ domain: "revenue", kind: "proposal", subject: "sell widgets", body: "a proposal", importance: 5, createdBy: "system" });
    f.revenue.seedSale({ id: "s1", product: "widget", timestampIso: WITHIN_WINDOW.toISOString(), amountUsd: 20 });

    const metrics = await runMetricsJob({
      runStore: f.runStore, taskStore: f.taskStore, memory: f.memory,
      revenue: f.revenue, metricsStore: f.metricsStore, windowDays: 7, now: NOW,
    });

    expect(metrics.netIncomeUsd).toBe(20);
    expect(metrics.computedAt).toBe(NOW.toISOString());
    const persisted = await f.metricsStore.listAll();
    expect(persisted).toEqual([metrics]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("excludes runs, memory records, and done tasks outside the window, but still counts a stale pending task", async () => {
    const f = fixtures();
    await recordRun(f.runStore, BEFORE_WINDOW, "builder", 100);
    await recordRun(f.runStore, WITHIN_WINDOW, "builder", 1);
    await f.memory.append({ ts: BEFORE_WINDOW.toISOString(), domain: "revenue", kind: "proposal", subject: "old", body: "old proposal", importance: 1, createdBy: "system" });
    // A task still "pending" from well before the window — starvation must see it regardless.
    await f.taskStore.create({ text: "still waiting", createdBy: "system" });

    const metrics = await runMetricsJob({
      runStore: f.runStore, taskStore: f.taskStore, memory: f.memory,
      revenue: f.revenue, metricsStore: f.metricsStore, windowDays: 7, now: NOW,
    });

    // Only the in-window run's $1 counts toward cost — but there's no done
    // task in-window either, so costPerCompletedTaskUsd is still null; the
    // real assertion here is on queue starvation seeing the old pending task.
    expect(metrics.costPerCompletedTaskUsd).toBeNull();
    expect(metrics.queueStarvationHours).not.toBeNull();
    expect(metrics.queueStarvationHours).toBeGreaterThan(24 * 30);
    rmSync(f.dataDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- metrics-job`
Expected: FAIL — `runMetricsJob` is not exported yet.

- [ ] **Step 3: Extend the implementation**

Append to `src/metrics.ts` (after `computeMetrics`), and add these imports
to the top of the file alongside the existing type-only imports:

```ts
import type { RevenueTransport } from "./control/revenue-transport.js";
import type { TaskStore } from "./control/task-store.js";
import type { MemoryStore } from "./memory/memory-store.js";
import type { RunStore } from "./run-store.js";
import type { MetricsStore } from "./state/metrics-store.js";
```

```ts
export interface MetricsJobDeps {
  runStore: RunStore;
  taskStore: TaskStore;
  memory: MemoryStore;
  revenue: RevenueTransport;
  metricsStore: MetricsStore;
  windowDays: number;
  now?: Date;
}

/**
 * The one place that gathers real data from every store and the revenue
 * transport, computes a snapshot, and persists it. Kept thin and
 * deliberately not unit-tested for every metric formula — computeMetrics
 * above already owns that; this function's own tests only prove the wiring
 * (right store, right window) is correct.
 */
export async function runMetricsJob(deps: MetricsJobDeps): Promise<Metrics> {
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - deps.windowDays * 24 * 60 * 60 * 1000);

  const [runsInWindow, allTasks, allMemory, salesInWindow] = await Promise.all([
    deps.runStore.listSince(since, now),
    deps.taskStore.list(),
    deps.memory.list(),
    deps.revenue.listSales(since.toISOString()),
  ]);

  const memoryRecordsInWindow = allMemory.filter((r) => new Date(r.ts) >= since && new Date(r.ts) <= now);
  const doneTasksInWindow = allTasks.filter(
    (t) => t.status === "done" && t.finishedAt !== undefined && new Date(t.finishedAt) >= since && new Date(t.finishedAt) <= now,
  );
  const pendingTasksNow = allTasks.filter((t) => t.status === "pending");

  const metrics = computeMetrics({
    computedAt: now,
    windowDays: deps.windowDays,
    runsInWindow,
    memoryRecordsInWindow,
    salesInWindow,
    doneTasksInWindow,
    pendingTasksNow,
  });

  await deps.metricsStore.write(metrics);
  return metrics;
}
```

Also add `import type { Metrics } from "./state/metrics-store.js";` if not
already present from Task 2 (it is — Task 2 already imports `Metrics` and
`NotAchievedByAgent` from the same module).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- metrics-job`
Expected: PASS, both tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/metrics.ts tests/metrics-job.test.ts
git commit -m "feat: add runMetricsJob, gathering real data into a persisted snapshot"
```

---

### Task 4: `metrics` config block

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Consumes: `IanaTimezone`, `validateCronSchedule` (both already private to `src/config.ts`).
- Produces: `export const MetricsSchema`, `export type MetricsConfig = z.infer<typeof MetricsSchema>`; `ConfigSchema` gains a `metrics: MetricsSchema.prefault({})` field.

- [ ] **Step 1: Write the failing tests**

Add to `tests/config.test.ts`, near the existing digest tests:

```ts
  it("defaults metrics to enabled, Monday 04:00 UTC, a 7-day window, when absent", () => {
    const config = parseConfig("config.yaml", VALID);
    expect(config.metrics).toEqual({ enabled: true, schedule: "0 4 * * 1", timezone: "UTC", windowDays: 7 });
  });

  it("honours an explicit metrics block", () => {
    const yaml = VALID + '\nmetrics:\n  enabled: false\n  schedule: "0 5 * * 1"\n  timezone: Europe/Berlin\n  windowDays: 14\n';
    const config = parseConfig("config.yaml", yaml);
    expect(config.metrics).toEqual({ enabled: false, schedule: "0 5 * * 1", timezone: "Europe/Berlin", windowDays: 14 });
  });

  it("rejects a non-canonical metrics timezone the same way digest does", () => {
    const yaml = VALID + "\nmetrics:\n  timezone: PST\n";
    expect(() => parseConfig("config.yaml", yaml)).toThrow(/metrics\.timezone.*IANA/s);
  });

  it("rejects an invalid metrics.schedule cron expression, naming the field and the value", () => {
    const yaml = VALID + '\nmetrics:\n  schedule: "not a cron expression"\n';
    try {
      parseConfig("config.yaml", yaml);
      expect.fail("expected parseConfig to throw");
    } catch (err) {
      const message = (err as ValidationError).message;
      expect(message).toContain("metrics.schedule");
      expect(message).toContain("not a cron expression");
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- config`
Expected: FAIL — `config.metrics` is `undefined` (the new field doesn't exist yet), and the timezone/cron rejection tests fail because there is no `metrics` key for zod to validate at all (unrecognised keys are simply ignored by a non-`.strict()` outer default, but `ConfigSchema` is `.strict()` — an unknown `metrics:` block will actually throw "Unrecognized key" instead, which is still a failure, just not the one being asserted; either way the test fails).

- [ ] **Step 3: Write the implementation**

In `src/config.ts`, add `MetricsSchema` right after `RetentionSchema` (before `MemorySchema`):

```ts
export const MetricsSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Weekly, Monday 04:00 by default — one hour after reflection's Monday
    // 03:00 (MemorySchema.reflectionSchedule below), so the two weekly
    // passes never tick at the same instant.
    schedule: z.string().default("0 4 * * 1"),
    timezone: IanaTimezone.default("UTC"),
    /** How far back each snapshot's window reaches. */
    windowDays: z.number().int().positive().default(7),
  })
  .strict()
  .superRefine(validateCronSchedule);
```

Then add `metrics: MetricsSchema.prefault({}),` to `ConfigSchema`, right
after `retention: RetentionSchema.prefault({}),`:

```ts
export const ConfigSchema = z
  .object({
    governor: GovernorSchema.prefault({}),
    discord: z
      .object({
        channels: z.record(z.string(), z.string()).default({}),
        botChannels: z.record(z.string(), z.string()).default({}).prefault({}),
      })
      .strict()
      .prefault({}),
    digest: DigestSchema.prefault({}),
    retention: RetentionSchema.prefault({}),
    metrics: MetricsSchema.prefault({}),
    memory: MemorySchema.prefault({}),
  })
  .strict();
```

And add the exported type next to the others:

```ts
export type MetricsConfig = z.infer<typeof MetricsSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- config`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add the metrics config block"
```

---

### Task 5: Digest integration — post the metrics delta

**Files:**
- Modify: `src/digest.ts`
- Modify: `tests/digest.test.ts`

**Interfaces:**
- Consumes: `MetricsStore`, `Metrics` from `./state/metrics-store.js` (Task 1).
- Produces: `buildDigestText`'s `opts` gains an optional `metricsStore?: MetricsStore`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/digest.test.ts`. First, change the file's existing
`import { mkdtempSync } from "node:fs";` line to also bring in `rmSync`
(the new tests below clean up their own temp dirs, unlike the file's
existing tests which never create one):

```ts
import { mkdtempSync, rmSync } from "node:fs";
```

Then add two more imports near the top:

```ts
import type { Metrics } from "../src/state/metrics-store.js";
import { MetricsStore } from "../src/state/metrics-store.js";
```

Then add a new `describe` block (the existing `SINCE`/`WITHIN_WINDOW`/
`BEFORE_WINDOW` constants and `stores()`/`recordRun()` helpers are already in this file and
apply unchanged):

```ts
function metricsSnapshot(overrides: Partial<Metrics> = {}): Metrics {
  return {
    computedAt: WITHIN_WINDOW.toISOString(),
    windowDays: 7,
    netIncomeUsd: 42,
    notAchievedRate: 0.1,
    notAchievedByAgent: [],
    costPerCompletedTaskUsd: 1.5,
    noveltySharePercent: 90,
    suppressedProposalCount: 1,
    queueStarvationHours: 2,
    ...overrides,
  };
}

describe("buildDigestText — metrics section", () => {
  it("includes a fresh snapshot's net income when one landed within the digest window", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(metricsSnapshot({ netIncomeUsd: 42 }));

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).toContain("$42.00 net income");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("shows the delta against the previous snapshot when one exists", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(metricsSnapshot({ computedAt: BEFORE_WINDOW.toISOString(), netIncomeUsd: 30 }));
    await metricsStore.write(metricsSnapshot({ computedAt: WITHIN_WINDOW.toISOString(), netIncomeUsd: 42 }));

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).toContain("+$12.00");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("omits the metrics section when the latest snapshot predates the digest window", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(metricsSnapshot({ computedAt: BEFORE_WINDOW.toISOString() }));

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).not.toContain("net income");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("omits the metrics section entirely when no metricsStore is passed", async () => {
    const { store, tasks } = stores();
    await recordRun(store, WITHIN_WINDOW, "success", 1);

    const text = await buildDigestText({ store, tasks, since: SINCE });

    expect(text).not.toContain("net income");
  });

  it("treats a fresh metrics snapshot as activity, not returning the empty-digest message, even with no runs or tasks", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(metricsSnapshot());

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).not.toBe("📅 Daily digest: nothing happened in the last 24h.");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("handles null-valued metric fields without printing 'null' or 'NaN'", async () => {
    const { store, tasks } = stores();
    const dataDir = mkdtempSync(join(tmpdir(), "cai-digest-metrics-"));
    const metricsStore = new MetricsStore(dataDir);
    await metricsStore.write(
      metricsSnapshot({ notAchievedRate: null, costPerCompletedTaskUsd: null, noveltySharePercent: null, queueStarvationHours: null }),
    );

    const text = await buildDigestText({ store, tasks, since: SINCE, metricsStore });

    expect(text).not.toContain("null");
    expect(text).not.toContain("NaN");
    rmSync(dataDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- digest`
Expected: FAIL — `buildDigestText`'s options type has no `metricsStore` field, and none of the assertions about "net income" text can pass yet.

- [ ] **Step 3: Extend the implementation**

In `src/digest.ts`, add an import and a `metricsStore` option, then move
the empty-digest early return so a fresh metrics snapshot also counts as
activity, and append the metrics line when one applies.

Add to the imports at the top:

```ts
import type { Metrics, MetricsStore } from "./state/metrics-store.js";
```

Add `metricsStore?: MetricsStore;` to `buildDigestText`'s `opts` parameter,
right after `memoryConfig?: MemoryConfig;`.

Immediately after the existing `notAchieved` computation (right after the
line `const notAchieved = recentRuns.filter(...).length;`), add:

```ts
  const freshMetrics = opts.metricsStore ? await opts.metricsStore.latestTwo() : null;
  const hasFreshMetrics = freshMetrics?.latest !== null && freshMetrics?.latest !== undefined && new Date(freshMetrics.latest.computedAt) >= opts.since;
```

Change the existing early-return condition from:

```ts
  if (recentRuns.length === 0 && finishedTasks.length === 0 && waitingTasks.length === 0) {
    return "📅 Daily digest: nothing happened in the last 24h.";
  }
```

to:

```ts
  if (recentRuns.length === 0 && finishedTasks.length === 0 && waitingTasks.length === 0 && !hasFreshMetrics) {
    return "📅 Daily digest: nothing happened in the last 24h.";
  }
```

(Note: `finishedTasks` is computed between the `notAchieved` line and this
early return in the existing file — `freshMetrics`/`hasFreshMetrics` above
must be inserted before this `if`, after `finishedTasks` is computed, so
place it directly above the `if` rather than immediately after
`notAchieved` if that reads more naturally; either position works as long
as both are defined before the `if`.)

Finally, right before the function's final `return lines.join("\n");`, add:

```ts
  if (hasFreshMetrics && freshMetrics?.latest) {
    lines.push(formatMetricsLine(freshMetrics.latest, freshMetrics.previous));
  }
```

And add this helper function below `buildDigestText` (after its closing
brace, still in `src/digest.ts`):

```ts
function formatMetricsLine(latest: Metrics, previous: Metrics | null): string {
  const revenueDelta = previous
    ? ` (${latest.netIncomeUsd - previous.netIncomeUsd >= 0 ? "+" : ""}$${(latest.netIncomeUsd - previous.netIncomeUsd).toFixed(2)} vs prior snapshot)`
    : "";
  const parts = [`📊 **Weekly metrics** (${latest.windowDays}d window): $${latest.netIncomeUsd.toFixed(2)} net income${revenueDelta}`];
  if (latest.notAchievedRate !== null) parts.push(`${(latest.notAchievedRate * 100).toFixed(0)}% not-achieved`);
  if (latest.costPerCompletedTaskUsd !== null) parts.push(`$${latest.costPerCompletedTaskUsd.toFixed(2)}/completed task`);
  if (latest.noveltySharePercent !== null) {
    parts.push(`${latest.noveltySharePercent.toFixed(0)}% novel${latest.suppressedProposalCount > 0 ? ` (${latest.suppressedProposalCount} suppressed)` : ""}`);
  }
  if (latest.queueStarvationHours !== null) parts.push(`queue starvation ${latest.queueStarvationHours.toFixed(1)}h`);
  return parts.join(" — ");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- digest`
Expected: PASS — every existing digest test (none of which pass
`metricsStore`) continues to pass unchanged, plus the 6 new tests above.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/digest.ts tests/digest.test.ts
git commit -m "feat: post the weekly metrics delta in the daily digest"
```

---

### Task 6: Wire the metrics job — trigger and boot

**Files:**
- Create: `src/triggers/metrics.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `runMetricsJob` (Task 3), `MetricsStore` (Task 1), `RevenueTransport`/`FakeRevenueTransport` (existing), `StripeRevenueTransport` (existing, `src/control/stripe-revenue-transport.ts`), `config.metrics` (Task 4).
- Produces: `export function startMetrics(opts: { schedule: string; timezone: string; windowDays: number; runStore: RunStore; taskStore: TaskStore; memory: MemoryStore; revenue: RevenueTransport; metricsStore: MetricsStore; now?: () => Date }): Cron`.

No test file for this task: `src/triggers/metrics.ts` mirrors
`src/triggers/reflection.ts` and `src/triggers/digest.ts`, neither of which
has a dedicated test file — the cron wrapper is thin scheduling glue; the
logic it calls (`runMetricsJob`) already has its own tests from Task 3.

- [ ] **Step 1: Write the trigger wrapper**

```ts
// src/triggers/metrics.ts
import { Cron } from "croner";
import type { RevenueTransport } from "../control/revenue-transport.js";
import type { TaskStore } from "../control/task-store.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { runMetricsJob } from "../metrics.js";
import type { RunStore } from "../run-store.js";
import type { MetricsStore } from "../state/metrics-store.js";

export function startMetrics(opts: {
  schedule: string;
  timezone: string;
  windowDays: number;
  runStore: RunStore;
  taskStore: TaskStore;
  memory: MemoryStore;
  revenue: RevenueTransport;
  metricsStore: MetricsStore;
  now?: () => Date;
}): Cron {
  const now = opts.now ?? (() => new Date());
  const job = new Cron(opts.schedule, { timezone: opts.timezone, protect: true }, () => {
    void runMetricsJob({
      runStore: opts.runStore,
      taskStore: opts.taskStore,
      memory: opts.memory,
      revenue: opts.revenue,
      metricsStore: opts.metricsStore,
      windowDays: opts.windowDays,
      now: now(),
    })
      .then((metrics) => {
        console.log(`[metrics] computed a ${opts.windowDays}d snapshot for ${metrics.computedAt}: $${metrics.netIncomeUsd.toFixed(2)} net income`);
      })
      .catch((error: unknown) => {
        console.error("[metrics] job failed", error);
      });
  });
  console.log(
    `[metrics] scheduled "${opts.schedule}" (${opts.timezone}); next run ${job.nextRun()?.toISOString() ?? "never"}`,
  );
  return job;
}
```

- [ ] **Step 2: Typecheck the new file in isolation**

Run: `npm run typecheck`
Expected: clean (this file has no test, but must still compile).

- [ ] **Step 3: Wire it into `src/index.ts`**

Add two imports near the top, alongside the other `control/` imports:

```ts
import { FakeRevenueTransport, type RevenueTransport } from "./control/revenue-transport.js";
import { StripeRevenueTransport } from "./control/stripe-revenue-transport.js";
```

And one alongside the other `state/` imports:

```ts
import { MetricsStore } from "./state/metrics-store.js";
```

Right after `github = new GithubApiTransport({ token: githubToken });`
(inside the `try` block, around line 93), add:

```ts
    // Optional, not mustEnv'd: revenue is unobservable without it, but a
    // missing key must not fail boot the same way a missing GITHUB_PR_TOKEN
    // does — the metrics job simply reports $0 net income via the fake
    // until the operator's merchant-of-record account exists.
    const revenueToken = process.env.REVENUE_API_TOKEN;
    revenue = revenueToken
      ? new StripeRevenueTransport({ token: revenueToken, apiBase: process.env.REVENUE_API_BASE })
      : new FakeRevenueTransport();
```

Declare `revenue` alongside the other `let` declarations near the top of
`main()` (with `github`, around line 70):

```ts
  let revenue: RevenueTransport;
```

Right after `const runStore = new RunStore(DATA_DIR);` (around line 145),
add:

```ts
  const metricsStore = new MetricsStore(DATA_DIR);
```

Extend the existing `startDigest` call (around line 265-282) so the digest
can show the metrics delta — add `metricsStore,` to its options object,
right after `memory,`:

```ts
        startDigest({
          schedule: config.digest.schedule,
          timezone: config.digest.timezone,
          channel: config.digest.channel,
          store: runStore,
          tasks,
          outbox,
          memory,
          memoryConfig: config.memory,
          metricsStore,
        });
```

Finally, add a new block right after the existing `if (config.memory.enabled)`
reflection block (after its closing `}`, around line 322), before the
`// Imported lazily so a boot failure above never starts a schedule.` comment:

```ts
  if (config.metrics.enabled) {
    void import("./triggers/metrics.js")
      .then(({ startMetrics }) => {
        startMetrics({
          schedule: config.metrics.schedule,
          timezone: config.metrics.timezone,
          windowDays: config.metrics.windowDays,
          runStore,
          taskStore: tasks,
          memory,
          revenue,
          metricsStore,
        });
      })
      .catch((error: unknown) => {
        console.error("[boot] failed to start the metrics schedule", error);
      });
  }
```

- [ ] **Step 4: Add a `metrics:` example block to `config.yaml`**

In the repository-root `config.yaml`, after the `retention:` block, add:

```yaml
metrics:
  enabled: true
  schedule: "0 4 * * 1"   # weekly (Monday 04:00) — one hour after memory.reflectionSchedule
  timezone: Europe/Berlin
  windowDays: 7
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green — `config.yaml`'s change doesn't affect any test (config
tests use inline YAML fixtures, not the repo-root file), and every store
constructed above (`MetricsStore`, `StripeRevenueTransport`/
`FakeRevenueTransport`) compiles against real types.

- [ ] **Step 6: Commit**

```bash
git add src/triggers/metrics.ts src/index.ts config.yaml
git commit -m "feat: wire the weekly metrics job into boot"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/system-context.md`
- Modify: `docs/superpowers/specs/2026-08-30-self-evaluation-design.md`

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: nothing (docs only).

- [ ] **Step 1: Update `README.md`**

In the `## Not built yet` section, find and replace the entire paragraph
added by `docs/superpowers/plans/2026-08-31-goal-file-and-spend-accounting.md`
(it currently reads, verbatim, from "Subsystem 2's foundation pieces are in
place" through "...still unwritten. See
`docs/superpowers/specs/2026-08-30-self-evaluation-design.md`.") with:

```markdown
Subsystem 2's foundation pieces are in place: `src/goals.ts` (a `goals.yaml`
schema and loader — the file itself is never authored by the system, only
by the operator, and is excluded from the merge pipeline the same as
`grants.yaml`; `goals.yaml` is now committed at the repo root),
`src/spend/spend-accounting.ts` + `src/state/spend-store.ts` (spend-pot
bookkeeping for a `provision`-kind grant), and `src/control/revenue-transport.ts`
plus `src/control/stripe-revenue-transport.ts` (the real, read-only Stripe
implementation). The weekly metrics job (`src/metrics.ts`/
`src/triggers/metrics.ts`) computes net income, not-achieved rate per agent,
cost per completed task, novelty share/suppression rate, and queue
starvation into `data/state/metrics-<date>.json`, with the delta posted in
the daily digest. No spend-card grant exists in `grants.yaml` yet, and
three metrics named in the spec are deliberately deferred because nothing
in this codebase yet produces the data they'd need: revenue per external
spend (spend events aren't logged with amount+timestamp, only current
balance), funnel counts / time-to-first-revenue (no funnel-stage tracking
exists), and PR-review rework rate (no `pr-reviewer` verdict is persisted
anywhere) — see `docs/superpowers/plans/2026-08-31-weekly-metrics-job.md`.
See also `docs/superpowers/specs/2026-08-30-self-evaluation-design.md`.
```

- [ ] **Step 2: Update `docs/system-context.md`**

Find the paragraph added by the goal-file-and-spend-accounting plan
(starts "A `goals.yaml` at the repo root..."). Replace its final sentence,
verbatim: `A weekly metrics job (not yet built) will compute revenue and
instrumental metrics against it; `src/spend/spend-accounting.ts` and
`src/control/revenue-transport.ts` are the spend-pot and revenue-reader
building blocks that job depends on.` — with:

```markdown
A weekly metrics job (`src/metrics.ts`, scheduled by
`src/triggers/metrics.ts`) computes revenue and instrumental metrics —
net income, not-achieved rate per agent, cost per completed task, novelty
share, queue starvation — into `data/state/metrics-<date>.json`, with the
delta appended to the daily digest the day a fresh snapshot lands.
```

- [ ] **Step 3: Update the spec's status**

In `docs/superpowers/specs/2026-08-30-self-evaluation-design.md`, the
status paragraph currently reads (verbatim, as of this plan's writing —
match against the file's actual current text, not this quote, if the two
have drifted): "Still needed: a separate write-scoped commerce capability
so the system can create what it sells (a Stripe Product/Price/Payment
Link) — nothing in this codebase can list anything for sale yet,
`RevenueTransport` only ever reads completed sales, so this needs its own
grant and its own restricted key once a product proposal actually needs
it, not bundled into the read-only revenue key; the weekly metrics job and
its digest integration (the piece that actually calls `listSales`);
instrumental subordination and the means-constraint classifier in the
proposal/queue path; quota-aware shedding in the Governor;
`architecture-scout`, which the spec's own build order places last."

Replace the whole paragraph with:

```markdown
Still needed: a separate write-scoped commerce capability so the system
can create what it sells (a Stripe Product/Price/Payment Link) — nothing
in this codebase can list anything for sale yet, `RevenueTransport` only
ever reads completed sales, so this needs its own grant and its own
restricted key once a product proposal actually needs it, not bundled
into the read-only revenue key. The weekly metrics job
(`docs/superpowers/plans/2026-08-31-weekly-metrics-job.md`) now ships,
computing net income, not-achieved rate per agent, cost per completed
task, novelty share/suppression rate, and queue starvation, with the delta
posted in the digest — but three named metrics are deliberately deferred
(see that plan's Global Constraints): revenue per external spend (spend
events aren't logged with amount+timestamp), funnel counts /
time-to-first-revenue (no funnel-stage tracking exists), and PR-review
rework rate (no `pr-reviewer` verdict is persisted). Also still needed:
instrumental subordination and the means-constraint classifier in the
proposal/queue path; quota-aware shedding in the Governor;
`architecture-scout`, which the spec's own build order places last.
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: unaffected (docs-only change) — green.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/system-context.md docs/superpowers/specs/2026-08-30-self-evaluation-design.md
git commit -m "docs: describe the weekly metrics job as shipped"
```

## Testing

Covered per-task above. Summary against the spec's "Testing" section:

- Metric computation: pure functions over fixture stores; each metric
  positive and negative; empty-history and single-run edge cases — Task 2.
- Wiring (right store, right window, snapshot persisted) — Task 3.
- Digest delta integration, including the "nothing happened" interaction
  and null-valued metrics — Task 5.
- Deferred by explicit scope ruling (see Global Constraints): revenue per
  external spend, funnel counts / time-to-first-revenue, PR-review rework
  rate. Also out of scope, unaffected by this plan: quota-aware shedding,
  instrumental subordination, means-constraint classifier, `architecture-scout`.
