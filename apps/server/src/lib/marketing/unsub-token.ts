/**
 * Unsubscribe token — the credential inside every List-Unsubscribe URL and
 * footer link. Commits to {emailHash, organiser} via HMAC so the /u endpoint
 * can suppress statelessly without ever learning the plaintext address.
 *
 * Same trust pattern as the gate token (lib/gate/token.ts): key derived from
 * EMAIL_HASH_SECRET, `mu1.{base64url payload}.{hmac hex}` format.
 *
 * Deliberately NO expiry: an unsubscribe link that stops working is a spam
 * complaint waiting to happen — RFC 8058 links must keep working indefinitely.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface UnsubTokenPayload {
  /** HMAC email hash of the recipient */
  h: string;
  /** Organiser address, lowercase */
  o: string;
  v: 1;
}

function tokenKey(): Buffer {
  const secret = process.env.EMAIL_HASH_SECRET;
  if (!secret) throw new Error("EMAIL_HASH_SECRET is not set");
  return createHmac("sha256", secret).update("woco-unsub-token-v1").digest();
}

function sign(payloadB64: string): string {
  return createHmac("sha256", tokenKey()).update(payloadB64).digest("hex");
}

export function mintUnsubToken(input: { emailHash: string; organiserAddress: string }): string {
  const payload: UnsubTokenPayload = {
    h: input.emailHash,
    o: input.organiserAddress.toLowerCase(),
    v: 1,
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `mu1.${b64}.${sign(b64)}`;
}

export type UnsubTokenVerdict =
  | { ok: true; payload: UnsubTokenPayload }
  | { ok: false; reason: "malformed" | "bad-signature" };

export function verifyUnsubToken(token: string): UnsubTokenVerdict {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "mu1") return { ok: false, reason: "malformed" };
  const [, b64, sig] = parts;

  const expected = Buffer.from(sign(b64), "hex");
  let presented: Buffer;
  try {
    presented = Buffer.from(sig, "hex");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: UnsubTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf-8")) as UnsubTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.h !== "string" || typeof payload.o !== "string" || payload.v !== 1) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, payload };
}
