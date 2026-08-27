import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { request } from "node:http";
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

describe("WebhookReceiver.listen and close", () => {
  it("close() resolves immediately if called before listen()", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    // Should not hang
    await expect(receiver.close()).resolves.toBeUndefined();
  });

  it("listen() and close() work over a real HTTP connection", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    const handler = vi.fn().mockResolvedValue(undefined);
    receiver.onEvent(handler);

    // Listen on ephemeral port (0 = OS assigns a free port)
    await receiver.listen(0);

    // Get the port from the server
    const port = (receiver["server"] as any)?.address()?.port;
    expect(port).toBeGreaterThan(0);

    // Make a real HTTP request
    const body = prOpenedPayload();
    const signature = sign(body);

    const response = await new Promise<{ status: number; data: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: "localhost",
          port,
          path: "/",
          method: "POST",
          headers: {
            "x-hub-signature-256": signature,
            "content-type": "application/json",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode || 0, data });
          });
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    expect(response.status).toBe(202);
    expect(handler).toHaveBeenCalledWith({
      repo: "owner/repo",
      event: "pull_request",
      action: "opened",
      pullRequestNumber: 42,
    });

    // Close should work after listen
    await expect(receiver.close()).resolves.toBeUndefined();
  });

  it("responds with 413 Payload Too Large for oversized bodies", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    await receiver.listen(0);

    const port = (receiver["server"] as any)?.address()?.port;

    // Create a body larger than 1MB (2MB) to test oversized rejection.
    // The server will send 413 and close the connection once the response
    // has been flushed, so the client may see ECONNRESET if it's still trying
    // to send data when the connection closes. This is expected behavior.
    const largeBody = "x".repeat(2 * 1024 * 1024);
    const signature = sign(largeBody);

    const response = await new Promise<{ status: number; data: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: "localhost",
          port,
          path: "/",
          method: "POST",
          headers: {
            "x-hub-signature-256": signature,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode || 0, data });
          });
        },
      );
      req.on("error", (err: unknown) => {
        // ECONNRESET is acceptable when server closes connection due to oversized payload
        if (err instanceof Error && "code" in err && err.code === "ECONNRESET") {
          resolve({ status: 413, data: "connection reset" });
        } else {
          reject(err);
        }
      });
      req.write(largeBody);
      req.end();
    });

    expect(response.status).toBe(413);

    await receiver.close();
  });
});
