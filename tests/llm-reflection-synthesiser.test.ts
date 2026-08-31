import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

const { LlmReflectionSynthesiser, parseReflections } = await import("../src/control/llm-reflection-synthesiser.js");

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

// Matches tests/llm-successor-suggester.test.ts's established convention:
// without this, queryMock's call history from earlier tests in this file
// leaks into later ones.
afterEach(() => {
  queryMock.mockReset();
  vi.unstubAllEnvs();
});

function reflection(over: Record<string, unknown> = {}) {
  return { domain: "research", subject: "recurring pattern", body: "conclusion body", importance: 6, ...over };
}

describe("parseReflections", () => {
  it("parses a clean JSON array of valid reflections", () => {
    const result = parseReflections(JSON.stringify([reflection()]));
    expect(result).toEqual([reflection()]);
  });

  it("strips a ```json fence before parsing", () => {
    const fenced = "```json\n" + JSON.stringify([reflection()]) + "\n```";
    expect(parseReflections(fenced)).toEqual([reflection()]);
  });

  it("strips a bare ``` fence (no language tag) before parsing", () => {
    const fenced = "```\n" + JSON.stringify([reflection()]) + "\n```";
    expect(parseReflections(fenced)).toEqual([reflection()]);
  });

  it("drops malformed items out of an otherwise-mixed array", () => {
    const badImportance = reflection({ importance: 11 }); // out of 1-10 range
    const missingDomain = { subject: "x", body: "x", importance: 5 }; // no domain
    const nonStringBody = reflection({ body: 123 });
    const good = reflection({ subject: "another pattern", body: "another conclusion" });
    const result = parseReflections(JSON.stringify([badImportance, missingDomain, nonStringBody, good]));
    expect(result).toEqual([good]);
  });

  it("returns [] for non-array JSON", () => {
    expect(parseReflections(JSON.stringify({ not: "an array" }))).toEqual([]);
  });

  it("returns [] for invalid JSON entirely, without throwing", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseReflections("this is not json at all {{{")).toEqual([]);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("returns [] for an empty string", () => {
    expect(parseReflections("")).toEqual([]);
    expect(parseReflections("   ")).toEqual([]);
  });
});

describe("LlmReflectionSynthesiser", () => {
  it("resolves to the parsed array of reflections from a valid JSON reply", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage(JSON.stringify([reflection()]))]));
    const result = await new LlmReflectionSynthesiser().synthesise("[research] x -> achieved: done");
    expect(result).toEqual([reflection()]);
  });

  it("includes the digest text in the synthesis call", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("[]")]));
    await new LlmReflectionSynthesiser().synthesise("[research] pricing tiers -> achieved: found three");
    const call = queryMock.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain("[research] pricing tiers -> achieved: found three");
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

    it("aborts a stalled synthesis call after the timeout and returns [] instead of hanging forever", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      queryMock.mockImplementation((opts: { options: { abortController: AbortController } }) =>
        hangingStream(opts.options.abortController.signal),
      );
      const result = await new LlmReflectionSynthesiser(10).synthesise("x");
      expect(result).toEqual([]);
    });

    it("keeps an answer already received before the timeout fires, rather than discarding it", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      queryMock.mockImplementation((opts: { options: { abortController: AbortController } }) => ({
        async *[Symbol.asyncIterator]() {
          yield assistantMessage(JSON.stringify([reflection()]));
          await new Promise<void>((resolve, reject) => {
            opts.options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      }));
      const result = await new LlmReflectionSynthesiser(10).synthesise("x");
      expect(result).toEqual([reflection()]);
    });
  });

  it("returns [] rather than throwing when the transport rejects for a reason unrelated to the timeout", async () => {
    // Unlike LlmRouter/LlmOutcomeVerifier, this synthesiser never propagates —
    // see the class's own doc comment: any failure at all degrades to [],
    // since a wedged synthesiser must never be able to disturb the reflection
    // batch job.
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      queryMock.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          throw new Error("transport exploded");
        },
      });
      const result = await new LlmReflectionSynthesiser(60_000).synthesise("x");
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
      queryMock.mockReturnValue(stream([assistantMessage("sure, here are some conclusions: things are working")]));
      const result = await new LlmReflectionSynthesiser().synthesise("x");
      expect(result).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
