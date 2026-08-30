import type { RunResult } from "../run-store.js";
import type { MemoryStore } from "./memory-store.js";
import type { MemoryRecord } from "./types.js";

export interface ReflectionInput {
  memory: MemoryStore;
  runs: RunResult[];
  synthesise: (digestText: string) => Promise<Array<{ domain: string; subject: string; body: string; importance: number }>>;
  now: Date;
}

/**
 * Generative Agents' second mechanism: periodically synthesise raw memories
 * into higher-level conclusions that then influence future behaviour.
 *
 * This is the closest thing in the system to cross-cutting judgment about what
 * to focus on — deliberately shaped as a periodic batch job whose output is
 * advisory DATA other components read, rather than a standing authority every
 * task must route through. See the spec's Non-goals for why not a manager
 * agent.
 *
 * Reflections are APPENDED. A newer reflection supersedes an older one by
 * recency; nothing is ever rewritten in place, because LLM-rewritten memory
 * degrades over successive updates.
 */
export async function runReflection(input: ReflectionInput): Promise<MemoryRecord[]> {
  try {
    const records = await input.memory.list();
    const outcomes = records.filter((r) => r.kind === "outcome");
    if (outcomes.length === 0 && input.runs.length === 0) return [];

    const digestText = [
      ...outcomes.map((r) => `[${r.domain}] ${r.subject} → ${r.verdict ?? "unknown"}: ${r.body}`),
      // Includes the verifier's reason (not just its verdict) — a bare
      // "not-achieved" tells the synthesiser nothing about WHY, and the
      // reason is exactly the detail a conclusion like "X keeps failing
      // because of Y" would need to draw on.
      ...input.runs.map((r) => {
        const outcome = r.verifiedOutcome;
        const graded = outcome ? `${outcome.verdict}: ${outcome.reason}` : "ungraded";
        return `[run:${r.agent}] ${r.status} (${graded}): ${r.summary}`;
      }),
    ].join("\n");

    const conclusions = await input.synthesise(digestText);
    const written: MemoryRecord[] = [];
    for (const conclusion of conclusions) {
      written.push(
        await input.memory.append({
          domain: conclusion.domain,
          kind: "reflection",
          subject: conclusion.subject,
          body: conclusion.body,
          importance: conclusion.importance,
          createdBy: "system:reflection",
          ts: input.now.toISOString(),
        }),
      );
    }
    return written;
  } catch (error) {
    console.error("[reflection] pass failed", error);
    return [];
  }
}
