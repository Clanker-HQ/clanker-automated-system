/**
 * Calls the SDK's experimental usage control method exactly the way
 * SdkRunner does (fired alongside a live run, awaited after the stream
 * drains) and prints the raw `rate_limits` payload.
 *
 * Exists because that call is the only proactive source of per-window
 * rate-limit percentages, it is deliberately wrapped in a swallow-everything
 * try/catch so it can never fail a run, and its failures therefore surface
 * nowhere except the supervisor's stdout. When the dashboard's 5h/7d tile
 * looks stale or wrong, run this to find out whether the endpoint is
 * answering at all before touching the display code.
 *
 * Costs one tiny Haiku turn against the real account.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCredentials } from "../src/runner/credentials.js";
import { toRateLimitSnapshotEvent } from "../src/runner/sdk-runner.js";

async function main(): Promise<void> {
  const { mode, childEnv } = resolveCredentials();
  console.log(`credential mode: ${mode}`);

  const stream = query({
    prompt: "Reply with exactly the word: ready",
    options: {
      model: "claude-haiku-4-5",
      maxTurns: 1,
      allowedTools: [],
      env: childEnv,
      permissionMode: "default",
      settingSources: [],
    },
  });

  const usage = (async () => {
    try {
      return { ok: true as const, value: await stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() };
    } catch (err) {
      return { ok: false as const, err };
    }
  })();

  for await (const message of stream) {
    if ((message as { type?: string }).type === "result") console.log("run finished");
  }

  const result = await usage;
  if (!result.ok) {
    console.log("\nusage call FAILED — this is what the supervisor swallows:");
    console.log(result.err);
    return;
  }
  console.log("\nrate_limits_available:", result.value.rate_limits_available);
  console.log("subscription_type:", result.value.subscription_type);
  console.log("rate_limits:", JSON.stringify(result.value.rate_limits, null, 2));
  console.log("\nmapped to a rate_limit_snapshot event:", JSON.stringify(toRateLimitSnapshotEvent(result.value)));
}

void main();
