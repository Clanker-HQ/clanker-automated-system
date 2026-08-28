import { join } from "node:path";
import type { AgentDef } from "../registry.js";
import type { RunResult } from "../run-store.js";
import type { Router, Specialist } from "./router.js";
import type { Task, TaskStore } from "./task-store.js";

export interface RunTrigger {
  executeRun(agent: AgentDef, now?: Date, promptContext?: string): Promise<RunResult | undefined>;
}

export interface DispatcherDeps {
  tasks: TaskStore;
  router: Router;
  agents: AgentDef[];
  orchestrator: RunTrigger;
  /**
   * Posts a task-id-correlated message: for a task that never reaches
   * Orchestrator.executeRun (a routing failure has no run, so it never gets a
   * report through the agent's own outbox), and on a run's success/failure —
   * the agent's own run report carries a runId, not a task id, so without this
   * there is no way to tie a Discord report back to the `!task` that asked for it.
   */
  notify: (text: string) => Promise<void>;
  dataDir: string;
  now?: () => Date;
}

/**
 * Posting to Discord must never change what a task RECORDS about itself.
 *
 * `notify` is not a rare-failure path: DiscordOutbox.webhookFor throws on every
 * single call when the channel key is unknown to config.yaml or its env var is
 * unset. Left unguarded inside runDispatchTick's outer catch, that exception
 * overwrote the task's already-correct status/failureReason with the Discord
 * error — replacing a real diagnosis ("boom", "no specialist matched this
 * task") with "DISCORD_WEBHOOK_SMOKE is unset", i.e. destroying the only record
 * of what actually went wrong, precisely when the operator needs it. The task
 * file is the durable record; the Discord post is a courtesy on top of it.
 *
 * Every notify in this module goes through here for that reason — call
 * `deps.notify` directly and the bug comes back.
 */
async function notifyBestEffort(deps: DispatcherDeps, text: string): Promise<void> {
  // try/catch rather than `.catch()` on the returned promise: webhookFor's
  // throw happens while *building* the request, so a notify implementation that
  // isn't itself `async` would throw synchronously and sail straight past a
  // `.catch()` handler. This form catches both, and tolerates a notify that
  // returns something other than a promise.
  try {
    await deps.notify(text);
  } catch (error) {
    console.error("[dispatcher] notify failed", error);
  }
}

/**
 * Content shape, not paragraph count, is the actual constraint: a list of
 * ideas should stay a list, a comparison should stay a comparison — forcing
 * either into prose would make it worse, not more detailed. Discord's
 * markdown has no table syntax, so a genuine side-by-side comparison needs a
 * fenced code block (or two labeled bullet lists) to render at all.
 */
const DETAIL_INSTRUCTION =
  "(The requester asked for more detail this time — give a longer, more " +
  "substantive final summary than your default. Use whichever format " +
  "actually fits the content best (a short paragraph, a bulleted list, " +
  "labeled sections) rather than forcing prose, and keep it skimmable, " +
  "roughly under 250 words. Discord doesn't render markdown tables, so if a " +
  "side-by-side comparison genuinely helps, use a fenced code block to keep " +
  "it aligned, or two labeled bullet lists instead.)";

function specialistsOf(agents: AgentDef[]): Specialist[] {
  return agents
    .filter((a) => a.enabled && a.trigger.type === "dispatched")
    .map((a) => ({ name: a.name, description: a.description }));
}

export interface DispatchOutcome {
  ran: boolean;
  taskId?: string;
  /**
   * True whenever a task went back to "pending" without being retried
   * immediately in this same drain: a Governor refusal, or the one silent
   * auto-retry on a failed run. The drain loop in Dispatcher.wake() must stop
   * on this either way — nextPending() would return the SAME task right back,
   * and for a refusal that spins for as long as the refusal lasts (quiet
   * hours: hours), while for an auto-retry it at least gives whatever was
   * transient (a flaky fetch, a momentary rate limit) the ~30s until the next
   * periodic tick to clear, instead of hammering it back-to-back.
   */
  deferred?: boolean;
}

/**
 * "empty": nothing eligible left to claim this pass (queue empty, or
 * everything remaining is excluded). "resolved": claimed, but already
 * terminal — failed before ever reaching executeRun (no specialists exist,
 * or none matched), so there is no run to track. "running": claimed,
 * routed, and executeRun has been started — `run` is NOT yet awaited here,
 * so a caller can go claim the next eligible task immediately instead of
 * blocking on this one's entire (up to hours-long) execution.
 */
type ClaimResult =
  | { kind: "empty" }
  | { kind: "resolved"; taskId: string }
  | { kind: "running"; taskId: string; run: Promise<DispatchOutcome> };

