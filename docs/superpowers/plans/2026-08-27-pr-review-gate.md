# PR Review-and-Merge Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let code changes merge to `main` with zero human review for the
general case, while a fixed set of security-sensitive files can never merge
through this pipeline under any verdict — enforced by two independent
mechanisms, not a human decision point.

**Architecture:** A new `webhook` trigger type (sibling to the existing
`cron`) fires the `pr-reviewer` agent — an ordinary agent under the existing
Governor/tier/grant machinery — when GitHub reports a PR's CI has gone green.
Two new MCP tools (`mergePR`, `postReviewComment`, mirroring the existing
`AskHuman` tool's shape) give it a way to act on GitHub; `mergePR` is grant-gated
through the same `decide()` engine every other outward effect uses, and is
preceded by a hard, non-bypassable path-exclusion check that no grant or
review verdict can override. The review itself is the agent's own prompted
reasoning (using the existing `Task` tool for sub-review angles), not new
orchestration code — this system already runs one agent per triggered run,
and that's sufficient for a thorough, self-adversarial review without
inventing a parallel execution model.

**Tech Stack:** Same as Plan A/B (Node 24, TypeScript, ESM, zod 4, vitest),
plus Node's built-in `node:http`/`node:crypto` for the webhook receiver and
signature verification (no new HTTP framework needed for one small,
internal-only endpoint).

**Spec:** [`docs/superpowers/specs/2026-08-27-pr-review-gate-design.md`](../specs/2026-08-27-pr-review-gate-design.md)

## Global Constraints

- Everything in Plan A/B's Global Constraints still applies verbatim: Node
  `>=24`, ESM with `.js` import extensions, exact model ID strings, IANA
  timezone names only, no colons in filenames, validation errors name the
  offending path/received value/fix, all configuration validated at boot.
- New modules follow the established conventions exactly: `ValidationError`
  / `formatZodError` from `src/errors.ts` for every validation failure; zod
  schemas use `.strict()`; tests that touch the filesystem use
  `mkdtempSync(join(tmpdir(), "cai-<thing>-"))`, never a fixed path.
- **The excluded-path set is exact and fixed for this plan:** `src/governor.ts`,
  `src/grants.ts`, `src/agent-schema.ts`, `src/control/bot.ts`, `grants.yaml`,
  and the `governor:` key of `config.yaml`. A PR touching any of these never
  merges through this pipeline under any circumstance — this check runs
  before the grant/review machinery even starts, and nothing later in the
  pipeline can override it.
- **`mergePR` only ever executes when three things are simultaneously true:**
  the excluded-path check passes, the PR's current head SHA still matches
  what was reviewed, and `decide()` resolves to `allow`. All three are
  re-checked inside the tool call itself, not trusted from an earlier step.
- No real GitHub repo exists yet for this project. Tasks that need one
  (Milestone B's live dry run) are explicit about that prerequisite; nothing
  in Milestone A requires it — `FakeGithubTransport` carries the whole test
  suite.

---

## Milestone A — Foundations (schema, transport, tools, wiring)

After Task 9, the whole pipeline is wired and tested end-to-end against
`FakeGithubTransport`: a webhook event triggers a run, an excluded-path PR is
mechanically refused, a clean PR reaches the point where `mergePR` would
succeed. No real GitHub repo, no real network calls anywhere in this
milestone's tests.

### Task 1: `WebhookTrigger` schema — `trigger` becomes a discriminated union

**Files:**
- Modify: `src/agent-schema.ts`
- Modify: `src/registry.ts`
- Modify: `src/triggers/cron.ts`
- Test: `tests/agent-schema.test.ts` (or wherever `CronTrigger`/`AgentSchema` is
  currently tested — check for the existing file before creating a new one)
- Test: `tests/registry.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentSchema.trigger` is now `z.discriminatedUnion("type", [CronTrigger, WebhookTrigger])`; exported `WebhookTrigger` schema; `AgentYaml["trigger"]`'s type narrows on `.type` at every existing call site.

- [ ] **Step 1: Write the failing test**

Find the existing test file covering `AgentSchema`/`parseAgent` (it's
`tests/registry.test.ts` if no dedicated schema test file exists — check with
`grep -rl "CronTrigger\|parseAgent" tests/` before writing). Add:

```ts
  it("accepts a webhook trigger, naming the repo and event it binds to", () => {
    const yaml = AGENT.replace(
      /trigger:\n {2}type: cron\n {2}schedule: .*\n {2}timezone: .*\n/,
      'trigger:\n  type: webhook\n  repo: "owner/repo"\n  event: pull_request\n',
    );
    expect(() => parseAgent("agent.yaml", yaml)).not.toThrow();
    const agent = parseAgent("agent.yaml", yaml);
    expect(agent.trigger).toEqual({ type: "webhook", repo: "owner/repo", event: "pull_request" });
  });

  it("rejects a webhook trigger with a malformed repo (must be owner/name)", () => {
    const yaml = AGENT.replace(
      /trigger:\n {2}type: cron\n {2}schedule: .*\n {2}timezone: .*\n/,
      'trigger:\n  type: webhook\n  repo: "not-a-repo-slug"\n  event: pull_request\n',
    );
    expect(() => parseAgent("agent.yaml", yaml)).toThrow(/repo/);
  });
```

Check the file's existing `AGENT` fixture string for its exact `trigger:`
block formatting before writing the `.replace(...)` regex above — match
whatever indentation/fields it actually uses rather than assuming.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/registry.test.ts` (or the correct file from Step 1)
Expected: FAIL — `trigger.type: "webhook"` is rejected by the current
`z.literal("cron")`-only schema.

- [ ] **Step 3: Add `WebhookTrigger` to `src/agent-schema.ts`**

Directly below the existing `CronTrigger` definition:

```ts
const WebhookTrigger = z
  .object({
    type: z.literal("webhook"),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"'),
    event: z.literal("pull_request"),
  })
  .strict();
```

Change the `trigger` field in `AgentSchema`'s object from:

```ts
    trigger: CronTrigger,
```

to:

```ts
    trigger: z.discriminatedUnion("type", [CronTrigger, WebhookTrigger]),
```

- [ ] **Step 4: Update `src/registry.ts`'s boot validation to be trigger-type-aware**

Read `src/registry.ts` in full first — the current cron-schedule validation
(around the `schedule`/`timezone` extraction and the `isValidCron(...)` check)
unconditionally assumes every agent has `trigger.schedule`/`trigger.timezone`.
Change the extraction so it only pulls/validates those fields when the
trigger is (or claims to be, for the raw-YAML fallback path used when zod
parsing already failed) a cron trigger:

```ts
    const rawTrigger = raw["trigger"] as Record<string, unknown> | undefined;
    const triggerType = agent?.trigger.type ?? asString(rawTrigger?.["type"]);
    const schedule = agent?.trigger.type === "cron" ? agent.trigger.schedule : asString(rawTrigger?.["schedule"]);
    const timezone = agent?.trigger.type === "cron" ? agent.trigger.timezone : asString(rawTrigger?.["timezone"]);
```

Guard the existing `isValidCron(...)` check so it only runs when
`triggerType === "cron"` (a webhook trigger has no schedule/timezone to
validate this way):

```ts
    if (triggerType === "cron" && schedule !== undefined && timezone !== undefined && !isValidCron(schedule, timezone)) {
      lines.push(
        `trigger.schedule: "${schedule}" is not a valid cron expression. Use five or six fields (croner also accepts a leading seconds field), e.g. "0 7 * * *" for 07:00 daily`,
      );
    }
```

- [ ] **Step 5: Update `src/triggers/cron.ts` to skip non-cron agents**

```ts
  for (const agent of agents) {
    if (!agent.enabled) {
      console.log(`[cron] ${agent.name} is disabled; not scheduled`);
      continue;
    }
    if (agent.trigger.type !== "cron") continue;
    const job = new Cron(
      agent.trigger.schedule,
```

(The rest of the function is unchanged — `agent.trigger.schedule`/`.timezone`
below this point are now type-narrowed safely by the `if` above, no cast
needed.)

- [ ] **Step 6: Run the test to verify it passes, then the full suite**

Run: `npm test -- tests/registry.test.ts && npm run typecheck && npm test`
Expected: all pass. The `trigger.type !== "cron"` narrowing in `cron.ts`
should make `agent.trigger.schedule` typecheck without a cast — if it
doesn't, the discriminated union isn't set up correctly; fix before moving
on rather than casting around it.

- [ ] **Step 7: Regenerate schema artifacts and commit**

```bash
npm run schema
git add src/agent-schema.ts src/registry.ts src/triggers/cron.ts schema tests/registry.test.ts
git commit -m "feat: webhook trigger type alongside cron"
```

---

### Task 2: `GithubPrGrant` schema

**Files:**
- Modify: `src/grants.ts`
- Test: `tests/grants.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GrantSchema` discriminated union gains a `github-pr` variant; `Grant` type includes it.

- [ ] **Step 1: Write the failing test**

Append to `tests/grants.test.ts`:

```ts
  it("parses a github-pr grant", () => {
    const grants = parseGrants(
      "grants.yaml",
      "grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: [owner/repo]\n    secret: GITHUB_PR_TOKEN\n",
    );
    expect(grants[0]).toMatchObject({ kind: "github-pr", repos: ["owner/repo"] });
  });

  it("rejects a github-pr grant with an empty repos list", () => {
    const yaml = "grants:\n  - id: infra-repo\n    kind: github-pr\n    repos: []\n    secret: GITHUB_PR_TOKEN\n";
    expect(() => parseGrants("grants.yaml", yaml)).toThrow();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/grants.test.ts`
Expected: FAIL — `kind: "github-pr"` doesn't match any variant of
`GrantSchema`.

- [ ] **Step 3: Add `GithubPrGrant` to `src/grants.ts`**

Directly below the existing `ProvisionGrant` definition:

```ts
const GithubPrGrant = z
  .object({
    id: z.string().min(1),
    kind: z.literal("github-pr"),
    repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"')).min(1),
    secret: z.string().min(1),
  })
  .strict();
```

Change:

```ts
export const GrantSchema = z.discriminatedUnion("kind", [HttpGrant, GitPushGrant, ProvisionGrant]);
```

to:

```ts
export const GrantSchema = z.discriminatedUnion("kind", [HttpGrant, GitPushGrant, ProvisionGrant, GithubPrGrant]);
```

`grantTargetPattern` (used by `matchGrant`) has a `switch (grant.kind)` over
the same union — add the new case so it stays exhaustive (TypeScript will
already flag this as a compile error via the missing-case check once the
union grows, so this step is required to typecheck, not optional polish).
A `github-pr` grant's `repos` field is a *list* to check membership against,
not a single glob pattern the way `urlPattern`/`remote`/`scope` are for the
other three kinds — `matchGrant` gets a repo-membership branch for this kind
in Task 7 (where the calling code that needs it is added), so this case
just needs to compile cleanly without being reachable through the normal
`globMatch` path:

```ts
    case "github-pr":
      // Not matched via globMatch — matchGrant (extended in Task 7) checks
      // grant.repos.includes(effect.target) directly for this kind. This
      // case exists only so the switch stays exhaustive.
      return "";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/grants.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/grants.ts tests/grants.test.ts
git commit -m "feat: github-pr grant kind"
```

---

### Task 3: Sensitive-path exclusion check (Wall 1)

**Files:**
- Create: `src/control/excluded-paths.ts`
- Test: `tests/excluded-paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: exported `EXCLUDED_PATHS: readonly string[]`; exported `touchesExcludedPath(changedFiles: string[]): boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/excluded-paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EXCLUDED_PATHS, touchesExcludedPath } from "../src/control/excluded-paths.js";

describe("touchesExcludedPath", () => {
  it("flags a change to any exact excluded path", () => {
    for (const path of EXCLUDED_PATHS) {
      expect(touchesExcludedPath([path])).toBe(true);
    }
  });

  it("flags a change when the excluded path is one of several changed files", () => {
    expect(touchesExcludedPath(["README.md", "src/governor.ts", "package.json"])).toBe(true);
  });

  it("does not flag an unrelated set of changed files", () => {
    expect(touchesExcludedPath(["README.md", "src/index.ts", "tests/foo.test.ts"])).toBe(false);
  });

  it("does not flag a path that merely contains an excluded filename as a substring", () => {
    // src/governor.ts is excluded; a differently-named file must not match by accident.
    expect(touchesExcludedPath(["src/governor.test.helpers.ts"])).toBe(false);
  });

  it("the excluded set names exactly the files this plan specifies", () => {
    expect(EXCLUDED_PATHS).toEqual([
      "src/governor.ts",
      "src/grants.ts",
      "src/agent-schema.ts",
      "src/control/bot.ts",
      "grants.yaml",
      "config.yaml",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/excluded-paths.test.ts`
Expected: FAIL — cannot resolve `../src/control/excluded-paths.js`.

- [ ] **Step 3: Write `src/control/excluded-paths.ts`**

```ts
/**
 * Files that define the rules constraining every agent in this system. A PR
 * touching any of these can never merge through the automated review-gate
 * pipeline, no matter what a review concludes — this is a static, mechanical
 * exclusion, not a judgment call any agent or review makes. See
 * docs/superpowers/specs/2026-08-27-pr-review-gate-design.md §3 (Lock 4).
 *
 * `config.yaml` is excluded whole rather than just its `governor:` key: a
 * line-range check inside one file is fragile against reformatting, and
 * nothing else in config.yaml is sensitive enough to be worth that risk for
 * the rare case an automated PR would want to touch it at all.
 */
export const EXCLUDED_PATHS: readonly string[] = [
  "src/governor.ts",
  "src/grants.ts",
  "src/agent-schema.ts",
  "src/control/bot.ts",
  "grants.yaml",
  "config.yaml",
];

export function touchesExcludedPath(changedFiles: string[]): boolean {
  return changedFiles.some((f) => EXCLUDED_PATHS.includes(f));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/excluded-paths.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/control/excluded-paths.ts tests/excluded-paths.test.ts
git commit -m "feat: sensitive-path exclusion check (Wall 1)"
```

---

### Task 4: `GithubTransport` interface and `FakeGithubTransport`

**Files:**
- Create: `src/control/github-transport.ts`
- Test: `tests/github-transport.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `interface PullRequestInfo { number: number; repo: string; headSha: string; changedFiles: string[]; diff: string; title: string; body: string }`; `interface GithubTransport { getPullRequest(repo: string, number: number): Promise<PullRequestInfo>; postReviewComment(repo: string, number: number, body: string): Promise<void>; mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<{ merged: true } | { merged: false; reason: string }> }`; class `FakeGithubTransport implements GithubTransport` (test double, exported alongside the real one for reuse in later tests — mirrors `FakeBotTransport`'s role exactly).

- [ ] **Step 1: Write the failing test**

Create `tests/github-transport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeGithubTransport } from "../src/control/github-transport.js";

function pr(overrides: Partial<Parameters<FakeGithubTransport["seedPullRequest"]>[0]> = {}) {
  return {
    number: 1,
    repo: "owner/repo",
    headSha: "abc123",
    changedFiles: ["src/index.ts"],
    diff: "diff --git a/src/index.ts b/src/index.ts\n+// change",
    title: "A small change",
    body: "Does a small thing.",
    ...overrides,
  };
}

describe("FakeGithubTransport", () => {
  it("returns a seeded pull request", async () => {
    const t = new FakeGithubTransport();
    t.seedPullRequest(pr());
    const info = await t.getPullRequest("owner/repo", 1);
    expect(info).toMatchObject({ number: 1, headSha: "abc123", changedFiles: ["src/index.ts"] });
  });

  it("throws a clear error for an unseeded pull request", async () => {
    const t = new FakeGithubTransport();
    await expect(t.getPullRequest("owner/repo", 999)).rejects.toThrow(/999/);
  });

  it("records posted review comments", async () => {
    const t = new FakeGithubTransport();
    t.seedPullRequest(pr());
    await t.postReviewComment("owner/repo", 1, "Looks fine.");
    expect(t.postedComments).toEqual([{ repo: "owner/repo", number: 1, body: "Looks fine." }]);
  });

  it("merges when the expected SHA matches the current head", async () => {
    const t = new FakeGithubTransport();
    t.seedPullRequest(pr({ headSha: "abc123" }));
    const result = await t.mergePullRequest("owner/repo", 1, "abc123");
    expect(result).toEqual({ merged: true });
    expect(t.merged).toEqual([{ repo: "owner/repo", number: 1 }]);
  });

  it("refuses to merge when the expected SHA is stale", async () => {
    const t = new FakeGithubTransport();
    t.seedPullRequest(pr({ headSha: "new-commit-sha" }));
    const result = await t.mergePullRequest("owner/repo", 1, "abc123");
    expect(result).toEqual({ merged: false, reason: expect.stringContaining("head") });
    expect(t.merged).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/github-transport.test.ts`
Expected: FAIL — cannot resolve `../src/control/github-transport.js`.

- [ ] **Step 3: Write `src/control/github-transport.ts`**

```ts
export interface PullRequestInfo {
  number: number;
  repo: string;
  headSha: string;
  changedFiles: string[];
  diff: string;
  title: string;
  body: string;
}

export type MergeResult = { merged: true } | { merged: false; reason: string };

export interface GithubTransport {
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  postReviewComment(repo: string, number: number, body: string): Promise<void>;
  /** Refuses (merged: false) rather than merging if the PR's current head has moved past expectedHeadSha. */
  mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<MergeResult>;
}

/** Test double: lets a test seed PR state and inspect what was posted/merged, with no real GitHub calls. */
export class FakeGithubTransport implements GithubTransport {
  postedComments: { repo: string; number: number; body: string }[] = [];
  merged: { repo: string; number: number }[] = [];
  private pulls = new Map<string, PullRequestInfo>();

  private key(repo: string, number: number): string {
    return `${repo}#${number}`;
  }

  seedPullRequest(info: PullRequestInfo): void {
    this.pulls.set(this.key(info.repo, info.number), info);
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
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/github-transport.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/control/github-transport.ts tests/github-transport.test.ts
git commit -m "feat: GithubTransport interface and fake for tests"
```

---

### Task 5: Webhook signature verification

**Files:**
- Create: `src/control/webhook-signature.ts`
- Test: `tests/webhook-signature.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: exported `verifyGithubSignature(payload: string, signatureHeader: string | undefined, secret: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/webhook-signature.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGithubSignature } from "../src/control/webhook-signature.js";

function sign(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("verifyGithubSignature", () => {
  it("accepts a correctly signed payload", () => {
    const payload = '{"action":"opened"}';
    expect(verifyGithubSignature(payload, sign(payload, "shhh"), "shhh")).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const payload = '{"action":"opened"}';
    const signature = sign(payload, "shhh");
    expect(verifyGithubSignature('{"action":"closed"}', signature, "shhh")).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const payload = '{"action":"opened"}';
    expect(verifyGithubSignature(payload, sign(payload, "wrong-secret"), "shhh")).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyGithubSignature('{"action":"opened"}', undefined, "shhh")).toBe(false);
  });

  it("rejects a malformed signature header (no sha256= prefix)", () => {
    expect(verifyGithubSignature('{"action":"opened"}', "not-a-real-signature", "shhh")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/webhook-signature.test.ts`
Expected: FAIL — cannot resolve `../src/control/webhook-signature.js`.

- [ ] **Step 3: Write `src/control/webhook-signature.ts`**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies GitHub's `X-Hub-Signature-256` header. Uses a constant-time
 * comparison (`timingSafeEqual`) rather than `===` — a naive string compare
 * leaks timing information an attacker could use to guess the correct
 * signature byte by byte, defeating the point of signing in the first place.
 */
export function verifyGithubSignature(payload: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/webhook-signature.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/control/webhook-signature.ts tests/webhook-signature.test.ts
git commit -m "feat: GitHub webhook signature verification"
```

---

### Task 6: Webhook receiver (HTTP server)

**Files:**
- Create: `src/control/webhook-receiver.ts`
- Test: `tests/webhook-receiver.test.ts`

**Interfaces:**
- Consumes: `verifyGithubSignature` (Task 5).
- Produces: `interface WebhookEvent { repo: string; event: "pull_request"; action: string; pullRequestNumber: number }`; class `WebhookReceiver` constructed as `new WebhookReceiver(opts: { secret: string })`, methods `onEvent(handler: (event: WebhookEvent) => Promise<void>): void`, `handleRequest(rawBody: string, signatureHeader: string | undefined): Promise<{ status: number; body: string }>` (pure — takes the raw body/header, returns what an HTTP layer should respond with; this task does NOT stand up `node:http` itself, so it's testable with zero real sockets), `listen(port: number): Promise<void>`, `close(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `tests/webhook-receiver.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WebhookReceiver } from "../src/control/webhook-receiver.js";

const SECRET = "test-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function prOpenedPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "opened",
    number: 42,
    repository: { full_name: "owner/repo" },
    ...overrides,
  });
}

describe("WebhookReceiver.handleRequest", () => {
  it("calls the registered handler for a validly signed pull_request event", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    const handler = vi.fn().mockResolvedValue(undefined);
    receiver.onEvent(handler);

    const body = prOpenedPayload();
    const result = await receiver.handleRequest(body, sign(body));

    expect(result.status).toBe(202);
    expect(handler).toHaveBeenCalledWith({ repo: "owner/repo", event: "pull_request", action: "opened", pullRequestNumber: 42 });
  });

  it("rejects a request with a bad signature and never calls the handler", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    const handler = vi.fn();
    receiver.onEvent(handler);

    const result = await receiver.handleRequest(prOpenedPayload(), "sha256=wrong");

    expect(result.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores an unrelated action without erroring, and does not call the handler", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    const handler = vi.fn();
    receiver.onEvent(handler);

    const body = prOpenedPayload({ action: "labeled" });
    const result = await receiver.handleRequest(body, sign(body));

    expect(result.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body without throwing", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    const body = "not json";
    await expect(receiver.handleRequest(body, sign(body))).resolves.toMatchObject({ status: 400 });
  });

  it("does not let a handler rejection crash the request", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    receiver.onEvent(async () => {
      throw new Error("boom");
    });
    const body = prOpenedPayload();
    const result = await receiver.handleRequest(body, sign(body));
    expect(result.status).toBe(202);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/webhook-receiver.test.ts`
Expected: FAIL — cannot resolve `../src/control/webhook-receiver.js`.

- [ ] **Step 3: Write `src/control/webhook-receiver.ts`**

```ts
import { createServer, type Server } from "node:http";
import { verifyGithubSignature } from "./webhook-signature.js";

export interface WebhookEvent {
  repo: string;
  event: "pull_request";
  action: string;
  pullRequestNumber: number;
}

const RELEVANT_ACTIONS: ReadonlySet<string> = new Set(["opened", "synchronize", "reopened"]);

export class WebhookReceiver {
  private readonly secret: string;
  private handler: ((event: WebhookEvent) => Promise<void>) | null = null;
  private server: Server | null = null;

  constructor(opts: { secret: string }) {
    this.secret = opts.secret;
  }

  onEvent(handler: (event: WebhookEvent) => Promise<void>): void {
    this.handler = handler;
  }

  /**
   * Pure request handling, deliberately separate from the `node:http` layer
   * below — this is what makes the whole receiver testable with zero real
   * sockets. `listen()` is a thin adapter on top of this.
   */
  async handleRequest(rawBody: string, signatureHeader: string | undefined): Promise<{ status: number; body: string }> {
    if (!verifyGithubSignature(rawBody, signatureHeader, this.secret)) {
      return { status: 401, body: "invalid signature" };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return { status: 400, body: "invalid JSON" };
    }

    const action = typeof payload.action === "string" ? payload.action : "";
    const repo = (payload.repository as Record<string, unknown> | undefined)?.full_name;
    const number = payload.number;

    if (!RELEVANT_ACTIONS.has(action) || typeof repo !== "string" || typeof number !== "number") {
      return { status: 200, body: "ignored" };
    }

    const event: WebhookEvent = { repo, event: "pull_request", action, pullRequestNumber: number };

    // Never let a handler failure become an unhandled rejection or a 500
    // that makes GitHub retry-storm an already-processing event — the run's
    // own failure handling (Governor, breaker) is the right place for that,
    // not this HTTP layer.
    void this.handler?.(event).catch((err: unknown) => {
      console.error(`[webhook] handler failed for ${repo}#${number}`, err);
    });

    return { status: 202, body: "accepted" };
  }

  async listen(port: number): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void this.handleRequest(Buffer.concat(chunks).toString("utf8"), req.headers["x-hub-signature-256"] as string | undefined).then(
          ({ status, body }) => {
            res.writeHead(status, { "content-type": "text/plain" });
            res.end(body);
          },
        );
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, resolve));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/webhook-receiver.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/control/webhook-receiver.ts tests/webhook-receiver.test.ts
git commit -m "feat: GitHub webhook receiver with signature verification"
```

---

### Task 7: `mergePR` MCP tool — the three-gate merge path

**Files:**
- Modify: `src/runner/sdk-runner.ts`
- Test: `tests/sdk-runner-options.test.ts` (extend)

**Interfaces:**
- Consumes: `touchesExcludedPath` (Task 3), `GithubTransport` (Task 4), `decide` from `src/grants.ts`.
- Produces: `SdkRunner`'s constructor dependency object gains `github?: GithubTransport` (optional — only agents that need it pass one; every existing test/agent that doesn't use GitHub tools is unaffected); a new `mergePR` MCP tool registered alongside `AskHuman` whenever `github` is provided.

- [ ] **Step 1: Write the failing test**

Read `src/runner/sdk-runner.ts` in full first — this task adds to the same
`SdkRunner` class Plan B's Task 12 built, so match its actual current shape
(the `canUseTool`/`AskHuman` pattern, the `deps` constructor field, the
`ctx`/`terminalEvent`/`sessionIdPromise` closures) rather than assuming.

Append to `tests/sdk-runner-options.test.ts`, in a new `describe` block:

```ts
import { FakeGithubTransport } from "../src/control/github-transport.js";

describe("SdkRunner mergePR tool", () => {
  function granted(repos: string[] = ["owner/repo"]) {
    return { ...AGENT, tier: "autonomous", approval: "auto", grantRefs: ["infra-repo"] } as unknown as AgentDef;
  }
  const GITHUB_PR_GRANT: Grant = { id: "infra-repo", kind: "github-pr", repos: ["owner/repo"], secret: "X" };

  it("passes the mergePR MCP tool's server when a GithubTransport is provided", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(new SdkRunner({ grants: [GITHUB_PR_GRANT], pending: new PendingStore(dir), github }).execute(granted(), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as { options: { mcpServers: Record<string, unknown> } };
    expect(params.options.mcpServers.githubPr).toBeDefined();
  });

  it("merges when the repo is granted, the SHA matches, and the path isn't excluded", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    github.seedPullRequest({ number: 1, repo: "owner/repo", headSha: "sha-1", changedFiles: ["src/index.ts"], diff: "", title: "t", body: "b" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [GITHUB_PR_GRANT], pending: new PendingStore(dir), github });
    await collect(runner.execute(granted(), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as { options: { mcpServers: { githubPr: { tools: { name: string; handler: (input: unknown) => Promise<unknown> }[] } } } };
    const mergeTool = params.options.mcpServers.githubPr.tools.find((t) => t.name === "mergePR")!;

    const result = await mergeTool.handler({ repo: "owner/repo", number: 1, expectedHeadSha: "sha-1", changedFiles: ["src/index.ts"] });

    expect(github.merged).toEqual([{ repo: "owner/repo", number: 1 }]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("merged") }] });
  });

  it("refuses to merge a PR touching an excluded path, without ever calling GithubTransport.mergePullRequest", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    github.seedPullRequest({ number: 1, repo: "owner/repo", headSha: "sha-1", changedFiles: ["src/governor.ts"], diff: "", title: "t", body: "b" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [GITHUB_PR_GRANT], pending: new PendingStore(dir), github });
    await collect(runner.execute(granted(), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as { options: { mcpServers: { githubPr: { tools: { name: string; handler: (input: unknown) => Promise<unknown> }[] } } } };
    const mergeTool = params.options.mcpServers.githubPr.tools.find((t) => t.name === "mergePR")!;

    const result = await mergeTool.handler({ repo: "owner/repo", number: 1, expectedHeadSha: "sha-1", changedFiles: ["src/governor.ts"] });

    expect(github.merged).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/excluded|sensitive/i) }] });
  });

  it("refuses to merge when the current head SHA has moved past what was reviewed", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    github.seedPullRequest({ number: 1, repo: "owner/repo", headSha: "newer-sha", changedFiles: ["src/index.ts"], diff: "", title: "t", body: "b" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [GITHUB_PR_GRANT], pending: new PendingStore(dir), github });
    await collect(runner.execute(granted(), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as { options: { mcpServers: { githubPr: { tools: { name: string; handler: (input: unknown) => Promise<unknown> }[] } } } };
    const mergeTool = params.options.mcpServers.githubPr.tools.find((t) => t.name === "mergePR")!;

    const result = await mergeTool.handler({ repo: "owner/repo", number: 1, expectedHeadSha: "sha-1", changedFiles: ["src/index.ts"] });

    expect(github.merged).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/head|sha/i) }] });
  });

  it("refuses to merge a repo the agent has no matching grant for", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    github.seedPullRequest({ number: 1, repo: "owner/other-repo", headSha: "sha-1", changedFiles: ["src/index.ts"], diff: "", title: "t", body: "b" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [GITHUB_PR_GRANT], pending: new PendingStore(dir), github });
    await collect(runner.execute(granted(), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as { options: { mcpServers: { githubPr: { tools: { name: string; handler: (input: unknown) => Promise<unknown> }[] } } } };
    const mergeTool = params.options.mcpServers.githubPr.tools.find((t) => t.name === "mergePR")!;

    const result = await mergeTool.handler({ repo: "owner/other-repo", number: 1, expectedHeadSha: "sha-1", changedFiles: ["src/index.ts"] });

    expect(github.merged).toEqual([]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/grant/i) }] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/sdk-runner-options.test.ts`
Expected: FAIL — `SdkRunner`'s constructor doesn't accept `github`; no
`githubPr` mcpServer exists.

- [ ] **Step 3: Implement in `src/runner/sdk-runner.ts`**

Add `github?: GithubTransport` to the `deps` constructor parameter's type
(alongside the existing `grants`/`pending` fields — read the current
constructor signature first and extend it, don't replace it). Import what's
needed:

```ts
import { touchesExcludedPath } from "../control/excluded-paths.js";
import type { GithubTransport } from "../control/github-transport.js";
```

Inside `execute()`, alongside the existing `askHumanServer` construction
(same location, same pattern — read that block first), add a second MCP
server, only when `this.deps.github` is present:

```ts
    const githubPrServer = this.deps.github
      ? createSdkMcpServer({
          name: "githubPr",
          tools: [
            tool(
              "mergePR",
              "Merge a pull request that has passed review. Only succeeds if the repo is granted, the diff doesn't touch a security-sensitive path, and the PR's head hasn't moved since you reviewed it.",
              {
                repo: z.string(),
                number: z.number().int().positive(),
                expectedHeadSha: z.string().min(1),
                changedFiles: z.array(z.string()),
              },
              async ({ repo, number, expectedHeadSha, changedFiles }) => {
                // Gate 1 — the excluded-path check. This runs first and
                // unconditionally: no grant, no review verdict, nothing
                // later in this handler can override it.
                if (touchesExcludedPath(changedFiles)) {
                  return {
                    content: [{ type: "text", text: `Refused: this PR touches a security-sensitive excluded path and can never merge through this pipeline. Changes to that code must be made directly by a human, outside this pipeline.` }],
                  };
                }

                // Gate 2 — does this agent hold a github-pr grant covering this repo?
                const decision = decide(agent, this.deps.grants, "mergePR", { repo });
                if (decision.kind !== "allow") {
                  return {
                    content: [{ type: "text", text: `Refused: no grant authorises merging pull requests in "${repo}".` }],
                  };
                }

                // Gate 3 — has a newer commit landed since this PR was reviewed?
                const result = await this.deps.github!.mergePullRequest(repo, number, expectedHeadSha);
                if (!result.merged) {
                  return { content: [{ type: "text", text: `Refused: ${result.reason}` }] };
                }
                return { content: [{ type: "text", text: `Merged ${repo}#${number}.` }] };
              },
            ),
          ],
        })
      : undefined;
```

Add it to the `mcpServers` option object alongside `askHuman` (read the
current `mcpServers: { askHuman: askHumanServer }` line and extend it):

```ts
        mcpServers: { askHuman: askHumanServer, ...(githubPrServer ? { githubPr: githubPrServer } : {}) },
```

**Note on Gate 2's `decide()` call:** `detectOutwardEffect` doesn't recognise
a bare `toolName: "mergePR"` — that's intentional. `decide()`'s tier/grant
logic (readonly/sandboxed always deny, grant-id must be in `agent.grantRefs`,
autonomous+auto resolves to allow) is exactly what's needed here and is
reused as-is; only the *effect detection* half (`detectOutwardEffect`, which
exists to infer intent from a free-form Bash string) doesn't apply, because
this tool already knows its own intent structurally. Since `decide()` calls
`detectOutwardEffect` internally and that returns `null` for an unrecognised
tool name, add one more case to `detectOutwardEffect` in `src/grants.ts` so
`decide()` produces a real decision here rather than falling through to its
"no effect detected → allow" default (which would make Gate 2 a no-op):

```ts
  if (toolName === "mergePR") {
    const repo = typeof input.repo === "string" ? input.repo : "";
    return repo ? { kind: "github-pr", description: `merge PR in ${repo}`, target: repo } : null;
  }
```

Add this alongside the existing `if (toolName === "WebFetch")` block in
`detectOutwardEffect`. Because `matchGrant` already checks `grant.kind`
against `effect.kind` (Plan B's final fix wave), this now correctly matches
only against `github-pr` grants, and `grantTargetPattern`'s new
`case "github-pr": return grant.repos.join(",")` (Task 2) needs to actually
be checked per-repo rather than as a joined string for `globMatch` to work
correctly — read `matchGrant`'s current implementation and adjust
`grantTargetPattern`'s `github-pr` case to properly test membership:

```ts
    case "github-pr":
      // globMatch expects one pattern string; a repo-list grant instead
      // checks direct membership, handled as a special case in matchGrant
      // itself rather than forcing repos into a single glob pattern.
      return "";
```

In `matchGrant`, add a repo-membership branch before the generic `globMatch`
call — this is the one place `grant.repos` is actually checked (Task 2's
`grantTargetPattern` case for `github-pr` deliberately returns `""` and is
never reached for this kind; read the current `matchGrant` implementation
first and adapt precisely — the shape below assumes the structure already
established in Plan B, adjust to match what's actually there):

```ts
export function matchGrant(grants: Grant[], effect: OutwardEffect): Grant | null {
  return (
    grants.find((g) => {
      if (g.kind !== effect.kind) return false;
      if (g.kind === "github-pr") return g.repos.includes(effect.target);
      return globMatch(grantTargetPattern(g), effect.target);
    }) ?? null
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/sdk-runner-options.test.ts tests/grants.test.ts`
Expected: PASS, all tests including the 6 new ones.

- [ ] **Step 5: Run the full suite, typecheck, commit**

```bash
npm run typecheck && npm test
git add src/runner/sdk-runner.ts src/grants.ts tests/sdk-runner-options.test.ts
git commit -m "feat: mergePR tool — the three-gate merge path (excluded-path, grant, stale-SHA)"
```

---

### Task 8: `postReviewComment` MCP tool

**Files:**
- Modify: `src/runner/sdk-runner.ts`
- Test: `tests/sdk-runner-options.test.ts` (extend)

**Interfaces:**
- Consumes: `GithubTransport` (Task 4).
- Produces: `postReviewComment` tool registered in the same `githubPr` MCP server built in Task 7.

- [ ] **Step 1: Write the failing test**

Append to the `describe("SdkRunner mergePR tool", ...)` block from Task 7
(or rename it to `"SdkRunner GitHub PR tools"` now that it covers two tools —
your judgment, either is fine as long as the tests are grouped sensibly):

```ts
  it("posts a review comment via GithubTransport, ungated (no grant check)", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const github = new FakeGithubTransport();
    github.seedPullRequest({ number: 1, repo: "owner/repo", headSha: "sha-1", changedFiles: [], diff: "", title: "t", body: "b" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    // Deliberately NO grants passed — posting a comment is not an outward
    // effect requiring authorisation, unlike merging.
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), github });
    await collect(runner.execute(granted(), CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as { options: { mcpServers: { githubPr: { tools: { name: string; handler: (input: unknown) => Promise<unknown> }[] } } } };
    const commentTool = params.options.mcpServers.githubPr.tools.find((t) => t.name === "postReviewComment")!;

    const result = await commentTool.handler({ repo: "owner/repo", number: 1, body: "Looks clean." });

    expect(github.postedComments).toEqual([{ repo: "owner/repo", number: 1, body: "Looks clean." }]);
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("posted") }] });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/sdk-runner-options.test.ts`
Expected: FAIL — no `postReviewComment` tool exists on the `githubPr` server.

- [ ] **Step 3: Add the tool in `src/runner/sdk-runner.ts`**

Inside the `tools: [...]` array of the `githubPrServer` built in Task 7, add
a second entry alongside `mergePR`:

```ts
            tool(
              "postReviewComment",
              "Post a comment on a pull request — findings, an explanation of why a merge was refused, or general review feedback. Never gated: commenting has no outward consequence beyond ordinary communication.",
              { repo: z.string(), number: z.number().int().positive(), body: z.string().min(1) },
              async ({ repo, number, body }) => {
                await this.deps.github!.postReviewComment(repo, number, body);
                return { content: [{ type: "text", text: `Comment posted on ${repo}#${number}.` }] };
              },
            ),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/sdk-runner-options.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm run typecheck && npm test
git add src/runner/sdk-runner.ts tests/sdk-runner-options.test.ts
git commit -m "feat: postReviewComment tool"
```

---

### Task 9: Wire it all together — Milestone A checkpoint

**Files:**
- Create: `src/control/github-api-transport.ts` (the real `GithubTransport`, using `fetch` against GitHub's REST API — no new dependency needed, Node 24 has global `fetch`)
- Modify: `src/index.ts`
- Modify: `.env.example`
- Modify: `config.yaml`
- Create: `agents/pr-reviewer/agent.yaml`, `agents/pr-reviewer/prompt.md`
- Test: `tests/index-webhook-wiring.test.ts` (or extend an existing integration-style test file if one already covers `src/index.ts`'s wiring — check first)

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: `Orchestrator.executeRun` gains an optional third parameter, `promptContext?: string`, appended to the file-read prompt — this is what lets a webhook-triggered run tell the agent *which* PR to review and what its diff actually is, since (unlike a `cron` agent's fixed daily task) every webhook-triggered run needs different, per-event content and `agent.promptPath` alone can't carry that. A running system where a webhook event reaches a real (or fake, in tests) `pr-reviewer` run end to end, with the PR's actual diff/title/body/changed-files/head-SHA in its first message.

- [ ] **Step 0: Extend `Orchestrator.executeRun` to accept per-trigger context**

Read `src/orchestrator.ts`'s current `executeRun` in full first. It currently
builds the prompt purely from `agent.promptPath`'s file contents — correct
for a `cron` agent (same task every day) but insufficient for a `webhook`
agent, where every invocation is about a *different* PR. Add a test to
`tests/orchestrator.test.ts`:

```ts
  it("appends promptContext to the file-read prompt when provided", async () => {
    const { agent, orchestrator, runner } = harness({ events: [{ type: "assistant", text: "ok" }] });
    const executeSpy = vi.spyOn(runner, "execute");
    await orchestrator.executeRun(agent, new Date(), "Extra per-run context.");
    const ctxArg = executeSpy.mock.calls[0]![1] as { prompt: string };
    expect(ctxArg.prompt).toContain("Do the thing.");
    expect(ctxArg.prompt).toContain("Extra per-run context.");
  });

  it("prompt is unchanged when promptContext is omitted (cron's existing behaviour)", async () => {
    const { agent, orchestrator, runner } = harness({ events: [{ type: "assistant", text: "ok" }] });
    const executeSpy = vi.spyOn(runner, "execute");
    await orchestrator.executeRun(agent);
    const ctxArg = executeSpy.mock.calls[0]![1] as { prompt: string };
    expect(ctxArg.prompt).toBe("Do the thing.");
  });
```

(`harness()` currently returns `{ agent, orchestrator, ... }` without
`runner` — check its actual return statement and add `runner` to it if
missing, a one-line change, since these two tests need to spy on it.)

Run `npm test -- tests/orchestrator.test.ts` and confirm these two fail
(second parameter doesn't exist / is ignored). Then change `executeRun`'s
signature and body:

```ts
  async executeRun(agent: AgentDef, now: Date = new Date(), promptContext?: string): Promise<RunResult | undefined> {
    const admitted = await this.governor.admit(agent, "trigger");
    if (admitted.kind === "refuse") {
      // ... unchanged ...
    }

    try {
      const runId = newRunId(agent.name, now);
      const basePrompt = await readFile(agent.promptPath, "utf8");
      const prompt = promptContext ? `${basePrompt}\n\n${promptContext}` : basePrompt;
      return await this.runAndRecord(agent, runId, { runId, workspace: agent.workspace, prompt });
    } finally {
      this.governor.releaseSlot();
    }
  }
```

Run the two new tests, then the full suite, then commit:

```bash
npm run typecheck && npm test
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: Orchestrator.executeRun accepts optional per-trigger prompt context"
```

- [ ] **Step 1: Write `src/control/github-api-transport.ts`**

```ts
import type { GithubTransport, MergeResult, PullRequestInfo } from "./github-transport.js";

/** The only file that talks to the real GitHub API, mirroring how discord-transport.ts is the only file importing discord.js and sdk-runner.ts the only file importing the Agent SDK. */
export class GithubApiTransport implements GithubTransport {
  constructor(private readonly opts: { token: string }) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    const [prRes, filesRes, diffRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, { headers: this.headers() }),
      fetch(`https://api.github.com/repos/${repo}/pulls/${number}/files?per_page=100`, { headers: this.headers() }),
      fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, { headers: { ...this.headers(), accept: "application/vnd.github.diff" } }),
    ]);
    if (!prRes.ok) throw new Error(`GitHub API: failed to fetch ${repo}#${number} (${prRes.status})`);
    const pr = (await prRes.json()) as { head: { sha: string }; title: string; body: string | null };
    const files = (await filesRes.json()) as { filename: string }[];
    const diff = await diffRes.text();
    return {
      number,
      repo,
      headSha: pr.head.sha,
      changedFiles: files.map((f) => f.filename),
      diff,
      title: pr.title,
      body: pr.body ?? "",
    };
  }

  async postReviewComment(repo: string, number: number, body: string): Promise<void> {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`GitHub API: failed to post comment on ${repo}#${number} (${res.status})`);
  }

  async mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<MergeResult> {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ sha: expectedHeadSha, merge_method: "squash" }),
    });
    if (res.status === 409) {
      return { merged: false, reason: "PR head moved since review started (GitHub rejected the expected SHA)" };
    }
    if (!res.ok) {
      return { merged: false, reason: `GitHub API rejected the merge (${res.status})` };
    }
    return { merged: true };
  }
}
```

- [ ] **Step 2: Wire into `src/index.ts`**

Read the current `main()` function in full first (its shape evolved across
Plan B — match what's actually there). Add, alongside the existing
`mustEnv("DISCORD_BOT_TOKEN")`/`mustEnv("DISCORD_OWNER_ID")` calls inside the
formatted boot try/catch:

```ts
    const githubToken = mustEnv("GITHUB_PR_TOKEN");
    const webhookSecret = mustEnv("GITHUB_WEBHOOK_SECRET");
