# Self-Build Merge Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a PR that touches only `grants.yaml` or `agents/*/{agent.yaml,prompt.md}` merge through the existing `pr-reviewer` → `mergePR` pipeline under four mechanical rules, instead of being unconditionally refused the way every such PR is refused today.

**Architecture:** A new pure function (`evaluateSelfBuildChange`) implements the four rules over already-fetched base/head file content — no I/O, no LLM. A thin async wrapper (`evaluateSelfBuildPr`) fetches that content fresh from GitHub via two new `GithubTransport` methods. `mergePR`'s existing gate 1 in `sdk-runner.ts` calls the wrapper for the self-build file shape and falls back to today's unconditional `touchesExcludedPath` refusal for everything else.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod (via the existing `AgentSchema`/`GrantSchema`), Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-self-build-design.md` (see especially "The merge gate" and "The four rules" sections; rule 3 as amended in `docs/superpowers/specs/2026-08-30-self-evaluation-design.md`, "Amendment to `2026-08-30-self-build-design.md` rule 3").

## Global Constraints

- **No new npm dependencies.**
- **ESM import specifiers end in `.js`** even for `.ts` files — match the existing codebase.
- **Tests live in `tests/<name>.test.ts`** and import from `../src/...js`. Run with `npm test` (vitest).
- **`self-build-gate.ts`'s core decision logic (`evaluateSelfBuildChange`) must be a pure function: no network call, no filesystem read, no LLM call.** All I/O happens in `evaluateSelfBuildPr`, which is a thin wrapper around it.
- **Rule 4 ("CI green") needs no code.** It is the existing branch-protection/CI gate. Do not add anything for it.
- **`config.yaml`, `src/governor.ts`, `src/grants.ts`'s own governance logic, and the rest of `EXCLUDED_PATHS`/`EXCLUDED_PREFIXES` (`src/control/excluded-paths.ts`) stay excluded exactly as today.** This plan narrows the exclusion only for the exact shape described in "The merge gate" below — it does not touch `touchesExcludedPath` itself.
- **Every task ends with `npm test` and `npm run typecheck` both green before committing.**
- **Line numbers cited anywhere in this plan are approximate locations in the file as it existed when this plan was written.** Earlier tasks in this plan edit these files, so by the time a later task runs, cited line numbers may have shifted. Locate every insertion point by reading the file fresh and matching the named surrounding code (a function name, a comment, an adjacent existing call) — never by trusting an absolute line number.

## The four rules (recap, from the spec — implemented in Task 2)

Given the PR's base-ref state (the current live registry) and the changed files' head-ref content:

1. **Schema-valid**: every resulting `agent.yaml` still validates against `AgentSchema`, the resulting `grants.yaml` still validates against `GrantSchema`, and `validateGrantRefs` still passes across the resulting full agent set.
2. **No existing grant edited in place**: for every grant `id` present in both base and new `grants.yaml`, the two must be structurally identical. Self-build may only add a new grant `id` or delete an old one.
3. **Credential scope**: a self-authored grant is admissible if either (a) its `secret` names an env var that is already provisioned (a truthy value in `process.env`) and already in use by an existing (base-ref) grant, or (b) it carries no real credential (its `secret` is unprovisioned) and is no broader than an existing grant of the same `kind` (same-or-narrower `urlPattern`/`remote`+`branches`/`scope`/`repos`).
4. **CI green** — unchanged, existing gate, no code here.

---

### Task 1: `GithubTransport` gains `getFileContent`/`listRepoFiles`, and `PullRequestInfo` gains `base`

**Files:**
- Modify: `src/control/github-transport.ts`
- Modify: `src/control/github-api-transport.ts`
- Test: `tests/github-transport.test.ts` (extend)
- Test: `tests/github-api-transport.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `PullRequestInfo` gains `base: string` (the PR's target branch, e.g. `"main"`). `GithubTransport` gains `getFileContent(repo: string, ref: string, path: string): Promise<string | null>` (null = absent at that ref) and `listRepoFiles(repo: string, ref: string, pathPrefix: string): Promise<string[]>` (every blob path under `pathPrefix`, recursively). `FakeGithubTransport` gains a `seedFile(repo, ref, path, content)` test helper, and `seedPullRequest` accepts an optional `base` (defaulting to `"main"`) so none of the ~19 existing `seedPullRequest({...})` call sites across the test suite need updating.

- [ ] **Step 1: Read the files this task touches**

Read `src/control/github-transport.ts` and `src/control/github-api-transport.ts` in full (both already shown in this plan's design, but read them fresh — this plan may be executed after other changes land).

- [ ] **Step 2: Write the failing tests**

Add to `tests/github-transport.test.ts`, after the existing `describe("FakeGithubTransport", ...)` block (keep the existing `pr()` helper and its tests untouched):

```ts
describe("FakeGithubTransport.seedPullRequest base ref", () => {
  it('defaults base to "main" when not given', async () => {
    const t = new FakeGithubTransport();
    t.seedPullRequest(pr());
    const info = await t.getPullRequest("owner/repo", 1);
    expect(info.base).toBe("main");
  });

  it("keeps an explicitly seeded base", async () => {
    const t = new FakeGithubTransport();
    t.seedPullRequest(pr({ base: "develop" }));
    const info = await t.getPullRequest("owner/repo", 1);
    expect(info.base).toBe("develop");
  });
});

describe("FakeGithubTransport.getFileContent / listRepoFiles", () => {
  it("returns seeded file content at a given ref", async () => {
    const t = new FakeGithubTransport();
    t.seedFile("owner/repo", "main", "grants.yaml", "grants: []\n");
    expect(await t.getFileContent("owner/repo", "main", "grants.yaml")).toBe("grants: []\n");
  });

  it("returns null for a file that was never seeded at that ref", async () => {
    const t = new FakeGithubTransport();
    expect(await t.getFileContent("owner/repo", "main", "grants.yaml")).toBeNull();
  });

  it("keeps content at different refs independent", async () => {
    const t = new FakeGithubTransport();
    t.seedFile("owner/repo", "main", "grants.yaml", "grants: []\n");
    t.seedFile("owner/repo", "sha-2", "grants.yaml", "grants: [{id: x}]\n");
    expect(await t.getFileContent("owner/repo", "main", "grants.yaml")).toBe("grants: []\n");
    expect(await t.getFileContent("owner/repo", "sha-2", "grants.yaml")).toBe("grants: [{id: x}]\n");
  });

  it("lists only seeded files under the given prefix, at the given ref", async () => {
    const t = new FakeGithubTransport();
    t.seedFile("owner/repo", "main", "agents/foo/agent.yaml", "name: foo\n");
    t.seedFile("owner/repo", "main", "agents/bar/agent.yaml", "name: bar\n");
    t.seedFile("owner/repo", "main", "grants.yaml", "grants: []\n");
    t.seedFile("owner/repo", "sha-2", "agents/baz/agent.yaml", "name: baz\n");
    const files = await t.listRepoFiles("owner/repo", "main", "agents/");
    expect(files.sort()).toEqual(["agents/bar/agent.yaml", "agents/foo/agent.yaml"]);
  });
});
```

Add to `tests/github-api-transport.test.ts`: first, change the existing `prJson()` helper (near the top of the file) so `getPullRequest`'s existing tests keep passing once `base.ref` is read —

```ts
function prJson(overrides: Record<string, unknown> = {}) {
  return { head: { sha: "sha-1" }, base: { ref: "main" }, title: "A change", body: "Does a thing.", ...overrides };
}
```

Then add, in the existing `describe("GithubApiTransport.getPullRequest", ...)` block:

```ts
  it("reports the PR's base branch from the API response", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/files")) return fakeResponse({ json: [{ filename: "src/a.ts" }] });
      return fakeResponse({ json: prJson({ base: { ref: "develop" } }), text: "diff --git a/x b/x" });
    }) as unknown as typeof fetch;

    const t = new GithubApiTransport({ token: "x", fetchImpl });
    const info = await t.getPullRequest("owner/repo", 1);

    expect(info.base).toBe("develop");
  });
```

And two new top-level `describe` blocks at the end of the file:

```ts
describe("GithubApiTransport.getFileContent", () => {
  it("decodes base64 content from the Contents API", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ json: { content: Buffer.from("grants:\n  - id: x\n").toString("base64"), encoding: "base64" } }),
    ) as unknown as typeof fetch;
    const t = new GithubApiTransport({ token: "x", fetchImpl });

    const content = await t.getFileContent("owner/repo", "main", "grants.yaml");

    expect(content).toBe("grants:\n  - id: x\n");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/contents/grants.yaml?ref=main",
      expect.anything(),
    );
  });

  it("returns null for a 404 (file absent at that ref) rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 404 })) as unknown as typeof fetch;
    const t = new GithubApiTransport({ token: "x", fetchImpl });
    expect(await t.getFileContent("owner/repo", "main", "grants.yaml")).toBeNull();
  });

  it("throws on a non-404 error response", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 500 })) as unknown as typeof fetch;
    const t = new GithubApiTransport({ token: "x", fetchImpl });
    await expect(t.getFileContent("owner/repo", "main", "grants.yaml")).rejects.toThrow(/500/);
  });
});

describe("GithubApiTransport.listRepoFiles", () => {
  it("returns blob paths under the given prefix from the recursive tree", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        json: {
          truncated: false,
          tree: [
            { path: "agents/foo/agent.yaml", type: "blob" },
            { path: "agents/foo/prompt.md", type: "blob" },
            { path: "agents", type: "tree" },
            { path: "src/index.ts", type: "blob" },
          ],
        },
      }),
    ) as unknown as typeof fetch;
    const t = new GithubApiTransport({ token: "x", fetchImpl });

    const files = await t.listRepoFiles("owner/repo", "main", "agents/");

    expect(files).toEqual(["agents/foo/agent.yaml", "agents/foo/prompt.md"]);
  });

  it("fails closed on a truncated tree rather than returning an incomplete listing", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ json: { truncated: true, tree: [] } })) as unknown as typeof fetch;
    const t = new GithubApiTransport({ token: "x", fetchImpl });
    await expect(t.listRepoFiles("owner/repo", "main", "agents/")).rejects.toThrow(/truncated/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- github-transport github-api-transport`
Expected: FAIL — `base`/`getFileContent`/`listRepoFiles`/`seedFile` don't exist yet.

- [ ] **Step 4: Update `src/control/github-transport.ts`**

```ts
export interface PullRequestInfo {
  number: number;
  repo: string;
  headSha: string;
  /** The branch this PR targets, e.g. "main" — used by the self-build gate to fetch the CURRENT (not stale) base-ref registry state. */
  base: string;
  changedFiles: string[];
  diff: string;
  title: string;
  body: string;
}

export type MergeResult = { merged: true } | { merged: false; reason: string };

export interface GithubTransport {
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  postReviewComment(repo: string, number: number, body: string): Promise<void>;
  mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<MergeResult>;
  createPullRequest(repo: string, opts: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  /** Content of `path` at `ref` (a branch name or commit SHA), or null if it doesn't exist there. */
  getFileContent(repo: string, ref: string, path: string): Promise<string | null>;
  /** Every blob path under `pathPrefix` at `ref`, recursively. */
  listRepoFiles(repo: string, ref: string, pathPrefix: string): Promise<string[]>;
}

/** Test double: lets a test seed PR state and inspect what was posted/merged, with no real GitHub calls. */
export class FakeGithubTransport implements GithubTransport {
  postedComments: { repo: string; number: number; body: string }[] = [];
  merged: { repo: string; number: number }[] = [];
  createdPullRequests: { repo: string; head: string; base: string; title: string; body: string }[] = [];
  private pulls = new Map<string, PullRequestInfo>();
  private files = new Map<string, string>();
  private nextPrNumber = 1;

  private key(repo: string, number: number): string {
    return `${repo}#${number}`;
  }

  private fileKey(repo: string, ref: string, path: string): string {
    return `${repo}@${ref}:${path}`;
  }

  seedPullRequest(info: Omit<PullRequestInfo, "base"> & { base?: string }): void {
    this.pulls.set(this.key(info.repo, info.number), { ...info, base: info.base ?? "main" });
  }

  /** Seeds the content a getFileContent/listRepoFiles call returns for `path` at `ref`. */
  seedFile(repo: string, ref: string, path: string, content: string): void {
    this.files.set(this.fileKey(repo, ref, path), content);
  }

  async getFileContent(repo: string, ref: string, path: string): Promise<string | null> {
    return this.files.get(this.fileKey(repo, ref, path)) ?? null;
  }

  async listRepoFiles(repo: string, ref: string, pathPrefix: string): Promise<string[]> {
    const prefix = this.fileKey(repo, ref, pathPrefix);
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(this.fileKey(repo, ref, "").length));
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    const info = this.pulls.get(this.key(repo, number));
    if (!info) throw new Error(`FakeGithubTransport: no pull request seeded for ${repo}#${number}`);
    return info;
  }

  async postReviewComment(repo: string, number: number, body: string): Promise<void> {
    this.postedComments.push({ repo, number, body });
  }

  async mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<MergeResult> {
    const info = await this.getPullRequest(repo, number);
    if (info.headSha !== expectedHeadSha) {
      return { merged: false, reason: `PR head moved (expected ${expectedHeadSha}, now ${info.headSha}) — a newer commit landed since review started` };
    }
    this.merged.push({ repo, number });
    return { merged: true };
  }

  async createPullRequest(
    repo: string,
    opts: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    this.createdPullRequests.push({ repo, ...opts });
    const number = this.nextPrNumber++;
    return { number, url: `https://github.com/${repo}/pull/${number}` };
  }
}
```

- [ ] **Step 5: Update `src/control/github-api-transport.ts`**

In `getPullRequest`, change the `pr` cast and the returned object to carry `base`:

```ts
    const pr = (await prRes.json()) as { head: { sha: string }; base: { ref: string }; title: string; body: string | null };
    const files = (await filesRes.json()) as { filename: string; previous_filename?: string }[];
    const diff = await diffRes.text();
    return {
      number,
      repo,
      headSha: pr.head.sha,
      base: pr.base.ref,
      changedFiles: files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])),
      diff,
      title: pr.title,
      body: pr.body ?? "",
    };
