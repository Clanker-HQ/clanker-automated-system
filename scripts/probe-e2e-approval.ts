/**
 * Manual, interactive end-to-end check of the full grant/park/Discord-
 * approval/resume chain, using the real SdkRunner (haiku) and the real
 * Discord bot — not a substitute for the automated test suite, a live
 * confirmation that the whole pipeline actually works together.
 *
 * Mirrors src/index.ts's real wiring exactly, except: it triggers
 * agents/e2e-approval-test directly (once) instead of starting cron, and it
 * does not exit — the Discord gateway connection keeps the process alive so
 * the bot can receive your approve/deny reply and call resumeRun.
 *
 * Run: npm run probe:e2e-approval
 * Then: reply in Discord to the posted approval prompt, and watch this
 * process's stdout for the outcome. Ctrl+C when done.
 */
import { join } from "node:path";
import { type Config, loadConfig } from "../src/config.js";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { DiscordBot } from "../src/control/bot.js";
import { DiscordJsTransport } from "../src/control/discord-transport.js";
import { PendingStore } from "../src/control/pending.js";
import { ValidationError } from "../src/errors.js";
import { Governor } from "../src/governor.js";
import { type Grant, loadGrants, validateGrantRefs } from "../src/grants.js";
import { Orchestrator } from "../src/orchestrator.js";
import { DiscordOutbox } from "../src/outbox/discord.js";
import { type AgentDef, loadRegistry } from "../src/registry.js";
import { RunStore } from "../src/run-store.js";
import { SdkRunner } from "../src/runner/sdk-runner.js";
import { BreakerStore } from "../src/state/breaker.js";
import { RateLimitTracker } from "../src/state/rate-limit.js";

const ROOT = process.env.APP_ROOT ?? process.cwd();
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new ValidationError(".env", [`${name} is required`]);
  return v;
}

async function main(): Promise<void> {
  let config: Config;
  let agents: AgentDef[];
  let botToken: string;
  let ownerId: string;

  try {
    config = loadConfig(join(ROOT, "config.yaml"));
    agents = loadRegistry({ agentsDir: join(ROOT, "agents"), dataDir: DATA_DIR, config });
    const grants: Grant[] = loadGrants(join(ROOT, "grants.yaml"));
    validateGrantRefs(agents, grants);
    botToken = mustEnv("DISCORD_BOT_TOKEN");
    ownerId = mustEnv("DISCORD_OWNER_ID");

    const testAgent = agents.find((a) => a.name === "e2e-approval-test");
    if (!testAgent) {
      throw new ValidationError("agents/", [
        "e2e-approval-test not found. Create agents/e2e-approval-test/ before running this probe.",
      ]);
    }

    const runStore = new RunStore(DATA_DIR);
    const overrides = new ConfigOverridesStore(DATA_DIR);
    const breaker = new BreakerStore(DATA_DIR);
    const governor = new Governor({
      dataDir: DATA_DIR, config, store: runStore, overrides,
      rateLimits: new RateLimitTracker(DATA_DIR), breaker,
    });

    const pending = new PendingStore(DATA_DIR);
    let bot: DiscordBot | undefined;

    const orchestrator = new Orchestrator({
      runner: new SdkRunner({ grants, pending }),
      store: runStore,
      outbox: new DiscordOutbox({ config, dataDir: DATA_DIR }),
      dataDir: DATA_DIR,
      governor,
      breaker,
      onParked: async (pendingId, kind) => {
        console.log(`\n[probe] run parked (${kind}), pending id: ${pendingId}`);
        if (!bot) return;
        const entry = await pending.get(pendingId);
        if (!entry) return;
        console.log(`[probe] posting to Discord — reply there with 'approve ${entry.id}' or 'deny ${entry.id}'`);
        if (kind === "approval") await bot.postApproval(entry);
        else await bot.postQuestion(entry);
      },
    });

    bot = new DiscordBot({
      transport: new DiscordJsTransport({ token: botToken }),
      pending, orchestrator, agents, ownerId,
      channelFor: (agentName) => {
        const agentDef = agents.find((a) => a.name === agentName);
        const key = agentDef?.outbox.discord ?? "";
        const varName = config.discord.botChannels[key];
        return varName ? (process.env[varName] ?? "") : "";
      },
      store: runStore, overrides, breaker, dataDir: DATA_DIR,
    });

    await bot.start();
    console.log("[probe] Discord bot connected");

    console.log(`[probe] triggering ${testAgent.name} (model ${testAgent.run.model})...`);
    const result = await orchestrator.executeRun(testAgent);
    console.log("[probe] executeRun returned:", result);

    if (result?.status === "parked") {
      console.log("[probe] waiting for your Discord reply — process stays alive until you Ctrl+C.");
      console.log("[probe] once you approve, watch for 'run resumed' below (from resumeRun's own logging) and check data/runs/ for the final result.json.");
    } else {
      console.log(`[probe] run finished immediately with status "${result?.status}" — did not park. Check the transcript in data/runs/${result?.runId}/transcript.jsonl.`);
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(`\n[probe] Configuration is invalid.\n`);
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

main();
