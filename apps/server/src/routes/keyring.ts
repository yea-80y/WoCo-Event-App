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
import { currentRing } from "../lib/keyring/current-ring.js";

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
