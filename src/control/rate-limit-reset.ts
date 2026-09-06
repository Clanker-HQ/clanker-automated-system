/**
 * Extracts the "resets HH:MM(am/pm) (IANA/Zone)" suffix Claude Code's own
 * session/rate-limit errors carry (e.g. "You've hit your session limit ·
 * resets 1:50pm (Europe/Bratislava)") and turns it into the next UTC instant
 * that wall-clock time occurs in that zone — so a failure caused by a
 * multi-hour limit window can be scheduled to retry once it's actually clear,
 * instead of sharing dispatcher.ts's fixed 1/5/15-minute backoff, none of
 * which can ever bridge a limit that resets hours from now.
 */
const RESET_PATTERN = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*\(([^)]+)\)/i;

/** local wall-clock time minus UTC, in ms, for `timeZone` at the instant `date`. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** The UTC instant at which `timeZone`'s wall clock reads `year-month-day hour:minute:00`. */
function utcForWallClock(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  return new Date(guess - tzOffsetMs(new Date(guess), timeZone));
}

export function parseRateLimitReset(message: string, now: Date): Date | undefined {
  const match = RESET_PATTERN.exec(message);
  if (!match) return undefined;
  const [, hourStr, minuteStr, ampm, timeZone] = match;

  let hour = Number(hourStr);
  const minute = minuteStr ? Number(minuteStr) : 0;
  if (ampm) {
    const lower = ampm.toLowerCase();
    if (lower === "pm" && hour !== 12) hour += 12;
    if (lower === "am" && hour === 12) hour = 0;
  }

  try {
    // Validates the zone: an unrecognized IANA name throws RangeError here.
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return undefined;
  }

  const todayParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  const year = Number(todayParts.year);
  const month = Number(todayParts.month);
  const day = Number(todayParts.day);

  let candidate = utcForWallClock(year, month, day, hour, minute, timeZone!);
  if (candidate.getTime() <= now.getTime()) {
    // Roll the calendar date forward one day — Date.UTC normalizes day
    // overflow across month/year boundaries the same way in every zone, so
    // this needs no zone-specific handling.
    const rolled = new Date(Date.UTC(year, month - 1, day + 1));
    candidate = utcForWallClock(rolled.getUTCFullYear(), rolled.getUTCMonth() + 1, rolled.getUTCDate(), hour, minute, timeZone!);
  }
  return candidate;
}