/**
 * Atomically claims the next eligible pending task (see
 * TaskStore.claimNextPending) and, if routing succeeds, starts its run
 * without awaiting it — this split is what lets Dispatcher.wake() run
 * multiple tasks concurrently instead of one at a time: claiming must stay
 * sequential (so two attempts can never grab the same task), but nothing
 * about actually running a claimed task needs to block claiming the next one.
 */
async function claimAndStart(deps: DispatcherDeps, exclude: ReadonlySet<string>): Promise<ClaimResult> {
  const now = deps.now ?? (() => new Date());
  const task = await deps.tasks.claimNextPending(exclude, now().toISOString());
  if (!task) return { kind: "empty" };

  const specialists = specialistsOf(deps.agents);

  if (specialists.length === 0) {
    await deps.tasks.update(task.id, {
      status: "failed",
      finishedAt: now().toISOString(),
      failureReason: "no dispatched specialist agents are registered",
    });
    await notifyBestEffort(deps, `⚠️ Task \`${task.id}\` failed: no dispatched specialist agents are registered.`);
    return { kind: "resolved", taskId: task.id };
  }

  // A task deferred by a previous governor refusal (or retry) keeps the
  // specialist it was already routed to, so a retry costs no second routing
  // call. Only an unrouted task pays for the router.
  let agent = task.specialistAgent
    ? deps.agents.find((a) => a.name === task.specialistAgent && a.trigger.type === "dispatched" && a.enabled)
    : undefined;

  if (!agent) {
    const chosenName = await deps.router.route(task.text, specialists);
    agent = chosenName
      ? deps.agents.find((a) => a.name === chosenName && a.trigger.type === "dispatched" && a.enabled)
      : undefined;

    if (!agent) {
      const reason = chosenName
        ? `router chose "${chosenName}", which is not a registered dispatched specialist`
        : "no specialist matched this task";
      await deps.tasks.update(task.id, { status: "failed", finishedAt: now().toISOString(), failureReason: reason });
      await notifyBestEffort(deps, `⚠️ Task \`${task.id}\` failed: ${reason}. Text: ${task.text}`);
      return { kind: "resolved", taskId: task.id };
    }

    // Persist the routing decision before attempting admission, so a refusal
    // on this very attempt still leaves the choice cached for the next one.
    await deps.tasks.update(task.id, { specialistAgent: agent.name });
  }

  return { kind: "running", taskId: task.id, run: executeAndFinalize(deps, task, agent) };
}

async function executeAndFinalize(deps: DispatcherDeps, task: Task, agent: AgentDef): Promise<DispatchOutcome> {
  const now = deps.now ?? (() => new Date());

  try {
    // Applied here, not in each specialist's own prompt.md, so every current
    // and future dispatched agent gets the same "-d" behavior for free rather
    // than each needing its own copy of this instruction.
    const promptContext = task.wantsDetail ? `${task.text}\n\n${DETAIL_INSTRUCTION}` : task.text;
    const result = await deps.orchestrator.executeRun(agent, now(), promptContext);

    if (!result) {
      // Governor refused admission (quiet hours, budget, breaker, STOP file) —
      // put it back to pending rather than failing it: unlike a cron agent,
      // which just gets another fire at its next scheduled time, a queued task
      // has nowhere else to go except the next dispatcher tick. specialistAgent
      // is deliberately NOT cleared: the routing decision stays valid, and
      // keeping it is what makes the retry free.
      await deps.tasks.update(task.id, { status: "pending", startedAt: undefined });
      return { ran: true, taskId: task.id, deferred: true };
    }

    if (result.status === "success") {
      await deps.tasks.update(task.id, {
        status: "done",
        finishedAt: now().toISOString(),
        result: { summary: result.summary, path: join(deps.dataDir, "runs", result.runId) },
      });
      await notifyBestEffort(deps, `✅ Task \`${task.id}\` done: ${result.summary}`);
    } else if (result.status === "parked" || result.status === "question") {
      // NOT a failure: the run is alive and paused mid-execution awaiting a
      // human approve/deny/answer, which Orchestrator.resumeRun will continue
      // in the original session. Marking it "failed" here would fabricate a
      // finishedAt, invent a failure reason, and hide the task from !tasks at
      // exactly the moment the owner needs to see that it is waiting on them.
      //
      // runId is recorded so that when the human eventually resumes this run
      // to its real completion, DiscordBot can find its way back to this
      // task and update it — see reconcileTaskForResumedRun in bot.ts.
      await deps.tasks.update(task.id, { status: "waiting", runId: result.runId });
    } else {
      const reason = result.error ?? `run ended with status "${result.status}"`;
      const previousRetries = task.retryCount ?? 0;
      if (previousRetries < 1) {
        // One silent retry before bothering the owner: a lot of these are
        // transient (a flaky fetch, a momentary rate limit) rather than a
        // real problem with the task or the agent. specialistAgent is kept,
        // same as every other requeue-to-pending path here, so the retry
        // doesn't pay for a second routing call.
        console.log(`[dispatcher] task ${task.id} failed (${reason}); retrying once before giving up`);
        await deps.tasks.update(task.id, { status: "pending", retryCount: previousRetries + 1, startedAt: undefined });
        return { ran: true, taskId: task.id, deferred: true };
      }
      await deps.tasks.update(task.id, {
        status: "failed",
        finishedAt: now().toISOString(),
        failureReason: reason,
      });
      await notifyBestEffort(deps, `❌ Task \`${task.id}\` failed: ${reason}`);
    }
    return { ran: true, taskId: task.id };
  } catch (error) {
    // Anything thrown mid-attempt (a prompt file that won't read, an update()
    // racing a deleted task file, a router that blows up) would otherwise leave
    // the task stuck "running" — invisible to nextPending() forever — and abort
    // the whole drain. Fail the task loudly instead, and let the drain go on:
    // a thrown error is not a "wait for the governor" situation.
    //
    // A notify() rejection deliberately never reaches here — see
    // notifyBestEffort. Overwriting a task's real status/failureReason with a
    // Discord error would destroy the diagnosis this branch exists to record.
    console.error(`[dispatcher] task ${task.id} threw mid-attempt`, error);
    try {
      await deps.tasks.update(task.id, {
        status: "failed",
        finishedAt: now().toISOString(),
        failureReason: error instanceof Error ? error.message : String(error),
      });
    } catch (cleanupError) {
      // The task file itself may be what's broken. Never let the cleanup of a
      // failure become a second, uncaught failure.
      console.error(`[dispatcher] could not mark task ${task.id} failed`, cleanupError);
    }
    return { ran: true, taskId: task.id };
  }
}

