import { join } from "node:path";
import type { PendingEntry } from "./pending.js";
import type { PendingStore } from "./pending.js";
import type { AgentDef } from "../registry.js";
import { QuietHoursSchema } from "../config.js";
import type { ConfigOverridesStore } from "../config-overrides.js";
import { formatZodError } from "../errors.js";
import type { RunStore } from "../run-store.js";
import type { BreakerStore } from "../state/breaker.js";

export interface IncomingMessage {
  channelId: string;
  authorId: string;
  content: string;
}

export interface BotTransport {
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  send(channelId: string, text: string): Promise<{ messageId: string }>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Test double: records everything sent, and lets a test inject an incoming message without a real Discord connection. */
export class FakeBotTransport implements BotTransport {
  sent: { channelId: string; text: string }[] = [];
  /** Set by a test to make the next start() reject, simulating a failed Discord connection (bad token, network drop, outage). */
  startError: Error | null = null;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(channelId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ channelId, text });
    return { messageId: `fake-${this.sent.length}` };
  }

  async start(): Promise<void> {
    if (this.startError) throw this.startError;
  }
  async stop(): Promise<void> {}

  async simulateMessage(msg: IncomingMessage): Promise<void> {
    if (this.handler) await this.handler(msg);
  }
}

interface ResumeCapableOrchestrator {
  /** Resolves to `undefined` when the resume was refused and never ran (governor refusal, or a pending entry with no session to continue). */
  resumeRun(entry: PendingEntry, decision: { approved: boolean } | { answer: string }, agent: AgentDef): Promise<unknown>;
}

const RESUME_REFUSED =
  "the pending entry is still open, so you can try again later.";

export class DiscordBot {
  private readonly transport: BotTransport;
  private readonly pending: PendingStore;
  private readonly orchestrator: ResumeCapableOrchestrator;
  private readonly agents: AgentDef[];
  private readonly channelFor: (agentName: string) => string;
  private readonly store: RunStore;
  private readonly overrides: ConfigOverridesStore;
  private readonly breaker: BreakerStore;
  private readonly dataDir: string;
  private readonly ownerId: string;
  /** Pending ids currently mid-resume, so a repeated `approve <id>` cannot start a second resume of the same entry while the first is still running. */
  private readonly resuming = new Set<string>();

  constructor(opts: {
    transport: BotTransport; pending: PendingStore; orchestrator: ResumeCapableOrchestrator;
    agents: AgentDef[]; channelFor: (agentName: string) => string;
    store: RunStore; overrides: ConfigOverridesStore; breaker: BreakerStore; dataDir: string;
    /** The one Discord user id allowed to approve/deny/answer or run any `!` admin command. */
    ownerId: string;
  }) {
    this.transport = opts.transport;
    this.pending = opts.pending;
    this.orchestrator = opts.orchestrator;
    this.agents = opts.agents;
    this.channelFor = opts.channelFor;
    this.store = opts.store;
    this.overrides = opts.overrides;
    this.breaker = opts.breaker;
    this.dataDir = opts.dataDir;
    this.ownerId = opts.ownerId;
  }

  async postApproval(entry: PendingEntry): Promise<void> {
    await this.transport.send(
      this.channelFor(entry.agentName),
      `🔔 **${entry.agentName}** wants to: ${entry.effect}\nGrant: \`${entry.grantRef}\`\n\nReply \`approve ${entry.id}\` or \`deny ${entry.id}\`.`,
    );
  }

  async postQuestion(entry: PendingEntry): Promise<void> {
    await this.transport.send(
      this.channelFor(entry.agentName),
      `❓ **${entry.agentName}** asks: ${entry.question}\n\nReply \`answer ${entry.id} <your answer>\`.`,
    );
  }

