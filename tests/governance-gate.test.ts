import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GOVERNANCE_MERGE_WINDOW_MS, GovernanceGateStore, MAX_GOVERNANCE_MERGES_PER_WINDOW } from "../src/state/governance-gate.js";

function store(): GovernanceGateStore {
  return new GovernanceGateStore(mkdtempSync(join(tmpdir(), "cai-governancegate-")));
}

describe("GovernanceGateStore attestations", () => {
  it("has no attestation for a PR that's never been attested", async () => {
    expect(await store().getAttestation("Clanker-HQ/clanker-automated-system", 100)).toBeNull();
  });

  it("records and returns an attestation", async () => {
    const s = store();
    await s.recordAttestation({
      repo: "Clanker-HQ/clanker-automated-system",
      number: 100,
      headSha: "abc123",
      verdict: "safe",
      reasoning: "Only widens a log message, no check removed.",
    });
    const attestation = await s.getAttestation("Clanker-HQ/clanker-automated-system", 100);
    expect(attestation).toMatchObject({ headSha: "abc123", verdict: "safe", reasoning: "Only widens a log message, no check removed." });
    expect(attestation?.attestedAt).toBeDefined();
  });

  it("a later attestation for the same PR overwrites the earlier one", async () => {
    const s = store();
    await s.recordAttestation({ repo: "owner/repo", number: 1, headSha: "sha-1", verdict: "unsafe", reasoning: "removes the budget cap" });
    await s.recordAttestation({ repo: "owner/repo", number: 1, headSha: "sha-2", verdict: "safe", reasoning: "fixed in the new commit" });
    const attestation = await s.getAttestation("owner/repo", 1);
    expect(attestation).toMatchObject({ headSha: "sha-2", verdict: "safe" });
  });

  it("tracks attestations for different PRs independently", async () => {
    const s = store();
    await s.recordAttestation({ repo: "owner/repo", number: 1, headSha: "sha-1", verdict: "safe", reasoning: "a" });
    await s.recordAttestation({ repo: "owner/repo", number: 2, headSha: "sha-2", verdict: "unsafe", reasoning: "b" });
    expect((await s.getAttestation("owner/repo", 1))?.verdict).toBe("safe");
    expect((await s.getAttestation("owner/repo", 2))?.verdict).toBe("unsafe");
  });

  it("survives a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-governancegate-"));
    await new GovernanceGateStore(dir).recordAttestation({ repo: "owner/repo", number: 1, headSha: "sha-1", verdict: "safe", reasoning: "a" });
    expect((await new GovernanceGateStore(dir).getAttestation("owner/repo", 1))?.headSha).toBe("sha-1");
  });
});

describe("GovernanceGateStore merge velocity", () => {
  it("counts 0 recent merges when none have happened", async () => {
    expect(await store().countRecentMerges()).toBe(0);
  });

  it("counts a merge recorded just now", async () => {
    const s = store();
    await s.recordMerge({ repo: "owner/repo", number: 1, headSha: "sha-1" });
    expect(await s.countRecentMerges()).toBe(1);
  });

  it("counts multiple merges within the window", async () => {
    const s = store();
    await s.recordMerge({ repo: "owner/repo", number: 1, headSha: "sha-1" });
    await s.recordMerge({ repo: "owner/repo", number: 2, headSha: "sha-2" });
    expect(await s.countRecentMerges()).toBe(2);
  });

  it("excludes a merge older than GOVERNANCE_MERGE_WINDOW_MS", async () => {
    const s = store();
    const now = new Date("2026-09-11T12:00:00.000Z");
    const old = new Date(now.getTime() - GOVERNANCE_MERGE_WINDOW_MS - 1000);
    await s.recordMerge({ repo: "owner/repo", number: 1, headSha: "sha-1" }, old);
    expect(await s.countRecentMerges(now)).toBe(0);
  });

  it("includes a merge exactly at the edge of the window", async () => {
    const s = store();
    const now = new Date("2026-09-11T12:00:00.000Z");
    const edge = new Date(now.getTime() - GOVERNANCE_MERGE_WINDOW_MS);
    await s.recordMerge({ repo: "owner/repo", number: 1, headSha: "sha-1" }, edge);
    expect(await s.countRecentMerges(now)).toBe(1);
  });

  // Regression coverage for the actual bound mergePR's gate enforces —
  // MAX_GOVERNANCE_MERGES_PER_WINDOW itself is consumed by sdk-runner.ts,
  // not this store, but the store's counting is what that comparison relies
  // on, so this documents the exact value the gate is protecting.
  it("MAX_GOVERNANCE_MERGES_PER_WINDOW is a small, deliberately conservative cap", () => {
    expect(MAX_GOVERNANCE_MERGES_PER_WINDOW).toBeGreaterThan(0);
    expect(MAX_GOVERNANCE_MERGES_PER_WINDOW).toBeLessThanOrEqual(5);
  });
});
