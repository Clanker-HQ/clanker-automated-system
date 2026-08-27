import type { AgentDef } from "../registry.js";

export type RunEvent =
  | { type: "assistant"; text: string }
  | { type: "tool_use"; name: string }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number }
  | { type: "error"; message: string }
  | {
      type: "rate_limit_event";
      status: "allowed" | "allowed_warning" | "rejected";
      rateLimitType?: string;
      utilization?: number;
      resetsAt?: number;
    }
  | { type: "parked"; kind: "approval" | "question"; pendingId: string }
  | { type: "denied"; reason: string };

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
