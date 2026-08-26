import { z } from "zod";
import { isValidTimeZone } from "./config.js";

export const TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep", "Bash",
  "WebSearch", "WebFetch", "TodoWrite", "Task",
] as const;

export const TIERS = ["readonly", "sandboxed", "granted", "autonomous"] as const;
export const APPROVALS = ["auto", "notify", "approve"] as const;
export const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * The only tools a `readonly` agent may be granted.
 *
 * Spec §7.2 gives `readonly` "read, search, web fetch, report" and forbids all
 * writes. Nothing downstream reads `tier` in this plan, so this schema is the
 * one place the tier can be made to mean something: without it, `tier:
 * readonly` alongside `allowedTools: [Read, Write, Bash]` would boot happily
 * and hand the agent a pre-approved shell — a silent lie rather than a
 * boundary.
 */
const READONLY_TOOLS: readonly string[] = [
  "Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite",
];

/** Tiers and features this plan cannot enforce yet, and the plan that delivers each. */
const NOT_YET: Record<string, string> = {
  granted: "Plan B (tiers and grant enforcement)",
  autonomous: "Plan B (tiers and grant enforcement)",
};

const CronTrigger = z
  .object({
    type: z.literal("cron"),
    schedule: z.string().min(1),
    timezone: z.string().superRefine((v, ctx) => {
      if (!isValidTimeZone(v)) {
        ctx.addIssue({
          code: "custom",
          message: `must be a canonical IANA zone name such as "Europe/Berlin" (or "UTC"); received ${JSON.stringify(v)}. Offsets ("+02:00") and abbreviations ("CEST", "PST") are rejected because they do not carry daylight-saving rules`,
        });
      }
    }),
  })
  .strict();

export const AgentSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase kebab-case"),
    enabled: z.boolean().default(true),
    authoredBy: z.string().default("claude-local"),
    trigger: CronTrigger,
    run: z
      .object({
        model: z.enum(MODELS),
        effort: z.enum(EFFORTS).default("medium"),
        maxTurns: z.number().int().positive().max(200).default(40),
        timeoutMinutes: z.number().positive().max(180).default(15),
        maxBudgetUsd: z.number().positive().max(20).default(1),
      })
      .strict(),
    permissions: z
      .object({
        allowedTools: z.array(z.enum(TOOLS)).default([]),
        disallowedTools: z.array(z.enum(TOOLS)).default([]),
      })
      .strict()
      .prefault({}),
    tier: z.enum(TIERS).default("sandboxed"),
    approval: z.enum(APPROVALS).default("notify"),
    grantRefs: z.array(z.string()).default([]),
    capabilities: z
      .object({
        browser: z
          .object({
            enabled: z.boolean().default(false),
            blockedOrigins: z.array(z.string()).default([]),
            exclusiveSlot: z.boolean().default(true),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    outbox: z
      .object({
        discord: z.string().min(1),
        notifyOn: z
          .array(z.enum(["success", "failure", "parked"]))
          .default(["success", "failure"]),
      })
      .strict(),
  })
  .strict()
  .superRefine((agent, ctx) => {
    const unavailable = NOT_YET[agent.tier];
    if (unavailable) {
      ctx.addIssue({
        code: "custom",
        path: ["tier"],
        message: `tier "${agent.tier}" requires grant enforcement, which is delivered in ${unavailable}. Use "sandboxed" or "readonly" until then`,
      });
    }
    if (agent.tier === "readonly") {
      const forbidden = agent.permissions.allowedTools.filter(
        (t) => !READONLY_TOOLS.includes(t),
      );
      if (forbidden.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["permissions", "allowedTools"],
          message: `tool(s) ${forbidden.join(", ")} cannot be granted to a "readonly" agent, which forbids all writes. Legal tools for tier "readonly": ${READONLY_TOOLS.join(", ")}. Remove them, or use tier: sandboxed if the agent needs to write`,
        });
      }
    }
    if (agent.approval !== "notify") {
      ctx.addIssue({
        code: "custom",
        path: ["approval"],
        message: `approval "${agent.approval}" requires the Discord control bot, delivered in Plan B (control channel). Use "notify" until then`,
      });
    }
    if (agent.grantRefs.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["grantRefs"],
        message: `grants are delivered in Plan B (tiers and grant enforcement). Use an empty list until then`,
      });
    }
    if (agent.capabilities.browser.enabled) {
      ctx.addIssue({
        code: "custom",
        path: ["capabilities", "browser", "enabled"],
        message: `browser control is delivered in Plan C (browser capability). Set false until then`,
      });
    }
    const overlap = agent.permissions.allowedTools.filter((t) =>
      agent.permissions.disallowedTools.includes(t),
    );
    if (overlap.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["permissions"],
        message: `tool(s) ${overlap.join(", ")} appear in both allowedTools and disallowedTools. List each tool in exactly one`,
      });
    }
  });

export type AgentYaml = z.infer<typeof AgentSchema>;
