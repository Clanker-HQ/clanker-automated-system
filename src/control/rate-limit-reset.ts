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

/**
 * The next instant at or after `now` when `timeZone`'s wall clock reads
 * `hour:minute` — rolling forward to tomorrow if that time has already
 * passed today. Factored out of parseRateLimitReset so webhook-wiring.ts's
 * preAdmissionResetAt can reuse the exact same "next occurrence of a named
 * clock time" logic for a quiet-hours end time or a daily-budget midnight
 * reset, neither of which comes from a parsed error message the way a
 * session-limit reset does, but which name an equally knowable wall-clock
 * instant.
 */
export function nextOccurrenceOfWallClock(hour: number, minute: number, timeZone: string, now: Date): Date {
  const todayParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  const year = Number(todayParts.year);
  const month = Number(todayParts.month);
  const day = Number(todayParts.day);

  let candidate = utcForWallClock(year, month, day, hour, minute, timeZone);
  if (candidate.getTime() <= now.getTime()) {
    // Roll the calendar date forward one day — Date.UTC normalizes day
    // overflow across month/year boundaries the same way in every zone, so
    // this needs no zone-specific handling.
    const rolled = new Date(Date.UTC(year, month - 1, day + 1));
    candidate = utcForWallClock(rolled.getUTCFullYear(), rolled.getUTCMonth() + 1, rolled.getUTCDate(), hour, minute, timeZone);
  }
  return candidate;
}

/**
 * Ceiling on how far in the future a parsed rate-limit reset instant may be
 * trusted before the entry deferring to it is treated as if no reset time
 * had been parsed at all — mirroring governor.ts's RATE_LIMIT_MAX_HOLD_MS and
 * cron.ts's MAX_LIMIT_RETRY_WAIT_MS, both bounded for the identical reason:
 * a `resetsAt` further out than any real subscription window is not
 * credible (a parsing slip, a clock skew, an API changing units), and
 * trusting it anyway is exactly how a bad parse turns into a deferral that
 * never comes back. 24 hours is well past the longest window the
 * subscription actually has (five hours) while still comfortably covering a
 * reset instant that names a time later today or tomorrow.
 */
export const RATE_LIMIT_RESET_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Validates (and where sensible, repairs) a parsed rate-limit reset instant
 * before anything is allowed to defer to it.
 *
 * Two failure modes, both from parseRateLimitReset having a bug or being fed
 * a malformed message, are guarded against here rather than trusted straight
 * through to `nextRetryAt`:
 *
 * - `target` beyond RATE_LIMIT_RESET_MAX_MS out is not credible (a parsing
 *   slip, a clock skew, an API changing units) — this returns `undefined`,
 *   the same "treat it as if nothing had parsed" fallback a `message` that
 *   never matched RESET_PATTERN already gets, so a caller need not
 *   special-case an implausible reset instant differently from no reset
 *   instant at all.
 * - `target` already at or before `now` is clamped up to `now` rather than
 *   rejected: an entry is already eligible for its very next drain tick
 *   whenever `nextRetryAt` is in the past (see webhook-wiring.ts's
 *   drainWebhookRetries and task-store.ts's nextPending, both of which treat
 *   "in the past" as "eligible now"), which is exactly right when a reset
 *   instant is only moments stale by the time it's recorded. Rejecting it
 *   outright would needlessly fall back to the fixed-backoff/attempt-count
 *   path for a defer that is, in fact, still perfectly legitimate.
 */
export function boundRateLimitReset(target: Date | undefined, now: Date): Date | undefined {
  if (!target) return undefined;
  const deltaMs = target.getTime() - now.getTime();
  if (deltaMs > RATE_LIMIT_RESET_MAX_MS) return undefined;
  return deltaMs < 0 ? now : target;
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

  return nextOccurrenceOfWallClock(hour, minute, timeZone!, now);
}

/**
 * Wording that means "the subscription is out of capacity right now", as
 * opposed to anything the agent itself did wrong.
 *
 * `rate_limit` is the SDK's own structured error string. The rest is what
 * Claude Code actually prints to a human — and that difference is what broke
 * improvement-scout on 2026-09-08. The only detector in the system tested for
 * the substring `rate_limit`, so the message its own runs recorded ("You've
 * hit your session limit · resets 1:20pm (Europe/Bratislava)") did not match:
 * two limit hits were filed as agent failures, a genuine max-turns failure
 * landed between them, and three "failures" is a tripped circuit breaker. The
 * agent was disabled for the one thing it demonstrably had no control over.
 */
const LIMIT_WORDING = /rate_limit|(?:rate|session|usage)[\s-]+limit/i;

/**
 * Whether a run's error came from the subscription's limits rather than from
 * anything the agent did — the single detector for that question, shared by
 * the orchestrator's status classification (which keeps a limit hit out of
 * the circuit breaker), the governor's admission backoff, and the
 * dispatcher's retry deferral, so the three can never disagree about what
 * counts as "not now".
 *
 * A parseable reset suffix counts on its own: message wording is Claude
 * Code's to change at will, but "· resets 3:00pm (Europe/Bratislava)" is a
 * statement only a capacity window ever makes. That also covers phrasings
 * this file has never seen — "You've reached your 5-hour limit", say, which
 * matches none of the nouns above.
 */
export function isLimitError(message: string): boolean {
  return LIMIT_WORDING.test(message) || RESET_PATTERN.test(message);
}
