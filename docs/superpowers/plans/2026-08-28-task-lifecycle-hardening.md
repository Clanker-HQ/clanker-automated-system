# Task Lifecycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the two daily scout agents memory of their own past proposals and a system-wide failure-pattern signal, and replace the dispatcher's single no-delay retry with a bounded exponential backoff.

**Architecture:** Two new ungated, read-only MCP tools (`listMyTasks`, `recentFailures`) join the existing `taskQueue` server in `src/runner/sdk-runner.ts`, gated only on whether a `TaskStore` is wired in (not on `wake`, which only `queueTask` needs). `TaskStore` gains a `nextRetryAt` field that `nextPending`/`claimNextPending` respect, and `dispatcher.ts`'s failure branch grows from a 1-attempt to a 3-attempt exponential backoff schedule.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`/`tool`), `zod`, `vitest`, ESM.

**Spec:** `docs/superpowers/specs/2026-08-28-task-lifecycle-hardening-design.md`

## Global Constraints

- `listMyTasks`: returns at most the 20 most recent tasks whose `createdBy` matches the calling agent's own name, sorted newest-first, `text` truncated to 200 characters (+ `…`).
- `recentFailures`: aggregates `status: "failed"` tasks with `finishedAt` in the last 14 days, grouped by `(specialistAgent ?? "unrouted", failureReason truncated to 80 chars)`, sorted by count descending, capped at the top 10 buckets. Never includes raw task `text`.
- Retry backoff schedule: `[60_000, 300_000, 900_000]` ms (1/5/15 minutes); `MAX_RETRIES = 3` (replaces today's cap of `1`).
- No `agent.yaml`/`allowedTools` changes for either new tool — custom MCP-server tools in this codebase are gated by server *registration*, not the SDK's `tools` allowlist (see the comment at the `query()` call site in `sdk-runner.ts`).

---

### Task 1: `TaskStore` gains `nextRetryAt` and honors it when claiming

**Files:**
- Modify: `src/control/task-store.ts:24-43` (the `Task` interface), `:118-126` (`update` — unchanged, but the doc comment below needs a small fix), `:128-140` (`nextPending`), `:142-155` (`claimNextPending`)
- Test: `tests/task-store.test.ts`

**Interfaces:**
- Produces: `Task.nextRetryAt?: string` (ISO timestamp). `nextPending(exclude?: ReadonlySet<string>, now?: Date): Promise<Task | null>` — new optional second parameter, defaulting to `new Date()`. `claimNextPending(exclude, startedAt)`'s existing signature is unchanged; it now derives `now` from `new Date(startedAt)` internally and passes it to `nextPending`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/task-store.test.ts`, near the existing `nextPending`/`claimNextPending` tests:

```ts
  it("nextPending skips a task whose nextRetryAt is still in the future", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { nextRetryAt: "2026-08-28T01:00:00.000Z" });
    expect(await s.nextPending(new Set(), new Date("2026-08-28T00:30:00.000Z"))).toBeNull();
  });

  it("nextPending picks up a task once its nextRetryAt has passed", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { nextRetryAt: "2026-08-28T01:00:00.000Z" });
    expect((await s.nextPending(new Set(), new Date("2026-08-28T01:00:01.000Z")))?.id).toBe(task.id);
  });

  it("claimNextPending skips a task whose nextRetryAt is still in the future relative to startedAt", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { nextRetryAt: "2026-08-28T01:00:00.000Z" });
    expect(await s.claimNextPending(new Set(), "2026-08-28T00:30:00.000Z")).toBeNull();
    expect((await s.get(task.id))?.status).toBe("pending");
  });

  it("claimNextPending claims a task once startedAt is past its nextRetryAt", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "discord:owner" });
    await s.update(task.id, { nextRetryAt: "2026-08-28T01:00:00.000Z" });
    const claimed = await s.claimNextPending(new Set(), "2026-08-28T01:00:01.000Z");
    expect(claimed?.id).toBe(task.id);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/task-store.test.ts`
Expected: FAIL — `nextRetryAt` doesn't exist on the update patch type yet / `nextPending` ignores the second argument, so the first two new tests fail (a task with a future `nextRetryAt` is still returned) and the field itself doesn't type-check.

- [ ] **Step 3: Add the field and the filtering logic**

In `src/control/task-store.ts`, add the field to `Task` (right after `retryCount`, `:40`):

```ts
  /** How many times the dispatcher has silently retried this task after a failed run — capped at 3 (see MAX_RETRIES in dispatcher.ts) before it's actually marked "failed". */
  retryCount?: number;
  /**
   * Set together with retryCount on a failed run: the earliest time this
   * task is eligible to be claimed again. nextPending/claimNextPending
   * exclude it until then, so a transient failure backs off instead of
   * being retried on the very next dispatcher tick.
   */
  nextRetryAt?: string;
```

(Note the `retryCount` doc comment's cap changes from "capped at 1" to "capped at 3" — Task 2 is what actually changes the cap in `dispatcher.ts`, but this comment lives here.)

Replace `nextPending` (`:135-140`):

```ts
  async nextPending(exclude: ReadonlySet<string> = new Set(), now: Date = new Date()): Promise<Task | null> {
    const pending = (await this.list()).filter(
      (t) => t.status === "pending" && !exclude.has(t.id) && (!t.nextRetryAt || new Date(t.nextRetryAt) <= now),
    );
    if (pending.length === 0) return null;
    pending.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    return pending[0]!;
  }
```

Replace `claimNextPending` (`:149-155`):

```ts
  async claimNextPending(exclude: ReadonlySet<string>, startedAt: string): Promise<Task | null> {
    return this.mutex.run(TaskStore.CLAIM_KEY, async () => {
      const task = await this.nextPending(exclude, new Date(startedAt));
      if (!task) return null;
      return this.update(task.id, { status: "running", startedAt });
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/task-store.test.ts`
Expected: PASS — all tests in the file, including the 4 new ones and every pre-existing one (`nextPending()` called with no arguments still defaults to `new Date()`, so untouched tests are unaffected).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/control/task-store.ts tests/task-store.test.ts
git commit -m "feat: TaskStore honors a nextRetryAt backoff timestamp when claiming"
```

---

### Task 2: Dispatcher backs off exponentially instead of retrying once

**Files:**
- Modify: `src/control/dispatcher.ts:78-92` (the `DispatchOutcome` doc comment), `:203-221` (the failure branch in `executeAndFinalize`)
- Test: `tests/dispatcher.test.ts`

**Interfaces:**
- Consumes: `Task.nextRetryAt` (Task 1).
- Produces: no new exported symbols — `executeAndFinalize`'s existing failure branch behavior changes from a 1-attempt to a 3-attempt schedule, still returning `{ ran: true, taskId, deferred: true }` on every attempt short of the last.

- [ ] **Step 1: Update the three existing tests that assumed a 1-retry cap**

These three tests in `tests/dispatcher.test.ts` set `retryCount: 1` to reach the "already exhausted" branch under the *old* cap of 1. Under the new cap of 3, `retryCount: 1` is still within budget and would back off instead of failing — each needs `retryCount: 3` instead, so the test still exercises "this is the exhausted case."

Replace the test at `:103-116` (`"marks the task failed, with the run's own error, on a second consecutive failure"`):

```ts
  it("marks the task failed, with the run's own error, once all 3 retries are exhausted", async () => {
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, { retryCount: 3 });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const outcome = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir,
    });
    expect(outcome).toEqual({ ran: true, taskId: task.id });
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.failureReason).toBe("boom");
  });