```

After the existing `bot`/`reconcileAndConnectBot` wiring, construct the
webhook receiver and register a handler that triggers the `pr-reviewer`
agent's `executeRun` (reusing `Orchestrator.executeRun` exactly as cron
does — a webhook-triggered run is not a new orchestrator method, it's the
same `executeRun` called from a different trigger source):

```ts
  const github = new GithubApiTransport({ token: githubToken });
  const webhookReceiver = new WebhookReceiver({ secret: webhookSecret });
  webhookReceiver.onEvent(async (event) => {
    const agent = agents.find((a) => a.trigger.type === "webhook" && a.trigger.repo === event.repo && a.trigger.event === event.event);
    if (!agent) return;
    // Pre-fetch the PR's actual content here, once, before the run starts —
    // the alternative (giving the agent its own "getPullRequest" tool and
    // trusting it to call it first) risks it reviewing the wrong PR or
    // skipping the fetch. This also captures the head SHA and changed-files
    // list at the moment of triggering, which the agent hands back into
    // mergePR unchanged — mergePR's own stale-SHA check (Task 7) is what
    // catches a commit landing after this snapshot was taken, not this step.
    const pr = await github.getPullRequest(event.repo, event.pullRequestNumber);
    const promptContext = [
      `Reviewing pull request #${pr.number} in ${pr.repo}.`,
      `Title: ${pr.title}`,
      `Description: ${pr.body || "(none)"}`,
      `Head SHA: ${pr.headSha}`,
      `Changed files: ${pr.changedFiles.join(", ")}`,
      `Diff:\n${pr.diff}`,
    ].join("\n\n");
    await orchestrator.executeRun(agent, new Date(), promptContext);
  });
  await webhookReceiver.listen(Number(process.env.WEBHOOK_PORT ?? 8787));
  console.log(`[boot] webhook receiver listening on :${process.env.WEBHOOK_PORT ?? 8787}`);
