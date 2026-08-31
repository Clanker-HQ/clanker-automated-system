import type { SpendCommitment, SpendState } from "../state/spend-store.js";

function committedRecurringUsd(state: SpendState): number {
  return state.commitments.filter((c) => c.recurring).reduce((sum, c) => sum + c.amountUsd, 0);
}

/**
 * balance − sum(committed recurring). A one-off spend already reduced
 * balanceUsd directly when it was recorded (see recordSpend, Task 6), so it
 * plays no further part here — only standing recurring draws do.
 */
export function availableToSpendUsd(state: SpendState): number {
  return state.balanceUsd - committedRecurringUsd(state);
}

/**
 * True when adding `candidate` as a new recurring commitment would leave the
 * balance unable to cover every committed recurring charge — i.e. it would
 * run out before some commitment's next renewal, not necessarily candidate's
 * own.
 */
export function wouldExhaustBeforeRenewal(state: SpendState, candidate: SpendCommitment): boolean {
  const withCandidate: SpendState = { ...state, commitments: [...state.commitments, candidate] };
  return availableToSpendUsd(withCandidate) < 0;
}
