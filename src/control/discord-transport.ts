import { Client, GatewayIntentBits, Partials } from "discord.js";
import type { BotTransport, IncomingMessage } from "./bot.js";

/**
 * The only file importing discord.js, mirroring src/runner/sdk-runner.ts's
 * role as the only file importing the Agent SDK. A gateway connection
 * (persistent outbound websocket) rather than Discord's interactions/slash-
 * command model — the latter needs a public HTTPS endpoint, which this
 * system does not have on local Docker Desktop and gains no benefit from on
 * a VPS either.
 */
export class DiscordJsTransport implements BotTransport {
  private readonly client: Client;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  constructor(private readonly opts: { token: string }) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(channelId: string, text: string): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new Error(`Discord channel ${channelId} is not a sendable text channel`);
    }
    const message = await channel.send(text);
    return { messageId: message.id };
  }

  async start(): Promise<void> {
    this.client.on("messageCreate", (message) => {
      if (message.author.bot) return;
      if (!this.handler) return;
      void this.handler({ channelId: message.channelId, authorId: message.author.id, content: message.content });
    });
    await this.client.login(this.opts.token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
