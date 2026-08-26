import { join } from "node:path";
import { type Config, loadConfig } from "./config.js";
import { ConfigOverridesStore, resolveGovernorSettings } from "./config-overrides.js";
import { DiscordBot } from "./control/bot.js";
import { reconcileAndConnectBot } from "./control/boot-wiring.js";
import { DiscordJsTransport } from "./control/discord-transport.js";
import { PendingStore } from "./control/pending.js";
import { ValidationError } from "./errors.js";
import { Governor } from "./governor.js";
import { loadGrants } from "./grants.js";
import { Orchestrator } from "./orchestrator.js";
import { DiscordOutbox } from "./outbox/discord.js";
import { type AgentDef, loadRegistry } from "./registry.js";
import { RunStore } from "./run-store.js";
import { buildRunner } from "./runner/build-runner.js";
import { resolveCredentials } from "./runner/credentials.js";
import { SdkRunner } from "./runner/sdk-runner.js";
import type { Runner } from "./runner/types.js";
import { BreakerStore } from "./state/breaker.js";
import { RateLimitTracker } from "./state/rate-limit.js";

const ROOT = process.env.APP_ROOT ?? process.cwd();
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new ValidationError(".env", [`${name} is required`]);
  return v;
}

function main(): void {
  let config: Config;
  let agents: AgentDef[];
  let runner: Runner;
  let credentialMode: string | undefined;
  let botToken: string;

  try {
    config = loadConfig(join(ROOT, "config.yaml"));
    agents = loadRegistry({ agentsDir: join(ROOT, "agents"), dataDir: DATA_DIR, config });
    runner = buildRunner({ grants: loadGrants(join(ROOT, "grants.yaml")), pending: new PendingStore(DATA_DIR) });
    if (runner instanceof SdkRunner) {
      // Resolved once, here, rather than only inside SdkRunner.execute: that
      // body does not run until the orchestrator's first next(), so a missing
      // or refused credential would otherwise surface as a *failed run* at the
      // first cron fire — recorded and posted to Discord — instead of as a
      // boot failure. All configuration is validated at boot.
      credentialMode = resolveCredentials().mode;
    }
    // Same reasoning as credentialMode above: resolved here, inside the
    // formatted boot-failure path, rather than only when DiscordJsTransport
    // is constructed below — a missing token must fail boot the same way a
    // missing config.yaml or grants.yaml does, not crash with a raw stack.
    botToken = mustEnv("DISCORD_BOT_TOKEN");
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(`\n[boot] Configuration is invalid. Nothing was started.\n`);
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  console.log(`[boot] ${agents.length} agent(s) loaded: ${agents.map((a) => a.name).join(", ")}`);
  if (credentialMode) console.log(`[boot] credentials: ${credentialMode}`);

  const runStore = new RunStore(DATA_DIR);
  const overrides = new ConfigOverridesStore(DATA_DIR);
  const breaker = new BreakerStore(DATA_DIR);
  const governor = new Governor({
    dataDir: DATA_DIR, config, store: runStore, overrides,
    rateLimits: new RateLimitTracker(DATA_DIR), breaker,
  });

  void overrides.read().then((o) => {
    const settings = resolveGovernorSettings(config, o);
    console.log(
      `[boot] governor live: maxConcurrent=${settings.maxConcurrent} dailyBudgetUsd=${settings.dailyBudgetUsd} ` +
        `quietHours=${settings.quietHours ? `${settings.quietHours.from}-${settings.quietHours.to} ${settings.quietHours.timezone}` : "off"}`,
    );
  });

  const orchestrator = new Orchestrator({
    runner,
    store: runStore,
    outbox: new DiscordOutbox({ config, dataDir: DATA_DIR }),
    dataDir: DATA_DIR,
    governor,
  });

  // Reconcile any pending approval/question entries left over from before
  // this process started (e.g. a restart while a run was parked), and
  // connect the Discord bot. reconcileAndConnectBot runs reconciliation
  // unconditionally — independent of whether the bot manages to connect —
  // and only re-posts still-active entries once a connection succeeds.
  const pending = new PendingStore(DATA_DIR);

  const bot = new DiscordBot({
    transport: new DiscordJsTransport({ token: botToken }),
    pending, orchestrator, agents,
    channelFor: (agentName) => {
      const agentDef = agents.find((a) => a.name === agentName);
      const key = agentDef?.outbox.discord ?? "";
      const varName = config.discord.botChannels[key];
      return varName ? (process.env[varName] ?? "") : "";
    },
    store: runStore, overrides, breaker, dataDir: DATA_DIR,
  });

  void reconcileAndConnectBot({ pending, bot, timeoutHours: config.governor.pendingTimeoutHours });

  // Imported lazily so a boot failure above never starts a schedule.
  void import("./triggers/cron.js")
    .then(({ startCron }) => {
      startCron(agents, orchestrator);
      console.log("[boot] supervisor running");
    })
    .catch((error: unknown) => {
      // Every other boot failure on this path is formatted; an import or
      // scheduling failure must not be the one that prints a bare stack trace.
      console.error(`\n[boot] Failed to start the schedule. Nothing is running.\n`);
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

main();
