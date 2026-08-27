import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { DiscordBot, FakeBotTransport } from "../src/control/bot.js";
import { reconcileAndConnectBot } from "../src/control/boot-wiring.js";
import { PendingStore } from "../src/control/pending.js";
import { TaskStore } from "../src/control/task-store.js";
import type { AgentDef } from "../src/registry.js";
import { RunStore } from "../src/run-store.js";
import { BreakerStore } from "../src/state/breaker.js";

const AGENTS = [{ name: "smoke", workspace: "/ws/smoke" } as AgentDef];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-boot-wiring-"));
  const pending = new PendingStore(dataDir);
  const transport = new FakeBotTransport();
  const orchestrator = { resumeRun: vi.fn().mockResolvedValue({ status: "success" }) };
  const tasks = new TaskStore(dataDir);
  const dispatcher = { wake: vi.fn().mockResolvedValue(undefined) };
  const bot = new DiscordBot({
    transport, pending, orchestrator: orchestrator as never, agents: AGENTS,
    channelFor: () => "smoke-channel",
    store: new RunStore(dataDir), overrides: new ConfigOverridesStore(dataDir),
    breaker: new BreakerStore(dataDir), dataDir, ownerId: "owner",
    tasks, dispatcher,
  });
  return { dataDir, pending, transport, bot };
}

describe("reconcileAndConnectBot", () => {
  it("auto-denies expired entries even when the bot fails to connect, and catches/logs the connection failure without throwing", async () => {
    const { pending, transport, bot } = setup();
    const stale = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "question", question: "stale?" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    transport.startError = new Error("bad token");
    const logs: string[] = [];
    const errors: string[] = [];

    // timeoutHours: 0 means anything created before "now" (which the 5ms
    // sleep above guarantees) is already expired.
    await expect(
      reconcileAndConnectBot({
        pending, bot, timeoutHours: 0,
        log: (l) => logs.push(l), logError: (l) => errors.push(l),
      }),
    ).resolves.not.toThrow();

    // Reconciliation ran and auto-denied the stale entry regardless of the
    // connection outcome — this is the invariant a nested
    // `bot.start().then(reconcile)` would silently break.
    expect(await pending.get(stale.id)).toBeNull();
    expect(logs.some((l) => l.includes("0 awaiting"))).toBe(true);

    // The connection failure was caught and logged, not thrown or left as
    // an unhandled rejection.
    expect(errors.some((l) => l.includes("Failed to connect the Discord bot"))).toBe(true);

    // No re-posting happened, since the bot never connected.
    expect(transport.sent).toHaveLength(0);
  });

  it("re-posts still-active entries once the bot connects successfully", async () => {
    const { pending, transport, bot } = setup();
    const active = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "question", question: "which branch?" });

    await reconcileAndConnectBot({ pending, bot, timeoutHours: 24, log: () => {}, logError: () => {} });

    expect(transport.sent.some((m) => m.text.includes(active.question!))).toBe(true);
  });
});
