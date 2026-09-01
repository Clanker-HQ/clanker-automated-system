import { Cron } from "croner";
import type { Deployment } from "../deploy/deploys-schema.js";
import { httpProbe, runProbePass, type UrlProbe } from "../deploy/probe.js";
import type { ProbeStore } from "../deploy/probe-store.js";

export function startProbe(opts: {
  schedule: string;
  timezone: string;
  deployments: Deployment[];
  store: ProbeStore;
  probe?: UrlProbe;
  now?: () => Date;
}): Cron {
  const now = opts.now ?? (() => new Date());
  const probe = opts.probe ?? httpProbe;
  // Async rather than `void run().catch()`: croner awaits an async callback,
  // so `protect: true` genuinely prevents an overlapping pass and
  // `job.trigger()` becomes awaitable — same reasoning as startMetrics.
  const job = new Cron(opts.schedule, { timezone: opts.timezone, protect: true }, async () => {
    try {
      const previous = await opts.store.read();
      const results = await runProbePass({ deployments: opts.deployments, previous, probe, now: now() });
      await opts.store.write(results);
      const down = results.filter((r) => !r.ok);
      console.log(`[probe] probed ${results.length} deployment(s); ${down.length} not serving`);
    } catch (error) {
      console.error("[probe] pass failed", error);
    }
  });
  console.log(`[probe] scheduled "${opts.schedule}" (${opts.timezone}); next run ${job.nextRun()?.toISOString() ?? "never"}`);
  return job;
}
