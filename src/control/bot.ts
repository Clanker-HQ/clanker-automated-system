import type { PendingEntry } from "./pending.js";
import type { PendingStore } from "./pending.js";
import type { AgentDef } from "../registry.js";

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
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(channelId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ channelId, text });
    return { messageId: `fake-${this.sent.length}` };
  }

  async start(): Promise<void> {}
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

  constructor(opts: {
    transport: BotTransport; pending: PendingStore; orchestrator: ResumeCapableOrchestrator;
    agents: AgentDef[]; channelFor: (agentName: string) => string;
  }) {
    this.transport = opts.transport;
    this.pending = opts.pending;
    this.orchestrator = opts.orchestrator;
    this.agents = opts.agents;
    this.channelFor = opts.channelFor;
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
}
