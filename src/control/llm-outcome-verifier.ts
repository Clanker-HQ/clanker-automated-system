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
 * A run that used at least this fraction of either ceiling (cost or turns)
 * is judged to have stopped at a real resource wall, not to have given up
 * with room to spare. 0.85, not 1.0: a run can be governor-timed-out or
 * self-stop a couple turns short of its literal cap while still being
 * exactly as budget-constrained in practice.
 */
const NEAR_CEILING_FRACTION = 0.85;

/**
 * Tells the grader how much of its resource ceiling a run actually used, and
 * how to weigh that against the task's full scope.
 *
 * Without this, the verifier grades every run against the task's full literal
 * scope with no notion that the run had a fixed turn/budget ceiling — but
 * research's own prompt (agents/research/prompt.md) explicitly instructs it
 * to answer conditionally and flag gaps rather than overrun its budget
 * chasing full coverage. That mismatch is structural, not a quality problem:
 * a multi-part ask ("verify 3 candidates with primary-source rigor") against
 * a budget that only covers one WILL be graded not-achieved on every attempt
 * for the identical reason, since the same ceiling applies to the retry (see
 * dispatcher.ts's RETRY_COST_CAP_MULTIPLIER for the resulting cost this
 * caused on real tasks). Exported standalone so the calibration can be
 * tested without mocking the SDK's query().
 */
export function budgetUtilizationNote(input: VerificationInput): string {
  const { costUsd, maxBudgetUsd, turns, maxTurns } = input;
  const costFraction = costUsd !== undefined && maxBudgetUsd ? costUsd / maxBudgetUsd : undefined;
  const turnFraction = turns !== undefined && maxTurns ? turns / maxTurns : undefined;
  if (costFraction === undefined && turnFraction === undefined) return "";

  const parts: string[] = [];
  if (costFraction !== undefined) {
    parts.push(`$${costUsd!.toFixed(2)} of a $${maxBudgetUsd!.toFixed(2)} budget (${Math.round(costFraction * 100)}%)`);
  }
  if (turnFraction !== undefined) {
    parts.push(`${turns} of a maximum ${maxTurns} turns (${Math.round(turnFraction * 100)}%)`);
  }

  const nearCeiling =
    (costFraction !== undefined && costFraction >= NEAR_CEILING_FRACTION) ||
    (turnFraction !== undefined && turnFraction >= NEAR_CEILING_FRACTION);
  const guidance = nearCeiling
    ? "It stopped at or near its resource ceiling. If its summary honestly flags what it didn't get to, rather than " +
      "overclaiming completeness, grade a scoped-down but accurate partial answer as achieved — reserve " +
      "not-achieved for a claim its own evidence doesn't support, or a gap it never acknowledged."
    : "It stopped well short of its resource ceiling, so a real gap here reflects the agent giving up early, not " +
      "running out of room.";

  return `This run used ${parts.join(", ")}. ${guidance}`;
}

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
    const budgetNote = budgetUtilizationNote(input);
    const prompt =
      `An agent was given a task and its run finished without erroring. Grade whether it ` +
      `actually achieved the task's objective, not just that it ran to completion.\n\n` +
      `Task given to the agent:\n${input.prompt}\n\n` +
      `Agent's own final summary of what it did:\n${input.summary || "(no summary recorded)"}\n\n` +
      (budgetNote ? `${budgetNote}\n\n` : "") +
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