```

Add two new methods to the class, after `createPullRequest`:

```ts
  async getFileContent(repo: string, ref: string, path: string): Promise<string | null> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API: failed to fetch ${repo}/${path}@${ref} (${res.status})`);
    const body = (await res.json()) as { content: string; encoding: string };
    return Buffer.from(body.content, "base64").toString("utf8");
  }

  /**
   * Uses the Git Trees API recursively rather than the Contents API, which
   * only lists one directory level per call — this needs every
   * `agents/*/agent.yaml` regardless of nesting depth in one round trip.
   * Fails closed on a truncated tree for the same reason `getPullRequest`
   * fails closed on a paginated changed-files list: an incomplete listing
   * here could hide an agent.yaml from the self-build gate's schema check.
   */
  async listRepoFiles(repo: string, ref: string, pathPrefix: string): Promise<string[]> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub API: failed to list files in ${repo}@${ref} (${res.status})`);
    const body = (await res.json()) as { tree: { path: string; type: string }[]; truncated: boolean };
    if (body.truncated) {
      throw new Error(`GitHub API: file tree for ${repo}@${ref} is truncated; refusing to enumerate an incomplete listing`);
    }
    return body.tree.filter((e) => e.type === "blob" && e.path.startsWith(pathPrefix)).map((e) => e.path);
  }
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/control/github-transport.ts src/control/github-api-transport.ts tests/github-transport.test.ts tests/github-api-transport.test.ts
git commit -m "feat: GithubTransport gains getFileContent/listRepoFiles and PullRequestInfo gains base"
```

