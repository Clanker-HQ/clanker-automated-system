export interface TaskReview {
  allowed: boolean;
  /** Set when allowed is false — the reason handed back to the calling agent so it can revise or drop the proposal. */
  reason?: string;
}

export interface TaskReviewInput {
  text: string;
  domain: string;
  subject?: string;
  createdBy: string;
}

/**
 * Grades whether a task's own stated rationale is grounded enough to hand to
 * `builder` — the same posture as `FindingReviewer` grading a finding's
 * confidence against its sources, applied at the moment real build time (and
 * eventually real spend: hosting, registration fees) is about to be
 * committed. Unlike `FindingReviewer`, this one can actually refuse: queueTask
 * fires mid-run, while the calling agent still has turns and budget left to
 * revise or drop the proposal, so there is no need to let a poorly-grounded
 * idea through and only flag it after the fact.
 */
export interface TaskReviewer {
  review(input: TaskReviewInput): Promise<TaskReview>;
}

/** Test double: a fixed answer or a computed one, with zero real LLM calls. */
export class FakeTaskReviewer implements TaskReviewer {
  calls: TaskReviewInput[] = [];

  constructor(
    private readonly respond: TaskReview | ((input: TaskReviewInput) => TaskReview),
  ) {}

  async review(input: TaskReviewInput): Promise<TaskReview> {
    this.calls.push(input);
    return typeof this.respond === "function" ? this.respond(input) : this.respond;
  }
}
