import { describe, expect, it } from "vitest";
import { buildFindingReviewer } from "../src/control/build-finding-reviewer.js";
import { FakeFindingReviewer } from "../src/control/finding-reviewer.js";
import { LlmFindingReviewer } from "../src/control/llm-finding-reviewer.js";

describe("buildFindingReviewer", () => {
  it("returns a FakeFindingReviewer that leaves confidence unchanged with zero real calls when RUNNER=fake", async () => {
    const reviewer = buildFindingReviewer({ RUNNER: "fake" });
    expect(reviewer).toBeInstanceOf(FakeFindingReviewer);
    const result = await reviewer.review({ topic: "x", conclusion: "y", confidence: "medium", sources: [] });
    expect(result).toEqual({ confidence: "medium" });
  });

  it("returns a real LlmFindingReviewer when RUNNER is not fake", () => {
    expect(buildFindingReviewer({})).toBeInstanceOf(LlmFindingReviewer);
  });
});
