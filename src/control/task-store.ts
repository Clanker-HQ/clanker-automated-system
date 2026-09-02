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
 * Once this many tasks have been claimed in a row without one of them being
 * "exploration", the next claim promotes a pending exploration task ahead of
 * everything else regardless of priority — see claimNextPending. Without
 * this, `weights.novelty` only biases proposal *ranking*, so once anything
 * starts earning money every allocation decision looks better spent on it,
 * and the system never tries anything new again.
 */
export const EXPLORATION_INTERVAL = 5;

/**
 * "waiting" is a live run that stopped mid-execution to await a human
 * approve/deny/answer (a `parked`/`question` RunResult). It is neither finished
 * nor failed — the run resumes its original session once the owner replies —
 * so it deliberately keeps no `finishedAt`/`failureReason`.
 *
 * "queued" and "running" are deliberately distinct, not one "in flight"
 * state. claimNextPending marks a task "queued" the instant it is claimed —
 * before routing, before Governor.admit() is ever called — so two dispatch
 * attempts can never claim the same task. Whether that claim can actually
 * START a run depends on Governor concurrency (config.yaml's maxConcurrent),
 * which can block for as long as every other slot stays busy. Collapsing
 * both into "running" (the previous behaviour) made `!tasks` show N tasks
 * "running" when only maxConcurrent of them genuinely were — the rest were
 * claimed and waiting their turn. Dispatcher.executeAndFinalize flips
 * "queued" to "running" via the onAdmitted callback, exactly when
 * Governor.admit() actually resolves.
 */
export type TaskStatus = "pending" | "queued" | "running" | "done" | "failed" | "waiting";

/**
 * "exploitation" is the default (see create()) so every existing caller —
 * human `!task` requests, dispatcher retries, agent proposals that predate
 * this field — is counted correctly by the exploration floor below without
 * having to know it exists. Only the overseer is expected to ever tag a
 * task "exploration"; nothing currently sets "maintenance" but the floor
 * treats it the same as "exploitation" (i.e. it counts against the floor).
 */
export type TaskCategory = "exploration" | "exploitation" | "maintenance";

export interface Task {
  id: string;
  text: string;
  priority: number;
  status: TaskStatus;
  /**
   * Optional, not required, because a task file written before this field
   * existed has none on disk — every read site must fall back to
   * "exploitation" (see create()'s default and claimNextPending below)
   * rather than assume this is always present.
   */
  category?: TaskCategory;
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

  async create(input: {
    text: string;
    priority?: number;
    createdBy: string;
    parentId?: string;
    wantsDetail?: boolean;
    category?: TaskCategory;
  }): Promise<Task> {
    await mkdir(this.dir(), { recursive: true });
    const task: Task = {
      id: randomUUID(),
      text: input.text,
      priority: input.priority ?? 50,
      status: "pending",
      category: input.category ?? "exploitation",
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

  /** Shared by nextPending and claimNextPending's exploration-floor check — same eligibility rule, applied to two different sort orders. */
  private async eligiblePending(exclude: ReadonlySet<string>, now: Date): Promise<Task[]> {
    return (await this.list()).filter(
      (t) => t.status === "pending" && !exclude.has(t.id) && (!t.nextRetryAt || new Date(t.nextRetryAt) <= now),
    );
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
    const pending = await this.eligiblePending(exclude, now);
    if (pending.length === 0) return null;
    pending.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    return pending[0]!;
  }

  /**
   * Under data/state/, not data/tasks/ — list() readdirs the tasks directory
   * and parses every *.json in it as a Task, so a counter file living there
   * would show up as a corrupt-task console.error on every tick, or worse, a
   * phantom task the dispatcher tries to run.
   */
  private explorationFloorPath(): string {
    return join(this.dataDir, "state", "exploration-floor.json");
  }

  /** Claims made since the last one that landed on an "exploration" task. Never mutated except from inside claimNextPending's own mutex — see there for why. */
  private async readClaimsSinceExploration(): Promise<number> {
    try {
      const parsed = JSON.parse(await readFile(this.explorationFloorPath(), "utf8")) as { claimsSinceExploration: number };
      return parsed.claimsSinceExploration;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error("[task-store] failed to read exploration-floor.json, treating the floor as freshly reset", err);
      }
      return 0;
    }
  }

  private async writeClaimsSinceExploration(count: number): Promise<void> {
    await mkdir(join(this.dataDir, "state"), { recursive: true });
    await writeFileAtomic(this.explorationFloorPath(), JSON.stringify({ claimsSinceExploration: count }, null, 2) + "\n");
  }

  /**
   * Atomically picks the next eligible pending task (see nextPending) and
   * marks it "queued" in the same step, so two dispatch attempts racing
   * concurrently can never both claim the same task — nextPending() alone is
   * just a read, with nothing stopping two callers from picking the same
   * result before either one flags it as taken. "queued" rather than
   * "running": claiming happens before routing and before this task has any
   * chance at a Governor concurrency slot, so calling it "running" here would
   * be false the moment more tasks are claimed than maxConcurrent allows.
   *
   * Also enforces the exploration floor: once EXPLORATION_INTERVAL claims in
   * a row have gone to something other than "exploration", the next claim
   * takes a pending exploration task over whatever priority would otherwise
   * pick, if one exists. The counter lives in the same mutex.run callback as
   * the claim itself (not a separate read-then-write) so two concurrent
   * claims can never both count the same gap or both reset it, and it is
   * persisted to disk on every claim — including when nothing was pending to
   * promote — so a restart never loses progress toward the floor, and a long
   * exploitation-only stretch is never quietly forgiven by leaving nothing
   * pending to promote in the meantime.
   */
  async claimNextPending(exclude: ReadonlySet<string>, startedAt: string): Promise<Task | null> {
    return this.mutex.run(TaskStore.CLAIM_KEY, async () => {
      const now = new Date(startedAt);
      const claimsSinceExploration = (await this.readClaimsSinceExploration()) + 1;

      let task: Task | null = null;
      if (claimsSinceExploration >= EXPLORATION_INTERVAL) {
        const exploration = (await this.eligiblePending(exclude, now)).filter((t) => (t.category ?? "exploitation") === "exploration");
        exploration.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
        task = exploration[0] ?? null;
      }
      if (!task) task = await this.nextPending(exclude, now);
      if (!task) return null;

      // Reset only on an actual exploration claim. If the floor triggered
      // above but nothing exploration was pending, `claimsSinceExploration`
      // (already incremented for this claim) is written back as-is — it
      // must keep climbing, not fall back to 0, so the moment an exploration
      // task finally arrives it is promoted immediately rather than waiting
      // out another full interval.
      await this.writeClaimsSinceExploration((task.category ?? "exploitation") === "exploration" ? 0 : claimsSinceExploration);
      return this.update(task.id, { status: "queued", startedAt });
    });
  }

  /**
   * A task still marked "queued" or "running" from before a restart has
   * nothing actually working it — the Orchestrator's own crash handling
   * covers the agent run itself, but the task-level record must not stay
   * stuck in either in-flight state. Reset it to "pending" so the next
   * dispatcher tick picks it back up.
   */
  async reconcile(): Promise<{ reset: Task[] }> {
    const inFlight = (await this.list()).filter((t) => t.status === "queued" || t.status === "running");
    const reset: Task[] = [];
    for (const task of inFlight) {
      reset.push(await this.update(task.id, { status: "pending", specialistAgent: undefined }));
    }
    return { reset };
  }
}
