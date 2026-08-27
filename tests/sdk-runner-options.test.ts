import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingStore } from "../src/control/pending.js";
import type { Grant } from "../src/grants.js";
import type { AgentDef } from "../src/registry.js";
import { resolveCredentials } from "../src/runner/credentials.js";
import type { RunEvent } from "../src/runner/types.js";

// The SDK is replaced wholesale: `query` is a plain named import, so this
// exercises the option object SdkRunner builds WITHOUT any network call,
// credential, or subscription quota. Nothing here reaches Anthropic.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  // Only `query` is replaced — the real network call this file must never
  // make. `createSdkMcpServer` and `tool` are pure descriptor-builders (no
  // network/credential access) that SdkRunner now calls unconditionally on
  // every execute(), so they're passed through from the real module rather
  // than stubbed out.
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

const { SdkRunner, estimateCostUsd } = await import("../src/runner/sdk-runner.js");

interface QueryParams {
  prompt: string;
  options: {
    model: string;
    effort: string;
    maxTurns: number;
    maxBudgetUsd: number;
    cwd: string;
    allowedTools?: string[];
    disallowedTools: string[];
    tools: string[];
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
    // Deliberately NOT set: `allowedTools` makes the SDK auto-approve those
    // tools without ever consulting `canUseTool`, which would defeat grant
    // enforcement for exactly the tools it needs to gate. `tools` (asserted
    // in the "trimming what's loaded" test below) is the separate, unrelated
    // option that still carries the agent's tool list.
    expect(params.options.allowedTools).toBeUndefined();
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
        // Already pulled off the stream by the time abort() has run, so it
        // must still be processed in full, not discarded.
        yield {
          type: "assistant",
          message: { content: "also processed", usage: { input_tokens: 999, output_tokens: 999 } },
        };
      })(),
    );
    for await (const event of iterable) events.push(event);

    expect(events).toEqual([
      { type: "assistant", text: "partial one" },
      { type: "assistant", text: "also processed" },
      {
        type: "usage",
        inputTokens: 1399,
        outputTokens: 1019,
        costUsd: estimateCostUsd("claude-haiku-4-5", 1399, 1019),
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

  it("passes the agent's allowedTools as the SDK's tools option, trimming what's loaded into the system prompt", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const { params } = await run([RESULT_MESSAGE]);
    expect(params.options.tools).toEqual(["Read", "Glob"]);
  });

  it("passes an empty tools array for an agent with no allowedTools, rather than falling back to every built-in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const bare = { ...AGENT, permissions: { allowedTools: [], disallowedTools: [] } } as unknown as AgentDef;
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(new SdkRunner().execute(bare, CTX, new AbortController().signal));
    expect((queryMock.mock.calls[0]![0] as QueryParams).options.tools).toEqual([]);
  });
});

const TEST_ECHO: Grant = { id: "test-echo", kind: "http", method: "POST", urlPattern: "https://httpbin.org/post", secret: "X" };

function sdkRunnerWith(grants: Grant[], pendingDir: string) {
  return new SdkRunner({ grants, pending: new PendingStore(pendingDir) });
}

