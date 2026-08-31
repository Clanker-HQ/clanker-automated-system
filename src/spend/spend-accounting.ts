import { randomUUID } from "node:crypto";
import type { MemoryStore } from "../memory/memory-store.js";
import type { SpendCommitment, SpendState, SpendStore } from "../state/spend-store.js";

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

export interface SpendRequest {
  amountUsd: number;
  recurring: boolean;
  /** Required (non-null) when recurring is true; ignored for a one-off spend. */
  nextRenewalAt: string | null;
  description: string;
  rationale: string;
  /** Self-assessed 1-10, same scale as MemoryRecord.importance. */
  importance: number;
}

export type SpendResult = { recorded: true; state: SpendState } | { recorded: false; reason: string };

/**
 * The one place that turns a spend decision into both persisted state and a
 * memory-log record — see spec, "Design rules": "Every spend is logged to
 * the memory log with its goal rationale, so the reflection pass can
 * evaluate return per euro as a first-class metric."
 */
export async function recordSpend(
  store: SpendStore,
  memory: MemoryStore,
  request: SpendRequest,
): Promise<SpendResult> {
  if (!Number.isFinite(request.amountUsd) || request.amountUsd <= 0) {
    return { recorded: false, reason: `amountUsd must be a positive finite number, got ${request.amountUsd}` };
  }
  if (request.recurring && !request.nextRenewalAt) {
    return { recorded: false, reason: "a recurring spend requires a non-null nextRenewalAt" };
  }

  const state = await store.read();
  let nextState: SpendState;

  if (request.recurring) {
    const commitment: SpendCommitment = {
      id: `spend_${randomUUID().slice(0, 12)}`,
      amountUsd: request.amountUsd,
      recurring: true,
      nextRenewalAt: request.nextRenewalAt,
    };
    if (wouldExhaustBeforeRenewal(state, commitment)) {
      return {
        recorded: false,
        reason: `committing $${request.amountUsd}/cycle would exceed the balance once every recurring commitment is counted`,
      };
    }
    nextState = { ...state, commitments: [...state.commitments, commitment] };
  } else {
    const available = availableToSpendUsd(state);
    if (request.amountUsd > available) {
      return { recorded: false, reason: `$${request.amountUsd} exceeds the $${available} available to spend` };
    }
    nextState = { ...state, balanceUsd: state.balanceUsd - request.amountUsd };
  }

  await store.write(nextState);
  await memory.append({
    domain: "spend",
    kind: "outcome",
    subject: request.description,
    body: request.rationale,
    importance: request.importance,
    createdBy: "system:spend-accounting",
  });

  return { recorded: true, state: nextState };
}
