import { truncateForPrompt } from "../truncate.js";
import { retrievalScore } from "./scoring.js";
import { similarity } from "./similarity.js";
import type { MemoryRecord } from "./types.js";

/** Below this, a record is noise rather than context, and padding a prompt with noise costs tokens and attention. */
const RELEVANCE_FLOOR = 0.2;

/**
 * `limit` bounds how many records are injected; nothing bounds how long each
 * body is. This block is prepended to a dispatched agent's prompt and resent
 * on every turn of the run, so one verbose record is paid for repeatedly. The
 * full body stays in the memory log for `recallMemory`.
 */
const MAX_BODY_CHARS = 200;

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
    // A reflection is a cross-cutting conclusion synthesised over every
    // domain at once — the domain it happens to be filed under says where it
    // was drawn from, not who it applies to — so it is exempt from the domain
    // filter that (correctly) partitions raw findings/outcomes/proposals.
    .filter((r) => r.domain === domain || r.kind === "reflection")
    .map((r) => ({ record: r, sim: similarity({ subject }, r) }))
    .filter((s) => s.sim >= RELEVANCE_FLOOR)
    .map((s) => ({
      record: s.record,
      score: retrievalScore({ similarity: s.sim, importance: s.record.importance, ts: s.record.ts }, opts.now, opts.halfLifeDays),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit);

  if (scored.length === 0) return "";
  const lines = scored.map(
    (s) => `- (${s.record.kind}, ${s.record.ts.slice(0, 10)}) ${s.record.subject}: ${truncateForPrompt(s.record.body, MAX_BODY_CHARS)}`,
  );
  return `\n\nWhat this system already knows about this area:\n${lines.join("\n")}`;
}
