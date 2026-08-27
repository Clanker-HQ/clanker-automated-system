import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { PendingStore } from "../control/pending.js";
import { decide, type Grant } from "../grants.js";
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

    case "rate_limit_event": {
      const info = (m.rate_limit_info as Record<string, unknown> | undefined) ?? {};
      const status = info.status;
      if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return [];
      const event: RunEvent = { type: "rate_limit_event", status };
      if (typeof info.rateLimitType === "string") (event as Record<string, unknown>).rateLimitType = info.rateLimitType;
      if (typeof info.utilization === "number") (event as Record<string, unknown>).utilization = info.utilization;
      if (typeof info.resetsAt === "number") (event as Record<string, unknown>).resetsAt = info.resetsAt;
      return [event];
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
  constructor(
    private readonly deps: { grants: Grant[]; pending: PendingStore } = {
      grants: [],
      pending: new PendingStore(process.cwd()),
    },
  ) {}

  async *execute(
    agent: AgentDef,
    ctx: RunContext,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    const { childEnv } = resolveCredentials();
    const controller = new AbortController();
    linkAbort(signal, controller);

    let sessionId = "";
    // canUseTool/AskHuman run on the SDK's own concurrent task, not driven by
    // the `for await` loop below — a decision can land before the loop has
    // pulled the first message carrying `session_id`. A deferred promise lets
    // either side await the session id instead of racing a plain variable
    // (which could otherwise be persisted into a pending entry as "").
    let resolveSessionId!: (id: string) => void;
    const sessionIdPromise = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });

    // Set by canUseTool or the AskHuman tool handler when a decision parks
    // or denies the run — those code paths abort `controller` directly
    // (not `signal`, which they don't own) to stop the SDK from continuing,
    // and stash the RunEvent to yield here once the stream loop notices.
    let terminalEvent: RunEvent | undefined;

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string; interrupt?: boolean }> => {
      const decision = decide(agent, this.deps.grants, toolName, input);
      if (decision.kind === "allow") return { behavior: "allow" };

      if (decision.kind === "deny") {
        terminalEvent = { type: "denied", reason: decision.reason };
        controller.abort();
        return { behavior: "deny", message: decision.reason, interrupt: true };
      }

      // A human already approved this exact grant earlier in this same run
      // (possibly in a previous park/resume cycle) — bypass the park path
      // entirely. Without this, a resumed agent that retries the outward
      // effect it was just approved for re-parks from scratch every time,
      // looping approve -> resume -> retry -> park forever. This is a pure
      // runtime override living here (where `ctx` is in scope), not in
      // `decide()`, which stays a static, per-call decision function with no
      // knowledge of approval history.
      if (ctx.approvedGrantRefs?.includes(decision.grantRef)) {
        // The only trace of this decision: no pending entry is written (there
        // is nothing to park for) and no RunEvent carries it either, so this
        // log line is what lets someone reading operational logs alongside
        // data/runs/<runId>/transcript.jsonl tell "auto-allowed under a prior
        // approval" apart from "no outward effect was ever detected" for the
        // matching tool_use entry.
        console.log(
          `[grants] ${toolName} auto-allowed under previously-approved grant "${decision.grantRef}" (run ${ctx.runId})`,
        );
        return { behavior: "allow" };
      }

      // Abort first — synchronously, before the disk write — so the
      // underlying agent process is told to stop as soon as possible rather
      // than after `pending.create()`'s await widens the window in which the
      // model could still act (and the stream could end naturally before
      // `terminalEvent` is even set).
      controller.abort();
      const entry = await this.deps.pending.create({
        runId: ctx.runId,
        agentName: agent.name,
        sessionId: await sessionIdPromise,
        kind: "approval",
        effect: decision.effect,
        grantRef: decision.grantRef,
      });
      terminalEvent = { type: "parked", kind: "approval", pendingId: entry.id };
      return { behavior: "deny", message: `parked for approval: ${decision.effect}`, interrupt: true };
    };

    const askHumanServer = createSdkMcpServer({
      name: "askHuman",
      tools: [
        tool(
          "AskHuman",
          "Ask the owner a free-text question and stop this run until they answer. Use this when you're blocked on information only the owner can provide.",
          { question: z.string().min(1) },
          async ({ question }) => {
            controller.abort();
            const entry = await this.deps.pending.create({
              runId: ctx.runId,
              agentName: agent.name,
              sessionId: await sessionIdPromise,
              kind: "question",
              question,
            });
            terminalEvent = { type: "parked", kind: "question", pendingId: entry.id };
            return { content: [{ type: "text", text: "Waiting for the owner's answer." }] };
          },
        ),
      ],
    });

    const stream = query({
      prompt: ctx.prompt,
      options: {
        model: agent.run.model,
        effort: agent.run.effort,
        maxTurns: agent.run.maxTurns,
        maxBudgetUsd: agent.run.maxBudgetUsd,
        cwd: ctx.workspace,
        // Deliberately NOT passing `allowedTools`: the SDK auto-approves any
        // tool named there without ever consulting `canUseTool` (it only
        // routes a call through the "ask" path — where canUseTool lives —
        // when the tool isn't already on that auto-allow list). Since every
        // tool `canUseTool` needs to gate (WebFetch, Bash, ...) is also on
        // the agent's own allowedTools list, setting both would let the SDK
        // auto-approve exactly the calls this boundary exists to intercept.
        // `tools` (below) still controls what's loaded/available — that's
        // unrelated to auto-approval — and `disallowedTools` is still a hard
        // block, also unrelated. Leaving `allowedTools` unset means every
        // tool call routes through `canUseTool`, where `decide()` is the
        // actual arbiter: non-outward-effect calls (Read, Glob, ...) still
        // get `{kind: "allow"}` immediately, just with one extra async
        // round-trip.
        disallowedTools: agent.permissions.disallowedTools,
        tools: agent.permissions.allowedTools,
        permissionMode: "default",
        settingSources: [],
        env: childEnv,
        abortController: controller,
        canUseTool,
        mcpServers: { askHuman: askHumanServer },
        ...(ctx.resume ? { resume: ctx.resume } : {}),
      },
    });

    let partial: PartialUsage = { inputTokens: 0, outputTokens: 0 };
    let sawTerminalUsage = false;

    // Invariant: a message already pulled off the stream is NEVER discarded,
    // aborted or not — it may be the only place a run's token usage shows up.
    // So every message is processed unconditionally (accumulate its usage,
    // map it to events, yield those events); the abort signal is checked only
    // AFTER processing, and only to decide whether to stop asking the stream
    // for more messages. Checking the abort state BEFORE mapping a message
    // that was already pulled would silently drop its usage/events, which is
    // the exact bug this file exists to fix (see accumulateUsage's doc
    // comment) — just for the specific message that races the abort.
    //
    // Checked here against `controller.signal`, not the outer `signal`
    // parameter: `linkAbort` only propagates outer -> inner, so an outer
    // abort/timeout always shows up on `controller.signal` too, but
    // canUseTool/AskHuman abort `controller` directly (they don't own
    // `signal`) — checking the outer `signal` here would never observe a
    // park/deny decision, and the terminalEvent below would never be
    // reached. `controller.signal.aborted` is true in every case that
    // matters, so it's the single condition both paths share.
    //
    // Wrapped in try/catch: the real SDK's transport REJECTS the async
    // iterator when `controller.abort()` is called mid-stream (it does not
    // just stop yielding), so `canUseTool`/`AskHuman` calling
    // `controller.abort()` makes this `for await` throw, not exit quietly.
    // Without the catch, that throw would propagate out of `execute()`
    // instead of reaching the post-loop block below — the caller would see
    // the run as crashed and never learn it was parked/denied. A rejection
    // that happens for any OTHER reason (a genuine transport failure) must
    // still propagate, so it's only swallowed when `controller.signal` is
    // the reason we know something aborted it.
    try {
      for await (const message of stream) {
        const record = message as Record<string, unknown>;
        if (typeof record.session_id === "string") {
          sessionId = record.session_id;
          resolveSessionId(record.session_id);
        }

        partial = accumulateUsage(partial, message);
        const events = toRunEvents(message);
        if (events.some((e) => e.type === "usage")) sawTerminalUsage = true;
        yield* events;

        if (controller.signal.aborted) break;
      }
    } catch (err) {
      if (!controller.signal.aborted) throw err;
      // else: this is the abort-caused rejection from the transport — fall
      // through to the post-loop block below, same as a clean break.
    }

    // Safety valve: resolve sessionIdPromise (a no-op if a message already
    // did) once the stream has been fully consumed either way. Without this,
    // a canUseTool/AskHuman call that lands after the stream has already
    // ended without ever carrying a session_id — e.g. a stream that closes
    // before any message reports one — would leave that handler's
    // `await sessionIdPromise` unsettled forever instead of falling back to
    // whatever (possibly still "") sessionId was captured.
    resolveSessionId(sessionId);

    // Fallback synthesis, reached either by the `break` above (aborted
    // mid-loop, after the last-pulled message was fully processed) or by the
    // stream simply ending on its own once aborted (the SDK may just stop
    // yielding without ever handing back another message to trigger the
    // check inside the loop) — either way, if the terminal `result` message
    // never arrived but per-turn usage was accumulated, that's the only
    // record of what the run actually spent. Gated on controller.signal.aborted
    // (see the loop comment above for why): a stream that ends early for some
    // OTHER reason (crash, unexpected close, protocol hiccup) with no `result`
    // message is not this fix's concern — synthesizing here is specifically
    // the abort fallback, not a generic "stream ended without a result"
    // fallback. Single call site: this used to be duplicated at two points
    // inside the loop, and now also covers yielding the parked/denied
    // terminalEvent set by canUseTool/AskHuman, for the same reason.
    if (controller.signal.aborted) {
      if (!sawTerminalUsage && (partial.inputTokens > 0 || partial.outputTokens > 0)) {
        yield {
          type: "usage",
          inputTokens: partial.inputTokens,
          outputTokens: partial.outputTokens,
          costUsd: estimateCostUsd(agent.run.model, partial.inputTokens, partial.outputTokens),
          durationMs: 0,
        };
      }
      if (terminalEvent) yield terminalEvent;
    }
  }
}
