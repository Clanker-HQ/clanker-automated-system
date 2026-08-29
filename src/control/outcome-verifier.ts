export interface VerifiedOutcome {
  verdict: "achieved" | "not-achieved" | "unclear";
  reason: string;
}

export interface VerificationInput {
  /** The task prompt the agent was given — the objective being graded against. */
  prompt: string;
  /** The agent's own final summary of what it did. */
  summary: string;
  /** The last few transcript lines, for a call that needs more than the summary alone. */
  tail: string[];
}

/**
 * Grades whether a run that the SDK reported as "success" (finished without
 * erroring) actually achieved the task it was given — a run finishing clean
 * says nothing about whether the agent's objective was met. Only ever called
 * for status "success" (see Orchestrator.runAndRecord); a failed/timeout/
 * parked run already carries its own, more specific signal.
 */
export interface OutcomeVerifier {
  verify(input: VerificationInput): Promise<VerifiedOutcome>;
}

/** Test double: a fixed answer or a computed one, with zero real LLM calls. */
export class FakeOutcomeVerifier implements OutcomeVerifier {
  calls: VerificationInput[] = [];

  constructor(
    private readonly respond: VerifiedOutcome | ((input: VerificationInput) => VerifiedOutcome),
  ) {}

  async verify(input: VerificationInput): Promise<VerifiedOutcome> {
    this.calls.push(input);
    return typeof this.respond === "function" ? this.respond(input) : this.respond;
  }
}
