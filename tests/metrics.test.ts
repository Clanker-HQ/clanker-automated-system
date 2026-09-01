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
