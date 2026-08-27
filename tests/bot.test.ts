import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DiscordBot, FakeBotTransport } from "../src/control/bot.js";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { PendingStore } from "../src/control/pending.js";
import type { AgentDef } from "../src/registry.js";
import { RunStore } from "../src/run-store.js";
import { BreakerStore } from "../src/state/breaker.js";

const AGENTS = [{ name: "smoke", workspace: "/ws/smoke" } as AgentDef];

/** Every `simulateMessage` below sends as this author; anything else must be ignored. */
const OWNER = "owner";

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-bot-"));
  const pending = new PendingStore(dataDir);
  const transport = new FakeBotTransport();
  const orchestrator = { resumeRun: vi.fn().mockResolvedValue({ status: "success" }) };
  const store = new RunStore(dataDir);
  const overrides = new ConfigOverridesStore(dataDir);
  const breaker = new BreakerStore(dataDir);
  const bot = new DiscordBot({
    transport, pending, orchestrator: orchestrator as never, agents: AGENTS,
    channelFor: () => "smoke-channel",
    store, overrides, breaker, dataDir, ownerId: OWNER,
  });
  return { dataDir, pending, transport, orchestrator, bot, store, overrides, breaker };
}

describe("DiscordBot", () => {
  it("posts an approval prompt naming the agent, the effect, and the grant", async () => {
    const { pending, transport, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "fetch https://httpbin.org/post", grantRef: "test-echo" });
    await bot.postApproval(entry);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.channelId).toBe("smoke-channel");
    expect(transport.sent[0]!.text).toContain("smoke");
    expect(transport.sent[0]!.text).toContain("fetch https://httpbin.org/post");
    expect(transport.sent[0]!.text).toContain("test-echo");
    expect(transport.sent[0]!.text).toContain(entry.id);
  });

  it("posts a question prompt with the agent's question text", async () => {
    const { pending, transport, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "question", question: "Which branch?" });
    await bot.postQuestion(entry);
    expect(transport.sent[0]!.text).toContain("Which branch?");
  });

  it("a reply of 'approve <id>' resolves the pending entry and resumes with approved: true", async () => {
    const { pending, transport, orchestrator, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    await bot.start();

    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `approve ${entry.id}` });

    expect(orchestrator.resumeRun).toHaveBeenCalledWith(entry, { approved: true }, AGENTS[0]);
    expect(await pending.get(entry.id)).toBeNull();
  });

  it("a reply of 'deny <id>' resumes with approved: false", async () => {
    const { pending, transport, orchestrator, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `deny ${entry.id}` });
    expect(orchestrator.resumeRun).toHaveBeenCalledWith(entry, { approved: false }, AGENTS[0]);
  });

  it("a reply of 'answer <id> <text>' resumes a question with that free text", async () => {
    const { pending, transport, orchestrator, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "question", question: "Which branch?" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `answer ${entry.id} use main` });
    expect(orchestrator.resumeRun).toHaveBeenCalledWith(entry, { answer: "use main" }, AGENTS[0]);
  });

  it("ignores a message that doesn't reference a known pending id", async () => {
    const { transport, orchestrator, bot } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "approve not-a-real-id" });
    expect(orchestrator.resumeRun).not.toHaveBeenCalled();
  });

  it("ignores a plain, unrelated message without erroring", async () => {
    const { transport, orchestrator, bot } = setup();
    await bot.start();
    await expect(transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "just chatting" })).resolves.not.toThrow();
    expect(orchestrator.resumeRun).not.toHaveBeenCalled();
  });

  it("ignores 'approve <id>' when the entry is a question, not an approval", async () => {
    const { pending, transport, orchestrator, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "question", question: "Which branch?" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `approve ${entry.id}` });
    expect(orchestrator.resumeRun).not.toHaveBeenCalled();
    expect(await pending.get(entry.id)).not.toBeNull();
  });

  it("ignores 'answer <id> <text>' when the entry is an approval, not a question", async () => {
    const { pending, transport, orchestrator, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `answer ${entry.id} use main` });
    expect(orchestrator.resumeRun).not.toHaveBeenCalled();
    expect(await pending.get(entry.id)).not.toBeNull();
  });

  it("does not throw or reject when resumeRun fails, so the handler survives for future messages", async () => {
    const { pending, transport, orchestrator, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    orchestrator.resumeRun.mockRejectedValueOnce(new Error("downstream failure"));
    await bot.start();

    await expect(
      transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `approve ${entry.id}` }),
    ).resolves.not.toThrow();
    expect(orchestrator.resumeRun).toHaveBeenCalledWith(entry, { approved: true }, AGENTS[0]);

    // The handler should still work for a subsequent message after the failure.
    const entry2 = await pending.create({ runId: "r2", agentName: "smoke", sessionId: "s2", kind: "approval", effect: "y", grantRef: "g2" });
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `approve ${entry2.id}` });
    expect(orchestrator.resumeRun).toHaveBeenCalledWith(entry2, { approved: true }, AGENTS[0]);
  });

  it("!budget <n> updates the override and echoes the new value", async () => {
    const { transport, bot } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!budget 25" });
    expect(transport.sent.some((m) => m.text.includes("25"))).toBe(true);
  });

  it("!quiet off disables quiet hours", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!quiet off" });
    expect((await overrides.read()).quietHours).toBeNull();
  });

  it("!stop creates the STOP file; !resume removes it", async () => {
    const { transport, bot, dataDir } = setup();
    await bot.start();
    const { existsSync } = await import("node:fs");
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!stop" });
    expect(existsSync(join(dataDir, "STOP"))).toBe(true);
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!resume" });
    expect(existsSync(join(dataDir, "STOP"))).toBe(false);
  });

  it("!disable <agent> and !enable <agent> update disabledAgents", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!disable smoke" });
    expect((await overrides.read()).disabledAgents).toEqual(["smoke"]);
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!enable smoke" });
    expect((await overrides.read()).disabledAgents ?? []).toEqual([]);
  });

  it("!disable with no argument replies with a usage error and does not mutate disabledAgents", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!disable" });
    expect(transport.sent.some((m) => m.text.includes("Usage"))).toBe(true);
    expect((await overrides.read()).disabledAgents).toBeUndefined();
  });

  it("!enable with no argument replies with a usage error and does not mutate disabledAgents", async () => {
    const { transport, bot, overrides } = setup();
    await overrides.set("disabledAgents", ["smoke"], "test");
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!enable" });
    expect(transport.sent.some((m) => m.text.includes("Usage"))).toBe(true);
    expect((await overrides.read()).disabledAgents).toEqual(["smoke"]);
  });

  // Critical: approve/deny/answer IS the human decision the whole tier/grant
  // system exists to require. Anyone who can see the channel must not be able
  // to supply it, or to run an admin command.
  it("ignores every message from an author other than the configured owner, silently", async () => {
    const { pending, transport, orchestrator, bot, overrides, dataDir } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    await bot.start();

    const intruder = { channelId: "smoke-channel", authorId: "someone-else" };
    await transport.simulateMessage({ ...intruder, content: `approve ${entry.id}` });
    await transport.simulateMessage({ ...intruder, content: "!stop" });
    await transport.simulateMessage({ ...intruder, content: "!budget 999" });
    await transport.simulateMessage({ ...intruder, content: "!disable smoke" });

    expect(orchestrator.resumeRun).not.toHaveBeenCalled();
    expect(await pending.get(entry.id)).not.toBeNull();
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dataDir, "STOP"))).toBe(false);
    const state = await overrides.read();
    expect(state.dailyBudgetUsd).toBeUndefined();
    expect(state.disabledAgents).toBeUndefined();
    // Silent on purpose: a reply would confirm the bot is listening and let an
    // attacker probe for the owner id.
    expect(transport.sent).toHaveLength(0);
  });

  it("still serves the owner after ignoring an intruder", async () => {
    const { pending, transport, orchestrator, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "not-owner", content: `approve ${entry.id}` });
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `approve ${entry.id}` });
    expect(orchestrator.resumeRun).toHaveBeenCalledTimes(1);
  });

  // Resolving before resuming destroyed the entry — sessionId and all — on any
  // refusal, with no feedback at all.
  it("keeps the pending entry and explains itself when resumeRun refuses", async () => {
    const { pending, transport, orchestrator, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    orchestrator.resumeRun.mockResolvedValueOnce(undefined);
    await bot.start();

    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `approve ${entry.id}` });

    expect(await pending.get(entry.id)).not.toBeNull();
    const replies = transport.sent.map((m) => m.text).join("\n");
    expect(replies).toContain(entry.id);
    expect(replies).toMatch(/refused/i);
    expect(replies).toMatch(/still open/i);
  });

  it("resolves the entry only after a resume that actually ran", async () => {
    const { pending, transport, orchestrator, bot } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    orchestrator.resumeRun.mockImplementationOnce(async () => {
      // Still present while the resumed run is in flight.
      expect(await pending.get(entry.id)).not.toBeNull();
      return { status: "success" };
    });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `approve ${entry.id}` });
    expect(await pending.get(entry.id)).toBeNull();
  });

  // An unvalidated timezone written into the overrides makes Governor.admit's
  // Intl.DateTimeFormat throw for EVERY agent on EVERY admission check.
  it("!quiet rejects an invalid timezone and leaves the override untouched", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!quiet 10:00-22:00 Not/AZone" });

    expect((await overrides.read()).quietHours).toBeUndefined();
    const reply = transport.sent.map((m) => m.text).join("\n");
    expect(reply).toContain("timezone");
    expect(reply).toContain("Not/AZone");
  });

  it("!quiet rejects an out-of-range time and leaves the override untouched", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!quiet 99:99-22:00 Europe/Berlin" });
    expect((await overrides.read()).quietHours).toBeUndefined();
    expect(transport.sent.map((m) => m.text).join("\n")).toContain("from");
  });

  it("!quiet accepts a valid window and stores it", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!quiet 22:00-07:00 Europe/Berlin" });
    expect((await overrides.read()).quietHours).toEqual({ from: "22:00", to: "07:00", timezone: "Europe/Berlin" });
  });

  it("!runs reports the most recent runs", async () => {
    const { transport, bot, store } = setup();
    const writer = await store.open("smoke-run-1", "smoke");
    await writer.close({ status: "success", summary: "did the thing" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!runs" });
    expect(transport.sent.some((m) => m.text.includes("smoke-run-1"))).toBe(true);
  });
});
