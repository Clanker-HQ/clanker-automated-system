import { describe, expect, it } from "vitest";
import { parseRateLimitReset } from "../src/control/rate-limit-reset.js";

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
