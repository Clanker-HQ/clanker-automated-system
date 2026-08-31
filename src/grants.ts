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

const GithubPrGrant = z
  .object({
    id: z.string().min(1),
    kind: z.literal("github-pr"),
    // "*" means "any repo this grant's underlying token can reach" — the
    // right shape for a dedicated, single-purpose bot account whose PAT is
    // itself scoped to "all repos on this account, PR actions only" (no
    // Administration/billing/account-level power). An explicit array is
    // still supported for an account or token shared across purposes, where
    // an allowlist narrower than the token's own reach is worth keeping.
    repos: z.union([
      z.literal("*"),
      z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"')).min(1),
    ]),
    secret: z.string().min(1),
  })
  .strict();

export const GrantSchema = z.discriminatedUnion("kind", [HttpGrant, GitPushGrant, ProvisionGrant, GithubPrGrant]);
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

/**
 * `kind` is the effect's *family*, and it must line up with the family of the
 * grant that authorises it. Without it, `matchGrant` compared nothing but
 * target strings — so a `git-push` grant whose `remote` happened to be written
 * as a URL could authorise an outbound HTTP call to that same URL, and a
 * wildcard `http` grant could authorise a push. Target equality is not
 * authority; the pair (kind, target) is.
 */
export interface OutwardEffect {
  kind: "http" | "git-push" | "provision" | "github-pr";
  description: string;
  target: string;
  /** Only ever set by the pushBranch effect below — a raw Bash `git push` never carries one. */
  branch?: string;
}

const OUTWARD_HOST_PATTERN = /https?:\/\/\S+/g;

/** The target recorded for a `git push` with no explicit remote argument. */
export const DEFAULT_UPSTREAM_TARGET = "(default upstream)";

// Node's URL keeps the brackets on an IPv6 hostname ("http://[::1]/" ->
// "[::1]"), so both spellings are listed rather than assumed.
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True only when the *hostname* of a parsed URL is loopback.
 *
 * The predecessor of this function tested `/localhost|127\.0\.0\.1/` against
 * the whole command string, so `curl https://evil.example.com/?ref=localhost`
 * and `curl -H "Origin: localhost" https://evil.example.com` both read as
 * "local" and escaped detection entirely, at every tier. Parsing the URL and
 * reading `.hostname` is the only check that cannot be spoofed by putting the
 * word "localhost" somewhere else in the command. An unparseable URL is not
 * local (fail closed).
 */
