import { describe, expect, it } from "vitest";
import { runProbePass, type UrlProbe } from "../src/deploy/probe.js";
import type { Deployment } from "../src/deploy/deploys-schema.js";

const D: Deployment = { slug: "status-page", repo: "o/r", hostname: "status.example.com", port: 8080, env: [] };
const NOW = new Date("2026-09-01T10:00:00.000Z");

const up: UrlProbe = async () => ({ ok: true, detail: null });
const down: UrlProbe = async () => ({ ok: false, detail: "HTTP 502" });

describe("runProbePass", () => {
  it("probes each deployment's public HTTPS URL, not its container", async () => {
    const seen: string[] = [];
    const spy: UrlProbe = async (url) => {
      seen.push(url);
      return { ok: true, detail: null };
    };
    await runProbePass({ deployments: [D], previous: [], probe: spy, now: NOW });
    expect(seen).toEqual(["https://status.example.com/"]);
  });

  it("records a healthy probe with zero consecutive failures", async () => {
    const results = await runProbePass({ deployments: [D], previous: [], probe: up, now: NOW });
    expect(results).toEqual([{ slug: "status-page", url: "https://status.example.com/", lastProbeAt: NOW.toISOString(), ok: true, consecutiveFailures: 0, detail: null }]);
  });

  it("counts consecutive failures across passes", async () => {
    const first = await runProbePass({ deployments: [D], previous: [], probe: down, now: NOW });
    expect(first[0]!.consecutiveFailures).toBe(1);
    const second = await runProbePass({ deployments: [D], previous: first, probe: down, now: NOW });
    expect(second[0]!.consecutiveFailures).toBe(2);
  });

  it("resets the failure count once a probe succeeds", async () => {
    const failed = await runProbePass({ deployments: [D], previous: [], probe: down, now: NOW });
    const recovered = await runProbePass({ deployments: [D], previous: failed, probe: up, now: NOW });
    expect(recovered[0]!.consecutiveFailures).toBe(0);
    expect(recovered[0]!.detail).toBeNull();
  });

  it("drops records for deployments no longer declared", async () => {
    const previous = await runProbePass({ deployments: [D], previous: [], probe: up, now: NOW });
    const results = await runProbePass({ deployments: [], previous, probe: up, now: NOW });
    expect(results).toEqual([]);
  });

  it("records a probe that throws as a failure rather than aborting the pass", async () => {
    const throwing: UrlProbe = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    const results = await runProbePass({ deployments: [D], previous: [], probe: throwing, now: NOW });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toMatch(/ENOTFOUND/);
  });

  it("keeps probing the rest when one deployment fails", async () => {
    const other: Deployment = { ...D, slug: "widget", hostname: "widget.example.com" };
    const mixed: UrlProbe = async (url) => (url.includes("widget") ? { ok: true, detail: null } : { ok: false, detail: "HTTP 500" });
    const results = await runProbePass({ deployments: [D, other], previous: [], probe: mixed, now: NOW });
    expect(results.map((r) => [r.slug, r.ok])).toEqual([["status-page", false], ["widget", true]]);
  });
});
