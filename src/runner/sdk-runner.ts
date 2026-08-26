import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDef } from "../registry.js";
import { resolveCredentials } from "./credentials.js";
import type { RunContext, RunEvent, Runner } from "./types.js";

function textOf(message: Record<string, unknown>): string {
  const content = (message.message as { content?: unknown } | undefined)?.content
    ?? message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
      .map((b) => b.text)
      .join("");
  }
  return "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Maps one SDK message to a RunEvent, or null for messages we do not record. */
export function toRunEvent(message: unknown): RunEvent | null {
  const m = message as Record<string, unknown>;
  switch (m.type) {
    case "assistant": {
      const text = textOf(m);
      return text.trim() ? { type: "assistant", text } : null;
    }
    case "tool_use":
      return { type: "tool_use", name: String(m.name ?? "unknown") };
    case "tool_result":
      return { type: "tool_result", name: String(m.name ?? "unknown"), ok: m.is_error !== true };
    case "usage":
    case "result": {
      const usage = (m.usage as Record<string, unknown> | undefined) ?? m;
      return {
        type: "usage",
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        costUsd: num(m.total_cost_usd ?? usage.total_cost_usd),
        durationMs: num(m.session_duration_ms ?? m.duration_ms),
      };
    }
    default:
      return null;
  }
}

export class SdkRunner implements Runner {
  async *execute(
    agent: AgentDef,
    ctx: RunContext,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    const { childEnv } = resolveCredentials();
    const controller = new AbortController();
    signal.addEventListener("abort", () => controller.abort(), { once: true });

    const stream = query({
      prompt: ctx.prompt,
      options: {
        model: agent.run.model,
        effort: agent.run.effort,
        maxTurns: agent.run.maxTurns,
        maxBudgetUsd: agent.run.maxBudgetUsd,
        cwd: ctx.workspace,
        allowedTools: agent.permissions.allowedTools,
        disallowedTools: agent.permissions.disallowedTools,
        permissionMode: "default",
        settingSources: [],
        env: childEnv,
        abortController: controller,
      },
    });

    for await (const message of stream) {
      if (signal.aborted) return;
      const event = toRunEvent(message);
      if (event) yield event;
    }
  }
}