/**
 * Attempts exactly one pending task, if one exists, start to finish — claim,
 * route, run, and record the outcome. Pure enough to unit test without a
 * timer, a real Router, or a real Orchestrator. A thin wrapper over
 * claimAndStart + executeAndFinalize: single-task callers (this function,
 * and every existing test) get the exact same claim-then-await-the-whole-run
 * behavior as before; Dispatcher.wake() is what actually uses the split to
 * run multiple tasks concurrently.
 */
export async function runDispatchTick(deps: DispatcherDeps): Promise<DispatchOutcome> {
  const claim = await claimAndStart(deps, new Set());
  if (claim.kind === "empty") return { ran: false };
  if (claim.kind === "resolved") return { ran: true, taskId: claim.taskId };
  return claim.run;
}

/**
 * Thin loop over claimAndStart — a periodic tick, plus a reactive wake() a
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
    this.timer = setInterval(() => {
      this.wake().catch((error: unknown) => {
        console.error("[dispatcher] wake() failed during periodic tick", error);
      });
    }, this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Claims and starts every eligible pending task without waiting for any one
   * of them to finish, so independent tasks actually run concurrently —
   * bounded not by this loop but by the Governor's own admission/slot
   * mechanism (governor.maxConcurrent), the same throttle a cron agent's
   * trigger is already subject to.
   *
   * A task that comes back deferred (a governor refusal, or the one silent
   * auto-retry) is excluded from being reclaimed for the REST of this wake()
   * call — nextPending() would hand it right back, and for a refusal that
   * spins for as long as the refusal lasts (quiet hours: hours). It's still
   * eligible again on the next wake()/periodic tick. Excluding only that one
   * task, rather than stopping the whole drain, is what lets an unrelated
   * still-pending task get a turn instead of queuing behind a stuck one.
   */
  async wake(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const deferredIds = new Set<string>();
      const inFlight = new Set<Promise<void>>();
      for (;;) {
        const claim = await claimAndStart(this.deps, deferredIds);
        if (claim.kind === "empty") break;
        if (claim.kind === "resolved") continue;

        const tracked: Promise<void> = claim.run
          .then((outcome) => {
            if (outcome.deferred && outcome.taskId) deferredIds.add(outcome.taskId);
          })
          .catch((error: unknown) => {
            // executeAndFinalize already catches everything it can attribute
            // to a specific task — this is a last-resort backstop so one
            // tracked run's surprise rejection can never take the others
            // (or the process, absent the global crash handler) down with it.
            console.error(`[dispatcher] tracked run for task ${claim.taskId} threw unexpectedly`, error);
          })
          .finally(() => {
            inFlight.delete(tracked);
          });
        inFlight.add(tracked);
      }
      await Promise.all(inFlight);
    } finally {
      this.draining = false;
    }
  }
}
