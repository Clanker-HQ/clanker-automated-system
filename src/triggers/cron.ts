import { Cron } from "croner";
import type { Orchestrator } from "../orchestrator.js";
import type { AgentDef } from "../registry.js";
import type { RunStore } from "../run-store.js";
import type { Strategy, StrategyStore } from "../world/strategy.js";
import type { WorldModel } from "../world/world-model.js";

/**
 * Zero allocation for a declared category means skip; everything else means
 * run. Fail open in three separate senses — no strategy written yet, an
 * unreadable strategy file, and an agent with no `category` all mean RUN.
 * A system that quietly stops scheduling itself because the overseer hasn't
 * had its first Monday yet is a far worse failure than one that over-runs.
 */
export function shouldSkip(agent: AgentDef, strategy: Strategy | null): boolean {
  if (!agent.category) return false;
  if (!strategy) return false;
  return strategy.allocation[agent.category] === 0;
}

/**
 * Whether a cron-triggered agent's schedule already came due before `now`
 * without a run to show for it -- the signature of a machine that wasn't on
 * at the scheduled minute, not of the agent actually running and finding
 * nothing to do. This project runs on `npm start` on a local machine, no VPS
 * yet (docs/system-context.md): a weekly or daily schedule can sleep through
 * its entire window if the laptop happens to be off right then, and croner
 * itself has no memory of that -- left alone it just waits for the NEXT
 * scheduled time, silently stretching a "weekly" agent to however long the
 * machine happens to stay off.
 *
 * `job.previousRuns(1, now)` is pattern-derived (like cronCadenceMs's use of
 * nextRun above), not the job instance's own fire history -- it answers "when
 * SHOULD this last have fired", which is exactly what's needed on a job that
 * was only just constructed this boot and has never fired for real yet.
 */
export function missedFireAt(job: Cron, lastRunAt: Date | null, now: Date = new Date()): Date | null {
  let due: Date | null;
  try {
    // Croner's backward search throws on some pathological patterns (e.g. a
    // once-every-few-years Feb 29 job with nothing yet in range) rather than
    // returning an empty array -- treated the same as "no previous fire to
    // catch up on", same posture as cronCadenceMs's own null-for-unfireable
    // case just above.
    due = job.previousRuns(1, now)[0] ?? null;
  } catch {
    return null;
  }
  if (!due) return null;
  if (lastRunAt && lastRunAt >= due) return null;
  return due;
}

/**
 * Runs a cron-triggered agent's job immediately if it missed its most recent
 * scheduled fire (see missedFireAt) -- reuses `job.trigger()` rather than
 * duplicating the callback, so the catch-up run passes through the exact same
 * allocation-skip check and Governor admission (budget/concurrency/quiet
 * hours) as a normal scheduled fire. Fire-and-forget from the caller's
 * perspective, same as the cron callback itself; errors are logged, never
 * thrown, so one agent's failed catch-up check can't stop the rest from being
 * scheduled.
 */
export async function catchUpIfMissed(agent: AgentDef, job: Cron, runStore: RunStore, now: Date = new Date()): Promise<void> {
  try {
    const last = await runStore.latestFor(agent.name);
    const due = missedFireAt(job, last ? new Date(last.startedAt) : null, now);
    if (!due) return;
    console.log(`[cron] ${agent.name} missed its ${due.toISOString()} fire (process was likely down); catching up now`);
    await job.trigger();
  } catch (error) {
    console.error(`[cron] ${agent.name} catch-up check failed`, error);
  }
}

export function startCron(
  agents: AgentDef[],
  orchestrator: Orchestrator,
  world: WorldModel,
  strategyStore: StrategyStore,
  runStore?: RunStore,
): Cron[] {
  const jobs: Cron[] = [];
  for (const agent of agents) {
    if (!agent.enabled) {
      console.log(`[cron] ${agent.name} is disabled; not scheduled`);
      continue;
    }
    if (agent.trigger.type !== "cron") continue;
    const job = new Cron(
      agent.trigger.schedule,
      { timezone: agent.trigger.timezone, protect: true },
      // Async rather than `void run().catch()`: croner awaits an async
      // callback, so `job.trigger()` becomes awaitable, which is what lets
      // this path be tested at all — see tests/metrics-trigger.test.ts.
      async () => {
        // Read fresh on every firing, not once at schedule time: jobs are
        // created once at boot but the strategy changes weekly, so reading
        // it at schedule time would freeze the first strategy forever.
        let strategy: Strategy | null = null;
        try {
          strategy = await strategyStore.latest();
        } catch (error) {
          console.error(`[cron] ${agent.name} strategy lookup failed; running anyway`, error);
        }
        if (shouldSkip(agent, strategy)) {
          console.log(`[cron] ${agent.name} skipped: category "${agent.category}" has zero allocation this cycle`);
          return;
        }
        let promptContext: string | undefined;
        try {
          promptContext = await world.summaryForPrompt();
        } catch (error) {
          // A world-model read must never stop a scheduled run — same
          // posture as dispatcher.ts's memory/world lookups. Fall back to
          // no context rather than skipping the run.
          console.error(`[cron] ${agent.name} world model summary skipped`, error);
        }
        try {
          await orchestrator.executeRun(agent, undefined, promptContext);
        } catch (error: unknown) {
          console.error(`[cron] ${agent.name} run failed to complete`, error);
        }
      },
    );
    console.log(
      `[cron] ${agent.name} scheduled "${agent.trigger.schedule}" (${agent.trigger.timezone}); ` +
        `next run ${job.nextRun()?.toISOString() ?? "never"}`,
    );
    jobs.push(job);
    if (runStore) void catchUpIfMissed(agent, job, runStore);
  }
  return jobs;
}
