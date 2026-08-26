# Plan B — Governance & Control: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the governor, capability tiers/grants, park/resume, and the
Discord control bot from parsed-but-inert (or boot-rejected) into real,
tested, enforced behaviour — while keeping every existing test green.

**Architecture:** Two new independent decision points around the existing
`Orchestrator`/`Runner` pipeline: a `Governor` that decides whether a run
starts at all (budgets, concurrency, quiet hours, breaker, best-effort
rate-limit gating), and grant enforcement (`src/grants.ts`) inside
`SdkRunner`'s `canUseTool` callback that decides whether a specific attempted
effect is allowed, denied, or must park for a human. A durable
`PendingStore` lets a parked run's approval or question outlive the process;
a Discord bot (gateway connection, not the existing one-way webhook) is the
human's side of that queue.

**Tech Stack:** Same as Plan A (Node 24, TypeScript 7, ESM, zod 4, vitest),
plus `discord.js` (gateway bot client) for the control bot.

**Spec:** [`docs/superpowers/specs/2026-08-26-plan-b-governance-design.md`](../specs/2026-08-26-plan-b-governance-design.md)
(and the parent [`2026-08-26-claude-agent-infrastructure-design.md`](../specs/2026-08-26-claude-agent-infrastructure-design.md)
§7.2–§7.4, §8.2, which the Plan B spec makes concrete).

## Global Constraints

- Everything in Plan A's Global Constraints still applies verbatim: Node
  `>=24`, ESM with `.js` import extensions, exact model ID strings, IANA
  timezone names only, no colons in filenames, validation errors name the
  offending path/received value/fix, all configuration validated at boot.
- New modules follow the established conventions exactly: `ValidationError`
  / `formatZodError` / `combineValidationErrors` from `src/errors.ts` for
  every validation failure; zod schemas use `.strict()`; tests that touch
  the filesystem use `mkdtempSync(join(tmpdir(), "cai-<thing>-"))`, never a
  fixed path.
- **Milestone A (Tasks 1–10) is the checkpoint.** After Task 10, every
  existing test still passes, the governor is fully live (budgets,
  concurrency, quiet hours, breaker all actually enforced), and nothing
  about tiers, grants, or Discord has changed yet — `tier: granted` still
  rejects at boot. This is a safe, independently mergeable state.
- **`tier: granted`/`autonomous`, `approval: auto`/`approve`, and non-empty
  `grantRefs` stay rejected at boot until Task 16** — the last task. Lifting
  that rejection early would let an agent boot into a tier that can park but
  that nothing can ever resume, which is worse than the current explicit
  rejection.
- No real grant exists anywhere in this plan. `grants.yaml` carries exactly
  one synthetic grant (`test-echo`, an `http` grant pointed at
  `https://httpbin.org/post`) used only to exercise the enforcement and
  park/resume machinery end-to-end.

---

## Milestone A — Governor, grants logic, and the pending queue (no SDK/Discord wiring yet)

### Task 1: Fix cost/token accounting for a run that's aborted mid-stream

**Files:**
- Modify: `src/runner/sdk-runner.ts`
- Test: `tests/sdk-runner-options.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: exported `estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number`; exported `accumulateUsage(existing: PartialUsage, message: unknown): PartialUsage`; type `PartialUsage = { inputTokens: number; outputTokens: number }`. `SdkRunner.execute` now yields a synthesized `"usage"` event before returning when aborted before the terminal `result` message ever arrived.

- [ ] **Step 1: Write the failing test**

Add to `tests/sdk-runner-options.test.ts` (uses the existing `run()`/`stream()`
helpers already in that file):

```ts
  it("emits a synthesized usage event from partial per-turn usage when aborted before the terminal result message", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const controller = new AbortController();

    const events: RunEvent[] = [];
    const iterable = new SdkRunner().execute(AGENT, CTX, controller.signal);
    queryMock.mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          message: { content: "partial one", usage: { input_tokens: 400, output_tokens: 20 } },
        };
        controller.abort();
        yield {
          type: "assistant",
          message: { content: "never reached", usage: { input_tokens: 999, output_tokens: 999 } },
        };
      })(),
    );
    for await (const event of iterable) events.push(event);

    expect(events).toEqual([
      { type: "assistant", text: "partial one" },
      {
        type: "usage",
        inputTokens: 400,
        outputTokens: 20,
        costUsd: estimateCostUsd("claude-haiku-4-5", 400, 20),
        durationMs: 0,
      },
    ]);
  });

  it("does not synthesize a second usage event when the terminal result message already provided one", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const controller = new AbortController();
    const { events } = await run(
      [
        { type: "assistant", message: { content: "a", usage: { input_tokens: 5, output_tokens: 1 } } },
        RESULT_MESSAGE,
      ],
      controller.signal,
    );
    controller.abort();
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
  });
```

Add the `estimateCostUsd` import at the top: `import { SdkRunner, estimateCostUsd } from "../src/runner/sdk-runner.js";` (replacing the existing `SdkRunner`-only dynamic import — keep the existing `vi.mock` / hoisted setup as-is, just add the named import to the same dynamic-import line: `const { SdkRunner, estimateCostUsd } = await import("../src/runner/sdk-runner.js");`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/sdk-runner-options.test.ts`
Expected: FAIL — `estimateCostUsd` is not exported; the partial-usage test gets no `"usage"` event at all.

- [ ] **Step 3: Implement in `src/runner/sdk-runner.ts`**

Add near the top, after the existing `num`/`str`/`blocksOf` helpers:

```ts
/**
 * Rough $/million-token rates for the fixed model set this system runs.
 * Used ONLY to estimate cost on a run aborted before the SDK's own
 * total_cost_usd figure (which arrives solely on the terminal `result`
 * message) was ever computed — subscription runs aren't billed by this
 * number, but a $0.0000 report for a run that burned its whole timeout is
 * worse than an estimate.
 */
const COST_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = COST_PER_MILLION_TOKENS[model];
  if (!rate) return 0;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

export interface PartialUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Accumulates the per-turn `usage` block every SDKAssistantMessage carries
 * (message.usage, standard Anthropic Messages API shape) — present on EVERY
 * assistant message, not only the terminal one. This is what lets a run
 * aborted mid-stream still report a truthful token count instead of losing
 * all accounting.
 */
export function accumulateUsage(existing: PartialUsage, message: unknown): PartialUsage {
  if (typeof message !== "object" || message === null) return existing;
  const m = message as Record<string, unknown>;
  if (m.type !== "assistant") return existing;
  const inner = m.message as Record<string, unknown> | undefined;
  const usage = inner?.usage as Record<string, unknown> | undefined;
  if (!usage) return existing;
  return {
    inputTokens: existing.inputTokens + num(usage.input_tokens),
    outputTokens: existing.outputTokens + num(usage.output_tokens),
  };
}
```

Then change `SdkRunner.execute`'s loop body:

```ts
  async *execute(
    agent: AgentDef,
    ctx: RunContext,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    const { childEnv } = resolveCredentials();
    const controller = new AbortController();
    linkAbort(signal, controller);

    const stream = query({
      prompt: ctx.prompt,
      options: {
        model: agent.run.model,
        effort: agent.run.effort,
        maxTurns: agent.run.maxTurns,
        maxBudgetUsd: agent.run.maxBudgetUsd,
        cwd: ctx.workspace,
        allowedTools: agent.permissions.allowedTools,
        disallowedTools: agent.permissions.disallowedTools,
        permissionMode: "default",
        settingSources: [],
        env: childEnv,
        abortController: controller,
      },
    });

    let partial: PartialUsage = { inputTokens: 0, outputTokens: 0 };
    let sawTerminalUsage = false;

    for await (const message of stream) {
      partial = accumulateUsage(partial, message);
      const events = toRunEvents(message);
      if (events.some((e) => e.type === "usage")) sawTerminalUsage = true;
      yield* events;
      if (signal.aborted) {
        if (!sawTerminalUsage && (partial.inputTokens > 0 || partial.outputTokens > 0)) {
          yield {
            type: "usage",
            inputTokens: partial.inputTokens,
            outputTokens: partial.outputTokens,
            costUsd: estimateCostUsd(agent.run.model, partial.inputTokens, partial.outputTokens),
            durationMs: 0,
          };
        }
        return;
      }
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/sdk-runner-options.test.ts`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm run typecheck && npm test`
Expected: all pass, no regressions.

```bash
git add src/runner/sdk-runner.ts tests/sdk-runner-options.test.ts
git commit -m "fix: preserve cost/token accounting for a run aborted mid-stream"
```

---

### Task 2: Trim the loaded tool set (cost floor)

**Files:**
- Modify: `src/runner/sdk-runner.ts`
- Test: `tests/sdk-runner-options.test.ts` (extend)

**Interfaces:**
- Consumes: `agent.permissions.allowedTools` (already exists).
- Produces: `SdkRunner.execute` now passes `options.tools` to the SDK.

- [ ] **Step 1: Write the failing test**

```ts
  it("passes the agent's allowedTools as the SDK's tools option, trimming what's loaded into the system prompt", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const { params } = await run([RESULT_MESSAGE]);
    expect(params.options.tools).toEqual(["Read", "Glob"]);
  });

  it("passes an empty tools array for an agent with no allowedTools, rather than falling back to every built-in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const bare = { ...AGENT, permissions: { allowedTools: [], disallowedTools: [] } } as unknown as AgentDef;
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(new SdkRunner().execute(bare, CTX, new AbortController().signal));
    expect((queryMock.mock.calls[0]![0] as QueryParams).options.tools).toEqual([]);
  });
```

Also extend the `QueryParams` interface at the top of the test file with
`tools: string[]` inside `options`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/sdk-runner-options.test.ts`
Expected: FAIL — `params.options.tools` is `undefined`.

- [ ] **Step 3: Implement**

In `src/runner/sdk-runner.ts`, add one line to the `query({ ... options: { ... } })` call from Task 1:

```ts
        allowedTools: agent.permissions.allowedTools,
        disallowedTools: agent.permissions.disallowedTools,
        tools: agent.permissions.allowedTools,
```

`AskHuman` (Task 12) is added separately via `mcpServers`, not this list —
`tools` governs only the SDK's own built-ins.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/sdk-runner-options.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite and commit**

```bash
npm run typecheck && npm test
git add src/runner/sdk-runner.ts tests/sdk-runner-options.test.ts
git commit -m "perf: trim the SDK's loaded tool set to an agent's allowedTools"
```

---

### Task 3: `grants.yaml` schema and loader

**Files:**
- Create: `src/grants.ts`
- Create: `grants.yaml`
- Test: `tests/grants.test.ts`

**Interfaces:**
- Consumes: `ValidationError`, `formatZodError`, `combineValidationErrors` from `src/errors.ts`.
- Produces: `GrantSchema` (zod discriminated union on `kind`), type `Grant`; `parseGrants(source: string, yamlText: string): Grant[]`; `loadGrants(path: string): Grant[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/grants.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseGrants } from "../src/grants.js";
import { ValidationError } from "../src/errors.js";

const VALID = `
grants:
  - id: test-echo
    kind: http
    method: POST
    urlPattern: "https://httpbin.org/post"
    secret: TEST_ECHO_TOKEN
`;

describe("parseGrants", () => {
  it("parses a valid http grant", () => {
    const grants = parseGrants("grants.yaml", VALID);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toEqual({
      id: "test-echo", kind: "http", method: "POST",
      urlPattern: "https://httpbin.org/post", secret: "TEST_ECHO_TOKEN",
    });
  });

  it("parses a git-push grant", () => {
    const grants = parseGrants(
      "grants.yaml",
      "grants:\n  - id: push-site\n    kind: git-push\n    remote: github.com/me/site\n    branches: [main]\n    secret: GH_TOKEN\n",
    );
    expect(grants[0]).toMatchObject({ kind: "git-push", remote: "github.com/me/site", branches: ["main"] });
  });

  it("parses a provision grant", () => {
    const grants = parseGrants(
      "grants.yaml",
      "grants:\n  - id: new-repo\n    kind: provision\n    resource: github-repo\n    scope: github.com/me\n    limit: { perDay: 3 }\n    secret: GH_TOKEN\n",
    );
    expect(grants[0]).toMatchObject({ kind: "provision", resource: "github-repo", limit: { perDay: 3 } });
  });

  it("defaults to an empty list when the grants key is absent", () => {
    expect(parseGrants("grants.yaml", "")).toEqual([]);
  });

  it("rejects an unknown kind, naming the legal values", () => {
    const yaml = VALID.replace("kind: http", "kind: ftp");
    expect(() => parseGrants("grants.yaml", yaml)).toThrow(ValidationError);
    try {
      parseGrants("grants.yaml", yaml);
    } catch (e) {
      expect((e as Error).message).toContain("Legal values");
    }
  });

  it("rejects two grants sharing an id", () => {
    const yaml = VALID + VALID.replace("test-echo", "test-echo");
    expect(() => parseGrants("grants.yaml", yaml)).toThrow(/duplicate/i);
  });

  it("rejects a grant missing a field its kind requires", () => {
    const yaml = "grants:\n  - id: bad\n    kind: http\n    method: POST\n    secret: X\n";
    expect(() => parseGrants("grants.yaml", yaml)).toThrow(/urlPattern/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/grants.test.ts`
Expected: FAIL — cannot resolve `../src/grants.js`.

- [ ] **Step 3: Write `src/grants.ts`**

```ts
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

export const GrantSchema = z.discriminatedUnion("kind", [HttpGrant, GitPushGrant, ProvisionGrant]);
export type Grant = z.infer<typeof GrantSchema>;

const GrantsFileSchema = z.object({ grants: z.array(GrantSchema).default([]) }).strict();

export function parseGrants(source: string, yamlText: string): Grant[] {
  const raw = parseYaml(yamlText) ?? {};
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/grants.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Create `grants.yaml`**

```yaml
grants:
  - id: test-echo
    kind: http
    method: POST
    urlPattern: "https://httpbin.org/post"
    secret: TEST_ECHO_TOKEN
