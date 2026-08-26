import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DiscordBot, FakeBotTransport } from "../src/control/bot.js";
import { PendingStore } from "../src/control/pending.js";
import type { AgentDef } from "../src/registry.js";

const AGENTS = [{ name: "smoke", workspace: "/ws/smoke" } as AgentDef];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "cai-bot-"));
  const pending = new PendingStore(dataDir);
  const transport = new FakeBotTransport();
  const orchestrator = { resumeRun: vi.fn().mockResolvedValue({ status: "success" }) };
  const bot = new DiscordBot({
    transport, pending, orchestrator: orchestrator as never, agents: AGENTS,
    channelFor: () => "smoke-channel",
  });
  return { dataDir, pending, transport, orchestrator, bot };
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
});
