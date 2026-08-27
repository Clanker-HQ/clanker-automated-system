import { describe, expect, it } from "vitest";
import { EXCLUDED_PATHS, touchesExcludedPath } from "../src/control/excluded-paths.js";

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
    expect(touchesExcludedPath(["README.md", "src/index.ts", "tests/foo.test.ts"])).toBe(false);
  });

  it("does not flag a path that merely contains an excluded filename as a substring", () => {
    // src/governor.ts is excluded; a differently-named file must not match by accident.
    expect(touchesExcludedPath(["src/governor.test.helpers.ts"])).toBe(false);
  });

  it("the excluded set names exactly the files this plan specifies", () => {
    expect(EXCLUDED_PATHS).toEqual([
      "src/governor.ts",
      "src/grants.ts",
      "src/agent-schema.ts",
      "src/control/bot.ts",
      "grants.yaml",
      "config.yaml",
    ]);
  });
});
