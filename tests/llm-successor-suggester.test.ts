import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

const { LlmSuccessorSuggester, parseSuggestions } = await import("../src/control/llm-successor-suggester.js");

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

// Matches tests/llm-router.test.ts's established convention: without this,
// queryMock's call history from earlier tests in this file leaks into later
// ones.
afterEach(() => {
  queryMock.mockReset();
  vi.unstubAllEnvs();
});

function suggestion(over: Record<string, unknown> = {}) {
  return { text: "investigate pricing tiers", domain: "research", subject: "investigate pricing tiers", importance: 5, goalAlignment: 0.6, ...over };
}

describe("parseSuggestions", () => {
  it("parses a clean JSON array of valid suggestions", () => {
    const result = parseSuggestions(JSON.stringify([suggestion()]));
    expect(result).toEqual([suggestion()]);
  });

  it("strips a ```json fence before parsing", () => {
    const fenced = "```json\n" + JSON.stringify([suggestion()]) + "\n```";
    expect(parseSuggestions(fenced)).toEqual([suggestion()]);
  });

  it("strips a bare ``` fence (no language tag) before parsing", () => {
    const fenced = "```\n" + JSON.stringify([suggestion()]) + "\n```";
    expect(parseSuggestions(fenced)).toEqual([suggestion()]);
  });

  it("drops malformed items out of an otherwise-mixed array", () => {
    const badImportance = suggestion({ importance: 11 }); // out of 1-10 range
    const missingDomain = { text: "x", subject: "x", importance: 5, goalAlignment: 0.5 }; // no domain
    const nonStringText = suggestion({ text: 123 });
    const good = suggestion({ subject: "compare hosting costs", text: "compare hosting costs" });
    const result = parseSuggestions(JSON.stringify([badImportance, missingDomain, nonStringText, good]));
    expect(result).toEqual([good]);
  });

  it("returns [] for non-array JSON", () => {
    expect(parseSuggestions(JSON.stringify({ not: "an array" }))).toEqual([]);
  });

  it("returns [] for invalid JSON entirely, without throwing", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseSuggestions("this is not json at all {{{")).toEqual([]);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("returns [] for an empty string", () => {
    expect(parseSuggestions("")).toEqual([]);
    expect(parseSuggestions("   ")).toEqual([]);
  });
});

describe("LlmSuccessorSuggester", () => {
  it("resolves to the parsed array of suggestions from a valid JSON reply", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage(JSON.stringify([suggestion()]))]));
    const result = await new LlmSuccessorSuggester().suggest("found three candidates");
    expect(result).toEqual([suggestion()]);
  });

  it("includes the summary in the suggestion call", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("[]")]));
    await new LlmSuccessorSuggester().suggest("found three profitable niches");
    const call = queryMock.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain("found three profitable niches");
  });

  describe("timeout", () => {
    /** A stream that hangs forever unless its AbortSignal fires, mimicking a stalled network call rather than a clean error. */
    function hangingStream(signal: AbortSignal): AsyncIterable<unknown> {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      };
    }

    it("aborts a stalled suggestion call after the timeout and returns [] instead of hanging forever", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      queryMock.mockImplementation((opts: { options: { abortController: AbortController } }) =>
        hangingStream(opts.options.abortController.signal),
      );
      const result = await new LlmSuccessorSuggester(10).suggest("x");
      expect(result).toEqual([]);
    });

    it("keeps an answer already received before the timeout fires, rather than discarding it", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      queryMock.mockImplementation((opts: { options: { abortController: AbortController } }) => ({
        async *[Symbol.asyncIterator]() {
          yield assistantMessage(JSON.stringify([suggestion()]));
          await new Promise<void>((resolve, reject) => {
            opts.options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      }));
      const result = await new LlmSuccessorSuggester(10).suggest("x");
      expect(result).toEqual([suggestion()]);
    });
  });

  it("returns [] rather than throwing when the transport rejects for a reason unrelated to the timeout", async () => {
    // Unlike LlmRouter/LlmOutcomeVerifier, this suggester never propagates —
    // see the class's own doc comment: any failure at all degrades to [],
    // since a wedged suggester must never be able to disturb the dispatcher.
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      queryMock.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          throw new Error("transport exploded");
        },
      });
      const result = await new LlmSuccessorSuggester(60_000).suggest("x");
      expect(result).toEqual([]);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("returns [] without throwing when the model's reply is not valid JSON", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      queryMock.mockReturnValue(stream([assistantMessage("sure, here are some ideas: do the thing")]));
      const result = await new LlmSuccessorSuggester().suggest("x");
      expect(result).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
