import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { KeyedMutex } from "../keyed-mutex.js";

/**
 * Generous for a real request, but a bound: nothing caps how much text ends
 * up in a task's `text` field before it's queued, so an accidental giant
 * paste (via `!task`) or a runaway tool call (via `queueTask`) would go
 * straight into a run's prompt with no warning otherwise. Shared by every
 * caller that creates a task from free-form text.
 */
export const MAX_TASK_TEXT_LENGTH = 4000;

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
  /** How many times the dispatcher has silently auto-retried this task after a failed run — capped at 3 (see MAX_RETRIES in dispatcher.ts) before it's actually marked "failed". */
  retryCount?: number;
  /**
   * Set together with retryCount on a failed run: the earliest time this
   * task is eligible to be claimed again. nextPending/claimNextPending
   * exclude it until then, so a transient failure backs off instead of
   * being retried on the very next dispatcher tick.
   */
  nextRetryAt?: string;
  /** Set alongside status: "waiting" — lets a later approve/deny/answer find its way back to this task once the run it belongs to actually finishes. */
  runId?: string;
  /**
   * The OutcomeVerifier's reason from the most recent attempt graded
   * "not-achieved" — threaded into the retry's own prompt (see dispatcher.ts)
   * so the next attempt has something concrete to correct instead of blindly
   * repeating itself. Left in place (not cleared) once the task finishes
   * either way; nothing reads it after that.
   */
  lastVerificationReason?: string;
}

export class TaskStore {
  private readonly mutex = new KeyedMutex();
  /** A fixed mutex key for claimNextPending — safe from ever colliding with a real task id, which is always a randomUUID(). */
  private static readonly CLAIM_KEY = "__claim__";

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
    await writeFileAtomic(this.path(task.id), JSON.stringify(task, null, 2) + "\n");
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

  /** Deletes a task's record outright — used only for `!cancel`, and only ever on a still-"pending" task. `force: true` makes a repeat call harmless. */
  async remove(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }

  /**
   * Serialized per id: without this, the dispatcher's tick and a Discord
   * `!cancel`/`!retry`/`!disable`-adjacent command racing on the SAME task
   * could both read the same "before" state and have one's write silently
   * clobber the other's — a plain read-then-write with nothing else guarding it.
   */
  async update(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Promise<Task> {
    return this.mutex.run(id, async () => {
      const existing = await this.get(id);
      if (!existing) throw new Error(`TaskStore: no task "${id}" to update`);
      const updated: Task = { ...existing, ...patch };
      await writeFileAtomic(this.path(id), JSON.stringify(updated, null, 2) + "\n");
      return updated;
    });
  }

  /**
   * Highest priority first, ties broken by creation order (FIFO). Null when
   * nothing is pending. `exclude` skips ids a concurrent dispatch drain has
   * already decided not to reclaim this pass (see claimNextPending) — a
   * plain read, so two concurrent callers could still both pick the same
   * task; that's exactly what claimNextPending exists to prevent. A task
   * whose `nextRetryAt` is still in the future (relative to `now`) is also
   * excluded — it's backing off after a failed attempt, not actually ready.
   */
  async nextPending(exclude: ReadonlySet<string> = new Set(), now: Date = new Date()): Promise<Task | null> {
    const pending = (await this.list()).filter(
      (t) => t.status === "pending" && !exclude.has(t.id) && (!t.nextRetryAt || new Date(t.nextRetryAt) <= now),
    );
    if (pending.length === 0) return null;
    pending.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    return pending[0]!;
  }

  /**
   * Atomically picks the next eligible pending task (see nextPending) and
   * marks it "running" in the same step, so two dispatch attempts racing
   * concurrently can never both claim the same task — nextPending() alone is
   * just a read, with nothing stopping two callers from picking the same
   * result before either one flags it as taken.
   */
  async claimNextPending(exclude: ReadonlySet<string>, startedAt: string): Promise<Task | null> {
    return this.mutex.run(TaskStore.CLAIM_KEY, async () => {
      const task = await this.nextPending(exclude, new Date(startedAt));
      if (!task) return null;
      return this.update(task.id, { status: "running", startedAt });
    });
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
