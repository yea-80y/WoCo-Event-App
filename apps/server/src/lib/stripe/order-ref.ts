/**
 * Order references the server itself stored (#661, #642).
 *
 * An order's `orderRef` goes on chain beside the buyer's ticket, so it is public,
 * and the dashboard opens whatever sealed box a slot's ref points to. If checkout
 * took ANY ref a browser sent, one buyer could put another buyer's sealed order
 * against their own ticket: the organiser would see the first buyer's details on
 * the second ticket, and the copier would never fill in the form. Nothing is
 * disclosed (the box is sealed to the organiser) but the organiser's records would
 * lie. So:
 *
 *  1. CANONICAL BYTES. Every box is stored as exactly `{"v":…,"enc":…,"ct":…}` in
 *     that order. A ref is the content address of those bytes, so a copied box —
 *     however its JSON was rearranged — always lands on the ORIGINAL's ref.
 *  2. ISSUED REFS ONLY. `prepare-order` returns the ref with a token: an HMAC over
 *     (ref, issued-at) under a key derived from `PAYMENT_QUOTE_SECRET`. Checkout
 *     takes a client-supplied ref only with a valid, unexpired token — so every
 *     ref that reaches a mint is one this server uploaded as canonical bytes. No
 *     record is kept: the token is the record, and it survives restarts.
 *  3. ONE SALE PER REF. A ref already carried by ANOTHER completed sale
 *     (`TicketSale.orderRef`) is refused at checkout and, as a backstop, replaced at
 *     fulfilment by the buyer's own minimal seal. A multi-ticket purchase sharing
 *     one ref is one sale, and a retried checkout never completed its first try.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { isSealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";

/** A real order box is ~4.5 KB; 16 KB of JSON bounds what one call can stamp. */
export const MAX_ORDER_BOX_JSON = 16 * 1024;

/** How long a `prepare-order` token stays good — a buyer's form session, generously. */
export const ORDER_REF_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const TOKEN_PREFIX = "ort1";
const REF_RE = /^[0-9a-f]{64}$/;

/**
 * The exact bytes an order box is stored as, or null: a strict v2 box (#642)
 * within the cap. Fixed key order is what makes a copy collide with its original.
 */
export function canonicalOrderBox(x: unknown): string | null {
  if (!isSealedBoxV2(x)) return null;
  const json = JSON.stringify({ v: x.v, enc: x.enc, ct: x.ct });
  return json.length <= MAX_ORDER_BOX_JSON ? json : null;
}

function tokenKey(): Buffer {
  // Derived from an existing mandatory secret, domain-separated so an order-ref
  // token can never be mistaken for a checkout tag or a payment quote.
  const secret = process.env.PAYMENT_QUOTE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("PAYMENT_QUOTE_SECRET is missing or too short - order refs cannot be issued.");
  }
  return createHmac("sha256", secret).update("woco/order-ref-token/v1").digest();
}

function mac(ref: string, issuedSec: number): string {
  return createHmac("sha256", tokenKey()).update(`${ref}|${issuedSec}`).digest("hex");
}

/** A token binding `orderRef` to this server, issued now. */
export function issueOrderRefToken(orderRef: string, nowMs = Date.now()): string {
  const issued = Math.floor(nowMs / 1000);
  return `${TOKEN_PREFIX}.${issued}.${mac(orderRef.toLowerCase(), issued)}`;
}

/** True only for a token this server issued for exactly this ref, still in date. */
export function verifyOrderRefToken(orderRef: string, token: unknown, nowMs = Date.now()): boolean {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !/^\d{1,12}$/.test(parts[1])) return false;
  const issued = Number(parts[1]);
  const ageMs = nowMs - issued * 1000;
  // A little future skew is tolerated; an old token is not.
  if (ageMs > ORDER_REF_TOKEN_TTL_MS || ageMs < -60_000) return false;
  const expected = Buffer.from(mac(orderRef.toLowerCase(), issued));
  const got = Buffer.from(parts[2]);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * The client-supplied ref checkout may use, or undefined: well-formed AND carried
 * by a valid token. Anything else is ignored exactly as a malformed ref always was —
 * the inline box (if sent) is uploaded instead, else fulfilment seals the minimum.
 */
export function acceptedClientOrderRef(orderRef: unknown, token: unknown, nowMs = Date.now()): string | undefined {
  if (typeof orderRef !== "string") return undefined;
  const ref = orderRef.toLowerCase();
  if (!REF_RE.test(ref)) return undefined;
  return verifyOrderRefToken(ref, token, nowMs) ? ref : undefined;
}
