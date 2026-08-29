import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCredentials } from "../runner/credentials.js";
import { toRunEvents } from "../runner/sdk-runner.js";
import type { OutcomeVerifier, VerificationInput, VerifiedOutcome } from "./outcome-verifier.js";

/** Same reasoning as LlmRouter's timeout: bounded so a stalled network call
 * here degrades to "unclear" instead of hanging the run that's already
 * finished and waiting to report. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Keeps the grading prompt (and its cost) small — the tail is context for
 * the model, not the thing being graded. */
const TAIL_CHAR_BUDGET = 4000;

/**
 * Parses "achieved: found three providers and compared them" (and the
 * not-achieved/unclear variants) into a VerifiedOutcome. Never throws: an
 * empty or unparseable reply falls back to "unclear" with a reason that says
 * so, the same posture toRunEvents already takes toward a malformed SDK
 * message — a grading call that goes sideways must degrade the verdict, not
 * the run that already completed.
 */
export function parseVerdict(raw: string): VerifiedOutcome {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { verdict: "unclear", reason: "the verification call returned no answer" };
  }
  const match = trimmed.match(/^(achieved|not-achieved|unclear)\b\s*[:\-]?\s*([\s\S]*)$/i);
  if (!match) {
    return { verdict: "unclear", reason: `could not parse a verdict from the model's reply: "${trimmed.slice(0, 200)}"` };
  }
  const verdict = match[1]!.toLowerCase() as VerifiedOutcome["verdict"];
  const reason = match[2]!.trim() || "(no reason given)";
  return { verdict, reason };
}

/**
 * Real verification call: one small, cheap, single-turn call — no tools, no
 * workspace, no agentic loop — grading the already-finished run's own prompt
 * and summary. Deliberately NOT run through Orchestrator/Governor/RunStore
 * (same posture as LlmRouter's routing call): this is a classification
 * decision about a run that already happened, not a task execution, and its
 * own small cost is not tracked against the daily budget.
 */
export class LlmOutcomeVerifier implements OutcomeVerifier {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async verify(input: VerificationInput): Promise<VerifiedOutcome> {
    const tailText = input.tail.join("\n").slice(-TAIL_CHAR_BUDGET);
    const prompt =
      `An agent was given a task and its run finished without erroring. Grade whether it ` +
      `actually achieved the task's objective, not just that it ran to completion.\n\n` +
      `Task given to the agent:\n${input.prompt}\n\n` +
      `Agent's own final summary of what it did:\n${input.summary || "(no summary recorded)"}\n\n` +
      (tailText ? `Recent transcript tail:\n${tailText}\n\n` : "") +
      `Reply with ONLY one of "achieved", "not-achieved", or "unclear", followed by a colon and a ` +
      `one-sentence reason, e.g. "achieved: found three providers and compared them as asked". No other text.`;

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

    let answer = "";
    try {
      for await (const message of stream) {
        for (const event of toRunEvents(message)) {
          if (event.type === "assistant" && event.text.trim()) answer = event.text.trim();
        }
      }
    } catch (err) {
      // Same abort-vs-genuine-rejection split as LlmRouter: the transport
      // rejects the iterator on abort rather than ending it cleanly, so a
      // timeout surfaces here as a throw, not a quiet end to iteration.
      if (!controller.signal.aborted) throw err;
    } finally {
      clearTimeout(timer);
    }

    return parseVerdict(answer);
  }
}
