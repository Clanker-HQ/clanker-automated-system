import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

const { LlmOutcomeVerifier, parseVerdict } = await import("../src/control/llm-outcome-verifier.js");

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

describe("parseVerdict", () => {
  it("parses a verdict and reason separated by a colon", () => {
    expect(parseVerdict("achieved: found three providers and compared them")).toEqual({
      verdict: "achieved",
      reason: "found three providers and compared them",
    });
  });

  it("is case-insensitive on the verdict word", () => {
    expect(parseVerdict("Not-Achieved: only looked at one provider").verdict).toBe("not-achieved");
  });

  it("falls back to unclear on an empty reply", () => {
    expect(parseVerdict("").verdict).toBe("unclear");
    expect(parseVerdict("   ").reason).toContain("no answer");
  });

  it("falls back to unclear when the reply doesn't start with a known verdict", () => {
    const result = parseVerdict("I'm not sure how to grade this");
    expect(result.verdict).toBe("unclear");
    expect(result.reason).toContain("could not parse");
  });

  it("gives a placeholder reason when the verdict has no reason attached", () => {
    expect(parseVerdict("achieved").reason).toBe("(no reason given)");
  });
});

describe("LlmOutcomeVerifier", () => {
  it("grades a run as achieved from the model's reply", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("achieved: did the thing as asked")]));
    const result = await new LlmOutcomeVerifier().verify({ prompt: "do the thing", summary: "did it", tail: [] });
    expect(result).toEqual({ verdict: "achieved", reason: "did the thing as asked" });
  });

  it("grades a run as not-achieved from the model's reply", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("not-achieved: only researched the named examples")]));
    const result = await new LlmOutcomeVerifier().verify({ prompt: "research broadly", summary: "researched", tail: [] });
    expect(result.verdict).toBe("not-achieved");
  });

  it("takes the LAST assistant text if the model produces more than one message", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("thinking..."), assistantMessage("achieved: done")]));
    const result = await new LlmOutcomeVerifier().verify({ prompt: "x", summary: "y", tail: [] });
    expect(result.verdict).toBe("achieved");
  });

  it("includes the prompt, summary, and tail in the grading call", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("achieved: fine")]));
    await new LlmOutcomeVerifier().verify({ prompt: "the task", summary: "the summary", tail: ["line one"] });
    const call = queryMock.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain("the task");
    expect(call.prompt).toContain("the summary");
    expect(call.prompt).toContain("line one");
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

    it("returns unclear instead of hanging forever when the grading call stalls", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      queryMock.mockImplementation((opts: { options: { abortController: AbortController } }) =>
        hangingStream(opts.options.abortController.signal),
      );
      const result = await new LlmOutcomeVerifier(10).verify({ prompt: "x", summary: "y", tail: [] });
      expect(result.verdict).toBe("unclear");
    });

    it("keeps an answer already received before the timeout fires, rather than discarding it", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      queryMock.mockImplementation((opts: { options: { abortController: AbortController } }) => ({
        async *[Symbol.asyncIterator]() {
          yield assistantMessage("achieved: got there first");
          await new Promise<void>((resolve, reject) => {
            opts.options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      }));
      const result = await new LlmOutcomeVerifier(10).verify({ prompt: "x", summary: "y", tail: [] });
      expect(result.verdict).toBe("achieved");
    });

    it("propagates a rejection unrelated to the timeout", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      queryMock.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          throw new Error("transport exploded");
        },
      });
      await expect(new LlmOutcomeVerifier(60_000).verify({ prompt: "x", summary: "y", tail: [] })).rejects.toThrow(
        "transport exploded",
      );
    });
  });
});