---

### Task 2: `self-build-gate.ts` — the four rules as a pure function

**Files:**
- Modify: `src/grants.ts` (export the existing private `globMatch` helper — no behavior change)
- Create: `src/control/self-build-gate.ts`
- Test: `tests/self-build-gate.test.ts`

**Interfaces:**
- Consumes: `Grant`, `parseGrants`, `validateGrantRefs`, `globMatch` (now exported) from `src/grants.ts`; `parseAgent` from `src/registry.ts`; `ValidationError` from `src/errors.ts`.
- Produces: `isSelfBuildChange(changedFiles: string[]): boolean`; `evaluateSelfBuildChange(input: SelfBuildInput): SelfBuildVerdict` where `SelfBuildVerdict = { allowed: true } | { allowed: false; rule: 1 | 2 | 3; reason: string }`. Both consumed by Task 3 and Task 4.

- [ ] **Step 1: Export `globMatch`**

In `src/grants.ts`, change:

```ts
function globMatch(pattern: string, value: string): boolean {
```

to:

```ts
export function globMatch(pattern: string, value: string): boolean {
```

This is a pure visibility change — no behavior differs. Run `npm test -- grants` to confirm the existing `grants.test.ts` suite (which already exercises `globMatch` indirectly through `matchGrant`) still passes before moving on.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/self-build-gate.test.ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- self-build-gate`
Expected: FAIL — cannot resolve `../src/control/self-build-gate.js`.

- [ ] **Step 4: Write the implementation**

```ts
// src/control/self-build-gate.ts
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
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- self-build-gate grants && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/grants.ts src/control/self-build-gate.ts tests/self-build-gate.test.ts
git commit -m "feat: self-build gate's four rules as a pure function"
```

---

### Task 3: `evaluateSelfBuildPr` — fetch base/head state from GitHub and call the pure rules

**Files:**
- Modify: `src/control/self-build-gate.ts` (add the wrapper)
- Test: `tests/self-build-gate.test.ts` (extend)

**Interfaces:**
- Consumes: `GithubTransport`, `PullRequestInfo` (Task 1); `evaluateSelfBuildChange` (Task 2).
- Produces: `evaluateSelfBuildPr(github: GithubTransport, repo: string, info: Pick<PullRequestInfo, "base" | "headSha" | "changedFiles">, env: Record<string, string | undefined>): Promise<SelfBuildVerdict>` — consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

Add these two imports to the top of `tests/self-build-gate.test.ts`, alongside its existing `import { evaluateSelfBuildChange, isSelfBuildChange } from "../src/control/self-build-gate.js";` line (extend that same import with `evaluateSelfBuildPr` rather than duplicating the line):

```ts
import { evaluateSelfBuildChange, evaluateSelfBuildPr, isSelfBuildChange } from "../src/control/self-build-gate.js";
import { FakeGithubTransport } from "../src/control/github-transport.js";
```

Then append this new `describe` block at the end of the file, after the existing `describe("evaluateSelfBuildChange", ...)` block's closing `});`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- self-build-gate`
Expected: FAIL — `evaluateSelfBuildPr` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Append to `src/control/self-build-gate.ts` (and add `GithubTransport`/`PullRequestInfo` to the existing import from `./github-transport.js` — this is the file's first dependency on that module):

```ts
import type { GithubTransport, PullRequestInfo } from "./github-transport.js";
```

```ts
/**
 * Fetches the base-ref registry state and this PR's head-ref changes fresh
 * from GitHub, then hands them to the pure evaluateSelfBuildChange above.
 * Kept separate so the actual decision logic stays a pure function no test
 * needs to mock GitHub for.
 */
export async function evaluateSelfBuildPr(
  github: GithubTransport,
  repo: string,
  info: Pick<PullRequestInfo, "base" | "headSha" | "changedFiles">,
  env: Record<string, string | undefined>,
): Promise<SelfBuildVerdict> {
  const [baseGrantsYaml, baseAgentPaths] = await Promise.all([
    github.getFileContent(repo, info.base, "grants.yaml"),
    github.listRepoFiles(repo, info.base, "agents/"),
  ]);

  const baseAgentFiles = await Promise.all(
    baseAgentPaths
      .filter((p) => p.endsWith("/agent.yaml"))
      .map(async (path) => ({ path, content: (await github.getFileContent(repo, info.base, path)) ?? "" })),
  );

  const changedAgentPaths = info.changedFiles.filter((f) => f.endsWith("/agent.yaml"));
  const changedAgentFiles = await Promise.all(
    changedAgentPaths.map(async (path) => ({ path, content: await github.getFileContent(repo, info.headSha, path) })),
  );

  const headGrantsYaml = info.changedFiles.includes("grants.yaml")
    ? ((await github.getFileContent(repo, info.headSha, "grants.yaml")) ?? "grants: []\n")
    : undefined;

  return evaluateSelfBuildChange({
    baseAgentFiles,
    baseGrantsYaml: baseGrantsYaml ?? "grants: []\n",
    changedAgentFiles,
    headGrantsYaml,
    env,
  });
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- self-build-gate && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/control/self-build-gate.ts tests/self-build-gate.test.ts
git commit -m "feat: fetch base/head registry state from GitHub for the self-build gate"
```

---

### Task 4: Wire the self-build gate into `mergePR`'s gate 1

**Files:**
- Modify: `src/runner/sdk-runner.ts`
- Test: `tests/sdk-runner-options.test.ts` (extend)

**Interfaces:**
- Consumes: `isSelfBuildChange`, `evaluateSelfBuildPr` (Tasks 2-3).
- Produces: no new public interface — `mergePR`'s existing gate 1 behavior changes for the self-build file shape only.

- [ ] **Step 1: Read the current handler**

Read `src/runner/sdk-runner.ts`'s `mergePR` tool handler fresh (search for `"mergePR"` — it's inside the `githubPrServer` block). Confirm gate 1 is still exactly the `touchesExcludedPath(info.changedFiles)` check described earlier in this plan's design notes; if it has moved or changed shape, adapt this task's edit to match what you find rather than assuming the line numbers below.

