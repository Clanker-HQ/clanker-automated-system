import { Cron } from "croner";
import type { MemoryStore } from "../memory/memory-store.js";
import { runReflection } from "../memory/reflection.js";
import type { RunResult, RunStore } from "../run-store.js";

export function startReflection(opts: {
  schedule: string;
  timezone: string;
  windowDays: number;
  memory: MemoryStore;
  runStore: RunStore;
  synthesise: (digestText: string) => Promise<Array<{ domain: string; subject: string; body: string; importance: number }>>;
  now?: () => Date;
}): Cron {
  const now = opts.now ?? (() => new Date());
  const job = new Cron(opts.schedule, { timezone: opts.timezone, protect: true }, () => {
    void (async () => {
      const nowDate = now();
      const since = new Date(nowDate.getTime() - opts.windowDays * 24 * 60 * 60 * 1000);
      const runs: RunResult[] = await opts.runStore.listSince(since, nowDate);
      const written = await runReflection({
        memory: opts.memory, runs, windowDays: opts.windowDays, synthesise: opts.synthesise, now: nowDate,
      });
      console.log(
        `[reflection] wrote ${written.length} reflection record(s) from ${runs.length} run(s) over the trailing ${opts.windowDays}d`,
      );
    })().catch((error: unknown) => {
      console.error("[reflection] pass failed", error);
    });
  });
  console.log(
    `[reflection] scheduled "${opts.schedule}" (${opts.timezone}); next run ${job.nextRun()?.toISOString() ?? "never"}`,
  );
  return job;
}
