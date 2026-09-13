import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebhookRetryStore } from "../src/control/webhook-retry-store.js";
import type { WebhookEvent } from "../src/control/webhook-receiver.js";

function event(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return { repo: "owner/repo", event: "pull_request", action: "opened", pullRequestNumber: 7, ...overrides };
}

describe("WebhookRetryStore", () => {
  it("has nothing pending initially", async () => {
    const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
    expect(await store.list()).toEqual([]);
  });

  it("create() persists the event with attempts starting at 1", async () => {
    const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
    const entry = await store.create(event());
    expect(entry.attempts).toBe(1);
    expect(entry.event).toEqual(event());
    expect(await store.get(entry.id)).toEqual(entry);
  });

  it("list() returns every persisted entry", async () => {
    const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
    await store.create(event({ pullRequestNumber: 1 }));
    await store.create(event({ pullRequestNumber: 2 }));
    const all = await store.list();
    expect(all.map((e) => e.event.pullRequestNumber).sort()).toEqual([1, 2]);
  });

  it("recordAttempt bumps the count and lastAttemptAt", async () => {
    const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
    const entry = await store.create(event());
    const updated = await store.recordAttempt(entry.id);
    expect(updated?.attempts).toBe(2);
    expect(updated?.createdAt).toBe(entry.createdAt);
  });

  it("recordAttempt on an unknown id is a harmless no-op returning null", async () => {
    const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
    expect(await store.recordAttempt("no-such-id")).toBeNull();
  });

  it("resolve removes the entry", async () => {
    const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
    const entry = await store.create(event());
    await store.resolve(entry.id);
    expect(await store.get(entry.id)).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("resolve on an already-resolved id is a harmless no-op", async () => {
    const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
    await store.resolve("no-such-id");
  });

  it("survives a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cai-webhookretry-"));
    const entry = await new WebhookRetryStore(dir).create(event());
    expect(await new WebhookRetryStore(dir).get(entry.id)).toEqual(entry);
  });

  describe("rate-limit deferral (a known reset instant)", () => {
    it("create() with rateLimitResetAt starts attempts at 0 and rateLimitDeferCount at 1, deferred to that instant", async () => {
      const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
      const resetAt = new Date(Date.now() + 60_000);
      const entry = await store.create(event(), { rateLimitResetAt: resetAt });
      expect(entry.attempts).toBe(0);
      expect(entry.rateLimitDeferCount).toBe(1);
      expect(entry.nextRetryAt).toBe(resetAt.toISOString());
    });

    it("recordAttempt with rateLimitResetAt bumps rateLimitDeferCount, not attempts, and refreshes nextRetryAt", async () => {
      const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
      const entry = await store.create(event());
      const resetAt = new Date(Date.now() + 60_000);
      const updated = await store.recordAttempt(entry.id, { rateLimitResetAt: resetAt });
      expect(updated?.attempts).toBe(1); // unchanged from create()'s plain-path default
      expect(updated?.rateLimitDeferCount).toBe(1);
      expect(updated?.nextRetryAt).toBe(resetAt.toISOString());
    });

    it("a plain recordAttempt (no rateLimitResetAt) clears a previously-set nextRetryAt", async () => {
      const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
      const entry = await store.create(event(), { rateLimitResetAt: new Date(Date.now() + 60_000) });
      const updated = await store.recordAttempt(entry.id);
      expect(updated?.attempts).toBe(1);
      expect(updated?.rateLimitDeferCount).toBe(1); // untouched by the plain branch
      expect(updated?.nextRetryAt).toBeUndefined();
    });

    // Regression coverage: a parseRateLimitReset bug or a malformed error
    // message could otherwise hand back an implausible instant and have it
    // written straight to `nextRetryAt`, deferring the entry for a day (or
    // longer, on repeat) on a reset time no real subscription window
    // justifies. See boundRateLimitReset in rate-limit-reset.ts.
    it("create() falls back to the plain path when rateLimitResetAt is implausibly far in the future", async () => {
      const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
      const farFuture = new Date(Date.now() + 25 * 60 * 60 * 1000);
      const entry = await store.create(event(), { rateLimitResetAt: farFuture });
      expect(entry.attempts).toBe(1);
      expect(entry.rateLimitDeferCount).toBeUndefined();
      expect(entry.nextRetryAt).toBeUndefined();
    });

    it("recordAttempt falls back to bumping attempts when rateLimitResetAt is implausibly far in the future", async () => {
      const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
      const entry = await store.create(event());
      const farFuture = new Date(Date.now() + 25 * 60 * 60 * 1000);
      const updated = await store.recordAttempt(entry.id, { rateLimitResetAt: farFuture });
      expect(updated?.attempts).toBe(2);
      expect(updated?.rateLimitDeferCount).toBeUndefined();
      expect(updated?.nextRetryAt).toBeUndefined();
    });

    it("create() clamps a past rateLimitResetAt up to now instead of discarding the defer", async () => {
      const store = new WebhookRetryStore(mkdtempSync(join(tmpdir(), "cai-webhookretry-")));
      const before = Date.now();
      const entry = await store.create(event(), { rateLimitResetAt: new Date(before - 60_000) });
      expect(entry.rateLimitDeferCount).toBe(1);
      expect(entry.nextRetryAt).toBeDefined();
      expect(new Date(entry.nextRetryAt!).getTime()).toBeGreaterThanOrEqual(before);
    });
  });
});