- [ ] **Step 2: Write the failing tests**

Add to `tests/sdk-runner-options.test.ts`, inside the existing `describe("SdkRunner GitHub PR tools", ...)` block (it already defines `granted()` and `GITHUB_PR_GRANT` — reuse them):

```ts
  it("merges a self-build grants.yaml-only PR that passes the self-build gate", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    vi.stubEnv("GITHUB_PR_TOKEN", "provisioned");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    const baseGrants = 'grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n';
    const headGrants =
      'grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n' +
      '  - id: new-thing\n    kind: github-pr\n    repos: ["owner/other-repo"]\n    secret: GITHUB_PR_TOKEN\n';
    github.seedFile("owner/repo", "main", "grants.yaml", baseGrants);
    github.seedFile("owner/repo", "sha-1", "grants.yaml", headGrants);
    github.seedPullRequest({ number: 1, repo: "owner/repo", headSha: "sha-1", base: "main", changedFiles: ["grants.yaml"], diff: "", title: "t", body: "b" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [GITHUB_PR_GRANT], pending: new PendingStore(dir), github });
    await collect(runner.execute(granted(), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as unknown as GithubPrParams;

    const result = await mergeToolHandler(params)({ repo: "owner/repo", number: 1, expectedHeadSha: "sha-1" });

    expect(github.merged).toEqual([{ repo: "owner/repo", number: 1 }]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("merged") }] });
  });

  it("refuses a self-build grants.yaml PR that edits an existing grant in place, citing the failing rule", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    const baseGrants = 'grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo"]\n    secret: GITHUB_PR_TOKEN\n';
    const headGrants = 'grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: ["owner/repo", "owner/other-repo"]\n    secret: GITHUB_PR_TOKEN\n';
    github.seedFile("owner/repo", "main", "grants.yaml", baseGrants);
    github.seedFile("owner/repo", "sha-1", "grants.yaml", headGrants);
    github.seedPullRequest({ number: 1, repo: "owner/repo", headSha: "sha-1", base: "main", changedFiles: ["grants.yaml"], diff: "", title: "t", body: "b" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [GITHUB_PR_GRANT], pending: new PendingStore(dir), github });
    await collect(runner.execute(granted(), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as unknown as GithubPrParams;

    const result = await mergeToolHandler(params)({ repo: "owner/repo", number: 1, expectedHeadSha: "sha-1" });

    expect(github.merged).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/self-build rule 2/) }] });
  });

  it("still refuses a PR that mixes grants.yaml with an ordinary code file, exactly as touchesExcludedPath does today", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    github.seedPullRequest({ number: 1, repo: "owner/repo", headSha: "sha-1", changedFiles: ["grants.yaml", "src/orchestrator.ts"], diff: "", title: "t", body: "b" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [GITHUB_PR_GRANT], pending: new PendingStore(dir), github });
    await collect(runner.execute(granted(), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as unknown as GithubPrParams;

    const result = await mergeToolHandler(params)({ repo: "owner/repo", number: 1, expectedHeadSha: "sha-1" });

    expect(github.merged).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/excluded|sensitive/i) }] });
  });
```

