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

const WebhookTrigger = z
  .object({
    type: z.literal("webhook"),
    // "*" matches events from any repo the configured GithubTransport's
    // token can reach — the intended shape for a dedicated bot account whose
    // token is itself scoped to "all repos on this account, PR actions
    // only" rather than per-repo. A GitHub webhook still has to be added on
    // each repo individually (GitHub has no account-wide webhook without a
    // GitHub App), so "*" removes per-repo *config* edits, not the per-repo
    // *webhook* setup.
    repo: z.string().refine((v) => v === "*" || /^[\w.-]+\/[\w.-]+$/.test(v), {
      message: 'must be "owner/repo", or "*" to match any repo the bot account can reach',
    }),
    event: z.literal("pull_request"),
  })
  .strict();

export const AgentSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase kebab-case"),
    enabled: z.boolean().default(true),
    authoredBy: z.string().default("claude-local"),
    trigger: z.discriminatedUnion("type", [CronTrigger, WebhookTrigger]),
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
    // Same argument as READONLY_TOOLS above, applied to grants. `decide()`
    // denies every outward effect for these two tiers *before* it ever
    // consults grantRefs, so a grant listed here can never authorise
    // anything — leaving it accepted would make `grantRefs: [deploy-prod]`
    // on a readonly agent read as a capability it does not have. A silent
    // lie rather than a boundary.
    if ((agent.tier === "readonly" || agent.tier === "sandboxed") && agent.grantRefs.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["grantRefs"],
        message: `grant(s) ${agent.grantRefs.join(", ")} cannot be listed on a "${agent.tier}" agent: that tier denies every outward effect before grants are consulted, so these refs would never authorise anything. Remove them, or use tier: granted if the agent genuinely needs those effects`,
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
export type CronTrigger = z.infer<typeof CronTrigger>;
export type WebhookTrigger = z.infer<typeof WebhookTrigger>;
