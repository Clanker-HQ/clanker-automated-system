import type { SuccessorSuggester } from "../memory/successor.js";
import { LlmSuccessorSuggester } from "./llm-successor-suggester.js";

/**
 * Same fake/real switch as buildRouter and buildOutcomeVerifier, read from
 * the same RUNNER env var — a dispatcher run under RUNNER=fake must consume
 * no subscription quota proposing successors either, not just routing and
 * grading. The fake proposes nothing, which is also the correct behavior for
 * a successor pass with no real work to react to.
 */
export function buildSuccessorSuggester(env: NodeJS.ProcessEnv = process.env): SuccessorSuggester {
  if (env.RUNNER === "fake") {
    return async () => [];
  }
  return new LlmSuccessorSuggester().suggest;
}
