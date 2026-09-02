import { describe, expect, it } from "vitest";
import { buildTaskReviewer } from "../src/control/build-task-reviewer.js";
import { FakeTaskReviewer } from "../src/control/task-reviewer.js";
import { LlmTaskReviewer } from "../src/control/llm-task-reviewer.js";

describe("buildTaskReviewer", () => {
  it("returns a FakeTaskReviewer that allows everything with zero real calls when RUNNER=fake", async () => {
    const reviewer = buildTaskReviewer({ RUNNER: "fake" });
    expect(reviewer).toBeInstanceOf(FakeTaskReviewer);
    const result = await reviewer.review({ text: "x", domain: "general", createdBy: "agent:research" });
    expect(result).toEqual({ allowed: true });
  });

  it("returns a real LlmTaskReviewer when RUNNER is not fake", () => {
    expect(buildTaskReviewer({})).toBeInstanceOf(LlmTaskReviewer);
  });
});
