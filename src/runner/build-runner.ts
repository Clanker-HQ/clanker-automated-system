import type { GithubTransport } from "../control/github-transport.js";
import type { PendingStore } from "../control/pending.js";
import type { Grant } from "../grants.js";
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
  opts: { grants: Grant[]; pending: PendingStore; github?: GithubTransport },
  env: NodeJS.ProcessEnv = process.env,
): Runner {
  if (env.RUNNER === "fake") {
    console.log("[boot] RUNNER=fake — no subscription quota will be consumed");
    return new FakeRunner({
      events: [
        { type: "assistant", text: "Fake run: the pipeline is working." },
        { type: "usage", inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1 },
      ],
    });
  }
  return new SdkRunner(opts);
}
