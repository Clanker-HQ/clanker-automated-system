import { describe, expect, it } from "vitest";
import { evaluateSelfBuildChange, evaluateSelfBuildPr, isSelfBuildChange } from "../src/control/self-build-gate.js";
import { FakeGithubTransport } from "../src/control/github-transport.js";

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
const EMPTY_DEPLOYS = "deployments: []\n";

function grantsYaml(entries: string): string {
  return `grants:\n${entries}`;
}

function base() {
  return {
    baseAgentFiles: [],
    baseGrantsYaml: EMPTY_GRANTS,
    changedAgentFiles: [],
    agentNamesWithPromptMd: new Set<string>(),
    env: {},
  };
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

  it("is false for a name containing characters outside the tightened charset", () => {
    expect(isSelfBuildChange(["agents/evil?ref=main/agent.yaml"])).toBe(false);
    expect(isSelfBuildChange(["agents/../agent.yaml"])).toBe(false);
    expect(isSelfBuildChange(["agents/Foo/agent.yaml"])).toBe(false);
  });
});

describe("evaluateSelfBuildChange", () => {
  it("rule 1: refuses a new agent.yaml that fails AgentSchema validation", () => {
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [],
      baseGrantsYaml: EMPTY_GRANTS,
      changedAgentFiles: [{ path: "agents/bad/agent.yaml", content: INVALID_AGENT }],
      agentNamesWithPromptMd: new Set(["bad"]),
      env: {},
      baseDeploysYaml: EMPTY_DEPLOYS,
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
      agentNamesWithPromptMd: new Set(["foo"]),
      env: {},
      baseDeploysYaml: EMPTY_DEPLOYS,
    });
    expect(verdict).toMatchObject({ allowed: false, rule: 1 });
  });

  it("rule 2: refuses an existing grant edited in place", () => {
    const base = grantsYaml('  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n');
    const head = grantsYaml('  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo", "owner/other"]\n    secret: GITHUB_PR_TOKEN\n');
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [], baseGrantsYaml: base, changedAgentFiles: [], headGrantsYaml: head,
      agentNamesWithPromptMd: new Set<string>(), env: {}, baseDeploysYaml: EMPTY_DEPLOYS,
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
      agentNamesWithPromptMd: new Set<string>(),
      env: { GITHUB_PR_TOKEN: "provisioned" },
      baseDeploysYaml: EMPTY_DEPLOYS,
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
      baseAgentFiles: [], baseGrantsYaml: base, changedAgentFiles: [], headGrantsYaml: head,
      agentNamesWithPromptMd: new Set<string>(), env: {}, baseDeploysYaml: EMPTY_DEPLOYS,
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
      baseAgentFiles: [], baseGrantsYaml: base, changedAgentFiles: [], headGrantsYaml: head,
      agentNamesWithPromptMd: new Set<string>(), env: {}, baseDeploysYaml: EMPTY_DEPLOYS,
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
      baseAgentFiles: [], baseGrantsYaml: base, changedAgentFiles: [], headGrantsYaml: head,
      agentNamesWithPromptMd: new Set<string>(), env: {}, baseDeploysYaml: EMPTY_DEPLOYS,
    });
    expect(verdict).toMatchObject({ allowed: false, rule: 3 });
  });

  it("allows an unrelated field edit on an existing agent, with grants.yaml untouched", () => {
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [{ path: "agents/foo/agent.yaml", content: FOO_AGENT_V1 }],
      baseGrantsYaml: EMPTY_GRANTS,
      changedAgentFiles: [{ path: "agents/foo/agent.yaml", content: FOO_AGENT_V2 }],
      agentNamesWithPromptMd: new Set(["foo"]),
      env: {},
      baseDeploysYaml: EMPTY_DEPLOYS,
    });
    expect(verdict).toEqual({ allowed: true });
  });

  it("treats a deleted agent.yaml as removed from the resulting set", () => {
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [{ path: "agents/foo/agent.yaml", content: FOO_AGENT_V1 }],
      baseGrantsYaml: EMPTY_GRANTS,
      changedAgentFiles: [{ path: "agents/foo/agent.yaml", content: null }],
      agentNamesWithPromptMd: new Set(["foo"]),
      env: {},
      baseDeploysYaml: EMPTY_DEPLOYS,
    });
    expect(verdict).toEqual({ allowed: true });
  });

  it("ignores a prompt.md-only change — nothing here parses prompt text", () => {
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [{ path: "agents/foo/agent.yaml", content: FOO_AGENT_V1 }],
      baseGrantsYaml: EMPTY_GRANTS,
      changedAgentFiles: [{ path: "agents/foo/prompt.md", content: "New prompt text." }],
      agentNamesWithPromptMd: new Set(["foo"]),
      env: {},
      baseDeploysYaml: EMPTY_DEPLOYS,
    });
    expect(verdict).toEqual({ allowed: true });
  });

  it("rule 1: refuses when an agent's name doesn't match its directory", () => {
    const mismatched = FOO_AGENT_V1.replace("name: foo", "name: not-foo");
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [],
      baseGrantsYaml: EMPTY_GRANTS,
      changedAgentFiles: [{ path: "agents/foo/agent.yaml", content: mismatched }],
      agentNamesWithPromptMd: new Set(["foo"]),
      env: {},
      baseDeploysYaml: EMPTY_DEPLOYS,
    });
    expect(verdict).toMatchObject({ allowed: false, rule: 1 });
  });

  it("rule 1: refuses when an agent has no prompt.md", () => {
    const verdict = evaluateSelfBuildChange({
      baseAgentFiles: [],
      baseGrantsYaml: EMPTY_GRANTS,
      changedAgentFiles: [{ path: "agents/foo/agent.yaml", content: FOO_AGENT_V1 }],
      agentNamesWithPromptMd: new Set<string>(), // no prompt.md anywhere
      env: {},
      baseDeploysYaml: EMPTY_DEPLOYS,
    });
    expect(verdict).toMatchObject({ allowed: false, rule: 1 });
  });
});

