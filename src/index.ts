import { join } from "node:path";
import { loadConfig } from "./config.js";
import { ValidationError } from "./errors.js";
import { Orchestrator } from "./orchestrator.js";
import { DiscordOutbox } from "./outbox/discord.js";
import { loadRegistry } from "./registry.js";
import { RunStore } from "./run-store.js";
import { FakeRunner } from "./runner/fake-runner.js";
import type { Runner } from "./runner/types.js";

const ROOT = process.env.APP_ROOT ?? process.cwd();
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");

function buildRunner(): Runner {
  // Task 7 wires the real runner (SdkRunner) in here, gated on RUNNER !== "fake".
  // Until then this always returns FakeRunner so `npm start` and `npm run
  // typecheck` stay green without depending on src/runner/sdk-runner.ts.
  console.log("[boot] RUNNER=fake — no subscription quota will be consumed");
  return new FakeRunner({
    events: [
      { type: "assistant", text: "Fake run: the pipeline is working." },
      { type: "usage", inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1 },
    ],
  });
}

function main(): void {
  let config, agents;
  try {
    config = loadConfig(join(ROOT, "config.yaml"));
    agents = loadRegistry({ agentsDir: join(ROOT, "agents"), dataDir: DATA_DIR, config });
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(`\n[boot] Configuration is invalid. Nothing was started.\n`);
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  console.log(`[boot] ${agents.length} agent(s) loaded: ${agents.map((a) => a.name).join(", ")}`);

  const orchestrator = new Orchestrator({
    runner: buildRunner(),
    store: new RunStore(DATA_DIR),
    outbox: new DiscordOutbox({ config, dataDir: DATA_DIR }),
    dataDir: DATA_DIR,
  });

  // Imported lazily so a boot failure above never starts a schedule.
  void import("./triggers/cron.js").then(({ startCron }) => {
    startCron(agents, orchestrator);
    console.log("[boot] supervisor running");
  });
}

main();
