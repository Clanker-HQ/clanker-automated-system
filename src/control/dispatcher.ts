import { join } from "node:path";
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

function specialistsOf(agents: AgentDef[]): Specialist[] {
  return agents
    .filter((a) => a.enabled && a.trigger.type === "dispatched")
    .map((a) => ({ name: a.name, description: a.description }));
}

export interface DispatchOutcome {
  ran: boolean;
  taskId?: string;
  /**
   * True only when the Governor refused admission and the task went back to
   * "pending". The drain loop in Dispatcher.wake() must stop on this: the very
   * next nextPending() would return the SAME task, hit the same refusal, and
   * spin — burning CPU (and, before the routing cache below, an unbudgeted
   * routing LLM call per iteration) for as long as the refusal lasts, which
   * for quiet hours is measured in hours.
   */
  deferred?: boolean;
}

/** Attempts exactly one pending task, if one exists. Pure enough to unit test without a timer, a real Router, or a real Orchestrator. */
export async function runDispatchTick(deps: DispatcherDeps): Promise<DispatchOutcome> {
  const task = await deps.tasks.nextPending();
  if (!task) return { ran: false };

  const now = deps.now ?? (() => new Date());

  try {
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

    // A task deferred by a previous governor refusal keeps the specialist it
    // was already routed to, so a retry costs no second routing call. Only an
    // unrouted task pays for the router.
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
        await deps.notify(`⚠️ Task \`${task.id}\` failed: ${reason}. Text: ${task.text}`);
        return { ran: true, taskId: task.id };
      }

      // Persist the routing decision before attempting admission, so a refusal
      // on this very attempt still leaves the choice cached for the next one.
      await deps.tasks.update(task.id, { specialistAgent: agent.name });
    }

    await deps.tasks.update(task.id, { status: "running", specialistAgent: agent.name, startedAt: now().toISOString() });

    const result = await deps.orchestrator.executeRun(agent, now(), task.text);

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
      await deps.notify(`✅ Task \`${task.id}\` done: ${result.summary}`);
    } else if (result.status === "parked" || result.status === "question") {
      // NOT a failure: the run is alive and paused mid-execution awaiting a
      // human approve/deny/answer, which Orchestrator.resumeRun will continue
      // in the original session. Marking it "failed" here would fabricate a
      // finishedAt, invent a failure reason, and hide the task from !tasks at
      // exactly the moment the owner needs to see that it is waiting on them.
      //
      // Known v1 limitation: nothing updates this task again once the human
      // resumes the run to its real completion — the resume path knows about
      // runs and pending entries, not tasks. Cross-linking a resumed run back
      // to its task is future work, deliberately not attempted here.
      await deps.tasks.update(task.id, { status: "waiting" });
    } else {
      const reason = result.error ?? `run ended with status "${result.status}"`;
      await deps.tasks.update(task.id, {
        status: "failed",
        finishedAt: now().toISOString(),
        failureReason: reason,
      });
      await deps.notify(`❌ Task \`${task.id}\` failed: ${reason}`);
    }
    return { ran: true, taskId: task.id };
  } catch (error) {
    // Anything thrown mid-attempt (a prompt file that won't read, a notify()
    // rejection, an update() racing a deleted task file) would otherwise leave
    // the task stuck "running" — invisible to nextPending() forever — and abort
    // the whole drain. Fail the task loudly instead, and let the drain go on:
    // a thrown error is not a "wait for the governor" situation.
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

  async wake(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      // Stop on a deferral, not just on an empty queue: a governor refusal
      // leaves the same task at the head of the queue, so continuing would
      // re-pick it immediately and spin until the refusal lifts. The periodic
      // tick (or the next !task / completed run) is what retries it.
      let outcome = await runDispatchTick(this.deps);
      while (outcome.ran && !outcome.deferred) outcome = await runDispatchTick(this.deps);
    } finally {
      this.draining = false;
    }
  }
}
