# Standing/Proactive Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the system generate its own work: two new cron-triggered agents each propose one thing worth doing and queue it as a real task, using a new `queueTask` MCP tool that any agent run can call.

**Architecture:** One new capability (`queueTask`, an MCP tool registered on `SdkRunner` alongside the existing `askHuman` tool) plumbed through to the existing, unmodified task queue/dispatcher/Governor pipeline. Two new `agent.yaml` + `prompt.md` pairs (`opportunity-scout`, `improvement-scout`) are the only new "business logic" — config, not code.

**Tech Stack:** TypeScript, the existing `@anthropic-ai/claude-agent-sdk` MCP tool pattern (`createSdkMcpServer`/`tool`), zod for input validation, vitest.

**Spec:** [`docs/superpowers/specs/2026-08-28-standing-tasks-design.md`](../specs/2026-08-28-standing-tasks-design.md)

## Global Constraints

- `queueTask`'s `text` is capped at the same 4000 characters `!task` already enforces (`MAX_TASK_TEXT_LENGTH`, relocated to `src/control/task-store.ts` so both call sites share one constant).
- A self-queued task defaults to **priority 30** (below the human default of 50) and **`wantsDetail: true`**, and is attributed as `createdBy: "agent:<agent.name>"`.
- At most **3** `queueTask` calls succeed per agent run; a 4th is refused with a message, not an exception.
- `queueTask` requires no grant and works at every tier (it has no outward effect in `src/grants.ts`'s sense) — it is only *registered* when both `tasks` and `wake` are wired into `SdkRunner`, the same optional-dependency shape `github`/`githubPrServer` already use.
- Both new agents run at `tier: readonly` with no `grantRefs` — structurally unable to write, push, fetch, or provision, not merely instructed not to.
- Every new/changed file must leave `npm run typecheck` and `npx vitest run --exclude "**/.claude/**"` clean before that task's commit.

---

### Task 1: `queueTask` MCP tool on `SdkRunner`

**Files:**
- Modify: `src/control/task-store.ts` (add and export `MAX_TASK_TEXT_LENGTH`)
- Modify: `src/control/bot.ts:1-11,68-76` (import the relocated constant instead of defining it)
- Modify: `src/runner/sdk-runner.ts:1-9,202-215,311-406` (add the tool)
- Create: `tests/sdk-runner-queue-task.test.ts`

**Interfaces:**
- Consumes: `TaskStore.create(input: { text: string; priority?: number; createdBy: string; parentId?: string; wantsDetail?: boolean }): Promise<Task>` (existing, `src/control/task-store.ts`).
- Produces: `SdkRunner`'s constructor deps gain two new **optional** fields — `tasks?: TaskStore` and `wake?: () => Promise<void>` — consumed by Task 2's production wiring. `MAX_TASK_TEXT_LENGTH` becomes a named export of `src/control/task-store.ts`.

- [ ] **Step 1: Move `MAX_TASK_TEXT_LENGTH` into `task-store.ts` and re-export it from `bot.ts`**

In `src/control/task-store.ts`, add near the top (after the imports, before the `TaskStatus` type):

```ts
/**
 * Generous for a real request, but a bound: nothing caps how much text ends
 * up in a task's `text` field before it's queued, so an accidental giant
 * paste (via `!task`) or a runaway tool call (via `queueTask`) would go
 * straight into a run's prompt with no warning otherwise. Shared by every
 * caller that creates a task from free-form text.
 */
export const MAX_TASK_TEXT_LENGTH = 4000;
```

In `src/control/bot.ts`, delete this block (currently just above `formatTaskDetail`):

```ts
/**
 * Generous for a real request, but a bound: nothing today caps how much text
 * `!task` accepts before queuing it, so an accidental giant paste would go
 * straight into a run's prompt with no warning. Independent of any one
 * transport's own limit (Discord's real messages already cap at 2000
 * characters, but a task's text is assembled from `msg.content`, which a
 * different transport could hand over uncapped).
 */
const MAX_TASK_TEXT_LENGTH = 4000;
```

And change the import line:

```ts
import type { Task, TaskStore } from "./task-store.js";
```

to:

```ts
import { MAX_TASK_TEXT_LENGTH, type Task, type TaskStore } from "./task-store.js";
```

- [ ] **Step 2: Run the existing suite to prove the relocation changed nothing**

Run: `npx vitest run --exclude "**/.claude/**" tests/bot.test.ts tests/task-store.test.ts`
Expected: PASS, same counts as before this step.

- [ ] **Step 3: Commit the relocation**

```bash
git add src/control/task-store.ts src/control/bot.ts
git commit -m "refactor: move MAX_TASK_TEXT_LENGTH to task-store.ts so queueTask can share it"
```

- [ ] **Step 4: Write the failing tests for the `queueTask` tool**

Note on test shape: the design spec mentions a possible `FakeRunner`-driven
end-to-end test, but `FakeRunner` has no concept of MCP tools at all — it
just yields a scripted list of `RunEvent`s, bypassing `canUseTool`/
`mcpServers` entirely. Neither `AskHuman` nor `mergePR`/`postReviewComment`
(the two existing MCP tools) have a `FakeRunner`-based test either, for the
same reason — they're tested by mocking the SDK's `query()` call directly,
exactly as `sdk-runner-options.test.ts` already does. This test file follows
that same, already-established pattern rather than inventing a new one.

Create `tests/sdk-runner-queue-task.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingStore } from "../src/control/pending.js";
import { MAX_TASK_TEXT_LENGTH, TaskStore } from "../src/control/task-store.js";
import type { AgentDef } from "../src/registry.js";
import type { RunEvent } from "../src/runner/types.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: queryMock };
});

const { SdkRunner } = await import("../src/runner/sdk-runner.js");

function stream(messages: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

const AGENT = {
  name: "opportunity-scout",
  run: { model: "claude-haiku-4-5", effort: "low", maxTurns: 15, timeoutMinutes: 5, maxBudgetUsd: 0.5 },
  permissions: { allowedTools: ["WebSearch"], disallowedTools: [] },
} as unknown as AgentDef;

const CTX = { runId: "scout-run", workspace: "/tmp/ws/opportunity-scout", prompt: "Find a way to make money." };

const RESULT_MESSAGE = {
  type: "result", subtype: "success", is_error: false,
  usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.001, duration_ms: 100,
};

interface QueueTaskParams {
  options: {
    mcpServers: Record<
      string,
      { instance?: { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> } } | undefined
    >;
  };
}

async function collect(iterable: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

afterEach(() => {
  queryMock.mockReset();
  vi.unstubAllEnvs();
});

describe("SdkRunner queueTask tool", () => {
  it("is not registered when tasks/wake are not wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir) });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    expect(params.options.mcpServers.taskQueue).toBeUndefined();
  });

  it("is registered, and queues a task, when tasks/wake are wired in", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    const result = await handler({ text: "Research whether X is a viable niche." });

    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Queued task") }] });
    const created = await tasks.list();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      text: "Research whether X is a viable niche.",
      priority: 30,
      createdBy: "agent:opportunity-scout",
      wantsDetail: true,
      status: "pending",
    });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit priority when one is given, instead of the self-queued default", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({ text: "Urgent-ish idea.", priority: 70 });

    const created = await tasks.list();
    expect(created[0]?.priority).toBe(70);
  });

  it("refuses a 4th queueTask call in the same run, and does not queue it", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask!.handler;

    await handler({ text: "one" });
    await handler({ text: "two" });
    await handler({ text: "three" });
    const fourth = await handler({ text: "four" });

    expect(fourth).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Refused") }] });
    expect(await tasks.list()).toHaveLength(3);
  });

  it("rejects an empty or oversized text at the schema level, before any task is created", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const wake = vi.fn().mockResolvedValue(undefined);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks, wake });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const instance = params.options.mcpServers.taskQueue!.instance as unknown as { connect: (t: unknown) => Promise<void> };
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([instance.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "queueTask", arguments: { text: "x".repeat(MAX_TASK_TEXT_LENGTH + 1) } });

    expect(result.isError).toBe(true);
    expect(await tasks.list()).toEqual([]);
    await client.close();
  });
});
```

- [ ] **Step 5: Run the new tests to verify they fail**

Run: `npx vitest run --exclude "**/.claude/**" tests/sdk-runner-queue-task.test.ts`
Expected: FAIL — `params.options.mcpServers.taskQueue` doesn't exist yet (the first test may pass trivially since it expects `undefined`; the rest must fail).

- [ ] **Step 6: Implement the `queueTask` tool in `sdk-runner.ts`**

Add to the imports at the top of `src/runner/sdk-runner.ts` (alongside the existing `PendingStore` import):

```ts
import { TaskStore, MAX_TASK_TEXT_LENGTH } from "../control/task-store.js";
```

Change the `SdkRunner` constructor (currently at line 202-208):

```ts
export class SdkRunner implements Runner {
  constructor(
    private readonly deps: { grants: Grant[]; pending: PendingStore; github?: GithubTransport } = {
      grants: [],
      pending: new PendingStore(process.cwd()),
    },
  ) {}
```

to:

```ts
export class SdkRunner implements Runner {
  constructor(
    private readonly deps: {
      grants: Grant[];
      pending: PendingStore;
      github?: GithubTransport;
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

Immediately after the existing `githubPrServer` block (which ends right before `const stream = query({`), insert:

```ts
    /**
     * Lets any agent queue new work the same way a human's `!task` does — no
     * outward effect (it writes to this process's own task queue, not the
     * network), so it needs no grant and is available at every tier, the
     * same as `askHuman` above. Only registered when both `tasks` and `wake`
     * are wired in: production always wires both; a test or script that
     * doesn't care about task-queueing simply never sees this tool, the same
     * optional-dependency shape `github`/`githubPrServer` above already use.
     */
    const DEFAULT_SELF_QUEUED_PRIORITY = 30;
    const MAX_QUEUE_TASK_CALLS_PER_RUN = 3;
    let queueTaskCalls = 0;
    const tasksDep = this.deps.tasks;
    const wakeDep = this.deps.wake;
    const taskQueueServer =
      tasksDep && wakeDep
        ? createSdkMcpServer({
            name: "taskQueue",
            tools: [
              tool(
                "queueTask",
                "Queue a new task for the system to work on later — the same durable queue a human's !task command adds to. Use this to propose research or an improvement rather than doing it yourself in this run.",
                { text: z.string().min(1).max(MAX_TASK_TEXT_LENGTH), priority: z.number().int().nonnegative().optional() },
                async ({ text, priority }) => {
                  // A hard cap enforced here, not just in the prompt: the code is
                  // the boundary, the same posture detectOutwardEffect already
                  // uses for outward effects — an over-eager or confused model
                  // must not be able to flood the queue in a single run.
                  if (queueTaskCalls >= MAX_QUEUE_TASK_CALLS_PER_RUN) {
                    return {
                      content: [
                        {
                          type: "text" as const,
                          text: `Refused: already queued ${MAX_QUEUE_TASK_CALLS_PER_RUN} tasks this run, the maximum allowed in one run.`,
                        },
                      ],
                    };
                  }
                  queueTaskCalls += 1;
                  const created = await tasksDep.create({
                    text,
                    priority: priority ?? DEFAULT_SELF_QUEUED_PRIORITY,
                    createdBy: `agent:${agent.name}`,
                    wantsDetail: true,
                  });
                  void wakeDep().catch((err: unknown) => {
                    console.error(`[queueTask] dispatcher wake failed after queuing ${created.id} (agent ${agent.name})`, err);
                  });
                  return { content: [{ type: "text" as const, text: `Queued task ${created.id}.` }] };
                },
              ),
            ],
          })
        : undefined;
```

Then update the `mcpServers` field inside the `query({ ... options: { ... } })` call (currently `mcpServers: { askHuman: askHumanServer, ...(githubPrServer ? { githubPr: githubPrServer } : {}) },`) to:

```ts
        mcpServers: {
          askHuman: askHumanServer,
          ...(githubPrServer ? { githubPr: githubPrServer } : {}),
          ...(taskQueueServer ? { taskQueue: taskQueueServer } : {}),
        },
```

- [ ] **Step 7: Run the new tests to verify they pass**

Run: `npx vitest run --exclude "**/.claude/**" tests/sdk-runner-queue-task.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm run typecheck && npx vitest run --exclude "**/.claude/**"`
Expected: both clean. (`sdk-runner-options.test.ts` and `sdk-runner.test.ts` must be unaffected — neither passes `tasks`/`wake`, so `taskQueue` is simply never registered for them.)

- [ ] **Step 9: Commit**

```bash
git add src/runner/sdk-runner.ts tests/sdk-runner-queue-task.test.ts
git commit -m "feat: queueTask MCP tool, so any agent can queue new work like !task does"
```

---

### Task 2: Wire `queueTask` into production

**Files:**
- Modify: `src/runner/build-runner.ts`
- Modify: `src/index.ts:11,54-64,84,168-176` (exact lines may have shifted after Task 1; locate by content, not line number)
- Modify: `tests/build-runner.test.ts`

**Interfaces:**
- Consumes: `SdkRunner`'s new optional `tasks`/`wake` deps (Task 1). `Dispatcher.wake(): Promise<void>` (existing, `src/control/dispatcher.ts`).
- Produces: nothing new downstream — this task only wires existing pieces together in the real boot path.

- [ ] **Step 1: Write the failing test proving `buildRunner` should accept `tasks`/`wake`**

In `tests/build-runner.test.ts`, add this import:

```ts
import { TaskStore } from "../src/control/task-store.js";
```

and add a new test inside `describe("buildRunner", ...)`, after the existing "passes the grants and pending store through" test:

```ts
  it("accepts tasks/wake and still returns the real runner when provided", () => {
    const { grants, pending } = opts();
    const tasks = new TaskStore(mkdtempSync(join(tmpdir(), "cai-buildrunner-")));
    const wake = async () => {};
    const runner = buildRunner({ grants, pending, tasks, wake }, {}) as SdkRunner;
    expect(runner).toBeInstanceOf(SdkRunner);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --exclude "**/.claude/**" tests/build-runner.test.ts`
Expected: FAIL — a TypeScript error, since `buildRunner`'s current options type has no `tasks`/`wake` fields (`{ grants, pending, tasks, wake }` isn't assignable to `{ grants: Grant[]; pending: PendingStore; github?: GithubTransport }`).

- [ ] **Step 3: Add `tasks`/`wake` to `buildRunner`'s options type**

In `src/runner/build-runner.ts`, add an import:

```ts
import type { TaskStore } from "../control/task-store.js";
```

Change the `buildRunner` signature from:

```ts
export function buildRunner(
  opts: { grants: Grant[]; pending: PendingStore; github?: GithubTransport },
  env: NodeJS.ProcessEnv = process.env,
): Runner {
```

to:

```ts
export function buildRunner(
  opts: { grants: Grant[]; pending: PendingStore; github?: GithubTransport; tasks?: TaskStore; wake?: () => Promise<void> },
  env: NodeJS.ProcessEnv = process.env,
): Runner {
```

(The `return new SdkRunner(opts);` line below is unchanged — `opts` already carries the new fields through structurally.)

- [ ] **Step 4: Run it again to verify it passes**

Run: `npx vitest run --exclude "**/.claude/**" tests/build-runner.test.ts`
Expected: PASS, all tests including the new one.

- [ ] **Step 5: Wire real `tasks`/`wake` into `src/index.ts`**

Find the block of `let` declarations near the top of `main()` (currently):

```ts
  let config: Config;
  let agents: AgentDef[];
  let runner: Runner;
  let credentialMode: string | undefined;
  let botToken: string;
  let ownerId: string;
  let githubToken: string;
  let webhookSecret: string;
  let webhookPort: number;
  let github: GithubApiTransport;
```

Add one more declaration:

```ts
  let dispatcher: Dispatcher | undefined;
```

Find the `runner = buildRunner(...)` call:

```ts
    runner = buildRunner({ grants, pending: new PendingStore(DATA_DIR), github });
```

Change it to:

```ts
    runner = buildRunner({
      grants, pending: new PendingStore(DATA_DIR), github,
      tasks: new TaskStore(DATA_DIR),
      // Late-bound: `dispatcher` isn't constructed until after boot's config/
      // credential validation completes (same reason `bot` below is late-bound
      // too) — but this closure is only ever CALLED much later, once a real
      // agent run actually invokes queueTask, by which point `dispatcher`
      // is always set.
      wake: async () => { if (dispatcher) await dispatcher.wake(); },
    });
```

(`TaskStore` is already imported in `src/index.ts` — no new import needed.)

Find the dispatcher construction further down:

```ts
  const dispatcher = new Dispatcher({
    tasks,
    router,
    agents,
    orchestrator,
    dataDir: DATA_DIR,
    notify: async (text) => {
      await outbox.postAlert("smoke", text);
    },
  });
```

Change `const dispatcher =` to `dispatcher =` (drop `const` — it now assigns the `let` declared above):

```ts
  dispatcher = new Dispatcher({
    tasks,
    router,
    agents,
    orchestrator,
    dataDir: DATA_DIR,
    notify: async (text) => {
      await outbox.postAlert("smoke", text);
    },
  });
```

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npm run typecheck && npx vitest run --exclude "**/.claude/**"`
Expected: both clean. `src/index.ts` has no direct unit tests (it runs `main()` on import), so a clean typecheck plus the existing `boot-wiring.test.ts`/`dispatcher.test.ts` staying green is this step's verification.

- [ ] **Step 7: Commit**

```bash
git add src/runner/build-runner.ts src/index.ts tests/build-runner.test.ts
git commit -m "feat: wire queueTask's tasks/wake deps into the real boot path"
```

---

### Task 3: `opportunity-scout` agent

**Files:**
- Create: `agents/opportunity-scout/agent.yaml`
- Create: `agents/opportunity-scout/prompt.md`

**Interfaces:**
- Consumes: the `queueTask` tool (Tasks 1-2), `WebSearch` (built-in, already ungated for every tier).
- Produces: nothing consumed by a later task — this is a leaf.

- [ ] **Step 1: Create the agent definition**

Create `agents/opportunity-scout/agent.yaml`:

```yaml
name: opportunity-scout
enabled: true
authoredBy: claude-local
description: >-
  Looks for plausible ways this system or its operator could earn money,
  and queues well-scoped research questions for the research specialist to
  investigate. Proposes only — never researches or spends itself.

trigger:
  type: cron
  schedule: "0 6 * * *"
  timezone: Europe/Berlin

run:
  model: claude-haiku-4-5
  effort: low
  maxTurns: 15
  timeoutMinutes: 5
  maxBudgetUsd: 0.50

permissions:
  allowedTools: [WebSearch]
  disallowedTools: []

tier: readonly
approval: notify
grantRefs: []

outbox:
  discord: smoke
  notifyOn: [success, failure]
```

- [ ] **Step 2: Write the prompt**

Create `agents/opportunity-scout/prompt.md`:

```markdown
You decide what, if anything, is worth investigating as a way to earn
money with this system or for its operator — you do not do the research
yourself.

## Your job

Use WebSearch to get a sense of current opportunities, trends, or gaps
worth a closer look. Then queue up to 3 well-scoped research questions via
the `queueTask` tool — each one specific enough that a research agent
picking it up later knows exactly what to look into and why it might be
worth money. Do not write anything else, and do not attempt the research
yourself.

## What makes a good task

Specific, not generic: "research the market for X, focused on Y" is
useful; "look into ways to make money" is not — narrowing that down is
your job, not the research agent's. Say why it's plausible, based on what
you found.

If nothing looks genuinely promising today, it's fine to queue nothing at
all — a forced, low-value task queued out of obligation is worse than
none.
```

- [ ] **Step 3: Confirm the new agent loads and validates correctly**

Run: `npm run typecheck && npx vitest run --exclude "**/.claude/**" tests/registry.test.ts`
Expected: both clean — `registry.test.ts` exercises `loadRegistry` against temp-directory fixtures, not the real `agents/` folder, so this step is really about proving the YAML itself is well-formed and matches the schema. To directly sanity-check that (this project is ESM — `"type": "module"` in `package.json` — so use `tsx`, not a `require()`-based inline script), run from the repo root:

```bash
npx tsx -e "
import { loadConfig } from './src/config.js';
import { loadRegistry } from './src/registry.js';
const config = loadConfig('config.yaml');
const agents = loadRegistry({ agentsDir: 'agents', dataDir: '.data-check', config });
console.log(agents.map((a) => a.name));
"
```

Expected: prints a list of agent names including `opportunity-scout`, with no thrown `ValidationError`. (If this inline check is awkward in your shell, running the full app briefly with `RUNNER=fake docker compose up --build` and checking the boot log's `[boot] N agent(s) loaded: ...` line is an equally valid way to confirm the same thing.)

- [ ] **Step 4: Document it in the README**

In `README.md`, find this paragraph (in the "The task queue" section):

```
Today there is exactly one specialist, `research`: it
searches and reads the open web and writes up what it finds, with no code
changes, no publishing, and no spending.
```

Leave it as-is (still accurate — `opportunity-scout` is a `cron` agent, not a `dispatched` specialist), and add a new paragraph immediately after the existing digest/retention section (before "## Development"):

```markdown
**The system can queue its own tasks, not just yours.** Two cron-triggered
agents run daily and each propose up to 3 tasks via a `queueTask` tool —
no human approval needed to queue, matching every other read-only or
proposal-only action in this system. A self-queued task is
indistinguishable from a `!task` one once it exists — same routing, same
Governor admission, same `!tasks`/`!result`/digest visibility — except its
`createdBy` reads `agent:<name>` instead of `discord:<id>`, and it starts
at a lower default priority (30 vs. 50) so it never queues ahead of
something a human actually asked for. `opportunity-scout` looks for
plausible ways to earn money and queues research questions for `research`
to investigate. `improvement-scout` reads this project's own source and
docs and queues concrete gaps or capability ideas. Neither can write,
push, fetch, or spend beyond proposing — both run at `tier: readonly`.
```

- [ ] **Step 5: Commit**

```bash
git add agents/opportunity-scout README.md
git commit -m "feat: opportunity-scout agent, proposing money-making research tasks"
```

---

### Task 4: `improvement-scout` agent

**Files:**
- Create: `agents/improvement-scout/agent.yaml`
- Create: `agents/improvement-scout/prompt.md`

**Interfaces:**
- Consumes: the `queueTask` tool (Tasks 1-2), `Read`/`Glob`/`Grep` (built-in, already ungated for every tier).
- Produces: nothing consumed by a later task — this is a leaf.

- [ ] **Step 1: Create the agent definition**

Create `agents/improvement-scout/agent.yaml`:

```yaml
name: improvement-scout
enabled: true
authoredBy: claude-local
description: >-
  Reads this project's own source and docs, and queues concrete
  improvement/bugfix/capability ideas as tasks for later review. Proposes
  only — never writes or changes anything itself.

trigger:
  type: cron
  schedule: "0 7 * * *"
  timezone: Europe/Berlin

run:
  model: claude-haiku-4-5
  effort: low
  maxTurns: 30
  timeoutMinutes: 15
  maxBudgetUsd: 1.00

permissions:
  allowedTools: [Read, Glob, Grep]
  disallowedTools: []

tier: readonly
approval: notify
grantRefs: []

outbox:
  discord: smoke
  notifyOn: [success, failure]
```

- [ ] **Step 2: Write the prompt**

Create `agents/improvement-scout/prompt.md`:

```markdown
You look for concrete ways this system could be improved, fixed, or
expanded — you do not make the change yourself.

## What to read

This is the `claude-agent-infrastructure` project's own source, rooted at
`/app` (use absolute paths — your working directory is not the repo):

- `/app/src/` — the actual implementation
- `/app/README.md` and `/app/CONFIGURING.md` — what the system does and how
  it's configured
- `/app/docs/superpowers/specs/` and `/app/docs/superpowers/plans/` —
  design decisions already made, including things ALREADY deliberately
  deferred. Read these before proposing something: if a spec already names
  and explains deferring an idea, don't re-propose it as if it were new —
  only surface it again if you have a genuinely new argument for doing it
  now.

## Your job

Find up to 3 concrete things worth doing: a bug, a missing safeguard, a
gap between what's documented and what the code actually does, or a
capability worth adding. Queue each one via the `queueTask` tool,
described precisely enough that whoever picks it up later — a human, or a
future coding agent — knows exactly what to do and why, including the
specific file(s) involved.

You have no ability to write or change anything — this is read-and-propose
only. If nothing concrete stands out, it's fine to queue nothing at all.
```

- [ ] **Step 3: Confirm the new agent loads and validates correctly**

Same check as Task 3 Step 3 — run `npm run typecheck`, and re-run the inline `loadRegistry` sanity check (or a fresh `RUNNER=fake docker compose up --build` boot log check) and confirm `improvement-scout` appears in the loaded agent list alongside `opportunity-scout`.

- [ ] **Step 4: Extend the README paragraph added in Task 3**

The paragraph added in Task 3 already describes both agents together — no further README change needed here. Re-read it once both `agent.yaml` files exist and confirm nothing in it has gone stale (schedule times, tier, tool lists) now that both are real files, not just described in prose.

- [ ] **Step 5: Run the full suite one last time**

Run: `npm run typecheck && npx vitest run --exclude "**/.claude/**"`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add agents/improvement-scout
git commit -m "feat: improvement-scout agent, proposing codebase improvement tasks"
```