```

Replace the `retryCount: 1` line and its comment at `:213` (inside `"notifies with the task id and the error on a failed run"`) with:

```ts
    await tasks.update(task.id, { retryCount: 3 }); // past all 3 retries, so this failure actually notifies
```

Replace the `retryCount: 1` line and its comment at `:271` (inside `"keeps the run's own failureReason when the failure notify rejects"`) with:

```ts
      await tasks.update(task.id, { retryCount: 3 }); // past all 3 retries
```

- [ ] **Step 2: Write the new failing tests for the backoff schedule**

Add near the (now-renamed) test from Step 1:

```ts
  it("backs off for 1 minute, keeping the task pending, after the first failure", async () => {
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const notify = vi.fn().mockResolvedValue(undefined);
    const now = () => new Date("2026-08-28T00:00:00.000Z");
    const outcome = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify, dataDir, now,
    });
    expect(outcome).toEqual({ ran: true, taskId: task.id, deferred: true });
    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("pending");
    expect(updated?.retryCount).toBe(1);
    expect(updated?.nextRetryAt).toBe("2026-08-28T00:01:00.000Z");
    expect(updated?.finishedAt).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("backs off for 5 minutes on the second failure, and 15 minutes on the third", async () => {
    const { tasks, dataDir } = taskStore();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, { retryCount: 1 });
    const executeRun = vi.fn().mockResolvedValue(successResult({ status: "failed", error: "boom" }));
    const now = () => new Date("2026-08-28T00:00:00.000Z");

    const second = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, now,
    });
    expect(second).toEqual({ ran: true, taskId: task.id, deferred: true });
    expect((await tasks.get(task.id))?.retryCount).toBe(2);
    expect((await tasks.get(task.id))?.nextRetryAt).toBe("2026-08-28T00:05:00.000Z");

    // Simulate the backoff window having passed so this task is claimable again.
    await tasks.update(task.id, { nextRetryAt: undefined });
    const third = await runDispatchTick({
      tasks, router: new FakeRouter("research"), agents: [specialist()],
      orchestrator: { executeRun }, notify: vi.fn(), dataDir, now,
    });
    expect(third).toEqual({ ran: true, taskId: task.id, deferred: true });
    expect((await tasks.get(task.id))?.retryCount).toBe(3);
    expect((await tasks.get(task.id))?.nextRetryAt).toBe("2026-08-28T00:15:00.000Z");
  });
