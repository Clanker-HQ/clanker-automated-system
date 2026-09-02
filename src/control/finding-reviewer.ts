export type FindingConfidence = "low" | "medium" | "high";

export interface FindingReview {
  confidence: FindingConfidence;
  /** Set only when this differs from the confidence research itself gave — the one-line reason to surface, so a downgrade isn't silent. */
  note?: string;
}

export interface ReviewInput {
  topic: string;
  conclusion: string;
  confidence: FindingConfidence;
  sources: string[];
}

/**
 * Grades whether a finding `research` just recorded actually earns its
 * self-assigned confidence — the same posture as `OutcomeVerifier` grading a
 * run's summary against its prompt, applied to a finding's conclusion against
 * its sources instead. Never re-does the research; it only checks whether the
 * confidence label is honest given what's there.
 */
export interface FindingReviewer {
  review(input: ReviewInput): Promise<FindingReview>;
}

/** Test double: a fixed answer or a computed one, with zero real LLM calls. */
export class FakeFindingReviewer implements FindingReviewer {
  calls: ReviewInput[] = [];

  constructor(
    private readonly respond: FindingReview | ((input: ReviewInput) => FindingReview),
  ) {}

  async review(input: ReviewInput): Promise<FindingReview> {
    this.calls.push(input);
    return typeof this.respond === "function" ? this.respond(input) : this.respond;
  }
}
