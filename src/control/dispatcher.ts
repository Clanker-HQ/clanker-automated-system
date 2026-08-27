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
  /** Posts a message for a task that never reaches Orchestrator.executeRun — a routing failure has no run, so it never gets a report through the agent's own outbox. */
  notify: (text: string) => Promise<void>;
  dataDir: string;
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
      result: { summary: result.summary, path: join(deps.dataDir, "runs", result.runId) },
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
      let outcome = await runDispatchTick(this.deps);
      while (outcome.ran) outcome = await runDispatchTick(this.deps);
    } finally {
      this.draining = false;
    }
  }
}
