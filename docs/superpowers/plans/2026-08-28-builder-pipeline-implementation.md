# Builder Agent + Multi-hop Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `builder` specialist that can implement a described code change, commit it, push it to a dedicated branch namespace, and open a PR — fully autonomously — with a hard, code-level guarantee it can never push to a protected branch or merge anything itself.

**Architecture:** Two new MCP tools (`pushBranch`, `openPR`) join the existing `mergePR`/`postReviewComment` tools on the `githubPr` server in `src/runner/sdk-runner.ts`. `pushBranch` is authorized by a newly-enforced `git-push` grant kind (structurally separate from the `github-pr` grant kind `mergePR` uses), and delegates the actual push to an injectable `GitPusher`. `openPR` is ungated and calls a new `GithubTransport.createPullRequest` method. A new `builder` agent (`trigger: dispatched`) uses these tools; `research`'s prompt gains one closing instruction to hand off implementable conclusions to it via the existing `queueTask` tool. No `Router` changes are needed — routing is already description-based (see `dispatcher.ts`'s `specialistsOf()`).

**Tech Stack:** TypeScript, Node 24, Zod, Vitest, `@anthropic-ai/claude-agent-sdk`, `node:child_process` (new — first use in `src/`).

**Spec:** `docs/superpowers/specs/2026-08-28-builder-pipeline-design.md` (this plan implements it in full; read it alongside this plan). Builds on `docs/superpowers/specs/2026-08-28-task-lifecycle-hardening-design.md`, already merged (its `queueTask`/`listMyTasks`/`recentFailures` tools already exist in `src/runner/sdk-runner.ts` — nothing in this plan touches them except reading `listMyTasks`'s registration pattern as a template).

## Global Constraints

- Branch namespace: `agent/builder/` prefix, enforced unconditionally in both `pushBranch` and `openPR` — never bypassable by any grant.
- `builder` never receives a `github-pr`-kind grant. Pushing is authorized exclusively via the (now-enforced) `git-push` kind, kept structurally separate from merge authorization — this is the entire point of the spec (see spec §3).
- `pushBranch`'s grant `secret` env var is read at runtime to build the push URL — the one grant-kind exception to "secret is boot-checked only." No other grant kind's runtime behavior changes.
- `openPR` and `postReviewComment` are ungated; `mergePR` and `pushBranch` are gated (unconditional branch/path check, then grant check, in that order).
- Each `builder` run clones fresh; no persistent checkout across runs.
- `builder`'s `agent.yaml`: `tier: autonomous`, `approval: auto`, `grantRefs: [builder-push]` — per this project's CLAUDE.md standing rule, never `park`/`notify`. Safety comes from the branch-name regex (unconditional, in code) and the grant scope, not a human click.
- **Resolved deviation from the spec's pseudocode** (spec §4.2): the spec's `pushBranch` sketch reads `decision.grantRef` off an `"allow"` decision to look up the matched grant's `secret`. `Decision`'s `"allow"` variant (`src/grants.ts`) carries no `grantRef` — only `"park"` does — so that line doesn't type-check as written. Task 4 below resolves this by having the handler call `matchGrant()` directly (already exported from `src/grants.ts`) to get the matched `Grant` object, rather than extending `decide()`'s return shape. This keeps `Decision`'s contract — and every existing test asserting on it — untouched; `decide()` is still used unchanged for the tier/park/deny gate itself.
- Repo/branch validation: `pushBranch` and `openPR` both validate their repo-shaped inputs with the same `owner/repo` zod regex `mergePR` already uses (`/^[\w.-]+\/[\w.-]+$/`), matching this file's established convention. The spec's `openPR` sketch left `repo` as a bare `z.string()`; this plan tightens it for consistency, the same reasoning `mergePR`'s existing schema already applies.
- `git` CLI availability: already satisfied. `Dockerfile` has installed `git` since the containerization commit (`14556af`), before this spec was written — Task 9 only adds a comment recording that this is why, no functional Dockerfile change is needed.

---

### Task 1: `git-push` grant enforcement + `pushBranch` effect detection

**Files:**
- Modify: `src/grants.ts`
- Test: `tests/grants.test.ts`

**Interfaces:**
- Produces: `OutwardEffect.branch?: string` (new optional field); `detectOutwardEffect("pushBranch", { repo, branch })` returns `{ kind: "git-push", description, target: repo, branch }` or `null` if `repo`/`branch` aren't strings; `matchGrant()` now enforces `GitPushGrant.branches` against `effect.branch` when `effect.branch` is defined, and is unchanged when it's `undefined` (the existing Bash-`git push` detection path, which never sets `branch`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/grants.test.ts` (append inside/near the existing `describe("detectOutwardEffect", ...)` and `describe("matchGrant", ...)` blocks — match the existing file's import list, which already includes `detectOutwardEffect`, `matchGrant`, `decide`, `validateGrantRefs`):

```ts
describe("detectOutwardEffect: pushBranch", () => {
  it("reports a git-push effect carrying the branch", () => {
    const effect = detectOutwardEffect("pushBranch", { repo: "owner/repo", branch: "agent/builder/add-x" });
    expect(effect).toEqual({
      kind: "git-push",
      description: "push agent/builder/add-x to owner/repo",
      target: "owner/repo",
      branch: "agent/builder/add-x",
    });
  });

  it("returns null when repo is missing or not a string", () => {
    expect(detectOutwardEffect("pushBranch", { branch: "agent/builder/x" })).toBeNull();
    expect(detectOutwardEffect("pushBranch", { repo: 1, branch: "agent/builder/x" })).toBeNull();
  });

  it("returns null when branch is missing or not a string", () => {
    expect(detectOutwardEffect("pushBranch", { repo: "owner/repo" })).toBeNull();
    expect(detectOutwardEffect("pushBranch", { repo: "owner/repo", branch: 1 })).toBeNull();
  });
});

describe("matchGrant: git-push branch enforcement", () => {
  // Built via parseGrants, matching this file's established convention (see
  // PUSH_SITE above) rather than a literal `Grant`-typed object — no new
  // import is needed and the grant is validated the same way a real one is.
  const BUILDER_PUSH = parseGrants(
    "grants.yaml",
    'grants:\n  - id: builder-push\n    kind: git-push\n    remote: "owner/repo"\n    branches: ["agent/builder/*"]\n    secret: X\n',
  )[0]!;

  it("matches when remote and branch both match a pushBranch effect", () => {
    const effect = detectOutwardEffect("pushBranch", { repo: "owner/repo", branch: "agent/builder/add-x" })!;
    expect(matchGrant([BUILDER_PUSH], effect)).toBe(BUILDER_PUSH);
  });

  it("rejects a pushBranch effect whose branch falls outside the grant's branches patterns", () => {
    const effect = detectOutwardEffect("pushBranch", { repo: "owner/repo", branch: "main" })!;
    expect(matchGrant([BUILDER_PUSH], effect)).toBeNull();
  });

  it("rejects a pushBranch effect whose remote doesn't match, even with a matching branch", () => {
    const effect = detectOutwardEffect("pushBranch", { repo: "owner/other-repo", branch: "agent/builder/add-x" })!;
    expect(matchGrant([BUILDER_PUSH], effect)).toBeNull();
  });

  it("does not apply branch enforcement to a raw Bash git push effect (branch is undefined)", () => {
    const effect = detectOutwardEffect("Bash", { command: "git push owner/repo main" })!;
    expect(effect.branch).toBeUndefined();
    // remote matches "owner/repo" via globMatch on `remote`; branches is
    // irrelevant here since effect.branch is undefined — unchanged behavior.
    expect(matchGrant([BUILDER_PUSH], effect)).toBe(BUILDER_PUSH);
  });

  it("supports a glob pattern in branches, e.g. agent/builder/*", () => {
    const effect = detectOutwardEffect("pushBranch", { repo: "owner/repo", branch: "agent/builder/deeply/nested-slug" })!;
    expect(matchGrant([BUILDER_PUSH], effect)).toBe(BUILDER_PUSH);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/grants.test.ts`
Expected: FAIL — `detectOutwardEffect` returns `null` for `"pushBranch"` (no case exists yet), so the `.toEqual` assertions fail and `effect!` throws in the `matchGrant` tests.

- [ ] **Step 3: Implement**

In `src/grants.ts`, add `branch?: string` to `OutwardEffect`:

```ts
export interface OutwardEffect {
  kind: "http" | "git-push" | "provision" | "github-pr";
  description: string;
  target: string;
  /** Only ever set by the pushBranch effect below — a raw Bash `git push` never carries one. */
  branch?: string;
}
```

Add a `pushBranch` case to `detectOutwardEffect`, immediately after the existing `mergePR` block and before the function's final `return null;`:

```ts
  // Only reachable via the pushBranch tool handler's own direct decide() call
  // (src/runner/sdk-runner.ts), same as mergePR above.
  if (toolName === "pushBranch") {
    const repo = typeof input.repo === "string" ? input.repo : "";
    const branch = typeof input.branch === "string" ? input.branch : "";
    if (!repo || !branch) return null;
    return { kind: "git-push", description: `push ${branch} to ${repo}`, target: repo, branch };
  }

  return null;
```

Update `matchGrant` to enforce `branches` when `effect.branch` is present:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/grants.test.ts`
Expected: PASS, including the full pre-existing suite in that file (no regressions to the unchanged Bash/`http`/`github-pr` paths).

- [ ] **Step 5: Commit**

```bash
git add src/grants.ts tests/grants.test.ts
git commit -m "feat: enforce git-push grant branches and detect pushBranch effects"
```

---

### Task 2: `GitPusher` — the injectable push mechanism

**Files:**
- Create: `src/control/git-pusher.ts`
- Test: `tests/git-pusher.test.ts`

**Interfaces:**
- Produces: `GitPusher` interface with `push(opts: { cwd: string; remoteUrl: string; branch: string }): Promise<void>`; `RealGitPusher` (shells out to real `git`); `FakeGitPusher` (records calls, no I/O) with a public `pushed: { cwd: string; remoteUrl: string; branch: string }[]` array.

- [ ] **Step 1: Write the failing tests**

Create `tests/git-pusher.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const { RealGitPusher, FakeGitPusher } = await import("../src/control/git-pusher.js");

describe("RealGitPusher", () => {
  it("shells out to git push with the remote URL and an explicit refspec, no shell interpolation", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown, stdout: string, stderr: string) => void) =>
      cb(null, "", ""),
    );
    const pusher = new RealGitPusher();

    await pusher.push({
      cwd: "/work/repo",
      remoteUrl: "https://x-access-token:tok@github.com/owner/repo.git",
      branch: "agent/builder/add-x",
    });

    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/work/repo", "push", "https://x-access-token:tok@github.com/owner/repo.git", "HEAD:refs/heads/agent/builder/add-x"],
      expect.any(Function),
    );
  });

  it("rejects when the underlying git push fails", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown, stdout: string, stderr: string) => void) =>
      cb(new Error("git push failed"), "", "non-fast-forward"),
    );
    const pusher = new RealGitPusher();

    await expect(
      pusher.push({ cwd: "/work/repo", remoteUrl: "https://x-access-token:tok@github.com/owner/repo.git", branch: "agent/builder/add-x" }),
    ).rejects.toThrow("git push failed");
  });
});

describe("FakeGitPusher", () => {
  it("records the push without touching real git or the network", async () => {
    const pusher = new FakeGitPusher();
    const opts = { cwd: "/work/repo", remoteUrl: "https://x-access-token:tok@github.com/owner/repo.git", branch: "agent/builder/add-x" };

    await pusher.push(opts);

    expect(pusher.pushed).toEqual([opts]);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/git-pusher.test.ts`
Expected: FAIL with "Cannot find module '../src/control/git-pusher.js'" (file doesn't exist yet).

- [ ] **Step 3: Implement**

Create `src/control/git-pusher.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Injectable push mechanism, mirroring GithubTransport's injectable-transport shape. */
export interface GitPusher {
  push(opts: { cwd: string; remoteUrl: string; branch: string }): Promise<void>;
}

/**
 * Shells out to the real `git` binary via execFile (never a shell — no
 * interpolation risk from `remoteUrl`/`branch`). `remoteUrl` carries the push
 * credential as a one-shot CLI argument
 * (`https://x-access-token:<token>@github.com/owner/repo.git`) rather than a
 * credential helper or `git remote add` — it never touches disk and never
 * appears in `git remote -v` afterward.
 */
export class RealGitPusher implements GitPusher {
  async push(opts: { cwd: string; remoteUrl: string; branch: string }): Promise<void> {
    await execFileAsync("git", ["-C", opts.cwd, "push", opts.remoteUrl, `HEAD:refs/heads/${opts.branch}`]);
  }
}

/** Test double: records what would have been pushed, with no real git or network call. */
export class FakeGitPusher implements GitPusher {
  pushed: { cwd: string; remoteUrl: string; branch: string }[] = [];

  async push(opts: { cwd: string; remoteUrl: string; branch: string }): Promise<void> {
    this.pushed.push(opts);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/git-pusher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/control/git-pusher.ts tests/git-pusher.test.ts
git commit -m "feat: add GitPusher (RealGitPusher/FakeGitPusher) for pushBranch"
```

---

### Task 3: `GithubTransport.createPullRequest`

**Files:**
- Modify: `src/control/github-transport.ts`
- Modify: `src/control/github-api-transport.ts`
- Test: `tests/github-transport.test.ts`
- Test: `tests/github-api-transport.test.ts`

**Interfaces:**
- Consumes: existing `GithubTransport` interface, `FakeGithubTransport`, `GithubApiTransport` (from Task 3's read of the current files — see plan's grounding above).
- Produces: `GithubTransport.createPullRequest(repo: string, opts: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>`, implemented on both `FakeGithubTransport` and `GithubApiTransport`. `FakeGithubTransport` gains a public `createdPullRequests: { repo: string; head: string; base: string; title: string; body: string }[]` array.

- [ ] **Step 1: Write the failing tests**

Add to `tests/github-transport.test.ts` (inside the existing `describe("FakeGithubTransport", ...)` block):

```ts
  it("records a created pull request and returns an incrementing fake number/url", async () => {
    const t = new FakeGithubTransport();

    const first = await t.createPullRequest("owner/repo", { head: "agent/builder/add-x", base: "main", title: "Add X", body: "Because Y." });
    const second = await t.createPullRequest("owner/repo", { head: "agent/builder/add-z", base: "main", title: "Add Z", body: "Because W." });

    expect(t.createdPullRequests).toEqual([
      { repo: "owner/repo", head: "agent/builder/add-x", base: "main", title: "Add X", body: "Because Y." },
      { repo: "owner/repo", head: "agent/builder/add-z", base: "main", title: "Add Z", body: "Because W." },
    ]);
    expect(first).toEqual({ number: 1, url: "https://github.com/owner/repo/pull/1" });
    expect(second).toEqual({ number: 2, url: "https://github.com/owner/repo/pull/2" });
  });
```

Add to `tests/github-api-transport.test.ts` (new `describe` block, using the existing `fakeResponse` helper already defined at the top of that file):

```ts
describe("GithubApiTransport.createPullRequest", () => {
  it("posts to the pulls endpoint and returns the created PR's number and url", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ json: { number: 42, html_url: "https://github.com/owner/repo/pull/42" } }),
    ) as unknown as typeof fetch;
    const t = new GithubApiTransport({ token: "x", fetchImpl });

    const pr = await t.createPullRequest("owner/repo", { head: "agent/builder/add-x", base: "main", title: "Add X", body: "Because Y." });

    expect(pr).toEqual({ number: 42, url: "https://github.com/owner/repo/pull/42" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ head: "agent/builder/add-x", base: "main", title: "Add X", body: "Because Y." }),
      }),
    );
  });

  it("throws when GitHub rejects the pull request creation", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 422 })) as unknown as typeof fetch;
    const t = new GithubApiTransport({ token: "x", fetchImpl });

    await expect(
      t.createPullRequest("owner/repo", { head: "agent/builder/add-x", base: "main", title: "Add X", body: "" }),
    ).rejects.toThrow(/422/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/github-transport.test.ts tests/github-api-transport.test.ts`
Expected: FAIL — `createPullRequest` doesn't exist on either class yet (TypeScript compile error surfaces as a test failure under `vitest run`).

- [ ] **Step 3: Implement**

In `src/control/github-transport.ts`, extend the interface and `FakeGithubTransport`:

```ts
export interface GithubTransport {
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  postReviewComment(repo: string, number: number, body: string): Promise<void>;
  /** Refuses (merged: false) rather than merging if the PR's current head has moved past expectedHeadSha. */
  mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<MergeResult>;
  createPullRequest(repo: string, opts: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
}

/** Test double: lets a test seed PR state and inspect what was posted/merged, with no real GitHub calls. */
export class FakeGithubTransport implements GithubTransport {
  postedComments: { repo: string; number: number; body: string }[] = [];
  merged: { repo: string; number: number }[] = [];
  createdPullRequests: { repo: string; head: string; base: string; title: string; body: string }[] = [];
  private pulls = new Map<string, PullRequestInfo>();
  private nextPrNumber = 1;

  // ... existing key/seedPullRequest/getPullRequest/postReviewComment/mergePullRequest unchanged ...

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

(Only add the new field/method — leave every existing method and the `key`/`seedPullRequest` helpers exactly as they are today.)

In `src/control/github-api-transport.ts`, add the method to `GithubApiTransport` (place it after `mergePullRequest`):

```ts
  async createPullRequest(
    repo: string,
    opts: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ head: opts.head, base: opts.base, title: opts.title, body: opts.body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub API: failed to open a pull request for ${repo}:${opts.head} (${res.status})`);
    const pr = (await res.json()) as { number: number; html_url: string };
    return { number: pr.number, url: pr.html_url };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/github-transport.test.ts tests/github-api-transport.test.ts`
Expected: PASS, including every pre-existing test in both files.

- [ ] **Step 5: Commit**

```bash
git add src/control/github-transport.ts src/control/github-api-transport.ts tests/github-transport.test.ts tests/github-api-transport.test.ts
git commit -m "feat: add GithubTransport.createPullRequest"
```

---

### Task 4: `pushBranch` MCP tool (the security-critical gate)

**Files:**
- Modify: `src/runner/sdk-runner.ts`
- Test: `tests/sdk-runner-options.test.ts`

**Interfaces:**
- Consumes: `GitPusher` (Task 2), the enforced `git-push` `matchGrant`/`detectOutwardEffect` (Task 1), existing `decide()` (unchanged), existing `githubPrServer`/`mergePR` structure (see plan's grounding: `src/runner/sdk-runner.ts:340-414`).
- Produces: `SdkRunner`'s constructor deps gain `gitPusher?: GitPusher`; a `pushBranch` tool registered on the `githubPr` server only when both `github` and `gitPusher` are present.

- [ ] **Step 1: Write the failing tests**

Add to `tests/sdk-runner-options.test.ts`, inside (or immediately after) the existing `describe("SdkRunner GitHub PR tools", ...)` block. First, add `FakeGitPusher` to the top-of-file imports (alongside the existing `FakeGithubTransport` import):

```ts
import { FakeGitPusher } from "../src/control/git-pusher.js";
```

Then add a new nested `describe`:

```ts
  describe("pushBranch", () => {
    const GIT_PUSH_GRANT: Grant = { id: "builder-push", kind: "git-push", remote: "owner/repo", branches: ["agent/builder/*"], secret: "BUILDER_PUSH_TOKEN" };

    function builderAgent(grantRefs: string[] = ["builder-push"]) {
      return { ...AGENT, name: "builder", tier: "autonomous", approval: "auto", grantRefs } as unknown as AgentDef;
    }

    interface PushBranchParams {
      options: {
        mcpServers: {
          githubPr?: {
            instance: { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> };
          };
        };
      };
    }
    function pushBranchHandler(params: PushBranchParams): (input: unknown) => Promise<unknown> {
      return params.options.mcpServers.githubPr!.instance._registeredTools.pushBranch!.handler;
    }
    function mergeHandler(params: PushBranchParams): (input: unknown) => Promise<unknown> {
      return params.options.mcpServers.githubPr!.instance._registeredTools.mergePR!.handler;
    }

    it("is not registered when gitPusher is not wired in, even with github present", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const github = new FakeGithubTransport();
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      const runner = new SdkRunner({ grants: [GIT_PUSH_GRANT], pending: new PendingStore(dir), github });
      await collect(runner.execute(builderAgent(), CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as unknown as PushBranchParams;
      expect(params.options.mcpServers.githubPr!.instance._registeredTools.pushBranch).toBeUndefined();
    });

    it("refuses a branch outside agent/builder/, before any grant is even consulted (Gate 1, unconditional)", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      vi.stubEnv("BUILDER_PUSH_TOKEN", "tok");
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const github = new FakeGithubTransport();
      const gitPusher = new FakeGitPusher();
      // Deliberately permissive grant (branches: "*") to prove Gate 1 alone stops this.
      const permissive: Grant = { id: "builder-push", kind: "git-push", remote: "*", branches: ["*"], secret: "BUILDER_PUSH_TOKEN" };
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      const runner = new SdkRunner({ grants: [permissive], pending: new PendingStore(dir), github, gitPusher });
      await collect(runner.execute(builderAgent(), CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as unknown as PushBranchParams;

      const result = await pushBranchHandler(params)({ repo: "owner/repo", branch: "main" });

      expect(gitPusher.pushed).toEqual([]);
      expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/agent\/builder\//) }] });
    });

    it("pushes via GitPusher when the branch namespace and grant both check out", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      vi.stubEnv("BUILDER_PUSH_TOKEN", "tok");
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const github = new FakeGithubTransport();
      const gitPusher = new FakeGitPusher();
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      const runner = new SdkRunner({ grants: [GIT_PUSH_GRANT], pending: new PendingStore(dir), github, gitPusher });
      await collect(runner.execute(builderAgent(), CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as unknown as PushBranchParams;

      const result = await pushBranchHandler(params)({ repo: "owner/repo", branch: "agent/builder/add-x" });

      expect(gitPusher.pushed).toEqual([
        { cwd: CTX.workspace, remoteUrl: "https://x-access-token:tok@github.com/owner/repo.git", branch: "agent/builder/add-x" },
      ]);
      expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Pushed HEAD to owner/repo:agent/builder/add-x") }] });
    });

    it("denies when no git-push grant matches the repo, and never calls GitPusher", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const github = new FakeGithubTransport();
      const gitPusher = new FakeGitPusher();
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      const runner = new SdkRunner({ grants: [GIT_PUSH_GRANT], pending: new PendingStore(dir), github, gitPusher });
      await collect(runner.execute(builderAgent(), CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as unknown as PushBranchParams;

      const result = await pushBranchHandler(params)({ repo: "owner/other-repo", branch: "agent/builder/add-x" });

      expect(gitPusher.pushed).toEqual([]);
      expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/no grant authorises/i) }] });
    });

    it("refuses with a clear message when the grant's secret env var isn't set, without calling GitPusher", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      // BUILDER_PUSH_TOKEN deliberately left unset.
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const github = new FakeGithubTransport();
      const gitPusher = new FakeGitPusher();
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      const runner = new SdkRunner({ grants: [GIT_PUSH_GRANT], pending: new PendingStore(dir), github, gitPusher });
      await collect(runner.execute(builderAgent(), CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as unknown as PushBranchParams;

      const result = await pushBranchHandler(params)({ repo: "owner/repo", branch: "agent/builder/add-x" });

      expect(gitPusher.pushed).toEqual([]);
      expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("BUILDER_PUSH_TOKEN") }] });
    });

    // This is the single most important test in this plan (spec §6): a
    // successful pushBranch must NOT also authorize mergePR, even for the
    // exact same agent/repo in the exact same run — proving the git-push and
    // github-pr grant kinds stay independently revocable.
    it("does not let a successful pushBranch also authorise mergePR — builder has no github-pr grant at all", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      vi.stubEnv("BUILDER_PUSH_TOKEN", "tok");
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const github = new FakeGithubTransport();
      github.seedPullRequest({ number: 1, repo: "owner/repo", headSha: "sha-1", changedFiles: ["src/x.ts"], diff: "", title: "t", body: "b" });
      const gitPusher = new FakeGitPusher();
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      // builder's ONLY grant is the git-push one — no github-pr grant, per spec §3.
      const runner = new SdkRunner({ grants: [GIT_PUSH_GRANT], pending: new PendingStore(dir), github, gitPusher });
      await collect(runner.execute(builderAgent(), CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as unknown as PushBranchParams;

      const pushResult = await pushBranchHandler(params)({ repo: "owner/repo", branch: "agent/builder/add-x" });
      expect(pushResult).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Pushed HEAD") }] });

      const mergeResult = await mergeHandler(params)({ repo: "owner/repo", number: 1, expectedHeadSha: "sha-1" });
      expect(github.merged).toEqual([]);
      expect(mergeResult).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/no grant authorises/i) }] });
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sdk-runner-options.test.ts`
Expected: FAIL — `pushBranch` is `undefined` on every test that expects it to exist/behave (no such tool registered yet), and the "not registered" test also fails since `gitPusher` isn't a recognized constructor option yet (TypeScript error).

- [ ] **Step 3: Implement**

In `src/runner/sdk-runner.ts`:

1. Add the import (extend the existing `grants.js` import line):

```ts
import { decide, detectOutwardEffect, matchGrant, type Grant } from "../grants.js";
```

2. Add `gitPusher?: GitPusher` to the constructor's `deps` type, and import the type:

```ts
import type { GitPusher } from "../control/git-pusher.js";
```

```ts
  constructor(
    private readonly deps: {
      grants: Grant[];
      pending: PendingStore;
      github?: GithubTransport;
      gitPusher?: GitPusher;
      /** Wired in production (src/index.ts); optional so tests/scripts that don't care about task-queueing can skip it, the same shape `github` already uses. */
      tasks?: TaskStore;
      /** Wakes the dispatcher after queueTask adds work, so it's picked up on this tick rather than waiting for the next periodic one. */
      wake?: () => Promise<void>;
    } = {
      grants: [],
      pending: new PendingStore(process.cwd()),
    },
  ) {}
```

3. Inside `execute()`, capture `gitPusher` alongside the existing `github` closure variable (right before the `githubPrServer` construction):

```ts
    const github = this.deps.github;
    const gitPusher = this.deps.gitPusher;
```

4. Add the `pushBranch` tool to the `githubPrServer`'s `tools` array, conditionally included via the same spread-ternary pattern `queueTask` already uses for `wakeDep` (see the `taskQueueServer` block later in this same file). Insert it after `postReviewComment`:

```ts
            tool(
              "postReviewComment",
              "Post a comment on a pull request — findings, an explanation of why a merge was refused, or general review feedback. Never gated: commenting has no outward consequence beyond ordinary communication.",
              { repo: z.string(), number: z.number().int().positive(), body: z.string().min(1) },
              async ({ repo, number, body }) => {
                await github.postReviewComment(repo, number, body);
                return { content: [{ type: "text" as const, text: `Comment posted on ${repo}#${number}.` }] };
              },
            ),
            ...(gitPusher
              ? [
                  tool(
                    "pushBranch",
                    "Push the current branch to a new remote branch and prepare it for a PR. Refuses any branch outside the agent/builder/ namespace, and refuses if no grant authorises pushing to the target repo.",
                    { repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"'), branch: z.string().min(1) },
                    async ({ repo, branch }: { repo: string; branch: string }) => {
                      // Gate 1 — unconditional, same pattern as mergePR's excluded-path
                      // lock. No grant, no tier, nothing below this can override it.
                      if (!/^agent\/builder\//.test(branch)) {
                        return {
                          content: [
                            {
                              type: "text" as const,
                              text: `Refused: branch "${branch}" is outside the agent/builder/ namespace this tool will ever push to.`,
                            },
                          ],
                        };
                      }

                      // Gate 2 — does this agent hold a git-push grant covering this repo+branch?
                      const decision = decide(agent, this.deps.grants, "pushBranch", { repo, branch });
                      if (decision.kind !== "allow") {
                        const text =
                          decision.kind === "park"
                            ? `Refused: pushing to "${repo}" requires human approval of grant "${decision.grantRef}", which this tool cannot wait for.`
                            : `Refused: no grant authorises pushing to "${repo}".`;
                        return { content: [{ type: "text" as const, text }] };
                      }

                      // decide()'s "allow" carries no grantRef (only "park" does), so
                      // the matched Grant is looked up directly here via matchGrant —
                      // this is the one spot this tool needs the grant object itself
                      // (for its `secret`), not just the yes/no decision.
                      const effect = detectOutwardEffect("pushBranch", { repo, branch })!;
                      const relevantGrants = this.deps.grants.filter((g) => agent.grantRefs.includes(g.id));
                      const grant = matchGrant(relevantGrants, effect);
                      const token = grant ? process.env[grant.secret] : undefined;
                      if (!grant || !token) {
                        return {
                          content: [
                            { type: "text" as const, text: `Refused: grant "${grant?.id}" has no ${grant?.secret} set.` },
                          ],
                        };
                      }

                      await gitPusher.push({
                        cwd: ctx.workspace,
                        remoteUrl: `https://x-access-token:${token}@github.com/${repo}.git`,
                        branch,
                      });
                      return { content: [{ type: "text" as const, text: `Pushed HEAD to ${repo}:${branch}.` }] };
                    },
                  ),
                ]
              : []),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sdk-runner-options.test.ts`
Expected: PASS, including every pre-existing test in the file (the `mergePR`/`postReviewComment` describe block must be completely unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/runner/sdk-runner.ts tests/sdk-runner-options.test.ts
git commit -m "feat: add gated pushBranch MCP tool, kept structurally separate from mergePR's grant"
```

---

### Task 5: `openPR` MCP tool

**Files:**
- Modify: `src/runner/sdk-runner.ts`
- Test: `tests/sdk-runner-options.test.ts`

**Interfaces:**
- Consumes: `GithubTransport.createPullRequest` (Task 3).
- Produces: an `openPR` tool registered on the `githubPr` server whenever `github` is present (independent of `gitPusher`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/sdk-runner-options.test.ts`, another nested `describe` inside `"SdkRunner GitHub PR tools"`:

```ts
  describe("openPR", () => {
    function openPrHandler(params: {
      options: { mcpServers: { githubPr: { instance: { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> } } } };
    }): (input: unknown) => Promise<unknown> {
      return params.options.mcpServers.githubPr.instance._registeredTools.openPR!.handler;
    }

    it("is registered whenever github is present, independent of gitPusher", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const github = new FakeGithubTransport();
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      // Deliberately no gitPusher.
      const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), github });
      await collect(runner.execute(granted(), CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as unknown as GithubPrParams;
      expect(params.options.mcpServers.githubPr.instance._registeredTools.openPR).toBeDefined();
    });

    it("opens a pull request via GithubTransport when head is in the agent/builder/ namespace", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const github = new FakeGithubTransport();
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), github });
      await collect(runner.execute(granted(), CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as unknown as GithubPrParams;

      const result = await openPrHandler(params)({
        repo: "owner/repo",
        head: "agent/builder/add-x",
        base: "main",
        title: "Add X",
        body: "Because Y.",
      });

      expect(github.createdPullRequests).toEqual([
        { repo: "owner/repo", head: "agent/builder/add-x", base: "main", title: "Add X", body: "Because Y." },
      ]);
      expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Opened https://github.com/owner/repo/pull/1") }] });
    });

    it("refuses a head outside the agent/builder/ namespace, without calling GithubTransport", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
      const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
      const github = new FakeGithubTransport();
      queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
      const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), github });
      await collect(runner.execute(granted(), CTX, new AbortController().signal));
      const params = queryMock.mock.calls[0]![0] as unknown as GithubPrParams;

      const result = await openPrHandler(params)({ repo: "owner/repo", head: "main", base: "main", title: "t", body: "b" });

      expect(github.createdPullRequests).toEqual([]);
      expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/agent\/builder\//) }] });
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sdk-runner-options.test.ts`
Expected: FAIL — `openPR` is `undefined`.

- [ ] **Step 3: Implement**

In `src/runner/sdk-runner.ts`, add `openPR` unconditionally to the `githubPrServer`'s `tools` array (i.e. NOT inside the `gitPusher ?` conditional block — it belongs alongside `mergePR`/`postReviewComment`, after the `pushBranch` block from Task 4):

```ts
            tool(
              "openPR",
              "Open a pull request for a branch that was already pushed via pushBranch. Never gated: by the time this runs, the code is already public on a branch that can only ever be outside the default branch — merging, the actual point of risk, stays behind mergePR's own gates.",
              {
                repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"'),
                head: z.string().min(1),
                base: z.string().min(1),
                title: z.string().min(1),
                body: z.string(),
              },
              async ({ repo, head, base, title, body }) => {
                // Defense in depth, not a security boundary on its own —
                // pushBranch already refused any branch outside this
                // namespace before code could reach GitHub at all.
                if (!/^agent\/builder\//.test(head)) {
                  return {
                    content: [{ type: "text" as const, text: `Refused: "${head}" is outside the agent/builder/ namespace.` }],
                  };
                }
                const pr = await github.createPullRequest(repo, { head, base, title, body });
                return { content: [{ type: "text" as const, text: `Opened ${pr.url}.` }] };
              },
            ),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sdk-runner-options.test.ts`
Expected: PASS — full file green, including Tasks 4 and 5's additions and every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add src/runner/sdk-runner.ts tests/sdk-runner-options.test.ts
git commit -m "feat: add ungated openPR MCP tool"
```

