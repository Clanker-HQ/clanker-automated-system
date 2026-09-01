import { Cron } from "croner";
import type { RevenueTransport } from "../control/revenue-transport.js";
import { loadGoals } from "../goals.js";
import type { Orchestrator } from "../orchestrator.js";
import type { AgentDef } from "../registry.js";
import type { MetricsStore } from "../state/metrics-store.js";
import { gradeExpectations, type Verdict } from "../world/grade-expectations.js";
import type { Strategy, StrategyStore } from "../world/strategy.js";
import type { WorldModel } from "../world/world-model.js";

function renderGoals(goalsPath: string): string {
  const goals = loadGoals(goalsPath);
  if (!goals) {
    return "No goals.yaml has been written yet — the operator has not completed the bootstrap step. Say so in `intent` rather than inventing a goal.";
  }
  return (
    `Primary: ${goals.primary.statement}\n` +
    `Secondary (instrumental): ${goals.secondary.statement}\n` +
    `Means:\n${goals.means.map((m) => `- ${m}`).join("\n")}`
  );
}

function renderPreviousStrategy(strategy: Strategy | null): string {
  if (!strategy) return "None — this is the first cycle.";
  return (
    `Written: ${strategy.writtenAt}\n` +
    `Intent: ${strategy.intent}\n` +
    `Allocation: research=${strategy.allocation.research} build=${strategy.allocation.build} maintain=${strategy.allocation.maintain}\n` +
    `Change reason: ${strategy.changeReason || "(none given)"}`
  );
}

function renderVerdicts(verdicts: Verdict[]): string {
  if (verdicts.length === 0) return "None — no expectations were due, or this is the first cycle.";
  return verdicts.map((v) => `- ${v.expectationId}: ${v.outcome} — ${v.detail}`).join("\n");
}

/**
 * Grades the previous cycle's expectations and assembles everything the
 * overseer needs into one prompt context, the same extension point
 * startCron's world.summaryForPrompt() uses (Orchestrator.executeRun's
 * `promptContext` parameter) — except this trigger is bespoke rather than
 * going through the generic per-agent cron loop, because grading and
 * loadGoals only belong here, not on every cron agent. See Design §3 in the
 * autonomous-operation plan for why the overseer itself stays off the
 * execution path even though this trigger runs it like any other agent.
 */
async function buildPromptContext(opts: {
  strategyStore: StrategyStore;
  world: WorldModel;
  metricsStore: MetricsStore;
  revenue: RevenueTransport;
  goalsPath: string;
  now: Date;
}): Promise<string> {
  const previousStrategy = await opts.strategyStore.latest();
  const { latest: metricsSnapshot } = await opts.metricsStore.latestTwo();
  const salesInWindow = previousStrategy ? await opts.revenue.listSales(previousStrategy.writtenAt) : [];
  const portfolio = await opts.world.readPortfolio();
  const verdicts = previousStrategy
    ? gradeExpectations({
        expectations: previousStrategy.expectations,
        metrics: metricsSnapshot,
        salesInWindow,
        portfolio,
        now: opts.now,
      })
    : [];
  const worldSummary = await opts.world.summaryForPrompt();

  return (
    `## Goals\n\n${renderGoals(opts.goalsPath)}\n\n` +
    `## Previous strategy\n\n${renderPreviousStrategy(previousStrategy)}\n\n` +
    `## Verdicts on the previous cycle's expectations\n\n${renderVerdicts(verdicts)}\n\n` +
    `## World model\n\n${worldSummary}`
  );
}

export function startOverseer(opts: {
  agent: AgentDef;
  orchestrator: Orchestrator;
  strategyStore: StrategyStore;
  world: WorldModel;
  metricsStore: MetricsStore;
  revenue: RevenueTransport;
  goalsPath: string;
  now?: () => Date;
}): Cron {
  if (opts.agent.trigger.type !== "cron") {
    throw new Error(`startOverseer requires a cron-triggered agent; "${opts.agent.name}" has trigger.type "${opts.agent.trigger.type}"`);
  }
  const trigger = opts.agent.trigger;
  const now = opts.now ?? (() => new Date());
  // Async rather than `void run().catch()`: croner awaits an async callback,
  // so `protect: true` genuinely prevents an overlapping run, and
  // `job.trigger()` becomes awaitable — same reasoning as startMetrics.
  const job = new Cron(trigger.schedule, { timezone: trigger.timezone, protect: true }, async () => {
    try {
      const nowDate = now();
      const promptContext = await buildPromptContext({
        strategyStore: opts.strategyStore,
        world: opts.world,
        metricsStore: opts.metricsStore,
        revenue: opts.revenue,
        goalsPath: opts.goalsPath,
        now: nowDate,
      });
      await opts.orchestrator.executeRun(opts.agent, nowDate, promptContext);
      console.log(`[overseer] cycle run for ${nowDate.toISOString()} complete`);
    } catch (error) {
      console.error("[overseer] cycle failed", error);
    }
  });
  console.log(
    `[overseer] scheduled "${trigger.schedule}" (${trigger.timezone}); next run ${job.nextRun()?.toISOString() ?? "never"}`,
  );
  return job;
}
