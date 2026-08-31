import { describe, expect, it } from "vitest";
import { evaluateSelfBuildChange, isSelfBuildChange } from "../src/control/self-build-gate.js";

const FOO_AGENT_V1 = `
name: foo
description: Does foo things.
trigger:
  type: cron
  schedule: "0 7 * * *"
  timezone: Europe/Berlin
run:
  model: claude-haiku-4-5
  effort: low
  maxTurns: 10
  timeoutMinutes: 10
  maxBudgetUsd: 1
tier: readonly
approval: notify
grantRefs: []
outbox:
  discord: ops
  notifyOn: [success, failure]
`;

const FOO_AGENT_V2 = FOO_AGENT_V1.replace("Does foo things.", "Does foo things, now better.");

const FOO_AGENT_GRANTED = FOO_AGENT_V1.replace("tier: readonly", "tier: granted").replace("grantRefs: []", "grantRefs: [infra-repo]");

const INVALID_AGENT = `
name: bad
trigger:
  type: cron
  schedule: "0 7 * * *"
  timezone: Europe/Berlin
run:
  model: claude-haiku-4-5
tier: not-a-real-tier
approval: notify
outbox:
  discord: ops
`;

const EMPTY_GRANTS = "grants: []\n";

function grantsYaml(entries: string): string {
  return `grants:\n${entries}`;
}

describe("isSelfBuildChange", () => {
  it("is true for a grants.yaml-only change", () => {
    expect(isSelfBuildChange(["grants.yaml"])).toBe(true);
  });

  it("is true for an agent.yaml and prompt.md change under one agent directory", () => {
    expect(isSelfBuildChange(["agents/foo/agent.yaml", "agents/foo/prompt.md"])).toBe(true);
  });

  it("is false for a nested path under an agent directory", () => {
    expect(isSelfBuildChange(["agents/foo/sub/agent.yaml"])).toBe(false);
  });

  it("is false when mixed with an ordinary code file", () => {
    expect(isSelfBuildChange(["grants.yaml", "src/index.ts"])).toBe(false);
  });

  it("is false for an empty change set", () => {
    expect(isSelfBuildChange([])).toBe(false);
  });
});

describe("evaluateSelfBuildChange", () => {
  it("rule 1: refuses a new agent.yaml that fails AgentSchema validation", () => {
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [],
      baseGrantsYaml: EMPTY_GRANTS,
      changedAgentFiles: [{ path: "agents/bad/agent.yaml", content: INVALID_AGENT }],
      env: {},
    });
    expect(verdict).toMatchObject({ allowed: false, rule: 1 });
  });

  it("rule 1: refuses when a grant deletion would leave an existing agent's grantRefs dangling", () => {
    const base = grantsYaml('  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n');
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [{ path: "agents/foo/agent.yaml", content: FOO_AGENT_GRANTED }],
      baseGrantsYaml: base,
      changedAgentFiles: [],
      headGrantsYaml: EMPTY_GRANTS,
      env: {},
    });
    expect(verdict).toMatchObject({ allowed: false, rule: 1 });
  });

  it("rule 2: refuses an existing grant edited in place", () => {
    const base = grantsYaml('  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n');
    const head = grantsYaml('  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo", "owner/other"]\n    secret: GITHUB_PR_TOKEN\n');
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [], baseGrantsYaml: base, changedAgentFiles: [], headGrantsYaml: head, env: {},
    });
    expect(verdict).toMatchObject({ allowed: false, rule: 2 });
  });

  it("rule 3(a): allows a new grant naming an already-provisioned, already-in-use secret", () => {
    const base = grantsYaml('  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n');
    const head = grantsYaml(
      '  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n' +
        '  - id: new-thing\n    kind: github-pr\n    repos: ["owner/other"]\n    secret: GITHUB_PR_TOKEN\n',
    );
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [], baseGrantsYaml: base, changedAgentFiles: [], headGrantsYaml: head,
      env: { GITHUB_PR_TOKEN: "provisioned" },
    });
    expect(verdict).toEqual({ allowed: true });
  });

  it("rule 3: refuses a new grant naming an unprovisioned secret that is also not narrower than any existing same-kind grant", () => {
    const base = grantsYaml('  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n');
    const head = grantsYaml(
      '  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n' +
        '  - id: new-thing\n    kind: http\n    method: GET\n    urlPattern: "https://api.example.com/*"\n    secret: BRAND_NEW_TOKEN\n',
    );
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [], baseGrantsYaml: base, changedAgentFiles: [], headGrantsYaml: head, env: {},
    });
    expect(verdict).toMatchObject({ allowed: false, rule: 3 });
  });

  it("rule 3(b): allows a synthetic grant narrower than an existing same-kind grant", () => {
    const base = grantsYaml('  - id: web-read\n    kind: http\n    method: GET\n    urlPattern: "*"\n    secret: WEB_READ_TOKEN\n');
    const head = grantsYaml(
      '  - id: web-read\n    kind: http\n    method: GET\n    urlPattern: "*"\n    secret: WEB_READ_TOKEN\n' +
        '  - id: scoped-read\n    kind: http\n    method: GET\n    urlPattern: "https://api.example.com/*"\n    secret: SCOPED_READ_TOKEN\n',
    );
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [], baseGrantsYaml: base, changedAgentFiles: [], headGrantsYaml: head, env: {},
    });
    expect(verdict).toEqual({ allowed: true });
  });

  it("rule 3(b): refuses a synthetic grant broader than any existing same-kind grant", () => {
    const base = grantsYaml('  - id: scoped-existing\n    kind: http\n    method: GET\n    urlPattern: "https://api.example.com/*"\n    secret: SCOPED_TOKEN\n');
    const head = grantsYaml(
      '  - id: scoped-existing\n    kind: http\n    method: GET\n    urlPattern: "https://api.example.com/*"\n    secret: SCOPED_TOKEN\n' +
        '  - id: broad-new\n    kind: http\n    method: GET\n    urlPattern: "*"\n    secret: BROAD_NEW_TOKEN\n',
    );
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [], baseGrantsYaml: base, changedAgentFiles: [], headGrantsYaml: head, env: {},
    });
    expect(verdict).toMatchObject({ allowed: false, rule: 3 });
  });

  it("allows an unrelated field edit on an existing agent, with grants.yaml untouched", () => {
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [{ path: "agents/foo/agent.yaml", content: FOO_AGENT_V1 }],
      baseGrantsYaml: EMPTY_GRANTS,
      changedAgentFiles: [{ path: "agents/foo/agent.yaml", content: FOO_AGENT_V2 }],
      env: {},
    });
    expect(verdict).toEqual({ allowed: true });
  });

  it("treats a deleted agent.yaml as removed from the resulting set", () => {
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [{ path: "agents/foo/agent.yaml", content: FOO_AGENT_V1 }],
      baseGrantsYaml: EMPTY_GRANTS,
      changedAgentFiles: [{ path: "agents/foo/agent.yaml", content: null }],
      env: {},
    });
    expect(verdict).toEqual({ allowed: true });
  });

  it("ignores a prompt.md-only change — nothing here parses prompt text", () => {
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [{ path: "agents/foo/agent.yaml", content: FOO_AGENT_V1 }],
      baseGrantsYaml: EMPTY_GRANTS,
      changedAgentFiles: [{ path: "agents/foo/prompt.md", content: "New prompt text." }],
      env: {},
    });
    expect(verdict).toEqual({ allowed: true });
  });
});
