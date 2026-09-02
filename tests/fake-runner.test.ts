import { describe, expect, it } from "vitest";
import { FakeRunner } from "../src/runner/fake-runner.js";
import type { AgentDef } from "../src/registry.js";
import type { RunEvent } from "../src/runner/types.js";

const AGENT = { name: "smoke" } as AgentDef;
const CTX = { runId: "smoke-1", workspace: "/tmp/ws", prompt: "hi" };

async function drain(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("FakeRunner", () => {
  it("replays its scripted events in order", async () => {
    const runner = new FakeRunner({
      events: [
        { type: "assistant", text: "thinking" },
        { type: "tool_use", name: "Write" },
        { type: "usage", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01, durationMs: 5 },
      ],
    });
    const events = await drain(runner.execute(AGENT, CTX, new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual(["assistant", "tool_use", "usage"]);
  });

  it("throws after the configured number of events", async () => {
    const runner = new FakeRunner({
      events: [{ type: "assistant", text: "a" }, { type: "assistant", text: "b" }],
      throwAfter: 1,
    });
    await expect(drain(runner.execute(AGENT, CTX, new AbortController().signal)))
      .rejects.toThrow(/scripted failure/);
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const runner = new FakeRunner({ events: [], hangForever: true });
    const promise = drain(runner.execute(AGENT, CTX, controller.signal));
    controller.abort();
    await expect(promise).resolves.toEqual([]);
  });
});
