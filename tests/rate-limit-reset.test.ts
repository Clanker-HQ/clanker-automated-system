import { describe, expect, it } from "vitest";
import { boundRateLimitReset, isLimitError, parseRateLimitReset, RATE_LIMIT_RESET_MAX_MS } from "../src/control/rate-limit-reset.js";

describe("parseRateLimitReset", () => {
  it("parses a 12-hour reset time with am/pm into today's occurrence in that zone, when it hasn't passed yet", () => {
    const now = new Date("2026-01-01T10:00:00.000Z");
    const result = parseRateLimitReset("You've hit your session limit · resets 3:00pm (UTC)", now);
    expect(result).toEqual(new Date("2026-01-01T15:00:00.000Z"));
  });

  it("rolls over to the next day when the reset time already passed today", () => {
    const now = new Date("2026-01-01T16:00:00.000Z");
    const result = parseRateLimitReset("You've hit your session limit · resets 3:00pm (UTC)", now);
    expect(result).toEqual(new Date("2026-01-02T15:00:00.000Z"));
  });

  it("converts a non-UTC IANA timezone to the correct UTC instant", () => {
    // 1:50pm in Asia/Tokyo (UTC+9, no DST) is 04:50 UTC the same day.
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = parseRateLimitReset("You've hit your session limit · resets 1:50pm (Asia/Tokyo)", now);
    expect(result).toEqual(new Date("2026-01-01T04:50:00.000Z"));
  });

  it("parses a 24-hour time with no am/pm marker", () => {
    const now = new Date("2026-01-01T10:00:00.000Z");
    const result = parseRateLimitReset("resets 15:30 (UTC)", now);
    expect(result).toEqual(new Date("2026-01-01T15:30:00.000Z"));
  });

  it("defaults minutes to 0 when the time has no minutes component", () => {
    const now = new Date("2026-01-01T10:00:00.000Z");
    const result = parseRateLimitReset("resets 3pm (UTC)", now);
    expect(result).toEqual(new Date("2026-01-01T15:00:00.000Z"));
  });

  it("returns undefined for a message with no resets-style suffix", () => {
    expect(parseRateLimitReset("boom", new Date("2026-01-01T00:00:00.000Z"))).toBeUndefined();
  });

  it("returns undefined when the parenthesized timezone is not a valid IANA zone", () => {
    const now = new Date("2026-01-01T10:00:00.000Z");
    expect(parseRateLimitReset("resets 3pm (Nowhere/Fake)", now)).toBeUndefined();
  });
});

// The real incident: improvement-scout was disabled on 2026-09-08 because
// two of its three breaker-tripping "failures" were subscription limit hits,
// whose message ("You've hit your session limit · resets 1:20pm
// (Europe/Bratislava)") contains no "rate_limit" substring — the only thing
// the old detector looked for. See src/control/rate-limit-reset.ts.
// Guards against a parseRateLimitReset bug or a malformed message handing
// back an instant that would defer an entry forever (too far out) or never
// actually come due (undefined) — see boundRateLimitReset's own doc comment
// and src/control/webhook-retry-store.ts / dispatcher.ts, which apply this
// before ever writing to `nextRetryAt`.
describe("boundRateLimitReset", () => {
  const now = new Date("2026-09-13T12:00:00.000Z");

  it("passes through undefined unchanged", () => {
    expect(boundRateLimitReset(undefined, now)).toBeUndefined();
  });

  it("passes through a plausible near-future instant unchanged", () => {
    const target = new Date(now.getTime() + 60 * 60 * 1000);
    expect(boundRateLimitReset(target, now)).toEqual(target);
  });

  it("passes through an instant exactly at the ceiling", () => {
    const target = new Date(now.getTime() + RATE_LIMIT_RESET_MAX_MS);
    expect(boundRateLimitReset(target, now)).toEqual(target);
  });

  it("rejects (returns undefined for) an instant beyond the ceiling", () => {
    const target = new Date(now.getTime() + RATE_LIMIT_RESET_MAX_MS + 1);
    expect(boundRateLimitReset(target, now)).toBeUndefined();
  });

  it("clamps a past instant up to now, rather than rejecting it", () => {
    const target = new Date(now.getTime() - 60 * 60 * 1000);
    expect(boundRateLimitReset(target, now)).toEqual(now);
  });

  it("clamps an instant equal to now unchanged", () => {
    expect(boundRateLimitReset(now, now)).toEqual(now);
  });
});

describe("isLimitError", () => {
  it.each([
    "Claude Code returned an error result: You've hit your session limit · resets 1:20pm (Europe/Bratislava)",
    "You've hit your session limit · resets 3:30pm (Europe/Bratislava)",
    "Claude usage limit reached",
    "assistant message reported error: rate_limit",
    "You've reached your 5-hour limit · resets 3:00pm (UTC)",
    "Rate limit exceeded",
  ])("recognises %s as the environment refusing, not the agent failing", (message) => {
    expect(isLimitError(message)).toBe(true);
  });

  it.each([
    "Claude Code returned an error result: Reached maximum number of turns (30)",
    "TypeError: cannot read property of undefined",
    "Stopped after 5 consecutive tool failures with nothing succeeding in between.",
    "git push rejected: non-fast-forward",
    "",
  ])("does not mistake a genuine agent failure (%s) for a limit hit", (message) => {
    expect(isLimitError(message)).toBe(false);
  });
});
