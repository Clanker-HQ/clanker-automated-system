import type { MemoryConfig } from "../config.js";
import type { ConfigOverridesStore } from "../config-overrides.js";
import type { FindingReviewer } from "../control/finding-reviewer.js";
import type { GitPusher } from "../control/git-pusher.js";
import type { GithubTransport } from "../control/github-transport.js";
import type { PendingStore } from "../control/pending.js";
import type { TaskReviewer } from "../control/task-reviewer.js";
import type { TaskStore } from "../control/task-store.js";
import type { Grant } from "../grants.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { DiscordOutbox } from "../outbox/discord.js";
import type { AgentDef } from "../registry.js";
import type { BreakerStore } from "../state/breaker.js";
import type { StrategyStore } from "../world/strategy.js";
import type { WorldModel } from "../world/world-model.js";
import { FakeRunner } from "./fake-runner.js";
import { SdkRunner } from "./sdk-runner.js";
import type { Runner } from "./types.js";

/**
 * Selects the runner the supervisor will drive.
 *
 * Note the polarity: the REAL runner is the default and the fake is the
 * opt-in, matching .env.example ("Set to \"fake\" to run the pipeline without
 * consuming any subscription quota"). RUNNER is read here and nowhere else.
 *
 * This lives outside index.ts so it can be tested directly: importing
 * index.ts runs main(), which loads config, builds a schedule and starts the
 * supervisor.
 */
export function buildRunner(
  opts: {
    grants: Grant[];
    pending: PendingStore;
    github?: GithubTransport;
    gitPusher?: GitPusher;
    tasks?: TaskStore;
    taskReviewer?: TaskReviewer;
    wake?: () => Promise<void>;
    systemContext?: string;
    memory?: MemoryStore;
    memoryConfig?: MemoryConfig;
    world?: WorldModel;
    findingReviewer?: FindingReviewer;
    strategyStore?: StrategyStore;
    overrides?: ConfigOverridesStore;
    breaker?: BreakerStore;
    agents?: AgentDef[];
    outbox?: DiscordOutbox;
  },
  env: NodeJS.ProcessEnv = process.env,
): Runner {
  if (env.RUNNER === "fake") {
    console.log("[boot] RUNNER=fake — no subscription quota will be consumed");
    return new FakeRunner({
      events: [
        { type: "assistant", text: "Fake run: the pipeline is working." },
        { type: "usage", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 1 },
      ],
    });
  }
  return new SdkRunner(opts);
}
