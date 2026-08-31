import { readFileSync } from "node:fs";
import { Cron } from "croner";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ValidationError, formatZodError } from "./errors.js";

/**
 * True only for a schedule croner can actually run — shared by an agent's own
 * `trigger.schedule` (registry.ts) and `digest`/`retention`'s schedules
 * below, so a typo'd cron expression fails boot with a named, formatted error
 * in every one of these places, not just the one that happened to get checked.
 */
export function isValidCron(expression: string, timezone: string): boolean {
  try {
    const probe = new Cron(expression, { timezone, paused: true });
    probe.stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * True only for canonical IANA zone names.
 *
 * `new Intl.DateTimeFormat({ timeZone })` is NOT a sufficient check: it accepts
 * "+02:00", "PST", "EST", and "Etc/GMT-2", none of which carry daylight-saving
 * rules. The canonical list is the real test — but "UTC" is legitimately absent
 * from it, so it is allowed explicitly.
 */
const CANONICAL_ZONES: ReadonlySet<string> = new Set([
  ...Intl.supportedValuesOf("timeZone"),
  "UTC",
]);

export function isValidTimeZone(tz: string): boolean {
  return CANONICAL_ZONES.has(tz);
}

const TimeOfDay = z.string().superRefine((v, ctx) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must be a 24-hour time such as "22:00"; received ${JSON.stringify(v)}`,
    });
  }
});

const IanaTimezone = z.string().superRefine((v, ctx) => {
  if (!isValidTimeZone(v)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must be a canonical IANA zone name such as "Europe/Berlin" (or "UTC"); received ${JSON.stringify(v)}. Offsets ("+02:00") and abbreviations ("CEST", "PST") are rejected because they do not carry daylight-saving rules`,
    });
  }
});

export const QuietHoursSchema = z
  .object({
    from: TimeOfDay,
    to: TimeOfDay,
    timezone: IanaTimezone,
  })
  .strict()
  .superRefine((v, ctx) => {
    // Governor.isWithinQuietHours only ever checks `current >= from && current
    // < to` (a same-day window) — with `from >= to`, that comparison can never
    // be true for ANY current time, so an overnight window ("22:00"-"07:00")
    // or a zero-length one ("03:00"-"03:00") would pass validation, get
    // written/echoed back as if it worked, and then silently suppress
    // nothing, forever. Same bug class as `approval: "auto"` on a
    // non-autonomous tier: config that looks like it should do something but
    // structurally cannot, caught here instead of discovered by a human
    // wondering why quiet hours never once kicked in.
    if (v.from >= v.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message:
          `"${v.from}"-"${v.to}" can never suppress anything — quiet hours only support a same-day ` +
          `window, so \`from\` must be earlier than \`to\`. An overnight window (e.g. "22:00"-"07:00") ` +
          `isn't representable; pick two same-day windows instead if you need to cover midnight`,
      });
    }
  });

/**
 * A bad cron expression here used to fail silently: nothing calls startDigest/
 * startRetention until well after config is parsed, so `new Cron(...)`
 * throwing there was only ever caught by index.ts's generic `.catch()` and
 * logged to console — the digest or retention sweep would just never get
 * scheduled, with no boot failure naming the actual problem the way every
 * other bad config value gets. Checked here instead, at the same place (and
 * in the same shape) as an agent's own `trigger.schedule` in registry.ts.
 */
function validateCronSchedule(v: { schedule: string; timezone: string }, ctx: z.RefinementCtx): void {
  if (!isValidCron(v.schedule, v.timezone)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schedule"],
      message:
        `"${v.schedule}" is not a valid cron expression for timezone "${v.timezone}". Use five or six ` +
        `fields (croner also accepts a leading seconds field), e.g. "0 8 * * *" for 08:00 daily`,
    });
  }
}

export const DigestSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Daily at 08:00 by default — croner's standard 5-field cron syntax, same as an agent's own `trigger.schedule`.
    schedule: z.string().default("0 8 * * *"),
    timezone: IanaTimezone.default("UTC"),
    // A key into discord.channels/discord.botChannels, same as an agent's outbox.discord.
    channel: z.string().default("ops"),
  })
  .strict()
  .superRefine(validateCronSchedule);

export const RetentionSchema = z
  .object({
    enabled: z.boolean().default(true),
    days: z.number().int().positive().default(30),
    // Weekly, Sunday 04:00 by default — this is bulk deletion, not routine reporting; no need for daily.
    schedule: z.string().default("0 4 * * 0"),
    timezone: IanaTimezone.default("UTC"),
    channel: z.string().default("ops"),
  })
  .strict()
  .superRefine(validateCronSchedule);

