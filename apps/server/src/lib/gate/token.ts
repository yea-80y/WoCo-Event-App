/**
 * Route A gate token — the single-use "Create your WoCo profile" credential
 * embedded in ticket emails (docs/ATTENDEE_GATE_RESALE_PLAN.md §3, Route A).
 *
 * Clicking the link proves control of the purchase inbox: the token is minted
 * ONLY at ticket-email send time (Stripe webhook path), where the recipient IS
 * the verified purchase email. It commits to the exact ticket + emailHash via
 * HMAC, same trust pattern as PaymentQuote. One-shot consumption is the gate
 * binding nullifier itself — the first redeem binds the edition and every
 * later attempt hits "already unlocked" (first click wins; forwarding the
 * email is implicit consent for group buys).
 *
 * Format: `gt1.{base64url(payload JSON)}.{hmac-sha256 hex}`
 * Key: derived from EMAIL_HASH_SECRET (mandatory at startup) so no new env
 * var / deploy step is needed. Rotating that secret invalidates outstanding
 * tokens AND changes stored emailHashes — same blast radius either way.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Emails sit in inboxes — keep the window generous. Route B remains the
 *  fallback for anyone who clicks after expiry. */
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface GateTokenPayload {
  eventId: string;
  seriesId: string;
  edition: number;
  /** HMAC email hash of the recipient — recorded on the binding. */
  emailHash: string;
  /** Expiry, ms epoch. */
  exp: number;
}

function tokenKey(): Buffer {
  const secret = process.env.EMAIL_HASH_SECRET;
  if (!secret) throw new Error("EMAIL_HASH_SECRET is not set");
  return createHmac("sha256", secret).update("woco-gate-token-v1").digest();
}

function sign(payloadB64: string): string {
  return createHmac("sha256", tokenKey()).update(payloadB64).digest("hex");
}

export function mintGateToken(input: Omit<GateTokenPayload, "exp">): string {
  const payload: GateTokenPayload = { ...input, exp: Date.now() + TOKEN_TTL_MS };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `gt1.${b64}.${sign(b64)}`;
}

export type GateTokenVerdict =
  | { ok: true; payload: GateTokenPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

export function verifyGateToken(token: string): GateTokenVerdict {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "gt1") return { ok: false, reason: "malformed" };
  const [, b64, sig] = parts;

  const expected = Buffer.from(sign(b64), "hex");
  const presented = Buffer.from(sig, "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: GateTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf-8")) as GateTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.eventId !== "string" ||
    typeof payload.seriesId !== "string" ||
    !Number.isInteger(payload.edition) ||
    typeof payload.emailHash !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (Date.now() > payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