function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function detectOutwardEffect(toolName: string, input: Record<string, unknown>): OutwardEffect | null {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    // Bare `git push` — no remote argument, pushing to the configured upstream
    // — is the commonest real-world form, and requiring a captured argument
    // meant it was detected as nothing at all. It now reports a sentinel
    // target so it's still checked against grants — no *specific* remote
    // pattern will match it, but a deliberately permissive one (`remote:
    // "*"`) still will, same as it would for any other target.
    if (/\bgit\s+push\b/.test(command)) {
      const remote = command.match(/\bgit\s+push\s+(\S+)/)?.[1];
      return {
        kind: "git-push",
        description: `git push (${command.trim()})`,
        target: remote ?? DEFAULT_UPSTREAM_TARGET,
      };
    }

    if (/\b(curl|wget)\b/.test(command)) {
      const urls = command.match(OUTWARD_HOST_PATTERN) ?? [];
      const outward = urls.filter((u) => !isLocalUrl(u));
      // Exempt only when at least one URL was found and every one of them is
      // genuinely loopback. No parseable URL at all → still an outward effect.
      if (urls.length > 0 && outward.length === 0) return null;
      return {
        kind: "http",
        description: `network call (${command.trim()})`,
        target: outward[0] ?? command.trim(),
      };
    }
    if (/\bnpm\s+publish\b/.test(command)) {
      return { kind: "provision", description: `npm publish (${command.trim()})`, target: "npm-publish" };
    }
    if (/\bgh\s+(repo\s+create|release\s+create|pr\s+create)\b/.test(command)) {
      return { kind: "provision", description: `gh (${command.trim()})`, target: "gh-provision" };
    }
    return null;
  }

  if (toolName === "WebFetch") {
    const url = typeof input.url === "string" ? input.url : "";
    return url ? { kind: "http", description: `fetch ${url}`, target: url } : null;
  }

  // Only reachable via the mergePR tool handler's own direct decide() call
  // (src/runner/sdk-runner.ts) — mergePR never routes through the
  // canUseTool/detectOutwardEffect path the SDK's own tool-call interception
  // uses, since it's a custom MCP tool the handler gates internally.
  if (toolName === "mergePR") {
    const repo = typeof input.repo === "string" ? input.repo : "";
    return repo ? { kind: "github-pr", description: `merge PR in ${repo}`, target: repo } : null;
  }

  // Only reachable via the pushBranch tool handler's own direct decide() call
  // (src/runner/sdk-runner.ts), same as mergePR above.
  if (toolName === "pushBranch") {
    const repo = typeof input.repo === "string" ? input.repo : "";
    const branch = typeof input.branch === "string" ? input.branch : "";
    if (!repo || !branch) return null;
    return { kind: "git-push", description: `push ${branch} to ${repo}`, target: repo, branch };
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
    case "github-pr":
      // Not matched via globMatch — matchGrant (extended in Task 7) checks
      // grant.repos.includes(effect.target) directly for this kind. This
      // case exists only so the switch stays exhaustive.
      return "";
  }
}

export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? "\\uFFFF" : `\\${c}`));
  const regex = new RegExp(`^${escaped.replace(/\\uFFFF/g, ".*")}$`);
  return regex.test(value);
}

export function matchGrant(grants: Grant[], effect: OutwardEffect): Grant | null {
  // The kind check comes first deliberately: a grant only authorises effects of
  // its own family, however well the target strings happen to line up.
  return (
    grants.find((g) => {
      if (g.kind !== effect.kind) return false;
      // github-pr grants authorise by exact repo-list membership (or "*"
      // for any repo), not glob matching — grantTargetPattern's "github-pr"
      // case deliberately returns "" and is never reached for this kind.
      if (g.kind === "github-pr") return g.repos === "*" || g.repos.includes(effect.target);
      // A pushBranch-detected effect carries the branch it intends to push;
      // a raw Bash `git push` effect never sets `branch`, so this additional
      // check is skipped for that path — unchanged behavior for every
      // existing caller.
      if (g.kind === "git-push" && effect.branch !== undefined) {
        return globMatch(g.remote, effect.target) && g.branches.some((pattern) => globMatch(pattern, effect.branch!));
      }
      return globMatch(grantTargetPattern(g), effect.target);
    }) ?? null
  );
}

/**
 * Cross-checks every agent's `grantRefs` against the ids actually present in
 * grants.yaml.
 *
 * Nothing else does: `decide()` filters the grant list by `grantRefs` and a
 * typo simply produces an empty list, so a misspelled ref boots cleanly and
 * then silently denies every effect the agent was meant to be allowed. Boot is
 * the only place that can tell the difference between "no grant" and "a grant
 * whose name was mistyped".
 */
export function validateGrantRefs(
  agents: readonly { name: string; grantRefs: readonly string[] }[],
  grants: readonly Grant[],
  source = "agent definitions",
): void {
  const known = grants.map((g) => g.id);
  const lines: string[] = [];
  for (const agent of agents) {
    for (const ref of agent.grantRefs) {
      if (!known.includes(ref)) {
        lines.push(
          `${agent.name}: grantRefs contains "${ref}", which is not the id of any grant in grants.yaml. ` +
            `Known grant ids: ${known.join(", ") || "(none)"}`,
        );
      }
    }
  }
  if (lines.length > 0) throw new ValidationError(source, lines);
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
