import { createServer, type Server } from "node:http";
import { verifyGithubSignature } from "./webhook-signature.js";

export interface WebhookEvent {
  repo: string;
  event: "pull_request";
  action: string;
  pullRequestNumber: number;
}

const RELEVANT_ACTIONS: ReadonlySet<string> = new Set(["opened", "synchronize", "reopened"]);

export class WebhookReceiver {
  private readonly secret: string;
  private handler: ((event: WebhookEvent) => Promise<void>) | null = null;
  private server: Server | null = null;

  constructor(opts: { secret: string }) {
    this.secret = opts.secret;
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

    if (!RELEVANT_ACTIONS.has(action) || typeof repo !== "string" || typeof number !== "number") {
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

      req.on("error", () => {
        if (!responseSent && !res.destroyed && !res.writableEnded) {
          responseSent = true;
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Bad request");
        }
      });

      req.on("data", (chunk: Buffer) => {
        if (responseSent) return;
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          responseSent = true;
          res.writeHead(413, { "content-type": "text/plain" });
          res.end("Payload too large");
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (responseSent) return;
        responseSent = true;
        void this.handleRequest(Buffer.concat(chunks).toString("utf8"), req.headers["x-hub-signature-256"] as string | undefined).then(
          ({ status, body }) => {
            res.writeHead(status, { "content-type": "text/plain" });
            res.end(body);
          },
        );
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, resolve));
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
