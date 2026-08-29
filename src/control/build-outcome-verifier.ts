import { LlmOutcomeVerifier } from "./llm-outcome-verifier.js";
import { FakeOutcomeVerifier, type OutcomeVerifier } from "./outcome-verifier.js";

/**
 * Same fake/real switch as buildRouter and buildRunner, read from the same
 * RUNNER env var — a run under RUNNER=fake must consume no subscription
 * quota for verification either, not just for the run itself.
 */
export function buildOutcomeVerifier(env: NodeJS.ProcessEnv = process.env): OutcomeVerifier {
  if (env.RUNNER === "fake") {
    return new FakeOutcomeVerifier({ verdict: "achieved", reason: "fake mode — not actually graded" });
  }
  return new LlmOutcomeVerifier();
}
