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
import { MAX_TASK_TEXT_LENGTH } from "./task-store.js";
import { resolveTaskByPrefix } from "./resolve-task.js";

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
      if (req.method === "GET" && req.path === "/api/status") {
        const status = await this.deps.governor.status();
        const active = await this.deps.tasks.list();
        const counts = { pending: 0, queued: 0, running: 0, waiting: 0 };
        for (const t of active) {
          if (t.status === "pending" || t.status === "queued" || t.status === "running" || t.status === "waiting") counts[t.status]++;
        }
        return json(200, { ...status, taskCounts: counts });
      }

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

      if (req.method === "POST" && req.path === "/api/tasks") {
        let payload: { text?: unknown; priority?: unknown; wantsDetail?: unknown };
        try {
          payload = JSON.parse(req.body) as typeof payload;
        } catch {
          return { status: 400, headers: { "content-type": "text/plain" }, body: "invalid JSON" };
        }
        if (typeof payload !== "object" || payload === null) {
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