```

Pass `github` into the `SdkRunner`/`buildRunner` construction — read how
`runner` is currently built (`buildRunner({ grants, pending })`) and extend
it to `buildRunner({ grants, pending, github })`, then thread `github`
through `buildRunner`'s own signature in `src/runner/build-runner.ts` the
same way `grants`/`pending` already are (read that file first — it's a small,
already-established pattern from Plan B Task 12, extend it rather than
guessing).

- [ ] **Step 3: `.env.example` additions**

```bash
# PR review-and-merge gate: a fine-grained PAT for the dedicated bot GitHub
# account, scoped to only the repos this system manages and only
# pull-request read/write + merge permissions — never broader.
GITHUB_PR_TOKEN=

# Shared secret configured when setting up the repo's webhook (Settings →
# Webhooks → Add webhook). Used to verify incoming events are genuinely
# from GitHub, not forged.
GITHUB_WEBHOOK_SECRET=

# Port the webhook receiver listens on locally; the ngrok tunnel (or, in
# production, a reverse proxy) forwards GitHub's requests here.
WEBHOOK_PORT=8787
```

- [ ] **Step 4: `config.yaml` and `grants.yaml` additions**

Add to `config.yaml` a documented example (not a real grant — matches the
project's existing "no real grant exists" posture):

```yaml
# github:
#   prToken: GITHUB_PR_TOKEN   # (documented here for discoverability; the
#                               # env var itself is read directly, not via
#                               # a config.yaml key, since it's a single
#                               # global credential, not per-channel)
```

(This is a comment-only addition — no schema change needed, since the token
is read directly via `mustEnv`, matching how `DISCORD_BOT_TOKEN` works.)

- [ ] **Step 5: `agents/pr-reviewer/agent.yaml`**

```yaml
name: pr-reviewer
enabled: true
authoredBy: claude-local

