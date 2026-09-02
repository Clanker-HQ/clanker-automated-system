import { describe, expect, it } from "vitest";
import { linkAbort, toRunEvents } from "../src/runner/sdk-runner.js";

// These messages are synthetic: modeled on the SDKMessage shapes documented
// in the installed @anthropic-ai/claude-agent-sdk type declarations
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts), not observed from a
// live run — the Task 8 probe is deferred (see task-7-report.md). toRunEvents
// must degrade to [] for anything it does not recognise rather than throw, so
// an SDK version bump degrades reporting instead of breaking a run.
describe("toRunEvents", () => {
  it("maps an assistant message with mixed content blocks to one event per text/tool_use block, in order, ignoring thinking", () => {
    const events = toRunEvents({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "first" },
          { type: "tool_use", id: "1", name: "Bash", input: {} },
          { type: "thinking", thinking: "pondering..." },
          { type: "tool_use", id: "2", name: "Write", input: {} },
        ],
      },
    });
    expect(events).toEqual([
      { type: "assistant", text: "first" },
      { type: "tool_use", name: "Bash" },
      { type: "tool_use", name: "Write" },
    ]);
  });

  it("maps an assistant message whose content is a plain string", () => {
    const events = toRunEvents({
      type: "assistant",
      message: { content: "hello world" },
    });
    expect(events).toEqual([{ type: "assistant", text: "hello world" }]);
  });

  it("returns [] for an assistant message with only whitespace text and no tool_use", () => {
    const events = toRunEvents({ type: "assistant", message: { content: "   " } });
    expect(events).toEqual([]);
  });

  it("surfaces an assistant message's error field as an error event", () => {
    const events = toRunEvents({
      type: "assistant",
      message: { content: "" },
      error: "rate_limit",
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect((events[0] as { message: string }).message).toContain("rate_limit");
  });

  it("maps a user message's tool_result blocks, using is_error to set ok", () => {
    const events = toRunEvents({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "ok" },
          { type: "tool_result", tool_use_id: "call-2", content: "boom", is_error: true },
        ],
      },
    });
    expect(events).toEqual([
      { type: "tool_result", name: "call-1", ok: true },
      { type: "tool_result", name: "call-2", ok: false },
    ]);
  });

  it("falls back to 'unknown' for a tool_result block with neither name nor tool_use_id", () => {
    const events = toRunEvents({
      type: "user",
      message: { content: [{ type: "tool_result", content: "ok" }] },
    });
    expect(events).toEqual([{ type: "tool_result", name: "unknown", ok: true }]);
  });

  it("maps a successful result to a single usage event and no error", () => {
    const events = toRunEvents({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 12, output_tokens: 4 },
      total_cost_usd: 0.03,
      duration_ms: 500,
    });
    expect(events).toEqual([
      { type: "usage", inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.03, durationMs: 500 },
    ]);
  });

  it("maps an error-subtype result to a usage event plus an error event naming the subtype verbatim", () => {
    const events = toRunEvents({
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      usage: { input_tokens: 5, output_tokens: 1 },
      total_cost_usd: 1,
      duration_ms: 200,
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "usage", inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1, durationMs: 200,
    });
    expect(events[1]!.type).toBe("error");
    expect((events[1] as { message: string }).message).toContain("error_max_budget_usd");
  });

  it("also emits an error event when subtype is 'success' but is_error is true", () => {
    const events = toRunEvents({
      type: "result",
      subtype: "success",
      is_error: true,
      usage: { input_tokens: 3, output_tokens: 2 },
      total_cost_usd: 0.01,
      duration_ms: 150,
    });
    expect(events).toHaveLength(2);
    expect(events[1]!.type).toBe("error");
    expect((events[1] as { message: string }).message).toContain("success");
  });

  it("returns [] for an unrecognised message type", () => {
    expect(toRunEvents({ type: "some_future_message_type", foo: "bar" })).toEqual([]);
  });

  it("does not throw and returns [] for a message that is not an object", () => {
    expect(() => toRunEvents(null)).not.toThrow();
    expect(toRunEvents(null)).toEqual([]);
    expect(toRunEvents(undefined)).toEqual([]);
    expect(toRunEvents("just a string")).toEqual([]);
  });

  it("returns [] rather than throwing for an assistant message whose content is a number", () => {
    expect(() => toRunEvents({ type: "assistant", message: { content: 42 } })).not.toThrow();
    expect(toRunEvents({ type: "assistant", message: { content: 42 } })).toEqual([]);
  });

  it("defaults every usage field to 0 when usage is absent from a result message", () => {
    const events = toRunEvents({ type: "result", subtype: "success", is_error: false });
    expect(events).toEqual([
      { type: "usage", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 0 },
    ]);
  });

  // The SDK's own type declarations document `usage` on a result message as
  // "MAIN AGENT LOOP ONLY ... per-turn in streaming-input sessions" and say
  // to "prefer modelUsage for token/cost accounting" — modelUsage is
  // "cumulative across turns", sharing total_cost_usd's lifecycle. A 20-turn
  // research run recorded costUsd: $0.56 (correct, from total_cost_usd) next
  // to inputTokens: 92 (from `usage`, the last turn only) — a run that
  // should have reported ~half a million cumulative input tokens looked like
  // it cost 24x what its own token count implied. This is that bug's fix.
  it("sums modelUsage's per-model totals for a result message's token counts, not the per-turn usage block", () => {
    const events = toRunEvents({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 92, output_tokens: 4562 },
      modelUsage: {
        "claude-haiku-4-5": {
          inputTokens: 480000,
          outputTokens: 4562,
          cacheReadInputTokens: 400000,
          cacheCreationInputTokens: 20000,
          costUSD: 0.5556445,
        },
      },
      total_cost_usd: 0.5556445,
      duration_ms: 120718,
    });
    // The cache counts were in this fixture from the start and were simply
    // never read: `inputTokens` is UNCACHED input only, so summing it alone
    // reported 480k for a run that actually moved 900k. The rolling
    // rate-limit window is what constrains this system, and re-reading a
    // cached prefix spends it too.
    expect(events[0]).toEqual({
      type: "usage",
      inputTokens: 480000,
      outputTokens: 4562,
      cacheReadTokens: 400000,
      cacheCreationTokens: 20000,
      costUsd: 0.5556445,
      durationMs: 120718,
    });
  });

  it("sums modelUsage across every model key — a mid-run fallback adds a second one", () => {
    const events = toRunEvents({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: {
        "claude-opus-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
        "claude-opus-4-8": { inputTokens: 200, outputTokens: 75, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.02 },
      },
      total_cost_usd: 0.03,
      duration_ms: 5000,
    });
    expect(events[0]).toMatchObject({ inputTokens: 300, outputTokens: 125 });
  });

  it("falls back to the per-turn usage block when modelUsage is absent — an older SDK build, or a crashed/startup-error result the SDK documents as possibly carrying zeroed modelUsage", () => {
    const events = toRunEvents({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 11, output_tokens: 3 },
      total_cost_usd: 0.002,
      duration_ms: 4200,
    });
    expect(events[0]).toEqual({
      type: "usage", inputTokens: 11, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.002, durationMs: 4200,
    });
  });

  it("falls back to the per-turn usage block when modelUsage is present but empty", () => {
    const events = toRunEvents({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 11, output_tokens: 3 },
      modelUsage: {},
      total_cost_usd: 0.002,
      duration_ms: 4200,
    });
    expect(events[0]).toEqual({
      type: "usage", inputTokens: 11, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.002, durationMs: 4200,
    });
  });

  it("maps a rate_limit_event message to a rate_limit_event RunEvent", () => {
    const events = toRunEvents({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.91,
        resetsAt: 1787766600,
      },
    });
    expect(events).toEqual([
      { type: "rate_limit_event", status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.91, resetsAt: 1787766600 },
    ]);
  });

  it("maps a rate_limit_event with a minimal payload, defaulting the optional fields to undefined", () => {
    const events = toRunEvents({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    expect(events).toEqual([{ type: "rate_limit_event", status: "allowed" }]);
  });

  // Auto-compaction (settings.autoCompactWindow, see sdk-runner.ts) had no
  // observability at all before this: a `system`/`compact_boundary` message
  // fell into the `default: return []` branch below and vanished, so nobody
  // could tell whether it fired, how often, or how much it actually saved
  // (pre_tokens/post_tokens ride along on the SDK's own message for exactly
  // this). Every conclusion this system has drawn from token counts so far
  // has come from a number that was actually being recorded — this is that
  // same discipline applied to the one new lever that touches conversation
  // content, not just the fixed per-turn baseline.
  it("maps a compact_boundary system message to a compacted RunEvent", () => {
    const events = toRunEvents({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 62000, post_tokens: 8100, duration_ms: 1400 },
      uuid: "u1",
      session_id: "s1",
    });
    expect(events).toEqual([{ type: "compacted", trigger: "auto", preTokens: 62000, postTokens: 8100 }]);
  });

  it("maps a manual compact_boundary with no post_tokens, defaulting it to undefined", () => {
    const events = toRunEvents({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 40000 },
      uuid: "u2",
      session_id: "s1",
    });
    expect(events).toEqual([{ type: "compacted", trigger: "manual", preTokens: 40000, postTokens: undefined }]);
  });

  it("ignores a system message that isn't a compact boundary", () => {
    expect(toRunEvents({ type: "system", subtype: "init", session_id: "s1" })).toEqual([]);
  });
});

// linkAbort exists because a listener attached to an AbortSignal that is
// ALREADY aborted never fires (per the AbortSignal spec) — so wiring it with
// only `signal.addEventListener("abort", ...)` silently drops the abort if
// the orchestrator's timeout fires before the async generator body starts
// running. This mirrors the check FakeRunner already makes at
// src/runner/fake-runner.ts:23-25.
describe("linkAbort", () => {
  it("aborts the controller immediately when the signal is already aborted before linking", () => {
    const source = new AbortController();
    source.abort();
    const target = new AbortController();
    linkAbort(source.signal, target);
    expect(target.signal.aborted).toBe(true);
  });

  it("aborts the controller when the signal aborts after linking", () => {
    const source = new AbortController();
    const target = new AbortController();
    linkAbort(source.signal, target);
    expect(target.signal.aborted).toBe(false);
    source.abort();
    expect(target.signal.aborted).toBe(true);
  });

  it("leaves the controller un-aborted when the signal never aborts", () => {
    const source = new AbortController();
    const target = new AbortController();
    linkAbort(source.signal, target);
    expect(target.signal.aborted).toBe(false);
  });
});

