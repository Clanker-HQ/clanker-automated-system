import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCredentials } from "../runner/credentials.js";
import { toRunEvents } from "../runner/sdk-runner.js";
import type { TaskReview, TaskReviewer, TaskReviewInput } from "./task-reviewer.js";

/** Same reasoning as LlmFindingReviewer's timeout: bounded so a stalled network call
 * here degrades to "allow" instead of blocking a real proposal on infrastructure flakiness. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Parses "refuse: claim rests on a blog roundup" (and the "allow: ..."
 * variant) into a TaskReview. Never throws, and fails open (allowed: true) on
 * anything unparseable or empty — a grading call that goes sideways must not
 * block a real proposal from a run that still has turns left to spend on it;
 * this reviewer's job is catching a confidently ungrounded rationale, not
 * second-guessing every proposal by default.
 */
export function parseTaskReview(raw: string): TaskReview {
  const trimmed = raw.trim();
  if (!trimmed) return { allowed: true };
  const match = trimmed.match(/^(allow|refuse)\b\s*[:\-]?\s*([\s\S]*)$/i);
  if (!match) return { allowed: true };
  const verdict = match[1]!.toLowerCase();
  if (verdict === "allow") return { allowed: true };
  const reason = match[2]!.trim() || "confidence in this task's rationale did not hold up under review";
  return { allowed: false, reason };
}

/**
 * Real review call: one small, cheap, single-turn call — no tools, no
 * workspace, no agentic loop — grading a task proposal's own stated rationale
 * before it's handed to `builder`. Deliberately NOT run through Orchestrator/
 * Governor/RunStore (same posture as LlmFindingReviewer/LlmOutcomeVerifier):
 * this is a classification decision about a proposal, not a task execution,
 * and its own small cost is not tracked against the daily budget.
 */
export class LlmTaskReviewer implements TaskReviewer {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async review(input: TaskReviewInput): Promise<TaskReview> {
    const prompt =
      `A research agent is about to hand this task to the build specialist, which will spend real time ` +
      `and eventually real money (hosting, registration fees) acting on it. Check whether the task's own ` +
      `stated rationale is actually grounded, watching specifically for two problems: (1) a competitive, ` +
      `market, or feasibility claim asserted as settled fact without the task text showing it was checked ` +
      `against a primary source (the actual vendor page, the actual marketplace/store, a technical spike) ` +
      `— a claim resting only on general/assumed knowledge or a secondary summary; (2) hedging language in ` +
      `the task's own text ("assumed", "not yet verified", "unconfirmed", "should be re-checked", "needs a ` +
      `fresh look") describing something the task nonetheless treats as ready to build now.\n\n` +
      `Task domain: ${input.domain}\n\n` +
      `Task text: ${input.text}\n\n` +
      `If the rationale is adequately grounded, reply with exactly "allow: <one-sentence reason>". If ` +
      `either problem applies, reply with "refuse: <one-sentence reason>" naming the specific ungrounded ` +
      `claim. Reply with ONLY "allow" or "refuse", a colon, and the reason. No other text.`;

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
      // Same abort-vs-genuine-rejection split as LlmFindingReviewer: the
      // transport rejects the iterator on abort rather than ending it
      // cleanly, so a timeout surfaces here as a throw, not a quiet end to
      // iteration.
      if (!controller.signal.aborted) throw err;
    } finally {
      clearTimeout(timer);
    }

    return parseTaskReview(answer);
  }
}
