import { describe, expect, it } from "vitest";
import { buildRouter } from "../src/control/build-router.js";
import { LlmRouter } from "../src/control/llm-router.js";
import { FakeRouter } from "../src/control/router.js";

describe("buildRouter", () => {
  it("returns a FakeRouter that picks the first specialist when RUNNER=fake", async () => {
    const router = buildRouter({ RUNNER: "fake" });
    expect(router).toBeInstanceOf(FakeRouter);
    const result = await router.route("anything", [{ name: "research", description: "d" }]);
    expect(result).toBe("research");
  });

  it("returns a real LlmRouter when RUNNER is not fake", () => {
    expect(buildRouter({})).toBeInstanceOf(LlmRouter);
  });
});
