import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Orchestrator } from "../src/orchestrator.js";
import type { AgentDef } from "../src/registry.js";
import { startCron } from "../src/triggers/cron.js";
import { WorldModel } from "../src/world/world-model.js";

/** Feb 29 on a non-leap year — never fires on its own, so only trigger() runs the job. */
const NEVER = "0 0 29 2 *";

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "improvement-scout",
    enabled: true,
    trigger: { type: "cron", schedule: NEVER, timezone: "UTC" },
    ...overrides,
  } as unknown as AgentDef;
}

describe("startCron", () => {
  it("passes the world model summary as promptContext to a cron-triggered agent", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-cron-trigger-"));
    const world = new WorldModel(dataDir);
    await world.upsertPortfolioEntry({
      slug: "widget-api",
      purpose: "Paid API for widget conversion",
      status: "live",
      nextReviewAt: "2026-10-01",
      bar: "at least one paying customer",
      monthlyCostUsd: 12,
      notes: ["2026-09-01: launched"],
    });

    const executeRun = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { executeRun } as unknown as Orchestrator;

    const jobs = startCron([agent()], orchestrator, world);
    try {
      await jobs[0]!.trigger();
      const [, , promptContext] = executeRun.mock.calls[0]!;
      expect(promptContext).toContain("widget-api");
    } finally {
      for (const job of jobs) job.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
