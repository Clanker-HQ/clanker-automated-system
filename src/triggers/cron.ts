import { Cron } from "croner";
import type { Orchestrator } from "../orchestrator.js";
import type { AgentDef } from "../registry.js";
import type { WorldModel } from "../world/world-model.js";

export function startCron(agents: AgentDef[], orchestrator: Orchestrator, world: WorldModel): Cron[] {
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
