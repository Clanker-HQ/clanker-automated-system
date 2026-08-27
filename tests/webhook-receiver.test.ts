import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WebhookReceiver } from "../src/control/webhook-receiver.js";

const SECRET = "test-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function prOpenedPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "opened",
    number: 42,
    repository: { full_name: "owner/repo" },
    ...overrides,
  });
}

describe("WebhookReceiver.handleRequest", () => {
  it("calls the registered handler for a validly signed pull_request event", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    const handler = vi.fn().mockResolvedValue(undefined);
    receiver.onEvent(handler);

    const body = prOpenedPayload();
    const result = await receiver.handleRequest(body, sign(body));

    expect(result.status).toBe(202);
    expect(handler).toHaveBeenCalledWith({ repo: "owner/repo", event: "pull_request", action: "opened", pullRequestNumber: 42 });
  });

  it("rejects a request with a bad signature and never calls the handler", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    const handler = vi.fn();
    receiver.onEvent(handler);

    const result = await receiver.handleRequest(prOpenedPayload(), "sha256=wrong");

    expect(result.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores an unrelated action without erroring, and does not call the handler", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    const handler = vi.fn();
    receiver.onEvent(handler);

    const body = prOpenedPayload({ action: "labeled" });
    const result = await receiver.handleRequest(body, sign(body));

    expect(result.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body without throwing", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    const body = "not json";
    await expect(receiver.handleRequest(body, sign(body))).resolves.toMatchObject({ status: 400 });
  });

  it("does not let a handler rejection crash the request", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    receiver.onEvent(async () => {
      throw new Error("boom");
    });
    const body = prOpenedPayload();
    const result = await receiver.handleRequest(body, sign(body));
    expect(result.status).toBe(202);
  });
});