```

- [ ] **Step 3: Run the tests to verify the new ones fail and the updated ones still fail for the right reason**

Run: `npx vitest run tests/dispatcher.test.ts`
Expected: FAIL — the two new backoff tests fail because `nextRetryAt` is never set and `retryCount` still caps at 1 (the task is marked `"failed"` after only 1 attempt instead of backing off); the three updated `retryCount: 3` tests fail because the *old* code fails the task after 1 retry regardless of `retryCount`'s value only mattering at the `< 1` check — i.e. they still reach `"failed"`, but via the old single-check path, not proof the new 3-attempt logic exists yet. (This is expected — Step 4 makes the underlying logic match.)

- [ ] **Step 4: Implement the backoff schedule**

In `src/control/dispatcher.ts`, add near the top of the file, after the `DETAIL_INSTRUCTION` constant (`:70`):

```ts
/** 1min, 5min, 15min — index i is the delay after the (i+1)th failure. */
const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000];
const MAX_RETRIES = RETRY_BACKOFF_MS.length;
```

Update the `DispatchOutcome` doc comment (`:82-92`) — replace "or the one silent auto-retry on a failed run" with "or a backoff retry on a failed run" (both occurrences: the leading sentence and the parenthetical later in the same comment about "~30s until the next periodic tick").

Replace the failure branch in `executeAndFinalize` (`:202-221`, the `else` branch handling a non-success/parked/question result):

```ts
    } else {
      const reason = result.error ?? `run ended with status "${result.status}"`;
      const previousRetries = task.retryCount ?? 0;
      if (previousRetries < MAX_RETRIES) {
        // Exponential backoff before bothering the owner: a lot of these are
        // transient (a flaky fetch, a momentary rate limit) rather than a
        // real problem with the task or the agent. specialistAgent is kept,
        // same as every other requeue-to-pending path here, so the retry
        // doesn't pay for a second routing call.
        const delayMs = RETRY_BACKOFF_MS[previousRetries]!;
        console.log(
          `[dispatcher] task ${task.id} failed (${reason}); retrying in ${delayMs / 1000}s (attempt ${previousRetries + 1}/${MAX_RETRIES})`,
        );
        await deps.tasks.update(task.id, {
          status: "pending",
          retryCount: previousRetries + 1,
          startedAt: undefined,
          nextRetryAt: new Date(now().getTime() + delayMs).toISOString(),
        });
        return { ran: true, taskId: task.id, deferred: true };
      }
      await deps.tasks.update(task.id, {
        status: "failed",
        finishedAt: now().toISOString(),
        failureReason: reason,
      });
      await notifyBestEffort(deps, `❌ Task \`${task.id}\` failed: ${reason}`);
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dispatcher.test.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 6: Typecheck, run the full suite, and commit**

Run: `npm run typecheck && npx vitest run --exclude "**/.claude/**"`
Expected: no type errors; full suite green.

```bash
git add src/control/dispatcher.ts tests/dispatcher.test.ts
git commit -m "feat: dispatcher backs off exponentially (1/5/15min) over 3 attempts instead of retrying once"
```

---

### Task 3: `listMyTasks` — scout self-history

**Files:**
- Modify: `src/runner/sdk-runner.ts:416-469` (the `taskQueueServer` construction)
- Test: `tests/sdk-runner-queue-task.test.ts`

**Interfaces:**
- Consumes: `TaskStore.list()` (existing).
- Produces: a `listMyTasks` tool on the `taskQueue` MCP server, registered whenever `this.deps.tasks` is present, independent of `this.deps.wake`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/sdk-runner-queue-task.test.ts`, after the existing `describe("SdkRunner queueTask tool", ...)` block (and before its closing nothing else needed — this is a new top-level `describe`):

```ts
describe("SdkRunner listMyTasks tool", () => {
  it("is registered even without wake — read-only, no dispatcher nudge needed", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    expect(params.options.mcpServers.taskQueue).toBeDefined();
    expect(params.options.mcpServers.taskQueue!.instance!._registeredTools.queueTask).toBeUndefined();
    expect(params.options.mcpServers.taskQueue!.instance!._registeredTools.listMyTasks).toBeDefined();
  });

  it("returns only the calling agent's own tasks, most recent first, capped at 20", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    for (let i = 0; i < 25; i++) {
      await tasks.create({ text: `mine ${i}`, createdBy: "agent:opportunity-scout" });
    }
    await tasks.create({ text: "not mine", createdBy: "agent:improvement-scout" });
    await tasks.create({ text: "human", createdBy: "discord:owner" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.listMyTasks!.handler;

    const result = (await handler({})) as { content: { type: string; text: string }[] };
    const mine = JSON.parse(result.content[0]!.text) as { text: string }[];
    expect(mine).toHaveLength(20);
    expect(mine.every((t) => t.text.startsWith("mine "))).toBe(true);
    expect(mine[0]!.text).toBe("mine 24");
  });

  it("truncates a long task's text to 200 characters", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    await tasks.create({ text: "x".repeat(300), createdBy: "agent:opportunity-scout" });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.listMyTasks!.handler;

    const result = (await handler({})) as { content: { type: string; text: string }[] };
    const [mine] = JSON.parse(result.content[0]!.text) as { text: string }[];
    expect(mine!.text).toBe(`${"x".repeat(200)}…`);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sdk-runner-queue-task.test.ts`
Expected: FAIL — `taskQueue` server is currently `undefined` when `tasks` is given without `wake` (the whole server construction is gated on both), so every test in this new `describe` block fails.

- [ ] **Step 3: Implement `listMyTasks` and change the registration condition**

In `src/runner/sdk-runner.ts`, replace the entire block from the `DEFAULT_SELF_QUEUED_PRIORITY` constant through the end of `taskQueueServer`'s definition (`:425-469`):

```ts
    const DEFAULT_SELF_QUEUED_PRIORITY = 30;
    const MAX_QUEUE_TASK_CALLS_PER_RUN = 3;
    const LIST_MY_TASKS_LIMIT = 20;
    const LIST_MY_TASKS_TEXT_TRUNCATE = 200;
    let queueTaskCalls = 0;
    const tasksDep = this.deps.tasks;
    const wakeDep = this.deps.wake;
    /**
     * `listMyTasks` and `recentFailures` need only `tasksDep` — they never
     * touch the dispatcher. `queueTask` additionally needs `wakeDep`, so it's
     * included conditionally within this same server rather than gating the
     * whole server on both, the way it did before this tool existed.
     */
    const taskQueueServer = tasksDep
      ? createSdkMcpServer({
          name: "taskQueue",
          tools: [
            ...(wakeDep
              ? [
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
                        priority: Math.min(priority ?? DEFAULT_SELF_QUEUED_PRIORITY, DEFAULT_SELF_QUEUED_PRIORITY),
                        createdBy: `agent:${agent.name}`,
                        wantsDetail: true,
                      });
                      void wakeDep().catch((err: unknown) => {
                        console.error(`[queueTask] dispatcher wake failed after queuing ${created.id} (agent ${agent.name})`, err);
                      });
                      return { content: [{ type: "text" as const, text: `Queued task ${created.id}.` }] };
                    },
                  ),
                ]
              : []),
            tool(
              "listMyTasks",
              "List the tasks you've queued yourself via queueTask, most recent first — use this before proposing new work so you don't repeat an idea you already queued.",
              {},
              async () => {
                const mine = (await tasksDep.list())
                  .filter((t) => t.createdBy === `agent:${agent.name}`)
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .slice(0, LIST_MY_TASKS_LIMIT)
                  .map((t) => ({
                    id: t.id,
                    text: t.text.length > LIST_MY_TASKS_TEXT_TRUNCATE ? `${t.text.slice(0, LIST_MY_TASKS_TEXT_TRUNCATE)}…` : t.text,
                    status: t.status,
                    createdAt: t.createdAt,
                  }));
                return { content: [{ type: "text" as const, text: JSON.stringify(mine, null, 2) }] };
              },
            ),
          ],
        })
      : undefined;
