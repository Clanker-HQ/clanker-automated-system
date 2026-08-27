# Task Queue & Dispatcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner submit a free-form task via Discord and have it durably
queued, routed by a real reasoning call to the right specialist agent, run
under the existing Governor, and reported back — proving the smallest version
of "hand the system a request, it figures out who handles it" before betting
on self-generating tasks, multiple specialists, or self-build.

**Architecture:** Two new components sit in front of the existing, unmodified
run pipeline. `TaskStore` (mirrors `PendingStore`'s one-file-per-entity
pattern) durably holds tasks. `Dispatcher` pulls the next pending task, asks a
`Router` (an LLM classification call, `FakeRouter`/`LlmRouter` split the same
way `GithubTransport`/`FakeGithubTransport` already is in this codebase) which
specialist should handle it, then hands the run to
`Orchestrator.executeRun(agent, now, task.text)` — the exact same call
`makeWebhookHandler` already uses for PR reviews, with no changes to
`Orchestrator`, `Governor`, or `SdkRunner`. One new specialist agent
(`research`, `tier: granted` with a new broadly-scoped read-only `http` grant)
is the only thing routed to in this slice.

**Tech Stack:** Same as Plan A/B/PR-review-gate (Node 24, TypeScript, ESM, zod
4, vitest). No new runtime dependency — the routing call reuses
`@anthropic-ai/claude-agent-sdk`'s `query()`, already a dependency.

**Spec:** [`docs/superpowers/specs/2026-08-27-task-queue-dispatcher-design.md`](../specs/2026-08-27-task-queue-dispatcher-design.md)

## Global Constraints

- Everything in Plan A/B/PR-review-gate's Global Constraints still applies
  verbatim: Node `>=24`, ESM with `.js` import extensions, exact model ID
  strings (`claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5` — never
  date-suffixed), IANA timezone names only, no colons in filenames,
  validation errors name the offending path/received value/fix, all
  configuration validated at boot.
- New modules follow the established conventions exactly: `ValidationError`
  / `formatZodError` from `src/errors.ts` for every validation failure; zod
  schemas use `.strict()`; type-only imports use `import type` (this repo
  builds with `verbatimModuleSyntax: true`); tests that touch the filesystem
  use `mkdtempSync(join(tmpdir(), "cai-<thing>-"))`, never a fixed path.
- **No database.** `TaskStore` follows `PendingStore`'s exact pattern — one
  JSON file per task under `data/tasks/<id>.json`. Spec §3 explains why; do
  not introduce SQLite or anything else in this plan.
- **No changes to `Orchestrator`, `Governor`, `SdkRunner`, or the `cron`/
  `webhook` trigger handling.** The dispatcher is a new caller of
  `Orchestrator.executeRun`, exactly like `makeWebhookHandler` already is —
  not a new execution path. `src/triggers/cron.ts`'s existing
  `if (agent.trigger.type !== "cron") continue;` and
  `makeWebhookHandler`'s existing `a.trigger.type === "webhook"` filter
  already correctly skip a `dispatched`-trigger agent without any change,
  since both already guard on trigger type.
- **The routing call is not an agent run.** It does not go through
  `Orchestrator`/`Governor`/`RunStore` — it's a single-turn, no-tools
  classification call (see Task 4), deliberately outside the budget/run
  accounting that governs real agent work. Keep it that way; do not route it
  through the Governor.
- `grants.yaml`'s `secret` field is validated for well-formedness only and
  not otherwise consulted at match time (see the existing `test-echo` grant
  and README's documented caveat) — the new `web-read` grant's
  `secret: WEB_READ_TOKEN` does not need a real environment variable set.

---

## Milestone A — Storage and schema (no wiring yet)

### Task 1: `Task` type and `TaskStore`

**Files:**
- Create: `src/control/task-store.ts`
- Test: `tests/task-store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `type TaskStatus = "pending" | "running" | "done" | "failed"`;
  `interface Task { id: string; text: string; priority: number; status: TaskStatus; createdBy: string; createdAt: string; startedAt?: string; finishedAt?: string; specialistAgent?: string; parentId?: string; result?: { summary: string; path: string }; failureReason?: string }`;
  `class TaskStore` with `create(input: { text: string; priority?: number; createdBy: string; parentId?: string }): Promise<Task>`,
  `get(id: string): Promise<Task | null>`, `list(): Promise<Task[]>`,
  `update(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Promise<Task>`,
  `nextPending(): Promise<Task | null>`, `reconcile(): Promise<{ reset: Task[] }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/task-store.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskStore } from "../src/control/task-store.js";

function store(): TaskStore {
  return new TaskStore(mkdtempSync(join(tmpdir(), "cai-tasks-")));
}

describe("TaskStore", () => {
  it("creates a task with a generated id, default priority, and pending status", async () => {
    const s = store();
    const task = await s.create({ text: "research profitable niches", createdBy: "discord:owner" });
    expect(task.id).toBeTruthy();
    expect(task.priority).toBe(50);
    expect(task.status).toBe("pending");
    expect(task.createdAt).toBeTruthy();
    expect(await s.get(task.id)).toEqual(task);
  });

  it("returns null for an id that doesn't exist", async () => {
    expect(await store().get("nope")).toBeNull();
  });

  it("honours an explicit priority and parentId", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner", priority: 90, parentId: "parent-1" });
    expect(task.priority).toBe(90);
    expect(task.parentId).toBe("parent-1");
  });

  it("update merges a patch and persists it", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    const updated = await s.update(task.id, { status: "running", specialistAgent: "research" });
    expect(updated.status).toBe("running");
    expect(updated.specialistAgent).toBe("research");
    expect(updated.text).toBe("x");
    expect(await s.get(task.id)).toEqual(updated);
  });

  it("update throws a clear error for an unknown id", async () => {
    await expect(store().update("nope", { status: "done" })).rejects.toThrow(/nope/);
  });

  it("nextPending returns null when nothing is pending", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { status: "done" });
    expect(await s.nextPending()).toBeNull();
  });

  it("nextPending picks the highest priority, ties broken by creation order", async () => {
    const s = store();
    const low = await s.create({ text: "low", createdBy: "discord:owner", priority: 10 });
    const high = await s.create({ text: "high", createdBy: "discord:owner", priority: 90 });
    void low;
    expect((await s.nextPending())?.id).toBe(high.id);

    const s2 = store();
    const first = await s2.create({ text: "first", createdBy: "discord:owner", priority: 50 });
    const second = await s2.create({ text: "second", createdBy: "discord:owner", priority: 50 });
    void second;
    expect((await s2.nextPending())?.id).toBe(first.id);
  });

  it("reconcile resets a running task back to pending and clears its specialistAgent", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { status: "running", specialistAgent: "research" });
    const { reset } = await s.reconcile();
    expect(reset).toHaveLength(1);
    const after = await s.get(task.id);
    expect(after?.status).toBe("pending");
    expect(after?.specialistAgent).toBeUndefined();
  });

  it("reconcile leaves pending/done/failed tasks untouched", async () => {
    const s = store();
    const pending = await s.create({ text: "p", createdBy: "discord:owner" });
    const done = await s.create({ text: "d", createdBy: "discord:owner" });
    await s.update(done.id, { status: "done" });
    const { reset } = await s.reconcile();
    expect(reset).toEqual([]);
    expect((await s.get(pending.id))?.status).toBe("pending");
    expect((await s.get(done.id))?.status).toBe("done");
  });

  it("survives a simulated restart: a new TaskStore over the same directory sees prior tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-tasks-"));
    const first = new TaskStore(dir);
    const task = await first.create({ text: "x", createdBy: "discord:owner" });
    const second = new TaskStore(dir);
    expect(await second.get(task.id)).toEqual(task);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/task-store.test.ts`
Expected: FAIL — cannot resolve `../src/control/task-store.js`.

- [ ] **Step 3: Write `src/control/task-store.ts`**

```ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface Task {
  id: string;
  text: string;
  priority: number;
  status: TaskStatus;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  specialistAgent?: string;
  parentId?: string;
  result?: { summary: string; path: string };
  failureReason?: string;
}