trigger:
  type: webhook
  repo: "owner/repo"   # replace with the real repo once it exists
  event: pull_request

run:
  model: claude-sonnet-5
  effort: high
  maxTurns: 60
  timeoutMinutes: 30
  maxBudgetUsd: 3.00

permissions:
  allowedTools: [Read, Write, Edit, Glob, Grep, Bash, Task]
  disallowedTools: []

tier: autonomous
approval: auto
grantRefs: [infra-repo]

outbox:
  discord: smoke
  notifyOn: [success, failure]
```

(`sonnet` and a higher budget/turn ceiling than `smoke`'s, deliberately — this
is the heaviest-judgment agent in the system, reviewing changes to
everything else; cutting its budget to save a few cents is the wrong place
to economise.)

- [ ] **Step 6: `agents/pr-reviewer/prompt.md`**

```markdown
You are reviewing a pull request before deciding whether to merge it. Nobody
else will look at this PR unless you refuse to merge it — your review is the
only gate. Take that seriously; do not rubber-stamp.

## What you have

The PR's diff, title, description, head SHA, and changed-files list are
included in the message that started this run — scroll up, they're already
there; you don't need to fetch them yourself. You also have Bash, so you can
check out the PR's branch and actually run things — the
test suite, a linter, or anything else useful to decide whether this is
safe. Use Task to spawn sub-reviews from different angles in parallel
(correctness/bugs, security, code quality/simplification, and whether the
diff actually does what the PR claims) rather than trying to hold every
angle in your own head at once.

