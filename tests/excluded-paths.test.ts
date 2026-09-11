import { describe, expect, it } from "vitest";
import {
  EXCLUDED_PATHS,
  EXCLUDED_PREFIXES,
  GOVERNANCE_PATHS,
  INFRA_REPO,
  isGovernanceOnlyChange,
  touchesExcludedPath,
} from "../src/control/excluded-paths.js";

describe("touchesExcludedPath", () => {
  it("flags a change to any exact excluded path", () => {
    for (const path of EXCLUDED_PATHS) {
      expect(touchesExcludedPath([path], INFRA_REPO)).toBe(true);
    }
  });

  it("flags a change when the excluded path is one of several changed files", () => {
    expect(touchesExcludedPath(["README.md", "src/governor.ts", "package.json"], INFRA_REPO)).toBe(true);
  });

  it("does not flag an unrelated set of changed files", () => {
    expect(touchesExcludedPath(["README.md", "src/orchestrator.ts", "tests/foo.test.ts"], INFRA_REPO)).toBe(false);
  });

  it("does not flag a path that merely contains an excluded filename as a substring", () => {
    // src/governor.ts is excluded; a differently-named file must not match by accident.
    expect(touchesExcludedPath(["src/governor.test.helpers.ts"], INFRA_REPO)).toBe(false);
  });

  it("the excluded set names exactly the files this plan specifies", () => {
    expect(EXCLUDED_PATHS).toEqual([
      // The parent governance files.
      "src/governor.ts",
      "src/grants.ts",
      "src/agent-schema.ts",
      "src/control/bot.ts",
      "grants.yaml",
      "config.yaml",
      "goals.yaml",
      // This pipeline's own safety rails — a pipeline able to merge changes
      // to its own gates is a pipeline with no gates.
      "src/control/excluded-paths.ts",
      "src/runner/sdk-runner.ts",
      "src/control/git-pusher.ts",
      "src/control/webhook-signature.ts",
      "src/control/webhook-wiring.ts",
      "src/control/webhook-receiver.ts",
      "src/runner/credentials.ts",
      "src/index.ts",
      ".github/workflows/ci.yml",
      "src/control/self-build-gate.ts",
    ]);
  });

  it("the excluded prefix set names exactly the subtrees this plan specifies", () => {
    expect(EXCLUDED_PREFIXES).toEqual(["agents/", "scripts/"]);
  });

  it("refuses a PR touching the deploy script — it owns the health gate and the rollback", () => {
    expect(touchesExcludedPath(["scripts/auto-deploy.sh"], INFRA_REPO)).toBe(true);
    expect(touchesExcludedPath(["scripts/deploy-products.sh"], INFRA_REPO)).toBe(true);
  });

  it("refuses a PR touching the self-build gate itself", () => {
    expect(touchesExcludedPath(["src/control/self-build-gate.ts"], INFRA_REPO)).toBe(true);
  });

  it("still permits deploys.yaml — the whole point is that agents write it", () => {
    expect(touchesExcludedPath(["deploys.yaml"], INFRA_REPO)).toBe(false);
  });

  // Regression test for the final review's Critical #2: exact-path membership
  // structurally cannot cover `agents/`, a directory that grows over time.
  // Any agent.yaml is a capability grant — a PR adding `tier: autonomous,
  // approval: auto, grantRefs: [infra-repo]` to some unrelated agent hands
  // that agent merge capability without touching the excluded grants.yaml.
  it("flags any file under an excluded prefix, including ones that don't exist yet", () => {
    expect(touchesExcludedPath(["agents/pr-reviewer/agent.yaml"], INFRA_REPO)).toBe(true);
    expect(touchesExcludedPath(["agents/some-future-agent/agent.yaml"], INFRA_REPO)).toBe(true);
    expect(touchesExcludedPath(["agents/pr-reviewer/prompt.md"], INFRA_REPO)).toBe(true);
    expect(touchesExcludedPath(["README.md", "agents/smoke/agent.yaml"], INFRA_REPO)).toBe(true);
  });

  it("flags the pipeline's own implementation files", () => {
    expect(touchesExcludedPath(["src/control/excluded-paths.ts"], INFRA_REPO)).toBe(true);
    expect(touchesExcludedPath(["src/runner/sdk-runner.ts"], INFRA_REPO)).toBe(true);
    // Regression test for the final review's Important #2: git-pusher.ts is
    // the code that turns a validated `branch` argument into the actual
    // pushed git ref, so it needs the same protection as the regex in
    // sdk-runner.ts that validates that argument.
    expect(touchesExcludedPath(["src/control/git-pusher.ts"], INFRA_REPO)).toBe(true);
    expect(touchesExcludedPath(["src/control/webhook-signature.ts"], INFRA_REPO)).toBe(true);
    expect(touchesExcludedPath(["src/control/webhook-wiring.ts"], INFRA_REPO)).toBe(true);
    expect(touchesExcludedPath(["src/control/webhook-receiver.ts"], INFRA_REPO)).toBe(true);
    expect(touchesExcludedPath(["src/runner/credentials.ts"], INFRA_REPO)).toBe(true);
    expect(touchesExcludedPath(["src/index.ts"], INFRA_REPO)).toBe(true);
    expect(touchesExcludedPath([".github/workflows/ci.yml"], INFRA_REPO)).toBe(true);
  });

  it("flags a change to goals.yaml, the same as grants.yaml and config.yaml", () => {
    expect(touchesExcludedPath(["goals.yaml"], INFRA_REPO)).toBe(true);
  });

  it("does not flag a file whose path merely resembles an excluded prefix", () => {
    // "agents/" is the prefix — a sibling directory that starts with the same
    // letters must not match.
    expect(touchesExcludedPath(["agents-docs/readme.md"], INFRA_REPO)).toBe(false);
    expect(touchesExcludedPath(["docs/agents/overview.md"], INFRA_REPO)).toBe(false);
  });
});

