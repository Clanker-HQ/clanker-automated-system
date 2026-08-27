import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies GitHub's `X-Hub-Signature-256` header. Uses a constant-time
 * comparison (`timingSafeEqual`) rather than `===` — a naive string compare
 * leaks timing information an attacker could use to guess the correct
 * signature byte by byte, defeating the point of signing in the first place.
 */
export function verifyGithubSignature(payload: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