export class TaskStore {
  constructor(private readonly dataDir: string) {}

  private dir(): string {
    return join(this.dataDir, "tasks");
  }

  private path(id: string): string {
    return join(this.dir(), `${id}.json`);
  }

  async create(input: { text: string; priority?: number; createdBy: string; parentId?: string }): Promise<Task> {
    await mkdir(this.dir(), { recursive: true });
    const task: Task = {
      id: randomUUID(),
      text: input.text,
      priority: input.priority ?? 50,
      status: "pending",
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      ...(input.parentId ? { parentId: input.parentId } : {}),
    };
    await writeFile(this.path(task.id), JSON.stringify(task, null, 2) + "\n");
    return task;
  }

  async get(id: string): Promise<Task | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as Task;
    } catch {
      return null;
    }
  }

  async list(): Promise<Task[]> {
    const files = await readdir(this.dir()).catch(() => [] as string[]);
    const tasks: Task[] = [];
    for (const file of files) {
      const task = await this.get(file.replace(/\.json$/, ""));
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async update(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Promise<Task> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`TaskStore: no task "${id}" to update`);
    const updated: Task = { ...existing, ...patch };
    await writeFile(this.path(id), JSON.stringify(updated, null, 2) + "\n");
    return updated;
  }

  /** Highest priority first, ties broken by creation order (FIFO). Null when nothing is pending. */
  async nextPending(): Promise<Task | null> {
    const pending = (await this.list()).filter((t) => t.status === "pending");
    if (pending.length === 0) return null;
    pending.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    return pending[0]!;
  }

  /**
   * A task still marked "running" from before a restart has nothing actually
   * working it — the Orchestrator's own crash handling covers the agent run
   * itself, but the task-level record must not stay stuck. Reset it to
   * "pending" so the next dispatcher tick picks it back up.
   */
  async reconcile(): Promise<{ reset: Task[] }> {
    const running = (await this.list()).filter((t) => t.status === "running");
    const reset: Task[] = [];
    for (const task of running) {
      reset.push(await this.update(task.id, { status: "pending", specialistAgent: undefined }));
    }
    return { reset };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/task-store.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/control/task-store.ts tests/task-store.test.ts
git commit -m "feat: TaskStore — durable task queue, one file per task"
```

---

### Task 2: `dispatched` trigger and a `description` field on `AgentSchema`

**Files:**
- Modify: `src/agent-schema.ts`
- Test: `tests/registry.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentSchema.trigger` becomes a three-way discriminated union
  (`CronTrigger | WebhookTrigger | DispatchedTrigger`); exported
  `DispatchedTrigger` schema and type; `AgentSchema` gains a top-level
  `description: z.string().default("")` field, required non-empty when
  `trigger.type === "dispatched"`.

- [ ] **Step 1: Write the failing test**

Read `tests/registry.test.ts` in full first — find its `AGENT` fixture
string and check the exact current formatting of its `trigger:` and `name:`
blocks (the PR-review-gate plan's Task 1 hit this same fixture; its `.replace`
regex may have shifted since). Adjust the regexes below to match what's
actually there before adding:

```ts
  it("accepts a dispatched trigger when a non-empty description is present", () => {
    const yaml = AGENT
      .replace(/trigger:\n {2}type: cron\n {2}schedule: .*\n {2}timezone: .*\n/, "trigger:\n  type: dispatched\n")
      .replace(/^name: .*/m, "name: smoke\ndescription: Handles routine smoke checks.");
    expect(() => parseAgent("agent.yaml", yaml)).not.toThrow();
    const agent = parseAgent("agent.yaml", yaml);
    expect(agent.trigger).toEqual({ type: "dispatched" });
    expect(agent.description).toBe("Handles routine smoke checks.");
  });

  it("rejects a dispatched trigger with no description", () => {
    const yaml = AGENT.replace(
      /trigger:\n {2}type: cron\n {2}schedule: .*\n {2}timezone: .*\n/,
      "trigger:\n  type: dispatched\n",
    );
    expect(() => parseAgent("agent.yaml", yaml)).toThrow(/description/);
  });

  it("defaults description to an empty string for a cron agent, which needs none", () => {
    const agent = parseAgent("agent.yaml", AGENT);
    expect(agent.description).toBe("");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/registry.test.ts`
Expected: FAIL — `trigger.type: "dispatched"` is rejected by the current
two-variant union, and `description` doesn't exist on the parsed type.

- [ ] **Step 3: Add `DispatchedTrigger` and `description` to `src/agent-schema.ts`**

Directly below the existing `WebhookTrigger` definition:

```ts
const DispatchedTrigger = z.object({ type: z.literal("dispatched") }).strict();
```

Change the `trigger` field:

```ts
    trigger: z.discriminatedUnion("type", [CronTrigger, WebhookTrigger, DispatchedTrigger]),
```

Add a `description` field to the object, directly below `authoredBy`:

```ts
    description: z.string().default(""),
```

Add a check to the existing `.superRefine((agent, ctx) => { ... })` block,
alongside the other tier/browser/tools checks:

```ts
    if (agent.trigger.type === "dispatched" && !agent.description.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["description"],
        message: `a "dispatched" agent needs a non-empty top-level description — the dispatcher's routing call reads it to decide when this specialist applies`,
      });
    }
```

Export the new trigger type alongside the existing ones, at the bottom of
the file:

```ts
export type DispatchedTrigger = z.infer<typeof DispatchedTrigger>;
```

- [ ] **Step 4: Run the test to verify it passes, then the full suite**

Run: `npm test -- tests/registry.test.ts && npm run typecheck && npm test`
Expected: all pass. `src/triggers/cron.ts`'s existing
`if (agent.trigger.type !== "cron") continue;` and
`src/control/webhook-wiring.ts`'s existing `a.trigger.type === "webhook"`
filter should both still typecheck and behave correctly against the new
three-way union with no changes — if either doesn't typecheck, the
discriminated union isn't set up correctly; fix before moving on.

- [ ] **Step 5: Regenerate schema artifacts and commit**

```bash
npm run schema
git add src/agent-schema.ts schema tests/registry.test.ts
git commit -m "feat: dispatched trigger type and agent description field"
```

---

## Milestone B — Routing

### Task 3: `Router` interface and `FakeRouter`

**Files:**
- Create: `src/control/router.ts`
- Test: `tests/router.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `interface Specialist { name: string; description: string }`;
  `interface Router { route(taskText: string, specialists: Specialist[]): Promise<string | null> }`;
  class `FakeRouter implements Router`, constructed with a fixed answer or a
  `(taskText, specialists) => string | null` function, recording every call
  in a public `calls` array.

- [ ] **Step 1: Write the failing test**

Create `tests/router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeRouter } from "../src/control/router.js";

describe("FakeRouter", () => {
  it("returns a fixed answer and records the call", async () => {
    const router = new FakeRouter("research");
    const specialists = [{ name: "research", description: "researches things" }];
    const result = await router.route("find me a good business idea", specialists);
    expect(result).toBe("research");
    expect(router.calls).toEqual([{ taskText: "find me a good business idea", specialists }]);
  });

  it("returns null when constructed with null", async () => {
    const router = new FakeRouter(null);
    expect(await router.route("anything", [{ name: "research", description: "d" }])).toBeNull();
  });

  it("supports a function responder for per-call logic", async () => {
    const router = new FakeRouter((_text, specialists) => specialists[0]?.name ?? null);
    expect(await router.route("anything", [{ name: "research", description: "d" }])).toBe("research");
    expect(await router.route("anything", [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/router.test.ts`
Expected: FAIL — cannot resolve `../src/control/router.js`.

- [ ] **Step 3: Write `src/control/router.ts`**

```ts
export interface Specialist {
  name: string;
  description: string;
}

/** Decides which specialist agent (by name) should handle a task, or null if none fit. */
export interface Router {
  route(taskText: string, specialists: Specialist[]): Promise<string | null>;
}

/** Test double: a fixed answer or a computed one, with zero real LLM calls. */
export class FakeRouter implements Router {
  calls: { taskText: string; specialists: Specialist[] }[] = [];

  constructor(
    private readonly respond: string | null | ((taskText: string, specialists: Specialist[]) => string | null),
  ) {}

  async route(taskText: string, specialists: Specialist[]): Promise<string | null> {
    this.calls.push({ taskText, specialists });
    return typeof this.respond === "function" ? this.respond(taskText, specialists) : this.respond;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/router.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/control/router.ts tests/router.test.ts
git commit -m "feat: Router interface and FakeRouter test double"
```

---

### Task 4: `LlmRouter` — the real routing call

**Files:**
- Create: `src/control/llm-router.ts`
- Test: `tests/llm-router.test.ts`

**Interfaces:**
- Consumes: `Router`/`Specialist` (Task 3), `resolveCredentials` from
  `src/runner/credentials.ts`, `toRunEvents` (exported from
  `src/runner/sdk-runner.ts`).
- Produces: class `LlmRouter implements Router`.

- [ ] **Step 1: Write the failing test**

Create `tests/llm-router.test.ts`. This mirrors `tests/sdk-runner-options.test.ts`'s
existing `query` mock exactly — read that file's top section first if
anything below doesn't line up with the SDK's current shape:

```ts
import { describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

const { LlmRouter } = await import("../src/control/llm-router.js");

function stream(messages: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

function assistantMessage(text: string) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

describe("LlmRouter", () => {
  it("returns the specialist whose name the model replies with", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("research")]));
    const result = await new LlmRouter().route("find a profitable niche", [
      { name: "research", description: "researches things" },
    ]);
    expect(result).toBe("research");
  });

  it("matches case-insensitively", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("Research")]));
    const result = await new LlmRouter().route("x", [{ name: "research", description: "d" }]);
    expect(result).toBe("research");
  });

  it("returns null when the model says none", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("none")]));
    const result = await new LlmRouter().route("x", [{ name: "research", description: "d" }]);
    expect(result).toBeNull();
  });

  it("returns null when the model names something not in the specialist list", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("some-made-up-agent")]));
    const result = await new LlmRouter().route("x", [{ name: "research", description: "d" }]);
    expect(result).toBeNull();
  });

  it("takes the LAST assistant text if the model produces more than one message", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    queryMock.mockReturnValue(stream([assistantMessage("thinking..."), assistantMessage("research")]));
    const result = await new LlmRouter().route("x", [{ name: "research", description: "d" }]);
    expect(result).toBe("research");
  });

  it("returns null immediately without calling query when there are no specialists", async () => {
    const result = await new LlmRouter().route("x", []);
    expect(result).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/llm-router.test.ts`
Expected: FAIL — cannot resolve `../src/control/llm-router.js`.

- [ ] **Step 3: Write `src/control/llm-router.ts`**

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCredentials } from "../runner/credentials.js";
import { toRunEvents } from "../runner/sdk-runner.js";
import type { Router, Specialist } from "./router.js";

/**
 * Real routing decision: one small, cheap, single-turn call — no tools, no
 * workspace, no agentic loop, and deliberately NOT run through
 * Orchestrator/Governor/RunStore. This is a classification decision, not a
 * task execution.
 *
 * The answer is read from the last `assistant` text event `toRunEvents`
 * (already tested against the SDK's real message shapes in
 * tests/sdk-runner.test.ts) extracts from the stream, rather than an
 * unverified field on the terminal `result` message — reusing an
 * already-proven extraction path instead of assuming a new one.
 */
export class LlmRouter implements Router {
  async route(taskText: string, specialists: Specialist[]): Promise<string | null> {
    if (specialists.length === 0) return null;

    const menu = specialists.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    const prompt =
      `A task needs to be routed to exactly one specialist agent, or none if nothing fits.\n\n` +
      `Task: ${taskText}\n\nAvailable specialists:\n${menu}\n\n` +
      `Reply with ONLY the chosen specialist's name exactly as listed above, or the single word "none" if no specialist fits. No other text.`;

    const { childEnv } = resolveCredentials();
    const stream = query({
      prompt,
      options: {
        model: "claude-haiku-4-5",
        effort: "low",
        maxTurns: 1,
        maxBudgetUsd: 0.05,
        cwd: process.cwd(),
        allowedTools: [],
        disallowedTools: [],
        tools: [],
        permissionMode: "default",
        settingSources: [],
        env: childEnv,
        abortController: new AbortController(),
      },
    });

    let answer = "";
    for await (const message of stream) {
      for (const event of toRunEvents(message)) {
        if (event.type === "assistant" && event.text.trim()) answer = event.text.trim();
      }
    }

    const normalized = answer.toLowerCase();
    if (normalized === "none" || normalized === "") return null;
    return specialists.find((s) => s.name.toLowerCase() === normalized)?.name ?? null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/llm-router.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/control/llm-router.ts tests/llm-router.test.ts
git commit -m "feat: LlmRouter — real single-turn routing call"
```

---

### Task 5: `buildRouter` — fake/real selector

**Files:**
- Create: `src/control/build-router.ts`
- Test: `tests/build-router.test.ts`

**Interfaces:**
- Consumes: `Router`, `FakeRouter` (Task 3), `LlmRouter` (Task 4).
- Produces: `buildRouter(env?: NodeJS.ProcessEnv): Router`.

- [ ] **Step 1: Write the failing test**

Create `tests/build-router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRouter } from "../src/control/build-router.js";
import { LlmRouter } from "../src/control/llm-router.js";
import { FakeRouter } from "../src/control/router.js";

describe("buildRouter", () => {
  it("returns a FakeRouter that picks the first specialist when RUNNER=fake", async () => {
    const router = buildRouter({ RUNNER: "fake" });
    expect(router).toBeInstanceOf(FakeRouter);
    const result = await router.route("anything", [{ name: "research", description: "d" }]);
    expect(result).toBe("research");
  });

  it("returns a real LlmRouter when RUNNER is not fake", () => {
    expect(buildRouter({})).toBeInstanceOf(LlmRouter);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/build-router.test.ts`
Expected: FAIL — cannot resolve `../src/control/build-router.js`.

- [ ] **Step 3: Write `src/control/build-router.ts`**

```ts
import { LlmRouter } from "./llm-router.js";
import { FakeRouter, type Router } from "./router.js";

/**
 * Same fake/real switch as buildRunner (src/runner/build-runner.ts), read
 * from the same RUNNER env var — a dispatcher run under RUNNER=fake must
 * consume no subscription quota either, not just the specialist's own run.
 * The fake always picks the first registered specialist, so the whole
 * queue -> route -> run -> report pipeline can be exercised end to end with
 * zero real spend, the same way FakeRunner already lets the rest of this
 * project be tested.
 */
export function buildRouter(env: NodeJS.ProcessEnv = process.env): Router {
  if (env.RUNNER === "fake") {
    return new FakeRouter((_taskText, specialists) => specialists[0]?.name ?? null);
  }
  return new LlmRouter();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/build-router.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/control/build-router.ts tests/build-router.test.ts
git commit -m "feat: buildRouter fake/real selector"
```

---

## Milestone C — Dispatcher

### Task 6: `runDispatchTick` and the `Dispatcher` loop

**Files:**
- Create: `src/control/dispatcher.ts`
- Test: `tests/dispatcher.test.ts`

**Interfaces:**
- Consumes: `AgentDef` (`src/registry.ts`), `RunResult` (`src/run-store.ts`),
  `Router`/`Specialist` (Task 3), `Task`/`TaskStore` (Task 1).
- Produces: `interface RunTrigger { executeRun(agent: AgentDef, now?: Date, promptContext?: string): Promise<RunResult | undefined> }`;
  `interface DispatcherDeps { tasks: TaskStore; router: Router; agents: AgentDef[]; orchestrator: RunTrigger; notify: (text: string) => Promise<void>; now?: () => Date }`;
  `runDispatchTick(deps: DispatcherDeps): Promise<{ ran: boolean; taskId?: string }>`;
  class `Dispatcher` with `constructor(deps: DispatcherDeps, tickMs?: number)`,
  `start(): void`, `stop(): void`, `wake(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `tests/dispatcher.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Dispatcher, runDispatchTick } from "../src/control/dispatcher.js";
import { FakeRouter } from "../src/control/router.js";
import { TaskStore } from "../src/control/task-store.js";
import type { AgentDef } from "../src/registry.js";
import type { RunResult } from "../src/run-store.js";

function taskStore(): TaskStore {
  return new TaskStore(mkdtempSync(join(tmpdir(), "cai-dispatcher-")));
}

function specialist(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "research",
    enabled: true,
    description: "researches things",
    trigger: { type: "dispatched" },
    ...overrides,
  } as unknown as AgentDef;
}

function successResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: "research-1",
    agent: "research",
    status: "success",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    durationMs: 60000,
    costUsd: 0.01,
    inputTokens: 10,
    outputTokens: 20,
    turns: 1,
    summary: "Found three ideas.",
    ...overrides,
  };
}

describe("runDispatchTick", () => {
  it("does nothing and reports ran:false when the queue is empty", async () => {
    const result = await runDispatchTick({
      tasks: taskStore(), router: new FakeRouter(null), agents: [specialist()],
      orchestrator: { executeRun: vi.fn() }, notify: vi.fn(),
    });
    expect(result).toEqual({ ran: false });
  });

  it("routes a pending task, runs it, and marks it done on success", async () => {
    const tasks = taskStore();
    const task = await tasks.create({ text: "find a profitable niche", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult());
    const result = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(),
    });
    expect(result).toEqual({ ran: true, taskId: task.id });
    expect(executeRun).toHaveBeenCalledWith(specialist(), expect.any(Date), "find a profitable niche");
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.specialistAgent).toBe("research");
    expect(updated?.result).toEqual({ summary: "Found three ideas.", path: "data/runs/research-1" });
  });

  it("marks the task failed, with the run's own error, when the run doesn't succeed", async () => {
    const tasks = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(),
    });
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.failureReason).toBe("boom");
  });

  it("puts the task back to pending, without failing it, when the governor refuses admission", async () => {
    const tasks = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(),
    });
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("pending");
  });

  it("fails the task and notifies, without ever calling executeRun, when no specialist matches", async () => {
    const tasks = taskStore();
    await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter(null), agents: [specialist()],
      orchestrator: { executeRun }, notify,
    });
    expect(executeRun).not.toHaveBeenCalled();
    const [task] = await tasks.list();
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toContain("no specialist matched");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("fails the task and notifies when no dispatched specialists are registered at all", async () => {
    const tasks = taskStore();
    await tasks.create({ text: "x", createdBy: "discord:owner" });
    const notify = vi.fn().mockResolvedValue(undefined);
    await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [],
      orchestrator: { executeRun: vi.fn() }, notify,
    });
    const [task] = await tasks.list();
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toContain("no dispatched specialist");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("fails the task when the router names an agent that isn't a registered dispatched specialist", async () => {
    const tasks = taskStore();
    await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn();
    await runDispatchTick({
      tasks, router: new FakeRouter("some-other-agent"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(),
    });
    expect(executeRun).not.toHaveBeenCalled();
    const [task] = await tasks.list();
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toContain("some-other-agent");
  });
});

describe("Dispatcher.wake", () => {
  it("drains every pending task in one wake() call, not just one", async () => {
    const tasks = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    await tasks.create({ text: "b", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult());
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(),
    });
    await dispatcher.wake();
    expect(executeRun).toHaveBeenCalledTimes(2);
    const remaining = (await tasks.list()).filter((t) => t.status === "pending" || t.status === "running");
    expect(remaining).toEqual([]);
  });

  it("a re-entrant wake() call while draining is a no-op, not a second concurrent drain", async () => {
    const tasks = taskStore();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    let resolveRun!: (r: RunResult) => void;
    const executeRun = vi.fn().mockReturnValue(new Promise<RunResult>((resolve) => { resolveRun = resolve; }));
    const dispatcher = new Dispatcher({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(),
    });
    const firstWake = dispatcher.wake();
    const secondWake = dispatcher.wake();
    resolveRun(successResult());
    await Promise.all([firstWake, secondWake]);
    expect(executeRun).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/dispatcher.test.ts`
Expected: FAIL — cannot resolve `../src/control/dispatcher.js`.

- [ ] **Step 3: Write `src/control/dispatcher.ts`**

```ts
import type { AgentDef } from "../registry.js";
import type { RunResult } from "../run-store.js";
import type { Router, Specialist } from "./router.js";
import type { TaskStore } from "./task-store.js";

export interface RunTrigger {
  executeRun(agent: AgentDef, now?: Date, promptContext?: string): Promise<RunResult | undefined>;
}

export interface DispatcherDeps {
  tasks: TaskStore;
  router: Router;
  agents: AgentDef[];
  orchestrator: RunTrigger;
  /** Posts a message for a task that never reaches Orchestrator.executeRun — a routing failure has no run, so it never gets a report through the agent's own outbox. */
  notify: (text: string) => Promise<void>;
  now?: () => Date;
}

function specialistsOf(agents: AgentDef[]): Specialist[] {
  return agents
    .filter((a) => a.enabled && a.trigger.type === "dispatched")
    .map((a) => ({ name: a.name, description: a.description }));
}

/** Attempts exactly one pending task, if one exists. Pure enough to unit test without a timer, a real Router, or a real Orchestrator. */
export async function runDispatchTick(deps: DispatcherDeps): Promise<{ ran: boolean; taskId?: string }> {
  const task = await deps.tasks.nextPending();
  if (!task) return { ran: false };

  const now = deps.now ?? (() => new Date());
  const specialists = specialistsOf(deps.agents);

  if (specialists.length === 0) {
    await deps.tasks.update(task.id, {
      status: "failed",
      finishedAt: now().toISOString(),
      failureReason: "no dispatched specialist agents are registered",
    });
    await deps.notify(`⚠️ Task \`${task.id}\` failed: no dispatched specialist agents are registered.`);
    return { ran: true, taskId: task.id };
  }

  const chosenName = await deps.router.route(task.text, specialists);
  const agent = chosenName
    ? deps.agents.find((a) => a.name === chosenName && a.trigger.type === "dispatched" && a.enabled)
    : undefined;

  if (!agent) {
    const reason = chosenName
      ? `router chose "${chosenName}", which is not a registered dispatched specialist`
      : "no specialist matched this task";
    await deps.tasks.update(task.id, { status: "failed", finishedAt: now().toISOString(), failureReason: reason });
    await deps.notify(`⚠️ Task \`${task.id}\` failed: ${reason}. Text: ${task.text}`);
    return { ran: true, taskId: task.id };
  }

  await deps.tasks.update(task.id, { status: "running", specialistAgent: agent.name, startedAt: now().toISOString() });

  const result = await deps.orchestrator.executeRun(agent, now(), task.text);

  if (!result) {
    // Governor refused admission (quiet hours, budget, breaker, STOP file) —
    // put it back to pending rather than failing it: unlike a cron agent,
    // which just gets another fire at its next scheduled time, a queued task
    // has nowhere else to go except the next dispatcher tick.
    await deps.tasks.update(task.id, { status: "pending", specialistAgent: undefined, startedAt: undefined });
    return { ran: true, taskId: task.id };
  }

  if (result.status === "success") {
    await deps.tasks.update(task.id, {
      status: "done",
      finishedAt: now().toISOString(),
      result: { summary: result.summary, path: `data/runs/${result.runId}` },
    });
  } else {
    await deps.tasks.update(task.id, {
      status: "failed",
      finishedAt: now().toISOString(),
      failureReason: result.error ?? `run ended with status "${result.status}"`,
    });
  }
  return { ran: true, taskId: task.id };
}

/**
 * Thin loop over runDispatchTick — a periodic tick, plus a reactive wake() a
 * caller (a new `!task`, or a run finishing) can call to attempt work
 * immediately rather than waiting for the next timer. Re-entrant: a wake()
 * that arrives mid-drain is a no-op, since the in-progress drain will reach
 * any newly-added task itself (nextPending() re-reads the store every call).
 */
export class Dispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(
    private readonly deps: DispatcherDeps,
    private readonly tickMs: number = 30_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.wake(), this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async wake(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let outcome = await runDispatchTick(this.deps);
      while (outcome.ran) outcome = await runDispatchTick(this.deps);
    } finally {
      this.draining = false;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/dispatcher.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/control/dispatcher.ts tests/dispatcher.test.ts
git commit -m "feat: dispatcher — routes and runs the next pending task"
```

---

## Milestone D — Discord, the research specialist, and wiring

### Task 7: `!task` and `!tasks` Discord commands

**Files:**
- Modify: `src/control/bot.ts`
- Test: `tests/bot.test.ts` (extend)

**Interfaces:**
- Consumes: `Task`/`TaskStore` (Task 1).
- Produces: `DiscordBot`'s constructor gains required `tasks: TaskStore` and
  `dispatcher: { wake(): Promise<void> }` fields; two new commands.

- [ ] **Step 1: Write the failing test**

Read `tests/bot.test.ts` in full first — find its existing `DiscordBot`
construction helper and the imports it already has for
`FakeBotTransport`/`PendingStore`/`RunStore`/`ConfigOverridesStore`/
`BreakerStore`. Add `tasks`/`dispatcher` to whatever pattern it already uses
for the other fake/real dependencies (a fresh `TaskStore` over the same temp
`dataDir` the harness already creates, and a `{ wake: vi.fn().mockResolvedValue(undefined) }`
fake for `dispatcher`), then append these tests to the file, adding the
`TaskStore` import at the top:

```ts
import { TaskStore } from "../src/control/task-store.js";

describe("DiscordBot task commands", () => {
  it("!task queues a task, replies with its id, and wakes the dispatcher", async () => {
    const { transport, bot, dataDir } = harness(); // adapt to the existing harness's actual return shape
    const tasks = new TaskStore(dataDir);
    await bot.start();
    await transport.simulateMessage({ channelId: "c1", authorId: OWNER_ID, content: "!task find a profitable SaaS idea" });
    const all = await tasks.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toBe("find a profitable SaaS idea");
    expect(all[0]?.createdBy).toBe(`discord:${OWNER_ID}`);
    expect(transport.sent[0]?.text).toContain(all[0]!.id);
  });

  it("!task with no text replies with usage and creates nothing", async () => {
    const { transport, bot, dataDir } = harness();
    const tasks = new TaskStore(dataDir);
    await bot.start();
    await transport.simulateMessage({ channelId: "c1", authorId: OWNER_ID, content: "!task" });
    expect(await tasks.list()).toEqual([]);
    expect(transport.sent[0]?.text).toContain("Usage");
  });

  it("!tasks lists pending and running tasks, not done ones", async () => {
    const { transport, bot, dataDir } = harness();
    const tasks = new TaskStore(dataDir);
    await tasks.create({ text: "a pending one", createdBy: "discord:owner" });
    const running = await tasks.create({ text: "a running one", createdBy: "discord:owner" });
    await tasks.update(running.id, { status: "running" });
    const done = await tasks.create({ text: "a finished one", createdBy: "discord:owner" });
    await tasks.update(done.id, { status: "done" });

    await bot.start();
    await transport.simulateMessage({ channelId: "c1", authorId: OWNER_ID, content: "!tasks" });
    const reply = transport.sent[0]!.text;
    expect(reply).toContain("a pending one");
    expect(reply).toContain("a running one");
    expect(reply).not.toContain("a finished one");
  });

  it("ignores !task from a non-owner author", async () => {
    const { transport, bot, dataDir } = harness();
    const tasks = new TaskStore(dataDir);
    await bot.start();
    await transport.simulateMessage({ channelId: "c1", authorId: "not-the-owner", content: "!task do something" });
    expect(await tasks.list()).toEqual([]);
    expect(transport.sent).toEqual([]);
  });
});
```

(`OWNER_ID` here stands for whatever constant/string the existing test file
already uses for its authorized owner id — use that, not a new one.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/bot.test.ts`
Expected: FAIL — `DiscordBot`'s constructor doesn't accept `tasks`/
`dispatcher`, and no `!task`/`!tasks` command exists.

- [ ] **Step 3: Implement in `src/control/bot.ts`**

Add an interface directly above `DiscordBot`, alongside the existing
`ResumeCapableOrchestrator`:

```ts
interface WakeableDispatcher {
  wake(): Promise<void>;
}
```

Add `tasks: TaskStore` and `dispatcher: WakeableDispatcher` to the
constructor's `opts` type and to the class's private fields (alongside the
existing fields — read the current constructor first and extend it, don't
replace it):

```ts
import type { TaskStore } from "./task-store.js";
```

```ts
  private readonly tasks: TaskStore;
  private readonly dispatcher: WakeableDispatcher;
```

```ts
    this.tasks = opts.tasks;
    this.dispatcher = opts.dispatcher;
```

Add two cases to the `switch (command)` block in `handleCommand`, alongside
the existing `!runs` case:

```ts
      case "!task": {
        if (!arg.trim()) return void reply("Usage: `!task <free-form request>`");
        const task = await this.tasks.create({ text: arg, createdBy: `discord:${msg.authorId}` });
        void this.dispatcher.wake().catch((err: unknown) => {
          console.error(`[bot] dispatcher wake failed after !task ${task.id}:`, err);
        });
        return void reply(`📋 Task \`${task.id}\` queued.`);
      }
      case "!tasks": {
        const all = await this.tasks.list();
        const active = all
          .filter((t) => t.status === "pending" || t.status === "running")
          .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
        const lines = active.map((t) => {
          const text = t.text.length > 60 ? `${t.text.slice(0, 57)}...` : t.text;
          return `${t.id.slice(0, 8)} — ${t.status} — ${text}`;
        });
        return void reply(lines.length > 0 ? lines.join("\n") : "No pending or running tasks.");
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/bot.test.ts`
Expected: PASS, including every pre-existing test in the file (the
constructor change is additive, but confirm nothing else constructing a
`DiscordBot` elsewhere in the test file broke).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/control/bot.ts tests/bot.test.ts
git commit -m "feat: !task/!tasks Discord commands"
```

---

### Task 8: The `research` specialist agent and its grant

**Files:**
- Create: `agents/research/agent.yaml`
- Create: `agents/research/prompt.md`
- Modify: `grants.yaml`

**Interfaces:**
- Consumes: `AgentSchema`'s `dispatched` trigger and `description` field
  (Task 2); `GrantSchema`'s existing `http` variant (`src/grants.ts` —
  unmodified by this plan).
- Produces: a loadable agent definition and a grant `loadRegistry`/
  `loadGrants`/`validateGrantRefs` (all unmodified) accept without error.

- [ ] **Step 1: Add the `web-read` grant to `grants.yaml`**

Append to the `grants:` list, after the existing `infra-repo` entry:

```yaml
  # Backs agents/research's grantRefs. Read-only web access (WebFetch to
  # arbitrary URLs) is a deliberately broad, low-risk grant: reading a public
  # page carries none of the "spend money / do something irreversible"
  # character the owner reserves for personal approval, unlike a git-push or
  # provision grant. `method`/`secret` are schema-required fields, checked
  # for well-formedness at boot only and not otherwise consulted at match
  # time (see the existing test-echo grant, and README's documented caveat
  # about method/branches/limit.perDay) — WEB_READ_TOKEN does not need to be
  # set in .env.
  - id: web-read
    kind: http
    method: GET
    urlPattern: "*"
    secret: WEB_READ_TOKEN
```

- [ ] **Step 2: Write `agents/research/agent.yaml`**

```yaml
name: research
enabled: true
authoredBy: claude-local
description: >-
  Researches a topic on the open web — market opportunities, technical
  questions, whether an idea is any good — and writes up findings.
  Read-and-report only: no code changes, no publishing, no spending.

trigger:
  type: dispatched

run:
  model: claude-haiku-4-5
  effort: medium
  maxTurns: 30
  timeoutMinutes: 20
  maxBudgetUsd: 2.00

permissions:
  allowedTools: [WebSearch, WebFetch, Write]
  disallowedTools: []

tier: granted
approval: auto
grantRefs: [web-read]

outbox:
  discord: smoke
  notifyOn: [success, failure]
```

- [ ] **Step 3: Write `agents/research/prompt.md`**

```markdown
You are researching a topic and writing up what you find. Nobody reviews
this before it reaches the owner — write it as if it will be read directly,
not as a draft for someone else to polish.

## What you have

The task's request is appended to this prompt. It may be specific ("research
X") or open-ended ("find a promising niche for a small paid tool"). If it's
open-ended, use your own judgment about what's worth investigating — you
don't need to ask; nobody is waiting to answer.

## How to research

Use WebSearch to find sources, then WebFetch to actually read the pages that
look substantive — a search snippet alone is rarely enough to write anything
useful. Favor primary sources and recent material over aggregator content
that's just repeating older takes.

## What to produce

Write your findings to a new, uniquely-named markdown file in your
workspace (e.g. `findings-<short-topic-slug>-<date>.md`) — this workspace is
shared across every research run, so a fixed filename would silently
overwrite a previous run's output. Include enough detail that someone could
act on it: what you found, why it's worth attention (or isn't), sources, and
anything uncertain flagged as uncertain rather than stated as fact. End your
final message with a short (2-4 sentence) summary of what you found — that
summary is what reaches the owner directly; the file is for anyone who wants
the full detail.

You have no ability to spend money, publish anything, or change any code —
this is read-and-report only. If the task seems to call for building or
publishing something, say so in your summary rather than attempting it.
```

- [ ] **Step 4: Verify it loads cleanly**

Run: `npm run typecheck && npm test`
Expected: all existing tests still pass — `loadRegistry`/`loadGrants`/
`validateGrantRefs` are unmodified by this plan, so a schema or grant-ref
mistake here surfaces as a failure in whatever existing test exercises the
real `agents/`/`grants.yaml` directories (check `tests/registry.test.ts` and
`tests/grants.test.ts` for one that does, and run it directly first if so:
`npm test -- tests/registry.test.ts tests/grants.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add agents/research grants.yaml
git commit -m "feat: research specialist agent and its web-read grant"
```

---

### Task 9: Wire the dispatcher into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: a running system where `!task` in Discord reaches the queue, the
  dispatcher routes and runs it, and the result is reported — end to end.

`src/index.ts` cannot be imported directly in a test (it runs `main()` on
import, per the existing pattern noted in `src/control/webhook-wiring.ts`'s
own comment), so this task is verified by typecheck, the full suite, and a
manual smoke run rather than a new unit test — the pieces it wires
(`TaskStore`, `buildRouter`, `Dispatcher`, `runDispatchTick`, the bot
commands) are already fully covered by Tasks 1–7's own tests.

- [ ] **Step 1: Add imports**

Alongside the existing `src/control/*` imports in `src/index.ts`:

```ts
import { buildRouter } from "./control/build-router.js";
import { Dispatcher } from "./control/dispatcher.js";
import { TaskStore } from "./control/task-store.js";
```

- [ ] **Step 2: Construct `TaskStore` and pull `DiscordOutbox` into a named variable**

Directly below the existing `const pending = new PendingStore(DATA_DIR);`:

```ts
  const tasks = new TaskStore(DATA_DIR);
```

Read the current `Orchestrator` construction block — it builds
`outbox: new DiscordOutbox({ config, dataDir: DATA_DIR })` inline. Extract
that to a named `const` just above it, so the same instance can be reused by
the dispatcher's `notify` callback below:

```ts
  const outbox = new DiscordOutbox({ config, dataDir: DATA_DIR });
```

and change the inline construction inside `new Orchestrator({...})` from
`outbox: new DiscordOutbox({ config, dataDir: DATA_DIR }),` to `outbox,`.

- [ ] **Step 3: Construct the router and dispatcher**

Directly after the `const orchestrator = new Orchestrator({...})` block —
which comes after the existing `let bot: DiscordBot | undefined;` line — and
before the `bot = new DiscordBot({...})` assignment further down, which
needs it:

```ts
  const router = buildRouter();
  const dispatcher = new Dispatcher({
    tasks,
    router,
    agents,
    orchestrator,
    // No agent has been chosen yet at this point (a routing failure, or no
    // registered specialist at all), so there is no agent.outbox.discord to
    // report through — "smoke" is this project's one configured channel,
    // matching how agents/pr-reviewer and agents/smoke both already use it.
    notify: (text) => outbox.postAlert("smoke", text),
  });
```

- [ ] **Step 4: Pass `tasks`/`dispatcher` into the `DiscordBot` construction**

In the existing `bot = new DiscordBot({...})` call, add two fields to the
opts object (alongside `store, overrides, breaker, dataDir`):

```ts
    tasks, dispatcher,
```

- [ ] **Step 5: Reconcile tasks and start the dispatcher on boot**

Directly after the existing
`void reconcileAndConnectBot({ pending, bot, timeoutHours: config.governor.pendingTimeoutHours });`
line:

```ts
  void tasks.reconcile().then(({ reset }) => {
    if (reset.length > 0) {
      console.log(`[tasks] ${reset.length} task(s) reset from "running" to "pending" after restart`);
    }
    dispatcher.start();
    void dispatcher.wake();
  });
```

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: all pass, including every test from Tasks 1–8.

- [ ] **Step 7: Manual smoke check (no subscription quota consumed)**

```bash
RUNNER=fake docker compose up --build
```

Confirm the boot log shows the agent count including `research`, then from
the configured Discord channel: `!task find a profitable niche for a small
paid tool`. Expect a `📋 Task ... queued.` reply, followed shortly by the
`research` agent's fake run result (per `buildRunner`'s existing
`RUNNER=fake` fixture) reported the same way any other agent's run already
is. Then `!tasks` should show nothing pending/running once it completes.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire the task queue and dispatcher into boot"
```

---

## Self-Review Notes

- **Spec coverage:** §2 architecture → Tasks 1, 6, 9. §3 TaskStore → Task 1.
  §4 Discord commands → Task 7. §5 dispatcher/routing/trigger variant →
  Tasks 2, 3, 4, 5, 6. §6 research agent/grant → Task 8. §7 error handling →
  Task 6's branches (no-match, run failure, governor refusal) and Task 1's
  `reconcile`. §9 testing conventions (fakes, `mkdtempSync`, no real spend) →
  followed throughout.
- **Open items from the spec** (dispatched trigger schema shape, `data/`
  path convention, tick interval, whether `!task` needs a priority argument)
  are resolved concretely above: trigger is a bare `{ type: "dispatched" }`;
  results are recorded via the run's own `data/runs/<runId>/` (already the
  system's existing durable artifact location — no new path convention
  invented); tick interval is 30s with reactive `wake()` covering the
  common case; `!task` ships without a priority argument in v1 (every
  user-submitted task defaults to priority 50 — YAGNI until standing
  directives exist and priority actually differentiates something, per spec
  §8).
