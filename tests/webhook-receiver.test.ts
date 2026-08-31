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
    // Defaults to a trusted author so every existing test (which doesn't
    // care about this field) keeps exercising the "accepted" path.
    pull_request: { author_association: "OWNER" },
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

  it.each(["MEMBER", "COLLABORATOR"])(
    "calls the handler for a PR authored by a %s",
    async (authorAssociation) => {
      const receiver = new WebhookReceiver({ secret: SECRET });
      const handler = vi.fn().mockResolvedValue(undefined);
      receiver.onEvent(handler);

      const body = prOpenedPayload({ pull_request: { author_association: authorAssociation } });
      const result = await receiver.handleRequest(body, sign(body));

      expect(result.status).toBe(202);
      expect(handler).toHaveBeenCalledWith({ repo: "owner/repo", event: "pull_request", action: "opened", pullRequestNumber: 42 });
    },
  );

  it.each(["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", "MANNEQUIN"])(
    "ignores a PR authored by a %s, without calling the handler",
    async (authorAssociation) => {
      const receiver = new WebhookReceiver({ secret: SECRET });
      const handler = vi.fn();
      receiver.onEvent(handler);

      const body = prOpenedPayload({ pull_request: { author_association: authorAssociation } });
      const result = await receiver.handleRequest(body, sign(body));

      expect(result.status).toBe(200);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("fails closed (ignores, does not call the handler) when author_association is missing", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    const handler = vi.fn();
    receiver.onEvent(handler);

    const body = prOpenedPayload({ pull_request: {} });
    const result = await receiver.handleRequest(body, sign(body));

    expect(result.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed when the pull_request object itself is missing", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    const handler = vi.fn();
    receiver.onEvent(handler);

    const body = prOpenedPayload({ pull_request: undefined });
    const result = await receiver.handleRequest(body, sign(body));

    expect(result.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
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

  it("responds with a clean 413 Payload Too Large for oversized bodies, not a connection reset", async () => {
    const receiver = new WebhookReceiver({ secret: SECRET });
    await receiver.listen(0);

    const port = (receiver["server"] as any)?.address()?.port;

    // 10MB -- well above the 1MB cap and well above "1 byte over the limit",
    // so a real amount of unread data sits in the socket's receive buffer
    // when the limit trips. This is the case that actually exercises the
    // RST-vs-clean-close distinction: a client must receive the 413 body,
    // not an ECONNRESET, even for a realistically large oversized payload.
    const largeBody = "x".repeat(10 * 1024 * 1024);
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
      // No ECONNRESET tolerance here: a reset is exactly the defect under
      // test, not an acceptable alternative outcome.
      req.on("error", reject);
      req.write(largeBody);
      req.end();
    });

    expect(response.status).toBe(413);
    expect(response.data).toBe("Payload too large");

    await receiver.close();
  });

  it("rejects listen() (rather than crashing with an unhandled 'error' event) when the port is already in use", async () => {
    const holder = new WebhookReceiver({ secret: SECRET });
    await holder.listen(0);
    const takenPort = (holder["server"] as any)?.address()?.port;

    const receiver = new WebhookReceiver({ secret: SECRET });
    await expect(receiver.listen(takenPort)).rejects.toThrow(/EADDRINUSE/);

    await holder.close();
  });

  it("still allows a later listen() to succeed on the same instance after an earlier port conflict", async () => {
    // Guards against the 'error' listener leaking across calls: since each
    // listen() call builds a fresh node:http server, a listener attached
    // during a failed attempt must not linger and reject an unrelated,
    // later, successful bind.
    const holder = new WebhookReceiver({ secret: SECRET });
    await holder.listen(0);
    const takenPort = (holder["server"] as any)?.address()?.port;

    const receiver = new WebhookReceiver({ secret: SECRET });
    await expect(receiver.listen(takenPort)).rejects.toThrow();
    await expect(receiver.listen(0)).resolves.toBeUndefined();

    await receiver.close();
    await holder.close();
  });

  it("destroys a connection that never finishes sending its body (slowloris backstop)", async () => {
    // Short timeout so the test is fast and deterministic instead of waiting
    // out the real 30s production default.
    const receiver = new WebhookReceiver({ secret: SECRET, requestTimeoutMs: 150 });
    await receiver.listen(0);

    const port = (receiver["server"] as any)?.address()?.port;

    const start = Date.now();
    const outcome = await new Promise<{ terminated: boolean; gotResponse: boolean }>((resolve, reject) => {
      const req = request({
        hostname: "localhost",
        port,
        path: "/",
        method: "POST",
        headers: { "content-type": "application/json" },
      });

      let settled = false;
      let gotResponse = false;
      const finish = (terminated: boolean): void => {
        if (settled) return;
        settled = true;
        resolve({ terminated, gotResponse });
      };

      req.on("response", () => {
        gotResponse = true;
      });
      req.on("error", () => finish(true));
      req.on("close", () => finish(true));

      // Write a chunk and deliberately never call req.end() -- simulates a
      // stalled/slowloris client that trickles bytes and never completes.
      req.write(JSON.stringify({ action: "opened" }).slice(0, 5));

      setTimeout(() => {
        if (!settled) reject(new Error("connection was not terminated within the expected bound"));
      }, 5000);
    });

    const elapsedMs = Date.now() - start;

    expect(outcome.terminated).toBe(true);
    expect(outcome.gotResponse).toBe(false);
    // Should be terminated close to requestTimeoutMs, not held open indefinitely.
    expect(elapsedMs).toBeLessThan(2000);

    await receiver.close();
  });
});