## How to decide

For every finding any sub-review surfaces, adversarially re-check it
yourself before trusting it — could it be a false positive? Does it survive
you actively trying to argue it away? Only count a finding as real once it
survives that.

Calibrate: Critical or Important findings that survive your own adversarial
check mean **do not merge**. Minor findings or polish suggestions don't
block a merge — post them as a review comment, but proceed.

## What to actually do

- If you decide **not** to merge: call `postReviewComment` explaining
  clearly and specifically why, citing what you found. Stop there — do not
  call `mergePR`.
- If you decide to merge: call `mergePR` with the repo, PR number, and the
  exact head SHA and changed-files list given to you above (not something
  you re-derive — this is what lets the tool detect whether a newer commit
  landed while you were reviewing). If it refuses (a stale SHA, an excluded
  path, a missing grant), that refusal is authoritative — do not retry, do
  not argue with it, just post a comment explaining that it couldn't be
  merged and why, if the tool gave you a reason.

You will never be asked to approve anything and nobody is waiting on you —
decide, act, and be done.
```

- [ ] **Step 7: Write the integration test**

This test's job is narrower than "prove the merge-gating logic works" — that
is already fully covered at the `SdkRunner` unit level by Tasks 7–8's tests
(mocking the SDK's `query()` and driving `canUseTool`/the `mergePR` tool
handler directly). This test proves the layer those don't touch: **does an
incoming webhook event resolve to the correct agent and trigger a run at
all** — using `FakeRunner` (not a mocked `SdkRunner`), the same pattern
`tests/orchestrator.test.ts`'s `harness()` already establishes.

Create `tests/webhook-orchestrator-wiring.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApprovedGrantsStore } from "../src/state/approved-grants.js";
import { BreakerStore } from "../src/state/breaker.js";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { FakeGithubTransport } from "../src/control/github-transport.js";
import { WebhookReceiver } from "../src/control/webhook-receiver.js";
import { Governor } from "../src/governor.js";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";
import { RateLimitTracker } from "../src/state/rate-limit.js";
import { RunStore } from "../src/run-store.js";
import { FakeRunner } from "../src/runner/fake-runner.js";
import type { AgentDef } from "../src/registry.js";

