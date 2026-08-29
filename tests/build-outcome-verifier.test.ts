import { describe, expect, it } from "vitest";
import { buildOutcomeVerifier } from "../src/control/build-outcome-verifier.js";
import { LlmOutcomeVerifier } from "../src/control/llm-outcome-verifier.js";
import { FakeOutcomeVerifier } from "../src/control/outcome-verifier.js";

describe("buildOutcomeVerifier", () => {
  it("returns a FakeOutcomeVerifier that grades 'achieved' with zero real calls when RUNNER=fake", async () => {
    const verifier = buildOutcomeVerifier({ RUNNER: "fake" });
    expect(verifier).toBeInstanceOf(FakeOutcomeVerifier);
    const result = await verifier.verify({ prompt: "x", summary: "y", tail: [] });
    expect(result.verdict).toBe("achieved");
  });

  it("returns a real LlmOutcomeVerifier when RUNNER is not fake", () => {
    expect(buildOutcomeVerifier({})).toBeInstanceOf(LlmOutcomeVerifier);
  });
});
