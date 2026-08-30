import { retrievalScore } from "./scoring.js";
import { similarity } from "./similarity.js";
import type { MemoryRecord } from "./types.js";

/** Below this, a record is noise rather than context, and padding a prompt with noise costs tokens and attention. */
const RELEVANCE_FLOOR = 0.2;

/**
 * Builds the "what do I already know about this?" block prepended to a
 * dispatched agent's prompt. Unlike the novelty gate, similarity is a BONUS
 * here and reflections are included — a synthesised conclusion is exactly the
 * kind of thing an agent should start a run knowing.
 */
export function retrieveContext(
  subject: string,
  domain: string,
  records: MemoryRecord[],
  opts: { limit: number; halfLifeDays: number; now: Date },
): string {
  const scored = records
    .filter((r) => r.domain === domain)
    .map((r) => ({ record: r, sim: similarity({ subject }, r) }))
    .filter((s) => s.sim >= RELEVANCE_FLOOR)
    .map((s) => ({
      record: s.record,
      score: retrievalScore({ similarity: s.sim, importance: s.record.importance, ts: s.record.ts }, opts.now, opts.halfLifeDays),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit);

  if (scored.length === 0) return "";
  const lines = scored.map((s) => `- (${s.record.kind}, ${s.record.ts.slice(0, 10)}) ${s.record.subject}: ${s.record.body}`);
  return `\n\nWhat this system already knows about this area:\n${lines.join("\n")}`;
}