```

(This step deliberately only adds `listMyTasks` — `recentFailures` is Task 4's job, added to the same `tools` array.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sdk-runner-queue-task.test.ts`
Expected: PASS — every test in the file, both the pre-existing `queueTask` tests (still registered correctly whenever `wake` is also present) and the new `listMyTasks` tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/runner/sdk-runner.ts tests/sdk-runner-queue-task.test.ts
git commit -m "feat: add listMyTasks tool so an agent can see its own past self-queued proposals"
```

---

### Task 4: `recentFailures` — aggregate failure signal

**Files:**
- Modify: `src/runner/sdk-runner.ts` (the `tools` array built in Task 3, adding one more tool)
- Test: `tests/sdk-runner-queue-task.test.ts`

**Interfaces:**
- Consumes: `TaskStore.list()`, `Task.status`/`Task.finishedAt`/`Task.specialistAgent`/`Task.failureReason` (all existing fields).
- Produces: a `recentFailures` tool on the `taskQueue` server, registered under the same `tasksDep`-only condition as `listMyTasks`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `tests/sdk-runner-queue-task.test.ts`, after the `listMyTasks` block from Task 3:

```ts
describe("SdkRunner recentFailures tool", () => {
  async function failedTask(
    tasks: TaskStore,
    opts: { text: string; specialistAgent?: string; failureReason?: string; finishedAt: string },
  ) {
    const t = await tasks.create({ text: opts.text, createdBy: "discord:owner" });
    return tasks.update(t.id, {
      status: "failed",
      specialistAgent: opts.specialistAgent,
      failureReason: opts.failureReason,
      finishedAt: opts.finishedAt,
    });
  }

  it("is registered whenever tasks is wired in, independent of wake", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    expect(params.options.mcpServers.taskQueue!.instance!._registeredTools.recentFailures).toBeDefined();
  });

  it("groups failures by specialist and truncated reason, sorted by count descending", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const recent = "2026-08-28T00:00:00.000Z";
    await failedTask(tasks, { text: "a", specialistAgent: "research", failureReason: "boom", finishedAt: recent });
    await failedTask(tasks, { text: "b", specialistAgent: "research", failureReason: "boom", finishedAt: recent });
    await failedTask(tasks, { text: "c", specialistAgent: "research", failureReason: "boom", finishedAt: recent });
    await failedTask(tasks, { text: "d", specialistAgent: "builder", failureReason: "other", finishedAt: recent });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.recentFailures!.handler;

    const result = (await handler({})) as { content: { type: string; text: string }[] };
    const buckets = JSON.parse(result.content[0]!.text) as { specialistAgent: string; reason: string; count: number }[];
    expect(buckets[0]).toMatchObject({ specialistAgent: "research", reason: "boom", count: 3 });
    expect(buckets[1]).toMatchObject({ specialistAgent: "builder", reason: "other", count: 1 });
  });

  it("excludes failures older than 14 days", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    await failedTask(tasks, { text: "a", specialistAgent: "research", failureReason: "boom", finishedAt: old });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.recentFailures!.handler;

    const result = (await handler({})) as { content: { type: string; text: string }[] };
    expect(JSON.parse(result.content[0]!.text)).toEqual([]);
  });

  it("never includes raw task text in its output", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-token-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "cai-sdkrunner-"));
    const tasks = new TaskStore(dir);
    await failedTask(tasks, {
      text: "a very specific and sensitive task description",
      specialistAgent: "research",
      failureReason: "boom",
      finishedAt: "2026-08-28T00:00:00.000Z",
    });
    queryMock.mockReturnValue(stream([RESULT_MESSAGE]));
    const runner = new SdkRunner({ grants: [], pending: new PendingStore(dir), tasks });
    await collect(runner.execute(AGENT, CTX, new AbortController().signal));
    const params = queryMock.mock.calls[0]![0] as QueueTaskParams;
    const handler = params.options.mcpServers.taskQueue!.instance!._registeredTools.recentFailures!.handler;

    const result = (await handler({})) as { content: { type: string; text: string }[] };
    expect(result.content[0]!.text).not.toContain("sensitive task description");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sdk-runner-queue-task.test.ts`
Expected: FAIL — `recentFailures` doesn't exist on `_registeredTools` yet, so every test in this new `describe` block fails.

- [ ] **Step 3: Implement `recentFailures`**

In `src/runner/sdk-runner.ts`, add three more constants next to the ones added in Task 3 (`LIST_MY_TASKS_LIMIT`/`LIST_MY_TASKS_TEXT_TRUNCATE`):

```ts
    const RECENT_FAILURES_WINDOW_DAYS = 14;
    const RECENT_FAILURES_TOP_N = 10;
    const RECENT_FAILURES_REASON_TRUNCATE = 80;