describe("SdkRunner grant enforcement", () => {
  it("passes a canUseTool function and the AskHuman tool's MCP server to the SDK", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const granted = { ...AGENT, tier: "granted", grantRefs: ["test-echo"], approval: "notify" } as unknown as AgentDef;
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(sdkRunnerWith([TEST_ECHO], dir).execute(granted, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueryParams & { options: { canUseTool: unknown; mcpServers: Record<string, unknown> } };
    expect(typeof params.options.canUseTool).toBe("function");
    expect(params.options.mcpServers.askHuman).toBeDefined();
  });

  it("parks and writes a pending entry when canUseTool sees a matching-grant effect on a granted agent", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const granted = { ...AGENT, tier: "granted", grantRefs: ["test-echo"], approval: "notify" } as unknown as AgentDef;
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(sdkRunnerWith([TEST_ECHO], dir).execute(granted, CTX, new AbortController().signal));

    const params = queryMock.mock.calls[0]![0] as { options: { canUseTool: (name: string, input: Record<string, unknown>, opts: { signal: AbortSignal; toolUseID: string }) => Promise<unknown> } };
    const decision = await params.options.canUseTool("WebFetch", { url: "https://httpbin.org/post" }, { signal: new AbortController().signal, toolUseID: "t1" } as never);

    expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
    const pending = new PendingStore(dir);
    const entries = await pending.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: CTX.runId, agentName: granted.name, kind: "approval", grantRef: "test-echo" });
  });

  it("denies without parking when no grant matches", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const granted = { ...AGENT, tier: "granted", grantRefs: [], approval: "notify" } as unknown as AgentDef;
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(sdkRunnerWith([TEST_ECHO], dir).execute(granted, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as { options: { canUseTool: (name: string, input: Record<string, unknown>, opts: unknown) => Promise<unknown> } };

    const decision = await params.options.canUseTool("WebFetch", { url: "https://httpbin.org/post" }, { signal: new AbortController().signal, toolUseID: "t1" });
    expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
    expect(await new PendingStore(dir).list()).toEqual([]);
  });

  it("allows a call with no outward effect", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(sdkRunnerWith([], dir).execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as { options: { canUseTool: (name: string, input: Record<string, unknown>, opts: unknown) => Promise<unknown> } };
    const decision = await params.options.canUseTool("Read", { file_path: "notes.md" }, { signal: new AbortController().signal, toolUseID: "t1" });
    expect(decision).toEqual({ behavior: "allow" });
  });

  // The 4 tests above all call canUseTool AFTER execute() has fully drained,
  // which can't prove anything about what happens when a park/deny decision
  // lands WHILE the stream is still running. The real SDK's transport
  // rejects the async iterator once `controller.abort()` is called mid-run
  // (it does not just stop yielding quietly) — this test's mocked `query`
  // return value simulates exactly that: it yields one message carrying a
  // session id, then calls the SdkRunner-built `canUseTool` itself (as the
  // real SDK would, mid-stream) and, once that resolves, throws — modeling
  // the transport's abort-triggered rejection. This is what actually proves
  // the terminalEvent reaches the caller instead of the generator throwing.
  it("yields the parked terminal event when canUseTool parks mid-stream and the transport then rejects on abort", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const granted = { ...AGENT, tier: "granted", grantRefs: ["test-echo"], approval: "notify" } as unknown as AgentDef;

    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "assistant", session_id: "sess-mid-stream", message: { content: "starting" } };
        // By the time query() was called (synchronously, before this
        // generator is ever iterated), the params it was called with are
        // already recorded on the mock — grab the real canUseTool it built.
        const params = queryMock.mock.calls[0]![0] as {
          options: { canUseTool: (name: string, input: Record<string, unknown>, opts: unknown) => Promise<unknown> };
        };
        const decision = await params.options.canUseTool(
          "WebFetch",
          { url: "https://httpbin.org/post" },
          { signal: new AbortController().signal, toolUseID: "t1" },
        );
        expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });

    const events = await collect(sdkRunnerWith([TEST_ECHO], dir).execute(granted, CTX, new AbortController().signal));

    expect(events[0]).toEqual({ type: "assistant", text: "starting" });
    expect(events.at(-1)).toMatchObject({ type: "parked", kind: "approval" });

    // Also proves Important #4's fix: the pending entry got the session id
    // carried by the message the loop had already processed, not "".
    const entries = await new PendingStore(dir).list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sessionId: "sess-mid-stream", kind: "approval", grantRef: "test-echo" });
  });

  // The bug this fix addresses: a human approves a grant, the resumed run
  // retries the exact same outward effect, and without this bypass
  // canUseTool parks AGAIN from scratch — looping approve -> resume -> retry
  // -> park forever. ctx.approvedGrantRefs carries what was already approved
  // earlier in this same run; canUseTool must consult it before parking.
  it("allows a matching-grant effect straight through when called after the stream has drained, and writes no pending entry", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const granted = { ...AGENT, tier: "granted", grantRefs: ["test-echo"], approval: "notify" } as unknown as AgentDef;
    const resumeCtx = { ...CTX, approvedGrantRefs: ["test-echo"] };
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));

    await collect(sdkRunnerWith([TEST_ECHO], dir).execute(granted, resumeCtx, new AbortController().signal));

    const params = queryMock.mock.calls[0]![0] as { options: { canUseTool: (name: string, input: Record<string, unknown>, opts: unknown) => Promise<unknown> } };
    const decision = await params.options.canUseTool("WebFetch", { url: "https://httpbin.org/post" }, { signal: new AbortController().signal, toolUseID: "t1" });

    expect(decision).toEqual({ behavior: "allow" });
    expect(await new PendingStore(dir).list()).toEqual([]);
  });

  // The test above calls canUseTool only AFTER execute() has fully drained,
  // which can't prove anything about mid-stream behavior — a stale terminal
  // "parked" event could never appear in `events` regardless of whether the
  // bypass works, since nothing was yielded to trigger it. This test calls
  // canUseTool from INSIDE the mocked stream (mirroring the mid-stream abort
  // test above) so it actually proves: no abort happens, the stream is never
  // interrupted, and the run reaches its normal terminal usage event instead
  // of the parked/aborted fallback path.
  it("does not abort or park mid-stream when canUseTool sees an already-approved grant — the run completes normally", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const granted = { ...AGENT, tier: "granted", grantRefs: ["test-echo"], approval: "notify" } as unknown as AgentDef;
    const resumeCtx = { ...CTX, approvedGrantRefs: ["test-echo"] };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "assistant", session_id: "sess-bypass", message: { content: "starting" } };
        const params = queryMock.mock.calls[0]![0] as {
          options: { canUseTool: (name: string, input: Record<string, unknown>, opts: unknown) => Promise<unknown> };
        };
        const decision = await params.options.canUseTool(
          "WebFetch",
          { url: "https://httpbin.org/post" },
          { signal: new AbortController().signal, toolUseID: "t1" },
        );
        expect(decision).toEqual({ behavior: "allow" });
        yield RESULT_MESSAGE;
      },
    });

    const events = await collect(sdkRunnerWith([TEST_ECHO], dir).execute(granted, resumeCtx, new AbortController().signal));

    expect(events.some((e) => e.type === "parked")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "usage" });
    expect(await new PendingStore(dir).list()).toEqual([]);
    // The auto-allow bypass writes no pending entry and no RunEvent, so a log
    // line is the only trace of the decision — assert it's actually there.
    expect(logSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(
      'auto-allowed under previously-approved grant "test-echo"',
    );
    logSpy.mockRestore();
  });

  // Confirms the original park behaviour is untouched when approvedGrantRefs
  // is absent (a fresh, non-resumed run) or present but doesn't cover the
  // grant that matched — the bypass above must not become a blanket allow.
  it("still parks and writes a pending entry when approvedGrantRefs is absent", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const granted = { ...AGENT, tier: "granted", grantRefs: ["test-echo"], approval: "notify" } as unknown as AgentDef;
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(sdkRunnerWith([TEST_ECHO], dir).execute(granted, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as { options: { canUseTool: (name: string, input: Record<string, unknown>, opts: unknown) => Promise<unknown> } };

    const decision = await params.options.canUseTool("WebFetch", { url: "https://httpbin.org/post" }, { signal: new AbortController().signal, toolUseID: "t1" });

    expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
    expect(await new PendingStore(dir).list()).toHaveLength(1);
  });

  it("still parks when approvedGrantRefs is present but does not include the matched grant", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const granted = { ...AGENT, tier: "granted", grantRefs: ["test-echo"], approval: "notify" } as unknown as AgentDef;
    const ctxWithOtherApproval = { ...CTX, approvedGrantRefs: ["some-other-grant"] };
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(sdkRunnerWith([TEST_ECHO], dir).execute(granted, ctxWithOtherApproval, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as { options: { canUseTool: (name: string, input: Record<string, unknown>, opts: unknown) => Promise<unknown> } };

    const decision = await params.options.canUseTool("WebFetch", { url: "https://httpbin.org/post" }, { signal: new AbortController().signal, toolUseID: "t1" });

    expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
    expect(await new PendingStore(dir).list()).toHaveLength(1);
  });
});
