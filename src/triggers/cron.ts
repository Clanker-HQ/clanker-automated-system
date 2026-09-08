import { Cron } from "croner";
import { isLimitError, parseRateLimitReset } from "../control/rate-limit-reset.js";
import type { Orchestrator } from "../orchestrator.js";
import type { AgentDef } from "../registry.js";
import type { RunResult, RunStore } from "../run-store.js";
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

/**
 * How many attempts one scheduled firing gets when a subscription limit is
 * what stopped it, and how long after the reset instant to try again.
 *
 * Three, because the point is to recover the firing, not to poll: each retry
 * is aimed at a reset time something actually reported, so the first one
 * normally lands. The cap is what keeps a limit that never clears — or a
 * reset time that keeps parsing to "just about now" — from turning a
 * once-daily agent into a loop.
 *
 * The grace period exists because a reset instant is a boundary: firing at
 * exactly 13:20 races the window rolling over, and losing that race costs
 * the whole retry.
 */
const MAX_LIMIT_ATTEMPTS = 3;
const LIMIT_RETRY_GRACE_MS = 60_000;

/**
 * Ceiling on how far out a retry may be scheduled, matching the governor's
 * own RATE_LIMIT_MAX_HOLD_MS. Beyond this the reset time is not credible (a
 * parsing slip, a clock skew, an API changing units), and a cron agent is
 * better off waiting for its next real scheduled fire than sitting on a
 * day-long timer that survives no restart anyway.
 */
const MAX_LIMIT_RETRY_WAIT_MS = 6 * 60 * 60 * 1000;

/** Just the slice of Governor this file needs — see limitRetryAt. */
export interface LimitAwareGovernor {
  status(): Promise<{ rateLimitStatus: string | null; rateLimitResetsAt: number | null }>;
}

/**
 * When to re-run a scheduled firing that a subscription limit stopped, or
 * null if it should not be re-run at all.
 *
 * A cron agent that collides with a limit used to lose its slot outright.
 * improvement-scout fires once a day at 13:00; on 2026-09-08 it hit its
 * session limit and nothing ever re-ran it — catchUpIfMissed reads the failed
 * run's own startedAt and correctly concludes the fire was not missed. Not
 * being disabled for the collision (see BreakerStore's FAILURE_STATUSES and
 * isLimitError) is only half of it; the run still has to happen.
 *
 * Two shapes of collision, because there are two places a limit can stop a
 * firing. The run may START and be cut off, in which case its own error names
 * the reset time. Or admission may refuse it before it starts —
 * `executeRun` returns undefined — in which case the run has nothing to say
 * and the governor's current snapshot does.
 *
 * Only a limit earns a retry. A genuine failure re-run at the reset instant
 * would just fail again, and a refusal for quiet hours, budget or a tripped
 * breaker is the system working as intended.
 */
export async function limitRetryAt(
  result: RunResult | undefined,
  governor: LimitAwareGovernor | undefined,
  now: Date = new Date(),
): Promise<Date | null> {
  let target: Date | null = null;
  if (result) {
    // isLimitError, not the status alone: "interrupted" also covers a run
    // stopped for broken tools, which retrying at a reset instant cannot help.
    if (result.status !== "interrupted" || !isLimitError(result.error ?? "")) return null;
    target = parseRateLimitReset(result.error ?? "", now) ?? null;
  }
  if (!target && governor) {
    const status = await governor.status().catch((error: unknown) => {
      console.error("[cron] governor status lookup failed while sizing a limit retry", error);
      return null;
    });
    if (status?.rateLimitStatus === "rejected" && status.rateLimitResetsAt !== null) {
      target = new Date(status.rateLimitResetsAt * 1000);
    }
  }
  if (!target) return null;
  if (target.getTime() - now.getTime() > MAX_LIMIT_RETRY_WAIT_MS) return null;
  // A reset instant already in the past means the limit should be clear
  // already; still wait out the grace period rather than retrying instantly
  // into whatever is evidently still holding.
  return new Date(Math.max(target.getTime(), now.getTime()) + LIMIT_RETRY_GRACE_MS);
}

export interface CronFiringDeps {
  orchestrator: Pick<Orchestrator, "executeRun">;
  world: WorldModel;
  strategyStore: StrategyStore;
  governor?: LimitAwareGovernor;
  now?: () => Date;
  /** Injectable so a test need not wait out a real multi-hour timer. */
  schedule?: (at: Date, run: () => void) => void;
}

/**
 * One firing of a cron-triggered agent: the allocation check, the world-model
 * context, the run, and a bounded retry if a subscription limit stopped it.
 *
 * Extracted from startCron's callback so a retry can re-enter it directly
 * with an incremented attempt count, rather than going through
 * `job.trigger()` — which has no way to carry one, and so would reset the
 * count on every retry.
 */
export async function runCronFiring(agent: AgentDef, deps: CronFiringDeps, attempt = 0): Promise<void> {
  // Read fresh on every firing, not once at schedule time: jobs are
  // created once at boot but the strategy changes weekly, so reading
  // it at schedule time would freeze the first strategy forever.
  let strategy: Strategy | null = null;
  try {
    strategy = await deps.strategyStore.latest();
  } catch (error) {
    console.error(`[cron] ${agent.name} strategy lookup failed; running anyway`, error);
  }
  if (shouldSkip(agent, strategy)) {
    console.log(`[cron] ${agent.name} skipped: category "${agent.category}" has zero allocation this cycle`);
    return;
  }
  let promptContext: string | undefined;
  try {
    promptContext = await deps.world.summaryForPrompt();
  } catch (error) {
    // A world-model read must never stop a scheduled run — same
    // posture as dispatcher.ts's memory/world lookups. Fall back to
    // no context rather than skipping the run.
    console.error(`[cron] ${agent.name} world model summary skipped`, error);
  }

  let result: RunResult | undefined;
  try {
    result = await deps.orchestrator.executeRun(agent, undefined, promptContext);
  } catch (error: unknown) {
    console.error(`[cron] ${agent.name} run failed to complete`, error);
    return;
  }

  const now = deps.now?.() ?? new Date();
  const retryAt = await limitRetryAt(result, deps.governor, now);
  if (!retryAt) return;
  if (attempt + 1 >= MAX_LIMIT_ATTEMPTS) {
    console.log(
      `[cron] ${agent.name} still limited after ${attempt + 1} attempt(s); ` +
        `leaving it for its next scheduled fire`,
    );
    return;
  }
  console.log(
    `[cron] ${agent.name} hit a subscription limit; retrying at ${retryAt.toISOString()} ` +
      `(attempt ${attempt + 2}/${MAX_LIMIT_ATTEMPTS})`,
  );
  const run = (): void => {
    void runCronFiring(agent, deps, attempt + 1);
  };
  if (deps.schedule) {
    deps.schedule(retryAt, run);
  } else {
    // unref'd: a pending retry must not be the reason the process refuses to
    // exit on shutdown. It is also why a retry does not survive a restart —
    // acceptable, since boot's catchUpIfMissed already covers the case where
    // the process was down through a scheduled fire entirely.
    setTimeout(run, Math.max(0, retryAt.getTime() - now.getTime())).unref();
  }
}

export function startCron(
  agents: AgentDef[],
  orchestrator: Orchestrator,
  world: WorldModel,
  strategyStore: StrategyStore,
  runStore?: RunStore,
  governor?: LimitAwareGovernor,
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
        await runCronFiring(agent, { orchestrator, world, strategyStore, governor });
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
