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
