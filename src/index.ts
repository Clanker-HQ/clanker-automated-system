import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, loadConfig } from "./config.js";
import { ConfigOverridesStore, resolveGovernorSettings } from "./config-overrides.js";
import { DiscordBot } from "./control/bot.js";
import { reconcileAndConnectBot } from "./control/boot-wiring.js";
import { buildOutcomeVerifier } from "./control/build-outcome-verifier.js";
import { buildReflectionSynthesiser } from "./control/build-reflection-synthesiser.js";
import { buildRouter } from "./control/build-router.js";
import { buildSuccessorSuggester } from "./control/build-successor-suggester.js";
import { Dispatcher } from "./control/dispatcher.js";
import { DiscordJsTransport } from "./control/discord-transport.js";
import { RealGitPusher } from "./control/git-pusher.js";
import { GithubApiTransport } from "./control/github-api-transport.js";
import { PendingStore } from "./control/pending.js";
import { LemonSqueezyRevenueTransport } from "./control/lemonsqueezy-revenue-transport.js";
import { FakeRevenueTransport, type RevenueTransport } from "./control/revenue-transport.js";
import { StripeRevenueTransport } from "./control/stripe-revenue-transport.js";
import { TaskStore } from "./control/task-store.js";
import { WebhookReceiver } from "./control/webhook-receiver.js";
import { makeWebhookHandler } from "./control/webhook-wiring.js";
import { installCrashHandlers } from "./crash-handlers.js";
import { ValidationError } from "./errors.js";
import { Governor } from "./governor.js";
import { type Grant, loadGrants, validateGrantRefs } from "./grants.js";
import { MemoryStore } from "./memory/memory-store.js";
import { Orchestrator } from "./orchestrator.js";
import { DiscordOutbox } from "./outbox/discord.js";
import { type AgentDef, loadRegistry } from "./registry.js";
import { RunStore } from "./run-store.js";
import { buildRunner } from "./runner/build-runner.js";
import { resolveCredentials } from "./runner/credentials.js";
import { SdkRunner } from "./runner/sdk-runner.js";
import type { Runner } from "./runner/types.js";
import { ApprovedGrantsStore } from "./state/approved-grants.js";
import { BreakerStore } from "./state/breaker.js";
import { MetricsStore } from "./state/metrics-store.js";
import { RateLimitTracker } from "./state/rate-limit.js";
import { StrategyStore } from "./world/strategy.js";
import { WorldModel } from "./world/world-model.js";

const ROOT = process.env.APP_ROOT ?? process.cwd();
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new ValidationError(".env", [`${name} is required`]);
  return v;
}

/**
 * `Number(undefined)` is `NaN` and `Number("")`/`Number("smtp")` are also
 * `NaN` or nonsensical — none of that is a `ValidationError` today, so a
 * typo'd `WEBHOOK_PORT` would silently bind an OS-assigned ephemeral port
 * instead of failing boot the way every other misconfigured value does.
 */
function parsePort(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ValidationError(".env", [`${name} must be a valid port number (1-65535); received ${JSON.stringify(raw)}`]);
  }
  return n;
}