```

Add a new `tool(...)` entry to the `tools` array built in Task 3, immediately after the `listMyTasks` tool (still inside the `tasksDep ? createSdkMcpServer(...) : undefined` block, alongside `listMyTasks` — not inside the `wakeDep ? [...] : []` conditional, which is only for `queueTask`):

```ts
            tool(
              "recentFailures",
              "See aggregate patterns in recently failed tasks across the whole system — which specialist, what kind of failure, how often — over the last 14 days. Never includes the original task text.",
              {},
              async () => {
                const cutoff = Date.now() - RECENT_FAILURES_WINDOW_DAYS * 24 * 60 * 60 * 1000;
                const failed = (await tasksDep.list()).filter(
                  (t) => t.status === "failed" && t.finishedAt !== undefined && new Date(t.finishedAt).getTime() >= cutoff,
                );
                const buckets = new Map<string, { specialistAgent: string; reason: string; count: number; exampleTaskId: string }>();
                for (const t of failed) {
                  const specialistAgent = t.specialistAgent ?? "unrouted";
                  const reason = (t.failureReason ?? "(no reason recorded)").slice(0, RECENT_FAILURES_REASON_TRUNCATE);
                  const key = `${specialistAgent} ${reason}`;
                  const existing = buckets.get(key);
                  if (existing) existing.count += 1;
                  else buckets.set(key, { specialistAgent, reason, count: 1, exampleTaskId: t.id });
                }
                const top = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, RECENT_FAILURES_TOP_N);
                return { content: [{ type: "text" as const, text: JSON.stringify(top, null, 2) }] };
              },
            ),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sdk-runner-queue-task.test.ts`
Expected: PASS — every test in the file.

- [ ] **Step 5: Typecheck, run the full suite, and commit**

Run: `npm run typecheck && npx vitest run --exclude "**/.claude/**"`
Expected: no type errors; full suite green.

```bash
git add src/runner/sdk-runner.ts tests/sdk-runner-queue-task.test.ts
git commit -m "feat: add recentFailures tool so the system can surface its own failure patterns"
```

---

### Task 5: Scout prompts use `listMyTasks`/`recentFailures`

**Files:**
- Modify: `agents/opportunity-scout/prompt.md`, `agents/improvement-scout/prompt.md`

**Interfaces:**
- Consumes: `listMyTasks` (Task 3), `recentFailures` (Task 4) — both already callable by every agent regardless of `allowedTools` (see Global Constraints).

- [ ] **Step 1: Update `agents/opportunity-scout/prompt.md`**

Replace the entire file with:

```markdown
You decide what, if anything, is worth investigating as a way to earn
money with this system or for its operator — you do not do the research
yourself.

