// tests/dashboard-server.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DashboardServer, type DashboardDeps } from "../src/control/dashboard-server.js";
import { TaskStore } from "../src/control/task-store.js";
import { RunStore } from "../src/run-store.js";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { Governor } from "../src/governor.js";
import { BreakerStore } from "../src/state/breaker.js";
import { WorldModel } from "../src/world/world-model.js";
import { MetricsStore } from "../src/state/metrics-store.js";
import { RateLimitTracker } from "../src/state/rate-limit.js";
import { parseConfig } from "../src/config.js";
import type { AgentDef } from "../src/registry.js";

const CONFIG = parseConfig(
  "config.yaml",
  "governor:\n  maxConcurrent: 2\n  dailyBudgetUsd: 10\n  pendingTimeoutHours: 24\ndiscord:\n  channels: {}\n",
);

export function testDeps(dataDir: string = mkdtempSync(join(tmpdir(), "cai-dashboard-"))): DashboardDeps {
  const runs = new RunStore(dataDir);
  const overrides = new ConfigOverridesStore(dataDir);
  const breaker = new BreakerStore(dataDir);
  return {
    tasks: new TaskStore(dataDir),
    runs,
    overrides,
    governor: new Governor({ dataDir, config: CONFIG, store: runs, overrides, rateLimits: new RateLimitTracker(dataDir), breaker }),
    breaker,
    world: new WorldModel(dataDir),
    metrics: new MetricsStore(dataDir),
    dispatcher: { wake: async () => {} },
    agents: [] as AgentDef[],
    dataDir,
  };
}

export function server(deps: DashboardDeps = testDeps()): DashboardServer {
  return new DashboardServer({ user: "op", password: "secret", deps });
}

export const AUTH = `Basic ${Buffer.from("op:secret").toString("base64")}`;

describe("DashboardServer auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const result = await server().handleRequest({
      method: "GET", path: "/api/status", query: new URLSearchParams(), authHeader: undefined, body: "",
    });
    expect(result.status).toBe(401);
  });

  it("rejects a request with the wrong password", async () => {
    const wrong = `Basic ${Buffer.from("op:nope").toString("base64")}`;
    const result = await server().handleRequest({
      method: "GET", path: "/api/status", query: new URLSearchParams(), authHeader: wrong, body: "",
    });
    expect(result.status).toBe(401);
  });

  it("returns 404 for an unknown path once authenticated", async () => {
    const result = await server().handleRequest({
      method: "GET", path: "/api/nonexistent", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(404);
  });
});

describe("GET /api/status", () => {
  it("returns governor status plus task counts by status", async () => {
    const deps = testDeps();
    await deps.tasks.create({ text: "a", createdBy: "test" });
    const result = await server(deps).handleRequest({
      method: "GET", path: "/api/status", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.taskCounts).toEqual({ pending: 1, queued: 0, running: 0, waiting: 0 });
    expect(parsed.dailyBudgetUsd).toBe(10);
  });

  it("returns 500 without hanging when a dependency throws unexpectedly", async () => {
    const deps = testDeps();
    deps.governor = {
      status: async () => { throw new Error("disk exploded"); },
      adjustConcurrency: () => {},
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await server(deps).handleRequest({
        method: "GET", path: "/api/status", query: new URLSearchParams(), authHeader: AUTH, body: "",
      });
      expect(result.status).toBe(500);
    } finally {
      errors.mockRestore();
    }
  });
});
