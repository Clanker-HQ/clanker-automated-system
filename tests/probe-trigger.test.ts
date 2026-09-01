import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProbeStore } from "../src/deploy/probe-store.js";
import { startProbe } from "../src/triggers/probe.js";
import type { Deployment } from "../src/deploy/deploys-schema.js";

const A: Deployment = { slug: "status-page", repo: "o/r", hostname: "status.example.com", port: 8080, env: [] };
const B: Deployment = { slug: "widget", repo: "o/w", hostname: "widget.example.com", port: 3000, env: [] };
const NOW = new Date("2026-09-01T10:00:00.000Z");

// A schedule that never fires on its own within a test run: every firing here
// is an explicit job.trigger(), so nothing races the assertions.
const NEVER = "0 0 1 1 *";

describe("startProbe", () => {
  it("writes a record for every declared deployment", async () => {
    const store = new ProbeStore(await mkdtemp(join(tmpdir(), "probe-")));
    const job = startProbe({
      schedule: NEVER,
      timezone: "UTC",
      deployments: [A, B],
      store,
      probe: async () => ({ ok: true, detail: null }),
      now: () => NOW,
    });
    await job.trigger();
    job.stop();
    expect((await store.read()).map((r) => r.slug).sort()).toEqual(["status-page", "widget"]);
  });

  it("still records the reachable deployment when another one's probe throws", async () => {
    const store = new ProbeStore(await mkdtemp(join(tmpdir(), "probe-")));
    const job = startProbe({
      schedule: NEVER,
      timezone: "UTC",
      deployments: [A, B],
      store,
      probe: async (url) => {
        if (url.includes("status")) throw new Error("getaddrinfo ENOTFOUND");
        return { ok: true, detail: null };
      },
      now: () => NOW,
    });
    await job.trigger();
    job.stop();
    const results = await store.read();
    expect(results.find((r) => r.slug === "widget")?.ok).toBe(true);
    expect(results.find((r) => r.slug === "status-page")?.ok).toBe(false);
  });
});
