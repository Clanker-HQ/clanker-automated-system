# Builder Agent + Multi-hop Pipeline — Design

**Status:** Approved for planning
**Related:** [[2026-08-28-standing-tasks-design]], [[2026-08-28-task-lifecycle-hardening-design]]
**CLAUDE.md note:** this spec was revised mid-design after a standing-preference
correction — pushing code defaults to `tier: autonomous` + `approval: auto`
like everything else in this project. Safety here comes from an unconditional,
code-level branch-name restriction and the *existing*, already-autonomous
`pr-reviewer`/`mergePR` review pipeline — never from a human approval click.

## 1. Problem

`improvement-scout` and `research` can each identify concrete, buildable
work, but nothing in the system can act on it. Today both dead-end in a
Discord summary: `research` writes findings to a file and reports a
2-4 sentence summary; `improvement-scout` queues a task description and
stops. No specialist agent can write code, push it anywhere, or open a
PR — closing that loop is the entire point of this spec.

## 2. Goals / Non-goals

**Goals:**
- A new dispatched specialist, `builder`, that can implement a described
  change, commit it, push it, and open a PR — fully autonomously.
- A hard, code-level guarantee that `builder` can never push to a
  protected/default branch or merge anything itself, regardless of how
  its grant is configured.
- `research` gains the ability to hand off a concrete implementable
  conclusion to `builder` via the existing `queueTask` tool, instead of
  dead-ending at a Discord summary.

**Non-goals:**
- `builder` does not review or merge PRs — that stays `pr-reviewer`'s job,
  unchanged.
- No new review logic beyond what `pr-reviewer`/`mergePR` already do
  (excluded-path lock, head-SHA staleness check). This spec's only new
  algorithmic safety net is the branch-name restriction; everything past
  "a PR now exists" reuses the existing, already-autonomous pipeline.
- No persistent/reused checkout across runs — each `builder` run clones
  fresh. Revisit only if clone time becomes a real cost.

## 3. Why this doesn't collapse into a self-merge hole

The most important design constraint here is one that isn't obvious until
you look at how the existing `github-pr` grant kind works:
`matchGrant`'s `github-pr` case authorizes *any* effect of that kind
against a matching repo — it has no idea whether the effect was
`mergePR` or something else. If `builder` were given a `github-pr`-kind
grant to authorize pushing, and the `mergePR` tool is registered globally
on the same `githubPr` MCP server (it is — registration is per-runner,
not per-agent; `decide()` is what actually enforces per-agent boundaries,
using the real `AgentDef` in scope for that run), then the *same* grant
would also authorize `builder` calling `mergePR` on that repo. That would
let `builder` push and then self-merge, silently defeating the entire
"pr-reviewer is the real gate" design.

The fix: `builder`'s push is authorized under the **`git-push`** grant
kind (already defined in `src/grants.ts`, currently unused), not
`github-pr`. `builder` is given **no** `github-pr`-kind grant at all — so
even though `mergePR` is technically callable (visible), `decide()` finds
no matching grant for it and denies it every time. Two structurally
different grant kinds for two structurally different privileges is what
makes "can push" and "can merge" independently revocable and impossible
to conflate.

## 4. Design

### 4.1 Extending the `git-push` grant kind

`GitPushGrant` already has the right shape (`remote`, `branches`,
`secret`) but `branches` is currently **not enforced** —
`matchGrant`'s `git-push` case only checks `remote` via `globMatch`. This
spec makes `branches` real:

- `OutwardEffect` gains an optional `branch?: string` field.
- `detectOutwardEffect` gains a new case: `toolName === "pushBranch"`
  reads `input.repo`/`input.branch` and returns
  `{ kind: "git-push", description: \`push ${branch} to ${repo}\`, target: repo, branch }`.
  (The existing Bash-based `git push` detection is untouched — it still
  reports `kind: "git-push"` with no `branch`, so it only ever matches a
  grant whose `branches` isn't checked because `effect.branch` is
  `undefined`; see below.)
