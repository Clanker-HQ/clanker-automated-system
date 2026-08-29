import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DiscordBot, FakeBotTransport } from "../src/control/bot.js";
import { ConfigOverridesStore } from "../src/config-overrides.js";
import { PendingStore } from "../src/control/pending.js";
import type { GovernorStatus } from "../src/governor.js";
import type { AgentDef } from "../src/registry.js";
import { RunStore } from "../src/run-store.js";
import { BreakerStore } from "../src/state/breaker.js";
import { TaskStore } from "../src/control/task-store.js";

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
  const tasks = new TaskStore(dataDir);
  const dispatcher = { wake: vi.fn().mockResolvedValue(undefined) };
  // Mutable so a test can adjust a field and see !status reflect it, without
  // needing a real Governor (and the config/run-store/rate-limit fixtures
  // that would drag along).
  const governorStatus: GovernorStatus = {
    stopped: false, quietHours: null, quietHoursActive: false,
    dailyBudgetUsd: 10, spentTodayUsd: 0, maxConcurrent: 2,
    breakerEnabled: true, disabledAgents: [],
  };
  const governor = { status: async () => governorStatus, adjustConcurrency: vi.fn() };
  const bot = new DiscordBot({
    transport, pending, orchestrator: orchestrator as never, agents: AGENTS,
    channelFor: () => "smoke-channel",
    store, overrides, breaker, dataDir, ownerId: OWNER,
    tasks, dispatcher, governor,
  });
  return { dataDir, pending, transport, orchestrator, bot, store, overrides, breaker, tasks, dispatcher, governorStatus, governor };
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

  it("resuming a run linked to a waiting task marks it done and notifies the task's channel", async () => {
    const { pending, transport, orchestrator, bot, tasks } = setup();
    const task = await tasks.create({ text: "research something", createdBy: "discord:owner" });
    await tasks.update(task.id, { status: "waiting", runId: "r1" });
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    orchestrator.resumeRun.mockResolvedValueOnce({ status: "success", runId: "r1", summary: "Found the answer." });
    await bot.start();

    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `approve ${entry.id}` });

    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("done");
    expect(updated?.result?.summary).toBe("Found the answer.");
    expect(transport.sent.some((m) => m.text.includes(task.id) && m.text.includes("Found the answer."))).toBe(true);
  });

  it("resuming a run that fails marks its linked task failed and notifies", async () => {
    const { pending, transport, orchestrator, bot, tasks } = setup();
    const task = await tasks.create({ text: "research something", createdBy: "discord:owner" });
    await tasks.update(task.id, { status: "waiting", runId: "r1" });
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    orchestrator.resumeRun.mockResolvedValueOnce({ status: "failed", runId: "r1", error: "boom" });
    await bot.start();

    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `approve ${entry.id}` });

    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.failureReason).toBe("boom");
    expect(transport.sent.some((m) => m.text.includes(task.id) && m.text.includes("boom"))).toBe(true);
  });

  it("resuming a run that parks again leaves its linked task waiting, untouched", async () => {
    const { pending, transport, orchestrator, bot, tasks } = setup();
    const task = await tasks.create({ text: "research something", createdBy: "discord:owner" });
    await tasks.update(task.id, { status: "waiting", runId: "r1" });
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    orchestrator.resumeRun.mockResolvedValueOnce({ status: "parked", runId: "r1" });
    await bot.start();

    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `approve ${entry.id}` });

    const updated = await tasks.get(task.id);
    expect(updated?.status).toBe("waiting");
    expect(transport.sent.some((m) => m.text.includes(task.id))).toBe(false);
  });

  it("resuming a run with no linked task is a no-op for the task store", async () => {
    const { pending, transport, orchestrator, bot, tasks } = setup();
    const entry = await pending.create({ runId: "r1", agentName: "smoke", sessionId: "s1", kind: "approval", effect: "x", grantRef: "g" });
    orchestrator.resumeRun.mockResolvedValueOnce({ status: "success", runId: "r1", summary: "done" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: `approve ${entry.id}` });
    expect(await tasks.list()).toEqual([]);
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

  it("!concurrency <n> updates the override, echoes the new value, and tells the governor to admit any already-queued runs", async () => {
    const { transport, bot, overrides, governor } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!concurrency 5" });
    expect((await overrides.read()).maxConcurrent).toBe(5);
    expect(transport.sent.some((m) => m.text.includes("5"))).toBe(true);
    expect(governor.adjustConcurrency).toHaveBeenCalledWith(5);
  });

  it("!concurrency with an invalid argument replies with an error and never calls the governor", async () => {
    const { transport, bot, overrides, governor } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!concurrency 0" });
    expect((await overrides.read()).maxConcurrent).toBeUndefined();
    expect(governor.adjustConcurrency).not.toHaveBeenCalled();
    expect(transport.sent.map((m) => m.text).join("\n")).toContain("Not a valid concurrency");
  });

  it("!breaker off disables the circuit breaker", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!breaker off" });
    expect((await overrides.read()).breakerEnabled).toBe(false);
  });

  it("!breaker on re-enables the circuit breaker", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!breaker off" });
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!breaker on" });
    expect((await overrides.read()).breakerEnabled).toBe(true);
  });

  it("!breaker with no/unknown argument replies with usage and leaves the override untouched", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!breaker" });
    expect((await overrides.read()).breakerEnabled).toBeUndefined();
    expect(transport.sent.map((m) => m.text).join("\n")).toContain("Usage");
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

  it("!disable <unknown-agent> refuses, naming the known agents, and never touches disabledAgents", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!disable reasearch" });
    expect((await overrides.read()).disabledAgents).toBeUndefined();
    const reply = transport.sent.map((m) => m.text).join("\n");
    expect(reply).toContain("No agent named");
    expect(reply).toContain("smoke");
  });

  it("!enable <unknown-agent> still clears a stale override but flags that nothing is currently loaded by that name", async () => {
    const { transport, bot, overrides } = setup();
    await overrides.set("disabledAgents", ["removed-agent"], "test");
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!enable removed-agent" });
    expect((await overrides.read()).disabledAgents ?? []).toEqual([]);
    expect(transport.sent.some((m) => m.text.includes("no agent by that name is currently loaded"))).toBe(true);
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

  it("!quiet accepts a valid same-day window and stores it", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!quiet 02:00-03:00 Europe/Berlin" });
    expect((await overrides.read()).quietHours).toEqual({ from: "02:00", to: "03:00", timezone: "Europe/Berlin" });
  });

  it("!quiet rejects an overnight window, which could never actually suppress anything, and leaves the override untouched", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!quiet 22:00-07:00 Europe/Berlin" });
    expect((await overrides.read()).quietHours).toBeUndefined();
    const reply = transport.sent.map((m) => m.text).join("\n");
    expect(reply).toContain("22:00");
    expect(reply).toContain("07:00");
  });

  it("!quiet rejects a zero-length window (from equal to to)", async () => {
    const { transport, bot, overrides } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!quiet 03:00-03:00 Europe/Berlin" });
    expect((await overrides.read()).quietHours).toBeUndefined();
  });

  it("!runs reports the most recent runs", async () => {
    const { transport, bot, store } = setup();
    const writer = await store.open("smoke-run-1", "smoke");
    await writer.close({ status: "success", summary: "did the thing" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!runs" });
    expect(transport.sent.some((m) => m.text.includes("smoke-run-1"))).toBe(true);
  });

  it("!runs flags a run whose objective was graded not-achieved, but not one graded achieved", async () => {
    const { transport, bot, store } = setup();
    const flagged = await store.open("smoke-run-flagged", "smoke");
    await flagged.close({ status: "success", summary: "did something" });
    await store.recordVerification("smoke-run-flagged", { verdict: "not-achieved", reason: "missed it" });
    const clean = await store.open("smoke-run-clean", "smoke");
    await clean.close({ status: "success", summary: "did the thing" });
    await store.recordVerification("smoke-run-clean", { verdict: "achieved", reason: "nailed it" });

    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "owner", content: "!runs" });
    const lines = transport.sent.find((m) => m.text.includes("smoke-run-flagged"))!.text.split("\n");
    const flaggedLine = lines.find((l) => l.includes("smoke-run-flagged"))!;
    const cleanLine = lines.find((l) => l.includes("smoke-run-clean"))!;
    expect(flaggedLine).toContain("not-achieved");
    expect(cleanLine).not.toContain("achieved");
  });
});

