import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCredentials } from "../runner/credentials.js";
import { toRunEvents } from "../runner/sdk-runner.js";
import type { FindingConfidence, FindingReview, FindingReviewer, ReviewInput } from "./finding-reviewer.js";

/** Same reasoning as LlmOutcomeVerifier's timeout: bounded so a stalled network call
 * here degrades to "keep the given confidence" instead of hanging a tool call. */
const DEFAULT_TIMEOUT_MS = 60_000;

const LEVEL_RANK: Record<FindingConfidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * Parses "low: sourced only from a roundup blog" (and the medium/high
 * variants) into a FindingReview, given the confidence `research` originally
 * claimed. Never throws and never raises confidence above what was given —
 * this reviewer's only job is catching overclaiming, not second-guessing
 * appropriate caution. An empty, unparseable, or (were it to happen) a
 * higher-than-given reply all fall back to the given confidence unchanged,
 * the same "a grading call that goes sideways must not corrupt the result"
 * posture parseVerdict takes toward "unclear".
 */
export function parseReview(raw: string, given: FindingConfidence): FindingReview {
  const trimmed = raw.trim();
  if (!trimmed) return { confidence: given };
  const match = trimmed.match(/^(low|medium|high)\b\s*[:\-]?\s*([\s\S]*)$/i);
  if (!match) return { confidence: given };
  const confidence = match[1]!.toLowerCase() as FindingConfidence;
  if (LEVEL_RANK[confidence] >= LEVEL_RANK[given]) return { confidence: given };
  const note = match[2]!.trim() || "confidence downgraded by automated review";
  return { confidence, note };
}

/**
 * Real review call: one small, cheap, single-turn call — no tools, no
 * workspace, no agentic loop — grading a finding `research` just recorded
 * against its own sources. Deliberately NOT run through Orchestrator/
 * Governor/RunStore (same posture as LlmOutcomeVerifier): this is a
 * classification decision about a finding that already happened, not a task
 * execution, and its own small cost is not tracked against the daily budget.
 */
export class LlmFindingReviewer implements FindingReviewer {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async review(input: ReviewInput): Promise<FindingReview> {
    const sourcesText = input.sources.length > 0 ? input.sources.join(", ") : "(none listed)";
    const prompt =
      `A research agent recorded a finding with a self-assigned confidence level. Check whether that ` +
      `confidence is actually earned, watching specifically for two problems: (1) a factual or ` +
      `competitive claim that rests on secondary/aggregator sources (a blog roundup, a "best X" ` +
      `listicle, a review site) when checking the primary source directly (the vendor's own page, the ` +
      `actual marketplace/store listing, official documentation) was clearly possible and would settle ` +
      `the claim, with no sign that was done; (2) the conclusion's own text contains unresolved hedging ` +
      `inconsistent with its stated confidence — phrases like "not verified", "unconfirmed", "assumed", ` +
      `"needs to be re-checked", "flag for follow-up" describing something the conclusion still treats ` +
      `as established fact.\n\n` +
      `Topic: ${input.topic}\n\n` +
      `Stated confidence: ${input.confidence}\n\n` +
      `Conclusion: ${input.conclusion}\n\n` +
      `Sources: ${sourcesText}\n\n` +
      `If the stated confidence is earned, reply with exactly the same level, e.g. "${input.confidence}: holds". ` +
      `If either problem applies, reply with a LOWER confidence level than stated (never higher) and a ` +
      `one-sentence reason, e.g. "low: claim about competitor pricing sourced only from a roundup blog, ` +
      `not the vendor's own page". Reply with ONLY the level, a colon, and the reason. No other text.`;

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
      // Same abort-vs-genuine-rejection split as LlmOutcomeVerifier: the
      // transport rejects the iterator on abort rather than ending it
      // cleanly, so a timeout surfaces here as a throw, not a quiet end to
      // iteration.
      if (!controller.signal.aborted) throw err;
    } finally {
      clearTimeout(timer);
    }

    return parseReview(answer, input.confidence);
  }
}
