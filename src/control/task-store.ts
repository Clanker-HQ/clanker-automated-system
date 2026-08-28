import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * "waiting" is a live run that stopped mid-execution to await a human
 * approve/deny/answer (a `parked`/`question` RunResult). It is neither finished
 * nor failed — the run resumes its original session once the owner replies —
 * so it deliberately keeps no `finishedAt`/`failureReason`.
 */
export type TaskStatus = "pending" | "running" | "done" | "failed" | "waiting";

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
  /** Set when the requester asked for a longer, more substantive final summary than the specialist's default. */
  wantsDetail?: boolean;
}

export class TaskStore {
  constructor(private readonly dataDir: string) {}

  private dir(): string {
    return join(this.dataDir, "tasks");
  }

  private path(id: string): string {
    return join(this.dir(), `${id}.json`);
  }

  async create(input: { text: string; priority?: number; createdBy: string; parentId?: string; wantsDetail?: boolean }): Promise<Task> {
    await mkdir(this.dir(), { recursive: true });
    const task: Task = {
      id: randomUUID(),
      text: input.text,
      priority: input.priority ?? 50,
      status: "pending",
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.wantsDetail ? { wantsDetail: true } : {}),
    };
    await writeFile(this.path(task.id), JSON.stringify(task, null, 2) + "\n");
    return task;
  }

  async get(id: string): Promise<Task | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as Task;
    } catch (err) {
      // A missing file is a legitimate "no such task". Anything else — a
      // corrupt/truncated JSON file, a permission error — silently drops the
      // task out of list()/nextPending() forever, which is exactly the kind of
      // quiet loss this project's fail-loud posture exists to prevent. Still
      // returns null (callers have no better move), but it is never silent.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error(`[task-store] failed to read/parse task "${id}"`, err);
      }
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

  /** Tasks whose id starts with `prefix` — how `!result <short-id>` resolves the truncated id `!tasks` shows. */
  async findByPrefix(prefix: string): Promise<Task[]> {
    return (await this.list()).filter((t) => t.id.startsWith(prefix));
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
