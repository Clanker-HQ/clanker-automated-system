import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { RunResult } from "../run-store.js";

const DISCORD_LIMIT = 2000;

const ICON: Record<string, string> = {
  success: "✅", failed: "❌", timeout: "⏱️",
  "budget-exceeded": "💸", killed: "🛑", interrupted: "⚠️",
  parked: "⏸️", question: "❓", denied: "🚫",
};

export function formatRunMessage(result: RunResult, tail?: string[]): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const header =
    `${ICON[result.status] ?? "•"} **${result.agent}** — ${result.status}\n` +
    `\`${result.runId}\`\n` +
    // "tool calls", not "turns": the count is derived from tool_use events so
    // that the real and fake runners stay consistent. The SDK's own num_turns
    // is deliberately not read.
    `${result.turns} tool calls · ${seconds}s · $${result.costUsd.toFixed(4)} · ` +
    `${result.inputTokens}in/${result.outputTokens}out\n`;

  const body = result.summary ? `\n${result.summary}\n` : "";
  const failureDetail = result.error ? `\n**Error:** ${result.error}\n` : "";
  // Only surfaced when the verdict is NOT "achieved" — an "achieved" grading
  // on every single successful run would just be noise on top of the ✅ this
  // message already carries. "not-achieved"/"unclear" are the actionable
  // cases this feature exists to catch: a run that finished clean but didn't
  // do what it was asked.
  const verificationDetail =
    result.verifiedOutcome && result.verifiedOutcome.verdict !== "achieved"
      ? `\n⚠️ **Verification: ${result.verifiedOutcome.verdict}** — ${result.verifiedOutcome.reason}\n`
      : "";

  let message = header + body + failureDetail + verificationDetail;

  // A "not-achieved" verdict gets the same debugging aid a real failure
  // does — the tail is exactly what a human needs to see WHY the objective
  // wasn't met. "unclear" doesn't: it's a weaker signal (the grader couldn't
  // tell), not a confirmed miss worth the extra message length.
  const showTail = result.status !== "success" || result.verifiedOutcome?.verdict === "not-achieved";
  if (tail && tail.length > 0 && showTail) {
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
    return this.deliver(channelKey, formatRunMessage(result, tail), result.runId);
  }

  async postAlert(channelKey: string, text: string): Promise<"delivered" | "undelivered"> {
    return this.deliver(channelKey, text, `alert-${Date.now()}`);
  }

  private async deliver(
    channelKey: string,
    content: string,
    undeliveredFileStem: string,
  ): Promise<"delivered" | "undelivered"> {
    const url = this.webhookFor(channelKey);

    // `formatRunMessage` already truncates the `.post()` path to
    // DISCORD_LIMIT, so this is a no-op there — but `postAlert` callers
    // (digest.ts, retention.ts, index.ts's summary alert, sdk-runner.ts's
    // governance-gate alert) hand this raw, unbounded text. Discovered
    // 2026-09-11: 23 "ops"-channel alerts over 9 days silently landed in
    // data/undelivered/ with "HTTP 400 Bad Request" — every one of them
    // 2014-2966 characters, just over Discord's hard 2000-character message
    // cap, because nothing truncated a postAlert call before it reached
    // fetch. A dropped alert defeats the after-the-fact visibility this
    // pipeline's whole safety model (CLAUDE.md, and now the governance
    // gate's own merge alert) depends on in place of a human approval click.
    content = content.length > DISCORD_LIMIT ? content.slice(0, DISCORD_LIMIT - 3) + "..." : content;

    // Why the last attempt failed, so the undelivered file says what went
    // wrong instead of leaving the owner to guess. The webhook URL is a
    // secret and is never recorded — only the status code or error message.
    let failure = "no delivery attempt was made";

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content,
            // `content` embeds agent-authored text: without this a summary
            // containing "@everyone" would ping the whole server.
            allowed_mentions: { parse: [] },
          }),
        });
        if (response.ok) return "delivered";
        failure = `Discord rejected the webhook with HTTP ${response.status} ${response.statusText}`.trim();
      } catch (error) {
        failure = `request failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (attempt < 3) await this.sleep(attempt * 1000);
    }

    const dir = join(this.dataDir, "undelivered");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${undeliveredFileStem}.json`),
      JSON.stringify(
        { channelKey, error: `after 3 attempts: ${failure}`, content },
        null,
        2,
      ) + "\n",
    );
    return "undelivered";
  }
}
