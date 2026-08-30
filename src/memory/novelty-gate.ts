import { similarity, type Comparable } from "./similarity.js";
import type { MemoryRecord } from "./types.js";

export interface NoveltyOptions {
  threshold: number;
  stalenessDays: number;
  now: Date;
}

export type NoveltyVerdict =
  | { kind: "novel"; maxSimilarity: number }
  | { kind: "suppressed"; priorId: string; maxSimilarity: number }
  | { kind: "retry"; priorId: string; maxSimilarity: number; priorReason?: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decides whether a proposal covers ground the system has already covered.
 *
 * Only `finding` and `outcome` records are compared against — a `proposal` is
 * work that has not run yet (suppressing against it would block work purely
 * because it was suggested twice), and a `reflection` is a synthesised
 * conclusion, not a piece of work.
 *
 * A prior that is fresh AND was actually achieved suppresses. Anything else
 * — stale, or graded not-achieved/unclear — is allowed through as a retry
 * carrying the prior's own record, so the next attempt is informed rather
 * than blind.
 */
export function assessNovelty(
  candidate: Comparable & { domain: string },
  records: MemoryRecord[],
  opts: NoveltyOptions,
): NoveltyVerdict {
  let best: { record: MemoryRecord; score: number } | null = null;
  for (const record of records) {
    if (record.domain !== candidate.domain) continue;
    if (record.kind !== "outcome" && record.kind !== "finding") continue;
    const score = similarity(candidate, record);
    if (!best || score > best.score) best = { record, score };
  }

  if (!best || best.score <= opts.threshold) {
    return { kind: "novel", maxSimilarity: best?.score ?? 0 };
  }

  const ageDays = (opts.now.getTime() - new Date(best.record.ts).getTime()) / DAY_MS;
  const isStale = ageDays > opts.stalenessDays;
  if (!isStale && best.record.verdict === "achieved") {
    return { kind: "suppressed", priorId: best.record.id, maxSimilarity: best.score };
  }
  return {
    kind: "retry",
    priorId: best.record.id,
    maxSimilarity: best.score,
    ...(best.record.body ? { priorReason: best.record.body } : {}),
  };
}