// Regression coverage for a real incident on 2026-09-09: AAS-Labs/pilot-01#4
// and #6 each got an unconditional "security-sensitive excluded path"
// refusal purely because their own Cloudflare Workers entrypoint is also
// named src/index.ts — a bare filename collision with zero relationship to
// THIS repo's own safety rails, silently blocking legitimate product-repo
// merges as if a deliberate security gate had tripped.
describe("touchesExcludedPath repo scoping", () => {
  it("does not flag a product repo's own src/index.ts, or any other excluded-looking path", () => {
    expect(touchesExcludedPath(["src/index.ts"], "AAS-Labs/pilot-01")).toBe(false);
    expect(touchesExcludedPath(["src/governor.ts", "grants.yaml"], "AAS-Labs/pilot-01")).toBe(false);
    expect(touchesExcludedPath(["agents/foo.ts"], "AAS-Labs/book-pipeline")).toBe(false);
  });

  it("still flags the same paths for the infra repo itself", () => {
    expect(touchesExcludedPath(["src/index.ts"], INFRA_REPO)).toBe(true);
  });

  it("INFRA_REPO names this project's own repo", () => {
    expect(INFRA_REPO).toBe("Clanker-HQ/clanker-automated-system");
  });
});

// Coverage for the 2026-09-11 governance gate — the small, named exception
// to "excluded path always refuses unconditionally" that mergePR's own gate
// (sdk-runner.ts) consults before falling back to that refusal.
describe("isGovernanceOnlyChange", () => {
  it("is true for a single governance-tier file", () => {
    for (const f of GOVERNANCE_PATHS) {
      expect(isGovernanceOnlyChange([f], INFRA_REPO), f).toBe(true);
    }
  });

  it("is true when every excluded file touched is governance-tier, even across several", () => {
    expect(isGovernanceOnlyChange(["src/governor.ts", "src/grants.ts", "config.yaml"], INFRA_REPO)).toBe(true);
  });

  it("is true when a governance file is mixed with an ordinary, non-excluded file", () => {
    expect(isGovernanceOnlyChange(["src/governor.ts", "README.md", "tests/governor.test.ts"], INFRA_REPO)).toBe(true);
  });

  it("is false when a floor (non-governance) excluded path is touched at all, even alone", () => {
    expect(isGovernanceOnlyChange(["src/runner/sdk-runner.ts"], INFRA_REPO)).toBe(false);
    expect(isGovernanceOnlyChange(["grants.yaml"], INFRA_REPO)).toBe(false);
    expect(isGovernanceOnlyChange(["src/control/excluded-paths.ts"], INFRA_REPO)).toBe(false);
    expect(isGovernanceOnlyChange(["src/control/webhook-wiring.ts"], INFRA_REPO)).toBe(false);
  });

  it("is false when a governance file is mixed with a floor file — mixing always falls back to the unconditional refusal", () => {
    expect(isGovernanceOnlyChange(["src/governor.ts", "src/runner/sdk-runner.ts"], INFRA_REPO)).toBe(false);
  });

  it("is false when no excluded path is touched at all — that PR was never refused, so this question doesn't apply", () => {
    expect(isGovernanceOnlyChange(["README.md", "src/foo.ts"], INFRA_REPO)).toBe(false);
  });

  it("is false for any repo other than the infra repo — GOVERNANCE_PATHS describes this repo's own layout only", () => {
    expect(isGovernanceOnlyChange(["src/governor.ts"], "AAS-Labs/pilot-01")).toBe(false);
  });

  it("GOVERNANCE_PATHS is a proper subset of EXCLUDED_PATHS — never a path EXCLUDED_PATHS doesn't already know about", () => {
    for (const f of GOVERNANCE_PATHS) expect(EXCLUDED_PATHS).toContain(f);
    expect(GOVERNANCE_PATHS.length).toBeLessThan(EXCLUDED_PATHS.length);
  });

  it("GOVERNANCE_PATHS excludes the enforcement mechanism itself and the webhook trust boundary", () => {
    for (const floorFile of [
      "src/control/excluded-paths.ts",
      "src/control/self-build-gate.ts",
      "src/runner/sdk-runner.ts",
      "src/control/git-pusher.ts",
      "src/control/webhook-signature.ts",
      "src/control/webhook-wiring.ts",
      "src/control/webhook-receiver.ts",
      "src/runner/credentials.ts",
      "src/index.ts",
      "grants.yaml",
      "goals.yaml",
    ]) {
      expect(GOVERNANCE_PATHS, floorFile).not.toContain(floorFile);
    }
  });
});
