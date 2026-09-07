import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadGrants, validateGrantRefs } from "../src/grants.js";
import { loadRegistry } from "../src/registry.js";

describe("pr-reviewer agent registration against the real repo config", () => {
  // Regression test for the bug this grantRefs line fixes: pr-reviewer held
  // only infra-repo, so a pull_request webhook on any AAS-Labs product repo
  // matched no grant and was silently never reviewed or merged, no matter
  // what its own webhook delivered. products-repo is what lets it reach a
  // repo covered by GITHUB_PRODUCTS_TOKEN instead of GITHUB_PR_TOKEN.
  it("loads agents/pr-reviewer/agent.yaml cleanly and holds both infra-repo and products-repo", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-pr-reviewer-registration-"));
    const config = loadConfig(join(process.cwd(), "config.yaml"));
    const agents = loadRegistry({
      agentsDir: join(process.cwd(), "agents"),
      dataDir,
      config,
      env: { ...process.env, DISCORD_WEBHOOK_OPS: "https://discord.com/api/webhooks/stub/stub" },
    });
    const grants = loadGrants(join(process.cwd(), "grants.yaml"));

    expect(() => validateGrantRefs(agents, grants)).not.toThrow();

    const prReviewer = agents.find((a) => a.name === "pr-reviewer");
    expect(prReviewer).toBeDefined();
    expect(prReviewer).toMatchObject({
      trigger: { type: "webhook", repo: "*", event: "pull_request" },
      tier: "autonomous",
      approval: "auto",
      grantRefs: ["infra-repo", "products-repo"],
    });
  });
});
