/**
 * `finding` — something learned (a research result, an audit finding).
 * `proposal` — work suggested but not yet done.
 * `outcome` — what actually happened when work ran, carrying its verdict.
 * `reflection` — a periodic higher-level conclusion synthesised from the above.
 */
export type MemoryKind = "finding" | "proposal" | "outcome" | "reflection";

export interface MemoryRecord {
  id: string;
  ts: string;
  /** Partitions similarity checks so an npm advisory is never compared to a revenue prospect. */
  domain: string;
  kind: MemoryKind;
  /** One canonical line, and the only field similarity compares. */
  subject: string;
  /** A natural key where the domain has one (package name, file path, repo) — an exact match short-circuits similarity to 1. */
  key?: string;
  body: string;
  /** Self-assessed 1-10, meaning importance TOWARD THE GOAL, not intrinsic interest. */
  importance: number;
  createdBy: string;
  sourceRunId?: string;
  sourceTaskId?: string;
  verdict?: "achieved" | "not-achieved" | "unclear";
  /** How many successor hops produced this. Root work is 0. Bounds runaway self-propagation. */
  chainDepth: number;
}

export type MemoryInput = Omit<MemoryRecord, "id" | "ts" | "chainDepth"> &
  Partial<Pick<MemoryRecord, "ts" | "chainDepth">>;
