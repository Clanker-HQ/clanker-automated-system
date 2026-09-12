import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebhookGiveUpStore } from "../src/state/webhook-give-ups.js";

function giveUp(overrides: Partial<Parameters<WebhookGiveUpStore["record"]>[1]> = {}) {
  return {
    reason: "attempts" as const,
    totalTries: 20,
    createdAt: "2026-09-11T16:18:05.867Z",
    gaveUpAt: "2026-09-11T16:27:24.523Z",
    ...overrides,
  };
}

describe("WebhookGiveUpStore", () => {
  it("list is empty when nothing has been recorded", async () => {
    const store = new WebhookGiveUpStore(mkdtempSync(join(tmpdir(), "cai-webhookgiveups-")));
    expect(await store.list()).toEqual({});
  });

  it("record adds an entry retrievable via list", async () => {
    const store = new WebhookGiveUpStore(mkdtempSync(join(tmpdir(), "cai-webhookgiveups-")));
    await store.record("Clanker-HQ/clanker-automated-system#75", giveUp());

    expect(await store.list()).toEqual({ "Clanker-HQ/clanker-automated-system#75": giveUp() });
  });

  it("tracks multiple PRs independently, each with its own reason/totalTries", async () => {
    const store = new WebhookGiveUpStore(mkdtempSync(join(tmpdir(), "cai-webhookgiveups-")));
    await store.record("Clanker-HQ/clanker-automated-system#75", giveUp({ reason: "attempts", totalTries: 20 }));
    await store.record("AAS-Labs/book-pipeline#1", giveUp({ reason: "rate-limit-defers", totalTries: 60 }));

    const all = await store.list();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all["Clanker-HQ/clanker-automated-system#75"]!.reason).toBe("attempts");
    expect(all["AAS-Labs/book-pipeline#1"]!.reason).toBe("rate-limit-defers");
  });

  it("recording again for the same key overwrites the previous entry", async () => {
    const store = new WebhookGiveUpStore(mkdtempSync(join(tmpdir(), "cai-webhookgiveups-")));
    await store.record("AAS-Labs/pilot-01#6", giveUp({ totalTries: 20 }));
    await store.record("AAS-Labs/pilot-01#6", giveUp({ totalTries: 41 }));

    const all = await store.list();
    expect(Object.keys(all)).toHaveLength(1);
    expect(all["AAS-Labs/pilot-01#6"]!.totalTries).toBe(41);
  });

  it("clear removes a recorded entry", async () => {
    const store = new WebhookGiveUpStore(mkdtempSync(join(tmpdir(), "cai-webhookgiveups-")));
    await store.record("AAS-Labs/pilot-01#6", giveUp());
    await store.clear("AAS-Labs/pilot-01#6");

    expect(await store.list()).toEqual({});
  });

  it("clear on a key with nothing recorded is a harmless no-op", async () => {
    const store = new WebhookGiveUpStore(mkdtempSync(join(tmpdir(), "cai-webhookgiveups-")));
    await expect(store.clear("AAS-Labs/pilot-01#6")).resolves.toBeUndefined();
    expect(await store.list()).toEqual({});
  });

  it("survives a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-webhookgiveups-"));
    await new WebhookGiveUpStore(dir).record("AAS-Labs/pilot-01#6", giveUp());
    expect(await new WebhookGiveUpStore(dir).list()).toEqual({ "AAS-Labs/pilot-01#6": giveUp() });
  });
});