- `matchGrant`'s `git-push` case: after the existing `globMatch(grant.remote,
  effect.target)` check, if `effect.branch` is present, additionally
  require `grant.branches.some(pattern => globMatch(pattern, effect.branch!))`.
  If `effect.branch` is `undefined` (a raw Bash `git push`), branch
  matching is skipped — unchanged behavior for every existing caller.

This is a small, additive change: it makes the schema's `branches` field
do what it always looked like it did, without touching the Bash-detection
path any existing agent relies on.

### 4.2 The `pushBranch` tool (unconditional Gate 1 + grant Gate 2)

A new tool, added to the existing `githubPr` MCP server in
`sdk-runner.ts` (same file as `mergePR`/`postReviewComment`), registered
under an **extended** condition: `github && gitPusher` both present (see
4.3 for `gitPusher`). Input: `{ repo: string, branch: string }` — the
branch to push `HEAD` to; the tool always pushes from the run's own
workspace clone, so there's no separate "what to push" parameter.

```ts
tool(
  "pushBranch",
  "Push the current branch to a new remote branch and prepare it for a PR. Refuses any branch outside the agent/builder/ namespace, and refuses if no grant authorises pushing to the target repo.",
  { repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"'), branch: z.string().min(1) },
  async ({ repo, branch }) => {
    // Gate 1 — unconditional, same pattern as mergePR's excluded-path lock.
    // No grant, no tier, nothing below this can override it.
    if (!/^agent\/builder\//.test(branch)) {
      return { content: [{ type: "text" as const, text: `Refused: branch "${branch}" is outside the agent/builder/ namespace this tool will ever push to.` }] };
    }

    // Gate 2 — does this agent hold a git-push grant covering this repo+branch?
    const decision = decide(agent, this.deps.grants, "pushBranch", { repo, branch });
    if (decision.kind !== "allow") {
      const text = decision.kind === "park"
        ? `Refused: pushing to "${repo}" requires human approval of grant "${decision.grantRef}", which this tool cannot wait for.`
        : `Refused: no grant authorises pushing to "${repo}".`;
      return { content: [{ type: "text" as const, text }] };
    }

    const grant = this.deps.grants.find((g) => g.kind === "git-push" && g.id === decision.grantRef);
    const token = grant ? process.env[grant.secret] : undefined;
    if (!token) return { content: [{ type: "text" as const, text: `Refused: grant "${decision.grantRef}" has no ${grant?.secret} set.` }] };

    await gitPusher.push({ cwd: ctx.workspace, remoteUrl: `https://x-access-token:${token}@github.com/${repo}.git`, branch });
    return { content: [{ type: "text" as const, text: `Pushed HEAD to ${repo}:${branch}.` }] };
  },
)
```

(`ctx`/`agent`/`gitPusher` are the same closure-scoped values every other
tool in this file already uses.) Note this is the first grant kind whose
`secret` field is actually read at runtime — every existing grant kind's
`secret` is checked for well-formedness at boot only (see the `web-read`
grant's comment in `grants.yaml`). That's an intentional, narrowly-scoped
exception: `pushBranch` is also the first tool that needs a *bearer
credential* to perform its effect (`mergePR`/`postReviewComment` only
need REST calls a shared bot token already covers). No other grant kind's
runtime behavior changes.

### 4.3 `GitPusher` — the injectable push mechanism

A new small interface, `src/control/git-pusher.ts`, mirroring
`GithubTransport`'s injectable-transport shape:

```ts
export interface GitPusher {
  push(opts: { cwd: string; remoteUrl: string; branch: string }): Promise<void>;
}

export class RealGitPusher implements GitPusher {
  async push(opts: { cwd: string; remoteUrl: string; branch: string }): Promise<void> {
    // shells out: git -C <cwd> push <remoteUrl> HEAD:refs/heads/<branch>
  }
}

export class FakeGitPusher implements GitPusher {
  pushed: { cwd: string; remoteUrl: string; branch: string }[] = [];
  async push(opts: { cwd: string; remoteUrl: string; branch: string }): Promise<void> {
    this.pushed.push(opts);
  }
}
```

`SdkRunner`'s constructor deps gain one new optional field:
`gitPusher?: GitPusher`, following the exact optional-dependency shape
`github`/`tasks`/`wake` already use. `RealGitPusher` embeds the token
directly in the HTTPS remote URL passed to `git push` rather than writing
it to a credential helper or config file — it never touches disk and
never appears in `git remote -v` afterward (the URL is passed as a
one-shot push argument, not `git remote add`).

### 4.4 `openPR` — ungated, like `postReviewComment`

`GithubTransport` gains one new method:

```ts
createPullRequest(repo: string, opts: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
```

Implemented in `GithubApiTransport` (`POST /repos/{repo}/pulls`) and
`FakeGithubTransport` (records the call, returns a fake number/url).

New tool in the `githubPr` server, registered under the existing
`github`-present condition (no `gitPusher` needed — opening a PR is a
pure REST call):

```ts
tool(
  "openPR",
  "Open a pull request for a branch that was already pushed via pushBranch. Never gated: by the time this runs, the code is already public on a branch that can only ever be outside the default branch — merging, the actual point of risk, stays behind mergePR's own gates.",
  { repo: z.string(), head: z.string().min(1), base: z.string().min(1), title: z.string().min(1), body: z.string() },
  async ({ repo, head, base, title, body }) => {
    // Defense in depth, not a security boundary on its own — pushBranch
    // already refused any branch outside this namespace before code could
    // reach GitHub at all.
    if (!/^agent\/builder\//.test(head)) {
      return { content: [{ type: "text" as const, text: `Refused: "${head}" is outside the agent/builder/ namespace.` }] };
    }
    const pr = await github.createPullRequest(repo, { head, base, title, body });
    return { content: [{ type: "text" as const, text: `Opened ${pr.url}.` }] };
  },
)
```

### 4.5 The `builder` agent

`agents/builder/agent.yaml`:

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

`agents/builder/prompt.md` covers: clone the target repo fresh
(`git clone --depth 1 https://github.com/<repo>.git .` — the task text
names the repo), make the described change, run the project's existing
tests/typecheck before committing, commit, determine the real default
branch (`git symbolic-ref refs/remotes/origin/HEAD` after cloning — never
guess `main`/`master`), create a local branch under
`agent/builder/<short-slug>`, call `pushBranch`, then `openPR` against
the real default branch just determined. It explicitly never attempts
`mergePR` (not in its toolset's intended job) and never pushes to
anything outside `agent/builder/*` (enforced in code regardless).

`grants.yaml` gains:

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

**Known environmental prerequisite, checked while writing this spec:**
`git remote -v` on this repo returns nothing — it has no GitHub remote
configured at all today. That's not a gap in this design; it's a
deploy-time prerequisite outside the code, the same category as
`pr-reviewer`'s webhook needing to be added on each repo in GitHub's own
settings before that pipeline sees any event from it. The plan implements
`builder` fully against `FakeGithubTransport`/`FakeGitPusher` regardless;
actually *running* it against a real repo requires whoever deploys this
to push the repo to GitHub (or point `builder` at a different repo that's
already hosted), fill in the real `owner/repo` above, and provision
`BUILDER_PUSH_TOKEN` in `.env` the same way `GITHUB_PR_TOKEN` already is.

### 4.6 Infra: `git` CLI in the container

No existing agent runs local `git` commands — `pr-reviewer` talks to
GitHub's REST API only via `GithubApiTransport`, no local checkout.
`builder` is the first agent that needs the `git` binary and outbound
HTTPS to `github.com` inside its workspace container. The plan must check
the Dockerfile/base image for `git` and add it if absent, the same kind
of gap the standing-tasks final review caught with `docker-compose.yml`'s
missing mounts.

### 4.7 The pipeline: `research` → `builder`

`agents/research/prompt.md` gains one new closing instruction: if the
findings conclude something concrete and *implementable* is worth doing
(a code change — not a market observation or a "someone should look into
this"), call `queueTask` describing exactly what to build, which repo,
and why, instead of only writing it into the findings file.

No `Router` changes are needed. `Router.route()` already does an
LLM-based match of task text against every enabled `trigger: dispatched`
specialist's `description` (see `specialistsOf()` in `dispatcher.ts`).
Once `builder` is registered as a third dispatched specialist with its
own description, a task whose text reads like "implement X" naturally
routes to it — the same generalization that let `queueTask`'s output
reach `research` today with zero router code changes.

## 5. Data flow

```
research (dispatched) --queueTask("implement X in repo Y")--> TaskStore
  (existing dispatcher/router picks up the task; router matches "implement"
   against builder's description; routes to builder)

builder (dispatched) --clone--> workspace
  --Write/Edit/Bash(test)--> local commit
  --pushBranch(repo, "agent/builder/<slug>")--> Gate 1 (branch regex) -->
    Gate 2 (git-push grant: remote + branches match) --> RealGitPusher.push()
  --openPR(repo, head, base, title, body)--> GithubTransport.createPullRequest()

(existing, unchanged) pr-reviewer webhook fires on the new PR
  --review--> mergePR (excluded-path lock, grant check, head-SHA check)
```

## 6. Testing

- `grants.ts`: `detectOutwardEffect("pushBranch", {...})` produces a
  `git-push` effect with the right `target`/`branch`; `matchGrant`'s
  extended branch check accepts a matching pattern and rejects a
  non-matching one; a raw Bash `git push` effect (no `branch`) is
  unaffected by the branches check either way.
- `sdk-runner`: `pushBranch` registered only when `github` **and**
  `gitPusher` are both present; refuses any branch outside
  `agent/builder/*` even when a permissive grant would otherwise allow
  it (Gate 1 is unconditional); allows a push when tier/approval/grant
  all line up, using `FakeGitPusher` to assert the exact push args
  without touching real git or network; denies when `builder` (or any
  agent) holds no matching `git-push` grant; confirms `builder` calling
  `mergePR` is denied even after a successful `pushBranch` (the
  cross-authorization gap this spec exists to close) — this is the single
  most important test in this plan.
- `openPR`: registered whenever `github` is present (independent of
  `gitPusher`); refuses a `head` outside the namespace; calls
  `GithubTransport.createPullRequest` with the right args otherwise.
- `GithubApiTransport`/`FakeGithubTransport`: `createPullRequest` unit
  tests mirroring the existing `postReviewComment`/`mergePullRequest`
  coverage style.
- Registry/schema validation: `agents/builder/agent.yaml` loads cleanly
  through the existing `loadRegistry`/grant-ref-validation path, and
  `grants.yaml`'s new `builder-push` entry parses under the existing
  `GrantSchema`.

## 7. Global Constraints (for the implementation plan)

- Branch namespace: `agent/builder/` prefix, enforced unconditionally in
  both `pushBranch` and `openPR`, never bypassable by any grant.
- `builder` never receives a `github-pr`-kind grant — pushing is
  authorized exclusively via the (now-enforced) `git-push` kind, kept
  structurally separate from merge authorization.
- `pushBranch`'s `secret` env var is read at runtime to build the push
  URL — this is the one grant-kind exception to "secret is boot-checked
  only"; no other grant kind's runtime behavior changes.
- `openPR` and `postReviewComment` are ungated; `mergePR` and `pushBranch`
  are gated (unconditional check + grant check, in that order).
- Each `builder` run clones fresh; no persistent checkout across runs.
