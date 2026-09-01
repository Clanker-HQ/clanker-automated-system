import type { PortfolioEntry } from "./world-model.js";

/** A review may extend an entry this many times before only killing it remains available. */
export const MAX_EXTENSIONS = 2;

/**
 * Entries whose review date has passed, most-overdue first. Pure over data
 * the caller already has (buildPromptContext reads the portfolio for grading
 * anyway) — no WorldModel, no I/O, so it's testable without a temp directory.
 *
 * A killed entry is never due, however overdue its date: killing is
 * terminal, and re-surfacing a killed product every review would train
 * whoever reads this to ignore the section entirely.
 */
export function dueReviews(portfolio: PortfolioEntry[], now: Date): PortfolioEntry[] {
  return portfolio
    .filter((entry) => entry.status !== "killed")
    .filter((entry) => new Date(entry.nextReviewAt).getTime() <= now.getTime())
    .sort((a, b) => new Date(a.nextReviewAt).getTime() - new Date(b.nextReviewAt).getTime());
}

/**
 * Whether this entry may still be extended rather than killed at its next
 * review. `extensionCount` reads back `undefined` on any entry persisted
 * before this field existed (see world-model.ts) — treated the same as 0
 * here, otherwise a pre-existing product would read as permanently
 * un-extendable the first time this ships, with no way to reach that state
 * honestly through a review.
 */
export function canExtend(entry: PortfolioEntry): boolean {
  return (entry.extensionCount ?? 0) < MAX_EXTENSIONS;
}