describe("DiscordBot task commands", () => {
  it("!task queues a task, replies with its id, and wakes the dispatcher", async () => {
    const { transport, bot, tasks, dispatcher } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!task find a profitable SaaS idea" });
    const all = await tasks.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toBe("find a profitable SaaS idea");
    expect(all[0]?.createdBy).toBe(`discord:${OWNER}`);
    expect(transport.sent[0]?.text).toContain(all[0]!.id);
    expect(dispatcher.wake).toHaveBeenCalled();
  });

  it("!task preserves internal whitespace and newlines in the request text", async () => {
    const { transport, bot, tasks } = setup();
    await bot.start();
    const text = "research two things:\n- one\n- two   (with  spacing)";
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `!task ${text}` });
    expect((await tasks.list())[0]?.text).toBe(text);
  });

  it("!task with no text replies with usage and creates nothing", async () => {
    const { transport, bot, tasks } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!task" });
    expect(await tasks.list()).toEqual([]);
    expect(transport.sent[0]?.text).toContain("Usage");
  });

  it("!task rejects text over the length cap, creating nothing", async () => {
    const { transport, bot, tasks } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `!task ${"x".repeat(4001)}` });
    expect(await tasks.list()).toEqual([]);
    expect(transport.sent[0]?.text).toContain("4001");
    expect(transport.sent[0]?.text).toContain("limit");
  });

  it("!task accepts text right at the length cap", async () => {
    const { transport, bot, tasks } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `!task ${"x".repeat(4000)}` });
    expect(await tasks.list()).toHaveLength(1);
  });

  it("!task -d flags the task for a detailed summary and strips the flag from the text", async () => {
    const { transport, bot, tasks } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!task -d find a profitable SaaS idea" });
    const all = await tasks.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toBe("find a profitable SaaS idea");
    expect(all[0]?.wantsDetail).toBe(true);
  });

  it("!task without -d leaves wantsDetail unset", async () => {
    const { transport, bot, tasks } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!task find a profitable SaaS idea" });
    expect((await tasks.list())[0]?.wantsDetail).toBeUndefined();
  });

  it("!task -d with nothing after the flag replies with usage and creates nothing", async () => {
    const { transport, bot, tasks } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!task -d" });
    expect(await tasks.list()).toEqual([]);
    expect(transport.sent[0]?.text).toContain("Usage");
  });

  it("a word that merely starts with -d is literal text, not the detail flag", async () => {
    const { transport, bot, tasks } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!task -detailed report please" });
    const all = await tasks.list();
    expect(all[0]?.text).toBe("-detailed report please");
    expect(all[0]?.wantsDetail).toBeUndefined();
  });

  it("!task -p <n> sets priority and strips the flag from the text", async () => {
    const { transport, bot, tasks } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!task -p 90 find a profitable SaaS idea" });
    const all = await tasks.list();
    expect(all[0]?.text).toBe("find a profitable SaaS idea");
    expect(all[0]?.priority).toBe(90);
    expect(all[0]?.wantsDetail).toBeUndefined();
  });

  it("!task -d and -p combine in either order", async () => {
    const { transport, bot, tasks } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!task -p 90 -d find idea" });
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!task -d -p 90 find idea" });
    const all = await tasks.list();
    expect(all).toHaveLength(2);
    for (const t of all) {
      expect(t.text).toBe("find idea");
      expect(t.priority).toBe(90);
      expect(t.wantsDetail).toBe(true);
    }
  });

  it("a -p flag with a non-numeric argument is left as literal text", async () => {
    const { transport, bot, tasks } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!task -p urgent find idea" });
    const all = await tasks.list();
    expect(all[0]?.text).toBe("-p urgent find idea");
    expect(all[0]?.priority).toBe(50);
  });

  it("!retry requeues a failed task, keeping its routing, and wakes the dispatcher", async () => {
    const { transport, bot, tasks, dispatcher } = setup();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, {
      status: "failed", failureReason: "boom", specialistAgent: "research", finishedAt: "t", retryCount: 1,
    });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `!retry ${task.id.slice(0, 8)}` });
    const after = await tasks.get(task.id);
    expect(after?.status).toBe("pending");
    expect(after?.failureReason).toBeUndefined();
    expect(after?.finishedAt).toBeUndefined();
    expect(after?.specialistAgent).toBe("research");
    // A manual retry is a fresh attempt: it gets its own silent auto-retry
    // from the dispatcher if this next run also fails transiently.
    expect(after?.retryCount).toBeUndefined();
    expect(dispatcher.wake).toHaveBeenCalled();
    expect(transport.sent[0]!.text).toContain("requeued");
  });

  it("!retry on a task that isn't failed says so and leaves it untouched", async () => {
    const { transport, bot, tasks } = setup();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `!retry ${task.id.slice(0, 8)}` });
    expect((await tasks.get(task.id))?.status).toBe("pending");
    expect(transport.sent[0]!.text).toContain("not failed");
  });

  it("!retry with an unmatched prefix says so", async () => {
    const { transport, bot } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!retry deadbeef" });
    expect(transport.sent[0]!.text).toContain("No task found");
  });

  it("!retry with no argument replies with usage", async () => {
    const { transport, bot } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!retry" });
    expect(transport.sent[0]!.text).toContain("Usage");
  });

  it("!cancel removes a pending task", async () => {
    const { transport, bot, tasks } = setup();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `!cancel ${task.id.slice(0, 8)}` });
    expect(await tasks.get(task.id)).toBeNull();
    expect(transport.sent[0]!.text).toContain("canceled");
  });

  it("!cancel on a non-pending task refuses and leaves it in place", async () => {
    const { transport, bot, tasks } = setup();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, { status: "running" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `!cancel ${task.id.slice(0, 8)}` });
    expect(await tasks.get(task.id)).not.toBeNull();
    expect(transport.sent[0]!.text).toContain("not pending");
  });

  it("!cancel with an unmatched prefix says so", async () => {
    const { transport, bot } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!cancel deadbeef" });
    expect(transport.sent[0]!.text).toContain("No task found");
  });

  it("!cancel with no argument replies with usage", async () => {
    const { transport, bot } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!cancel" });
    expect(transport.sent[0]!.text).toContain("Usage");
  });

  it("!status reports the default live state", async () => {
    const { transport, bot } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!status" });
    const reply = transport.sent[0]!.text;
    expect(reply).toContain("running");
    expect(reply).toContain("$0.00 of $10");
    expect(reply).toContain("Quiet hours: off");
    expect(reply).toContain("Circuit breaker: on");
    expect(reply).toContain("Disabled agents: none");
    expect(reply).toContain("0 pending, 0 running, 0 waiting");
  });

  it("!status reflects a stopped, quiet-hours-active, breaker-off state with disabled agents", async () => {
    const { transport, bot, governorStatus } = setup();
    governorStatus.stopped = true;
    governorStatus.quietHours = { from: "02:00", to: "03:00", timezone: "Europe/Berlin" };
    governorStatus.quietHoursActive = true;
    governorStatus.breakerEnabled = false;
    governorStatus.disabledAgents = ["research"];
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!status" });
    const reply = transport.sent[0]!.text;
    expect(reply).toContain("STOPPED");
    expect(reply).toContain("02:00-03:00 Europe/Berlin (active now)");
    expect(reply).toContain("Circuit breaker: off");
    expect(reply).toContain("Disabled agents: research");
  });

  it("!status counts pending, running, and waiting tasks", async () => {
    const { transport, bot, tasks } = setup();
    await tasks.create({ text: "a", createdBy: "discord:owner" });
    const running = await tasks.create({ text: "b", createdBy: "discord:owner" });
    await tasks.update(running.id, { status: "running" });
    const waiting = await tasks.create({ text: "c", createdBy: "discord:owner" });
    await tasks.update(waiting.id, { status: "waiting" });
    const done = await tasks.create({ text: "d", createdBy: "discord:owner" });
    await tasks.update(done.id, { status: "done" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!status" });
    expect(transport.sent[0]!.text).toContain("1 pending, 1 running, 1 waiting");
  });

  it("!tasks lists pending, running, and waiting tasks, not finished ones", async () => {
    const { transport, bot, tasks } = setup();
    await tasks.create({ text: "a pending one", createdBy: "discord:owner" });
    const running = await tasks.create({ text: "a running one", createdBy: "discord:owner" });
    await tasks.update(running.id, { status: "running" });
    // A run parked on the owner's own approve/deny/answer: still in flight, and
    // precisely the task they most need to see listed.
    const waiting = await tasks.create({ text: "a waiting one", createdBy: "discord:owner" });
    await tasks.update(waiting.id, { status: "waiting" });
    const done = await tasks.create({ text: "a finished one", createdBy: "discord:owner" });
    await tasks.update(done.id, { status: "done" });
    const failed = await tasks.create({ text: "a broken one", createdBy: "discord:owner" });
    await tasks.update(failed.id, { status: "failed" });

    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!tasks" });
    const reply = transport.sent[0]!.text;
    expect(reply).toContain("a pending one");
    expect(reply).toContain("a running one");
    expect(reply).toContain("a waiting one");
    expect(reply).not.toContain("a finished one");
    expect(reply).not.toContain("a broken one");
  });

  it("!result <short-id> reports a done task's full summary", async () => {
    const { transport, bot, tasks } = setup();
    const task = await tasks.create({ text: "find a profitable SaaS idea", createdBy: "discord:owner" });
    await tasks.update(task.id, { status: "done", result: { summary: "Found three promising niches.", path: "/data/runs/x" } });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `!result ${task.id.slice(0, 8)}` });
    const reply = transport.sent[0]!.text;
    expect(reply).toContain("done");
    expect(reply).toContain("Found three promising niches.");
  });

  it("!result shows who requested a self-queued task", async () => {
    const { transport, bot, tasks } = setup();
    const task = await tasks.create({ text: "look into X", createdBy: "agent:opportunity-scout" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `!result ${task.id}` });
    expect(transport.sent[0]!.text).toContain("Requested by: agent:opportunity-scout");
  });

  it("!result reports a failed task's reason", async () => {
    const { transport, bot, tasks } = setup();
    const task = await tasks.create({ text: "x", createdBy: "discord:owner" });
    await tasks.update(task.id, { status: "failed", failureReason: "no specialist matched this task" });
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: `!result ${task.id}` });
    expect(transport.sent[0]!.text).toContain("no specialist matched this task");
  });

  it("!result with an unmatched prefix says so and creates nothing", async () => {
    const { transport, bot } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!result deadbeef" });
    expect(transport.sent[0]!.text).toContain("No task found");
  });

  it("!result with an ambiguous prefix lists the matches instead of picking one", async () => {
    const { transport, bot, tasks } = setup();
    const a = await tasks.create({ text: "a", createdBy: "discord:owner" });
    const b = await tasks.create({ text: "b", createdBy: "discord:owner" });
    vi.spyOn(tasks, "findByPrefix").mockResolvedValue([a, b]);
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!result shared-prefix" });
    expect(transport.sent[0]!.text).toContain("2 tasks");
  });

  it("!result with no argument replies with usage", async () => {
    const { transport, bot } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: OWNER, content: "!result" });
    expect(transport.sent[0]!.text).toContain("Usage");
  });

  it("ignores !task from a non-owner author", async () => {
    const { transport, bot, tasks } = setup();
    await bot.start();
    await transport.simulateMessage({ channelId: "smoke-channel", authorId: "not-the-owner", content: "!task do something" });
    expect(await tasks.list()).toEqual([]);
    expect(transport.sent).toEqual([]);
  });
});