```

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/grants.ts grants.yaml tests/grants.test.ts
git commit -m "feat: grants.yaml schema and loader"
```

---

### Task 4: Tier/grant decision engine

**Files:**
- Modify: `src/grants.ts`
- Test: `tests/grants.test.ts` (extend)

**Interfaces:**
- Consumes: `Grant`, `AgentDef` (`tier`, `grantRefs`, `approval` fields already exist on the schema from Plan A).
- Produces: `interface OutwardEffect { description: string; target: string }`; `detectOutwardEffect(toolName: string, input: Record<string, unknown>): OutwardEffect | null`; `matchGrant(grants: Grant[], effect: OutwardEffect): Grant | null`; `type Decision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "park"; grantRef: string; effect: string }`; `decide(agent: Pick<AgentDef, "tier" | "grantRefs" | "approval">, grants: Grant[], toolName: string, input: Record<string, unknown>): Decision`.

- [ ] **Step 1: Write the failing test**

Append to `tests/grants.test.ts`:

```ts
import { decide, detectOutwardEffect, matchGrant } from "../src/grants.js";

const TEST_ECHO = parseGrants(
  "grants.yaml",
  'grants:\n  - id: test-echo\n    kind: http\n    method: POST\n    urlPattern: "https://httpbin.org/post"\n    secret: X\n',
)[0]!;

const PUSH_SITE = parseGrants(
  "grants.yaml",
  "grants:\n  - id: push-site\n    kind: git-push\n    remote: \"github.com/me/site\"\n    branches: [main]\n    secret: X\n",
)[0]!;

describe("detectOutwardEffect", () => {
  it("recognises git push inside a Bash command", () => {
    const effect = detectOutwardEffect("Bash", { command: "git push github.com/me/site main" });
    expect(effect).toEqual({
      description: "git push (git push github.com/me/site main)",
      target: "github.com/me/site",
    });
  });

  it("does not flag a local git commit", () => {
    expect(detectOutwardEffect("Bash", { command: "git commit -m wip" })).toBeNull();
  });

  it("recognises curl to a non-local host but not to localhost", () => {
    expect(detectOutwardEffect("Bash", { command: "curl https://httpbin.org/post" })).not.toBeNull();
    expect(detectOutwardEffect("Bash", { command: "curl http://localhost:3000" })).toBeNull();
  });

  it("recognises WebFetch as always an outward effect, keyed by its url", () => {
    expect(detectOutwardEffect("WebFetch", { url: "https://httpbin.org/post" })).toEqual({
      description: "fetch https://httpbin.org/post",
      target: "https://httpbin.org/post",
    });
  });

  it("returns null for a tool with no outward-effect pattern, like Read", () => {
    expect(detectOutwardEffect("Read", { file_path: "notes.md" })).toBeNull();
  });
});

describe("matchGrant", () => {
  it("matches a git-push grant by remote, ignoring branch detail in the target", () => {
    const effect = detectOutwardEffect("Bash", { command: "git push github.com/me/site main" })!;
    expect(matchGrant([PUSH_SITE], effect)).toBe(PUSH_SITE);
  });

  it("returns null when no grant's target matches", () => {
    const effect = detectOutwardEffect("Bash", { command: "git push github.com/someone-else/repo main" })!;
    expect(matchGrant([PUSH_SITE], effect)).toBeNull();
  });
});

function agent(tier: string, grantRefs: string[] = [], approval = "notify") {
  return { tier, grantRefs, approval } as never;
}

describe("decide", () => {
  it("allows a call with no outward effect regardless of tier", () => {
    expect(decide(agent("readonly"), [], "Read", { file_path: "x" })).toEqual({ kind: "allow" });
  });

  it("denies an outward effect from a readonly agent", () => {
    const result = decide(agent("readonly"), [], "WebFetch", { url: "https://httpbin.org/post" });
    expect(result.kind).toBe("deny");
  });

  it("denies an outward effect from a sandboxed agent even with no grantRefs", () => {
    const result = decide(agent("sandboxed"), [TEST_ECHO], "WebFetch", { url: "https://httpbin.org/post" });
    expect(result.kind).toBe("deny");
  });

  it("parks a granted agent's effect that matches one of its grantRefs", () => {
    const result = decide(agent("granted", ["test-echo"]), [TEST_ECHO], "WebFetch", { url: "https://httpbin.org/post" });
    expect(result).toEqual({ kind: "park", grantRef: "test-echo", effect: "fetch https://httpbin.org/post" });
  });

  it("denies a granted agent's effect that matches no grantRef", () => {
    const result = decide(agent("granted", ["test-echo"]), [TEST_ECHO], "Bash", { command: "git push github.com/x/y main" });
    expect(result.kind).toBe("deny");
  });

  it("allows an autonomous agent's matching effect without parking", () => {
    const result = decide(agent("autonomous", ["test-echo"], "auto"), [TEST_ECHO], "WebFetch", { url: "https://httpbin.org/post" });
    expect(result).toEqual({ kind: "allow" });
  });

  it("still parks an autonomous-tier agent whose approval mode isn't auto", () => {
    const result = decide(agent("autonomous", ["test-echo"], "notify"), [TEST_ECHO], "WebFetch", { url: "https://httpbin.org/post" });
    expect(result.kind).toBe("park");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/grants.test.ts`
Expected: FAIL — `decide`, `detectOutwardEffect`, `matchGrant` not exported.

- [ ] **Step 3: Extend `src/grants.ts`**

Append:

```ts
export interface OutwardEffect {
  description: string;
  target: string;
}

const OUTWARD_HOST_PATTERN = /https?:\/\/\S+/;

export function detectOutwardEffect(toolName: string, input: Record<string, unknown>): OutwardEffect | null {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const push = command.match(/\bgit\s+push\s+(\S+)/);
    if (push) return { description: `git push (${command.trim()})`, target: push[1]! };

    if (/\b(curl|wget)\b/.test(command) && !/localhost|127\.0\.0\.1/.test(command)) {
      const url = command.match(OUTWARD_HOST_PATTERN);
      return { description: `network call (${command.trim()})`, target: url?.[0] ?? command.trim() };
    }
    if (/\bnpm\s+publish\b/.test(command)) {
      return { description: `npm publish (${command.trim()})`, target: "npm-publish" };
    }
    if (/\bgh\s+(repo\s+create|release\s+create|pr\s+create)\b/.test(command)) {
      return { description: `gh (${command.trim()})`, target: "gh-provision" };
    }
    return null;
  }

  if (toolName === "WebFetch") {
    const url = typeof input.url === "string" ? input.url : "";
    return url ? { description: `fetch ${url}`, target: url } : null;
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
  }
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? "\uFFFF" : `\\${c}`));
  const regex = new RegExp(`^${escaped.replace(/\uFFFF/g, ".*")}$`);
  return regex.test(value);
}

export function matchGrant(grants: Grant[], effect: OutwardEffect): Grant | null {
  return grants.find((g) => globMatch(grantTargetPattern(g), effect.target) || effect.target.includes(grantTargetPattern(g).replace(/\*/g, ""))) ?? null;
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/grants.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/grants.ts tests/grants.test.ts
git commit -m "feat: tier/grant decision engine with outward-effect detection"
```

---

### Task 5: Durable pending queue

**Files:**
- Create: `src/control/pending.ts`
- Test: `tests/pending.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `interface PendingEntry { id: string; runId: string; agentName: string; sessionId: string; kind: "approval" | "question"; effect?: string; grantRef?: string; question?: string; askedAt: string }`; class `PendingStore` with `create(entry): Promise<PendingEntry>`, `get(id): Promise<PendingEntry | null>`, `list(): Promise<PendingEntry[]>`, `resolve(id): Promise<void>`, `reconcile(opts: { timeoutHours: number; now?: Date }): Promise<{ expired: PendingEntry[]; active: PendingEntry[] }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/pending.test.ts`:

```ts
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PendingStore } from "../src/control/pending.js";

function store() {
  return new PendingStore(mkdtempSync(join(tmpdir(), "cai-pending-")));
}

describe("PendingStore", () => {
  it("creates an entry with a generated id and timestamp, and reads it back", async () => {
    const s = store();
    const entry = await s.create({
      runId: "smoke-1", agentName: "smoke", sessionId: "sess-1",
      kind: "approval", effect: "fetch https://httpbin.org/post", grantRef: "test-echo",
    });
    expect(entry.id).toBeTruthy();
    expect(entry.askedAt).toBeTruthy();
    const fetched = await s.get(entry.id);
    expect(fetched).toEqual(entry);
  });

  it("returns null for an id that doesn't exist", async () => {
    expect(await store().get("nope")).toBeNull();
  });

  it("lists every open entry", async () => {
    const s = store();
    await s.create({ runId: "a", agentName: "a", sessionId: "s1", kind: "question", question: "which one?" });
    await s.create({ runId: "b", agentName: "b", sessionId: "s2", kind: "approval", effect: "x", grantRef: "g" });
    expect(await s.list()).toHaveLength(2);
  });

  it("resolve deletes the entry", async () => {
    const s = store();
    const entry = await s.create({ runId: "a", agentName: "a", sessionId: "s1", kind: "question", question: "?" });
    await s.resolve(entry.id);
    expect(await s.get(entry.id)).toBeNull();
    expect(await s.list()).toEqual([]);
  });

  it("reconciles: entries within the timeout are active, older ones are expired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-pending-"));
    const s = new PendingStore(dir);
    const fresh = await s.create(
      { runId: "a", agentName: "a", sessionId: "s1", kind: "question", question: "?" },
    );
    const stale = await s.create(
      { runId: "b", agentName: "b", sessionId: "s2", kind: "question", question: "?" },
    );
    // Simulate an old entry by re-writing its file with a backdated askedAt —
    // PendingStore itself always stamps "now", so backdating happens directly
    // on disk, the way a real restart-days-later scenario would look.
    const path = join(dir, "pending", `${stale.id}.json`);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.askedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(parsed));

    const result = await s.reconcile({ timeoutHours: 24 });
    expect(result.active.map((e) => e.id)).toEqual([fresh.id]);
    expect(result.expired.map((e) => e.id)).toEqual([stale.id]);
  });

  it("reconcile deletes the expired entry's file so it isn't re-reported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-pending-"));
    const s = new PendingStore(dir);
    await s.create({ runId: "a", agentName: "a", sessionId: "s1", kind: "question", question: "?" });
    const path = join(dir, "pending", `${(await s.list())[0]!.id}.json`);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.askedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(parsed));

    await s.reconcile({ timeoutHours: 24 });
    expect(readdirSync(join(dir, "pending"))).toHaveLength(0);
  });

  it("survives a simulated restart: a new PendingStore over the same directory sees prior entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-pending-"));
    const first = new PendingStore(dir);
    const entry = await first.create({ runId: "a", agentName: "a", sessionId: "s1", kind: "question", question: "?" });
    const second = new PendingStore(dir);
    expect(await second.get(entry.id)).toEqual(entry);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/pending.test.ts`
Expected: FAIL — cannot resolve `../src/control/pending.js`.

- [ ] **Step 3: Write `src/control/pending.ts`**

```ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PendingEntry {
  id: string;
  runId: string;
  agentName: string;
  sessionId: string;
  kind: "approval" | "question";
  effect?: string;
  grantRef?: string;
  question?: string;
  askedAt: string;
}

export class PendingStore {
  constructor(private readonly dataDir: string) {}

  private dir(): string {
    return join(this.dataDir, "pending");
  }

  private path(id: string): string {
    return join(this.dir(), `${id}.json`);
  }

  async create(entry: Omit<PendingEntry, "id" | "askedAt">): Promise<PendingEntry> {
    await mkdir(this.dir(), { recursive: true });
    const full: PendingEntry = { ...entry, id: randomUUID(), askedAt: new Date().toISOString() };
    await writeFile(this.path(full.id), JSON.stringify(full, null, 2) + "\n");
    return full;
  }

