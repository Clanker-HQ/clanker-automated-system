import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadGrants, validateGrantRefs } from "../src/grants.js";
import { loadRegistry } from "../src/registry.js";

// NOTE: this test intentionally fails until a human pastes the
// cloudflare-deploy/stripe-api grants block (see the PR that added those
// grantRefs to agents/builder/agent.yaml) into grants.yaml — this system
// never authors grants.yaml itself. Once that paste lands, this test (and
// boot's own validateGrantRefs call) passes with no further code change.
describe("builder agent registration against the real repo config", () => {
  it("loads agents/builder/agent.yaml cleanly and its grantRefs validate against the real grants.yaml", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-builder-registration-"));
    const config = loadConfig(join(process.cwd(), "config.yaml"));
    const agents = loadRegistry({
      agentsDir: join(process.cwd(), "agents"),
      dataDir,
      config,
      env: { ...process.env, DISCORD_WEBHOOK_OPS: "https://discord.com/api/webhooks/stub/stub" },
    });
    const grants = loadGrants(join(process.cwd(), "grants.yaml"));

    expect(() => validateGrantRefs(agents, grants)).not.toThrow();

    const builder = agents.find((a) => a.name === "builder");
    expect(builder).toBeDefined();
    expect(builder).toMatchObject({
      trigger: { type: "dispatched" },
      tier: "autonomous",
      approval: "auto",
      grantRefs: ["builder-push", "products-provision", "products-push", "cloudflare-deploy", "stripe-api"],
    });
  });
});
