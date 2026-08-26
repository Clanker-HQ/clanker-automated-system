import { describe, expect, it } from "vitest";
import { toRunEvents } from "../src/runner/sdk-runner.js";

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
      { type: "usage", inputTokens: 12, outputTokens: 4, costUsd: 0.03, durationMs: 500 },
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
      type: "usage", inputTokens: 5, outputTokens: 1, costUsd: 1, durationMs: 200,
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
      { type: "usage", inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
    ]);
  });
});
