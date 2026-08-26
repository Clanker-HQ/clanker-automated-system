import { describe, expect, it } from "vitest";
import { toRunEvent } from "../src/runner/sdk-runner.js";

// These messages are synthetic: modeled on the shapes documented in the SDK's
// own .d.ts and the brief's mapper, not observed from a live run (Task 8
// probe is deferred — see task-7-report.md). toRunEvent must degrade to null
// for anything it does not recognise rather than throw, so an SDK version
// bump degrades reporting instead of breaking a run.
describe("toRunEvent", () => {
  it("maps an assistant message whose content is a plain string", () => {
    const event = toRunEvent({ type: "assistant", content: "hello world" });
    expect(event).toEqual({ type: "assistant", text: "hello world" });
  });

  it("maps an assistant message whose content is nested under message.content", () => {
    const event = toRunEvent({
      type: "assistant",
      message: { content: "nested hello" },
    });
    expect(event).toEqual({ type: "assistant", text: "nested hello" });
  });

  it("maps an assistant message whose content is an array of mixed blocks", () => {
    const event = toRunEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "a" },
          { type: "tool_use", id: "x", name: "Bash" },
          { type: "text", text: "b" },
        ],
      },
    });
    expect(event).toEqual({ type: "assistant", text: "ab" });
  });

  it("returns null for an assistant message with no text content", () => {
    const event = toRunEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "x", name: "Bash" }] },
    });
    expect(event).toBeNull();
  });

  it("maps a tool_use message", () => {
    const event = toRunEvent({ type: "tool_use", name: "Bash" });
    expect(event).toEqual({ type: "tool_use", name: "Bash" });
  });

  it("maps a failing tool_result", () => {
    const event = toRunEvent({ type: "tool_result", name: "Bash", is_error: true });
    expect(event).toEqual({ type: "tool_result", name: "Bash", ok: false });
  });

  it("maps a successful tool_result", () => {
    const event = toRunEvent({ type: "tool_result", name: "Bash" });
    expect(event).toEqual({ type: "tool_result", name: "Bash", ok: true });
  });

  it("maps a usage-bearing message under the 'usage' discriminator with top-level fields", () => {
    const event = toRunEvent({
      type: "usage",
      input_tokens: 10,
      output_tokens: 5,
      total_cost_usd: 0.02,
      session_duration_ms: 1200,
    });
    expect(event).toEqual({
      type: "usage",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.02,
      durationMs: 1200,
    });
  });

  it("maps a usage-bearing message under the 'result' discriminator with nested usage fields", () => {
    const event = toRunEvent({
      type: "result",
      usage: { input_tokens: 7, output_tokens: 3 },
      total_cost_usd: 0.05,
      duration_ms: 800,
    });
    expect(event).toEqual({
      type: "usage",
      inputTokens: 7,
      outputTokens: 3,
      costUsd: 0.05,
      durationMs: 800,
    });
  });

  it("returns null for an unrecognised message type", () => {
    const event = toRunEvent({ type: "some_future_message_type", foo: "bar" });
    expect(event).toBeNull();
  });

  it("returns null rather than throwing for a message with no type at all", () => {
    const event = toRunEvent({ foo: "bar" });
    expect(event).toBeNull();
  });
});
