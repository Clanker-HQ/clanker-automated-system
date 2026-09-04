import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadGrants, validateGrantRefs } from "../src/grants.js";
import { loadRegistry } from "../src/registry.js";

describe("repair agent registration against the real repo config", () => {
  it("loads agents/repair/agent.yaml cleanly and reuses builder-push rather than a new grant", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-repair-registration-"));
    const config = loadConfig(join(process.cwd(), "config.yaml"));
    const agents = loadRegistry({
      agentsDir: join(process.cwd(), "agents"),
      dataDir,
      config,
      env: { ...process.env, DISCORD_WEBHOOK_OPS: "https://discord.com/api/webhooks/stub/stub" },
    });
    const grants = loadGrants(join(process.cwd(), "grants.yaml"));

    expect(() => validateGrantRefs(agents, grants)).not.toThrow();

    const repair = agents.find((a) => a.name === "repair");
    expect(repair).toBeDefined();
    expect(repair).toMatchObject({
      trigger: { type: "dispatched" },
      tier: "autonomous",
      approval: "auto",
      grantRefs: ["builder-push"],
    });
  });

  // The router's specialist menu is built from `description` alone (see
  // specialistsOf in router.ts) — this is the one lever that keeps repair
  // from being picked for ordinary feature work, so the description has to
  // read as narrowly self-referential rather than as a second builder.
  it("describes repair narrowly enough that it does not read as ordinary feature work", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-repair-registration-"));
    const config = loadConfig(join(process.cwd(), "config.yaml"));
    const agents = loadRegistry({
      agentsDir: join(process.cwd(), "agents"),
      dataDir,
      config,
      env: { ...process.env, DISCORD_WEBHOOK_OPS: "https://discord.com/api/webhooks/stub/stub" },
    });

    const repair = agents.find((a) => a.name === "repair");
    const description = repair?.description.toLowerCase() ?? "";
    expect(description).toMatch(/broken|failing|repair/);
    expect(description).not.toMatch(/implements a small|well-described code change/);
  });
});