## Before you propose anything

Call `listMyTasks` to see what you've already queued in past runs. Don't
queue an idea that's already there unless something concrete has changed
since (new information, a different angle) — say what changed if you do.

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

If nothing looks genuinely promising today — including because everything
you'd propose is already sitting in your own history from `listMyTasks` —
it's fine to queue nothing at all. A forced, low-value task queued out of
obligation is worse than none.
```

- [ ] **Step 2: Update `agents/improvement-scout/prompt.md`**

Replace the entire file with:

```markdown
You look for concrete ways this system could be improved, fixed, or
expanded — you do not make the change yourself.

## Before you propose anything

Call `listMyTasks` to see what you've already queued in past runs, and
`recentFailures` to see whether any specialist has been failing the same
way repeatedly. Don't repeat an idea already in `listMyTasks` unless
something concretely changed. If `recentFailures` shows a real recurring
pattern (not a one-off), treat that as a legitimate improvement to
propose in its own right, alongside whatever you find reading source.

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
gap between what's documented and what the code actually does, a
recurring failure pattern from `recentFailures`, or a capability worth
adding. Queue each one via the `queueTask` tool, described precisely
enough that whoever picks it up later — a human, or a future coding
agent — knows exactly what to do and why, including the specific file(s)
involved.

You have no ability to write or change anything — this is read-and-propose
only. If nothing concrete stands out, it's fine to queue nothing at all.
```

- [ ] **Step 3: Verify both files mention the new tools**

Run: `grep -l "listMyTasks" agents/opportunity-scout/prompt.md agents/improvement-scout/prompt.md && grep -l "recentFailures" agents/improvement-scout/prompt.md`
Expected: both paths printed by the first command; the improvement-scout path printed by the second.

- [ ] **Step 4: Run the full suite one more time and commit**

Run: `npm run typecheck && npx vitest run --exclude "**/.claude/**"`
Expected: no type errors; full suite green (prompt.md files aren't covered by any test, so this just confirms nothing else broke).

```bash
git add agents/opportunity-scout/prompt.md agents/improvement-scout/prompt.md
git commit -m "docs: scouts use listMyTasks/recentFailures to avoid repeating themselves"
```
