import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDef } from "../src/registry.js";
import { resolveCredentials } from "../src/runner/credentials.js";
import type { RunEvent } from "../src/runner/types.js";

// The SDK is replaced wholesale: `query` is a plain named import, so this
// exercises the option object SdkRunner builds WITHOUT any network call,
// credential, or subscription quota. Nothing here reaches Anthropic.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

const { SdkRunner, estimateCostUsd } = await import("../src/runner/sdk-runner.js");

interface QueryParams {
  prompt: string;
  options: {
    model: string;
    effort: string;
    maxTurns: number;
    maxBudgetUsd: number;
    cwd: string;
    allowedTools: string[];
    disallowedTools: string[];
    permissionMode: string;
    settingSources: unknown[];
    env: Record<string, string>;
    abortController: AbortController;
  };
}

function stream(messages: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

const AGENT = {
  name: "smoke",
  run: {
    model: "claude-haiku-4-5",
    effort: "high",
    maxTurns: 7,
    timeoutMinutes: 3,
    maxBudgetUsd: 0.25,
  },
  permissions: { allowedTools: ["Read", "Glob"], disallowedTools: ["Bash"] },
} as unknown as AgentDef;

const CTX = { runId: "smoke-run", workspace: "/tmp/ws/smoke", prompt: "Do the thing." };

const RESULT_MESSAGE = {
  type: "result",
  subtype: "success",
  is_error: false,
  usage: { input_tokens: 11, output_tokens: 3 },
  total_cost_usd: 0.002,
  duration_ms: 4200,
};

async function collect(iterable: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** Runs SdkRunner against the stub and returns the params `query` received. */
async function run(
  messages: unknown[],
  signal: AbortSignal = new AbortController().signal,
): Promise<{ params: QueryParams; events: RunEvent[] }> {
  queryMock.mockReturnValue(stream(messages));
  const events = await collect(new SdkRunner().execute(AGENT, CTX, signal));
  return { params: queryMock.mock.calls[0]![0] as QueryParams, events };
}

afterEach(() => {
  queryMock.mockReset();
  vi.unstubAllEnvs();
});

describe("SdkRunner query options", () => {
  it("passes the resolved allowlisted environment, never an API key from the host", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-must-not-be-forwarded");

    const { params } = await run([RESULT_MESSAGE]);

    expect(params.options.env).toEqual(resolveCredentials(process.env).childEnv);
    expect(params.options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fake-token-for-tests");
    expect(params.options.env.ANTHROPIC_API_KEY).toBeUndefined();
    // Deleting `env: childEnv` from sdk-runner.ts must not stay green.
    expect(params.options.env).toBeTypeOf("object");
  });

  it("threads the agent definition through to the SDK options", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");

    const { params } = await run([RESULT_MESSAGE]);

    expect(params.prompt).toBe(CTX.prompt);
    expect(params.options.model).toBe("claude-haiku-4-5");
    expect(params.options.effort).toBe("high");
    expect(params.options.maxTurns).toBe(7);
    expect(params.options.maxBudgetUsd).toBe(0.25);
    expect(params.options.cwd).toBe(CTX.workspace);
    expect(params.options.allowedTools).toEqual(["Read", "Glob"]);
    expect(params.options.disallowedTools).toEqual(["Bash"]);
    expect(params.options.settingSources).toEqual([]);
    expect(params.options.permissionMode).toBe("default");
  });

  it("maps the SDK's yielded messages into RunEvents", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");

    const { events } = await run([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "working" },
            { type: "tool_use", id: "1", name: "Read", input: {} },
          ],
        },
      },
      RESULT_MESSAGE,
    ]);

    expect(events).toEqual([
      { type: "assistant", text: "working" },
      { type: "tool_use", name: "Read" },
      { type: "usage", inputTokens: 11, outputTokens: 3, costUsd: 0.002, durationMs: 4200 },
    ]);
  });

  // linkAbort is correct in isolation (tests/sdk-runner.test.ts), but the abort
  // bug this branch already shipped once lived at the CALL site — this proves
  // execute() actually calls it.
  it("propagates an already-aborted input signal to the SDK's abortController", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const controller = new AbortController();
    controller.abort();

    const { params } = await run([RESULT_MESSAGE], controller.signal);

    expect(params.options.abortController.signal.aborted).toBe(true);
  });

  // Usage arrives only on the terminal `result` message. Checking
  // signal.aborted BEFORE mapping discarded the message just pulled off the
  // stream, so an aborted run reported $0.0000 for a run that burned its
  // whole timeout.
  it("still records the usage carried by the message it already pulled when aborted", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const controller = new AbortController();
    controller.abort();

    const { events } = await run([RESULT_MESSAGE, { type: "assistant", message: { content: "later" } }], controller.signal);

    expect(events).toEqual([
      { type: "usage", inputTokens: 11, outputTokens: 3, costUsd: 0.002, durationMs: 4200 },
    ]);
  });

  it("emits a synthesized usage event from partial per-turn usage when aborted before the terminal result message", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const controller = new AbortController();

    const events: RunEvent[] = [];
    const iterable = new SdkRunner().execute(AGENT, CTX, controller.signal);
    queryMock.mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          message: { content: "partial one", usage: { input_tokens: 400, output_tokens: 20 } },
        };
        controller.abort();
        yield {
          type: "assistant",
          message: { content: "never reached", usage: { input_tokens: 999, output_tokens: 999 } },
        };
      })(),
    );
    for await (const event of iterable) events.push(event);

    expect(events).toEqual([
      { type: "assistant", text: "partial one" },
      {
        type: "usage",
        inputTokens: 400,
        outputTokens: 20,
        costUsd: estimateCostUsd("claude-haiku-4-5", 400, 20),
        durationMs: 0,
      },
    ]);
  });

  it("does not synthesize a second usage event when the terminal result message already provided one", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const controller = new AbortController();
    const { events } = await run(
      [
        { type: "assistant", message: { content: "a", usage: { input_tokens: 5, output_tokens: 1 } } },
        RESULT_MESSAGE,
      ],
      controller.signal,
    );
    controller.abort();
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
  });
});
