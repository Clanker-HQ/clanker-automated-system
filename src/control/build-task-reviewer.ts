import { FakeTaskReviewer, type TaskReviewer } from "./task-reviewer.js";
import { LlmTaskReviewer } from "./llm-task-reviewer.js";

/**
 * Same fake/real switch as buildFindingReviewer/buildOutcomeVerifier, read
 * from the same RUNNER env var — a run under RUNNER=fake must consume no
 * subscription quota for task review either, not just for the run itself.
 */
export function buildTaskReviewer(env: NodeJS.ProcessEnv = process.env): TaskReviewer {
  if (env.RUNNER === "fake") {
    return new FakeTaskReviewer({ allowed: true });
  }
  return new LlmTaskReviewer();
}
