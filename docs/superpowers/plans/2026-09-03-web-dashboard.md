# Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-page web dashboard (status, tasks, runs, config, world model, metrics) that reuses the exact same stores and validation `bot.ts` already calls, reachable from a phone browser, with no frontend framework and no new backend dependency.

**Architecture:** A second raw-`node:http` server (`DashboardServer`, alongside the existing `WebhookReceiver`) gates every route behind HTTP Basic Auth, then serves a static single-page frontend plus a JSON API that reads/writes the same `TaskStore`/`RunStore`/`ConfigOverridesStore`/`BreakerStore`/`WorldModel`/`MetricsStore`/`Governor` instances the Discord bot uses.

**Tech Stack:** TypeScript, `node:http`, `node:crypto` (constant-time Basic Auth check), Zod (reusing `QuietHoursSchema`), Vitest. Frontend: one static HTML file, vanilla JS, no build step.

**Spec:** `docs/superpowers/specs/2026-09-03-web-dashboard-design.md`

## Global Constraints

- No HTTP framework (Express/Fastify/etc.) — raw `node:http` only, matching `WebhookReceiver`.
- No database — all persistence goes through the existing JSON-file-backed stores; no new store type is introduced.
- The dashboard is optional: it starts only when both `DASHBOARD_USER` and `DASHBOARD_PASSWORD` are set (neither is `mustEnv`'d), mirroring `REVENUE_API_TOKEN`'s posture. Default port is `8788`.
- Every request, including the static page itself, passes the same Basic Auth check — no unauthenticated route exists.
- The Basic Auth check hashes both sides (SHA-256) before `timingSafeEqual`, so it never leaks timing or length information.
- Every write endpoint reuses the exact validation and store calls `bot.ts` already makes for the equivalent `!command`, with `setBy: "dashboard"` in place of `"discord"` — no validation rule is reimplemented or allowed to drift.
- No websockets/SSE — polling only.
- No VPS or domain provisioning as part of this plan — out of scope per the spec.
- No frontend framework or build step — one static HTML file, vanilla JS, CSS grid/flexbox with a mobile breakpoint.

---

### Task 1: Extract `resolveTaskByPrefix` into a shared module

**Files:**
- Create: `src/control/resolve-task.ts`
- Modify: `src/control/bot.ts:307-316` (delete the private method), `src/control/bot.ts:1-11` (add import), call sites at `src/control/bot.ts:464`, `:471`, `:494`
- Test: `tests/resolve-task.test.ts`

**Interfaces:**
- Produces: `resolveTaskByPrefix(tasks: TaskStore, prefix: string): Promise<{ task: Task } | { error: string; notFound: boolean }>` — `notFound: true` means zero matches (a 404 for callers that map this to HTTP); `notFound: false` means an ambiguous prefix matched more than one task (a 409). `bot.ts`'s three call sites only read `.error`, so this refinement doesn't change their behavior.

- [ ] **Step 1: Write the failing test**

```ts
// tests/resolve-task.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskStore } from "../src/control/task-store.js";
import { resolveTaskByPrefix } from "../src/control/resolve-task.js";

function store(): TaskStore {
  return new TaskStore(mkdtempSync(join(tmpdir(), "cai-resolve-")));
}

describe("resolveTaskByPrefix", () => {
  it("resolves a full id to its task", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "test" });
    expect(await resolveTaskByPrefix(s, task.id)).toEqual({ task });
  });

  it("resolves a short prefix that matches exactly one task", async () => {
    const s = store();
    const task = await s.create({ text: "x", createdBy: "test" });
    expect(await resolveTaskByPrefix(s, task.id.slice(0, 8))).toEqual({ task });
  });

  it("returns notFound: true when no task matches", async () => {
    const result = await resolveTaskByPrefix(store(), "nope");
    expect(result).toEqual({ error: "No task found starting with `nope`.", notFound: true });
  });

  it("returns notFound: false with the short ids when the prefix is ambiguous", async () => {
    const s = store();
    const a = await s.create({ text: "a", createdBy: "test" });
    const b = await s.create({ text: "b", createdBy: "test" });
    // Every id starts with "", so this always matches everything currently in the store.
    const result = await resolveTaskByPrefix(s, "");
    expect(result).toEqual({
      error: `\`\` matches 2 tasks — be more specific: ${a.id.slice(0, 8)}, ${b.id.slice(0, 8)}`,
      notFound: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/resolve-task.test.ts`
Expected: FAIL — `Cannot find module '../src/control/resolve-task.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/control/resolve-task.ts
import type { Task, TaskStore } from "./task-store.js";

export type ResolvedTask = { task: Task } | { error: string; notFound: boolean };

/** Shared by `!result`/`!retry`/`!cancel` (bot.ts) and the dashboard's task endpoints: resolves the short id `!tasks` shows (or a full id) to exactly one task. */
export async function resolveTaskByPrefix(tasks: TaskStore, prefix: string): Promise<ResolvedTask> {
  const matches = await tasks.findByPrefix(prefix);
  if (matches.length === 0) return { error: `No task found starting with \`${prefix}\`.`, notFound: true };
  if (matches.length > 1) {
    const ids = matches.map((t) => t.id.slice(0, 8)).join(", ");
    return { error: `\`${prefix}\` matches ${matches.length} tasks — be more specific: ${ids}`, notFound: false };
  }
  return { task: matches[0]! };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/resolve-task.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Update `bot.ts` to use the shared function**

In `src/control/bot.ts`, add to the import block (after the existing `import { formatZodError } from "../errors.js";` at line 7):

```ts
import { resolveTaskByPrefix } from "./resolve-task.js";
```

Delete the private method at lines 307-316 (`private async resolveTaskByPrefix(prefix: string): Promise<{ task: Task } | { error: string }> { ... }`).

Replace each of the three call sites (`this.resolveTaskByPrefix(prefix)` at lines 464, 471, 494) with:

```ts
resolveTaskByPrefix(this.tasks, prefix)
```

- [ ] **Step 6: Run the full test suite to confirm nothing broke**

Run: `npx vitest run`
Expected: PASS (existing `tests/bot.test.ts` coverage of `!result`/`!retry`/`!cancel` still passes unchanged)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/control/resolve-task.ts src/control/bot.ts tests/resolve-task.test.ts
git commit -m "refactor: extract resolveTaskByPrefix so the dashboard can reuse it"
```

---

### Task 2: Add `RunStore.readTranscriptTail`

**Files:**
- Modify: `src/run-store.ts` (add a method to the `RunStore` class, after `readResult`, ~line 145)
- Test: `tests/run-store.test.ts` (append a new `describe` block before the file's final closing `});`)

**Interfaces:**
- Produces: `RunStore.readTranscriptTail(runId: string, lines: number): Promise<string[]>` — returns `[]` for a run with no transcript file rather than throwing (matches the existing `RunWriter.tail()` behavior it mirrors).

- [ ] **Step 1: Write the failing test**

Append to `tests/run-store.test.ts`, before the file's final `});`:

```ts
describe("RunStore.readTranscriptTail", () => {
  it("returns the last N lines of a run's transcript", async () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-runs-")));
    const writer = await store.open(newRunId("agent"), "agent");
    await writer.append({ type: "assistant", text: "one" });
    await writer.append({ type: "assistant", text: "two" });
    await writer.append({ type: "assistant", text: "three" });
    await writer.close({ status: "success", summary: "done" });

    const tail = await store.readTranscriptTail(writer.runId, 2);
    expect(tail).toHaveLength(2);
    expect(JSON.parse(tail[1]!).text).toBe("three");
  });

  it("returns an empty array for a run with no transcript on disk", async () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "cai-runs-")));
    expect(await store.readTranscriptTail("nonexistent-run", 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/run-store.test.ts`
Expected: FAIL — `store.readTranscriptTail is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/run-store.ts`, add this method to the `RunStore` class immediately after `readResult` (after line 145):

```ts
  /**
   * Like the `tail()` a RunWriter exposes while a run is still open
   * (see `writer.tail` above), but for any run id after the fact — used by
   * the dashboard's run-detail view, which has no open writer to ask.
   */
  async readTranscriptTail(runId: string, lines: number): Promise<string[]> {
    const raw = await readFile(join(this.runDir(runId), "transcript.jsonl"), "utf8").catch(() => "");
    return raw.trim().split("\n").filter(Boolean).slice(-lines);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/run-store.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/run-store.ts tests/run-store.test.ts
git commit -m "feat: let RunStore read a closed run's transcript tail"
```

---

### Task 3: Add `WorldModel.listFindings`

**Files:**
- Modify: `src/world/world-model.ts` (add a public method, after `summaryForPrompt`, ~line 234; make `listFindingTopics` reusable — it already is, as a private method on the same class)
- Test: `tests/world-model.test.ts` (append a new `describe` block before the file's final closing `});`)

**Interfaces:**
- Produces: `WorldModel.listFindings(): Promise<Finding[]>` — every finding's full current conclusion (unlike `summaryForPrompt`, which truncates to `MAX_CONCLUSION_CHARS`).

- [ ] **Step 1: Write the failing test**

Append to `tests/world-model.test.ts`, before the file's final `});` (reuses the `fixture()` and `finding()` helpers already defined near the top of this file):

```ts
describe("WorldModel.listFindings", () => {
  it("returns every finding's full, untruncated conclusion", async () => {
    const f = fixture();
    await f.world.writeFinding("pricing-strategy", finding());
    await f.world.writeFinding("competitor-scan", finding({ topic: "competitor-scan", conclusion: "Crowded space." }));

    const findings = await f.world.listFindings();
    expect(findings).toHaveLength(2);
    expect(findings.map((fd) => fd.topic).sort()).toEqual(["competitor-scan", "pricing-strategy"]);

    rmSync(f.dataDir, { recursive: true, force: true });
  });

  it("returns an empty array when no findings exist", async () => {
    const f = fixture();
    expect(await f.world.listFindings()).toEqual([]);
    rmSync(f.dataDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/world-model.test.ts`
Expected: FAIL — `f.world.listFindings is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/world/world-model.ts`, add this method to the `WorldModel` class immediately after `summaryForPrompt` (after line 234):

```ts
  /** Every finding's full current conclusion — unlike summaryForPrompt's digest, nothing here is truncated. */
  async listFindings(): Promise<Finding[]> {
    const topics = await this.listFindingTopics();
    const findings = await Promise.all(topics.map((topic) => this.readFinding(topic)));
    return findings.filter((f): f is Finding => f !== null);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/world-model.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/world/world-model.ts tests/world-model.test.ts
git commit -m "feat: let WorldModel list every finding's full conclusion"
```

---

### Task 4: `DashboardServer` skeleton and Basic Auth gate

**Files:**
- Create: `src/control/dashboard-server.ts`
- Test: `tests/dashboard-server.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks yet (this is the foundation the API tasks build on).
- Produces:
  - `export interface DashboardDeps { tasks: TaskStore; runs: RunStore; overrides: ConfigOverridesStore; governor: Pick<Governor, "status" | "adjustConcurrency">; breaker: BreakerStore; world: WorldModel; metrics: MetricsStore; dispatcher: { wake(): Promise<void> }; agents: AgentDef[]; dataDir: string; }`
  - `export interface DashboardRequest { method: string; path: string; query: URLSearchParams; authHeader: string | undefined; body: string; }`
  - `export interface DashboardResponse { status: number; headers?: Record<string, string>; body: string; }`
  - `export class DashboardServer { constructor(opts: { user: string; password: string; deps: DashboardDeps; requestTimeoutMs?: number }); async handleRequest(req: DashboardRequest): Promise<DashboardResponse>; async listen(port: number): Promise<void>; async close(): Promise<void>; }`
  - Also exported from this file (used only inside it, but exported test-file helpers reuse the deps shape): `testDeps` and `server`/`AUTH` are defined in the TEST file, not this one — later tasks' tests reuse those from `tests/dashboard-server.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/dashboard-server.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DashboardServer, type DashboardDeps } from "../src/control/dashboard-server.js";
import { TaskStore } from "../src/control/task-store.js";
import { RunStore } from "../src/run-store.js";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { Governor } from "../src/governor.js";
import { BreakerStore } from "../src/state/breaker.js";
import { WorldModel } from "../src/world/world-model.js";
import { MetricsStore } from "../src/state/metrics-store.js";
import { RateLimitTracker } from "../src/state/rate-limit.js";
import { parseConfig } from "../src/config.js";
import type { AgentDef } from "../src/registry.js";

const CONFIG = parseConfig(
  "config.yaml",
  "governor:\n  maxConcurrent: 2\n  dailyBudgetUsd: 10\n  pendingTimeoutHours: 24\ndiscord:\n  channels: {}\n",
);

export function testDeps(dataDir: string = mkdtempSync(join(tmpdir(), "cai-dashboard-"))): DashboardDeps {
  const runs = new RunStore(dataDir);
  const overrides = new ConfigOverridesStore(dataDir);
  const breaker = new BreakerStore(dataDir);
  return {
    tasks: new TaskStore(dataDir),
    runs,
    overrides,
    governor: new Governor({ dataDir, config: CONFIG, store: runs, overrides, rateLimits: new RateLimitTracker(dataDir), breaker }),
    breaker,
    world: new WorldModel(dataDir),
    metrics: new MetricsStore(dataDir),
    dispatcher: { wake: async () => {} },
    agents: [] as AgentDef[],
    dataDir,
  };
}

export function server(deps: DashboardDeps = testDeps()): DashboardServer {
  return new DashboardServer({ user: "op", password: "secret", deps });
}

export const AUTH = `Basic ${Buffer.from("op:secret").toString("base64")}`;

describe("DashboardServer auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const result = await server().handleRequest({
      method: "GET", path: "/api/status", query: new URLSearchParams(), authHeader: undefined, body: "",
    });
    expect(result.status).toBe(401);
  });

  it("rejects a request with the wrong password", async () => {
    const wrong = `Basic ${Buffer.from("op:nope").toString("base64")}`;
    const result = await server().handleRequest({
      method: "GET", path: "/api/status", query: new URLSearchParams(), authHeader: wrong, body: "",
    });
    expect(result.status).toBe(401);
  });

  it("returns 404 for an unknown path once authenticated", async () => {
    const result = await server().handleRequest({
      method: "GET", path: "/api/nonexistent", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: FAIL — `Cannot find module '../src/control/dashboard-server.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/control/dashboard-server.ts
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AgentDef } from "../registry.js";
import type { RunStore } from "../run-store.js";
import type { ConfigOverridesStore } from "../config-overrides.js";
import type { Governor } from "../governor.js";
import type { BreakerStore } from "../state/breaker.js";
import type { MetricsStore } from "../state/metrics-store.js";
import type { WorldModel } from "../world/world-model.js";
import type { TaskStore } from "./task-store.js";

export interface DashboardDeps {
  tasks: TaskStore;
  runs: RunStore;
  overrides: ConfigOverridesStore;
  governor: Pick<Governor, "status" | "adjustConcurrency">;
  breaker: BreakerStore;
  world: WorldModel;
  metrics: MetricsStore;
  dispatcher: { wake(): Promise<void> };
  agents: AgentDef[];
  dataDir: string;
}

export interface DashboardRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  authHeader: string | undefined;
  body: string;
}

export interface DashboardResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

function hashCreds(user: string, password: string): Buffer {
  return createHash("sha256").update(`${user}:${password}`).digest();
}

/**
 * Constant-time: a naive string compare (or an early length check on the raw
 * credentials, the way verifyGithubSignature's HMAC comparison gets away
 * with one) leaks timing information an attacker could use to guess
 * characters one at a time. Hashing both sides first also fixes both at 32
 * bytes regardless of input length, so there is no length to leak either —
 * unlike an HMAC digest, a raw credential string's length is exactly the
 * kind of thing an attacker controls and could otherwise infer.
 */
function checkAuth(authHeader: string | undefined, expectedUser: string, expectedPassword: string): boolean {
  if (!authHeader?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  const providedUser = decoded.slice(0, sep);
  const providedPassword = decoded.slice(sep + 1);
  return timingSafeEqual(hashCreds(providedUser, providedPassword), hashCreds(expectedUser, expectedPassword));
}

function json(status: number, data: unknown): DashboardResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(data) };
}

const UNAUTHORIZED: DashboardResponse = {
  status: 401,
  headers: { "content-type": "text/plain", "www-authenticate": 'Basic realm="dashboard"' },
  body: "unauthorized",
};

export class DashboardServer {
  private readonly user: string;
  private readonly password: string;
  private readonly deps: DashboardDeps;
  private readonly requestTimeoutMs: number;
  private server: Server | null = null;

  constructor(opts: { user: string; password: string; deps: DashboardDeps; requestTimeoutMs?: number }) {
    this.user = opts.user;
    this.password = opts.password;
    this.deps = opts.deps;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  /** Pure request handling, no real HTTP involved — exactly like WebhookReceiver.handleRequest. */
  async handleRequest(req: DashboardRequest): Promise<DashboardResponse> {
    if (!checkAuth(req.authHeader, this.user, this.password)) return UNAUTHORIZED;

    // Every route below (added in later tasks) lives inside this try block —
    // unlike WebhookReceiver, whose handler calls are already isolated by
    // their own .catch(), the routes here call directly into stores that can
    // throw on an unexpected I/O error, and a throw must still produce a
    // real response rather than leaving the request hanging forever.
    try {
      return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
    } catch (error) {
      console.error(`[dashboard] unhandled error handling ${req.method} ${req.path}`, error);
      return { status: 500, headers: { "content-type": "text/plain" }, body: "internal error" };
    }
  }

  async listen(port: number): Promise<void> {
    const MAX_BODY_SIZE = 1024 * 1024;

    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      let responseSent = false;

      const timer = setTimeout(() => req.destroy(), this.requestTimeoutMs);
      const clearRequestTimer = (): void => clearTimeout(timer);

      req.on("error", () => {
        clearRequestTimer();
        if (!responseSent && !res.destroyed && !res.writableEnded) {
          responseSent = true;
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Bad request");
        }
      });

      req.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          if (!responseSent) {
            responseSent = true;
            res.writeHead(413, { "content-type": "text/plain" });
            res.end("Payload too large");
          }
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        clearRequestTimer();
        if (responseSent) return;
        responseSent = true;
        const url = new URL(req.url ?? "/", "http://localhost");
        void this.handleRequest({
          method: req.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          authHeader: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        }).then(({ status, headers, body }) => {
          res.writeHead(status, headers ?? { "content-type": "text/plain" });
          res.end(body);
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.server!.once("error", onError);
      this.server!.listen(port, () => {
        this.server!.removeListener("error", onError);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/control/dashboard-server.ts tests/dashboard-server.test.ts
git commit -m "feat: add DashboardServer skeleton with Basic Auth gate"
```

---

### Task 5: Status endpoint

**Files:**
- Modify: `src/control/dashboard-server.ts` (`handleRequest`)
- Test: `tests/dashboard-server.test.ts` (append)

**Interfaces:**
- Consumes: `DashboardDeps.governor.status()`, `DashboardDeps.tasks.list()` (from Task 4).
- Produces: `GET /api/status` → `200` with `{ ...GovernorStatus, taskCounts: { pending, queued, running, waiting } }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-server.test.ts`:

```ts
describe("GET /api/status", () => {
  it("returns governor status plus task counts by status", async () => {
    const deps = testDeps();
    await deps.tasks.create({ text: "a", createdBy: "test" });
    const result = await server(deps).handleRequest({
      method: "GET", path: "/api/status", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.taskCounts).toEqual({ pending: 1, queued: 0, running: 0, waiting: 0 });
    expect(parsed.dailyBudgetUsd).toBe(10);
  });

  it("returns 500 without hanging when a dependency throws unexpectedly", async () => {
    const deps = testDeps();
    deps.governor = {
      status: async () => { throw new Error("disk exploded"); },
      adjustConcurrency: () => {},
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await server(deps).handleRequest({
        method: "GET", path: "/api/status", query: new URLSearchParams(), authHeader: AUTH, body: "",
      });
      expect(result.status).toBe(500);
    } finally {
      errors.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: FAIL — status endpoint returns 404, `result.status` is `404` not `200`

- [ ] **Step 3: Write minimal implementation**

In `src/control/dashboard-server.ts`, in `handleRequest`, insert immediately before the final `return { status: 404, ... }`:

```ts
    if (req.method === "GET" && req.path === "/api/status") {
      const status = await this.deps.governor.status();
      const active = await this.deps.tasks.list();
      const counts = { pending: 0, queued: 0, running: 0, waiting: 0 };
      for (const t of active) {
        if (t.status === "pending" || t.status === "queued" || t.status === "running" || t.status === "waiting") counts[t.status]++;
      }
      return json(200, { ...status, taskCounts: counts });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/control/dashboard-server.ts tests/dashboard-server.test.ts
git commit -m "feat: add GET /api/status to the dashboard"
```

---

### Task 6: Task-queue read endpoints

**Files:**
- Modify: `src/control/dashboard-server.ts` (imports + `handleRequest`)
- Test: `tests/dashboard-server.test.ts` (append)

**Interfaces:**
- Consumes: `resolveTaskByPrefix` (Task 1), `DashboardDeps.tasks` (Task 4).
- Produces: `GET /api/tasks` → `200` with active `Task[]`; `GET /api/tasks/:id` → `200` with a `Task`, `404` if no match, `409` if ambiguous.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-server.test.ts`:

```ts
describe("GET /api/tasks", () => {
  it("lists only active tasks, highest priority first, excluding finished ones", async () => {
    const deps = testDeps();
    const low = await deps.tasks.create({ text: "low", createdBy: "test", priority: 10 });
    const high = await deps.tasks.create({ text: "high", createdBy: "test", priority: 90 });
    const done = await deps.tasks.create({ text: "done", createdBy: "test" });
    await deps.tasks.update(done.id, { status: "done" });

    const result = await server(deps).handleRequest({
      method: "GET", path: "/api/tasks", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    const parsed = JSON.parse(result.body) as { id: string }[];
    expect(parsed.map((t) => t.id)).toEqual([high.id, low.id]);
  });
});

describe("GET /api/tasks/:id", () => {
  it("resolves a short id prefix to the matching task", async () => {
    const deps = testDeps();
    const task = await deps.tasks.create({ text: "x", createdBy: "test" });
    const result = await server(deps).handleRequest({
      method: "GET", path: `/api/tasks/${task.id.slice(0, 8)}`, query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).id).toBe(task.id);
  });

  it("returns 404 when no task matches", async () => {
    const result = await server().handleRequest({
      method: "GET", path: "/api/tasks/nope", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: FAIL — both new endpoints currently 404

- [ ] **Step 3: Write minimal implementation**

Add to the top imports of `src/control/dashboard-server.ts`:

```ts
import { resolveTaskByPrefix } from "./resolve-task.js";
```

Insert, before the final `return { status: 404, ... }` in `handleRequest`:

```ts
    if (req.method === "GET" && req.path === "/api/tasks") {
      const all = await this.deps.tasks.list();
      const active = all
        .filter((t) => t.status === "pending" || t.status === "queued" || t.status === "running" || t.status === "waiting")
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
      return json(200, active);
    }

    const taskDetailMatch = req.path.match(/^\/api\/tasks\/([^/]+)$/);
    if (req.method === "GET" && taskDetailMatch) {
      const resolved = await resolveTaskByPrefix(this.deps.tasks, taskDetailMatch[1]!);
      if ("error" in resolved) return json(resolved.notFound ? 404 : 409, { error: resolved.error });
      return json(200, resolved.task);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/control/dashboard-server.ts tests/dashboard-server.test.ts
git commit -m "feat: add task-queue read endpoints to the dashboard"
```

---

### Task 7: Task-queue write endpoints

**Files:**
- Modify: `src/control/dashboard-server.ts` (imports + `handleRequest`)
- Test: `tests/dashboard-server.test.ts` (append)

**Interfaces:**
- Consumes: `resolveTaskByPrefix` (Task 1), `MAX_TASK_TEXT_LENGTH` from `./task-store.js`.
- Produces: `POST /api/tasks` (`{ text, priority?, wantsDetail? }`) → `201` with the created `Task`, `400` on empty/oversized text; `POST /api/tasks/:id/retry` → `200` with the updated `Task`, `400` if not failed; `POST /api/tasks/:id/cancel` → `200` with `{ id }`, `400` if not pending.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-server.test.ts`:

```ts
describe("POST /api/tasks", () => {
  it("creates a task and wakes the dispatcher", async () => {
    const deps = testDeps();
    let woken = false;
    deps.dispatcher = { wake: async () => { woken = true; } };
    const result = await server(deps).handleRequest({
      method: "POST", path: "/api/tasks", query: new URLSearchParams(), authHeader: AUTH,
      body: JSON.stringify({ text: "look into X" }),
    });
    expect(result.status).toBe(201);
    expect(JSON.parse(result.body).text).toBe("look into X");
    expect(woken).toBe(true);
  });

  it("rejects empty text", async () => {
    const result = await server().handleRequest({
      method: "POST", path: "/api/tasks", query: new URLSearchParams(), authHeader: AUTH, body: JSON.stringify({ text: "  " }),
    });
    expect(result.status).toBe(400);
  });
});

describe("POST /api/tasks/:id/retry", () => {
  it("requeues a failed task", async () => {
    const deps = testDeps();
    const task = await deps.tasks.create({ text: "x", createdBy: "test" });
    await deps.tasks.update(task.id, { status: "failed", failureReason: "boom" });
    const result = await server(deps).handleRequest({
      method: "POST", path: `/api/tasks/${task.id}/retry`, query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).status).toBe("pending");
  });

  it("refuses to retry a task that isn't failed", async () => {
    const deps = testDeps();
    const task = await deps.tasks.create({ text: "x", createdBy: "test" });
    const result = await server(deps).handleRequest({
      method: "POST", path: `/api/tasks/${task.id}/retry`, query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(400);
  });
});

describe("POST /api/tasks/:id/cancel", () => {
  it("removes a pending task", async () => {
    const deps = testDeps();
    const task = await deps.tasks.create({ text: "x", createdBy: "test" });
    const result = await server(deps).handleRequest({
      method: "POST", path: `/api/tasks/${task.id}/cancel`, query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(200);
    expect(await deps.tasks.get(task.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: FAIL — all three POST routes currently 404

- [ ] **Step 3: Write minimal implementation**

Add to the top imports of `src/control/dashboard-server.ts`:

```ts
import { MAX_TASK_TEXT_LENGTH } from "./task-store.js";
```

Insert, before the final `return { status: 404, ... }` in `handleRequest`:

```ts
    if (req.method === "POST" && req.path === "/api/tasks") {
      let payload: { text?: unknown; priority?: unknown; wantsDetail?: unknown };
      try {
        payload = JSON.parse(req.body) as typeof payload;
      } catch {
        return { status: 400, headers: { "content-type": "text/plain" }, body: "invalid JSON" };
      }
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) return json(400, { error: "text is required" });
      if (text.length > MAX_TASK_TEXT_LENGTH) {
        return json(400, { error: `text is ${text.length} characters, over the ${MAX_TASK_TEXT_LENGTH}-character limit` });
      }
      const task = await this.deps.tasks.create({
        text,
        createdBy: "dashboard",
        ...(typeof payload.priority === "number" ? { priority: payload.priority } : {}),
        ...(payload.wantsDetail === true ? { wantsDetail: true } : {}),
      });
      void this.deps.dispatcher.wake().catch((err: unknown) => {
        console.error(`[dashboard] dispatcher wake failed after creating task ${task.id}`, err);
      });
      return json(201, task);
    }

    const taskRetryMatch = req.path.match(/^\/api\/tasks\/([^/]+)\/retry$/);
    if (req.method === "POST" && taskRetryMatch) {
      const resolved = await resolveTaskByPrefix(this.deps.tasks, taskRetryMatch[1]!);
      if ("error" in resolved) return json(resolved.notFound ? 404 : 409, { error: resolved.error });
      if (resolved.task.status !== "failed") {
        return json(400, { error: `Task is ${resolved.task.status}, not failed — nothing to retry.` });
      }
      const updated = await this.deps.tasks.update(resolved.task.id, {
        status: "pending", failureReason: undefined, finishedAt: undefined, startedAt: undefined,
        retryCount: undefined, nextRetryAt: undefined,
      });
      void this.deps.dispatcher.wake().catch((err: unknown) => {
        console.error(`[dashboard] dispatcher wake failed after retrying task ${updated.id}`, err);
      });
      return json(200, updated);
    }

    const taskCancelMatch = req.path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (req.method === "POST" && taskCancelMatch) {
      const resolved = await resolveTaskByPrefix(this.deps.tasks, taskCancelMatch[1]!);
      if ("error" in resolved) return json(resolved.notFound ? 404 : 409, { error: resolved.error });
      if (resolved.task.status !== "pending") {
        return json(400, { error: `Task is ${resolved.task.status}, not pending — can't cancel it.` });
      }
      await this.deps.tasks.remove(resolved.task.id);
      return json(200, { id: resolved.task.id });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/control/dashboard-server.ts tests/dashboard-server.test.ts
git commit -m "feat: add task-queue write endpoints to the dashboard"
```

---

### Task 8: Run-history endpoints

**Files:**
- Modify: `src/control/dashboard-server.ts` (`handleRequest`)
- Test: `tests/dashboard-server.test.ts` (append; add `newRunId` to the existing `run-store.js` import)

**Interfaces:**
- Consumes: `DashboardDeps.runs.listRecent`, `.readResult`, `.readTranscriptTail` (Task 2).
- Produces: `GET /api/runs?limit=20` → `200` with `RunResult[]`; `GET /api/runs/:id` → `200` with `{ ...RunResult, transcript: string[] }`, `404` if unknown.

- [ ] **Step 1: Write the failing test**

In `tests/dashboard-server.test.ts`, change the existing `import { RunStore } from "../src/run-store.js";` line to:

```ts
import { RunStore, newRunId } from "../src/run-store.js";
```

Append:

```ts
describe("GET /api/runs", () => {
  it("returns recent runs, most recent first", async () => {
    const deps = testDeps();
    const writer = await deps.runs.open(newRunId("agent"), "agent");
    await writer.close({ status: "success", summary: "done" });
    const result = await server(deps).handleRequest({
      method: "GET", path: "/api/runs", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(JSON.parse(result.body)).toHaveLength(1);
  });
});

describe("GET /api/runs/:id", () => {
  it("returns a run's result plus its transcript tail", async () => {
    const deps = testDeps();
    const writer = await deps.runs.open(newRunId("agent"), "agent");
    await writer.append({ type: "assistant", text: "hello" });
    await writer.close({ status: "success", summary: "done" });
    const result = await server(deps).handleRequest({
      method: "GET", path: `/api/runs/${writer.runId}`, query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.status).toBe("success");
    expect(parsed.transcript).toHaveLength(1);
  });

  it("returns 404 for an unknown run id", async () => {
    const result = await server().handleRequest({
      method: "GET", path: "/api/runs/nope", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: FAIL — both run endpoints currently 404

- [ ] **Step 3: Write minimal implementation**

Insert, before the final `return { status: 404, ... }` in `handleRequest`:

```ts
    if (req.method === "GET" && req.path === "/api/runs") {
      const limitParam = req.query.get("limit");
      const limit = limitParam && Number.isInteger(Number(limitParam)) && Number(limitParam) > 0 ? Number(limitParam) : 20;
      return json(200, await this.deps.runs.listRecent(limit));
    }

    const runDetailMatch = req.path.match(/^\/api\/runs\/([^/]+)$/);
    if (req.method === "GET" && runDetailMatch) {
      try {
        const result = await this.deps.runs.readResult(runDetailMatch[1]!);
        const transcript = await this.deps.runs.readTranscriptTail(runDetailMatch[1]!, 200);
        return json(200, { ...result, transcript });
      } catch {
        return json(404, { error: `No run found with id "${runDetailMatch[1]}".` });
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/control/dashboard-server.ts tests/dashboard-server.test.ts
git commit -m "feat: add run-history endpoints to the dashboard"
```

---

### Task 9: Config read + stop/resume endpoints

**Files:**
- Modify: `src/control/dashboard-server.ts` (imports + `handleRequest`)
- Test: `tests/dashboard-server.test.ts` (append; add `existsSync` to a `node:fs` import)

**Interfaces:**
- Produces: `GET /api/config` → `200` with `{ overrides: ConfigOverrides, resolved: GovernorStatus }`; `POST /api/stop` → `200` with `{ stopped: true }`; `POST /api/resume` → `200` with `{ stopped: false }`.

- [ ] **Step 1: Write the failing test**

Add near the top of `tests/dashboard-server.test.ts`:

```ts
import { existsSync } from "node:fs";
```

Append:

```ts
describe("GET /api/config", () => {
  it("returns raw overrides plus resolved governor settings", async () => {
    const deps = testDeps();
    await deps.overrides.set("dailyBudgetUsd", 42, "test");
    const result = await server(deps).handleRequest({
      method: "GET", path: "/api/config", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    const parsed = JSON.parse(result.body);
    expect(parsed.overrides.dailyBudgetUsd).toBe(42);
    expect(parsed.resolved.dailyBudgetUsd).toBe(42);
  });
});

describe("POST /api/stop and /api/resume", () => {
  it("sets and clears the STOP sentinel file", async () => {
    const deps = testDeps();
    await server(deps).handleRequest({ method: "POST", path: "/api/stop", query: new URLSearchParams(), authHeader: AUTH, body: "" });
    expect(existsSync(join(deps.dataDir, "STOP"))).toBe(true);

    await server(deps).handleRequest({ method: "POST", path: "/api/resume", query: new URLSearchParams(), authHeader: AUTH, body: "" });
    expect(existsSync(join(deps.dataDir, "STOP"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: FAIL — all three endpoints currently 404

- [ ] **Step 3: Write minimal implementation**

Add to the top imports of `src/control/dashboard-server.ts`:

```ts
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
```

Insert, before the final `return { status: 404, ... }` in `handleRequest`:

```ts
    if (req.method === "GET" && req.path === "/api/config") {
      return json(200, { overrides: await this.deps.overrides.read(), resolved: await this.deps.governor.status() });
    }

    if (req.method === "POST" && req.path === "/api/stop") {
      await mkdir(this.deps.dataDir, { recursive: true });
      await writeFile(join(this.deps.dataDir, "STOP"), "");
      return json(200, { stopped: true });
    }

    if (req.method === "POST" && req.path === "/api/resume") {
      await rm(join(this.deps.dataDir, "STOP"), { force: true });
      return json(200, { stopped: false });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/control/dashboard-server.ts tests/dashboard-server.test.ts
git commit -m "feat: add config-read and stop/resume endpoints to the dashboard"
```

---

### Task 10: Config write endpoints (budget, concurrency, quiet hours, breaker)

**Files:**
- Modify: `src/control/dashboard-server.ts` (imports + `handleRequest`)
- Test: `tests/dashboard-server.test.ts` (append)

**Interfaces:**
- Consumes: `QuietHoursSchema` from `../config.js`, `formatZodError` from `../errors.js`.
- Produces: `POST /api/config/budget` `{ value }`, `POST /api/config/concurrency` `{ value }`, `POST /api/config/quiet-hours` `{ from, to, timezone }` or `{ off: true }`, `POST /api/config/breaker` `{ enabled }` — each `200` on success with the field changed, `400` on invalid input.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-server.test.ts`:

```ts
describe("POST /api/config/budget", () => {
  it("sets the daily budget", async () => {
    const deps = testDeps();
    const result = await server(deps).handleRequest({
      method: "POST", path: "/api/config/budget", query: new URLSearchParams(), authHeader: AUTH, body: JSON.stringify({ value: 25 }),
    });
    expect(result.status).toBe(200);
    expect((await deps.overrides.read()).dailyBudgetUsd).toBe(25);
  });

  it("rejects a non-positive value", async () => {
    const result = await server().handleRequest({
      method: "POST", path: "/api/config/budget", query: new URLSearchParams(), authHeader: AUTH, body: JSON.stringify({ value: -5 }),
    });
    expect(result.status).toBe(400);
  });
});

describe("POST /api/config/concurrency", () => {
  it("sets concurrency and applies it to the live governor", async () => {
    const deps = testDeps();
    const result = await server(deps).handleRequest({
      method: "POST", path: "/api/config/concurrency", query: new URLSearchParams(), authHeader: AUTH, body: JSON.stringify({ value: 5 }),
    });
    expect(result.status).toBe(200);
    expect((await deps.overrides.read()).maxConcurrent).toBe(5);
  });
});

describe("POST /api/config/quiet-hours", () => {
  it("sets validated quiet hours", async () => {
    const deps = testDeps();
    const result = await server(deps).handleRequest({
      method: "POST", path: "/api/config/quiet-hours", query: new URLSearchParams(), authHeader: AUTH,
      body: JSON.stringify({ from: "02:00", to: "03:00", timezone: "Europe/Berlin" }),
    });
    expect(result.status).toBe(200);
    expect((await deps.overrides.read()).quietHours).toEqual({ from: "02:00", to: "03:00", timezone: "Europe/Berlin" });
  });

  it("turns quiet hours off", async () => {
    const deps = testDeps();
    await deps.overrides.set("quietHours", { from: "02:00", to: "03:00", timezone: "Europe/Berlin" }, "test");
    const result = await server(deps).handleRequest({
      method: "POST", path: "/api/config/quiet-hours", query: new URLSearchParams(), authHeader: AUTH, body: JSON.stringify({ off: true }),
    });
    expect(result.status).toBe(200);
    expect((await deps.overrides.read()).quietHours).toBeNull();
  });

  it("rejects an invalid timezone", async () => {
    const result = await server().handleRequest({
      method: "POST", path: "/api/config/quiet-hours", query: new URLSearchParams(), authHeader: AUTH,
      body: JSON.stringify({ from: "02:00", to: "03:00", timezone: "not/a-zone" }),
    });
    expect(result.status).toBe(400);
  });
});

describe("POST /api/config/breaker", () => {
  it("toggles the circuit breaker", async () => {
    const deps = testDeps();
    const result = await server(deps).handleRequest({
      method: "POST", path: "/api/config/breaker", query: new URLSearchParams(), authHeader: AUTH, body: JSON.stringify({ enabled: false }),
    });
    expect(result.status).toBe(200);
    expect((await deps.overrides.read()).breakerEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: FAIL — all four config-write endpoints currently 404

- [ ] **Step 3: Write minimal implementation**

Add to the top imports of `src/control/dashboard-server.ts`:

```ts
import { QuietHoursSchema } from "../config.js";
import { formatZodError } from "../errors.js";
```

Insert, before the final `return { status: 404, ... }` in `handleRequest`:

```ts
    if (req.method === "POST" && req.path === "/api/config/budget") {
      let payload: { value?: unknown };
      try {
        payload = JSON.parse(req.body) as typeof payload;
      } catch {
        return { status: 400, headers: { "content-type": "text/plain" }, body: "invalid JSON" };
      }
      const value = Number(payload.value);
      if (!Number.isFinite(value) || value <= 0) return json(400, { error: `Not a valid budget: ${JSON.stringify(payload.value)}` });
      await this.deps.overrides.set("dailyBudgetUsd", value, "dashboard");
      return json(200, { dailyBudgetUsd: value });
    }

    if (req.method === "POST" && req.path === "/api/config/concurrency") {
      let payload: { value?: unknown };
      try {
        payload = JSON.parse(req.body) as typeof payload;
      } catch {
        return { status: 400, headers: { "content-type": "text/plain" }, body: "invalid JSON" };
      }
      const value = Number(payload.value);
      if (!Number.isInteger(value) || value <= 0) return json(400, { error: `Not a valid concurrency: ${JSON.stringify(payload.value)}` });
      await this.deps.overrides.set("maxConcurrent", value, "dashboard");
      this.deps.governor.adjustConcurrency(value);
      return json(200, { maxConcurrent: value });
    }

    if (req.method === "POST" && req.path === "/api/config/quiet-hours") {
      let payload: { off?: unknown; from?: unknown; to?: unknown; timezone?: unknown };
      try {
        payload = JSON.parse(req.body) as typeof payload;
      } catch {
        return { status: 400, headers: { "content-type": "text/plain" }, body: "invalid JSON" };
      }
      if (payload.off === true) {
        await this.deps.overrides.set("quietHours", null, "dashboard");
        return json(200, { quietHours: null });
      }
      const parsed = QuietHoursSchema.safeParse({ from: payload.from, to: payload.to, timezone: payload.timezone });
      if (!parsed.success) {
        const problems = formatZodError("dashboard quiet-hours", parsed.error).lines.join("; ");
        return json(400, { error: problems });
      }
      await this.deps.overrides.set("quietHours", parsed.data, "dashboard");
      return json(200, { quietHours: parsed.data });
    }

    if (req.method === "POST" && req.path === "/api/config/breaker") {
      let payload: { enabled?: unknown };
      try {
        payload = JSON.parse(req.body) as typeof payload;
      } catch {
        return { status: 400, headers: { "content-type": "text/plain" }, body: "invalid JSON" };
      }
      if (typeof payload.enabled !== "boolean") return json(400, { error: "enabled must be a boolean" });
      await this.deps.overrides.set("breakerEnabled", payload.enabled, "dashboard");
      return json(200, { breakerEnabled: payload.enabled });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/control/dashboard-server.ts tests/dashboard-server.test.ts
git commit -m "feat: add config write endpoints to the dashboard"
```

---

### Task 11: Agent enable/disable endpoints

**Files:**
- Modify: `src/control/dashboard-server.ts` (`handleRequest`)
- Test: `tests/dashboard-server.test.ts` (append)

**Interfaces:**
- Produces: `POST /api/agents/:name/disable` → `200` with `{ disabledAgents }`, `404` for an unknown agent name; `POST /api/agents/:name/enable` → `200` with `{ disabledAgents }` (tolerates an unknown name, matching `!enable`), and resets that agent's breaker.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-server.test.ts`:

```ts
describe("POST /api/agents/:name/disable and /enable", () => {
  it("disables a known agent", async () => {
    const deps = testDeps();
    deps.agents = [{ name: "research" } as AgentDef];
    const result = await server(deps).handleRequest({
      method: "POST", path: "/api/agents/research/disable", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(200);
    expect((await deps.overrides.read()).disabledAgents).toEqual(["research"]);
  });

  it("refuses to disable an unknown agent name", async () => {
    const result = await server().handleRequest({
      method: "POST", path: "/api/agents/nope/disable", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(404);
  });

  it("re-enables an agent and resets its breaker", async () => {
    const deps = testDeps();
    deps.agents = [{ name: "research" } as AgentDef];
    await deps.overrides.set("disabledAgents", ["research"], "test");
    await deps.breaker.recordResult("research", "failed");
    await deps.breaker.recordResult("research", "failed");
    await deps.breaker.recordResult("research", "failed");
    expect(await deps.breaker.isTripped("research")).toBe(true);

    const result = await server(deps).handleRequest({
      method: "POST", path: "/api/agents/research/enable", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(200);
    expect((await deps.overrides.read()).disabledAgents).toEqual([]);
    expect(await deps.breaker.isTripped("research")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: FAIL — both endpoints currently 404

- [ ] **Step 3: Write minimal implementation**

Insert, before the final `return { status: 404, ... }` in `handleRequest`:

```ts
    const agentDisableMatch = req.path.match(/^\/api\/agents\/([^/]+)\/disable$/);
    if (req.method === "POST" && agentDisableMatch) {
      const name = decodeURIComponent(agentDisableMatch[1]!);
      if (!this.deps.agents.some((a) => a.name === name)) {
        return json(404, { error: `No agent named "${name}" is loaded.` });
      }
      const overrides = await this.deps.overrides.read();
      const disabled = new Set(overrides.disabledAgents ?? []);
      disabled.add(name);
      await this.deps.overrides.set("disabledAgents", [...disabled], "dashboard");
      return json(200, { disabledAgents: [...disabled] });
    }

    const agentEnableMatch = req.path.match(/^\/api\/agents\/([^/]+)\/enable$/);
    if (req.method === "POST" && agentEnableMatch) {
      const name = decodeURIComponent(agentEnableMatch[1]!);
      const overrides = await this.deps.overrides.read();
      const disabled = new Set(overrides.disabledAgents ?? []);
      disabled.delete(name);
      await this.deps.overrides.set("disabledAgents", [...disabled], "dashboard");
      await this.deps.breaker.reset(name);
      return json(200, { disabledAgents: [...disabled] });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/control/dashboard-server.ts tests/dashboard-server.test.ts
git commit -m "feat: add agent enable/disable endpoints to the dashboard"
```

---

### Task 12: World-model and metrics endpoints

**Files:**
- Modify: `src/control/dashboard-server.ts` (`handleRequest`)
- Test: `tests/dashboard-server.test.ts` (append)

**Interfaces:**
- Consumes: `DashboardDeps.world.readPortfolio/readShelf/listFindings` (Task 3), `DashboardDeps.metrics.write/listAll`.
- Produces: `GET /api/world` → `200` with `{ portfolio, shelf, findings }`; `GET /api/metrics?days=30` → `200` with `Metrics[]` from the last N days.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-server.test.ts`:

```ts
describe("GET /api/world", () => {
  it("returns portfolio, shelf, and findings together", async () => {
    const deps = testDeps();
    await deps.world.upsertPortfolioEntry({
      slug: "widget-api", purpose: "x", status: "live", nextReviewAt: "2026-10-01",
      bar: "one paying customer", monthlyCostUsd: 5, notes: [], extensionCount: 0,
    });
    await deps.world.writeFinding("pricing", {
      topic: "pricing", conclusion: "usage-based wins", confidence: "medium",
      updatedAt: "2026-09-01T00:00:00.000Z", sources: ["run-1"],
    });
    const result = await server(deps).handleRequest({
      method: "GET", path: "/api/world", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    const parsed = JSON.parse(result.body);
    expect(parsed.portfolio).toHaveLength(1);
    expect(parsed.findings).toHaveLength(1);
  });
});

describe("GET /api/metrics", () => {
  it("returns metrics snapshots within the requested window", async () => {
    const deps = testDeps();
    await deps.metrics.write({
      computedAt: new Date().toISOString(), windowDays: 7, netIncomeUsd: 0,
      notAchievedRate: null, notAchievedByAgent: [], costPerCompletedTaskUsd: null,
      noveltySharePercent: null, suppressedProposalCount: 0, queueStarvationHours: null,
    });
    const result = await server(deps).handleRequest({
      method: "GET", path: "/api/metrics", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(JSON.parse(result.body)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: FAIL — both endpoints currently 404

- [ ] **Step 3: Write minimal implementation**

Insert, before the final `return { status: 404, ... }` in `handleRequest` (this is now the LAST pair of routes before the 404 fallback):

```ts
    if (req.method === "GET" && req.path === "/api/world") {
      const [portfolio, shelf, findings] = await Promise.all([
        this.deps.world.readPortfolio(), this.deps.world.readShelf(), this.deps.world.listFindings(),
      ]);
      return json(200, { portfolio, shelf, findings });
    }

    if (req.method === "GET" && req.path === "/api/metrics") {
      const all = await this.deps.metrics.listAll();
      const daysParam = req.query.get("days");
      const days = daysParam && Number.isInteger(Number(daysParam)) && Number(daysParam) > 0 ? Number(daysParam) : 30;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      return json(200, all.filter((m) => new Date(m.computedAt).getTime() >= cutoff));
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: PASS — this is the full backend API; run the whole file once more to confirm every prior describe block still passes.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/control/dashboard-server.ts tests/dashboard-server.test.ts
git commit -m "feat: add world-model and metrics endpoints to the dashboard"
```

---

### Task 13: Wire `DashboardServer` into `src/index.ts` and document the env vars

**Files:**
- Modify: `src/index.ts` (imports, env reads near `webhookPort`'s declaration at line 133, construction+listen block after the `webhookReceiver` block at lines 319-333)
- Modify: `.env.example` (append)
- Modify: `README.md`'s "Not built yet" section — remove the dashboard from the "still genuinely deferred" list (it now exists)

**Interfaces:**
- Consumes: `DashboardServer` (Task 4), and the already-constructed `tasks`, `runStore`, `overrides`, `governor`, `breaker`, `world`, `metricsStore`, `dispatcher`, `agents` locals already in scope in `main()` at this point (confirmed via the existing `new DiscordBot({ ... store: runStore, overrides, breaker, dataDir: DATA_DIR, tasks, dispatcher, governor, ... })` call at `src/index.ts:296-307`, and `world`/`metricsStore` declared at lines 94 and 217 respectively).

- [ ] **Step 1: Add the import**

In `src/index.ts`, add to the import block (alphabetically, after `import { PendingStore } from "./control/pending.js";`):

```ts
import { DashboardServer } from "./control/dashboard-server.js";
```

- [ ] **Step 2: Read the new env vars**

In `src/index.ts`, in the block of `let` declarations at the top of `main()` (line 79), immediately after `let webhookPort: number;`, add:

```ts
  let dashboardUser: string | undefined;
  let dashboardPassword: string | undefined;
  let dashboardPort: number;
```

Then, near the existing `webhookPort = parsePort("WEBHOOK_PORT", process.env.WEBHOOK_PORT, 8787);` (line 133), add:

```ts
    dashboardUser = process.env.DASHBOARD_USER;
    dashboardPassword = process.env.DASHBOARD_PASSWORD;
    dashboardPort = parsePort("DASHBOARD_PORT", process.env.DASHBOARD_PORT, 8788);
```

- [ ] **Step 3: Construct and start the server**

In `src/index.ts`, immediately after the existing `webhookReceiver.listen(...)` block (after line 333), add:

```ts
  if (dashboardUser && dashboardPassword) {
    const dashboard = new DashboardServer({
      user: dashboardUser,
      password: dashboardPassword,
      deps: {
        tasks, runs: runStore, overrides, governor, breaker, world,
        metrics: metricsStore, dispatcher, agents, dataDir: DATA_DIR,
      },
    });
    void dashboard.listen(dashboardPort).then(
      () => {
        console.log(`[boot] dashboard listening on :${dashboardPort}`);
      },
      (error: unknown) => {
        console.error(`\n[boot] Failed to start the dashboard on port ${dashboardPort}. No web dashboard will be available.\n`);
        console.error(error instanceof Error ? error.message : String(error));
      },
    );
  } else {
    console.log("[boot] DASHBOARD_USER/DASHBOARD_PASSWORD not set — no dashboard server started");
  }
```

- [ ] **Step 4: Document the env vars**

Append to `.env.example`:

```
# Web dashboard — optional. Both must be set for it to start; leaving either
# empty means no dashboard server runs (matches REVENUE_API_TOKEN's posture).
# Basic Auth, so keep this on HTTPS in any real deployment (ngrok now, Caddy
# once/if a VPS exists) — credentials go out with every request.
DASHBOARD_PORT=8788
DASHBOARD_USER=
DASHBOARD_PASSWORD=
```

- [ ] **Step 5: Update README's "Not built yet" section**

In `README.md`, remove the dashboard bullet from the "Still genuinely deferred" list (the one reading `- **A dashboard.** Wanted eventually, but out of scope so far...`), since it now exists. Do not add a new "built" bullet elsewhere — the dashboard's own doc coverage is `docs/superpowers/specs/2026-09-03-web-dashboard-design.md`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 7: Manually verify the boot wiring**

Set `DASHBOARD_USER`/`DASHBOARD_PASSWORD` in your local `.env`, then run:

Run: `npm run dev`
Expected: console log shows `[boot] dashboard listening on :8788` (or your configured port) alongside the existing boot logs. Stop the process, unset those two env vars, run again — expected: `[boot] DASHBOARD_USER/DASHBOARD_PASSWORD not set — no dashboard server started`, and the rest of boot proceeds unaffected.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts .env.example README.md
git commit -m "feat: wire DashboardServer into boot, gated on DASHBOARD_USER/PASSWORD"
```

---

### Task 14: Static page shell (nav, layout, polling scaffold)

**Files:**
- Create: `public/dashboard/index.html`
- Modify: `src/control/dashboard-server.ts` (serve it for `GET /`)
- Test: manual (no frontend test tooling in this repo — see Step 4)

**Interfaces:**
- Produces: `GET /` → `200`, `text/html`, the dashboard page. The page defines a global `loaders` object (`{ [tabName: string]: () => void }`) that Tasks 15-20 populate — `showTab(name)` (defined here) looks up `loaders[name]` and calls it immediately, then every `REFRESH_MS` while that tab stays active.

- [ ] **Step 1: Write the page shell**

```html
<!-- public/dashboard/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clanker Dashboard</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --border: #2a2e38; --text: #e6e8ec; --muted: #9aa1ad;
    --accent: #5b8cff; --danger: #ff6161; --good: #4fd18b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; }
  header { padding: 1rem; border-bottom: 1px solid var(--border); }
  header h1 { margin: 0; font-size: 1.1rem; }
  nav { display: flex; gap: 0.5rem; padding: 0.5rem 1rem; border-bottom: 1px solid var(--border); overflow-x: auto; }
  nav button { background: none; border: 1px solid var(--border); color: var(--muted); padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; white-space: nowrap; font-size: 0.9rem; }
  nav button.active { background: var(--accent); color: white; border-color: var(--accent); }
  main { padding: 1rem; max-width: 900px; margin: 0 auto; }
  section[hidden] { display: none; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.4rem; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin-bottom: 0.6rem; }
  button.action { background: var(--accent); color: white; border: none; padding: 0.4rem 0.8rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
  button.action.danger { background: var(--danger); }
  input, select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem; font-size: 0.85rem; }
  @media (max-width: 600px) {
    nav { position: fixed; bottom: 0; left: 0; right: 0; background: var(--panel); justify-content: space-around; z-index: 10; }
    main { padding-bottom: 4.5rem; }
  }
</style>
</head>
<body>
<header><h1>Clanker Dashboard</h1></header>
<nav>
  <button data-tab="status" class="active">Status</button>
  <button data-tab="tasks">Tasks</button>
  <button data-tab="runs">Runs</button>
  <button data-tab="config">Config</button>
  <button data-tab="world">World</button>
  <button data-tab="metrics">Metrics</button>
</nav>
<main>
  <section id="tab-status"><p>Loading…</p></section>
  <section id="tab-tasks" hidden><p>Loading…</p></section>
  <section id="tab-runs" hidden><p>Loading…</p></section>
  <section id="tab-config" hidden><p>Loading…</p></section>
  <section id="tab-world" hidden><p>Loading…</p></section>
  <section id="tab-metrics" hidden><p>Loading…</p></section>
</main>
<script>
  const REFRESH_MS = 10000;
  let refreshTimer = null;
  const loaders = {};

  function showTab(name) {
    for (const btn of document.querySelectorAll("nav button")) {
      btn.classList.toggle("active", btn.dataset.tab === name);
    }
    for (const section of document.querySelectorAll("main > section")) {
      section.hidden = section.id !== `tab-${name}`;
    }
    if (refreshTimer) clearInterval(refreshTimer);
    const load = loaders[name];
    if (load) {
      load();
      refreshTimer = setInterval(load, REFRESH_MS);
    }
  }

  for (const btn of document.querySelectorAll("nav button")) {
    btn.addEventListener("click", () => showTab(btn.dataset.tab));
  }

  showTab("status");
</script>
</body>
</html>
```

- [ ] **Step 2: Serve it from `DashboardServer`**

In `src/control/dashboard-server.ts`, add to the top imports:

```ts
import { readFile } from "node:fs/promises";
```

Insert, as the FIRST route check in `handleRequest` (immediately after the `checkAuth` guard, before every other route):

```ts
    if (req.method === "GET" && req.path === "/") {
      const html = await readFile(new URL("../../public/dashboard/index.html", import.meta.url), "utf8");
      return { status: 200, headers: { "content-type": "text/html" }, body: html };
    }
```

(Read fresh on every request rather than cached — the file is small, this keeps a local edit-and-reload dev loop simple, and this is a low-traffic single-operator tool.)

- [ ] **Step 3: Add a test that the page is served and auth-gated**

Append to `tests/dashboard-server.test.ts`:

```ts
describe("GET /", () => {
  it("serves the dashboard page once authenticated", async () => {
    const result = await server().handleRequest({
      method: "GET", path: "/", query: new URLSearchParams(), authHeader: AUTH, body: "",
    });
    expect(result.status).toBe(200);
    expect(result.headers?.["content-type"]).toBe("text/html");
    expect(result.body).toContain("Clanker Dashboard");
  });

  it("requires auth for the page itself", async () => {
    const result = await server().handleRequest({
      method: "GET", path: "/", query: new URLSearchParams(), authHeader: undefined, body: "",
    });
    expect(result.status).toBe(401);
  });
});
```

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: PASS

- [ ] **Step 4: Manually verify in a browser**

Run: `npm run dev` (with `DASHBOARD_USER`/`DASHBOARD_PASSWORD` set in `.env`)

Open `http://localhost:8788/` in a desktop browser — expected: a Basic Auth prompt appears, then the page loads showing the tab bar and a "Status" section reading "Loading…" (no data yet — that's Task 15). Click each tab button — expected: the active tab highlights and its section becomes visible, others hide. Resize the window below 600px width (or open DevTools' device toolbar at a phone width) — expected: the nav bar moves to the bottom of the screen as a row of evenly-spaced buttons.

- [ ] **Step 5: Commit**

```bash
git add public/dashboard/index.html src/control/dashboard-server.ts tests/dashboard-server.test.ts
git commit -m "feat: add the dashboard's static page shell with tab navigation"
```

---

### Task 15: Status tab

**Files:**
- Modify: `public/dashboard/index.html` (the `#tab-status` section markup, and the `<script>` block)

**Interfaces:**
- Consumes: `GET /api/status` (Task 5).
- Produces: `loaders.status` — populates the Status tab and re-polls it every `REFRESH_MS`.

- [ ] **Step 1: Replace the Status section markup**

In `public/dashboard/index.html`, replace `<section id="tab-status"><p>Loading…</p></section>` with:

```html
  <section id="tab-status">
    <div class="card">
      <div class="row"><strong>State:</strong>&nbsp;<span id="status-state">—</span></div>
      <div class="row"><strong>Budget:</strong>&nbsp;<span id="status-budget">—</span></div>
      <div class="row"><strong>Concurrency:</strong>&nbsp;<span id="status-concurrency">—</span></div>
      <div class="row"><strong>Quiet hours:</strong>&nbsp;<span id="status-quiet">—</span></div>
      <div class="row"><strong>Circuit breaker:</strong>&nbsp;<span id="status-breaker">—</span></div>
      <div class="row"><strong>Disabled agents:</strong>&nbsp;<span id="status-disabled">—</span></div>
      <div class="row"><strong>Rate limit:</strong>&nbsp;<span id="status-ratelimit">—</span></div>
      <div class="row"><strong>Tasks:</strong>&nbsp;<span id="status-tasks">—</span></div>
    </div>
  </section>
```

- [ ] **Step 2: Add the loader function**

In `public/dashboard/index.html`'s `<script>` block, add this immediately before the `for (const btn of document.querySelectorAll("nav button"))` loop that wires up click handlers:

```js
  async function loadStatus() {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    const s = await res.json();
    document.getElementById("status-state").textContent = s.stopped ? "STOPPED" : "running";
    document.getElementById("status-budget").textContent = `$${s.spentTodayUsd.toFixed(2)} of $${s.dailyBudgetUsd}`;
    document.getElementById("status-concurrency").textContent = s.maxConcurrent;
    document.getElementById("status-quiet").textContent = s.quietHours
      ? `${s.quietHours.from}-${s.quietHours.to} ${s.quietHours.timezone}${s.quietHoursActive ? " (active)" : ""}`
      : "off";
    document.getElementById("status-breaker").textContent = s.breakerEnabled ? "on" : "off";
    document.getElementById("status-disabled").textContent = s.disabledAgents.length ? s.disabledAgents.join(", ") : "none";
    document.getElementById("status-ratelimit").textContent = s.rateLimitUtilization === null
      ? "no reading yet"
      : `${Math.round(s.rateLimitUtilization * 100)}% (pauses at ${Math.round(s.rateLimitPauseThreshold * 100)}%)`;
    const c = s.taskCounts;
    document.getElementById("status-tasks").textContent = `${c.pending} pending, ${c.queued} queued, ${c.running} running, ${c.waiting} waiting`;
  }
  loaders.status = loadStatus;
```

- [ ] **Step 3: Manually verify in a browser**

Run: `npm run dev`, open `http://localhost:8788/`.
Expected: the Status tab (active by default) fills in with real values within ~10s — budget, concurrency, quiet hours, breaker state, disabled agents, rate limit, and task counts all match what `!status` would report in Discord for the same running instance. Leave the tab open for over 10 seconds — expected: values refresh in place without a page reload.

- [ ] **Step 4: Commit**

```bash
git add public/dashboard/index.html
git commit -m "feat: render live status on the dashboard's Status tab"
```

---

### Task 16: Tasks tab

**Files:**
- Modify: `public/dashboard/index.html` (the `#tab-tasks` section markup, and the `<script>` block)

**Interfaces:**
- Consumes: `GET /api/tasks`, `POST /api/tasks`, `POST /api/tasks/:id/retry`, `POST /api/tasks/:id/cancel` (Tasks 6-7).
- Produces: `loaders.tasks`.

- [ ] **Step 1: Replace the Tasks section markup**

Replace `<section id="tab-tasks" hidden><p>Loading…</p></section>` with:

```html
  <section id="tab-tasks" hidden>
    <div class="card">
      <div class="row">
        <input id="task-text" placeholder="New task text" style="flex:1; min-width:200px;">
        <input id="task-priority" type="number" placeholder="priority (50)" style="width:8rem;">
        <button class="action" id="task-create">Queue</button>
      </div>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Status</th><th>Priority</th><th>Text</th><th>Actions</th></tr></thead>
        <tbody id="tasks-body"></tbody>
      </table>
    </div>
  </section>
```

- [ ] **Step 2: Add the loader and action handlers**

Add before the click-handler wiring loop in the `<script>` block:

```js
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function loadTasks() {
    const res = await fetch("/api/tasks");
    if (!res.ok) return;
    const tasks = await res.json();
    const body = document.getElementById("tasks-body");
    body.innerHTML = tasks.map((t) => `
      <tr>
        <td>${t.status}</td>
        <td>${t.priority}</td>
        <td>${escapeHtml(t.text.length > 80 ? t.text.slice(0, 77) + "…" : t.text)}</td>
        <td>
          ${t.status === "failed" ? `<button class="action" data-retry="${t.id}">Retry</button>` : ""}
          ${t.status === "pending" ? `<button class="action danger" data-cancel="${t.id}">Cancel</button>` : ""}
        </td>
      </tr>
    `).join("");

    for (const btn of body.querySelectorAll("[data-retry]")) {
      btn.addEventListener("click", async () => {
        await fetch(`/api/tasks/${btn.dataset.retry}/retry`, { method: "POST" });
        loadTasks();
      });
    }
    for (const btn of body.querySelectorAll("[data-cancel]")) {
      btn.addEventListener("click", async () => {
        await fetch(`/api/tasks/${btn.dataset.cancel}/cancel`, { method: "POST" });
        loadTasks();
      });
    }
  }
  loaders.tasks = loadTasks;

  document.getElementById("task-create").addEventListener("click", async () => {
    const textEl = document.getElementById("task-text");
    const priorityEl = document.getElementById("task-priority");
    const text = textEl.value.trim();
    if (!text) return;
    const body = { text };
    if (priorityEl.value) body.priority = Number(priorityEl.value);
    await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    textEl.value = "";
    priorityEl.value = "";
    loadTasks();
  });
```

Note: `document.getElementById("task-create")` runs once at page-load time (the tasks tab's markup exists in the DOM from the start, even while `hidden`), so this listener attaches correctly regardless of which tab is active on load — no need to defer it into `loadTasks()`.

- [ ] **Step 3: Manually verify in a browser**

Run: `npm run dev`, open the dashboard, click the "Tasks" tab.
Expected: the table lists current pending/queued/running/waiting tasks. Type text into the input and click "Queue" — expected: a new row appears (via the next poll or an immediate `loadTasks()` call) with status "pending". Find a `failed` task (or manually fail one) — expected: a "Retry" button appears and clicking it flips its status to "pending". Find a `pending` task — expected: a "Cancel" button appears and clicking it removes the row.

- [ ] **Step 4: Commit**

```bash
git add public/dashboard/index.html
git commit -m "feat: render task queue with retry/cancel/create on the dashboard's Tasks tab"
```

---

### Task 17: Runs tab

**Files:**
- Modify: `public/dashboard/index.html` (the `#tab-runs` section markup, and the `<script>` block)

**Interfaces:**
- Consumes: `GET /api/runs`, `GET /api/runs/:id` (Task 8).
- Produces: `loaders.runs`.

- [ ] **Step 1: Replace the Runs section markup**

Replace `<section id="tab-runs" hidden><p>Loading…</p></section>` with:

```html
  <section id="tab-runs" hidden>
    <div class="card">
      <table>
        <thead><tr><th>Run</th><th>Status</th><th>Cost</th><th></th></tr></thead>
        <tbody id="runs-body"></tbody>
      </table>
    </div>
    <div class="card" id="run-detail" hidden>
      <pre id="run-detail-body" style="white-space: pre-wrap; word-break: break-word; font-size: 0.8rem; max-height: 50vh; overflow-y: auto;"></pre>
    </div>
  </section>
```

- [ ] **Step 2: Add the loader and detail-view handler**

Add before the click-handler wiring loop in the `<script>` block:

```js
  async function loadRuns() {
    const res = await fetch("/api/runs?limit=20");
    if (!res.ok) return;
    const runs = await res.json();
    const body = document.getElementById("runs-body");
    body.innerHTML = runs.map((r) => `
      <tr>
        <td>${escapeHtml(r.runId)}</td>
        <td>${r.status}${r.verifiedOutcome && r.verifiedOutcome.verdict !== "achieved" ? ` (${r.verifiedOutcome.verdict})` : ""}</td>
        <td>$${r.costUsd.toFixed(4)}</td>
        <td><button class="action" data-detail="${r.runId}">View</button></td>
      </tr>
    `).join("");

    for (const btn of body.querySelectorAll("[data-detail]")) {
      btn.addEventListener("click", async () => {
        const detailRes = await fetch(`/api/runs/${btn.dataset.detail}`);
        if (!detailRes.ok) return;
        const detail = await detailRes.json();
        const lines = detail.transcript.map((line) => {
          try {
            const event = JSON.parse(line);
            return `[${event.at}] ${event.type}: ${event.text ?? JSON.stringify(event)}`;
          } catch {
            return line;
          }
        });
        document.getElementById("run-detail-body").textContent = `${detail.summary}\n\n${lines.join("\n")}`;
        document.getElementById("run-detail").hidden = false;
      });
    }
  }
  loaders.runs = loadRuns;
```

- [ ] **Step 3: Manually verify in a browser**

Run: `npm run dev`, open the dashboard, click the "Runs" tab.
Expected: a table of the most recent runs, most recent first, with status and cost. Click "View" on any row — expected: a panel below the table shows that run's summary and a tail of its transcript events.

- [ ] **Step 4: Commit**

```bash
git add public/dashboard/index.html
git commit -m "feat: render run history and detail on the dashboard's Runs tab"
```

---

### Task 18: Config tab

**Files:**
- Modify: `public/dashboard/index.html` (the `#tab-config` section markup, and the `<script>` block)

**Interfaces:**
- Consumes: `GET /api/config`, `POST /api/config/{budget,concurrency,quiet-hours,breaker}`, `POST /api/agents/:name/{disable,enable}`, `POST /api/stop`, `POST /api/resume` (Tasks 9-11).
- Produces: `loaders.config`.

- [ ] **Step 1: Replace the Config section markup**

Replace `<section id="tab-config" hidden><p>Loading…</p></section>` with:

```html
  <section id="tab-config" hidden>
    <div class="card">
      <div class="row"><strong>Run state:</strong>&nbsp;<span id="config-state">—</span>
        <button class="action" id="config-stop">Stop</button>
        <button class="action" id="config-resume">Resume</button>
      </div>
    </div>
    <div class="card">
      <div class="row">
        <label>Daily budget ($)&nbsp;<input id="config-budget" type="number" style="width:6rem;"></label>
        <button class="action" id="config-budget-save">Save</button>
      </div>
      <div class="row">
        <label>Concurrency&nbsp;<input id="config-concurrency" type="number" style="width:5rem;"></label>
        <button class="action" id="config-concurrency-save">Save</button>
      </div>
      <div class="row">
        <label>Quiet hours&nbsp;<input id="config-quiet-from" placeholder="HH:MM" style="width:5rem;"></label>
        -
        <input id="config-quiet-to" placeholder="HH:MM" style="width:5rem;">
        <input id="config-quiet-tz" placeholder="Area/City" style="width:10rem;">
        <button class="action" id="config-quiet-save">Save</button>
        <button class="action danger" id="config-quiet-off">Off</button>
      </div>
      <div class="row">
        <label><input type="checkbox" id="config-breaker"> Circuit breaker enabled</label>
      </div>
    </div>
    <div class="card">
      <div class="row">
        <input id="config-agent-name" placeholder="agent name" style="width:12rem;">
        <button class="action" id="config-agent-disable">Disable</button>
        <button class="action" id="config-agent-enable">Enable</button>
      </div>
      <div id="config-disabled-list"></div>
    </div>
  </section>
```

- [ ] **Step 2: Add the loader and control handlers**

Add before the click-handler wiring loop in the `<script>` block:

```js
  async function loadConfig() {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const { resolved } = await res.json();
    document.getElementById("config-state").textContent = resolved.stopped ? "STOPPED" : "running";
    document.getElementById("config-budget").value = resolved.dailyBudgetUsd;
    document.getElementById("config-concurrency").value = resolved.maxConcurrent;
    if (resolved.quietHours) {
      document.getElementById("config-quiet-from").value = resolved.quietHours.from;
      document.getElementById("config-quiet-to").value = resolved.quietHours.to;
      document.getElementById("config-quiet-tz").value = resolved.quietHours.timezone;
    }
    document.getElementById("config-breaker").checked = resolved.breakerEnabled;
    document.getElementById("config-disabled-list").textContent = resolved.disabledAgents.length
      ? `Disabled: ${resolved.disabledAgents.join(", ")}` : "No agents disabled";
  }
  loaders.config = loadConfig;

  document.getElementById("config-stop").addEventListener("click", async () => {
    await fetch("/api/stop", { method: "POST" });
    loadConfig();
  });
  document.getElementById("config-resume").addEventListener("click", async () => {
    await fetch("/api/resume", { method: "POST" });
    loadConfig();
  });
  document.getElementById("config-budget-save").addEventListener("click", async () => {
    const value = Number(document.getElementById("config-budget").value);
    await fetch("/api/config/budget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
    loadConfig();
  });
  document.getElementById("config-concurrency-save").addEventListener("click", async () => {
    const value = Number(document.getElementById("config-concurrency").value);
    await fetch("/api/config/concurrency", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
    loadConfig();
  });
  document.getElementById("config-quiet-save").addEventListener("click", async () => {
    const from = document.getElementById("config-quiet-from").value;
    const to = document.getElementById("config-quiet-to").value;
    const timezone = document.getElementById("config-quiet-tz").value;
    await fetch("/api/config/quiet-hours", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, to, timezone }) });
    loadConfig();
  });
  document.getElementById("config-quiet-off").addEventListener("click", async () => {
    await fetch("/api/config/quiet-hours", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ off: true }) });
    loadConfig();
  });
  document.getElementById("config-breaker").addEventListener("change", async (e) => {
    await fetch("/api/config/breaker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: e.target.checked }) });
    loadConfig();
  });
  document.getElementById("config-agent-disable").addEventListener("click", async () => {
    const name = document.getElementById("config-agent-name").value.trim();
    if (!name) return;
    await fetch(`/api/agents/${encodeURIComponent(name)}/disable`, { method: "POST" });
    loadConfig();
  });
  document.getElementById("config-agent-enable").addEventListener("click", async () => {
    const name = document.getElementById("config-agent-name").value.trim();
    if (!name) return;
    await fetch(`/api/agents/${encodeURIComponent(name)}/enable`, { method: "POST" });
    loadConfig();
  });
```

- [ ] **Step 3: Manually verify in a browser**

Run: `npm run dev`, open the dashboard, click the "Config" tab.
Expected: fields populate with the running instance's real settings. Change the budget field and click Save — expected: the value persists (reload the page to confirm it re-populates from the new value). Toggle the breaker checkbox — expected: it flips and stays flipped after a reload. Type a loaded agent's name and click Disable, then Enable — expected: "Disabled: <name>" appears then clears. Click Stop, then Resume — expected: "Run state" flips between STOPPED and running.

- [ ] **Step 4: Commit**

```bash
git add public/dashboard/index.html
git commit -m "feat: render runtime config controls on the dashboard's Config tab"
```

---

### Task 19: World tab

**Files:**
- Modify: `public/dashboard/index.html` (the `#tab-world` section markup, and the `<script>` block)

**Interfaces:**
- Consumes: `GET /api/world` (Task 12).
- Produces: `loaders.world`.

- [ ] **Step 1: Replace the World section markup**

Replace `<section id="tab-world" hidden><p>Loading…</p></section>` with:

```html
  <section id="tab-world" hidden>
    <div class="card">
      <h3>Portfolio</h3>
      <table>
        <thead><tr><th>Slug</th><th>Status</th><th>Next review</th><th>Monthly cost</th></tr></thead>
        <tbody id="world-portfolio-body"></tbody>
      </table>
    </div>
    <div class="card">
      <h3>Shelf</h3>
      <ul id="world-shelf-list"></ul>
    </div>
    <div class="card">
      <h3>Findings</h3>
      <div id="world-findings-list"></div>
    </div>
  </section>
```

- [ ] **Step 2: Add the loader**

Add before the click-handler wiring loop in the `<script>` block:

```js
  async function loadWorld() {
    const res = await fetch("/api/world");
    if (!res.ok) return;
    const { portfolio, shelf, findings } = await res.json();

    document.getElementById("world-portfolio-body").innerHTML = portfolio.map((p) => `
      <tr><td>${escapeHtml(p.slug)}</td><td>${p.status}</td><td>${p.nextReviewAt}</td><td>$${p.monthlyCostUsd}</td></tr>
    `).join("") || `<tr><td colspan="4">none</td></tr>`;

    document.getElementById("world-shelf-list").innerHTML = shelf.length
      ? shelf.map((s) => `<li>${escapeHtml(s.summary)} — <em>${escapeHtml(s.reason)}</em></li>`).join("")
      : "<li>none</li>";

    document.getElementById("world-findings-list").innerHTML = findings.length
      ? findings.map((f) => `
          <div class="row" style="align-items:flex-start;">
            <strong>${escapeHtml(f.topic)}</strong> (${f.confidence}):&nbsp;${escapeHtml(f.conclusion)}
          </div>
        `).join("")
      : "<p>none</p>";
  }
  loaders.world = loadWorld;
```

- [ ] **Step 3: Manually verify in a browser**

Run: `npm run dev`, open the dashboard, click the "World" tab.
Expected: portfolio entries, shelf items, and findings from `data/world/` render as text matching the raw Markdown files' content (cross-check against `data/world/portfolio.md`, `data/world/shelf.md`, `data/world/findings/*.md` directly).

- [ ] **Step 4: Commit**

```bash
git add public/dashboard/index.html
git commit -m "feat: render portfolio, shelf, and findings on the dashboard's World tab"
```

---

### Task 20: Metrics tab

**Files:**
- Modify: `public/dashboard/index.html` (the `#tab-metrics` section markup, and the `<script>` block)

**Interfaces:**
- Consumes: `GET /api/metrics` (Task 12).
- Produces: `loaders.metrics`.

- [ ] **Step 1: Replace the Metrics section markup**

Replace `<section id="tab-metrics" hidden><p>Loading…</p></section>` with:

```html
  <section id="tab-metrics" hidden>
    <div class="card">
      <table>
        <thead><tr><th>Date</th><th>Net income</th><th>Not-achieved rate</th><th>Cost/task</th><th>Novelty %</th></tr></thead>
        <tbody id="metrics-body"></tbody>
      </table>
    </div>
  </section>
```

- [ ] **Step 2: Add the loader**

Add before the click-handler wiring loop in the `<script>` block:

```js
  async function loadMetrics() {
    const res = await fetch("/api/metrics?days=30");
    if (!res.ok) return;
    const snapshots = await res.json();
    const body = document.getElementById("metrics-body");
    body.innerHTML = snapshots.slice().reverse().map((m) => `
      <tr>
        <td>${m.computedAt.slice(0, 10)}</td>
        <td>$${m.netIncomeUsd.toFixed(2)}${m.revenueUnavailable ? " (unavailable)" : ""}</td>
        <td>${m.notAchievedRate === null ? "—" : `${Math.round(m.notAchievedRate * 100)}%`}</td>
        <td>${m.costPerCompletedTaskUsd === null ? "—" : `$${m.costPerCompletedTaskUsd.toFixed(2)}`}</td>
        <td>${m.noveltySharePercent === null ? "—" : `${Math.round(m.noveltySharePercent)}%`}</td>
      </tr>
    `).join("") || `<tr><td colspan="5">no snapshots yet</td></tr>`;
  }
  loaders.metrics = loadMetrics;
```

- [ ] **Step 3: Manually verify in a browser**

Run: `npm run dev`, open the dashboard, click the "Metrics" tab.
Expected: one row per file under `data/state/metrics-*.json` within the last 30 days, most recent first, matching each file's own `netIncomeUsd`/`notAchievedRate`/etc. values. If no metrics files exist yet, expected: a single "no snapshots yet" row.

- [ ] **Step 4: Full end-to-end manual pass**

With the dev server running and `DASHBOARD_USER`/`DASHBOARD_PASSWORD` set, open the dashboard from a phone on the same Wi-Fi network at `http://<your-desktop's-LAN-IP>:8788/` (find the IP via `ipconfig` on Windows). Expected: the Basic Auth prompt appears, all six tabs are reachable via the bottom nav bar, content is legible without horizontal scrolling, and tapping any control (retry a task, toggle the breaker, etc.) works the same as on desktop.

- [ ] **Step 5: Commit**

```bash
git add public/dashboard/index.html
git commit -m "feat: render metrics trends on the dashboard's Metrics tab"
```
