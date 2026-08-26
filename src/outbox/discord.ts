import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { RunResult } from "../run-store.js";

const DISCORD_LIMIT = 2000;

const ICON: Record<string, string> = {
  success: "✅", failed: "❌", timeout: "⏱️",
  "budget-exceeded": "💸", killed: "🛑", interrupted: "⚠️",
};

export function formatRunMessage(result: RunResult, tail?: string[]): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const header =
    `${ICON[result.status] ?? "•"} **${result.agent}** — ${result.status}\n` +
    `\`${result.runId}\`\n` +
    `${result.turns} turns · ${seconds}s · $${result.costUsd.toFixed(4)} · ` +
    `${result.inputTokens}in/${result.outputTokens}out\n`;

  const body = result.summary ? `\n${result.summary}\n` : "";
  const failureDetail = result.error ? `\n**Error:** ${result.error}\n` : "";

  let message = header + body + failureDetail;

  if (tail && tail.length > 0 && result.status !== "success") {
    const budget = DISCORD_LIMIT - message.length - 20;
    let block = "";
    for (const line of tail.slice(-20)) {
      if (block.length + line.length + 1 > budget) break;
      block += line + "\n";
    }
    if (block) message += "```\n" + block + "```";
  }

  return message.length > DISCORD_LIMIT
    ? message.slice(0, DISCORD_LIMIT - 3) + "..."
    : message;
}

export class DiscordOutbox {
  private readonly config: Config;
  private readonly dataDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: {
    config: Config;
    dataDir: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.config = opts.config;
    this.dataDir = opts.dataDir;
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private webhookFor(channelKey: string): string {
    const varName = this.config.discord.channels[channelKey];
    if (!varName) {
      throw new Error(
        `Discord channel "${channelKey}" is not defined in config.yaml. ` +
          `Known channels: ${Object.keys(this.config.discord.channels).join(", ") || "(none)"}`,
      );
    }
    const url = this.env[varName];
    if (!url) {
      throw new Error(`Environment variable ${varName} is unset. Add it to .env`);
    }
    return url;
  }

  async post(
    channelKey: string,
    result: RunResult,
    tail?: string[],
  ): Promise<"delivered" | "undelivered"> {
    const url = this.webhookFor(channelKey);
    const content = formatRunMessage(result, tail);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (response.ok) return "delivered";
      } catch {
        // fall through to retry
      }
      if (attempt < 3) await this.sleep(attempt * 1000);
    }

    const dir = join(this.dataDir, "undelivered");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${result.runId}.json`),
      JSON.stringify({ channelKey, content, result }, null, 2) + "\n",
    );
    return "undelivered";
  }
}
