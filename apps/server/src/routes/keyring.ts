/**
 * POST /api/keyring/refresh (#186): "my account's key ring just moved". A device calls
 * it the moment its removal (or its new passkey's keys) landed onchain, so this server
 * reads the account's ring from the chain now instead of when its cache runs out.
 *
 * Nothing is taken from the request but who is asking: the answer is the chain's, the
 * same any reader gets. Authenticated so one caller cannot spend the RPC budget for
 * every account; limited per account and per IP.
 */
import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { clientIp } from "../lib/http/client-ip.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { currentRing, MAX_KEY_RING_BYTES } from "../lib/keyring/current-ring.js";
import { jsonBodyLimit } from "../lib/http/body-limit.js";
import { checkAttendeeGate } from "../lib/gate/check.js";
import { uploadToBytes } from "../lib/swarm/bytes.js";
import { whitelistHashes } from "../lib/swarm/whitelist.js";
import { encodeKeyRing, parseKeyRing } from "@woco/shared/keyring/ring";
import { ORDER_KEY_BYTES, orderKeyRef } from "@woco/shared";
import { bytesTreeChunks } from "@woco/shared/swarm/bytes-tree";

export const keyring = new Hono<AppEnv>();

const PER_ACCOUNT = new SlidingWindowLimiter([{ limit: 10, windowMs: 60_000 }]);
const PER_IP = new SlidingWindowLimiter([{ limit: 30, windowMs: 60_000 }]);

keyring.post("/refresh", requireAuth, async (c) => {
  const account = c.get("parentAddress").toLowerCase();
  const ik = `ip:${clientIp(c)}`;
  if (!PER_ACCOUNT.peek(account) || !PER_IP.peek(ik)) {
    c.header("Retry-After", "60");
    return c.json({ ok: false, error: "Too many requests - wait a minute and try again." }, 429);
  }
  PER_ACCOUNT.record(account);
  PER_IP.record(ik);
  const r = await currentRing(account, { fresh: true });
  if (r.status === "unavailable") {
    console.warn(`[keyring] refresh for ${account}: ${r.reason}`);
    return c.json({ ok: false, error: "Couldn't read your account's keys from the network - try again." }, 503);
  }
  return c.json({ ok: true, data: r.status === "ring" ? { ref: r.ref, gen: r.ring.gen } : null });
});

const RING_PER_ACCOUNT = new SlidingWindowLimiter([
  { limit: 10, windowMs: 60 * 60_000 },
  { limit: 30, windowMs: 24 * 60 * 60_000 },
]);

/**
 * POST /api/keyring/ring {dataB64} - store a key ring so any device can read it back
 * through the gateway (#186). Only a well-formed ring naming the caller's OWN account is
 * taken: this is not a general upload, and the gateway serves exactly its chunks. It is
 * stamped on the platform batch (small, long-lived, ours to keep alive); the account
 * itself then names it onchain. Storing one changes nothing until the anchor does.
 */
keyring.post("/ring", jsonBodyLimit(MAX_KEY_RING_BYTES * 2), requireAuth, async (c) => {
  const account = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as { dataB64?: unknown; orderKeyB64?: unknown } | undefined;
  if (typeof body?.dataB64 !== "string") return c.json({ ok: false, error: "Missing dataB64" }, 400);
  const bytes = new Uint8Array(Buffer.from(body.dataB64, "base64"));
  if (bytes.length < 1 || bytes.length > MAX_KEY_RING_BYTES) return c.json({ ok: false, error: "Ring too large" }, 413);
  // The generation's order key travels with its ring: buyers seal to it the moment the
  // ring is named, so it must already be readable through the gateway.
  const orderKey = typeof body.orderKeyB64 === "string" ? new Uint8Array(Buffer.from(body.orderKeyB64, "base64")) : null;
  let ringOrderKeyRef: string;
  try {
    const ring = parseKeyRing(bytes);
    ringOrderKeyRef = ring.orderKeyRef;
    // Byte for byte the canonical encoding, nothing else: JSON.parse forgives duplicate
    // keys and whitespace, and the gateway is about to serve exactly these bytes - a
    // "ring" with anything smuggled beside its fields is not stored.
    if (Buffer.compare(Buffer.from(encodeKeyRing(ring)), Buffer.from(bytes)) !== 0) {
      return c.json({ ok: false, error: "Not a key ring this server reads" }, 400);
    }
    if (ring.parent !== account) return c.json({ ok: false, error: "This ring is for a different account" }, 403);
  } catch {
    return c.json({ ok: false, error: "Not a key ring this server reads" }, 400);
  }
  if (orderKey && (orderKey.length !== ORDER_KEY_BYTES || orderKeyRef(orderKey) !== ringOrderKeyRef)) {
    return c.json({ ok: false, error: "That order key is not this ring's" }, 400);
  }
  if (!RING_PER_ACCOUNT.peek(account)) {
    c.header("Retry-After", "3600");
    return c.json({ ok: false, error: "Too many key changes - try again later." }, 429);
  }
  // Every key change is a sponsored op only an unlocked account gets; the ring rides on it.
  if (!(await checkAttendeeGate(account)).gated) return c.json({ ok: false, error: "ticket_required" }, 403);
  RING_PER_ACCOUNT.record(account);
  try {
    const chunks = bytesTreeChunks(bytes);
    const expected = chunks.at(-1)!.address;
    const ref = (await uploadToBytes(bytes)).toLowerCase().replace(/^0x/, "");
    if (ref !== expected) {
      console.error(`[keyring] ring upload for ${account} returned ${ref}, expected ${expected}`);
      return c.json({ ok: false, error: "The ring could not be stored - try again." }, 502);
    }
    const whitelist = chunks.map((ch) => ch.address);
    if (orderKey) {
      const keyRef = (await uploadToBytes(orderKey)).toLowerCase().replace(/^0x/, "");
      if (keyRef !== ringOrderKeyRef) throw new Error(`order key upload returned ${keyRef}`);
      whitelist.push(keyRef);
    }
    await whitelistHashes(whitelist);
    return c.json({ ok: true, data: { ref } });
  } catch (err) {
    console.error("[keyring] ring store failed:", (err as Error)?.message ?? err);
    return c.json({ ok: false, error: "The ring could not be stored - try again." }, 502);
  }
});

