export interface ScoringWeights {
  goal: number;
  novelty: number;
  importance: number;
  recency: number;
}

export interface PriorityInput {
  /** 0..1 — the proposal's own stated contribution to the primary goal. */
  goalAlignment: number;
  /** 0..1 — highest similarity to anything already completed. A PENALTY here. */
  maxSimilarity: number;
  /** 1..10, self-assessed. */
  importance: number;
  proposedAt: string;
}

export interface RetrievalInput {
  /** 0..1 — similarity to what the agent is about to work on. A BONUS here. */
  similarity: number;
  importance: number;
  ts: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Human `!task` priority. Nothing computed here may reach it. */
const HUMAN_PRIORITY = 50;

export function recencyDecay(ts: string, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now.getTime() - new Date(ts).getTime()) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Generative Agents scores memory retrieval as recency + importance +
 * relevance. That is right for RETRIEVAL and inverted for PRIORITISATION:
 * when choosing what to work on next, similarity to already-completed work is
 * a penalty, not a bonus. Conflating the two is the easy bug here, which is
 * why they are separate exported functions with separate input types.
 *
 * `goal` carries the largest weight by design — novelty and recency break
 * ties between comparably goal-aligned candidates, they never outvote the goal.
 */
export function priorityScore(input: PriorityInput, weights: ScoringWeights, now: Date): number {
  const total = weights.goal + weights.novelty + weights.importance + weights.recency;
  if (total === 0) return 0;
  const raw =
    weights.goal * clamp01(input.goalAlignment) +
    weights.novelty * (1 - clamp01(input.maxSimilarity)) +
    weights.importance * clamp01((input.importance - 1) / 9) +
    weights.recency * recencyDecay(input.proposedAt, now, 14);
  return clamp01(raw / total);
}

/** Maps a 0..1 score onto the task queue's integer priority, capped below human tasks. */
export function toPriority(score: number): number {
  return Math.min(HUMAN_PRIORITY - 1, Math.max(0, Math.round(clamp01(score) * (HUMAN_PRIORITY - 1))));
}

export function retrievalScore(input: RetrievalInput, now: Date, halfLifeDays: number): number {
  return (
    0.5 * clamp01(input.similarity) +
    0.3 * clamp01((input.importance - 1) / 9) +
    0.2 * recencyDecay(input.ts, now, halfLifeDays)
  );
}