export const MetricsSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Weekly, Monday 04:00 by default — one hour after reflection's Monday
    // 03:00 (MemorySchema.reflectionSchedule below), so the two weekly
    // passes never tick at the same instant.
    schedule: z.string().default("0 4 * * 1"),
    timezone: IanaTimezone.default("UTC"),
    /** How far back each snapshot's window reaches. */
    windowDays: z.number().int().positive().default(7),
  })
  .strict()
  .superRefine(validateCronSchedule);

export const MemorySchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Raw records older than this are pruned by the retention job. */
    retentionDays: z.number().int().positive().default(90),
    /** Reflections are already compressed, so they outlive raw records. */
    reflectionRetentionDays: z.number().int().positive().default(365),
    /** Above this similarity, a candidate counts as covering the same ground. */
    similarityThreshold: z.number().min(0).max(1).default(0.75),
    /** A prior record older than this no longer suppresses a repeat — the world moved on. */
    stalenessDays: z.number().int().positive().default(30),
    recencyHalfLifeDays: z.number().int().positive().default(14),
    /** Successor chain depth cap — bounds runaway self-propagation. */
    maxChainDepth: z.number().int().nonnegative().default(3),
    /** Ceiling on agent-originated tasks per rolling day, independent of depth. */
    maxAgentTasksPerDay: z.number().int().positive().default(20),
    weights: z
      .object({
        goal: z.number().min(0).default(0.5),
        novelty: z.number().min(0).default(0.25),
        importance: z.number().min(0).default(0.15),
        recency: z.number().min(0).default(0.1),
      })
      .strict()
      .prefault({}),
    /** Weekly, Monday 03:00 by default — batch synthesis, not routine reporting. */
    reflectionSchedule: z.string().default("0 3 * * 1"),
    reflectionTimezone: IanaTimezone.default("UTC"),
    /** How far back a reflection pass reads. */
    reflectionWindowDays: z.number().int().positive().default(14),
  })
  .strict()
  .superRefine((v, ctx) => {
    // MemorySchema's field names (reflectionSchedule/reflectionTimezone)
    // don't match validateCronSchedule's expected {schedule, timezone}
    // shape, so the check is inlined here rather than reused directly — same
    // validation, same boot-failure posture as DigestSchema/RetentionSchema.
    if (!isValidCron(v.reflectionSchedule, v.reflectionTimezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reflectionSchedule"],
        message:
          `"${v.reflectionSchedule}" is not a valid cron expression for timezone "${v.reflectionTimezone}". Use five or ` +
          `six fields (croner also accepts a leading seconds field), e.g. "0 3 * * 1" for Monday 03:00`,
      });
    }
  });

export const GovernorSchema = z
  .object({
    maxConcurrent: z.number().int().positive().default(2),
    dailyBudgetUsd: z.number().positive().default(10),
    pendingTimeoutHours: z.number().positive().default(24),
    quietHours: QuietHoursSchema.nullable().default(null),
  })
  .strict();

export const ConfigSchema = z
  .object({
    governor: GovernorSchema.prefault({}),
    discord: z
      .object({
        channels: z.record(z.string(), z.string()).default({}),
        botChannels: z.record(z.string(), z.string()).default({}).prefault({}),
      })
      .strict()
      .prefault({}),
    digest: DigestSchema.prefault({}),
    retention: RetentionSchema.prefault({}),
    metrics: MetricsSchema.prefault({}),
    memory: MemorySchema.prefault({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type GovernorConfig = z.infer<typeof GovernorSchema>;
export type QuietHours = z.infer<typeof QuietHoursSchema>;
export type DigestConfig = z.infer<typeof DigestSchema>;
export type RetentionConfig = z.infer<typeof RetentionSchema>;
export type MetricsConfig = z.infer<typeof MetricsSchema>;
export type MemoryConfig = z.infer<typeof MemorySchema>;

export function parseConfig(source: string, yamlText: string): Config {
  const result = ConfigSchema.safeParse(parseYaml(yamlText) ?? {});
  if (!result.success) throw formatZodError(source, result.error);
  return result.data;
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // A fresh deploy that forgets to mount config.yaml hits this first. Left
    // unwrapped it surfaces as a raw ENOENT, bypassing the formatted boot
    // failure every other configuration problem gets.
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "the file does not exist"
        : `it could not be read (${code ?? (error as Error).message})`;
    throw new ValidationError(path, [
      `${reason}. Create it at that path (the config.yaml in the repository root is a working example), or mount it there in the container`,
    ]);
  }
  return parseConfig(path, text);
}
