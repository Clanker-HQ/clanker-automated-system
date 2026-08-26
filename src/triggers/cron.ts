import { Cron } from "croner";
import type { Orchestrator } from "../orchestrator.js";
import type { AgentDef } from "../registry.js";

export function startCron(agents: AgentDef[], orchestrator: Orchestrator): Cron[] {
  const jobs: Cron[] = [];
  for (const agent of agents) {
    if (!agent.enabled) {
      console.log(`[cron] ${agent.name} is disabled; not scheduled`);
      continue;
    }
    const job = new Cron(
      agent.trigger.schedule,
      { timezone: agent.trigger.timezone, protect: true },
      () => {
        void orchestrator.executeRun(agent).catch((error: unknown) => {
          console.error(`[cron] ${agent.name} run failed to complete`, error);
        });
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
