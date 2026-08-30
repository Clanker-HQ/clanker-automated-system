import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

const { buildSuccessorSuggester } = await import("../src/control/build-successor-suggester.js");

function stream(messages: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

afterEach(() => {
  queryMock.mockReset();
  vi.unstubAllEnvs();
});

describe("buildSuccessorSuggester", () => {
  it("resolves to [] with zero real calls when RUNNER=fake", async () => {
    const suggest = buildSuccessorSuggester({ RUNNER: "fake" });
    const result = await suggest("anything");
    expect(result).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("reaches the real LlmSuccessorSuggester's SDK call when RUNNER is not fake", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([{ type: "assistant", message: { content: [{ type: "text", text: "[]" }] } }]));
    const suggest = buildSuccessorSuggester({});
    const result = await suggest("did some work");
    expect(result).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
