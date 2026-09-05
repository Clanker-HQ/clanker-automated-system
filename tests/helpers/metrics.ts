import type { Metrics } from "../../src/state/metrics-store.js";

/** Shared "happy path" snapshot fixture — a full week of real numbers, no data gaps. Override individual fields per test. */
export function metricsSnapshot(overrides: Partial<Metrics> = {}): Metrics {
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