  async get(id: string): Promise<PendingEntry | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as PendingEntry;
    } catch {
      return null;
    }
  }

  async list(): Promise<PendingEntry[]> {
    const files = await readdir(this.dir()).catch(() => [] as string[]);
    const entries: PendingEntry[] = [];
    for (const file of files) {
      const entry = await this.get(file.replace(/\.json$/, ""));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async resolve(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }

  async reconcile(opts: { timeoutHours: number; now?: Date }): Promise<{ expired: PendingEntry[]; active: PendingEntry[] }> {
    const now = opts.now ?? new Date();
    const cutoffMs = opts.timeoutHours * 60 * 60 * 1000;
    const all = await this.list();
    const expired: PendingEntry[] = [];
    const active: PendingEntry[] = [];
    for (const entry of all) {
      const ageMs = now.getTime() - new Date(entry.askedAt).getTime();
      if (ageMs > cutoffMs) {
        expired.push(entry);
        await this.resolve(entry.id);
      } else {
        active.push(entry);
      }
    }
    return { expired, active };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/pending.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/control/pending.ts tests/pending.test.ts
git commit -m "feat: durable pending queue for park/resume"
```

---

### Task 6: New RunEvent/RunStatus values and the rate_limit_event mapping

**Files:**
- Modify: `src/runner/types.ts`
- Modify: `src/run-store.ts`
- Modify: `src/runner/sdk-runner.ts`
- Modify: `src/outbox/discord.ts`
- Test: `tests/sdk-runner.test.ts` (extend), `tests/outbox.test.ts` (extend)

**Interfaces:**
- Produces: `RunEvent` gains `{ type: "rate_limit_event"; status: "allowed" | "allowed_warning" | "rejected"; rateLimitType?: string; utilization?: number; resetsAt?: number }`, `{ type: "parked"; kind: "approval" | "question"; pendingId: string }`, `{ type: "denied"; reason: string }`. `RunStatus` gains `"parked"`, `"question"`, `"denied"`. `toRunEvents` maps an SDK `rate_limit_event` message to the new `RunEvent`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sdk-runner.test.ts`:

```ts
  it("maps a rate_limit_event message to a rate_limit_event RunEvent", () => {
    const events = toRunEvents({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.91,
        resetsAt: 1787766600,
      },
    });
    expect(events).toEqual([
      { type: "rate_limit_event", status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.91, resetsAt: 1787766600 },
    ]);
  });

  it("maps a rate_limit_event with a minimal payload, defaulting the optional fields to undefined", () => {
    const events = toRunEvents({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    expect(events).toEqual([{ type: "rate_limit_event", status: "allowed" }]);
  });
```

Append to `tests/outbox.test.ts` (inside `describe("formatRunMessage", ...)`):

```ts
  it("renders the parked, question, and denied statuses with a distinct icon from failed", () => {
    const parked = formatRunMessage({ ...RESULT, status: "parked" as never });
    const question = formatRunMessage({ ...RESULT, status: "question" as never });
    const denied = formatRunMessage({ ...RESULT, status: "denied" as never });
    for (const text of [parked, question, denied]) {
      expect(text).not.toContain("❌");
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/sdk-runner.test.ts tests/outbox.test.ts`
Expected: FAIL — `toRunEvents` returns `[]` for `rate_limit_event`; the icon assertions currently pass by accident (no icon at all is defined for the new statuses, so this test may pass vacuously) — check by hand that `formatRunMessage` doesn't throw on an unrecognised status; if it doesn't throw, this specific test can pass before Step 3, which is fine — the meaningful failure is in `sdk-runner.test.ts`.

- [ ] **Step 3: Implement**

In `src/runner/types.ts`, extend the union:

```ts
export type RunEvent =
  | { type: "assistant"; text: string }
  | { type: "tool_use"; name: string }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number }
  | { type: "error"; message: string }
  | {
      type: "rate_limit_event";
      status: "allowed" | "allowed_warning" | "rejected";
      rateLimitType?: string;
      utilization?: number;
      resetsAt?: number;
    }
  | { type: "parked"; kind: "approval" | "question"; pendingId: string }
  | { type: "denied"; reason: string };
```

In `src/run-store.ts`, extend `RunStatus`:

```ts
export type RunStatus =
  | "success" | "failed" | "timeout" | "budget-exceeded" | "killed" | "interrupted"
  | "parked" | "question" | "denied";
```

In `src/runner/sdk-runner.ts`'s `toRunEvents`, add a case:

```ts
    case "rate_limit_event": {
      const info = (m.rate_limit_info as Record<string, unknown> | undefined) ?? {};
      const status = info.status;
      if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return [];
      const event: RunEvent = { type: "rate_limit_event", status };
      if (typeof info.rateLimitType === "string") (event as Record<string, unknown>).rateLimitType = info.rateLimitType;
      if (typeof info.utilization === "number") (event as Record<string, unknown>).utilization = info.utilization;
      if (typeof info.resetsAt === "number") (event as Record<string, unknown>).resetsAt = info.resetsAt;
      return [event];
    }
```

Add this case alongside the existing `"result"` case, before `default`.

In `src/outbox/discord.ts`, extend the `ICON` map:

```ts
const ICON: Record<string, string> = {
  success: "✅", failed: "❌", timeout: "⏱️",
  "budget-exceeded": "💸", killed: "🛑", interrupted: "⚠️",
  parked: "⏸️", question: "❓", denied: "🚫",
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/sdk-runner.test.ts tests/outbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm run typecheck && npm test
git add src/runner/types.ts src/run-store.ts src/runner/sdk-runner.ts src/outbox/discord.ts tests/sdk-runner.test.ts tests/outbox.test.ts
git commit -m "feat: parked/question/denied run outcomes and rate_limit_event mapping"
```

---

### Task 7: Persisted rate-limit snapshot and circuit breaker

**Files:**
- Create: `src/state/rate-limit.ts`
- Create: `src/state/breaker.ts`
- Test: `tests/rate-limit-tracker.test.ts`
- Test: `tests/breaker.test.ts`

**Interfaces:**
- Produces: `interface RateLimitSnapshot { status: "allowed" | "allowed_warning" | "rejected"; rateLimitType?: string; utilization?: number; resetsAt?: number; recordedAt: string }`; class `RateLimitTracker` with `record(info: Omit<RateLimitSnapshot, "recordedAt">, now?: Date): Promise<void>`, `read(): Promise<RateLimitSnapshot | null>`. `interface BreakerState { consecutiveFailures: number; disabledAt?: string }`; class `BreakerStore` with `recordResult(agentName: string, status: RunStatus, now?: Date): Promise<BreakerState>`, `isTripped(agentName: string): Promise<boolean>`, `reset(agentName: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/rate-limit-tracker.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RateLimitTracker } from "../src/state/rate-limit.js";

describe("RateLimitTracker", () => {
  it("returns null when nothing has been recorded yet (fails open, not closed)", async () => {
    const tracker = new RateLimitTracker(mkdtempSync(join(tmpdir(), "cai-rl-")));
    expect(await tracker.read()).toBeNull();
  });

  it("records and reads back the latest snapshot, stamped with when it was recorded", async () => {
    const tracker = new RateLimitTracker(mkdtempSync(join(tmpdir(), "cai-rl-")));
    await tracker.record({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.91, resetsAt: 1787766600 });
    const snapshot = await tracker.read();
    expect(snapshot?.status).toBe("allowed_warning");
    expect(snapshot?.utilization).toBe(0.91);
    expect(snapshot?.recordedAt).toBeTruthy();
  });

  it("a later record overwrites an earlier one", async () => {
    const tracker = new RateLimitTracker(mkdtempSync(join(tmpdir(), "cai-rl-")));
    await tracker.record({ status: "allowed", utilization: 0.1 });
    await tracker.record({ status: "rejected", utilization: 1.0 });
    expect((await tracker.read())?.status).toBe("rejected");
  });

  it("returns null rather than throwing when the file on disk is corrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-rl-"));
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "rate-limit.json"), "not json");
    expect(await new RateLimitTracker(dir).read()).toBeNull();
  });
});
```

Create `tests/breaker.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BreakerStore } from "../src/state/breaker.js";

describe("BreakerStore", () => {
  it("is not tripped for an agent with no recorded history", async () => {
    const breaker = new BreakerStore(mkdtempSync(join(tmpdir(), "cai-breaker-")));
    expect(await breaker.isTripped("smoke")).toBe(false);
  });

  it("trips after 3 consecutive failures", async () => {
    const breaker = new BreakerStore(mkdtempSync(join(tmpdir(), "cai-breaker-")));
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "timeout");
    expect(await breaker.isTripped("smoke")).toBe(false);
    await breaker.recordResult("smoke", "failed");
    expect(await breaker.isTripped("smoke")).toBe(true);
  });

  it("a success resets the counter", async () => {
    const breaker = new BreakerStore(mkdtempSync(join(tmpdir(), "cai-breaker-")));
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "success");
    await breaker.recordResult("smoke", "failed");
    expect(await breaker.isTripped("smoke")).toBe(false);
  });

  it.each(["parked", "question", "denied", "budget-exceeded"] as const)(
    "%s does not count as a failure toward the breaker",
    async (status) => {
      const breaker = new BreakerStore(mkdtempSync(join(tmpdir(), "cai-breaker-")));
      await breaker.recordResult("smoke", "failed");
      await breaker.recordResult("smoke", "failed");
      await breaker.recordResult("smoke", status);
      expect(await breaker.isTripped("smoke")).toBe(false);
    },
  );

  it("tracks agents independently", async () => {
    const breaker = new BreakerStore(mkdtempSync(join(tmpdir(), "cai-breaker-")));
    await breaker.recordResult("a", "failed");
    await breaker.recordResult("a", "failed");
    await breaker.recordResult("a", "failed");
    expect(await breaker.isTripped("a")).toBe(true);
    expect(await breaker.isTripped("b")).toBe(false);
  });

  it("reset clears a tripped breaker", async () => {
    const breaker = new BreakerStore(mkdtempSync(join(tmpdir(), "cai-breaker-")));
    await breaker.recordResult("a", "failed");
    await breaker.recordResult("a", "failed");
    await breaker.recordResult("a", "failed");
    await breaker.reset("a");
    expect(await breaker.isTripped("a")).toBe(false);
  });

  it("survives a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-breaker-"));
    await new BreakerStore(dir).recordResult("a", "failed");
    await new BreakerStore(dir).recordResult("a", "failed");
    await new BreakerStore(dir).recordResult("a", "failed");
    expect(await new BreakerStore(dir).isTripped("a")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/rate-limit-tracker.test.ts tests/breaker.test.ts`
Expected: FAIL — cannot resolve either module.

- [ ] **Step 3: Write `src/state/rate-limit.ts`**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RateLimitSnapshot {
  status: "allowed" | "allowed_warning" | "rejected";
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  recordedAt: string;
}

export class RateLimitTracker {
  constructor(private readonly dataDir: string) {}

  private path(): string {
    return join(this.dataDir, "state", "rate-limit.json");
  }

  async record(info: Omit<RateLimitSnapshot, "recordedAt">, now: Date = new Date()): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    const snapshot: RateLimitSnapshot = { ...info, recordedAt: now.toISOString() };
    await writeFile(this.path(), JSON.stringify(snapshot, null, 2) + "\n");
  }

  /** null means "no reading yet" or "unreadable" — callers must fail OPEN on null, never treat it as rejected. */
  async read(): Promise<RateLimitSnapshot | null> {
    try {
      return JSON.parse(await readFile(this.path(), "utf8")) as RateLimitSnapshot;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Write `src/state/breaker.ts`**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunStatus } from "../run-store.js";

export interface BreakerState {
  consecutiveFailures: number;
  disabledAt?: string;
}

const FAILURE_STATUSES: ReadonlySet<RunStatus> = new Set(["failed", "timeout"]);
const TRIP_THRESHOLD = 3;

export class BreakerStore {
  constructor(private readonly dataDir: string) {}

  private path(agentName: string): string {
    return join(this.dataDir, "state", agentName, "breaker.json");
  }

  private async read(agentName: string): Promise<BreakerState> {
    try {
      return JSON.parse(await readFile(this.path(agentName), "utf8")) as BreakerState;
    } catch {
      return { consecutiveFailures: 0 };
    }
  }

  private async write(agentName: string, state: BreakerState): Promise<void> {
    await mkdir(join(this.dataDir, "state", agentName), { recursive: true });
    await writeFile(this.path(agentName), JSON.stringify(state, null, 2) + "\n");
  }

  async recordResult(agentName: string, status: RunStatus, now: Date = new Date()): Promise<BreakerState> {
    const current = await this.read(agentName);
    const next: BreakerState = FAILURE_STATUSES.has(status)
      ? { consecutiveFailures: current.consecutiveFailures + 1 }
      : { consecutiveFailures: 0 };
    if (next.consecutiveFailures >= TRIP_THRESHOLD) next.disabledAt = now.toISOString();
    await this.write(agentName, next);
    return next;
  }

  async isTripped(agentName: string): Promise<boolean> {
    return (await this.read(agentName)).consecutiveFailures >= TRIP_THRESHOLD;
  }

  async reset(agentName: string): Promise<void> {
    await this.write(agentName, { consecutiveFailures: 0 });
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/rate-limit-tracker.test.ts tests/breaker.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/state/rate-limit.ts src/state/breaker.ts tests/rate-limit-tracker.test.ts tests/breaker.test.ts
git commit -m "feat: persisted rate-limit snapshot and per-agent circuit breaker"
```

---

### Task 8: Runtime-mutable config overrides

**Files:**
- Create: `src/config-overrides.ts`
- Test: `tests/config-overrides.test.ts`

**Interfaces:**
- Consumes: `Config`, `QuietHours`, `GovernorConfig` from `src/config.ts`.
- Produces: `interface ConfigOverrides { quietHours?: QuietHours | null; dailyBudgetUsd?: number; maxConcurrent?: number; disabledAgents?: string[] }`; class `ConfigOverridesStore` with `read(): Promise<ConfigOverrides>`, `set<K extends keyof ConfigOverrides>(key: K, value: ConfigOverrides[K], setBy: string): Promise<void>`; `resolveGovernorSettings(config: Config, overrides: ConfigOverrides): GovernorConfig`.

- [ ] **Step 1: Write the failing test**

Create `tests/config-overrides.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigOverridesStore, resolveGovernorSettings } from "../src/config-overrides.js";
import { parseConfig } from "../src/config.js";

const CONFIG = parseConfig(
  "config.yaml",
  'governor:\n  maxConcurrent: 2\n  dailyBudgetUsd: 10\n  pendingTimeoutHours: 24\n  quietHours: { from: "02:00", to: "03:00", timezone: Europe/Berlin }\ndiscord:\n  channels: {}\n',
);

describe("ConfigOverridesStore", () => {
  it("reads an empty object when nothing has been set", async () => {
    const store = new ConfigOverridesStore(mkdtempSync(join(tmpdir(), "cai-overrides-")));
    expect(await store.read()).toEqual({});
  });

  it("set then read round-trips a value", async () => {
    const store = new ConfigOverridesStore(mkdtempSync(join(tmpdir(), "cai-overrides-")));
    await store.set("dailyBudgetUsd", 25, "discord:owner");
    expect(await store.read()).toEqual({ dailyBudgetUsd: 25 });
  });

  it("set merges with existing overrides rather than replacing them", async () => {
    const store = new ConfigOverridesStore(mkdtempSync(join(tmpdir(), "cai-overrides-")));
    await store.set("dailyBudgetUsd", 25, "discord:owner");
    await store.set("maxConcurrent", 3, "discord:owner");
    expect(await store.read()).toEqual({ dailyBudgetUsd: 25, maxConcurrent: 3 });
  });

  it("setting quietHours to null explicitly disables it, distinct from never having been set", async () => {
    const store = new ConfigOverridesStore(mkdtempSync(join(tmpdir(), "cai-overrides-")));
    await store.set("quietHours", null, "discord:owner");
    expect(await store.read()).toEqual({ quietHours: null });
  });

  it("appends an audit log line naming the key, the new value, and who set it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-overrides-"));
    const store = new ConfigOverridesStore(dir);
    await store.set("dailyBudgetUsd", 25, "discord:owner");
    const log = readFileSync(join(dir, "state", "audit.log"), "utf8");
    expect(log).toContain("dailyBudgetUsd");
    expect(log).toContain("25");
    expect(log).toContain("discord:owner");
  });

  it("survives a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-overrides-"));
    await new ConfigOverridesStore(dir).set("maxConcurrent", 5, "discord:owner");
    expect(await new ConfigOverridesStore(dir).read()).toEqual({ maxConcurrent: 5 });
  });
});

