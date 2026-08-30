import type { Reflection } from "./llm-reflection-synthesiser.js";
import { LlmReflectionSynthesiser } from "./llm-reflection-synthesiser.js";

/**
 * Same fake/real switch as buildRouter, buildOutcomeVerifier, and
 * buildSuccessorSuggester, read from the same RUNNER env var — a reflection
 * pass run under RUNNER=fake must consume no subscription quota either, not
 * just routing, grading, and successor proposals. The fake proposes nothing,
 * which is also the correct behaviour for a reflection pass with no real
 * model to synthesise with.
 */
export function buildReflectionSynthesiser(env: NodeJS.ProcessEnv = process.env): (digestText: string) => Promise<Reflection[]> {
  if (env.RUNNER === "fake") {
    return async () => [];
  }
  return new LlmReflectionSynthesiser().synthesise;
}
