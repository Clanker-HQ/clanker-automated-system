import { Cron } from "croner";
import type { Orchestrator } from "../orchestrator.js";
import type { AgentDef } from "../registry.js";
import type { Strategy, StrategyStore } from "../world/strategy.js";
import type { WorldModel } from "../world/world-model.js";

/**
 * Zero allocation for a declared category means skip; everything else means
 * run. Fail open in three separate senses — no strategy written yet, an
 * unreadable strategy file, and an agent with no `category` all mean RUN.
 * A system that quietly stops scheduling itself because the overseer hasn't
 * had its first Monday yet is a far worse failure than one that over-runs.
 */
function shouldSkip(agent: AgentDef, strategy: Strategy | null): boolean {
  if (!agent.category) return false;
  if (!strategy) return false;
  return strategy.allocation[agent.category] === 0;
}

export function startCron(
  agents: AgentDef[],
  orchestrator: Orchestrator,
  world: WorldModel,
  strategyStore: StrategyStore,
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
  }
  return jobs;
}
