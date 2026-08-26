import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { resolveCredentials } from "../src/runner/credentials.js";

/**
 * Every variable the installed CLI honours to route a run at a *paid*
 * provider, read from its own process.env. An inherited
 * CLAUDE_CODE_USE_BEDROCK=1 — a plausible leftover on a developer machine —
 * would bill AWS while resolveCredentials still reported mode "subscription".
 */
const ALTERNATE_PROVIDER_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
];

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

  it("strips every alternate-provider switch the CLI honours", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: "tok" };
    for (const name of ALTERNATE_PROVIDER_VARS) env[name] = "leftover";

    const { mode, childEnv } = resolveCredentials(env);

    expect(mode).toBe("subscription");
    for (const name of ALTERNATE_PROVIDER_VARS) {
      expect(childEnv[name], `${name} must not reach the agent process`).toBeUndefined();
    }
  });

  it("strips arbitrary host secrets: the child gets an allowlist, not the shell profile", () => {
    const { childEnv } = resolveCredentials({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      DISCORD_WEBHOOK_SMOKE: "https://discord.test/hook",
      GH_TOKEN: "ghp-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    });
    expect(childEnv.DISCORD_WEBHOOK_SMOKE).toBeUndefined();
    expect(childEnv.GH_TOKEN).toBeUndefined();
    expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("passes through the non-secret variables a child process needs", () => {
    const { childEnv } = resolveCredentials({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      PATH: "/usr/bin",
      HOME: "/home/owner",
      TEMP: "/tmp",
      TZ: "Europe/Berlin",
      NODE_ENV: "production",
    });
    expect(childEnv.PATH).toBe("/usr/bin");
    expect(childEnv.HOME).toBe("/home/owner");
    expect(childEnv.TEMP).toBe("/tmp");
    expect(childEnv.TZ).toBe("Europe/Berlin");
    expect(childEnv.NODE_ENV).toBe("production");
  });

  it("matches allowlisted names case-insensitively, preserving the host's casing", () => {
    const { childEnv } = resolveCredentials({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      SystemRoot: "C:\Windows",
      Path: "C:\Windows\System32",
    });
    expect(childEnv.SystemRoot).toBe("C:\Windows");
    expect(childEnv.Path).toBe("C:\Windows\System32");
  });

  it("refuses an API key unless billing is explicitly opted into", () => {
    expect(() => resolveCredentials({ ANTHROPIC_API_KEY: "sk-x" })).toThrow(
      /ALLOW_API_BILLING/,
    );
  });

  it("permits API billing when explicitly opted into, passing only that key", () => {
    const { mode, childEnv } = resolveCredentials({
      ANTHROPIC_API_KEY: "sk-x",
      ALLOW_API_BILLING: "true",
      CLAUDE_CODE_USE_BEDROCK: "1",
      GH_TOKEN: "ghp-secret",
    });
    expect(mode).toBe("api-key");
    expect(childEnv.ANTHROPIC_API_KEY).toBe("sk-x");
    expect(childEnv.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(childEnv.GH_TOKEN).toBeUndefined();
  });

  it("explains how to obtain a token when no credential is present", () => {
    expect(() => resolveCredentials({})).toThrow(/claude setup-token/);
  });

  // index.ts only formats ValidationError; a plain Error would reach the owner
  // as a bare stack trace instead of the formatted boot-failure message.
  it("throws ValidationError so a missing credential formats like every other boot failure", () => {
    expect(() => resolveCredentials({})).toThrow(ValidationError);
    expect(() => resolveCredentials({ ANTHROPIC_API_KEY: "sk-x" })).toThrow(ValidationError);
  });
});
