import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SuccessorSuggestion } from "../memory/successor.js";
import { resolveCredentials } from "../runner/credentials.js";
import { toRunEvents } from "../runner/sdk-runner.js";

/**
 * Same bound as LlmRouter's DEFAULT_TIMEOUT_MS, and for the same reason: a
 * stalled call here would otherwise block whatever's awaiting
 * proposeSuccessors indefinitely, on top of the run it followed.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** importance is self-assessed 1..10 (see MemoryRecord); goalAlignment is 0..1. */
function isValidSuggestion(value: unknown): value is SuccessorSuggestion {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.text === "string" && v.text.trim() !== "" &&
    typeof v.domain === "string" && v.domain.trim() !== "" &&
    typeof v.subject === "string" && v.subject.trim() !== "" &&
    typeof v.importance === "number" && Number.isFinite(v.importance) && v.importance >= 1 && v.importance <= 10 &&
    typeof v.goalAlignment === "number" && Number.isFinite(v.goalAlignment) && v.goalAlignment >= 0 && v.goalAlignment <= 1
  );
}

/**
 * A cheap model asked for "JSON only, no fences" still occasionally wraps its
 * answer in a ```json ... ``` block anyway — stripping one off before
 * JSON.parse is a cheap way to avoid throwing away an otherwise-good answer
 * over a formatting tic. Anything else unparseable still throws here, which
 * the caller turns into [].
 */
function stripCodeFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]! : text;
}

/**
 * Parses the model's reply as a JSON array and keeps only well-shaped items —
 * a malformed entry is dropped rather than passed through for
 * proposeSuccessors to choke on, matching how the rest of the pass tolerates
 * bad input over crashing on it.
 */
function parseSuggestions(answer: string): SuccessorSuggestion[] {
  const parsed: unknown = JSON.parse(stripCodeFence(answer.trim()));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidSuggestion);
}

/**
 * Production SuccessorSuggester: one small, cheap, single-turn call — no
 * tools, no workspace, no agentic loop — same shape as LlmRouter's routing
 * call, just asking for structured JSON instead of a single specialist name
 * because a successor suggestion carries several independent fields
 * (text/domain/subject/importance/goalAlignment) that a bare name can't.
 *
 * Never throws: on ANY failure — timeout, non-JSON reply, wrong shape, a
 * thrown error from the SDK call itself — this returns [], the same way
 * LlmRouter degrades to null rather than propagating. proposeSuccessors has
 * its own try/catch as a backstop, but this suggester is defensive on its
 * own terms too, since a wedged suggester should cost nothing more than
 * "no successors this time," never a dispatcher-wide failure.
 *
 * `suggest` is an arrow-function instance field (not a prototype method) so
 * it can be handed around as a bare function value — `new
 * LlmSuccessorSuggester().suggest` — and still keep `this.timeoutMs` bound
 * correctly when called later as `deps.suggestSuccessors(summary)`.
 */
export class LlmSuccessorSuggester {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  suggest = async (summary: string): Promise<SuccessorSuggestion[]> => {
    const prompt =
      `A piece of work just finished. Decide whether any follow-up tasks are worth queuing next.\n\n` +
      `What was done: ${summary}\n\n` +
      `Propose 0 to 3 successor tasks — fewer is fine, and an empty list is the right answer when nothing ` +
      `concrete follows from this. Reply with ONLY a JSON array (no other text, no markdown fences), where ` +
      `each element has exactly these fields:\n` +
      `  "text": the task's full instruction text (string)\n` +
      `  "domain": a short category tag partitioning this from unrelated work, e.g. "research" (string)\n` +
      `  "subject": a one-line canonical summary of what the task is about (string)\n` +
      `  "importance": self-assessed importance toward the goal, 1-10 (number)\n` +
      `  "goalAlignment": self-assessed contribution to the primary goal, 0-1 (number)\n\n` +
      `Reply with "[]" if nothing concrete follows from this work.`;

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
        // Same reasoning as LlmRouter: the real SDK transport rejects the
        // async iterator on abort() rather than ending it quietly, so a
        // timeout surfaces here as a throw. Anything already captured in
        // `answer` before that is kept; any other rejection reason still
        // propagates to the outer catch below, which turns it into [].
        if (!controller.signal.aborted) throw err;
      } finally {
        clearTimeout(timer);
      }

      if (!answer) return [];
      return parseSuggestions(answer);
    } catch (error) {
      console.error("[successor-suggester] suggestion call failed; proposing nothing", error);
      return [];
    }
  };
}
