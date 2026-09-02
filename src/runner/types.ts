import type { AgentDef } from "../registry.js";

export type RunEvent =
  | { type: "assistant"; text: string }
  | { type: "tool_use"; name: string }
  | { type: "tool_result"; name: string; ok: boolean }
  /**
   * `inputTokens` is UNCACHED input only. The cached prefix is re-read on
   * every turn and counted separately — leaving it out under-reports the
   * traffic a run actually moves against the rolling rate-limit window.
   */
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      costUsd: number;
      durationMs: number;
    }
  | { type: "error"; message: string }
  /**
   * The run was stopped by the system because its environment stopped working
   * — not because the agent did anything wrong. Maps to RunStatus
   * "interrupted", which `BreakerStore`'s FAILURE_STATUSES deliberately
   * excludes: a broken dependency must not disable the agent that happened to
   * be running when it broke.
   */
  | { type: "interrupted"; reason: string }
  | {
      type: "rate_limit_event";
      status: "allowed" | "allowed_warning" | "rejected";
      rateLimitType?: string;
      utilization?: number;
      resetsAt?: number;
    }
  | { type: "parked"; kind: "approval" | "question"; pendingId: string }
  | { type: "denied"; reason: string }
  /**
   * The SDK's own auto-compaction fired mid-run (settings.autoCompactWindow
   * in SdkRunner, currently set for `research` only), replacing older
   * conversation content with a summary. `postTokens` is absent when the
   * SDK's message didn't report it, not when compaction produced zero.
   */
  | { type: "compacted"; trigger: "manual" | "auto"; preTokens: number; postTokens?: number };

export interface RunContext {
  runId: string;
  workspace: string;
  prompt: string;
  resume?: string;
  /**
   * Ids of grants already approved by a human earlier in THIS run (across
   * park/resume cycles). `canUseTool` in SdkRunner checks this before
   * parking again for the same grant — without it, a resumed agent that
   * retries the exact outward effect it was just approved for parks again,
   * looping approve -> resume -> retry -> park forever. Absent on a fresh
   * (non-resumed) run, where there is nothing yet to have approved.
   */
  approvedGrantRefs?: string[];
}

export interface Runner {
  execute(agent: AgentDef, ctx: RunContext, signal: AbortSignal): AsyncIterable<RunEvent>;
}