describe("resolveGovernorSettings", () => {
  it("falls back to config.yaml when no override is set", () => {
    const resolved = resolveGovernorSettings(CONFIG, {});
    expect(resolved.dailyBudgetUsd).toBe(10);
    expect(resolved.maxConcurrent).toBe(2);
    expect(resolved.quietHours?.timezone).toBe("Europe/Berlin");
  });

  it("an override takes precedence over config.yaml", () => {
    const resolved = resolveGovernorSettings(CONFIG, { dailyBudgetUsd: 25 });
    expect(resolved.dailyBudgetUsd).toBe(25);
    expect(resolved.maxConcurrent).toBe(2);
  });

  it("an explicit null override disables quiet hours even though config.yaml has one", () => {
    const resolved = resolveGovernorSettings(CONFIG, { quietHours: null });
    expect(resolved.quietHours).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/config-overrides.test.ts`
Expected: FAIL — cannot resolve `../src/config-overrides.js`.

- [ ] **Step 3: Write `src/config-overrides.ts`**

```ts
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, GovernorConfig, QuietHours } from "./config.js";

export interface ConfigOverrides {
  quietHours?: QuietHours | null;
  dailyBudgetUsd?: number;
  maxConcurrent?: number;
  disabledAgents?: string[];
}

export class ConfigOverridesStore {
  constructor(private readonly dataDir: string) {}

  private path(): string {
    return join(this.dataDir, "config-overrides.json");
  }

  async read(): Promise<ConfigOverrides> {
    try {
      return JSON.parse(await readFile(this.path(), "utf8")) as ConfigOverrides;
    } catch {
      return {};
    }
  }

  async set<K extends keyof ConfigOverrides>(key: K, value: ConfigOverrides[K], setBy: string): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    const current = await this.read();
    const previous = current[key];
    const next = { ...current, [key]: value };
    await writeFile(this.path(), JSON.stringify(next, null, 2) + "\n");
    const line = `${new Date().toISOString()} ${setBy} set ${String(key)} = ${JSON.stringify(value)} (was ${JSON.stringify(previous)})\n`;
    await appendFile(join(this.dataDir, "state", "audit.log"), line);
  }
}

/** override → config.yaml → built-in default. An override key that is `undefined` (never set) falls through; an explicit `null` on quietHours wins as "off". */
export function resolveGovernorSettings(config: Config, overrides: ConfigOverrides): GovernorConfig {
  return {
    maxConcurrent: overrides.maxConcurrent ?? config.governor.maxConcurrent,
    dailyBudgetUsd: overrides.dailyBudgetUsd ?? config.governor.dailyBudgetUsd,
    pendingTimeoutHours: config.governor.pendingTimeoutHours,
    quietHours: "quietHours" in overrides ? (overrides.quietHours ?? null) : config.governor.quietHours,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/config-overrides.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/config-overrides.ts tests/config-overrides.test.ts
git commit -m "feat: runtime-mutable governor settings with an audit log"
```

---

### Task 9: Governor — admission control and concurrency

**Files:**
- Create: `src/governor.ts`
- Test: `tests/governor.test.ts`

**Interfaces:**
- Consumes: `Config` (`src/config.ts`), `AgentDef` (`src/registry.ts`), `RunStore` (`src/run-store.ts`), `ConfigOverridesStore`/`resolveGovernorSettings` (Task 8), `RateLimitTracker` (Task 7), `BreakerStore` (Task 7).
- Produces: `type AdmitResult = { kind: "admit" } | { kind: "refuse"; reason: string; alert: boolean }`; class `Governor` with constructor `{ dataDir: string; config: Config; store: RunStore; overrides: ConfigOverridesStore; rateLimits: RateLimitTracker; breaker: BreakerStore; now?: () => Date }`, methods `admit(agent: AgentDef, kind: "trigger" | "resume"): Promise<AdmitResult>`, `releaseSlot(): void`, `recordRateLimit(info): Promise<void>` (live snapshot update from a streaming run), `recordRateLimitError(): Promise<void>` (reactive exponential backoff when the SDK itself reports a rate-limit error).

- [ ] **Step 1: Write the failing test**

Create `tests/governor.test.ts`:

```ts
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { Governor } from "../src/governor.js";
import { RunStore, newRunId } from "../src/run-store.js";
import { RateLimitTracker } from "../src/state/rate-limit.js";
import { BreakerStore } from "../src/state/breaker.js";
import type { AgentDef } from "../src/registry.js";

const CONFIG = parseConfig(
  "config.yaml",
  'governor:\n  maxConcurrent: 2\n  dailyBudgetUsd: 10\n  pendingTimeoutHours: 24\n  quietHours: { from: "02:00", to: "03:00", timezone: Europe/Berlin }\ndiscord:\n  channels: {}\n',
);

function agent(name = "smoke"): AgentDef {
  return { name } as AgentDef;
}

function build(dataDir: string, now: () => Date = () => new Date("2026-08-26T12:00:00.000Z")) {
  return new Governor({
    dataDir, config: CONFIG, store: new RunStore(dataDir),
    overrides: new ConfigOverridesStore(dataDir),
    rateLimits: new RateLimitTracker(dataDir),
    breaker: new BreakerStore(dataDir),
    now,
  });
}

describe("Governor.admit", () => {
  it("admits when nothing is blocking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("refuses when the STOP file is present, with alert: false (routine, not actionable)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    writeFileSync(join(dir, "STOP"), "");
    const result = await build(dir).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("STOP"), alert: false });
  });

  it("refuses when the agent's breaker is tripped, with alert: true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const breaker = new BreakerStore(dir);
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    const result = await build(dir).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("breaker"), alert: true });
  });

  it("a resume ignores the breaker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const breaker = new BreakerStore(dir);
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    await breaker.recordResult("smoke", "failed");
    expect(await build(dir).admit(agent(), "resume")).toEqual({ kind: "admit" });
  });

  it("refuses during quiet hours", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    // 02:30 Europe/Berlin falls inside the 02:00-03:00 window in CONFIG.
    const inWindow = () => new Date("2026-08-26T00:30:00.000Z"); // 02:30 CEST (UTC+2)
    const result = await build(dir, inWindow).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("quiet hours"), alert: false });
  });

  it("does not refuse for quiet hours once overridden off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new ConfigOverridesStore(dir).set("quietHours", null, "test");
    const inWindow = () => new Date("2026-08-26T00:30:00.000Z");
    expect(await build(dir, inWindow).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("refuses once today's spend meets the daily budget, with alert: true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const runStore = new RunStore(dir);
    const writer = await runStore.open(newRunId("smoke", new Date("2026-08-26T08:00:00.000Z")), "smoke");
    await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 10, durationMs: 1 });
    await writer.close({ status: "success", summary: "" });
    const result = await build(dir).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("budget"), alert: true });
  });

  it("does not count yesterday's spend against today's budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const runStore = new RunStore(dir);
    const writer = await runStore.open(newRunId("smoke", new Date("2026-08-25T08:00:00.000Z")), "smoke");
    await writer.append({ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 10, durationMs: 1 });
    await writer.close({ status: "success", summary: "" });
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("refuses when the last known rate-limit snapshot says rejected, with alert: true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    await new RateLimitTracker(dir).record({ status: "rejected" });
    const result = await build(dir).admit(agent(), "trigger");
    expect(result).toEqual({ kind: "refuse", reason: expect.stringContaining("rate limit"), alert: true });
  });

  it("admits when there is no rate-limit snapshot yet (fails open)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    expect(await build(dir).admit(agent(), "trigger")).toEqual({ kind: "admit" });
  });

  it("a second admit waits for a slot when maxConcurrent is 1, and proceeds once released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    mkdirSync(dir, { recursive: true });
    const config = parseConfig(
      "config.yaml",
      'governor:\n  maxConcurrent: 1\n  dailyBudgetUsd: 10\n  pendingTimeoutHours: 24\ndiscord:\n  channels: {}\n',
    );
    const governor = new Governor({
      dataDir: dir, config, store: new RunStore(dir), overrides: new ConfigOverridesStore(dir),
      rateLimits: new RateLimitTracker(dir), breaker: new BreakerStore(dir),
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    });

    const first = await governor.admit(agent("a"), "trigger");
    expect(first).toEqual({ kind: "admit" });

    let secondResolved = false;
    const secondPromise = governor.admit(agent("b"), "trigger").then((r) => {
      secondResolved = true;
      return r;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondResolved).toBe(false);

    governor.releaseSlot();
    expect(await secondPromise).toEqual({ kind: "admit" });
    expect(secondResolved).toBe(true);
  });
});

