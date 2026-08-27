import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGithubSignature } from "../src/control/webhook-signature.js";

function sign(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("verifyGithubSignature", () => {
  it("accepts a correctly signed payload", () => {
    const payload = '{"action":"opened"}';
    expect(verifyGithubSignature(payload, sign(payload, "shhh"), "shhh")).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const payload = '{"action":"opened"}';
    const signature = sign(payload, "shhh");
    expect(verifyGithubSignature('{"action":"closed"}', signature, "shhh")).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const payload = '{"action":"opened"}';
    expect(verifyGithubSignature(payload, sign(payload, "wrong-secret"), "shhh")).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyGithubSignature('{"action":"opened"}', undefined, "shhh")).toBe(false);
  });

  it("rejects a malformed signature header (no sha256= prefix)", () => {
    expect(verifyGithubSignature('{"action":"opened"}', "not-a-real-signature", "shhh")).toBe(false);
  });
});
