import type { Metrics } from "./metrics-store.js";

export interface ProbationOptions {
  /** Below this many graded runs, the rate is noise rather than evidence. */
  minRuns: number;
  /** At or above this not-achieved rate, the agent is not doing its job. */
  maxNotAchievedRate: number;
}

/**
 * Which agents have earned an automatic disable. Pure — the caller does the
 * writing, so this stays trivially testable and the policy stays in one place.
 *
 * This is deliberately a different signal from the circuit breaker
 * (src/state/breaker.ts), which counts consecutive HARD failures. An agent
 * whose every run finishes "success" while the verifier grades it
 * "not-achieved" never trips the breaker, and before this function existed
 * nothing else looked at that case either.
 */
export function evaluateProbation(metrics: Metrics, opts: ProbationOptions): string[] {
  return metrics.notAchievedByAgent
    .filter((a) => a.successRunCount >= opts.minRuns && a.rate >= opts.maxNotAchievedRate)
    .map((a) => a.agent);
}