---

### Task 6: Wire `GitPusher` through `build-runner.ts` and `index.ts`; add the `builder-push` grant

**Files:**
- Modify: `src/runner/build-runner.ts`
- Modify: `src/index.ts`
- Modify: `grants.yaml`
- Modify: `.env.example`
- Test: `tests/build-runner.test.ts`

**Interfaces:**
- Consumes: `RealGitPusher` (Task 2).
- Produces: `buildRunner(opts: { ...; gitPusher?: GitPusher }, env)` passes `gitPusher` through to `new SdkRunner(opts)`; `index.ts` constructs a `RealGitPusher` unconditionally (no env var needed at construction — only `pushBranch`'s runtime `process.env[grant.secret]` lookup needs `BUILDER_PUSH_TOKEN`, and only once an actual push is attempted) and passes it into `buildRunner`.

- [ ] **Step 1: Write the failing test**

Add to `tests/build-runner.test.ts`:

```ts
import { FakeGitPusher } from "../src/control/git-pusher.js";
```

```ts
  it("accepts a gitPusher and still returns the real runner when provided", () => {
    const { grants, pending } = opts();
    const gitPusher = new FakeGitPusher();
    const runner = buildRunner({ grants, pending, gitPusher }, {}) as SdkRunner;
    expect(runner).toBeInstanceOf(SdkRunner);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/build-runner.test.ts`
Expected: FAIL — TypeScript error, `gitPusher` isn't a recognized property on `buildRunner`'s `opts` parameter type yet.

- [ ] **Step 3: Implement**

In `src/runner/build-runner.ts`, add the import and extend the `opts` type:

```ts
import type { GitPusher } from "../control/git-pusher.js";
```

```ts
export function buildRunner(
  opts: { grants: Grant[]; pending: PendingStore; github?: GithubTransport; gitPusher?: GitPusher; tasks?: TaskStore; wake?: () => Promise<void> },
  env: NodeJS.ProcessEnv = process.env,
): Runner {
```

(`opts` is already passed wholesale to `new SdkRunner(opts)` in the `RUNNER !== "fake"` branch, so no other change is needed in this file — `gitPusher` flows through automatically.)

In `src/index.ts`, import `RealGitPusher` and pass an instance into `buildRunner`'s call (near the existing `github = new GithubApiTransport({ token: githubToken })` line):

```ts
import { RealGitPusher } from "./control/git-pusher.js";
```

```ts
    github = new GithubApiTransport({ token: githubToken });
    runner = buildRunner({
      grants, pending: new PendingStore(DATA_DIR), github,
      gitPusher: new RealGitPusher(),
      tasks,
      wake: async () => { if (dispatcher) await dispatcher.wake(); },
    });
```

In `grants.yaml`, append the `builder-push` grant (matching the file's existing comment style and the placeholder the spec calls out):

```yaml
  # Backs agents/builder's grantRefs. BUILDER_PUSH_TOKEN is a fine-grained
  # PAT on the same dedicated bot account infra-repo uses, scoped to
  # Contents:Write + Pull requests:Write on this repo only — broader than
  # infra-repo's Contents:Read, so it's a separate token, not a reused one.
  # branches restricts this grant to the agent/builder/ namespace as real,
  # enforced scope (see matchGrant's extended git-push case) — pushBranch's
  # own hardcoded regex enforces the same boundary unconditionally, so a
  # typo here narrows nothing that matters, but widens nothing dangerous
  # either.
  - id: builder-push
    kind: git-push
    remote: "owner/repo"   # placeholder: the actual infra repo's "owner/repo"
    branches: ["agent/builder/*"]
    secret: BUILDER_PUSH_TOKEN
```

In `.env.example`, append documentation for the new secret (after the existing `GITHUB_WEBHOOK_SECRET`/`WEBHOOK_PORT` entries):

```
# Push-and-open-PR gate for the builder agent: a fine-grained PAT on the same
# dedicated bot GitHub account infra-repo uses, scoped to Contents:Write +
# Pull requests:Write on this repo only. Read at runtime by the pushBranch
# tool (src/runner/sdk-runner.ts) to build the push URL — the one grant kind
# whose secret is consulted beyond boot-time well-formedness checking.
BUILDER_PUSH_TOKEN=
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/build-runner.test.ts`
Expected: PASS, including every pre-existing test in the file. Also run `npx vitest run tests/grants.test.ts` to confirm `grants.yaml`'s parsing tests (if any load the real file) still succeed — if none load the real file directly, this step is a no-op sanity check.

- [ ] **Step 5: Commit**

```bash
git add src/runner/build-runner.ts src/index.ts grants.yaml .env.example tests/build-runner.test.ts
git commit -m "feat: wire GitPusher through build-runner/index, add builder-push grant"
```

---

### Task 7: The `builder` agent definition

**Files:**
- Create: `agents/builder/agent.yaml`
- Create: `agents/builder/prompt.md`
- Test: `tests/builder-agent-registration.test.ts`

**Interfaces:**
- Consumes: `loadRegistry` (`src/registry.ts`), `loadGrants`/`validateGrantRefs` (`src/grants.ts`), both unchanged — this task only adds a new agent directory and grant entry (already added in Task 6) for the existing loaders to pick up.

- [ ] **Step 1: Write the failing test**

Create `tests/builder-agent-registration.test.ts` — this is a real-repo integration check (no scaffolded fixture), the same paths `src/index.ts` resolves at boot:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadGrants, validateGrantRefs } from "../src/grants.js";
import { loadRegistry } from "../src/registry.js";

describe("builder agent registration against the real repo config", () => {
  it("loads agents/builder/agent.yaml cleanly and its grantRefs validate against the real grants.yaml", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cai-builder-registration-"));
    const config = loadConfig(join(process.cwd(), "config.yaml"));
    const agents = loadRegistry({ agentsDir: join(process.cwd(), "agents"), dataDir, config });
    const grants = loadGrants(join(process.cwd(), "grants.yaml"));

    expect(() => validateGrantRefs(agents, grants)).not.toThrow();

    const builder = agents.find((a) => a.name === "builder");
    expect(builder).toBeDefined();
    expect(builder).toMatchObject({
      trigger: { type: "dispatched" },
      tier: "autonomous",
      approval: "auto",
      grantRefs: ["builder-push"],
    });
  });
});
```

(`loadRegistry`'s `config: Config` parameter is required — not optional — per `src/registry.ts`'s signature, and is used for outbox-channel validation (`opts.config.discord.channels`). `loadConfig` reads the repo's real `config.yaml`, the same file `src/index.ts` loads at boot.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/builder-agent-registration.test.ts`
Expected: FAIL — `agents.find((a) => a.name === "builder")` is `undefined` (directory doesn't exist yet).

- [ ] **Step 3: Implement**

Create `agents/builder/agent.yaml`:

```yaml
name: builder
enabled: true
authoredBy: claude-local
description: >-
  Implements a small, well-described code change, commits it, pushes it
  to a dedicated namespace, and opens a PR. Never merges — pr-reviewer
  and mergePR own that decision, unchanged.

trigger:
  type: dispatched

run:
  model: claude-sonnet-5
  effort: medium
  maxTurns: 60
  timeoutMinutes: 30
  maxBudgetUsd: 3.00

permissions:
  allowedTools: [Read, Write, Edit, Glob, Grep, Bash]
  disallowedTools: []

tier: autonomous
approval: auto
grantRefs: [builder-push]

outbox:
  discord: smoke
  notifyOn: [success, failure]
```

Create `agents/builder/prompt.md`:

```markdown
You implement a small, well-described code change end to end: clone the
target repo, make the change, verify it, commit it, push it, and open a
pull request. Nobody reviews your plan before you act — `pr-reviewer` reviews
the PR you open, after the fact, the same way it reviews any other PR.

## What you have

The task's request is appended to this prompt. It names the repo to change
(as `owner/repo`) and describes what to build and why. If either is missing
or too vague to act on safely, say so in your final message rather than
guessing at a repo or improvising scope.

## How to work

1. Clone the target repo fresh into your workspace:
   `git clone --depth 1 https://github.com/<owner>/<repo>.git .`
2. Determine the repo's real default branch — never guess `main` or
   `master`:
   `git symbolic-ref refs/remotes/origin/HEAD` (strip the `refs/remotes/origin/`
   prefix to get the branch name).
3. Create a local branch under the `agent/builder/` namespace, named for
   what you're building, e.g. `agent/builder/add-rate-limit-header`.
4. Make the described change.
5. Run the project's existing tests and typecheck (whatever it already uses
   — check `package.json` scripts, or the equivalent for the project's
   language/tooling) before committing. Do not commit a change that fails
   the project's own checks.
