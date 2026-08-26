import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDef } from "../registry.js";
import { resolveCredentials } from "./credentials.js";
import type { RunContext, RunEvent, Runner } from "./types.js";

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A non-empty string, else "unknown". */
function str(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function blocksOf(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is Record<string, unknown> => typeof b === "object" && b !== null,
  );
}

/**
 * A tool_result content block normally carries only tool_use_id, not a tool
 * name — fall back to that, and only then to "unknown".
 */
function toolResultName(block: Record<string, unknown>): string {
  if (typeof block.name === "string" && block.name) return block.name;
  if (typeof block.tool_use_id === "string" && block.tool_use_id) return block.tool_use_id;
  return "unknown";
}

/**
 * Rough $/million-token rates for the fixed model set this system runs.
 * Used ONLY to estimate cost on a run aborted before the SDK's own
 * total_cost_usd figure (which arrives solely on the terminal `result`
 * message) was ever computed — subscription runs aren't billed by this
 * number, but a $0.0000 report for a run that burned its whole timeout is
 * worse than an estimate.
 */
const COST_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = COST_PER_MILLION_TOKENS[model];
  if (!rate) return 0;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

export interface PartialUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Accumulates the per-turn `usage` block every SDKAssistantMessage carries
 * (message.usage, standard Anthropic Messages API shape) — present on EVERY
 * assistant message, not only the terminal one. This is what lets a run
 * aborted mid-stream still report a truthful token count instead of losing
 * all accounting.
 */
export function accumulateUsage(existing: PartialUsage, message: unknown): PartialUsage {
  if (typeof message !== "object" || message === null) return existing;
  const m = message as Record<string, unknown>;
  if (m.type !== "assistant") return existing;
  const inner = m.message as Record<string, unknown> | undefined;
  const usage = inner?.usage as Record<string, unknown> | undefined;
  if (!usage) return existing;
  return {
    inputTokens: existing.inputTokens + num(usage.input_tokens),
    outputTokens: existing.outputTokens + num(usage.output_tokens),
  };
}

/**
 * Maps one SDK message to zero or more RunEvents.
 *
 * `SDKMessage` has no standalone tool_use/tool_result/usage message types:
 * tool calls arrive as content blocks inside an `assistant` message
 * (`message.message.content`), tool results arrive as content blocks inside
 * a `user` message, and token/cost usage arrives on the terminal `result`
 * message alongside a `subtype` that says why the run stopped. One assistant
 * message can carry text and several tool_use blocks at once, so a single
 * SDK message can map to several RunEvents — hence the array return.
 *
 * Never throws: anything unrecognised or malformed returns [], so an SDK
 * version change degrades reporting rather than breaking a run.
 */
export function toRunEvents(message: unknown): RunEvent[] {
  if (typeof message !== "object" || message === null) return [];
  const m = message as Record<string, unknown>;

  switch (m.type) {
    case "assistant": {
      const events: RunEvent[] = [];
      const inner = m.message as Record<string, unknown> | undefined;
      const content = inner?.content;

      if (typeof content === "string") {
        if (content.trim()) events.push({ type: "assistant", text: content });
      } else {
        for (const block of blocksOf(content)) {
          if (block.type === "text" && typeof block.text === "string") {
            if (block.text.trim()) events.push({ type: "assistant", text: block.text });
          } else if (block.type === "tool_use") {
            events.push({ type: "tool_use", name: str(block.name) });
          }
          // "thinking" and any other block type is intentionally ignored.
        }
      }

      // SDKAssistantMessage.error carries conditions like
      // authentication_failed, rate_limit, billing_error, etc. — surface
      // them so a run doesn't silently look clean.
      if (typeof m.error === "string" && m.error) {
        events.push({ type: "error", message: `assistant message reported error: ${m.error}` });
      }
      return events;
    }

    case "user": {
      const events: RunEvent[] = [];
      const inner = m.message as Record<string, unknown> | undefined;
      for (const block of blocksOf(inner?.content)) {
        if (block.type === "tool_result") {
          events.push({
            type: "tool_result",
            name: toolResultName(block),
            ok: block.is_error !== true,
          });
        }
      }
      return events;
    }

    case "result": {
      const usage = (m.usage as Record<string, unknown> | undefined) ?? {};
      const events: RunEvent[] = [
        {
          type: "usage",
          inputTokens: num(usage.input_tokens),
          outputTokens: num(usage.output_tokens),
          costUsd: num(m.total_cost_usd),
          durationMs: num(m.duration_ms),
        },
      ];

      // subtype is the only record of *why* the SDK stopped ("success" vs.
      // error_during_execution / error_max_turns / error_max_budget_usd /
      // error_max_structured_output_retries); is_error can also be true on
      // an otherwise "success" subtype when the turn ended on an API error.
      // Preserve the subtype verbatim — mapping it to a distinct RunStatus
      // is out of scope here and belongs with the governor in a later plan.
      const subtype = typeof m.subtype === "string" ? m.subtype : "unknown";
      if (subtype !== "success" || m.is_error === true) {
        events.push({
          type: "error",
          message: `SDK run ended with subtype "${subtype}" (is_error=${m.is_error === true})`,
        });
      }
      return events;
    }

    default:
      return [];
  }
}

/**
 * Propagates an abort from `signal` to `controller`. A listener attached to
 * an AbortSignal that is already aborted never fires (per the AbortSignal
 * spec), so the already-aborted case must be checked explicitly rather than
 * relying solely on the "abort" event — the same pattern FakeRunner already
 * uses at src/runner/fake-runner.ts:23-25. Without this, a timeout that
 * fires before SdkRunner.execute's async generator body starts running
 * would never reach the SDK's own abortController, and the run would
 * continue to completion past its deadline.
 */
export function linkAbort(signal: AbortSignal, controller: AbortController): void {
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
}

export class SdkRunner implements Runner {
  async *execute(
    agent: AgentDef,
    ctx: RunContext,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    const { childEnv } = resolveCredentials();
    const controller = new AbortController();
    linkAbort(signal, controller);

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

    let partial: PartialUsage = { inputTokens: 0, outputTokens: 0 };
    let sawTerminalUsage = false;
    let wasAborted = signal.aborted;

    for await (const message of stream) {
      const isNowAborted = signal.aborted;
      const justAborted = !wasAborted && isNowAborted;

      if (justAborted) {
        // Signal just became aborted mid-stream, don't process this message.
        if (!sawTerminalUsage && (partial.inputTokens > 0 || partial.outputTokens > 0)) {
          yield {
            type: "usage",
            inputTokens: partial.inputTokens,
            outputTokens: partial.outputTokens,
            costUsd: estimateCostUsd(agent.run.model, partial.inputTokens, partial.outputTokens),
            durationMs: 0,
          };
        }
        return;
      }

      wasAborted = isNowAborted;
      partial = accumulateUsage(partial, message);
      const events = toRunEvents(message);
      if (events.some((e) => e.type === "usage")) sawTerminalUsage = true;
      yield* events;

      if (signal.aborted) {
        // Signal is aborted after processing this message; try to emit synthesized
        // usage if we haven't seen the terminal one yet.
        if (!sawTerminalUsage && (partial.inputTokens > 0 || partial.outputTokens > 0)) {
          yield {
            type: "usage",
            inputTokens: partial.inputTokens,
            outputTokens: partial.outputTokens,
            costUsd: estimateCostUsd(agent.run.model, partial.inputTokens, partial.outputTokens),
            durationMs: 0,
          };
        }
        return;
      }
    }
  }
}
