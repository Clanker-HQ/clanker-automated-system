import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

const { buildReflectionSynthesiser } = await import("../src/control/build-reflection-synthesiser.js");

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

describe("buildReflectionSynthesiser", () => {
  it("resolves to [] with zero real calls when RUNNER=fake", async () => {
    const synthesise = buildReflectionSynthesiser({ RUNNER: "fake" });
    const result = await synthesise("anything");
    expect(result).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("reaches the real LlmReflectionSynthesiser's SDK call when RUNNER is not fake", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([{ type: "assistant", message: { content: [{ type: "text", text: "[]" }] } }]));
    const synthesise = buildReflectionSynthesiser({});
    const result = await synthesise("some digest text");
    expect(result).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