6. Commit with a clear, specific message.
7. Call `pushBranch` with the repo and your `agent/builder/...` branch name.
   It pushes `HEAD` from your current workspace clone — there is nothing
   else to pass it.
8. Call `openPR` against the real default branch you determined in step 2,
   with a title and body that explain what changed and why.

You never call `mergePR` — that isn't your job, and no grant you hold would
authorize it anyway. You never push to any branch outside `agent/builder/*`
— `pushBranch` refuses that unconditionally, regardless of what you ask for.

## What to report

End your final message with a short summary: what you changed, a link to
the PR you opened, and anything you noticed but didn't fix. If you couldn't
complete the task (missing repo, tests failing in a way you couldn't
resolve, the change turned out to be larger or riskier than described),
say so plainly rather than opening a PR you're not confident in.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/builder-agent-registration.test.ts`
Expected: PASS. Also run the full suite once here — `npx vitest run` — since adding a new agent directory is exactly the kind of change that can surface an unrelated assumption elsewhere (e.g. a test that asserts an exact count of agents or dispatched specialists).

- [ ] **Step 5: Commit**

```bash
git add agents/builder/agent.yaml agents/builder/prompt.md tests/builder-agent-registration.test.ts
git commit -m "feat: add the builder dispatched specialist agent"
```