describe("Governor rate-limit recording", () => {
  it("recordRateLimit persists a live-streamed snapshot that a later admit() consults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const governor = build(dir);
    await governor.recordRateLimit({ status: "rejected" });
    expect(await governor.admit(agent(), "trigger")).toEqual({
      kind: "refuse", reason: expect.stringContaining("rate limit"), alert: true,
    });
  });

  it("recordRateLimitError marks the snapshot rejected even with no rate_limit_event to hand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const governor = build(dir);
    await governor.recordRateLimitError();
    const snapshot = await new RateLimitTracker(dir).read();
    expect(snapshot?.status).toBe("rejected");
    expect(snapshot?.resetsAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("recordRateLimitError's cooldown grows on repeated calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const governor = build(dir);
    await governor.recordRateLimitError();
    const first = (await new RateLimitTracker(dir).read())?.resetsAt ?? 0;
    await governor.recordRateLimitError();
    const second = (await new RateLimitTracker(dir).read())?.resetsAt ?? 0;
    expect(second).toBeGreaterThan(first);
  });

  it("a non-rejected recordRateLimit call resets the backoff level", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-gov-"));
    const governor = build(dir);
    await governor.recordRateLimitError();
    await governor.recordRateLimitError();
    await governor.recordRateLimit({ status: "allowed", utilization: 0.1 });
    await governor.recordRateLimitError();
    const afterReset = (await new RateLimitTracker(dir).read())?.resetsAt ?? 0;
    // One error after a reset should back off by the base cooldown (2^1 = 2
    // minutes), not continue compounding from the earlier two errors.
    const now = Math.floor(Date.now() / 1000);
    expect(afterReset).toBeLessThanOrEqual(now + 3 * 60);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/governor.test.ts`
Expected: FAIL — cannot resolve `../src/governor.js`.

- [ ] **Step 3: Write `src/governor.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config, QuietHours } from "./config.js";
import { ConfigOverridesStore, resolveGovernorSettings } from "./config-overrides.js";
import type { AgentDef } from "./registry.js";
import { RunStore } from "./run-store.js";
import { BreakerStore } from "./state/breaker.js";
import { RateLimitTracker } from "./state/rate-limit.js";

export type AdmitResult = { kind: "admit" } | { kind: "refuse"; reason: string; alert: boolean };

function isWithinQuietHours(quietHours: QuietHours, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: quietHours.timezone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")!.value;
  const minute = parts.find((p) => p.type === "minute")!.value;
  const current = `${hour}:${minute}`;
  // Same-day window only (from < to), matching config.yaml's documented examples.
  return current >= quietHours.from && current < quietHours.to;
}

function startOfDay(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export class Governor {
  private readonly dataDir: string;
  private readonly config: Config;
  private readonly store: RunStore;
  private readonly overrides: ConfigOverridesStore;
  private readonly rateLimits: RateLimitTracker;
  private readonly breaker: BreakerStore;
  private readonly now: () => Date;
  private activeSlots = 0;
  private readonly waiters: Array<() => void> = [];
  private consecutiveRateLimitErrors = 0;

  constructor(opts: {
    dataDir: string; config: Config; store: RunStore; overrides: ConfigOverridesStore;
    rateLimits: RateLimitTracker; breaker: BreakerStore; now?: () => Date;
  }) {
    this.dataDir = opts.dataDir;
    this.config = opts.config;
    this.store = opts.store;
    this.overrides = opts.overrides;
    this.rateLimits = opts.rateLimits;
    this.breaker = opts.breaker;
    this.now = opts.now ?? (() => new Date());
  }

  async admit(agent: AgentDef, kind: "trigger" | "resume"): Promise<AdmitResult> {
    if (existsSync(join(this.dataDir, "STOP"))) {
      return { kind: "refuse", reason: "STOP file present; refusing all new runs", alert: false };
    }

    if (kind === "trigger" && (await this.breaker.isTripped(agent.name))) {
      return { kind: "refuse", reason: `circuit breaker tripped for "${agent.name}" (3 consecutive failures)`, alert: true };
    }

    const overrides = await this.overrides.read();
    const settings = resolveGovernorSettings(this.config, overrides);
    const now = this.now();

    if (settings.quietHours && isWithinQuietHours(settings.quietHours, now)) {
      return { kind: "refuse", reason: `quiet hours (${settings.quietHours.from}-${settings.quietHours.to} ${settings.quietHours.timezone})`, alert: false };
    }

    const today = startOfDay(now, settings.quietHours?.timezone ?? "UTC");
    const recent = await this.store.listRecent(10_000);
    const spentToday = recent
      .filter((r) => startOfDay(new Date(r.startedAt), settings.quietHours?.timezone ?? "UTC") === today)
      .reduce((sum, r) => sum + r.costUsd, 0);
    if (spentToday >= settings.dailyBudgetUsd) {
      return { kind: "refuse", reason: `daily budget reached ($${spentToday.toFixed(2)} of $${settings.dailyBudgetUsd})`, alert: true };
    }

    const snapshot = await this.rateLimits.read();
    if (snapshot?.status === "rejected") {
      return { kind: "refuse", reason: `rate limit currently rejected (as of ${snapshot.recordedAt})`, alert: true };
    }

    await this.acquireSlot(settings.maxConcurrent);
    return { kind: "admit" };
  }

  private async acquireSlot(maxConcurrent: number): Promise<void> {
    if (this.activeSlots < maxConcurrent) {
      this.activeSlots += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.activeSlots += 1;
  }

  releaseSlot(): void {
    this.activeSlots -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Called live as a run streams a rate_limit_event — updates the snapshot admit() consults, without waiting for the run to finish. */
  async recordRateLimit(info: { status: "allowed" | "allowed_warning" | "rejected"; rateLimitType?: string; utilization?: number; resetsAt?: number }): Promise<void> {
    await this.rateLimits.record(info, this.now());
    if (info.status !== "rejected") this.consecutiveRateLimitErrors = 0;
  }

  /**
   * Reactive backoff: called when the SDK itself reports a rate_limit error
   * (distinct from recordRateLimit, which reflects the SDK's own live
   * utilization figure — this fires when no such figure caught it in time).
   * Marks the shared snapshot "rejected" so admit() refuses new runs, with a
   * cooldown that doubles per consecutive miss, capped at 30 minutes.
   * consecutiveRateLimitErrors is in-memory only: a restart resets the
   * backoff level but not safety, since the snapshot itself still reads
   * "rejected" until a genuinely fresh non-rejected reading arrives.
   */
  async recordRateLimitError(): Promise<void> {
    this.consecutiveRateLimitErrors += 1;
    const cooldownMinutes = Math.min(2 ** this.consecutiveRateLimitErrors, 30);
    const now = this.now();
    await this.rateLimits.record(
      { status: "rejected", resetsAt: Math.floor(now.getTime() / 1000) + cooldownMinutes * 60 },
      now,
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/governor.test.ts`
Expected: PASS, all tests. Note: the quiet-hours test's UTC offset assumes CEST
(UTC+2) on 2026-08-26, which holds — Central European Summer Time runs
through late October.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/governor.ts tests/governor.test.ts
git commit -m "feat: governor admission control — budgets, quiet hours, breaker, concurrency"
```

---

### Task 10: Wire the governor into the run loop — CHECKPOINT

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/outbox/discord.ts`
- Modify: `src/index.ts`
- Test: `tests/orchestrator.test.ts` (extend)
- Test: `tests/outbox.test.ts` (extend)

**Interfaces:**
- Consumes: `Governor` (Task 9).
- Produces: `Orchestrator`'s constructor gains a required `governor: Governor`; `executeRun` calls `governor.admit(agent, "trigger")` before doing any work and, on refusal, returns without creating a run record; `DiscordOutbox` gains `postAlert(channelKey: string, text: string): Promise<"delivered" | "undelivered">`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/outbox.test.ts` (inside `describe("DiscordOutbox", ...)`):

```ts
  it("postAlert sends raw text and retries/falls back to undelivered the same way post does", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const { instance } = outbox(fetchImpl);
    await expect(instance.postAlert("smoke", "daily budget reached")).resolves.toBe("delivered");
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body);
    expect(body.content).toContain("daily budget reached");
  });
```

Rewrite `tests/orchestrator.test.ts`'s existing setup to inject a `Governor`
(read the current file first to match its exact existing test names before
editing — this step modifies, not replaces, that file). Add these new
tests to it:

```ts
  it("does not execute the runner, and creates no run record, when the governor refuses", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "refuse", reason: "quiet hours", alert: false }), releaseSlot: vi.fn() };
    const runner = new FakeRunner({ events: [] });
    const executeSpy = vi.spyOn(runner, "execute");
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-")));
    const outbox = { post: vi.fn(), postAlert: vi.fn().mockResolvedValue("delivered") };
    const orchestrator = new Orchestrator({ runner, store, outbox: outbox as never, dataDir: store["dataDir"] as never, governor: governor as never });

    const result = await orchestrator.executeRun(AGENT);

    expect(result).toBeUndefined();
    expect(executeSpy).not.toHaveBeenCalled();
    await expect(store.listRecent(10)).resolves.toEqual([]);
  });

  it("posts an alert (not a run report) when the governor's refusal is alert-worthy", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "refuse", reason: "daily budget reached", alert: true }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn(), postAlert: vi.fn().mockResolvedValue("delivered") };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [] }), store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
    });

    await orchestrator.executeRun(AGENT);

    expect(outbox.postAlert).toHaveBeenCalledWith(AGENT.outbox.discord, expect.stringContaining("daily budget reached"));
    expect(outbox.post).not.toHaveBeenCalled();
  });

  it("releases the governor's slot after a successful run", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 }] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
    });

    await orchestrator.executeRun(AGENT);
    expect(governor.releaseSlot).toHaveBeenCalledTimes(1);
  });

  it("releases the governor's slot even when the run throws", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "assistant", text: "a" }], throwAfter: 0 }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
    });

    await orchestrator.executeRun(AGENT);
    expect(governor.releaseSlot).toHaveBeenCalledTimes(1);
  });
```

Read `tests/orchestrator.test.ts` in full before editing to find its
existing `AGENT` fixture, imports, and the STOP-file test (which moves to
`tests/governor.test.ts`'s coverage and should be **removed** from this
file since `Orchestrator` no longer checks `STOP` itself — the governor
does) — remove that one existing test as part of this step, and update
every existing `new Orchestrator({...})` call site in the file to include
a `governor: { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() } as never` field so the rest of the pre-existing suite keeps passing unmodified in behaviour.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/orchestrator.test.ts tests/outbox.test.ts`
Expected: FAIL — `Orchestrator` doesn't accept `governor`; `postAlert` doesn't exist.

- [ ] **Step 3: Implement `postAlert` in `src/outbox/discord.ts`**

Refactor the existing delivery loop into a shared private method first (read
the current file's `post` method to match its exact retry/undelivered logic
before extracting), then add:

```ts
  async postAlert(channelKey: string, text: string): Promise<"delivered" | "undelivered"> {
    return this.deliver(channelKey, text, `alert-${Date.now()}`);
  }
```

where `deliver(channelKey, content, undeliveredFileStem)` is the extracted
body of the existing `post` method's HTTP-send-with-retry loop, parameterised
on the message content string instead of always calling `formatRunMessage`
internally — `post` becomes `deliver(channelKey, formatRunMessage(result, tail), result.runId)`.

- [ ] **Step 4: Implement in `src/orchestrator.ts`**

Add `governor: Governor` to the constructor options and store it. At the
top of `executeRun`, before the existing `STOP` check (which this step
**removes** — the governor now owns that), add:

```ts
  async executeRun(agent: AgentDef, now: Date = new Date()): Promise<RunResult | undefined> {
    const admitted = await this.governor.admit(agent, "trigger");
    if (admitted.kind === "refuse") {
      console.log(`[governor] refused ${agent.name}: ${admitted.reason}`);
      if (admitted.alert) {
        await this.outbox.postAlert(agent.outbox.discord, `⚠️ **${agent.name}** was refused a run: ${admitted.reason}`).catch((err: unknown) => {
          console.error(`[orchestrator] failed to post refusal alert for ${agent.name}`, err);
        });
      }
      return undefined;
    }

    try {
      // ... existing body from `const runId = newRunId(...)` down to the
      // final `return result;`, with the STOP-file block removed entirely
      // (existsSync/join/stopRequested() and its call site).
    } finally {
      this.governor.releaseSlot();
    }
  }
```

Wrap the existing body (everything from `const runId = ...` to `return result;`)
in that `try { } finally { this.governor.releaseSlot(); }`, and delete the
`stopRequested()` private method and its call site entirely — `existsSync`
and the `join` import used only by it can be removed if nothing else in the
file needs them (check before removing `join`, since other lines still use it
for `agent.workspace` and paths).

Update the return type of `executeRun` to `Promise<RunResult | undefined>`
throughout its signature and callers.

- [ ] **Step 5: Update `src/index.ts`**

Construct the new dependencies and pass `governor` to `Orchestrator`:

```ts
import { ConfigOverridesStore } from "./config-overrides.js";
import { Governor } from "./governor.js";
import { BreakerStore } from "./state/breaker.js";
import { RateLimitTracker } from "./state/rate-limit.js";
```

```ts
  const runStore = new RunStore(DATA_DIR);
  const overrides = new ConfigOverridesStore(DATA_DIR);
  const governor = new Governor({
    dataDir: DATA_DIR, config, store: runStore, overrides,
    rateLimits: new RateLimitTracker(DATA_DIR), breaker: new BreakerStore(DATA_DIR),
  });

  const orchestrator = new Orchestrator({
    runner,
    store: runStore,
    outbox: new DiscordOutbox({ config, dataDir: DATA_DIR }),
    dataDir: DATA_DIR,
    governor,
  });
```

Remove the now-inaccurate boot log line `"[boot] governor not yet enforced..."`
and replace it with one reporting the resolved settings:

```ts
  void overrides.read().then((o) => {
    const settings = resolveGovernorSettings(config, o);
    console.log(
      `[boot] governor live: maxConcurrent=${settings.maxConcurrent} dailyBudgetUsd=${settings.dailyBudgetUsd} ` +
        `quietHours=${settings.quietHours ? `${settings.quietHours.from}-${settings.quietHours.to} ${settings.quietHours.timezone}` : "off"}`,
    );
  });
```

(add the `resolveGovernorSettings` import from `./config-overrides.js` alongside `ConfigOverridesStore`.)

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: all pass, including every pre-Task-10 test in `tests/orchestrator.test.ts` (now updated to inject a governor stub) and `tests/cron.test.ts` if one exists (check for it; if present, it drives `Orchestrator` through `startCron` and needs the same governor stub threaded through wherever it constructs an `Orchestrator`).

- [ ] **Step 7: Commit — this is the Milestone A checkpoint**

```bash
git add src/orchestrator.ts src/outbox/discord.ts src/index.ts tests/orchestrator.test.ts tests/outbox.test.ts
git commit -m "feat: wire the governor into the run loop (budgets/concurrency/quiet-hours now live)"
```

At this commit: every existing agent still runs exactly as before when
nothing is blocking it; a governor refusal now stops a run before it starts
instead of the STOP-file-only check; `!quiet`/`!budget`/`!concurrency` have
no UI yet (Task 15) but the settings they'd change are already read from
`config-overrides.json` if present. Tiers/grants/park/resume/Discord are
still entirely unbuilt. This is a safe point to stop, review, and merge
independently of the rest of the plan.

---

## Milestone B — Grant enforcement, park/resume, and the Discord bot

### Task 11: Probe — confirm `canUseTool`'s `interrupt: true` actually stops a run

**Files:**
- Create: `scripts/probe-canusetool.ts`

This is a spike, not a TDD task — there is no test to write, because its
entire purpose is finding out whether an assumption in the spec
(§3.3: a `PermissionResult` of `{ behavior: "deny", interrupt: true }` stops
the whole run, not just the one tool call) holds against the real SDK before
Task 12 builds on it.

- [ ] **Step 1: Write the probe**

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCredentials } from "../src/runner/credentials.js";

const { childEnv } = resolveCredentials();
let sawToolAttempt = false;
let sawAnythingAfterDenial = false;

for await (const message of query({
  prompt: "Run the Bash command `echo outward-effect-probe` right now.",
  options: {
    model: "claude-haiku-4-5",
    maxTurns: 5,
    allowedTools: ["Bash"],
    tools: ["Bash"],
    env: childEnv,
    permissionMode: "default",
    settingSources: [],
    canUseTool: async (toolName) => {
      sawToolAttempt = true;
      console.log(`canUseTool called for ${toolName} — denying with interrupt: true`);
      return { behavior: "deny", message: "probe: denying to test interrupt", interrupt: true };
    },
  },
})) {
  const record = message as Record<string, unknown>;
  if (sawToolAttempt) sawAnythingAfterDenial = true;
  console.log(record.type, "→", JSON.stringify(message).slice(0, 300));
}

console.log("\n--- probe result ---");
console.log("canUseTool was called:", sawToolAttempt);
console.log("stream continued after the deny (expected: minimal/none if interrupt works):", sawAnythingAfterDenial);
```

- [ ] **Step 2: Run it against the real SDK**

Run: `npm run probe:canusetool` (add the script `"probe:canusetool": "tsx scripts/probe-canusetool.ts"` to `package.json`'s `scripts`, alongside the existing `"probe"`)

Expected: `canUseTool was called: true`. Read the printed message stream —
confirm the run stops promptly after the denial (a `result` message with a
subtype indicating an aborted/interrupted turn, and no further `tool_use`
retries of the same command) rather than the agent quietly trying something
else and continuing to a normal `success`. Task 12's `canUseTool` already
calls the query's own `abortController.abort()` directly rather than relying
on the `interrupt` flag alone, specifically so this probe's outcome is a
sanity check, not a blocking dependency — but if the run does NOT stop even
with an explicit abort, that's a more serious finding worth flagging loudly
before Task 12 proceeds: it would mean the SDK's `resume` option (§5.3,
Task 13) may also need re-verification, since resuming assumes the prior
session ended in a clean, well-defined stopped state.

- [ ] **Step 3: Commit the probe script regardless of outcome**

```bash
git add scripts/probe-canusetool.ts package.json
git commit -m "chore: probe script confirming canUseTool's interrupt behaviour"
```

---

### Task 12: Wire `canUseTool` and the `AskHuman` tool into `SdkRunner`

**Files:**
- Modify: `src/runner/sdk-runner.ts`
- Test: `tests/sdk-runner-options.test.ts` (extend)

**Interfaces:**
- Consumes: `decide` from `src/grants.ts` (Task 4); `PendingStore` from `src/control/pending.ts` (Task 5); `Grant` from `src/grants.ts`.
- Produces: `SdkRunner`'s constructor becomes `new SdkRunner(opts: { grants: Grant[]; pending: PendingStore })`; `execute` now installs `canUseTool` and an `AskHuman` MCP tool; on a park/deny decision it writes a pending entry (approval) or has already written one (question — the `AskHuman` handler itself calls `pending.create`), yields the corresponding terminal `RunEvent` (`"parked"` or `"denied"`), and returns.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sdk-runner-options.test.ts`:

```ts
import { PendingStore } from "../src/control/pending.js";
import type { Grant } from "../src/grants.js";

const TEST_ECHO: Grant = { id: "test-echo", kind: "http", method: "POST", urlPattern: "https://httpbin.org/post", secret: "X" };

function sdkRunnerWith(grants: Grant[], pendingDir: string) {
  return new SdkRunner({ grants, pending: new PendingStore(pendingDir) });
}

describe("SdkRunner grant enforcement", () => {
  it("passes a canUseTool function and the AskHuman tool's MCP server to the SDK", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const granted = { ...AGENT, tier: "granted", grantRefs: ["test-echo"], approval: "notify" } as unknown as AgentDef;
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(sdkRunnerWith([TEST_ECHO], dir).execute(granted, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueryParams & { options: { canUseTool: unknown; mcpServers: Record<string, unknown> } };
    expect(typeof params.options.canUseTool).toBe("function");
    expect(params.options.mcpServers.askHuman).toBeDefined();
  });

  it("parks and writes a pending entry when canUseTool sees a matching-grant effect on a granted agent", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const granted = { ...AGENT, tier: "granted", grantRefs: ["test-echo"], approval: "notify" } as unknown as AgentDef;
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(sdkRunnerWith([TEST_ECHO], dir).execute(granted, CTX, new AbortController().signal));

    const params = queryMock.mock.calls[0]![0] as { options: { canUseTool: (name: string, input: Record<string, unknown>, opts: { signal: AbortSignal; toolUseID: string }) => Promise<unknown> } };
    const decision = await params.options.canUseTool("WebFetch", { url: "https://httpbin.org/post" }, { signal: new AbortController().signal, toolUseID: "t1" } as never);

    expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
    const pending = new PendingStore(dir);
    const entries = await pending.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: CTX.runId, agentName: granted.name, kind: "approval", grantRef: "test-echo" });
  });

  it("denies without parking when no grant matches", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const granted = { ...AGENT, tier: "granted", grantRefs: [], approval: "notify" } as unknown as AgentDef;
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(sdkRunnerWith([TEST_ECHO], dir).execute(granted, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as { options: { canUseTool: (name: string, input: Record<string, unknown>, opts: unknown) => Promise<unknown> } };

    const decision = await params.options.canUseTool("WebFetch", { url: "https://httpbin.org/post" }, { signal: new AbortController().signal, toolUseID: "t1" });
    expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
    expect(await new PendingStore(dir).list()).toEqual([]);
  });

  it("allows a call with no outward effect", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    await collect(sdkRunnerWith([], dir).execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as { options: { canUseTool: (name: string, input: Record<string, unknown>, opts: unknown) => Promise<unknown> } };
    const decision = await params.options.canUseTool("Read", { file_path: "notes.md" }, { signal: new AbortController().signal, toolUseID: "t1" });
    expect(decision).toEqual({ behavior: "allow" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/sdk-runner-options.test.ts`
Expected: FAIL — `SdkRunner` doesn't take a constructor argument; `canUseTool`/`mcpServers` absent from options.

- [ ] **Step 3: Implement in `src/runner/sdk-runner.ts`**

```ts
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { PendingStore } from "../control/pending.js";
import { decide, type Grant } from "../grants.js";
```

Replace the class:

```ts
export class SdkRunner implements Runner {
  constructor(private readonly deps: { grants: Grant[]; pending: PendingStore } = { grants: [], pending: new PendingStore(process.cwd()) }) {}

  async *execute(
    agent: AgentDef,
    ctx: RunContext,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    const { childEnv } = resolveCredentials();
    const controller = new AbortController();
    linkAbort(signal, controller);

    let sessionId = "";
    let terminalEvent: RunEvent | undefined;

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string; interrupt?: boolean }> => {
      const decision = decide(agent, this.deps.grants, toolName, input);
      if (decision.kind === "allow") return { behavior: "allow" };

      if (decision.kind === "deny") {
        terminalEvent = { type: "denied", reason: decision.reason };
        controller.abort();
        return { behavior: "deny", message: decision.reason, interrupt: true };
      }

      const entry = await this.deps.pending.create({
        runId: ctx.runId, agentName: agent.name, sessionId,
        kind: "approval", effect: decision.effect, grantRef: decision.grantRef,
      });
      terminalEvent = { type: "parked", kind: "approval", pendingId: entry.id };
      controller.abort();
      return { behavior: "deny", message: `parked for approval: ${decision.effect}`, interrupt: true };
    };

    const askHumanServer = createSdkMcpServer({
      name: "askHuman",
      tools: [
        tool(
          "AskHuman",
          "Ask the owner a free-text question and stop this run until they answer. Use this when you're blocked on information only the owner can provide.",
          { question: z.string().min(1) },
          async ({ question }) => {
            const entry = await this.deps.pending.create({
              runId: ctx.runId, agentName: agent.name, sessionId, kind: "question", question,
            });
            terminalEvent = { type: "parked", kind: "question", pendingId: entry.id };
            controller.abort();
            return { content: [{ type: "text", text: "Waiting for the owner's answer." }] };
          },
        ),
      ],
    });

    const stream = query({
      prompt: ctx.prompt,
      options: {
        model: agent.run.model,
        effort: agent.run.effort,
        maxTurns: agent.run.maxTurns,
        maxBudgetUsd: agent.run.maxBudgetUsd,
        cwd: ctx.workspace,
        allowedTools: agent.permissions.allowedTools,
        disallowedTools: agent.permissions.disallowedTools,
        tools: agent.permissions.allowedTools,
        permissionMode: "default",
        settingSources: [],
        env: childEnv,
        abortController: controller,
        canUseTool,
        mcpServers: { askHuman: askHumanServer },
      },
    });

    let partial: PartialUsage = { inputTokens: 0, outputTokens: 0 };
    let sawTerminalUsage = false;

    for await (const message of stream) {
      const record = message as Record<string, unknown>;
      if (typeof record.session_id === "string") sessionId = record.session_id;

      partial = accumulateUsage(partial, message);
      const events = toRunEvents(message);
      if (events.some((e) => e.type === "usage")) sawTerminalUsage = true;
      yield* events;

      if (signal.aborted) {
        if (!sawTerminalUsage && (partial.inputTokens > 0 || partial.outputTokens > 0)) {
          yield {
            type: "usage", inputTokens: partial.inputTokens, outputTokens: partial.outputTokens,
            costUsd: estimateCostUsd(agent.run.model, partial.inputTokens, partial.outputTokens), durationMs: 0,
          };
        }
        if (terminalEvent) yield terminalEvent;
        return;
      }
    }
  }
}
```

- [ ] **Step 4: Update the two existing call sites that construct `SdkRunner` with no arguments**

`src/runner/build-runner.ts` currently reads:

```ts
export function buildRunner(env: NodeJS.ProcessEnv = process.env): Runner {
  if (env.RUNNER === "fake") {
    console.log("[boot] RUNNER=fake — no subscription quota will be consumed");
    return new FakeRunner({ /* ... */ });
  }
  return new SdkRunner();
}
```

Change its signature to take the new dependencies as a required first
parameter, `env` moving to a defaulted second parameter (every existing
call site already passes `env` explicitly, so nothing relies on omitting
it):

```ts
import type { Grant } from "../grants.js";
import type { PendingStore } from "../control/pending.js";

export function buildRunner(
  opts: { grants: Grant[]; pending: PendingStore },
  env: NodeJS.ProcessEnv = process.env,
): Runner {
  if (env.RUNNER === "fake") {
    console.log("[boot] RUNNER=fake — no subscription quota will be consumed");
    return new FakeRunner({
      events: [
        { type: "assistant", text: "Fake run: the pipeline is working." },
        { type: "usage", inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1 },
      ],
    });
  }
  return new SdkRunner(opts);
}
```

Rewrite `tests/build-runner.test.ts` in full to match the new signature:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingStore } from "../src/control/pending.js";
import { buildRunner } from "../src/runner/build-runner.js";
import { FakeRunner } from "../src/runner/fake-runner.js";
import { SdkRunner } from "../src/runner/sdk-runner.js";

afterEach(() => vi.restoreAllMocks());

function opts() {
  return { grants: [], pending: new PendingStore(mkdtempSync(join(tmpdir(), "cai-buildrunner-"))) };
}

describe("buildRunner", () => {
  it("returns the real runner by default: the fake is the opt-in, not the other way round", () => {
    expect(buildRunner(opts(), {})).toBeInstanceOf(SdkRunner);
  });

  it("returns the fake runner only when RUNNER=fake", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(buildRunner(opts(), { RUNNER: "fake" })).toBeInstanceOf(FakeRunner);
    expect(log.mock.calls.flat().join(" ")).toContain("no subscription quota");
  });

  it("does not treat some other RUNNER value as the fake", () => {
    expect(buildRunner(opts(), { RUNNER: "sdk" })).toBeInstanceOf(SdkRunner);
    expect(buildRunner(opts(), { RUNNER: "" })).toBeInstanceOf(SdkRunner);
  });

  it("passes the grants and pending store through to the real runner's constructor", () => {
    const { grants, pending } = opts();
    const runner = buildRunner({ grants, pending }, {}) as SdkRunner;
    expect(runner).toBeInstanceOf(SdkRunner);
  });
});
```

Update `src/index.ts`'s call to `buildRunner(...)` to pass
`buildRunner({ grants: loadGrants(join(ROOT, "grants.yaml")), pending: new PendingStore(DATA_DIR) })`
(dropping the old single-argument `buildRunner()` call; `env` defaults),
importing `loadGrants` from `./grants.js` and `PendingStore` from `./control/pending.js`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/sdk-runner-options.test.ts tests/build-runner.test.ts`
Expected: PASS, all tests in both files.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/runner/sdk-runner.ts src/runner/build-runner.ts src/index.ts tests/sdk-runner-options.test.ts tests/build-runner.test.ts
git commit -m "feat: wire canUseTool grant enforcement and the AskHuman tool into SdkRunner"
```

---

### Task 13: Orchestrator resume path and boot reconciliation

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/index.ts`
- Test: `tests/orchestrator.test.ts` (extend)

**Interfaces:**
- Consumes: `PendingStore`, `PendingEntry` (Task 5); `parked`/`denied`/`rate_limit_event` `RunEvent`s and `RunStatus` values (Task 6); `Governor.recordRateLimit`/`recordRateLimitError` (Task 9).
- Produces: `Orchestrator`'s event loop now recognises `"parked"` and `"denied"` as terminal, non-error outcomes, setting `RunStatus` to `"parked"`/`"question"`/`"denied"` accordingly, and feeds every `"rate_limit_event"` seen (and any `"error"` event whose message contains `"rate_limit"`) to the governor live as the stream runs, not only after the run finishes; `Orchestrator` gains `resumeRun(entry: PendingEntry, decision: { approved: boolean } | { answer: string }): Promise<RunResult | undefined>`, which calls `governor.admit(agent, "resume")` then the runner with `{ resume: entry.sessionId }` and the decision injected as the prompt.

- [ ] **Step 1: Write the failing tests**

Append to `tests/orchestrator.test.ts`:

```ts
  it("records status 'parked' (not 'failed') when the runner emits a parked event, and does not treat it as an error", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "parked", kind: "approval", pendingId: "p1" }] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
    });
    const result = await orchestrator.executeRun(AGENT);
    expect(result?.status).toBe("parked");
    expect(result?.error).toBeUndefined();
  });

  it("records status 'question' when the runner emits a parked event with kind question", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "parked", kind: "question", pendingId: "p1" }] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
    });
    const result = await orchestrator.executeRun(AGENT);
    expect(result?.status).toBe("question");
  });

  it("records status 'denied' when the runner emits a denied event", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "denied", reason: "no grant matches" }] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
    });
    const result = await orchestrator.executeRun(AGENT);
    expect(result?.status).toBe("denied");
    expect(result?.error).toContain("no grant matches");
  });

  it("resumeRun asks the governor with kind 'resume' and calls the runner with the session id", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const runner = new FakeRunner({ events: [{ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 }] });
    const executeSpy = vi.spyOn(runner, "execute");
    const orchestrator = new Orchestrator({
      runner, store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
    });

    await orchestrator.resumeRun(
      { id: "p1", runId: "smoke-1", agentName: AGENT.name, sessionId: "sess-abc", kind: "approval", effect: "x", grantRef: "g", askedAt: new Date().toISOString() },
      { approved: true },
      AGENT,
    );

    expect(governor.admit).toHaveBeenCalledWith(AGENT, "resume");
    const ctxArg = executeSpy.mock.calls[0]![1] as { resume?: string };
    expect(ctxArg.resume).toBe("sess-abc");
  });

  it("feeds a rate_limit_event seen mid-run to the governor live, not only after the run finishes", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn(), recordRateLimit: vi.fn(), recordRateLimitError: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [
        { type: "rate_limit_event", status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.91 },
        { type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 },
      ] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
    });
    await orchestrator.executeRun(AGENT);
    expect(governor.recordRateLimit).toHaveBeenCalledWith({
      status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.91, resetsAt: undefined,
    });
  });

  it("calls the governor's reactive backoff when an assistant error reports rate_limit", async () => {
    const governor = { admit: vi.fn().mockResolvedValue({ kind: "admit" }), releaseSlot: vi.fn(), recordRateLimit: vi.fn(), recordRateLimitError: vi.fn() };
    const outbox = { post: vi.fn().mockResolvedValue("delivered"), postAlert: vi.fn() };
    const orchestrator = new Orchestrator({
      runner: new FakeRunner({ events: [{ type: "error", message: "assistant message reported error: rate_limit" }] }),
      store: new RunStore(mkdtempSync(join(tmpdir(), "cai-orch-"))),
      outbox: outbox as never, dataDir: "unused", governor: governor as never,
    });
    await orchestrator.executeRun(AGENT);
    expect(governor.recordRateLimitError).toHaveBeenCalledTimes(1);
  });
```

Note: `resumeRun` needs `RunContext` (`src/runner/types.ts`) to carry an
optional `resume?: string` field, and `Runner.execute`'s real implementation
(`SdkRunner`) needs to pass it through as the SDK's own `resume` option —
add both as part of this task.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/orchestrator.test.ts`
Expected: FAIL — `"parked"` currently falls through the existing `event.type === "error"` check untouched, so `result.status` stays `"success"` (wrong); `resumeRun` doesn't exist.

- [ ] **Step 3: Extend `RunContext` in `src/runner/types.ts`**

```ts
export interface RunContext {
  runId: string;
  workspace: string;
  prompt: string;
  resume?: string;
}
```

- [ ] **Step 4: Pass `resume` through in `src/runner/sdk-runner.ts`**

In the `query({ ... options: { ... } })` call built in Task 12, add:

```ts
        ...(ctx.resume ? { resume: ctx.resume } : {}),
```

- [ ] **Step 5: Implement in `src/orchestrator.ts`**

In the event loop inside `executeRun`, change the error-detection block to
also recognise the two new terminal event types:

```ts
      for await (const event of stream) {
        await writer.append(event);
        if (event.type === "error" && (status as RunStatus) !== "timeout") {
          status = "failed";
          error = event.message;
        }
        if (event.type === "denied" && (status as RunStatus) !== "timeout") {
          status = "denied";
          error = event.reason;
        }
        if (event.type === "parked" && (status as RunStatus) !== "timeout") {
          status = event.kind === "question" ? "question" : "parked";
        }
        // Feed the governor's shared rate-limit snapshot live, from every
        // run's stream, not only the triggering agent's own admission check
        // — it's one subscription-wide limit (spec §4.5).
        if (event.type === "rate_limit_event") {
          await this.governor.recordRateLimit({
            status: event.status, rateLimitType: event.rateLimitType,
            utilization: event.utilization, resetsAt: event.resetsAt,
          });
        }
        if (event.type === "error" && event.message.includes("rate_limit")) {
          await this.governor.recordRateLimitError();
        }
      }
```

Add `resumeRun`, sharing as much as possible with `executeRun` by extracting
the common "run the runner, stream to a writer, classify the outcome"
portion into a private `runAndRecord` method both call — read the current
full body of `executeRun` first, then factor it as:

```ts
  async resumeRun(
    entry: PendingEntry,
    decision: { approved: boolean } | { answer: string },
    agent: AgentDef,
  ): Promise<RunResult | undefined> {
    const admitted = await this.governor.admit(agent, "resume");
    if (admitted.kind === "refuse") {
      console.log(`[governor] refused resume of ${entry.runId}: ${admitted.reason}`);
      return undefined;
    }
    const prompt = "approved" in decision
      ? (decision.approved ? "Approved. Continue." : "Denied. Do not attempt that action; continue with anything else you can, or stop.")
      : decision.answer;

    try {
      return await this.runAndRecord(agent, entry.runId, { runId: entry.runId, workspace: agent.workspace, prompt, resume: entry.sessionId });
    } finally {
      this.governor.releaseSlot();
    }
  }
```

Factor `executeRun`'s post-admission body (everything from `const runId = newRunId(...)` onward) into `private async runAndRecord(agent: AgentDef, runId: string, ctx: RunContext): Promise<RunResult>`, and have `executeRun` call `await this.runAndRecord(agent, newRunId(agent.name, now), { runId, workspace: agent.workspace, prompt })` inside its own `try`/`finally`.

Import `PendingEntry` from `./control/pending.js`.

- [ ] **Step 6: Run the tests, then the full suite**

Run: `npm test -- tests/orchestrator.test.ts && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Boot reconciliation in `src/index.ts`**

After constructing `orchestrator`, before starting cron:

```ts
  const pending = new PendingStore(DATA_DIR);
  void pending.reconcile({ timeoutHours: (await overrides.read()).dailyBudgetUsd ? config.governor.pendingTimeoutHours : config.governor.pendingTimeoutHours }).then(({ expired, active }) => {
    for (const entry of expired) {
      console.log(`[pending] expired (auto-denied): ${entry.id} for ${entry.agentName}`);
    }
    console.log(`[pending] ${active.length} awaiting a response after startup`);
  });
```

(Task 15's bot is what actually re-posts `active` entries to Discord — this
step only logs, since the bot doesn't exist yet. Task 15 replaces this
`.then()` body with a real re-post call.)

- [ ] **Step 8: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/orchestrator.ts src/runner/types.ts src/runner/sdk-runner.ts src/index.ts tests/orchestrator.test.ts
git commit -m "feat: orchestrator resume path and boot-time pending reconciliation"
```

---

### Task 14: Discord bot — connection, transport, approvals, and questions

**Files:**
- Create: `src/control/bot.ts`
- Modify: `package.json` (add `discord.js`)
- Modify: `.env.example`
- Test: `tests/bot.test.ts`

**Interfaces:**
- Consumes: `PendingStore`/`PendingEntry` (Task 5); `Orchestrator.resumeRun` (Task 13); `AgentDef[]` (registry).
- Produces: `interface BotTransport { onMessage(handler: (msg: { channelId: string; authorId: string; content: string }) => Promise<void>): void; send(channelId: string, text: string): Promise<{ messageId: string }>; start(): Promise<void>; stop(): Promise<void> }`; class `FakeBotTransport implements BotTransport` (test double, exported alongside the real one for reuse in Task 15's tests); class `DiscordBot` constructed as `new DiscordBot(opts: { transport: BotTransport; pending: PendingStore; orchestrator: Orchestrator; agents: AgentDef[]; channelFor: (agentName: string) => string })` with `postApproval(entry: PendingEntry): Promise<void>`, `postQuestion(entry: PendingEntry): Promise<void>`, `start(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `tests/bot.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DiscordBot, FakeBotTransport } from "../src/control/bot.js";
import { PendingStore } from "../src/control/pending.js";
import type { AgentDef } from "../src/registry.js";

const AGENTS = [{ name: "smoke", workspace: "/ws/smoke" } as AgentDef];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-bot-"));
  const pending = new PendingStore(dataDir);
  const transport = new FakeBotTransport();
  const orchestrator = { resumeRun: vi.fn().mockResolvedValue({ status: "success" }) };
  const bot = new DiscordBot({
    transport, pending, orchestrator: orchestrator as never, agents: AGENTS,
    channelFor: () => "smoke-channel",
  });
  return { dataDir, pending, transport, orchestrator, bot };
}

describe("DiscordBot", () => {
  it("posts an approval prompt naming the agent, the effect, and the grant", async () => {
    const { pending, transport, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "fetch https://httpbin.org/post", grantRef: "test-echo" });
    await bot.postApproval(entry);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.channelId).toBe("smoke-channel");
    expect(transport.sent[0]!.text).toContain("smoke");
    expect(transport.sent[0]!.text).toContain("fetch https://httpbin.org/post");
    expect(transport.sent[0]!.text).toContain("test-echo");
    expect(transport.sent[0]!.text).toContain(entry.id);
  });

  it("posts a question prompt with the agent's question text", async () => {
    const { pending, transport, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "question", question: "Which branch?" });
    await bot.postQuestion(entry);
    expect(transport.sent[0]!.text).toContain("Which branch?");
  });

  it("a reply of 'approve <id>' resolves the pending entry and resumes with approved: true", async () => {
    const { pending, transport, orchestrator, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    await bot.start();

    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `approve ${entry.id}` });

    expect(orchestrator.resumeRun).toHaveBeenCalledWith(entry, { approved: true }, AGENTS[0]);
    expect(await pending.get(entry.id)).toBeNull();
  });

  it("a reply of 'deny <id>' resumes with approved: false", async () => {
    const { pending, transport, orchestrator, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `deny ${entry.id}` });
    expect(orchestrator.resumeRun).toHaveBeenCalledWith(entry, { approved: false }, AGENTS[0]);
  });

  it("a reply of 'answer <id> <text>' resumes a question with that free text", async () => {
    const { pending, transport, orchestrator, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "question", question: "Which branch?" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `answer ${entry.id} use main` });
    expect(orchestrator.resumeRun).toHaveBeenCalledWith(entry, { answer: "use main" }, AGENTS[0]);
  });

  it("ignores a message that doesn't reference a known pending id", async () => {
    const { transport, orchestrator, bot } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "approve not-a-real-id" });
    expect(orchestrator.resumeRun).not.toHaveBeenCalled();
  });

  it("ignores a plain, unrelated message without erroring", async () => {
    const { transport, orchestrator, bot } = setup();
    await bot.start();
    await expect(transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "just chatting" })).resolves.not.toThrow();
    expect(orchestrator.resumeRun).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/bot.test.ts`
Expected: FAIL — cannot resolve `../src/control/bot.js`.

- [ ] **Step 3: Add `discord.js`**

```bash
npm install discord.js@^14.27.0
```

- [ ] **Step 4: Write `src/control/bot.ts`**

```ts
import type { PendingEntry } from "./pending.js";
import type { PendingStore } from "./pending.js";
import type { AgentDef } from "../registry.js";

export interface IncomingMessage {
  channelId: string;
  authorId: string;
  content: string;
}

export interface BotTransport {
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  send(channelId: string, text: string): Promise<{ messageId: string }>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Test double: records everything sent, and lets a test inject an incoming message without a real Discord connection. */
export class FakeBotTransport implements BotTransport {
  sent: { channelId: string; text: string }[] = [];
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(channelId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ channelId, text });
    return { messageId: `fake-${this.sent.length}` };
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async simulateMessage(msg: IncomingMessage): Promise<void> {
    if (this.handler) await this.handler(msg);
  }
}

interface ResumeCapableOrchestrator {
  resumeRun(entry: PendingEntry, decision: { approved: boolean } | { answer: string }, agent: AgentDef): Promise<unknown>;
}

export class DiscordBot {
  private readonly transport: BotTransport;
  private readonly pending: PendingStore;
  private readonly orchestrator: ResumeCapableOrchestrator;
  private readonly agents: AgentDef[];
  private readonly channelFor: (agentName: string) => string;

  constructor(opts: {
    transport: BotTransport; pending: PendingStore; orchestrator: ResumeCapableOrchestrator;
    agents: AgentDef[]; channelFor: (agentName: string) => string;
  }) {
    this.transport = opts.transport;
    this.pending = opts.pending;
    this.orchestrator = opts.orchestrator;
    this.agents = opts.agents;
    this.channelFor = opts.channelFor;
  }

  async postApproval(entry: PendingEntry): Promise<void> {
    await this.transport.send(
      this.channelFor(entry.agentName),
      `🔔 **${entry.agentName}** wants to: ${entry.effect}\nGrant: \`${entry.grantRef}\`\n\nReply \`approve ${entry.id}\` or \`deny ${entry.id}\`.`,
    );
  }

  async postQuestion(entry: PendingEntry): Promise<void> {
    await this.transport.send(
      this.channelFor(entry.agentName),
      `❓ **${entry.agentName}** asks: ${entry.question}\n\nReply \`answer ${entry.id} <your answer>\`.`,
    );
  }

  async start(): Promise<void> {
    this.transport.onMessage(async (msg) => {
      const approve = msg.content.match(/^approve\s+(\S+)/i);
      const deny = msg.content.match(/^deny\s+(\S+)/i);
      const answer = msg.content.match(/^answer\s+(\S+)\s+([\s\S]+)/i);

      const id = approve?.[1] ?? deny?.[1] ?? answer?.[1];
      if (!id) return;

      const entry = await this.pending.get(id);
      if (!entry) return;

      const agent = this.agents.find((a) => a.name === entry.agentName);
      if (!agent) return;

      await this.pending.resolve(id);

      if (approve) {
        await this.orchestrator.resumeRun(entry, { approved: true }, agent);
      } else if (deny) {
        await this.orchestrator.resumeRun(entry, { approved: false }, agent);
      } else if (answer) {
        await this.orchestrator.resumeRun(entry, { answer: answer[2]!.trim() }, agent);
      }
    });
    await this.transport.start();
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/bot.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Add the Discord bot token to `.env.example`**

```bash
# Real two-way Discord bot (Plan B): create an Application + Bot at
# https://discord.com/developers/applications, enable the "Message Content"
# privileged intent under Bot settings, and invite it to your server with
# the `bot` scope. Paste the bot token here (never the webhook URL above).
DISCORD_BOT_TOKEN=
```

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/control/bot.ts package.json package-lock.json .env.example tests/bot.test.ts
git commit -m "feat: Discord bot — approvals, questions, and a fake transport for tests"
```

---

### Task 15: Real Discord transport, admin commands, and boot wiring

**Files:**
- Create: `src/control/discord-transport.ts`
- Modify: `src/control/bot.ts`
- Modify: `src/config-overrides.ts` (no interface change; consumed by commands)
- Modify: `src/index.ts`
- Test: `tests/bot.test.ts` (extend)

**Interfaces:**
- Produces: class `DiscordJsTransport implements BotTransport` (the only file importing `discord.js`, mirroring how `sdk-runner.ts` is the only file importing the Agent SDK), constructed as `new DiscordJsTransport(opts: { token: string })`. `DiscordBot.start()` additionally handles admin commands: `!runs`, `!stop`, `!resume`, `!disable <agent>`, `!enable <agent>`, `!quiet`, `!quiet <from>-<to>`, `!quiet off`, `!budget <n>`, `!concurrency <n>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/bot.test.ts` (extend `setup()` to also construct a
`RunStore`, `ConfigOverridesStore`, and a `BreakerStore` over `dataDir`, and
pass them into `DiscordBot`'s constructor — add those three as new required
constructor fields: `store: RunStore`, `overrides: ConfigOverridesStore`,
`breaker: BreakerStore`, plus `dataDir: string` for the `STOP` file and
`disabledAgents: Set<string>` mutation via `overrides`):

```ts
  it("!budget <n> updates the override and echoes the new value", async () => {
    const { transport, bot } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!budget 25" });
    expect(transport.sent.some((m) => m.text.includes("25"))).toBe(true);
  });

  it("!quiet off disables quiet hours", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!quiet off" });
    expect((await overrides.read()).quietHours).toBeNull();
  });

  it("!stop creates the STOP file; !resume removes it", async () => {
    const { transport, bot, dataDir } = setup();
    await bot.start();
    const { existsSync } = await import("node:fs");
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!stop" });
    expect(existsSync(join(dataDir, "STOP"))).toBe(true);
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!resume" });
    expect(existsSync(join(dataDir, "STOP"))).toBe(false);
  });

  it("!disable <agent> and !enable <agent> update disabledAgents", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!disable smoke" });
    expect((await overrides.read()).disabledAgents).toEqual(["smoke"]);
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!enable smoke" });
    expect((await overrides.read()).disabledAgents ?? []).toEqual([]);
  });

  it("!runs reports the most recent runs", async () => {
    const { transport, bot, store } = setup();
    const writer = await store.open("smoke-run-1", "smoke");
    await writer.close({ status: "success", summary: "did the thing" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!runs" });
    expect(transport.sent.some((m) => m.text.includes("smoke-run-1"))).toBe(true);
  });
```

Update `setup()` in the same file to build and pass the new dependencies
(`RunStore`, `ConfigOverridesStore`, `BreakerStore`, `dataDir`), and export
those under `{ ..., store, overrides, breaker, dataDir }` from `setup()`'s
return value.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/bot.test.ts`
Expected: FAIL — `DiscordBot` doesn't recognise `!` commands yet; constructor doesn't accept the new fields.

- [ ] **Step 3: Extend `src/control/bot.ts`**

Add the new constructor fields and command handling inside `start()`'s
message handler, before the `approve`/`deny`/`answer` matching (so a `!`
command never gets misread as a pending-id reply):

```ts
  constructor(opts: {
    transport: BotTransport; pending: PendingStore; orchestrator: ResumeCapableOrchestrator;
    agents: AgentDef[]; channelFor: (agentName: string) => string;
    store: RunStore; overrides: ConfigOverridesStore; breaker: BreakerStore; dataDir: string;
  }) {
    // ...existing assignments, plus:
    this.store = opts.store;
    this.overrides = opts.overrides;
    this.breaker = opts.breaker;
    this.dataDir = opts.dataDir;
  }
```

```ts
    this.transport.onMessage(async (msg) => {
      if (msg.content.startsWith("!")) return this.handleCommand(msg);
      // ...existing approve/deny/answer handling
    });
```

```ts
  private async handleCommand(msg: IncomingMessage): Promise<void> {
    const [command, ...rest] = msg.content.trim().split(/\s+/);
    const arg = rest.join(" ");
    const reply = (text: string) => this.transport.send(msg.channelId, text);

    switch (command) {
      case "!stop": {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(join(this.dataDir, "STOP"), "");
        return void reply("🛑 STOP file set. No new runs until `!resume`.");
      }
      case "!resume": {
        const { rmSync } = await import("node:fs");
        rmSync(join(this.dataDir, "STOP"), { force: true });
        return void reply("▶️ STOP file cleared. Runs resume on the next trigger.");
      }
      case "!disable": {
        const overrides = await this.overrides.read();
        const disabled = new Set(overrides.disabledAgents ?? []);
        disabled.add(arg);
        await this.overrides.set("disabledAgents", [...disabled], "discord");
        return void reply(`⏸️ ${arg} disabled.`);
      }
      case "!enable": {
        const overrides = await this.overrides.read();
        const disabled = new Set(overrides.disabledAgents ?? []);
        disabled.delete(arg);
        await this.overrides.set("disabledAgents", [...disabled], "discord");
        await this.breaker.reset(arg);
        return void reply(`▶️ ${arg} enabled.`);
      }
      case "!budget": {
        const value = Number(arg);
        if (!Number.isFinite(value) || value <= 0) return void reply(`Not a valid budget: "${arg}"`);
        await this.overrides.set("dailyBudgetUsd", value, "discord");
        return void reply(`💰 Daily budget set to $${value}.`);
      }
      case "!concurrency": {
        const value = Number(arg);
        if (!Number.isInteger(value) || value <= 0) return void reply(`Not a valid concurrency: "${arg}"`);
        await this.overrides.set("maxConcurrent", value, "discord");
        return void reply(`🔀 Concurrency set to ${value}.`);
      }
      case "!quiet": {
        if (arg === "off") {
          await this.overrides.set("quietHours", null, "discord");
          return void reply("🔕 Quiet hours disabled.");
        }
        const match = arg.match(/^(\d\d:\d\d)-(\d\d:\d\d)\s+(\S+)$/);
        if (!match) return void reply('Usage: `!quiet HH:MM-HH:MM Area/City` or `!quiet off`');
        await this.overrides.set("quietHours", { from: match[1]!, to: match[2]!, timezone: match[3]! }, "discord");
        return void reply(`🌙 Quiet hours set to ${match[1]}-${match[2]} ${match[3]}.`);
      }
      case "!runs": {
        const recent = await this.store.listRecent(20);
        const lines = recent.map((r) => `${r.runId} — ${r.status} — $${r.costUsd.toFixed(4)}`);
        return void reply(lines.length > 0 ? lines.join("\n") : "No runs yet.");
      }
      default:
        return void reply(`Unknown command: ${command}`);
    }
  }
```

Add the corresponding imports at the top of `bot.ts`:
`import { join } from "node:path";`, `import type { RunStore } from "../run-store.js";`,
`import type { ConfigOverridesStore } from "../config-overrides.js";`,
`import type { BreakerStore } from "../state/breaker.js";`, and add the four
new private readonly fields (`store`, `overrides`, `breaker`, `dataDir`) to
the class declaration.

- [ ] **Step 4: Write `src/control/discord-transport.ts`**

```ts
import { Client, GatewayIntentBits, Partials } from "discord.js";
import type { BotTransport, IncomingMessage } from "./bot.js";

/**
 * The only file importing discord.js, mirroring src/runner/sdk-runner.ts's
 * role as the only file importing the Agent SDK. A gateway connection
 * (persistent outbound websocket) rather than Discord's interactions/slash-
 * command model — the latter needs a public HTTPS endpoint, which this
 * system does not have on local Docker Desktop and gains no benefit from on
 * a VPS either.
 */
export class DiscordJsTransport implements BotTransport {
  private readonly client: Client;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  constructor(private readonly opts: { token: string }) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(channelId: string, text: string): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new Error(`Discord channel ${channelId} is not a sendable text channel`);
    }
    const message = await channel.send(text);
    return { messageId: message.id };
  }

  async start(): Promise<void> {
    this.client.on("messageCreate", (message) => {
      if (message.author.bot) return;
      if (!this.handler) return;
      void this.handler({ channelId: message.channelId, authorId: message.author.id, content: message.content });
    });
    await this.client.login(this.opts.token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
```

- [ ] **Step 5: Wire into `src/index.ts`**

```ts
import { DiscordJsTransport } from "./control/discord-transport.js";
import { DiscordBot } from "./control/bot.js";
```

After the pending-reconciliation block (Task 13, Step 7), replace its
`.then()` body with the real bot construction — this now needs `agents` in
scope, which it already is (`main()`'s existing `agents` variable), and
`config.discord.channels` to resolve a channel key to a Discord channel id.
`config.discord.channels` today maps a key to an env var *name* holding a
**webhook URL**; the bot needs a **channel id** instead. Add a parallel
map in `config.yaml` (documented, not schema-enforced beyond what
`z.record(z.string(), z.string())` already allows since `discord.channels`
is untyped beyond key→string) — reuse the same `discord.channels` map,
treating its values as env var names that, for bot-capable channels, should
resolve to a Discord channel id rather than a webhook URL. Document this in
`config.yaml`'s comments:

```yaml
discord:
  channels:
    smoke: DISCORD_WEBHOOK_SMOKE   # webhook URL — routine reports (outbox)
```

becomes, once the bot needs a channel it can also post approvals into,
naming a second env var per channel:

```yaml
discord:
  channels:
    smoke: DISCORD_WEBHOOK_SMOKE
  botChannels:
    smoke: DISCORD_CHANNEL_ID_SMOKE   # numeric Discord channel id, for the bot
```

Extend `ConfigSchema` in `src/config.ts` with `botChannels: z.record(z.string(), z.string()).default({}).prefault({})` inside the existing `discord` object (a small, additive schema change — add one `it` to `tests/config.test.ts` asserting `config.discord.botChannels` defaults to `{}` when absent, following the exact same pattern as the existing `channels` field's tests).

```ts
  const bot = new DiscordBot({
    transport: new DiscordJsTransport({ token: mustEnv("DISCORD_BOT_TOKEN") }),
    pending, orchestrator, agents,
    channelFor: (agentName) => {
      const agentDef = agents.find((a) => a.name === agentName);
      const key = agentDef?.outbox.discord ?? "";
      const varName = config.discord.botChannels[key];
      return varName ? (process.env[varName] ?? "") : "";
    },
    store: runStore, overrides, breaker: new BreakerStore(DATA_DIR), dataDir: DATA_DIR,
  });

  void bot.start().then(async () => {
    console.log("[boot] Discord bot connected");
    const { active } = await pending.reconcile({ timeoutHours: config.governor.pendingTimeoutHours });
    for (const entry of active) {
      if (entry.kind === "approval") await bot.postApproval(entry);
      else await bot.postQuestion(entry);
    }
  });
```

Add a small `mustEnv` helper near the top of `index.ts` if one doesn't
already exist: `function mustEnv(name: string): string { const v = process.env[name]; if (!v) throw new ValidationError(".env", [`${name} is required`]); return v; }`.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/control/bot.ts src/control/discord-transport.ts src/config.ts src/index.ts config.yaml package.json package-lock.json tests/bot.test.ts tests/config.test.ts
git commit -m "feat: real Discord gateway transport, admin commands, boot wiring"
```

---

### Task 16: Lift the boot-time rejections for `granted`/`autonomous`

**Files:**
- Modify: `src/agent-schema.ts`
- Modify: `scripts/emit-schema.ts`
- Test: `tests/registry.test.ts` (update the two tests that currently assert rejection)

**Interfaces:**
- Produces: `agent.yaml` with `tier: granted`/`autonomous`, `approval: auto`/`approve`, or non-empty `grantRefs` now validates successfully (still checked against `schema/capabilities.json`'s tool/tier enums as before). Browser capability (`capabilities.browser.enabled`) stays rejected — untouched by this plan, still Plan C.

- [ ] **Step 1: Update the tests that currently assert rejection**

In `tests/registry.test.ts`, find `"rejects a tier whose enforcement is not yet built, naming the plan"` and replace it:

```ts
  it("accepts tier: granted now that enforcement exists, still rejecting an unknown tier value", () => {
    const yaml = AGENT + "tier: granted\ngrantRefs: [test-echo]\napproval: approve\n";
    expect(() => parseAgent("agent.yaml", yaml)).not.toThrow();
    expect(parseAgent("agent.yaml", yaml).tier).toBe("granted");
  });
```

Leave the browser-capability rejection test (`"rejects browser capability, naming the plan"`) unchanged — still correct.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/registry.test.ts`
Expected: FAIL — `tier: granted` still throws, naming "Plan B".

- [ ] **Step 3: Update `src/agent-schema.ts`**

In the `NOT_YET` map, remove the `granted`/`autonomous` entries entirely
(the map becomes empty, but keep the object and its `superRefine` check —
Plan C will add `capabilities.browser` back into it, which is already
handled by a separate check, so verify whether `NOT_YET` is used only for
tiers or also referenced elsewhere before deleting it outright; if it's
tier-only, delete the whole `NOT_YET` construct and the `tier` branch of
`superRefine` that reads it). Remove the `superRefine` branches that reject
`agent.approval !== "notify"` and `agent.grantRefs.length > 0` — both are
now valid. Leave the `capabilities.browser.enabled` rejection and the
`allowedTools`/`disallowedTools` overlap check untouched.

- [ ] **Step 4: Update `scripts/emit-schema.ts`**

Remove the now-stale `notYetAvailable` entries for `"tier: granted / autonomous"`, `"approval: auto / approve"`, and `grantRefs`, keeping only `"capabilities.browser.enabled": "Plan C (browser capability)"` and `"trigger.type: webhook": "Plan B (trigger adapters)"` if that one is still accurate (check: does this plan add a webhook trigger type? No — only `cron` exists per this plan too, so that line stays as-is, still pointing at a genuinely future plan).

- [ ] **Step 5: Run the test, then the full suite**

Run: `npm test -- tests/registry.test.ts && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Regenerate the schema artefacts**

Run: `npm run schema`
Expected: `schema/agent.schema.json` and `schema/capabilities.json` rewritten.

- [ ] **Step 7: Commit**

```bash
git add src/agent-schema.ts scripts/emit-schema.ts schema tests/registry.test.ts
git commit -m "feat: unlock tier: granted/autonomous now grant enforcement and park/resume exist"
```

---

### Task 17: Documentation

**Files:**
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update `README.md`**

Replace the "Not built yet" section (governor/tiers/bot/park-resume are no
longer true gaps) with what remains genuinely deferred: the builder agent
and its proposal-approval flow, outcome verification, browser capability,
and any real grant beyond the synthetic `test-echo` one. Add a new "Setup"
step for the Discord bot (Application + Bot creation, Message Content
intent, invite, `DISCORD_BOT_TOKEN`, and the new `botChannels`/
`DISCORD_CHANNEL_ID_*` entries in `config.yaml`/`.env`), matching the
existing webhook setup step's level of detail. Update "Things worth knowing
before you trust it" to remove the now-resolved rate-limit-inert and
cost-floor items, and add the §3.2a limitation from the spec (Bash outward-
effect detection is a heuristic pattern list, not a hard boundary) verbatim
in spirit, phrased for an operator rather than a reviewer.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for governor, grants, park/resume, and the Discord bot"
```
