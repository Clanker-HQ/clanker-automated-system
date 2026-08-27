import { LlmRouter } from "./llm-router.js";
import { FakeRouter, type Router } from "./router.js";

/**
 * Same fake/real switch as buildRunner (src/runner/build-runner.ts), read
 * from the same RUNNER env var — a dispatcher run under RUNNER=fake must
 * consume no subscription quota either, not just the specialist's own run.
 * The fake always picks the first registered specialist, so the whole
 * queue -> route -> run -> report pipeline can be exercised end to end with
 * zero real spend, the same way FakeRunner already lets the rest of this
 * project be tested.
 */
export function buildRouter(env: NodeJS.ProcessEnv = process.env): Router {
  if (env.RUNNER === "fake") {
    return new FakeRouter((_taskText, specialists) => specialists[0]?.name ?? null);
  }
  return new LlmRouter();
}