  async start(): Promise<void> {
    this.transport.onMessage(async (msg) => {
      // The single authorization gate for the whole control surface. Every
      // admin command and — far more importantly — every approve/deny/answer
      // is the human decision the tier/grant system exists to require, so
      // anyone who can see the channel must not be able to supply it.
      // Deliberately silent: replying "unauthorized" would confirm to a prober
      // that they had reached the bot, and would let them binary-search for
      // the owner id. An unauthorized message is treated exactly like an
      // unrecognised one — nothing happens.
      if (msg.authorId !== this.ownerId) return;

      if (msg.content.startsWith("!")) return this.handleCommand(msg);

      const approve = msg.content.match(/^approve\s+(\S+)/i);
      const deny = msg.content.match(/^deny\s+(\S+)/i);
      const answer = msg.content.match(/^answer\s+(\S+)\s+([\s\S]+)/i);

      const id = approve?.[1] ?? deny?.[1] ?? answer?.[1];
      if (!id) return;

      const entry = await this.pending.get(id);
      if (!entry) return;

      // Guard against a command that doesn't match the entry's kind (e.g. "approve"
      // on a question entry, which has no grantRef/effect to approve). Not a crash
      // either way — Orchestrator.resumeRun only branches on "approved" in decision —
      // but resuming it would be semantically wrong, so we ignore the mismatched command.
      if ((approve || deny) && entry.kind !== "approval") return;
      if (answer && entry.kind !== "question") return;

      const agent = this.agents.find((a) => a.name === entry.agentName);
      if (!agent) return;

      // A resume can be refused (STOP file, quiet hours, daily budget, a
      // rate-limit rejection, or an entry with no session to continue), in
      // which case resumeRun returns undefined and nothing ran. Resolving the
      // entry *first* used to destroy it — sessionId and all — on exactly
      // those occasions, with no feedback to the operator. So: resume first,
      // resolve only once the resume was actually attempted, and say so in the
      // channel when it wasn't.
      //
      // Never let a failed resolve/resume become an unhandled rejection: a real
      // EventEmitter-based transport (Task 15) won't await this listener, so a
      // thrown/rejected promise here would otherwise risk crashing the process
      // and would definitely stop this handler from processing future messages.
      if (this.resuming.has(id)) return;
      this.resuming.add(id);
      try {
        let outcome: unknown;
        if (approve) {
          outcome = await this.orchestrator.resumeRun(entry, { approved: true }, agent);
        } else if (deny) {
          outcome = await this.orchestrator.resumeRun(entry, { approved: false }, agent);
        } else if (answer) {
          outcome = await this.orchestrator.resumeRun(entry, { answer: answer[2]!.trim() }, agent);
        }

        if (outcome === undefined) {
          await this.transport.send(
            msg.channelId,
            `⚠️ Resume of \`${id}\` was refused — check the governor (quiet hours, daily budget, the STOP file, ` +
              `a rate-limit rejection) or the run's session id. Nothing ran and ${RESUME_REFUSED}`,
          );
          return;
        }

        await this.pending.resolve(id);
      } catch (error) {
        console.error(`[bot] failed to resolve/resume pending entry ${id}:`, error);
      } finally {
        this.resuming.delete(id);
      }
    });
    await this.transport.start();
  }

  private async handleCommand(msg: IncomingMessage): Promise<void> {
    const [command, ...rest] = msg.content.trim().split(/\s+/);
    const arg = rest.join(" ");
    const reply = (text: string) => this.transport.send(msg.channelId, text);

    switch (command) {
      case "!stop": {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(join(this.dataDir, "STOP"), "");
        return void reply("🛑 STOP file set. No new runs until `!resume`.");
      }
      case "!resume": {
        const { rmSync } = await import("node:fs");
        rmSync(join(this.dataDir, "STOP"), { force: true });
        return void reply("▶️ STOP file cleared. Runs resume on the next trigger.");
      }
      case "!disable": {
        if (!arg.trim()) return void reply("Usage: `!disable <agent-name>`");
        const overrides = await this.overrides.read();
        const disabled = new Set(overrides.disabledAgents ?? []);
        disabled.add(arg);
        await this.overrides.set("disabledAgents", [...disabled], "discord");
        return void reply(`⏸️ ${arg} disabled.`);
      }
      case "!enable": {
        if (!arg.trim()) return void reply("Usage: `!enable <agent-name>`");
        const overrides = await this.overrides.read();
        const disabled = new Set(overrides.disabledAgents ?? []);
        disabled.delete(arg);
        await this.overrides.set("disabledAgents", [...disabled], "discord");
        await this.breaker.reset(arg);
        return void reply(`▶️ ${arg} enabled.`);
      }
      case "!budget": {
        const value = Number(arg);
        if (!Number.isFinite(value) || value <= 0) return void reply(`Not a valid budget: "${arg}"`);
        await this.overrides.set("dailyBudgetUsd", value, "discord");
        return void reply(`💰 Daily budget set to $${value}.`);
      }
      case "!concurrency": {
        const value = Number(arg);
        if (!Number.isInteger(value) || value <= 0) return void reply(`Not a valid concurrency: "${arg}"`);
        await this.overrides.set("maxConcurrent", value, "discord");
        return void reply(`🔀 Concurrency set to ${value}.`);
      }
      case "!quiet": {
        if (arg === "off") {
          await this.overrides.set("quietHours", null, "discord");
          return void reply("🔕 Quiet hours disabled.");
        }
        const match = arg.match(/^(\d\d:\d\d)-(\d\d:\d\d)\s+(\S+)$/);
        if (!match) return void reply('Usage: `!quiet HH:MM-HH:MM Area/City` or `!quiet off`');
        // The regex above only proves the *shape*: it accepts "99:99" and any
        // non-whitespace string as a timezone. An unusable timezone written
        // into the overrides makes Governor.admit's Intl.DateTimeFormat throw
        // a RangeError on every admission check, for every agent, until
        // someone hand-edits the file — so it is validated against the very
        // same schema config.yaml's own governor.quietHours must satisfy.
        const parsed = QuietHoursSchema.safeParse({ from: match[1]!, to: match[2]!, timezone: match[3]! });
        if (!parsed.success) {
          const problems = formatZodError("!quiet", parsed.error).lines.join("\n• ");
          return void reply(`❌ Quiet hours not changed:\n• ${problems}`);
        }
        await this.overrides.set("quietHours", parsed.data, "discord");
        return void reply(`🌙 Quiet hours set to ${parsed.data.from}-${parsed.data.to} ${parsed.data.timezone}.`);
      }
      case "!runs": {
        const recent = await this.store.listRecent(20);
        const lines = recent.map((r) => `${r.runId} — ${r.status} — $${r.costUsd.toFixed(4)}`);
        return void reply(lines.length > 0 ? lines.join("\n") : "No runs yet.");
      }
      default:
        return void reply(`Unknown command: ${command}`);
    }
  }
}
