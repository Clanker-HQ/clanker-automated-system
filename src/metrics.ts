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
