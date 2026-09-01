import { describe, expect, it } from "vitest";
import { probeWarnings } from "../src/deploy/probe-warnings.js";
import type { ProbeResult } from "../src/deploy/probe-store.js";

const NOW = new Date("2026-09-01T10:00:00.000Z");
const ok: ProbeResult = { slug: "status-page", url: "https://status.example.com/", lastProbeAt: "2026-09-01T09:55:00.000Z", ok: true, consecutiveFailures: 0, detail: null };

describe("probeWarnings", () => {
  it("says nothing when everything is healthy", () => {
    expect(probeWarnings({ probes: [ok], declaredSlugs: ["status-page"], now: NOW, maxAgeMinutes: 30 })).toEqual([]);
  });

  it("says nothing at all when nothing is deployed", () => {
    expect(probeWarnings({ probes: [], declaredSlugs: [], now: NOW, maxAgeMinutes: 30 })).toEqual([]);
  });

  it("warns about a deployment that is down, naming it and why", () => {
    const down = { ...ok, ok: false, consecutiveFailures: 3, detail: "HTTP 502" };
    const lines = probeWarnings({ probes: [down], declaredSlugs: ["status-page"], now: NOW, maxAgeMinutes: 30 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("status-page");
    expect(lines[0]).toContain("HTTP 502");
    expect(lines[0]).toMatch(/^⚠️/);
  });

  it("warns when the prober itself has stopped running", () => {
    const stale = { ...ok, lastProbeAt: "2026-09-01T08:00:00.000Z" };
    const lines = probeWarnings({ probes: [stale], declaredSlugs: ["status-page"], now: NOW, maxAgeMinutes: 30 });
    expect(lines[0]).toMatch(/stopped running|stale/i);
  });

  it("warns about a declared deployment that has never been probed", () => {
    const lines = probeWarnings({ probes: [], declaredSlugs: ["status-page"], now: NOW, maxAgeMinutes: 30 });
    expect(lines[0]).toContain("status-page");
    expect(lines[0]).toMatch(/never/i);
  });
});