No new import is needed — `tests/sdk-runner-options.test.ts` already imports `FakeGithubTransport` from `"../src/control/github-transport.js"` (used by the file's other GitHub-PR-tool tests).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- sdk-runner-options`
Expected: FAIL on the three new cases; every pre-existing case in the file still PASSes.

- [ ] **Step 4: Wire the gate**

In `src/runner/sdk-runner.ts`, add the import near the other `../control/*` imports at the top of the file:

```ts
import { evaluateSelfBuildPr, isSelfBuildChange } from "../control/self-build-gate.js";
```

Replace the `mergePR` handler's gate 1 block:

```ts
              async ({ repo, number, expectedHeadSha }) => {
                const info = await github.getPullRequest(repo, number);

                // Gate 1 — the excluded-path check, against the PR's real,
                // GitHub-reported changed files. This runs first and
                // unconditionally: no grant, no review verdict, nothing
                // later in this handler can override it.
                if (touchesExcludedPath(info.changedFiles)) {
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: "Refused: this PR touches a security-sensitive excluded path and can never merge through this pipeline. Changes to that code must be made directly by a human, outside this pipeline.",
                      },
                    ],
                  };
                }
```

with:

```ts
              async ({ repo, number, expectedHeadSha }) => {
                const info = await github.getPullRequest(repo, number);

                // Gate 1 — self-build changes (grants.yaml, or agents/*/{agent.yaml,
                // prompt.md} in isolation — see isSelfBuildChange) get the mechanical
                // four-rule self-build gate instead of an unconditional refusal;
                // everything else still gets the unconditional excluded-path refusal,
                // exactly as before this gate existed. This runs first: no grant, no
                // review verdict, nothing later in this handler can override either branch.
                if (isSelfBuildChange(info.changedFiles)) {
                  const verdict = await evaluateSelfBuildPr(github, repo, info, process.env);
                  if (!verdict.allowed) {
                    return {
                      content: [
                        { type: "text" as const, text: `Refused: self-build rule ${verdict.rule} failed — ${verdict.reason}` },
                      ],
                    };
                  }
                  // Passed all four rules — fall through to gates 2/3 below, same as
                  // any other merge: a self-build change still needs a grant and a
                  // fresh SHA.
                } else if (touchesExcludedPath(info.changedFiles)) {
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: "Refused: this PR touches a security-sensitive excluded path and can never merge through this pipeline. Changes to that code must be made directly by a human, outside this pipeline.",
                      },
                    ],
                  };
                }
```

Leave gates 2 and 3 (the grant check and the stale-SHA check) exactly as they are — they still run, unconditionally, for a self-build change that passed gate 1, same as for any other merge.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — including every pre-existing `sdk-runner-options` case.

- [ ] **Step 6: Commit**

```bash
git add src/runner/sdk-runner.ts tests/sdk-runner-options.test.ts
git commit -m "feat: wire the self-build gate into mergePR's gate 1"
```

---

### Task 5: Documentation — describe the self-build flow as shipped

**Files:**
- Modify: `README.md`
- Modify: `docs/system-context.md`
- Modify: `docs/superpowers/specs/2026-08-30-self-build-design.md`

**Interfaces:**
- Consumes: nothing (docs-only task).
- Produces: no code.

- [ ] **Step 1: Update `README.md`**

Read the "Not built yet" section (search for `## Not built yet`). Remove the first bullet (the one starting "**Git-based deploy and the "proposal approval" Discord flow**") and add a short paragraph above the "Still genuinely deferred:" list, or as a new sentence in the intro paragraph, noting it now works:

```markdown
The governor, capability tiers and grants, park/resume, and the Discord control
bot (approvals, questions, admin commands) are all built and live. A PR
touching only `grants.yaml` or `agents/*/{agent.yaml,prompt.md}` can merge
through the normal `pr-reviewer` → `mergePR` pipeline under four mechanical
rules (`src/control/self-build-gate.ts`) instead of being refused outright —
see `docs/superpowers/specs/2026-08-30-self-build-design.md`. Everything
outside that exact shape is refused exactly as before.
Still genuinely deferred:
```

Keep the remaining two bullets (browser capability, dashboard) as they are.

- [ ] **Step 2: Update `docs/system-context.md`**

Read the "Before proposing or designing something new" and "possible future additions" sections (search for `## Before proposing or designing something new` and the surrounding bullet list). Remove the bullet:

```markdown
- **A self-build flow.** An agent proposing a change to this system's own
  configuration (a new `agent.yaml`, a `grants.yaml` edit), with the
  supervisor validating it and asking to merge it. Would need its own
  deploy/approval path — `builder`'s current PR flow is deliberately
  barred from touching those files.
```

It is no longer a future addition — `builder`'s existing PR flow now reaches `grants.yaml`/`agents/**` for exactly this shape, gated by `src/control/self-build-gate.ts`.

- [ ] **Step 3: Update the spec's status line**

In `docs/superpowers/specs/2026-08-30-self-build-design.md`, change the opening status line:

```markdown
Status: partially shipped. `improvement-scout`'s redundancy-awareness fix
(see "`improvement-scout` prompt change" below) landed 2026-08-30, ahead of
and independent from the rest of this spec. The merge gate itself — the part
that actually lets a config-only PR merge — is not yet implemented; that's
the remaining work. See `docs/decisions.md` for why `grants.yaml`/`agents/**`
were excluded from the normal PR pipeline in the first place; this spec is
the "own deploy/approval path" `docs/system-context.md` flagged as the
missing piece.
```

to:

```markdown
Status: shipped. `improvement-scout`'s redundancy-awareness fix landed
2026-08-30; the merge gate itself (`src/control/self-build-gate.ts`, wired
into `mergePR`'s gate 1 in `src/runner/sdk-runner.ts`) landed
2026-08-31. See `docs/decisions.md` for why `grants.yaml`/`agents/**` were
excluded from the normal PR pipeline in the first place — that reasoning is
unchanged for everything outside the exact shape this gate admits.
```

- [ ] **Step 4: Run the full suite and typecheck** (docs-only, but confirms nothing else broke since Task 4)

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/system-context.md docs/superpowers/specs/2026-08-30-self-build-design.md
git commit -m "docs: describe the self-build merge gate as shipped"
```
