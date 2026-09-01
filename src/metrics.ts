import { evaluateProbation } from "./state/agent-probation.js";
import type { ConfigOverridesStore } from "./config-overrides.js";
import type { RevenueTransport, Sale } from "./control/revenue-transport.js";
import type { Task, TaskStore } from "./control/task-store.js";
import type { MemoryStore } from "./memory/memory-store.js";
import type { MemoryRecord } from "./memory/types.js";
import type { RunStore, RunResult } from "./run-store.js";
import type { Metrics, MetricsStore, NotAchievedByAgent } from "./state/metrics-store.js";

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

/** Same bar as evaluateProbation's doc comment: below 5 runs the rate is noise, and 60%+ not-achieved means the agent isn't doing its job. */
const PROBATION_OPTIONS = { minRuns: 5, maxNotAchievedRate: 0.6 };

interface MetricsOutbox {
  postAlert(channelKey: string, text: string): Promise<"delivered" | "undelivered">;
}

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

export interface MetricsJobDeps {
  runStore: RunStore;
  taskStore: TaskStore;
  memory: MemoryStore;
  revenue: RevenueTransport;
  metricsStore: MetricsStore;
  windowDays: number;
  now?: Date;
  /**
   * Required. It was optional at first, so that existing callers kept
   * compiling — and the scheduled path in src/triggers/metrics.ts then never
   * passed it, leaving the probation check fully implemented, fully tested,
   * and never once executed in production. That is the same "computed by
   * something, consumed by nothing" failure this check exists to catch, so
   * the type now refuses it: a caller that forgets fails `npm run typecheck`
   * rather than silently doing half the job.
   */
  overrides: ConfigOverridesStore;
  /** Only consulted when an agent is actually disabled; absent means the disable still happens but nothing is posted. */
  outbox?: MetricsOutbox;
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

  const [runsInWindow, allTasks, allMemory] = await Promise.all([
    deps.runStore.listSince(since, now),
    deps.taskStore.list(),
    deps.memory.list(),
  ]);
  // Recorded on the snapshot, not just logged: the console.error below reaches
  // the container log, while the $0 it explains reaches Discord. Without the
  // flag travelling with the number, "no sales yet" and "we could not read
  // sales" render identically in the digest — the exact silent failure a
  // revenue-driven system must never have.
  let revenueUnavailable = false;
  const salesInWindow = await deps.revenue.listSales(since.toISOString()).catch((error: unknown) => {
    console.error("[metrics] revenue transport failed; this snapshot's netIncomeUsd reflects a data gap, not zero sales", error);
    revenueUnavailable = true;
    return [];
  });

  const memoryRecordsInWindow = allMemory.filter((r) => new Date(r.ts) >= since && new Date(r.ts) <= now);
  const doneTasksInWindow = allTasks.filter(
    (t) => t.status === "done" && t.finishedAt !== undefined && new Date(t.finishedAt) >= since && new Date(t.finishedAt) <= now,
  );
  const pendingTasksNow = allTasks.filter((t) => t.status === "pending");

  // Added here rather than threaded through computeMetrics: that function is
  // deliberately pure arithmetic over already-gathered data, and this is a
  // provenance fact about the gathering, which happened here.
  const metrics: Metrics = {
    ...computeMetrics({
      computedAt: now,
      windowDays: deps.windowDays,
      runsInWindow,
      memoryRecordsInWindow,
      salesInWindow,
      doneTasksInWindow,
      pendingTasksNow,
    }),
    revenueUnavailable,
  };

  await deps.metricsStore.write(metrics);

  {
    const toDisable = evaluateProbation(metrics, PROBATION_OPTIONS);
    if (toDisable.length > 0) {
      const current = await deps.overrides.read();
      const disabled = new Set(current.disabledAgents ?? []);
      for (const name of toDisable) disabled.add(name);
      await deps.overrides.set("disabledAgents", [...disabled], "metrics-job");

      // A silent disable is the same silent-failure class this whole
      // mechanism exists to close — the operator must hear about it the same
      // way they hear about `!disable`.
      const detail = toDisable
        .map((name) => {
          const agentMetrics = metrics.notAchievedByAgent.find((a) => a.agent === name);
          const rate = agentMetrics ? `${Math.round(agentMetrics.rate * 100)}%` : "?";
          const runs = agentMetrics?.successRunCount ?? "?";
          return `${name} (${rate} not-achieved over ${runs} runs)`;
        })
        .join(", ");
      await deps.outbox?.postAlert(
        "ops",
        `⏸️ Auto-disabled for succeeding without achieving anything: ${detail}. Undo with \`!enable <agent-name>\`.`,
      ).catch((error: unknown) => {
        console.error("[metrics] failed to post probation alert", error);
      });
    }
  }

  return metrics;
}
