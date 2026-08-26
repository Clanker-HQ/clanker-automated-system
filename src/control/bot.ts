import { join } from "node:path";
import type { PendingEntry } from "./pending.js";
import type { PendingStore } from "./pending.js";
import type { AgentDef } from "../registry.js";
import type { ConfigOverridesStore } from "../config-overrides.js";
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
  resumeRun(entry: PendingEntry, decision: { approved: boolean } | { answer: string }, agent: AgentDef): Promise<unknown>;
}

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

  constructor(opts: {
    transport: BotTransport; pending: PendingStore; orchestrator: ResumeCapableOrchestrator;
    agents: AgentDef[]; channelFor: (agentName: string) => string;
    store: RunStore; overrides: ConfigOverridesStore; breaker: BreakerStore; dataDir: string;
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

      // Never let a failed resolve/resume become an unhandled rejection: a real
      // EventEmitter-based transport (Task 15) won't await this listener, so a
      // thrown/rejected promise here would otherwise risk crashing the process
      // and would definitely stop this handler from processing future messages.
      try {
        await this.pending.resolve(id);

        if (approve) {
          await this.orchestrator.resumeRun(entry, { approved: true }, agent);
        } else if (deny) {
          await this.orchestrator.resumeRun(entry, { approved: false }, agent);
        } else if (answer) {
          await this.orchestrator.resumeRun(entry, { answer: answer[2]!.trim() }, agent);
        }
      } catch (error) {
        console.error(`[bot] failed to resolve/resume pending entry ${id}:`, error);
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
        await this.overrides.set("quietHours", { from: match[1]!, to: match[2]!, timezone: match[3]! }, "discord");
        return void reply(`🌙 Quiet hours set to ${match[1]}-${match[2]} ${match[3]}.`);
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
