import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

const { LlmTaskReviewer, parseTaskReview } = await import("../src/control/llm-task-reviewer.js");

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

describe("parseTaskReview", () => {
  it("allows when the model agrees the rationale is grounded", () => {
    expect(parseTaskReview("allow: checked the vendor's own pricing page")).toEqual({ allowed: true });
  });

  it("refuses and carries the reason when the model disagrees", () => {
    expect(parseTaskReview("refuse: claim rests on a blog roundup, not the marketplace itself")).toEqual({
      allowed: false,
      reason: "claim rests on a blog roundup, not the marketplace itself",
    });
  });

  it("is case-insensitive on the verdict word", () => {
    expect(parseTaskReview("Refuse: reason here").allowed).toBe(false);
  });

  it("fails open (allows) on an empty reply, rather than blocking on noise", () => {
    expect(parseTaskReview("")).toEqual({ allowed: true });
  });

  it("fails open (allows) when the reply doesn't start with a known verdict", () => {
    expect(parseTaskReview("I'm not sure how to grade this")).toEqual({ allowed: true });
  });

  it("gives a placeholder reason when a refusal has no reason attached", () => {
    expect(parseTaskReview("refuse")).toEqual({
      allowed: false,
      reason: "confidence in this task's rationale did not hold up under review",
    });
  });
});

describe("LlmTaskReviewer", () => {
  it("allows a task from the model's reply", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("allow: sourced from the vendor's own page")]));
    const result = await new LlmTaskReviewer().review({
      text: "Build the checkout flow.", domain: "general", createdBy: "agent:research",
    });
    expect(result).toEqual({ allowed: true });
  });

  it("refuses a task from the model's reply", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("refuse: no primary source checked")]));
    const result = await new LlmTaskReviewer().review({
      text: "Build the checkout flow.", domain: "general", createdBy: "agent:research",
    });
    expect(result).toEqual({ allowed: false, reason: "no primary source checked" });
  });

  it("takes the LAST assistant text if the model produces more than one message", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("thinking..."), assistantMessage("allow: fine")]));
    const result = await new LlmTaskReviewer().review({ text: "x", domain: "general", createdBy: "agent:research" });
    expect(result).toEqual({ allowed: true });
  });

  it("includes the task text and domain in the grading call", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("allow: fine")]));
    await new LlmTaskReviewer().review({ text: "the task text", domain: "the-domain", createdBy: "agent:research" });
    const call = queryMock.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain("the task text");
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

    it("fails open (allows) instead of hanging forever when the grading call stalls", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      queryMock.mockImplementation((opts: { options: { abortController: AbortController } }) =>
        hangingStream(opts.options.abortController.signal),
      );
      const result = await new LlmTaskReviewer(10).review({ text: "x", domain: "general", createdBy: "agent:research" });
      expect(result).toEqual({ allowed: true });
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
        new LlmTaskReviewer(60_000).review({ text: "x", domain: "general", createdBy: "agent:research" }),
      ).rejects.toThrow("transport exploded");
    });
  });
});
