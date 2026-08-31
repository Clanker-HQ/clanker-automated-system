import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCredentials } from "../runner/credentials.js";
import { toRunEvents } from "../runner/sdk-runner.js";

/**
 * Same bound as LlmRouter's/LlmSuccessorSuggester's DEFAULT_TIMEOUT_MS, and
 * for the same reason: a stalled call here would otherwise block the weekly
 * reflection pass indefinitely rather than just costing it "no conclusions
 * this week."
 */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface Reflection {
  domain: string;
  subject: string;
  body: string;
  importance: number;
}

/** importance is self-assessed 1..10, same convention as MemoryRecord/SuccessorSuggestion. */
function isValidReflection(value: unknown): value is Reflection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.domain === "string" && v.domain.trim() !== "" &&
    typeof v.subject === "string" && v.subject.trim() !== "" &&
    typeof v.body === "string" && v.body.trim() !== "" &&
    typeof v.importance === "number" && Number.isFinite(v.importance) && v.importance >= 1 && v.importance <= 10
  );
}

/**
 * A cheap model asked for "JSON only, no fences" still occasionally wraps its
 * answer in a ```json ... ``` block anyway — stripping one off before
 * JSON.parse is a cheap way to avoid throwing away an otherwise-good answer
 * over a formatting tic. Anything still unparseable after this is handled by
 * parseReflections's own catch, below.
 *
 * Duplicated from llm-successor-suggester.ts's private helper of the same
 * name rather than shared: it's a few lines, and this file has no other
 * reason to import from that one.
 */
function stripCodeFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]! : text;
}

/**
 * Parses the model's reply as a JSON array and keeps only well-shaped items —
 * a malformed entry is dropped rather than passed through for runReflection
 * to choke on, matching how the rest of the pass tolerates bad input over
 * crashing on it.
 *
 * Never throws — same never-fail posture as parseVerdict in
 * llm-outcome-verifier.ts and parseSuggestions in llm-successor-suggester.ts,
 * and exported standalone for the same reason: unit testable with plain
 * strings, no SDK mocking required. Unparseable JSON is logged (never silent)
 * and degrades to [], the "no conclusions this pass" answer.
 */
export function parseReflections(answer: string): Reflection[] {
  const trimmed = answer.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(trimmed));
  } catch (error) {
    console.error("[reflection-synthesiser] could not parse reflections as JSON", error);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidReflection);
}

/**
 * Production ReflectionSynthesiser: one small, cheap, single-turn call — no
 * tools, no workspace, no agentic loop — same shape as LlmRouter's routing
 * call and LlmSuccessorSuggester's suggestion call, asking for structured
 * JSON because a conclusion carries several independent fields
 * (domain/subject/body/importance) that a bare string can't.
 *
 * Never throws: on ANY failure — timeout, non-JSON reply, wrong shape, a
 * thrown error from the SDK call itself — this returns [], the same way
 * LlmSuccessorSuggester degrades to [] rather than propagating. runReflection
 * has its own try/catch as a backstop, but this synthesiser is defensive on
 * its own terms too, since a wedged synthesiser should cost nothing more than
 * "no conclusions this week," never a failed batch job.
 *
 * `synthesise` is an arrow-function instance field (not a prototype method)
 * so it can be handed around as a bare function value — `new
 * LlmReflectionSynthesiser().synthesise` — and still keep `this.timeoutMs`
 * bound correctly when called later as `deps.synthesise(digestText)`.
 */
export class LlmReflectionSynthesiser {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  synthesise = async (digestText: string): Promise<Reflection[]> => {
    const prompt =
      `Below is a digest of recent outcomes and run results from an autonomous agent system. Look for ` +
      `higher-level patterns worth remembering — recurring failure modes, approaches that keep working, or ` +
      `gaps in what's being attempted — rather than restating individual entries.\n\n` +
      `Digest:\n${digestText}\n\n` +
      `Propose 0 to 5 conclusions — fewer is fine, and an empty list is the right answer when nothing rises ` +
      `above the individual entries. Reply with ONLY a JSON array (no other text, no markdown fences), where ` +
      `each element has exactly these fields:\n` +
      `  "domain": a short category tag partitioning this from unrelated work, e.g. "research" (string)\n` +
      `  "subject": a one-line canonical summary of the conclusion (string)\n` +
      `  "body": the conclusion itself, in enough detail to be useful later (string)\n` +
      `  "importance": self-assessed importance toward future decisions, 1-10 (number)\n\n` +
      `Reply with "[]" if nothing in the digest rises to the level of a durable conclusion.`;

    let answer = "";
    try {
      const { childEnv } = resolveCredentials();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const stream = query({
        prompt,
        options: {
          model: "claude-haiku-4-5",
          effort: "low",
          maxTurns: 1,
          maxBudgetUsd: 0.05,
          cwd: process.cwd(),
          allowedTools: [],
          disallowedTools: [],
          tools: [],
          permissionMode: "default",
          settingSources: [],
          env: childEnv,
          abortController: controller,
        },
      });

      try {
        for await (const message of stream) {
          for (const event of toRunEvents(message)) {
            if (event.type === "assistant" && event.text.trim()) answer = event.text.trim();
          }
        }
      } catch (err) {
        // Same reasoning as LlmRouter/LlmSuccessorSuggester: the real SDK
        // transport rejects the async iterator on abort() rather than ending
        // it quietly, so a timeout surfaces here as a throw. Anything already
        // captured in `answer` before that is kept; any other rejection
        // reason still propagates to the outer catch below, which turns it
        // into [].
        if (!controller.signal.aborted) throw err;
      } finally {
        clearTimeout(timer);
      }

      return parseReflections(answer);
    } catch (error) {
      console.error("[reflection-synthesiser] synthesis call failed; proposing nothing", error);
      return [];
    }
  };
}
