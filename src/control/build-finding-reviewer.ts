import { FakeFindingReviewer, type FindingReviewer } from "./finding-reviewer.js";
import { LlmFindingReviewer } from "./llm-finding-reviewer.js";

/**
 * Same fake/real switch as buildOutcomeVerifier, read from the same RUNNER
 * env var — a run under RUNNER=fake must consume no subscription quota for
 * finding review either, not just for the run itself.
 */
export function buildFindingReviewer(env: NodeJS.ProcessEnv = process.env): FindingReviewer {
  if (env.RUNNER === "fake") {
    return new FakeFindingReviewer((input) => ({ confidence: input.confidence }));
  }
  return new LlmFindingReviewer();
}
