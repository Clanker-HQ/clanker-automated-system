import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

const { LlmFindingReviewer, parseReview } = await import("../src/control/llm-finding-reviewer.js");

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

afterEach(() => {
  queryMock.mockReset();
  vi.unstubAllEnvs();
});

describe("parseReview", () => {
  it("keeps the given confidence unchanged when the model agrees", () => {
    expect(parseReview("high: holds", "high")).toEqual({ confidence: "high" });
  });

  it("downgrades confidence and carries the reason when the model disagrees", () => {
    expect(parseReview("low: sourced only from a roundup blog, not the vendor's own page", "medium")).toEqual({
      confidence: "low",
      note: "sourced only from a roundup blog, not the vendor's own page",
    });
  });

  it("is case-insensitive on the confidence word", () => {
    expect(parseReview("Low: reason here", "high").confidence).toBe("low");
  });

  it("never raises confidence above what was given, even if the model tries to", () => {
    expect(parseReview("high: looks solid", "low")).toEqual({ confidence: "low" });
  });

  it("falls back to the given confidence on an empty reply, rather than downgrading on noise", () => {
    expect(parseReview("", "high")).toEqual({ confidence: "high" });
  });

  it("falls back to the given confidence when the reply doesn't start with a known level", () => {
    expect(parseReview("I'm not sure how to grade this", "medium")).toEqual({ confidence: "medium" });
  });

  it("gives a placeholder note when a downgrade has no reason attached", () => {
    expect(parseReview("low", "high")).toEqual({ confidence: "low", note: "confidence downgraded by automated review" });
  });
});

describe("LlmFindingReviewer", () => {
  it("returns the finding's own confidence when the model agrees", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("high: well sourced")]));
    const result = await new LlmFindingReviewer().review({
      topic: "x", conclusion: "y", confidence: "high", sources: ["https://example.com"],
    });
    expect(result).toEqual({ confidence: "high" });
  });

  it("downgrades and attaches a note when the model disagrees", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(
      stream([assistantMessage("low: claim rests on a blog roundup, not the marketplace itself")]),
    );
    const result = await new LlmFindingReviewer().review({
      topic: "x", conclusion: "y", confidence: "medium", sources: ["https://example.com/roundup"],
    });
    expect(result).toEqual({ confidence: "low", note: "claim rests on a blog roundup, not the marketplace itself" });
  });

  it("takes the LAST assistant text if the model produces more than one message", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("thinking..."), assistantMessage("high: holds")]));
    const result = await new LlmFindingReviewer().review({ topic: "x", conclusion: "y", confidence: "high", sources: [] });
    expect(result).toEqual({ confidence: "high" });
  });

  it("includes the topic, conclusion, confidence, and sources in the grading call", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("high: fine")]));
    await new LlmFindingReviewer().review({
      topic: "the topic", conclusion: "the conclusion", confidence: "high", sources: ["https://a.example"],
    });
    const call = queryMock.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain("the topic");
    expect(call.prompt).toContain("the conclusion");
    expect(call.prompt).toContain("high");
    expect(call.prompt).toContain("https://a.example");
  });

  describe("timeout", () => {
    function hangingStream(signal: AbortSignal): AsyncIterable<unknown> {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      };
    }

    it("falls back to the given confidence instead of hanging forever when the grading call stalls", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      queryMock.mockImplementation((opts: { options: { abortController: AbortController } }) =>
        hangingStream(opts.options.abortController.signal),
      );
      const result = await new LlmFindingReviewer(10).review({ topic: "x", conclusion: "y", confidence: "medium", sources: [] });
      expect(result).toEqual({ confidence: "medium" });
    });

    it("propagates a rejection unrelated to the timeout", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      queryMock.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          throw new Error("transport exploded");
        },
      });
      await expect(
        new LlmFindingReviewer(60_000).review({ topic: "x", conclusion: "y", confidence: "high", sources: [] }),
      ).rejects.toThrow("transport exploded");
    });
  });
});
