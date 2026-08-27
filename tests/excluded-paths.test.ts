import { describe, expect, it } from "vitest";
import { EXCLUDED_PATHS, EXCLUDED_PREFIXES, touchesExcludedPath } from "../src/control/excluded-paths.js";

describe("touchesExcludedPath", () => {
  it("flags a change to any exact excluded path", () => {
    for (const path of EXCLUDED_PATHS) {
      expect(touchesExcludedPath([path])).toBe(true);
    }
  });

  it("flags a change when the excluded path is one of several changed files", () => {
    expect(touchesExcludedPath(["README.md", "src/governor.ts", "package.json"])).toBe(true);
  });

  it("does not flag an unrelated set of changed files", () => {
    expect(touchesExcludedPath(["README.md", "src/orchestrator.ts", "tests/foo.test.ts"])).toBe(false);
  });

  it("does not flag a path that merely contains an excluded filename as a substring", () => {
    // src/governor.ts is excluded; a differently-named file must not match by accident.
    expect(touchesExcludedPath(["src/governor.test.helpers.ts"])).toBe(false);
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
      // This pipeline's own safety rails — a pipeline able to merge changes
      // to its own gates is a pipeline with no gates.
      "src/control/excluded-paths.ts",
      "src/runner/sdk-runner.ts",
      "src/control/webhook-signature.ts",
      "src/control/webhook-wiring.ts",
      "src/control/webhook-receiver.ts",
      "src/runner/credentials.ts",
      "src/index.ts",
      ".github/workflows/ci.yml",
    ]);
  });

  it("the excluded prefix set names exactly the subtrees this plan specifies", () => {
    expect(EXCLUDED_PREFIXES).toEqual(["agents/"]);
  });

  // Regression test for the final review's Critical #2: exact-path membership
  // structurally cannot cover `agents/`, a directory that grows over time.
  // Any agent.yaml is a capability grant — a PR adding `tier: autonomous,
  // approval: auto, grantRefs: [infra-repo]` to some unrelated agent hands
  // that agent merge capability without touching the excluded grants.yaml.
  it("flags any file under an excluded prefix, including ones that don't exist yet", () => {
    expect(touchesExcludedPath(["agents/pr-reviewer/agent.yaml"])).toBe(true);
    expect(touchesExcludedPath(["agents/some-future-agent/agent.yaml"])).toBe(true);
    expect(touchesExcludedPath(["agents/pr-reviewer/prompt.md"])).toBe(true);
    expect(touchesExcludedPath(["README.md", "agents/smoke/agent.yaml"])).toBe(true);
  });

  it("flags the pipeline's own implementation files", () => {
    expect(touchesExcludedPath(["src/control/excluded-paths.ts"])).toBe(true);
    expect(touchesExcludedPath(["src/runner/sdk-runner.ts"])).toBe(true);
    expect(touchesExcludedPath(["src/control/webhook-signature.ts"])).toBe(true);
    expect(touchesExcludedPath(["src/control/webhook-wiring.ts"])).toBe(true);
    expect(touchesExcludedPath(["src/control/webhook-receiver.ts"])).toBe(true);
    expect(touchesExcludedPath(["src/runner/credentials.ts"])).toBe(true);
    expect(touchesExcludedPath(["src/index.ts"])).toBe(true);
    expect(touchesExcludedPath([".github/workflows/ci.yml"])).toBe(true);
  });

  it("does not flag a file whose path merely resembles an excluded prefix", () => {
    // "agents/" is the prefix — a sibling directory that starts with the same
    // letters must not match.
    expect(touchesExcludedPath(["agents-docs/readme.md"])).toBe(false);
    expect(touchesExcludedPath(["docs/agents/overview.md"])).toBe(false);
  });
});
