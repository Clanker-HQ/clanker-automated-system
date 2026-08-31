import { ValidationError } from "../errors.js";
import { globMatch, parseGrants, validateGrantRefs, type Grant } from "../grants.js";
import { parseAgent } from "../registry.js";

/**
 * The only file-set shape this gate ever evaluates: `grants.yaml` exactly, or
 * `agents/<name>/{agent.yaml,prompt.md}` — one path segment for the agent
 * name, no nested directories, no other filenames. Anything outside this
 * shape (including a self-build file mixed with an ordinary code file) is
 * never a self-build change; `sdk-runner.ts` falls back to the unconditional
 * `touchesExcludedPath` refusal for it, exactly as before this gate existed.
 */
const AGENT_FILE_PATTERN = /^agents\/[^/]+\/(agent\.yaml|prompt\.md)$/;

export function isSelfBuildChange(changedFiles: string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every((f) => f === "grants.yaml" || AGENT_FILE_PATTERN.test(f));
}

export interface SelfBuildAgentFile {
  path: string;
  /** null means this path was deleted by the PR. Only meaningful in changedAgentFiles — base state is always pre-deletion. */
  content: string | null;
}

export interface SelfBuildInput {
  /** Every agents/*\/agent.yaml path and its content at the PR's BASE ref (the live registry before this PR). */
  baseAgentFiles: { path: string; content: string }[];
  /** grants.yaml content at the base ref. */
  baseGrantsYaml: string;
  /** Only the agents/*\/agent.yaml paths this PR actually changes, with HEAD content (null = deleted by this PR). Entries for prompt.md are ignored here — nothing in this function parses prompt text. */
  changedAgentFiles: SelfBuildAgentFile[];
  /** grants.yaml content at the head ref, or undefined if this PR does not touch grants.yaml (base content is then reused unchanged). */
  headGrantsYaml?: string;
  /** process.env-shaped: a secret counts as "provisioned" when its value here is truthy. */
  env: Record<string, string | undefined>;
}

export type SelfBuildVerdict = { allowed: true } | { allowed: false; rule: 1 | 2 | 3; reason: string };

function messageFor(err: unknown): string {
  return err instanceof ValidationError ? err.lines.join("; ") : (err as Error).message;
}

/** True when `candidate`'s real-world reach is no broader than `existing`'s. Same `kind` required; a mismatched kind is never "no broader". */
function isNoBroaderThan(existing: Grant, candidate: Grant): boolean {
  if (existing.kind === "http" && candidate.kind === "http") {
    return globMatch(existing.urlPattern, candidate.urlPattern);
  }
  if (existing.kind === "provision" && candidate.kind === "provision") {
    return globMatch(existing.scope, candidate.scope);
  }
  if (existing.kind === "git-push" && candidate.kind === "git-push") {
    return globMatch(existing.remote, candidate.remote) && candidate.branches.every((cb) => existing.branches.some((eb) => globMatch(eb, cb)));
  }
  if (existing.kind === "github-pr" && candidate.kind === "github-pr") {
    if (existing.repos === "*") return true;
    if (candidate.repos === "*") return false;
    return candidate.repos.every((r) => existing.repos.includes(r));
  }
  return false;
}

/**
 * The four rules from docs/superpowers/specs/2026-08-30-self-build-design.md
 * (rule 3 as amended in 2026-08-30-self-evaluation-design.md), minus rule 4
 * (CI green — the existing branch-protection/CI gate, not new code here).
 * Pure function, no LLM, no I/O — every fetch this needs has already
 * happened by the time it's called (see evaluateSelfBuildPr in Task 3).
 */
export function evaluateSelfBuildChange(input: SelfBuildInput): SelfBuildVerdict {
  // Reconstruct the resulting agents/*/agent.yaml set: base state, with this
  // PR's changes applied (an override, or a removal for null content).
  const resultPaths = new Map<string, string>();
  for (const f of input.baseAgentFiles) resultPaths.set(f.path, f.content);
  for (const f of input.changedAgentFiles) {
    if (!f.path.endsWith("/agent.yaml")) continue; // prompt.md changes carry no schema to check
    if (f.content === null) resultPaths.delete(f.path);
    else resultPaths.set(f.path, f.content);
  }

  // Rule 1a — every resulting agent.yaml still validates against AgentSchema.
  const agents: { name: string; grantRefs: string[] }[] = [];
  for (const [path, content] of resultPaths) {
    try {
      const agent = parseAgent(path, content);
      agents.push({ name: agent.name, grantRefs: agent.grantRefs });
    } catch (err) {
      return { allowed: false, rule: 1, reason: `${path} does not validate against AgentSchema: ${messageFor(err)}` };
    }
  }

  // Rule 1b — the resulting grants.yaml still validates against GrantSchema.
  const resultingGrantsYaml = input.headGrantsYaml ?? input.baseGrantsYaml;
  let grants: Grant[];
  try {
    grants = parseGrants("grants.yaml", resultingGrantsYaml);
  } catch (err) {
    return { allowed: false, rule: 1, reason: `grants.yaml does not validate against GrantSchema: ${messageFor(err)}` };
  }

  // Rule 1c — validateGrantRefs still passes across the resulting full agent set.
  try {
    validateGrantRefs(agents, grants, "self-build change");
  } catch (err) {
    return { allowed: false, rule: 1, reason: messageFor(err) };
  }

  // Rule 2 — no existing grant edited in place.
  let baseGrants: Grant[];
  try {
    baseGrants = parseGrants("grants.yaml", input.baseGrantsYaml);
  } catch {
    // Unreachable in practice: the base ref is the live, already-merged
    // registry, which passed this same check when it landed. Treat as no
    // prior grants rather than let a caller-side data problem masquerade as
    // this PR editing something.
    baseGrants = [];
  }
  const baseById = new Map(baseGrants.map((g) => [g.id, g]));
  for (const g of grants) {
    const prior = baseById.get(g.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(g)) {
      return { allowed: false, rule: 2, reason: `grant "${g.id}" was edited in place; self-build may only add a new grant id or delete an old one` };
    }
  }

  // Rule 3 — credential scope, for every grant id this PR newly introduces.
  const newGrants = grants.filter((g) => !baseById.has(g.id));
  for (const g of newGrants) {
    const provisioned = Boolean(input.env[g.secret]);
    if (provisioned && baseGrants.some((existing) => existing.secret === g.secret)) continue; // (a)
    if (!provisioned && baseGrants.some((existing) => existing.kind === g.kind && isNoBroaderThan(existing, g))) continue; // (b)

    return {
      allowed: false,
      rule: 3,
      reason: provisioned
        ? `grant "${g.id}" names secret ${g.secret}, which is provisioned but not yet used by any existing grant — self-build may only reuse an already-live credential`
        : `grant "${g.id}" names an unprovisioned secret ${g.secret} and is no narrower than any existing same-kind grant — a brand-new credential needs a human to provision it first`,
    };
  }

  return { allowed: true };
}
