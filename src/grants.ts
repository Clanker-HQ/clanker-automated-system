import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ValidationError, formatZodError } from "./errors.js";

const HttpGrant = z
  .object({
    id: z.string().min(1),
    kind: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    urlPattern: z.string().min(1),
    secret: z.string().min(1),
  })
  .strict();

const GitPushGrant = z
  .object({
    id: z.string().min(1),
    kind: z.literal("git-push"),
    remote: z.string().min(1),
    branches: z.array(z.string().min(1)).min(1),
    secret: z.string().min(1),
  })
  .strict();

const ProvisionGrant = z
  .object({
    id: z.string().min(1),
    kind: z.literal("provision"),
    resource: z.enum(["github-repo", "host-site", "dns-subdomain"]),
    scope: z.string().min(1),
    limit: z.object({ perDay: z.number().int().positive() }).strict(),
    secret: z.string().min(1),
  })
  .strict();

export const GrantSchema = z.discriminatedUnion("kind", [HttpGrant, GitPushGrant, ProvisionGrant]);
export type Grant = z.infer<typeof GrantSchema>;

const GrantsFileSchema = z.object({ grants: z.array(GrantSchema).default([]) }).strict();

export function parseGrants(source: string, yamlText: string): Grant[] {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText) ?? {};
  } catch (error) {
    throw new ValidationError(source, [
      `is not valid YAML: ${(error as Error).message}`,
    ]);
  }

  const result = GrantsFileSchema.safeParse(raw);
  if (!result.success) throw formatZodError(source, result.error);

  const seen = new Map<string, number>();
  result.data.grants.forEach((g) => seen.set(g.id, (seen.get(g.id) ?? 0) + 1));
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicates.length > 0) {
    throw new ValidationError(source, [
      `duplicate grant id(s): ${duplicates.join(", ")}. Every grant needs a unique id`,
    ]);
  }

  return result.data.grants;
}

export function loadGrants(path: string): Grant[] {
  return parseGrants(path, readFileSync(path, "utf8"));
}

export interface OutwardEffect {
  description: string;
  target: string;
}

const OUTWARD_HOST_PATTERN = /https?:\/\/\S+/;

export function detectOutwardEffect(toolName: string, input: Record<string, unknown>): OutwardEffect | null {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const push = command.match(/\bgit\s+push\s+(\S+)/);
    if (push) return { description: `git push (${command.trim()})`, target: push[1]! };

    if (/\b(curl|wget)\b/.test(command) && !/localhost|127\.0\.0\.1/.test(command)) {
      const url = command.match(OUTWARD_HOST_PATTERN);
      return { description: `network call (${command.trim()})`, target: url?.[0] ?? command.trim() };
    }
    if (/\bnpm\s+publish\b/.test(command)) {
      return { description: `npm publish (${command.trim()})`, target: "npm-publish" };
    }
    if (/\bgh\s+(repo\s+create|release\s+create|pr\s+create)\b/.test(command)) {
      return { description: `gh (${command.trim()})`, target: "gh-provision" };
    }
    return null;
  }

  if (toolName === "WebFetch") {
    const url = typeof input.url === "string" ? input.url : "";
    return url ? { description: `fetch ${url}`, target: url } : null;
  }

  return null;
}

function grantTargetPattern(grant: Grant): string {
  switch (grant.kind) {
    case "http":
      return grant.urlPattern;
    case "git-push":
      return grant.remote;
    case "provision":
      return grant.scope;
  }
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? "\\uFFFF" : `\\${c}`));
  const regex = new RegExp(`^${escaped.replace(/\\uFFFF/g, ".*")}$`);
  return regex.test(value);
}

export function matchGrant(grants: Grant[], effect: OutwardEffect): Grant | null {
  return grants.find((g) => globMatch(grantTargetPattern(g), effect.target)) ?? null;
}

export type Decision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "park"; grantRef: string; effect: string };

export function decide(
  agent: { tier: string; grantRefs: string[]; approval: string },
  grants: Grant[],
  toolName: string,
  input: Record<string, unknown>,
): Decision {
  const effect = detectOutwardEffect(toolName, input);
  if (!effect) return { kind: "allow" };

  if (agent.tier === "readonly" || agent.tier === "sandboxed") {
    return { kind: "deny", reason: `tier "${agent.tier}" forbids outward effects: ${effect.description}` };
  }

  const relevantGrants = grants.filter((g) => agent.grantRefs.includes(g.id));
  const matched = matchGrant(relevantGrants, effect);
  if (!matched) {
    return { kind: "deny", reason: `no grant matches attempted effect: ${effect.description}` };
  }
  if (agent.tier === "autonomous" && agent.approval === "auto") {
    return { kind: "allow" };
  }
  return { kind: "park", grantRef: matched.id, effect: effect.description };
}
