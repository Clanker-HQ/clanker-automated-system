import { Cron } from "croner";
import { shouldSkip } from "../triggers/cron.js";
import type { AgentDef } from "../registry.js";
import type { Strategy } from "../world/strategy.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The real gap between two consecutive fires of a cron schedule, computed from croner itself rather than parsed out of the expression -- correct for any valid schedule, not just the "daily"/"weekly" shapes a hand-rolled parser would special-case. Null only for a schedule croner can never fire again (e.g. a past-only expression), which none of this repo's agent.yaml files use. */
export function cronCadenceMs(schedule: string, timezone: string): number | null {
  const job = new Cron(schedule, { timezone });
  const first = job.nextRun();
  if (!first) return null;
  const second = job.nextRun(first);
  if (!second) return null;
  return second.getTime() - first.getTime();
}

/**
 * Generalizes stalePasses (below) from "the weekly metrics pass" to any
 * enabled cron-triggered agent: `dependency-scout`, `cleanup-scout`,
 * `portfolio-sync-scout`, `overseer`, etc. all stop running the same silent
 * way a stopped metrics pass does, and nothing before this caught it for any
 * agent but metrics/probe. A category the current strategy has zero-
 * allocated (cron.ts's own shouldSkip) is excluded -- that is an intentional
 * skip, not the pass having died.
 */
export function staleCronAgents(opts: {
  agents: AgentDef[];
  strategy: Strategy | null;
  lastRunAt: (agentName: string) => Date | null;
  now: Date;
  /** How many cadences of silence before it's a warning, not a fluke -- matches MAX_METRICS_AGE_DAYS/MAX_PROBE_AGE_MINUTES's own "twice the cadence" rule in src/digest.ts. */
  multiplier?: number;
}): string[] {
  const multiplier = opts.multiplier ?? 2;
  const warnings: string[] = [];
  for (const agent of opts.agents) {
    if (!agent.enabled) continue;
    if (agent.trigger.type !== "cron") continue;
    if (shouldSkip(agent, opts.strategy)) continue;
    const cadenceMs = cronCadenceMs(agent.trigger.schedule, agent.trigger.timezone);
    if (cadenceMs === null) continue;
    const last = opts.lastRunAt(agent.name);
    if (last === null) {
      warnings.push(`⚠️ **${agent.name}** has never run — its cron pass has never completed.`);
      continue;
    }
    const ageMs = opts.now.getTime() - last.getTime();
    if (ageMs > cadenceMs * multiplier) {
      const ageDays = ageMs / DAY_MS;
      const ageDesc = ageDays >= 1 ? `${ageDays.toFixed(1)} days` : `${Math.round(ageMs / (60 * 1000))} minutes`;
      warnings.push(`⚠️ **${agent.name}**'s cron pass hasn't run in ${ageDesc} — it looks stopped, not just quiet.`);
    }
  }
  return warnings;
}

/**
 * Whether the system's periodic self-assessment is actually still happening.
 *
 * Deliberately code and not an agent: the failure this detects is "the
 * scheduled pass stopped running", and an agent that has stopped running
 * cannot report that it has stopped running. Read by the daily digest, which
 * runs on its own schedule and so survives the weekly ones dying.
 */
export function stalePasses(input: { latestMetricsAt: string | null; now: Date; maxAgeDays: number }): string[] {
  if (input.latestMetricsAt === null) {
    return ["⚠️ No metrics snapshot has ever been written — the weekly metrics pass has never completed."];
  }
  const ageDays = (input.now.getTime() - new Date(input.latestMetricsAt).getTime()) / DAY_MS;
  if (ageDays > input.maxAgeDays) {
    return [`⚠️ The newest metrics snapshot is ${Math.floor(ageDays)} days old — the weekly metrics pass has stopped running.`];
  }
  return [];
}
