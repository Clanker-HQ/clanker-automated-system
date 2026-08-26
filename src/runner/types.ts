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
}

export interface Runner {
  execute(agent: AgentDef, ctx: RunContext, signal: AbortSignal): AsyncIterable<RunEvent>;
}
