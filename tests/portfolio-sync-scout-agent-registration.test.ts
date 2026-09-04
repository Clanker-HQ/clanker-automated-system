import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadGrants, validateGrantRefs } from "../src/grants.js";
import { loadRegistry } from "../src/registry.js";

describe("portfolio-sync-scout agent registration against the real repo config", () => {
  it("loads agents/portfolio-sync-scout/agent.yaml cleanly, with no grants needed", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-portfolio-sync-scout-registration-"));
    const config = loadConfig(join(process.cwd(), "config.yaml"));
    const agents = loadRegistry({
      agentsDir: join(process.cwd(), "agents"),
      dataDir,
      config,
      env: { ...process.env, DISCORD_WEBHOOK_OPS: "https://discord.com/api/webhooks/stub/stub" },
    });
    const grants = loadGrants(join(process.cwd(), "grants.yaml"));

    expect(() => validateGrantRefs(agents, grants)).not.toThrow();

    const scout = agents.find((a) => a.name === "portfolio-sync-scout");
    expect(scout).toBeDefined();
    expect(scout).toMatchObject({
      trigger: { type: "cron", schedule: "0 14 * * *" },
      category: "maintain",
      tier: "readonly",
      approval: "notify",
      grantRefs: [],
    });
  });

  // shouldSkip (src/triggers/cron.ts) reads `category` to decide whether the
  // weekly strategy's allocation pauses this agent — "maintain" groups it
  // with cleanup-scout/dependency-scout under overseer's own allocation
  // split, which is the intended lever (see agents/overseer/prompt.md), not
  // a category of its own that overseer would have to learn about separately.
  it("shares the maintain category with the other reconciliation scouts", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-portfolio-sync-scout-registration-"));
    const config = loadConfig(join(process.cwd(), "config.yaml"));
    const agents = loadRegistry({
      agentsDir: join(process.cwd(), "agents"),
      dataDir,
      config,
      env: { ...process.env, DISCORD_WEBHOOK_OPS: "https://discord.com/api/webhooks/stub/stub" },
    });

    const scout = agents.find((a) => a.name === "portfolio-sync-scout");
    const cleanup = agents.find((a) => a.name === "cleanup-scout");
    expect(scout?.category).toBe(cleanup?.category);
  });
});
