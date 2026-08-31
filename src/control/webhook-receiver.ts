import { createServer, type Server } from "node:http";
import { verifyGithubSignature } from "./webhook-signature.js";

export interface WebhookEvent {
  repo: string;
  event: "pull_request";
  action: string;
  pullRequestNumber: number;
}

const RELEVANT_ACTIONS: ReadonlySet<string> = new Set(["opened", "synchronize", "reopened"]);

/**
 * GitHub computes this relationship itself and includes it on every
 * `pull_request` payload — no extra API call needed to tell a stranger's
 * fork PR apart from the operator's own or a trusted collaborator's. Fail
 * closed: only these three admit the PR; anything else (a real but
 * lower-trust value, or the field/object missing entirely) is ignored the
 * same as an irrelevant action, since a webhook signature only proves the
 * event came from GitHub, not that the PR's author should be trusted with
 * a real, quota-consuming review run.
 */
const TRUSTED_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export class WebhookReceiver {
  private readonly secret: string;
  private readonly requestTimeoutMs: number;
  private handler: ((event: WebhookEvent) => Promise<void>) | null = null;
  private server: Server | null = null;

  constructor(opts: { secret: string; requestTimeoutMs?: number }) {
    this.secret = opts.secret;
    // Slowloris backstop for listen()'s node:http adapter: a request that
    // hasn't finished sending its body within this window gets destroyed.
    // Configurable so tests can exercise it without a real 30s wait.
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  onEvent(handler: (event: WebhookEvent) => Promise<void>): void {
    this.handler = handler;
  }

  /**
   * Pure request handling, deliberately separate from the `node:http` layer
   * below — this is what makes the whole receiver testable with zero real
   * sockets. `listen()` is a thin adapter on top of this.
   */
  async handleRequest(rawBody: string, signatureHeader: string | undefined): Promise<{ status: number; body: string }> {
    if (!verifyGithubSignature(rawBody, signatureHeader, this.secret)) {
      return { status: 401, body: "invalid signature" };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return { status: 400, body: "invalid JSON" };
    }

    const action = typeof payload.action === "string" ? payload.action : "";
    const repo = (payload.repository as Record<string, unknown> | undefined)?.full_name;
    const number = payload.number;
    const authorAssociation = (payload.pull_request as Record<string, unknown> | undefined)?.author_association;

    if (
      !RELEVANT_ACTIONS.has(action) ||
      typeof repo !== "string" ||
      typeof number !== "number" ||
      typeof authorAssociation !== "string" ||
      !TRUSTED_AUTHOR_ASSOCIATIONS.has(authorAssociation)
    ) {
      return { status: 200, body: "ignored" };
    }

    const event: WebhookEvent = { repo, event: "pull_request", action, pullRequestNumber: number };

    // Never let a handler failure become an unhandled rejection or a 500
    // that makes GitHub retry-storm an already-processing event — the run's
    // own failure handling (Governor, breaker) is the right place for that,
    // not this HTTP layer.
    void this.handler?.(event).catch((err: unknown) => {
      console.error(`[webhook] handler failed for ${repo}#${number}`, err);
    });

    return { status: 202, body: "accepted" };
  }

  async listen(port: number): Promise<void> {
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB

    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      let responseSent = false;

      // Slowloris backstop: bounds how long a connection can be held open
      // by a client that trickles bytes forever (or never finishes sending).
      // This is independent of the oversized-body handling below -- it's
      // the only thing in this handler that ever calls req.destroy().
      const timer = setTimeout(() => {
        req.destroy();
      }, this.requestTimeoutMs);
      const clearRequestTimer = (): void => clearTimeout(timer);

      req.on("error", () => {
        clearRequestTimer();
        if (!responseSent && !res.destroyed && !res.writableEnded) {
          responseSent = true;
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Bad request");
        }
      });

      req.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          if (!responseSent) {
            responseSent = true;
            res.writeHead(413, { "content-type": "text/plain" });
            res.end("Payload too large");
          }
          // Deliberately do NOT pause() or destroy() here. Node sends an RST
          // (surfacing to the client as ECONNRESET) when a socket is closed
          // while unread body data is still sitting in its receive buffer --
          // true whether that data was ignored via pause() or never read at
          // all. So instead we keep consuming (and discarding) the rest of
          // the body: memory stays bounded because we simply stop retaining
          // chunks below, and the eventual connection close (once the client
          // finishes sending and the stream reaches 'end') is clean because
          // nothing is left unread. This costs a little extra bandwidth/CPU
          // to drain, but that's the trade that actually delivers the 413.
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        clearRequestTimer();
        if (responseSent) return; // oversized body already got its 413; body is now fully drained, let the connection close naturally
        responseSent = true;
        void this.handleRequest(Buffer.concat(chunks).toString("utf8"), req.headers["x-hub-signature-256"] as string | undefined).then(
          ({ status, body }) => {
            res.writeHead(status, { "content-type": "text/plain" });
            res.end(body);
          },
        );
      });
    });

    // Without this, a server-level error (most commonly EADDRINUSE — the
    // configured port already in use) surfaces as an unhandled 'error' event
    // on the server instead of a rejection: a hard process crash with a raw
    // stack trace, and the returned promise never even settles. `once` (not
    // `on`) and removing the listener on success: a runtime error on an
    // already-listening server is a different concern this method doesn't
    // own, and must not reject a promise that already resolved.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.server!.once("error", onError);
      this.server!.listen(port, () => {
        this.server!.removeListener("error", onError);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
