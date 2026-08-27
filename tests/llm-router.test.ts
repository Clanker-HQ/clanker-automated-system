import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

const { LlmRouter } = await import("../src/control/llm-router.js");

function stream(messages: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

function assistantMessage(text: string) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

// Matches tests/sdk-runner-options.test.ts's established convention: without
// this, queryMock's call history from earlier tests in this file leaks into
// later ones (e.g. the "no specialists" test below would see calls made by
// prior tests and wrongly fail toHaveBeenCalled assertions).
afterEach(() => {
  queryMock.mockReset();
  vi.unstubAllEnvs();
});

describe("LlmRouter", () => {
  it("returns the specialist whose name the model replies with", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("research")]));
    const result = await new LlmRouter().route("find a profitable niche", [
      { name: "research", description: "researches things" },
    ]);
    expect(result).toBe("research");
  });

  it("matches case-insensitively", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("Research")]));
    const result = await new LlmRouter().route("x", [{ name: "research", description: "d" }]);
    expect(result).toBe("research");
  });

  it("returns null when the model says none", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("none")]));
    const result = await new LlmRouter().route("x", [{ name: "research", description: "d" }]);
    expect(result).toBeNull();
  });

  it("returns null when the model names something not in the specialist list", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("some-made-up-agent")]));
    const result = await new LlmRouter().route("x", [{ name: "research", description: "d" }]);
    expect(result).toBeNull();
  });

  it("takes the LAST assistant text if the model produces more than one message", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("thinking..."), assistantMessage("research")]));
    const result = await new LlmRouter().route("x", [{ name: "research", description: "d" }]);
    expect(result).toBe("research");
  });

  it("returns null immediately without calling query when there are no specialists", async () => {
    const result = await new LlmRouter().route("x", []);
    expect(result).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
