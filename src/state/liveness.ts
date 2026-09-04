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

export interface AgentLiveness {
  lastRunAt: Date | null;
  /** Null for a disabled/non-cron agent, or a schedule croner can never fire again -- there is no cadence to judge staleness against. */
  cadenceMs: number | null;
  /**
   * True only when the absence of a recent run is actually meaningful: an
   * enabled cron agent, not this cycle's intentional zero-allocation skip,
   * silent for more than `multiplier` cadences (or never having run at all).
   * A disabled, non-cron, or strategy-skipped agent is never stale -- it
   * simply isn't being checked, which is a different fact than "checked and
   * found broken".
   */
  stale: boolean;
}

/**
 * Generalizes stalePasses (below) from "the weekly metrics pass" to any
 * single agent: `dependency-scout`, `cleanup-scout`, `portfolio-sync-scout`,
 * `overseer`, etc. all stop running the same silent way a stopped metrics
 * pass does. A category the current strategy has zero-allocated (cron.ts's
 * own shouldSkip) never counts as stale -- that is an intentional skip, not
 * the pass having died.
 */
export function agentLiveness(opts: {
  agent: AgentDef;
  strategy: Strategy | null;
  lastRunAt: Date | null;
  now: Date;
  /** How many cadences of silence before it's stale, not a fluke -- matches MAX_METRICS_AGE_DAYS/MAX_PROBE_AGE_MINUTES's own "twice the cadence" rule in src/digest.ts. */
  multiplier?: number;
}): AgentLiveness {
  const multiplier = opts.multiplier ?? 2;
  if (!opts.agent.enabled || opts.agent.trigger.type !== "cron" || shouldSkip(opts.agent, opts.strategy)) {
    return { lastRunAt: opts.lastRunAt, cadenceMs: null, stale: false };
  }
  const cadenceMs = cronCadenceMs(opts.agent.trigger.schedule, opts.agent.trigger.timezone);
  if (cadenceMs === null) return { lastRunAt: opts.lastRunAt, cadenceMs: null, stale: false };
  const stale = opts.lastRunAt === null || opts.now.getTime() - opts.lastRunAt.getTime() > cadenceMs * multiplier;
  return { lastRunAt: opts.lastRunAt, cadenceMs, stale };
}

/** Renders agentLiveness's verdict as the digest's warning lines -- see agentLiveness for what "stale" means and why a skipped agent is exempt. */
export function staleCronAgents(opts: {
  agents: AgentDef[];
  strategy: Strategy | null;
  lastRunAt: (agentName: string) => Date | null;
  now: Date;
  multiplier?: number;
}): string[] {
  const warnings: string[] = [];
  for (const agent of opts.agents) {
    const liveness = agentLiveness({
      agent, strategy: opts.strategy, lastRunAt: opts.lastRunAt(agent.name), now: opts.now, multiplier: opts.multiplier,
    });
    if (!liveness.stale) continue;
    if (liveness.lastRunAt === null) {
      warnings.push(`⚠️ **${agent.name}** has never run — its cron pass has never completed.`);
      continue;
    }
    const ageMs = opts.now.getTime() - liveness.lastRunAt.getTime();
    const ageDays = ageMs / DAY_MS;
    const ageDesc = ageDays >= 1 ? `${ageDays.toFixed(1)} days` : `${Math.round(ageMs / (60 * 1000))} minutes`;
    warnings.push(`⚠️ **${agent.name}**'s cron pass hasn't run in ${ageDesc} — it looks stopped, not just quiet.`);
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