describe("deploys.yaml as a self-build shape", () => {
  const ENTRY = `deployments:
  - slug: status-page
    repo: Clanker-HQ/clanker-status-page
    hostname: status.203-0-113-5.sslip.io
    port: 8080
`;

  it("is a self-build change on its own", () => {
    expect(isSelfBuildChange(["deploys.yaml"])).toBe(true);
  });

  it("is not a self-build change when mixed with an ordinary file", () => {
    expect(isSelfBuildChange(["deploys.yaml", "src/orchestrator.ts"])).toBe(false);
  });

  it("admits a PR that adds an entry", () => {
    const verdict = evaluateSelfBuildChange({ ...base(), baseDeploysYaml: "deployments: []\n", headDeploysYaml: ENTRY });
    expect(verdict).toEqual({ allowed: true });
  });

  it("admits a PR that removes an entry", () => {
    const verdict = evaluateSelfBuildChange({ ...base(), baseDeploysYaml: ENTRY, headDeploysYaml: "deployments: []\n" });
    expect(verdict).toEqual({ allowed: true });
  });

  it("refuses a deploys.yaml that does not validate", () => {
    const verdict = evaluateSelfBuildChange({ ...base(), baseDeploysYaml: "deployments: []\n", headDeploysYaml: "deployments:\n  - slug: x\n" });
    expect(verdict).toMatchObject({ allowed: false, rule: 4 });
  });

  it("refuses an entry edited in place", () => {
    const repointed = ENTRY.replace("Clanker-HQ/clanker-status-page", "AAS-Labs/something-else");
    const verdict = evaluateSelfBuildChange({ ...base(), baseDeploysYaml: ENTRY, headDeploysYaml: repointed });
    expect(verdict).toMatchObject({ allowed: false, rule: 4 });
    expect((verdict as { reason: string }).reason).toMatch(/edited in place/);
  });

  it("refuses a new entry claiming a hostname an existing entry already has", () => {
    // ENTRY carries its own "deployments:" header, so concatenating two full
    // copies would produce two competing top-level keys — invalid YAML — not
    // one list with two items. Strip the second copy's header so both
    // entries land under ENTRY's single "deployments:" list.
    const colliding = ENTRY + ENTRY.replace("deployments:\n", "").replace("status-page", "other-page");
    const verdict = evaluateSelfBuildChange({ ...base(), baseDeploysYaml: ENTRY, headDeploysYaml: colliding });
    expect(verdict).toMatchObject({ allowed: false, rule: 4 });
    expect((verdict as { reason: string }).reason).toMatch(/hostname/);
  });

  it("leaves the existing rules reachable when deploys.yaml is untouched", () => {
    const verdict = evaluateSelfBuildChange({ ...base(), baseDeploysYaml: ENTRY });
    expect(verdict).toEqual({ allowed: true });
  });
});

describe("evaluateSelfBuildPr", () => {
  it("fetches base and head grants.yaml and allows a self-build change that passes all rules", async () => {
    const github = new FakeGithubTransport();
    github.seedFile("owner/repo", "main", "grants.yaml", 'grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n');
    github.seedFile(
      "owner/repo", "sha-1", "grants.yaml",
      'grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n' +
        '  - id: new-thing\n    kind: github-pr\n    repos: ["owner/other"]\n    secret: GITHUB_PR_TOKEN\n',
    );

    const verdict = await evaluateSelfBuildPr(
      github, "owner/repo",
      { base: "main", headSha: "sha-1", changedFiles: ["grants.yaml"] },
      { GITHUB_PR_TOKEN: "provisioned" },
    );

    expect(verdict).toEqual({ allowed: true });
  });

  it("fetches base agent files via listRepoFiles, so rule 1 catches a grants.yaml-only PR that deletes a grant an untouched base agent still references", async () => {
    const github = new FakeGithubTransport();
    const grantedAgent = "name: foo\ntrigger:\n  type: cron\n  schedule: \"0 7 * * *\"\n  timezone: Europe/Berlin\nrun:\n  model: claude-haiku-4-5\ntier: granted\napproval: notify\ngrantRefs: [infra-repo]\noutbox:\n  discord: ops\n";
    github.seedFile("owner/repo", "main", "agents/foo/agent.yaml", grantedAgent);
    github.seedFile("owner/repo", "main", "agents/foo/prompt.md", "Do foo things.");
    github.seedFile("owner/repo", "main", "grants.yaml", 'grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n');
    github.seedFile("owner/repo", "sha-1", "grants.yaml", "grants: []\n");

    const verdict = await evaluateSelfBuildPr(
      github, "owner/repo",
      { base: "main", headSha: "sha-1", changedFiles: ["grants.yaml"] },
      {},
    );

    expect(verdict).toMatchObject({ allowed: false, rule: 1 });
  });

  it("treats an unseeded base grants.yaml as an empty grant list rather than throwing", async () => {
    const github = new FakeGithubTransport();
    const verdict = await evaluateSelfBuildPr(
      github, "owner/repo",
      { base: "main", headSha: "sha-1", changedFiles: ["agents/foo/agent.yaml"] },
      {},
    );
    // No agent seeded at head either — getFileContent returns null, which
    // evaluateSelfBuildChange's changedAgentFiles then carries as a deletion
    // of a path that was never in the base set either. Novel-agent creation
    // is exercised by the "allows a new grant..." case above; this one only
    // proves the wrapper never crashes on an all-empty GitHub state.
    expect(verdict.allowed).toBe(true);
  });
});