---

### Task 8: `research` → `builder` handoff

**Files:**
- Modify: `agents/research/prompt.md`

**Interfaces:**
- None — prompt-text only. No `Router`/dispatcher code changes are needed (per spec §4.7): `Router.route()` already LLM-matches task text against every enabled `trigger: dispatched` specialist's `description`, and `builder`'s `description` (Task 7) is what makes this handoff reachable.

- [ ] **Step 1: Add the handoff instruction**

Edit `agents/research/prompt.md`, inserting a new section after "What to produce" and before the final "You have no ability to spend money..." paragraph:

```markdown
## When your conclusion is something to build

If your findings conclude something concrete and *implementable* is worth
doing — a code change, not a market observation or a "someone should look
into this" — call `queueTask` describing exactly what to build, which repo
(as `owner/repo`), and why, in addition to writing it into your findings
file. This hands the idea to `builder`, the specialist that can actually
write and ship the change; without this call, an implementable conclusion
dead-ends here even though something could act on it.
```

(This changes the final paragraph's meaning slightly — the agent still cannot spend money, publish, or edit code itself, but it now *can* set the wheels in motion via `queueTask`. Leave the final "no ability to..." paragraph's wording about the agent's own actions unchanged; it remains true that `research` itself does none of these things.)

- [ ] **Step 2: Verify the instruction landed correctly**

Run: `grep -n "queueTask" agents/research/prompt.md`
Expected: one match, inside the new "When your conclusion is something to build" section.

This task has no automated test — `research`'s prompt is plain instruction text with no schema to validate against, the same as every other prompt-only edit in this codebase (see `agents/opportunity-scout/prompt.md`'s and `agents/improvement-scout/prompt.md`'s `listMyTasks`/`recentFailures` instructions from the prior spec, which also shipped without a dedicated test).

- [ ] **Step 3: Commit**

```bash
git add agents/research/prompt.md
git commit -m "docs: research hands concrete implementable conclusions to builder via queueTask"
```

---

### Task 9: Dockerfile — record why `git` is already there

**Files:**
- Modify: `Dockerfile`

**Interfaces:** None.

- [ ] **Step 1: Verify `git` is already installed**

Run: `grep -n "git" Dockerfile`
Expected: `RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ...` — confirmed present since the containerization commit (`14556af`), predating this spec. No functional change is needed; `builder` is simply the first agent to actually exercise it.

- [ ] **Step 2: Add a one-line comment recording why it matters now**

Edit `Dockerfile`:

```dockerfile
FROM node:24-bookworm-slim

# git and ca-certificates were added when this container was first built;
# builder (docs/superpowers/specs/2026-08-28-builder-pipeline-design.md) is
# the first agent to actually run local git commands (clone/commit/push)
# and needs outbound HTTPS to github.com — both already satisfied here.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 3: Confirm the image still builds (only if Docker is available in this environment)**

Run: `docker build -t cai-builder-check .`
Expected: builds successfully, same as before this comment-only change. If Docker isn't available in the environment executing this plan, skip this step — the change is a comment, and `git`'s presence was already confirmed by inspection in Step 1.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "docs: record why the Dockerfile already has git, for builder"
```

---

## Final Verification (before handing off to finishing-a-development-branch)

- [ ] Run the full test suite: `npx vitest run`. Expected: all tests pass, including every test added across Tasks 1–7 and every pre-existing test untouched by this plan.
- [ ] Run the TypeScript compiler: check `package.json`'s `scripts` for a `typecheck`/`build` script (e.g. `npx tsc --noEmit`) and run it. Expected: no type errors.
- [ ] Grep for the single most important guarantee this spec exists to create: `grep -n "grantRefs: \[builder-push\]" agents/builder/agent.yaml` and confirm `builder`'s `grantRefs` contains no `github-pr`-kind grant id (cross-check against `grants.yaml`'s `kind: github-pr` entries — currently only `infra-repo`).
- [ ] Confirm `agents/builder/agent.yaml` sets `tier: autonomous` / `approval: auto` (no `park`/`notify`), per this project's CLAUDE.md standing rule.
