import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";

/**
 * How many governance-tier merges (see GOVERNANCE_PATHS in
 * ../control/excluded-paths.js) this pipeline may complete on its own within
 * GOVERNANCE_MERGE_WINDOW_MS, before it must stop and require a human to
 * merge directly instead. This is the circuit breaker for the whole gate:
 * every other check here is a single LLM's judgment on a single diff, which
 * — unlike self-build-gate.ts's mechanical, schema-level rules — cannot be
 * proven correct by construction. A cap this low means even a bad or subtly
 * wrong attestation can only do so much before a human is forced back into
 * the loop, rather than compounding unattended.
 */
export const MAX_GOVERNANCE_MERGES_PER_WINDOW = 2;

export const GOVERNANCE_MERGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface GovernanceAttestation {
  repo: string;
  number: number;
  /** Must match the PR's CURRENT head at merge time — an attestation for an older commit is stale and void, the same way mergePR's own expectedHeadSha check treats a moved head as a fresh, unreviewed PR. */
  headSha: string;
  verdict: "safe" | "unsafe";
  /** The reviewing agent's own account of what it checked — surfaced in the Discord alert and in a refusal message, so a human reading either one sees the actual reasoning, not just a verdict. */
  reasoning: string;
}

export interface GovernanceMergeRecord {
  repo: string;
  number: number;
  headSha: string;
}

interface GovernanceGateData {
  /** Keyed by `${repo}#${number}` — only ever the LATEST attestation for that PR, same as PrFixAttemptStore's per-PR keying. A stale one is superseded, not accumulated. */
  attestations: Record<string, GovernanceAttestation & { attestedAt: string }>;
  /** Append-only log of completed governance-tier merges, purely for the velocity cap above — never pruned automatically (see countRecentMerges, which filters by window on read; a small file is not worth the complexity of a separate retention pass). */
  merges: (GovernanceMergeRecord & { mergedAt: string })[];
}

/**
 * Backs the automated exception to EXCLUDED_PATHS for governance-tier files
 * (governor.ts, grants.ts, agent-schema.ts, bot.ts, config.yaml — see
 * GOVERNANCE_PATHS's own doc comment for why these specifically, and not the
 * rest of EXCLUDED_PATHS, are eligible at all). Two responsibilities:
 *
 * 1. Recording pr-reviewer's own dedicated, adversarially-framed safety
 *    review of a governance-tier diff (see attestGovernanceSafety in
 *    sdk-runner.ts) — a SEPARATE pass from its ordinary review, specifically
 *    prompted to ask "does this remove, weaken, or add a bypass to any
 *    check, cap, refusal, or credential scope; does it expand what any
 *    agent can do" — so mergePR's gate has something concrete to consult
 *    instead of just trusting the ordinary review's general verdict.
 * 2. The velocity cap above, so a wrong "safe" verdict has a small, bounded
 *    blast radius rather than an unbounded one.
 *
 * A single shared JSON file (not one-file-per-entry like WebhookRetryStore):
 * both the attestation map and the merge log are small, and both need to be
 * read together to decide "is this specific merge, right now, allowed" —
 * splitting them across many files would buy nothing.
 */
export class GovernanceGateStore {
  constructor(private readonly dataDir: string) {}

  private path(): string {
    return join(this.dataDir, "state", "governance-gate.json");
  }

  private async readAll(): Promise<GovernanceGateData> {
    try {
      return JSON.parse(await readFile(this.path(), "utf8")) as GovernanceGateData;
    } catch {
      return { attestations: {}, merges: [] };
    }
  }

  private async writeAll(data: GovernanceGateData): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    await writeFileAtomic(this.path(), JSON.stringify(data, null, 2) + "\n");
  }

  /** Overwrites any prior attestation for this (repo, number) — only the most recent verdict ever matters. */
  async recordAttestation(input: GovernanceAttestation, now: Date = new Date()): Promise<void> {
    const data = await this.readAll();
    data.attestations[`${input.repo}#${input.number}`] = { ...input, attestedAt: now.toISOString() };
    await this.writeAll(data);
  }

  async getAttestation(repo: string, number: number): Promise<(GovernanceAttestation & { attestedAt: string }) | null> {
    const data = await this.readAll();
    return data.attestations[`${repo}#${number}`] ?? null;
  }

  async recordMerge(input: GovernanceMergeRecord, now: Date = new Date()): Promise<void> {
    const data = await this.readAll();
    data.merges.push({ ...input, mergedAt: now.toISOString() });
    await this.writeAll(data);
  }

  /** How many governance-tier merges landed within GOVERNANCE_MERGE_WINDOW_MS of `now` — what MAX_GOVERNANCE_MERGES_PER_WINDOW is checked against. */
  async countRecentMerges(now: Date = new Date()): Promise<number> {
    const data = await this.readAll();
    const cutoff = now.getTime() - GOVERNANCE_MERGE_WINDOW_MS;
    return data.merges.filter((m) => new Date(m.mergedAt).getTime() >= cutoff).length;
  }
}