function main(): void {
  let config: Config;
  let agents: AgentDef[];
  let runner: Runner;
  let credentialMode: string | undefined;
  let botToken: string;
  let ownerId: string;
  let githubToken: string;
  let webhookSecret: string;
  let webhookPort: number;
  let github: GithubApiTransport;
  let revenue: RevenueTransport;
  let revenueMode: string;
  let dispatcher: Dispatcher | undefined;
  // Constructed inside the try block, right after `config` loads (it needs
  // nothing else) — hoisted out of its old spot further down so buildRunner,
  // just below, can pass it to SdkRunner for the overseer's setAgentEnabled
  // tool (Task C3) the same way installCrashHandlers/Orchestrator use it later.
  let outbox: DiscordOutbox;

  const tasks = new TaskStore(DATA_DIR);
  const memory = new MemoryStore(DATA_DIR);
  const world = new WorldModel(DATA_DIR);
  const strategyStore = new StrategyStore(DATA_DIR);
  // Hoisted out of their old spot further down (see `outbox` above): both
  // are plain constructors with no I/O, and SdkRunner's setAgentEnabled tool
  // (Task C3) needs them threaded through buildRunner below.
  const overrides = new ConfigOverridesStore(DATA_DIR);
  const breaker = new BreakerStore(DATA_DIR);

  try {
    config = loadConfig(join(ROOT, "config.yaml"));
    outbox = new DiscordOutbox({ config, dataDir: DATA_DIR });
    agents = loadRegistry({ agentsDir: join(ROOT, "agents"), dataDir: DATA_DIR, config });
    // Hoisted out of buildRunner's argument list so the same list can be
    // cross-checked against every agent's grantRefs: a typo there is otherwise
    // indistinguishable at runtime from "this agent has no grants", and
    // silently denies every effect the agent was configured to be allowed.
    const grants: Grant[] = loadGrants(join(ROOT, "grants.yaml"));
    validateGrantRefs(agents, grants);
    // A fine-grained PAT for the dedicated bot GitHub account, and the shared
    // secret that lets WebhookReceiver tell a genuine GitHub event apart from
    // a forged one. Resolved here, with the same boot-failure formatting as
    // every other required credential below — a missing token must fail boot
    // loudly, not surface as a crash the first time a webhook fires.
    githubToken = mustEnv("GITHUB_PR_TOKEN");
    webhookSecret = mustEnv("GITHUB_WEBHOOK_SECRET");
    webhookPort = parsePort("WEBHOOK_PORT", process.env.WEBHOOK_PORT, 8787);
    github = new GithubApiTransport({ token: githubToken });
    // Optional, not mustEnv'd: revenue is unobservable without it, but a
    // missing key must not fail boot the same way a missing GITHUB_PR_TOKEN
    // does — the metrics job simply reports $0 net income via the fake
    // until the operator's merchant-of-record account exists.
    const revenueToken = process.env.REVENUE_API_TOKEN;
    if (revenueToken) {
      // Which transport, from config, not from whichever one happened to be
      // written first: Lemon Squeezy and Stripe agree on nothing (endpoint,
      // auth headers, pagination, response shape), and runMetricsJob
      // deliberately swallows a revenue failure so one outage can't take the
      // whole snapshot down. Guessing wrong here therefore surfaces as $0
      // income forever, not as an error.
      revenue =
        config.revenue.provider === "stripe"
          ? new StripeRevenueTransport({ token: revenueToken, apiBase: process.env.REVENUE_API_BASE })
          : new LemonSqueezyRevenueTransport({ token: revenueToken, apiBase: process.env.REVENUE_API_BASE });
      revenueMode = config.revenue.provider;
    } else {
      revenue = new FakeRevenueTransport();
      revenueMode = "fake (REVENUE_API_TOKEN unset — every snapshot reports $0)";
    }
    // Optional, not mustEnv'd: an agent that can't Read files (research) just
    // loses the systemContext tool if this is missing, rather than boot
    // failing over a doc file. See docs/system-context.md itself, and the
    // tool's own doc comment in sdk-runner.ts, for why this exists.
    const systemContextPath = join(ROOT, "docs/system-context.md");
    const systemContext = existsSync(systemContextPath) ? readFileSync(systemContextPath, "utf8") : undefined;
    runner = buildRunner({
      grants, pending: new PendingStore(DATA_DIR), github,
      gitPusher: new RealGitPusher(),
      tasks,
      memory,
      memoryConfig: config.memory,
      systemContext,
      world,
      strategyStore,
      overrides,
      breaker,
      agents,
      outbox,
      // Late-bound: `dispatcher` isn't constructed until after boot's config/
      // credential validation completes (same reason `bot` below is late-bound
      // too) — but this closure is only ever CALLED much later, once a real
      // agent run actually invokes queueTask, by which point `dispatcher`
      // is always set.
      wake: async () => { if (dispatcher) await dispatcher.wake(); },
    });
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
    // The single account allowed to approve/deny/answer or run admin
    // commands. Resolved here, with the same boot-failure formatting as the
    // token above: without it the bot would accept a human decision from
    // anyone who can see the channel, which is the one thing the whole
    // tier/grant system exists to require a *specific* human for.
    ownerId = mustEnv("DISCORD_OWNER_ID");
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
  console.log(`[boot] revenue: ${revenueMode}`);

  const runStore = new RunStore(DATA_DIR);
  const metricsStore = new MetricsStore(DATA_DIR);
  const approvedGrants = new ApprovedGrantsStore(DATA_DIR);
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

  const pending = new PendingStore(DATA_DIR);

  // The orchestrator needs the bot (to announce a live park) and the bot needs
  // the orchestrator (to resume one), so one of the two references has to be
  // late-bound. The hook below is the smaller half: it is only ever called
  // from inside a running agent's event stream, long after both objects are
  // constructed, so the `if (!bot)` guard is a formality rather than a real
  // window.
  let bot: DiscordBot | undefined;

  // Installed as early as an outbox exists to alert through, so it covers
  // everything from here on — the config/credential loading above is already
  // covered by its own formatted ValidationError path.
  installCrashHandlers({ dataDir: DATA_DIR, outbox, channel: config.digest.channel });

  const orchestrator = new Orchestrator({
    runner,
    store: runStore,
    outbox,
    dataDir: DATA_DIR,
    governor,
    breaker,
    approvedGrants,
    verifier: buildOutcomeVerifier(),
    onParked: async (pendingId, kind) => {
      if (!bot) return;
      const entry = await pending.get(pendingId);
      if (!entry) return;
      if (kind === "approval") await bot.postApproval(entry);
      else await bot.postQuestion(entry);
    },
  });

  const router = buildRouter();
  dispatcher = new Dispatcher({
    tasks,
    router,
    agents,
    orchestrator,
    dataDir: DATA_DIR,
    memory,
    world,
    memoryConfig: config.memory,
    suggestSuccessors: buildSuccessorSuggester(),
    // No agent has been chosen yet at this point (a routing failure, or no
    // registered specialist at all), so there is no agent.outbox.discord to
    // report through — "ops" is this project's one configured channel,
    // matching how agents/pr-reviewer already uses it.
    // Wrapped in an async function with a bare await (rather than returning
    // outbox.postAlert(...) directly): postAlert resolves to
    // "delivered" | "undelivered", not void, and DispatcherDeps.notify's
    // type is `(text: string) => Promise<void>` — the wrapper's inferred
    // Promise<void> return type is what actually satisfies it.
    notify: async (text) => {
      await outbox.postAlert("ops", text);
    },
  });

  // Reconcile any pending approval/question entries left over from before
  // this process started (e.g. a restart while a run was parked), and
  // connect the Discord bot. reconcileAndConnectBot runs reconciliation
  // unconditionally — independent of whether the bot manages to connect —
  // and only re-posts still-active entries once a connection succeeds.
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
    tasks, dispatcher, governor,
  });

  void reconcileAndConnectBot({ pending, bot, timeoutHours: config.governor.pendingTimeoutHours });

  void tasks.reconcile().then(({ reset }) => {
    if (reset.length > 0) {
      console.log(`[tasks] ${reset.length} task(s) reset from "running" to "pending" after restart`);
    }
    dispatcher.start();
    void dispatcher.wake();
  });

  const webhookReceiver = new WebhookReceiver({ secret: webhookSecret });
  webhookReceiver.onEvent(makeWebhookHandler({ agents, github, orchestrator }));
  void webhookReceiver.listen(webhookPort).then(
    () => {
      console.log(`[boot] webhook receiver listening on :${webhookPort}`);
    },
    (error: unknown) => {
      // Matches reconcileAndConnectBot's posture just above (log and carry
      // on, don't crash the process): a failed bind here means PR-review
      // webhooks won't arrive, but cron-triggered agents and the Discord
      // bot are unaffected and shouldn't go down with it.
      console.error(`\n[boot] Failed to start the webhook receiver on port ${webhookPort}. No PR review webhooks will be received.\n`);
      console.error(error instanceof Error ? error.message : String(error));
    },
  );

  if (config.digest.enabled) {
    void import("./triggers/digest.js")
      .then(({ startDigest }) => {
        startDigest({
          schedule: config.digest.schedule,
          timezone: config.digest.timezone,
          channel: config.digest.channel,
          store: runStore,
          tasks,
          outbox,
          memory,
          memoryConfig: config.memory,
          metricsStore,
        });
      })
      .catch((error: unknown) => {
        console.error("[boot] failed to start the daily digest", error);
      });
  }

  if (config.retention.enabled) {
    void import("./triggers/retention.js")
      .then(({ startRetention }) => {
        startRetention({
          schedule: config.retention.schedule,
          timezone: config.retention.timezone,
          dataDir: DATA_DIR,
          days: config.retention.days,
          channel: config.retention.channel,
          outbox,
          memory,
          memoryConfig: config.memory,
        });
      })
      .catch((error: unknown) => {
        console.error("[boot] failed to start the data-retention schedule", error);
      });
  }

  // Gated on memory.enabled, the same flag that gates successor proposals and
  // retention's memory pruning above — a reflection pass has nothing to
  // synthesise from, and nowhere useful to write its output, when memory
  // itself is off.
  if (config.memory.enabled) {
    void import("./triggers/reflection.js")
      .then(({ startReflection }) => {
        startReflection({
          schedule: config.memory.reflectionSchedule,
          timezone: config.memory.reflectionTimezone,
          windowDays: config.memory.reflectionWindowDays,
          memory,
          runStore,
          synthesise: buildReflectionSynthesiser(),
        });
      })
      .catch((error: unknown) => {
        console.error("[boot] failed to start the reflection schedule", error);
      });
  }

  if (config.metrics.enabled) {
    void import("./triggers/metrics.js")
      .then(({ startMetrics }) => {
        startMetrics({
          schedule: config.metrics.schedule,
          timezone: config.metrics.timezone,
          windowDays: config.metrics.windowDays,
          runStore,
          taskStore: tasks,
          memory,
          revenue,
          // The same store `!disable` writes to, so an agent the metrics job
          // puts on probation is cleared by `!enable` like any other.
          overrides,
          metricsStore,
        });
      })
      .catch((error: unknown) => {
        console.error("[boot] failed to start the metrics schedule", error);
      });
  }

  // Gated on the agent's own `enabled` field (agents/overseer/agent.yaml),
  // the same flag startCron's generic loop already checks for every other
  // cron agent — there is no separate config.overseer.enabled, since the
  // agent definition already carries this switch.
  const overseerAgent = agents.find((a) => a.name === "overseer");
  if (overseerAgent?.enabled) {
    void import("./triggers/overseer.js")
      .then(({ startOverseer }) => {
        startOverseer({
          agent: overseerAgent,
          orchestrator,
          strategyStore,
          world,
          metricsStore,
          revenue,
          goalsPath: join(ROOT, "goals.yaml"),
        });
      })
      .catch((error: unknown) => {
        console.error("[boot] failed to start the overseer schedule", error);
      });
  }

  // Imported lazily so a boot failure above never starts a schedule. The
  // overseer is excluded here even though its own agent.yaml also declares
  // trigger.type: cron: it is scheduled separately just above, through a
  // bespoke trigger that grades the previous cycle's expectations and reads
  // goals.yaml before the run starts (Task C3). Scheduling it again here
  // too would fire it a second time on the same tick — once with that rich
  // context, once with only the generic world-model summary this loop
  // passes to every other cron agent — silently writing two different
  // Strategy documents for one cycle and corrupting the grading this whole
  // plan is built on.
  void import("./triggers/cron.js")
    .then(({ startCron }) => {
      startCron(agents.filter((a) => a.name !== "overseer"), orchestrator, world);
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
