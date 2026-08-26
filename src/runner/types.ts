import type { AgentDef } from "../registry.js";

export type RunEvent =
  | { type: "assistant"; text: string }
  | { type: "tool_use"; name: string }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number }
  | { type: "error"; message: string };

export interface RunContext {
  runId: string;
  workspace: string;
  prompt: string;
}

export interface Runner {
  execute(agent: AgentDef, ctx: RunContext, signal: AbortSignal): AsyncIterable<RunEvent>;
}
