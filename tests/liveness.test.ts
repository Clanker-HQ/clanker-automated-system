import { describe, expect, it } from "vitest";
import type { AgentDef } from "../src/registry.js";
import { agentLiveness, cronCadenceMs, stalePasses, staleCronAgents } from "../src/state/liveness.js";
import type { Strategy } from "../src/world/strategy.js";

const NOW = new Date("2026-09-30T08:00:00.000Z");

function cronAgent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "dependency-scout",
    enabled: true,
    trigger: { type: "cron", schedule: "0 14 * * *", timezone: "Europe/Berlin" },
    category: "maintain",
    ...overrides,
  } as AgentDef;
}

function strategy(overrides: Partial<Strategy["allocation"]> = {}): Strategy {
  return {
    writtenAt: "2026-09-28T00:00:00.000Z",
    intent: "",
    allocation: { research: 34, build: 33, maintain: 33, ...overrides },
    expectations: [],
    changeReason: "",
  };
}

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

describe("cronCadenceMs", () => {
  it("computes the interval between two consecutive fires of a daily schedule", () => {
    const ms = cronCadenceMs("0 14 * * *", "UTC");
    expect(ms).toBe(24 * 60 * 60 * 1000);
  });

  it("computes the interval for a weekly schedule", () => {
    const ms = cronCadenceMs("0 7 * * 1", "UTC");
    expect(ms).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("agentLiveness", () => {
  it("reports the cadence and marks stale when the agent hasn't run within twice it", () => {
    const agent = cronAgent();
    const staleAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    const result = agentLiveness({ agent, strategy: strategy(), lastRunAt: staleAt, now: NOW });
    expect(result.stale).toBe(true);
    expect(result.lastRunAt).toEqual(staleAt);
    expect(result.cadenceMs).toBe(24 * 60 * 60 * 1000);
  });

  it("is not stale when the agent ran recently", () => {
    const agent = cronAgent();
    const recentAt = new Date(NOW.getTime() - 6 * 60 * 60 * 1000);
    const result = agentLiveness({ agent, strategy: strategy(), lastRunAt: recentAt, now: NOW });
    expect(result.stale).toBe(false);
  });

  it("is stale when the agent has never run", () => {
    const agent = cronAgent();
    const result = agentLiveness({ agent, strategy: strategy(), lastRunAt: null, now: NOW });
    expect(result.stale).toBe(true);
    expect(result.lastRunAt).toBeNull();
  });

  it("is never stale for a disabled agent, regardless of last run", () => {
    const agent = cronAgent({ enabled: false });
    const result = agentLiveness({ agent, strategy: strategy(), lastRunAt: null, now: NOW });
    expect(result.stale).toBe(false);
  });

  it("is never stale for a non-cron agent, and reports no cadence", () => {
    const agent = cronAgent({ trigger: { type: "dispatched" } });
    const result = agentLiveness({ agent, strategy: strategy(), lastRunAt: null, now: NOW });
    expect(result.stale).toBe(false);
    expect(result.cadenceMs).toBeNull();
  });

  it("is never stale when the agent's category is zero-allocated this cycle", () => {
    const agent = cronAgent({ category: "maintain" });
    const result = agentLiveness({
      agent, strategy: strategy({ maintain: 0, research: 50, build: 50 }), lastRunAt: null, now: NOW,
    });
    expect(result.stale).toBe(false);
  });
});

describe("staleCronAgents", () => {
  it("warns when an enabled cron agent hasn't run within twice its own cadence", () => {
    const agent = cronAgent({ name: "dependency-scout" });
    const staleAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days, daily cadence
    const warnings = staleCronAgents({
      agents: [agent],
      strategy: strategy(),
      lastRunAt: () => staleAt,
      now: NOW,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dependency-scout");
  });

  it("is silent when the agent ran recently relative to its cadence", () => {
    const agent = cronAgent({ name: "dependency-scout" });
    const recentAt = new Date(NOW.getTime() - 6 * 60 * 60 * 1000); // 6h ago, daily cadence
    const warnings = staleCronAgents({ agents: [agent], strategy: strategy(), lastRunAt: () => recentAt, now: NOW });
    expect(warnings).toEqual([]);
  });

  it("warns when the agent has never run at all", () => {
    const agent = cronAgent({ name: "dependency-scout" });
    const warnings = staleCronAgents({ agents: [agent], strategy: strategy(), lastRunAt: () => null, now: NOW });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/never/i);
  });

  it("is silent for a disabled agent", () => {
    const agent = cronAgent({ name: "dependency-scout", enabled: false });
    const warnings = staleCronAgents({ agents: [agent], strategy: strategy(), lastRunAt: () => null, now: NOW });
    expect(warnings).toEqual([]);
  });

  it("is silent for a non-cron (dispatched) agent", () => {
    const agent = cronAgent({ name: "builder", trigger: { type: "dispatched" } });
    const warnings = staleCronAgents({ agents: [agent], strategy: strategy(), lastRunAt: () => null, now: NOW });
    expect(warnings).toEqual([]);
  });

  // A category the current strategy has zero-allocated is an INTENTIONAL
  // skip (cron.ts's own shouldSkip) -- flagging it as broken would teach the
  // operator to distrust every real warning that follows.
  it("is silent when the agent's category has zero allocation this cycle", () => {
    const agent = cronAgent({ name: "cleanup-scout", category: "maintain" });
    const warnings = staleCronAgents({
      agents: [agent],
      strategy: strategy({ maintain: 0, research: 50, build: 50 }),
      lastRunAt: () => null,
      now: NOW,
    });
    expect(warnings).toEqual([]);
  });
});