const SECRET = "test-webhook-secret";
const CONFIG = parseConfig("config.yaml", "discord:\n  channels:\n    smoke: DISCORD_WEBHOOK_SMOKE\n");

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function prPayload(repo: string, number: number, action = "opened"): string {
  return JSON.stringify({ action, number, repository: { full_name: repo } });
}

/** Mirrors tests/orchestrator.test.ts's realHarness() — a real Governor
 * over a real (temp-dir) RunStore/BreakerStore, with a FakeRunner standing
 * in for SdkRunner, since this test's job is the webhook->agent resolution
 * and admission path, not the merge-gating logic (already covered at the
 * SdkRunner unit level in Tasks 7-8). */
function buildSystem() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-webhook-wiring-"));
  const promptPath = join(dataDir, "prompt.md");
  writeFileSync(promptPath, "Review the PR.");

  const prReviewerAgent = {
    name: "pr-reviewer", enabled: true, dir: dataDir, promptPath,
    workspace: join(dataDir, "workspaces", "pr-reviewer"),
    trigger: { type: "webhook", repo: "owner/repo", event: "pull_request" },
    run: { model: "claude-sonnet-5", effort: "high", maxTurns: 60, maxBudgetUsd: 3, timeoutMinutes: 30 },
    outbox: { discord: "smoke", notifyOn: [] },
  } as unknown as AgentDef;

  const store = new RunStore(dataDir);
  const breaker = new BreakerStore(dataDir);
  const governor = new Governor({
    dataDir, config: CONFIG, store,
    overrides: new ConfigOverridesStore(dataDir),
    rateLimits: new RateLimitTracker(dataDir),
    breaker,
  });
  const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn().mockResolvedValue("delivered") } as never;
  const approvedGrants = new ApprovedGrantsStore(dataDir);
  const runner = new FakeRunner({ events: [{ type: "assistant", text: "reviewed" }] });
  const executeSpy = vi.spyOn(runner, "execute");
  const orchestrator = new Orchestrator({ runner, store, outbox, dataDir, governor, breaker, approvedGrants });

  const github = new FakeGithubTransport();
  github.seedPullRequest({
    number: 7, repo: "owner/repo", headSha: "sha-1",
    changedFiles: ["src/index.ts"], diff: "diff --git a/src/index.ts...", title: "A change", body: "Does a thing.",
  });

  const agents = [prReviewerAgent];
  const receiver = new WebhookReceiver({ secret: SECRET });
  receiver.onEvent(async (event) => {
    const agent = agents.find((a) => a.trigger.type === "webhook" && a.trigger.repo === event.repo && a.trigger.event === event.event);
    if (!agent) return;
    const pr = await github.getPullRequest(event.repo, event.pullRequestNumber);
    const promptContext = `Reviewing PR #${pr.number} in ${pr.repo}. Head SHA: ${pr.headSha}. Changed files: ${pr.changedFiles.join(", ")}.`;
    await orchestrator.executeRun(agent, new Date(), promptContext);
  });

  return { receiver, executeSpy, dataDir, github };
}

