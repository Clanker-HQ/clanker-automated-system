import { describe, expect, it } from "vitest";
import { resolveCredentials } from "../src/runner/credentials.js";

describe("resolveCredentials", () => {
  it("uses the subscription token when present", () => {
    const { mode, childEnv } = resolveCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(mode).toBe("subscription");
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });

  it("strips an API key so a stray variable can never cause API billing", () => {
    const { mode, childEnv } = resolveCredentials({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      ANTHROPIC_API_KEY: "sk-should-be-removed",
    });
    expect(mode).toBe("subscription");
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("refuses an API key unless billing is explicitly opted into", () => {
    expect(() => resolveCredentials({ ANTHROPIC_API_KEY: "sk-x" })).toThrow(
      /ALLOW_API_BILLING/,
    );
  });

  it("permits API billing when explicitly opted into", () => {
    const { mode } = resolveCredentials({
      ANTHROPIC_API_KEY: "sk-x", ALLOW_API_BILLING: "true",
    });
    expect(mode).toBe("api-key");
  });

  it("explains how to obtain a token when no credential is present", () => {
    expect(() => resolveCredentials({})).toThrow(/claude setup-token/);
  });
});
