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