describe("webhook -> agent resolution", () => {
  it("triggers the matching webhook-triggered agent's run, with the PR's actual content in its prompt", async () => {
    const { receiver, executeSpy } = buildSystem();
    const body = prPayload("owner/repo", 7);

    const result = await receiver.handleRequest(body, sign(body));
    // handleRequest fires the handler asynchronously (fire-and-forget, per
    // Task 6) — give it a tick to actually run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(result.status).toBe(202);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const ctxArg = executeSpy.mock.calls[0]![1] as { prompt: string };
    expect(ctxArg.prompt).toContain("Head SHA: sha-1");
    expect(ctxArg.prompt).toContain("src/index.ts");
  });

  it("does not trigger any run for a repo with no matching webhook-triggered agent", async () => {
    const { receiver, executeSpy } = buildSystem();
    const body = prPayload("owner/some-other-repo", 3);

    await receiver.handleRequest(body, sign(body));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("does not trigger a run for an unsigned/forged webhook, even for a matching repo", async () => {
    const { receiver, executeSpy } = buildSystem();
    const body = prPayload("owner/repo", 7);

    const result = await receiver.handleRequest(body, "sha256=forged");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(result.status).toBe(401);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 8: Run the full suite, typecheck**

Run: `npm run typecheck && npm test`
Expected: all pass, including the new integration test.

- [ ] **Step 9: Commit — Milestone A checkpoint**

```bash
npm run schema
git add src/control/github-api-transport.ts src/index.ts src/runner/build-runner.ts .env.example config.yaml agents/pr-reviewer tests/index-webhook-wiring.test.ts
git commit -m "feat: wire the webhook receiver and pr-reviewer agent end to end"
```

At this commit: the whole pipeline exists and is tested against fakes. No
real GitHub repo, CI workflow, or GitHub-side configuration exists yet —
that's Milestone B. This is a safe, independently-reviewable checkpoint.

---

## Milestone B — Real-world hardening

### Task 10: GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:** none — this is configuration, not code the rest of the plan depends on structurally (the webhook receiver reacts to the PR event GitHub sends once this workflow's check passes, but nothing here changes any TypeScript interface).

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run typecheck and tests on every PR"
```

(This cannot be verified by running it locally — it only takes effect once
a real GitHub repo exists and a PR is opened against it. Verification is
Task 13's live dry run.)

---

### Task 11: Network isolation during test execution — probe first

**Files:**
- Create: `scripts/probe-network-isolation.ts`

**Interfaces:** none yet — this is a spike (per the spec's §6, "quick and dirty is fine" territory), matching how Plan B's Task 11 probed the SDK's `interrupt` behaviour before committing to an implementation.

- [ ] **Step 1: Write the probe**

The goal: find a mechanism, on both the current Windows dev machine and the
eventual Linux VPS, to run one `Bash` tool's underlying subprocess with
network access disabled, without disabling network for the rest of the
`pr-reviewer` agent's own process (which still needs network for the merge
API calls afterward).

```ts
/**
 * Probes whether the PR-review test-execution step can run with network
 * access disabled, on this machine. Linux has straightforward options
 * (unshare --net, firejail --net=none); Windows does not have an equivalent
 * built-in primitive. Run this manually — `npx tsx scripts/probe-network-isolation.ts`
 * — and read the printed result before Task 12 depends on its answer.
 */
import { execSync } from "node:child_process";
import { platform } from "node:os";

console.log(`Platform: ${platform()}`);

if (platform() === "linux") {
  try {
    const result = execSync("unshare --net -- curl -s --max-time 2 https://example.com -o /dev/null -w '%{http_code}'", { encoding: "utf8" });
    console.log(`unshare --net curl result: "${result}" (expect a failure/timeout, not a 200)`);
  } catch (err) {
    console.log("unshare --net blocked the network call as expected:", (err as Error).message.slice(0, 200));
  }
} else {
  console.log(
    "No built-in Windows primitive for per-process network isolation exists (no unshare equivalent). " +
      "On this platform, network-off-during-test-execution is NOT currently enforceable — this is a real, " +
      "documented gap for local dev/test, closed once this runs on the Linux VPS per the spec's deployment plan.",
  );
}
```

- [ ] **Step 2: Run it and record the result**

Run: `npx tsx scripts/probe-network-isolation.ts`

On Linux (the eventual VPS target): confirm `unshare --net` genuinely blocks
the `curl` call. On Windows (current dev machine): expect the documented
gap — this is real and known, not a bug to fix here.

- [ ] **Step 3: Commit the probe regardless of outcome**

```bash
git add scripts/probe-network-isolation.ts
git commit -m "chore: probe network-isolation mechanism for PR test execution"
```

---

### Task 12: Apply network isolation to the test-execution step (Linux; documented no-op elsewhere)

**Files:**
- Modify: `agents/pr-reviewer/prompt.md`

**Interfaces:** none new.

- [ ] **Step 1: Update the prompt to instruct network-off execution where available**

Given Task 11's probe result, the cheapest correct place for this is the
prompt itself, not new TypeScript machinery — the reviewer already has
`Bash`, and instructing it to prefix test-running commands appropriately is
far simpler than building a new sandboxing layer into `SdkRunner` for one
agent. Add to `agents/pr-reviewer/prompt.md`, in the "What you have" section:

```markdown
When actually running the PR's code (installing dependencies, running its
test suite, executing anything from the PR itself) — as opposed to reading
files or running `git`/`gh` commands you trust — prefix the command with
`unshare --net --` if it's available (`which unshare`). This blocks network
access for exactly that command, since the PR's own code hasn't been vetted
yet and shouldn't be able to make outbound calls while it runs. If `unshare`
isn't available on this machine, proceed without it, but never use any
network access gained during that step for anything beyond reporting what
happened.
```

- [ ] **Step 2: Commit**

```bash
git add agents/pr-reviewer/prompt.md
git commit -m "feat: instruct network isolation during PR code execution where available"
```

(No test for this step — it's prompt guidance for a model's own tool-call
choices, not code with a deterministic assertion to write. Its real
verification is Task 13's live dry run.)

---

### Task 13: GitHub-side setup and live dry run

**Files:** none (repo configuration + a manual verification pass, not code)

- [ ] **Step 1: Create the GitHub repo**

Under the dedicated bot account created earlier in this project, create a
small throwaway test repository — not the real infrastructure repo yet.

- [ ] **Step 2: Configure Wall 2 — CODEOWNERS + branch protection**

Add a `CODEOWNERS` file to the test repo naming a human account (the
owner's own GitHub account, not the bot) as the required reviewer for the
excluded paths listed in `src/control/excluded-paths.ts`:

```
/src/governor.ts        @owner-account
/src/grants.ts          @owner-account
/src/agent-schema.ts    @owner-account
/src/control/bot.ts     @owner-account
/grants.yaml            @owner-account
/config.yaml            @owner-account
```

In the repo's Settings → Branches, add a protection rule on `main` requiring
a review from a CODEOWNERS-matched reviewer before merge, and confirm the
bot account's permissions do not include "bypass branch protection."

- [ ] **Step 3: Add the webhook**

Settings → Webhooks → Add webhook, pointing at the ngrok URL forwarding to
`WEBHOOK_PORT`, content type `application/json`, the same secret as
`GITHUB_WEBHOOK_SECRET`, subscribed to "Pull requests" events only.

- [ ] **Step 4: Generate the fine-grained PAT**

Scoped to only this test repo for now (per the spec's §4.4, the repo list
grows as more projects come under management), with only "Pull requests:
Read and write" and "Contents: Read" permissions.

- [ ] **Step 5: Live dry run**

Start the supervisor (`docker compose up` or `npm start`) with `.env`
populated. Open a small, genuinely harmless PR against the test repo (e.g.
a one-line README change) from a second branch. Confirm, in order: CI runs
and goes green, the webhook fires, `[boot] webhook receiver listening`
already logged at startup, a `pr-reviewer` run starts, and the PR either
merges or gets a comment explaining why not — whichever it decides. Then
open a second PR that touches one of the excluded paths (even a trivial,
harmless one-line change to `config.yaml`) and confirm it is refused and
stays open, and separately confirm GitHub's own branch protection would
ALSO refuse it if the bot's token tried to force it (this is the point
where Wall 2 gets its first real exercise, not just a unit test).

- [ ] **Step 6: Record the outcome**

No commit for this step — it's operational verification, not a code change.
If anything in the dry run surfaces a real gap, that becomes a new task
appended to this plan (or a follow-up plan), not a silent workaround.

---

## After This Plan

Once this milestone is live and trusted against the test repo, point
`agents/pr-reviewer/agent.yaml`'s `trigger.repo` at the real
`claude-agent-infrastructure` repo (once it exists on GitHub) and repeat
Task 13's setup there. Sub-project 2b — the autonomous code-proposing agent
that actually opens PRs in the first place — is a separate design, built on
top of this gate once it's proven trustworthy in practice, per the spec's
§10.
