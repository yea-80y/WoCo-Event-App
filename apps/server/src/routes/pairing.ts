/**
 * `/api/pairing/:id/:slot` (#746 step 4): the mailbox for linking another device.
 *
 * No session on either side: the device being linked has none yet, and making a
 * device the main passkey ends the old main's ownership partway through. The
 * messages are sealed under a key from the code the devices share, which this
 * server never sees (`lib/auth/pairing-mailbox.ts`).
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { jsonBodyLimit } from "../lib/http/body-limit.js";
import { clientIp } from "../lib/http/client-ip.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { PAIRING_BOX_RE, PAIRING_ID_RE, PAIRING_MAX_BOX_CHARS, isPairingSlot } from "@woco/shared";
import { getPairingSlot, putPairingSlot, type PairingPutResult } from "../lib/auth/pairing-mailbox.js";

export const pairing = new Hono<AppEnv>();

// A pairing is one offer; a retry after a reload is another. Answers and replies
// are one each per pairing.
const OFFER_IP = new SlidingWindowLimiter([{ limit: 10, windowMs: 10 * 60_000 }]);
const WRITE_IP = new SlidingWindowLimiter([{ limit: 30, windowMs: 10 * 60_000 }]);
// Both devices poll every couple of seconds for up to ten minutes, possibly from
// behind one address.
const READ_IP = new SlidingWindowLimiter([{ limit: 120, windowMs: 60_000 }]);
const MAX_BODY_BYTES = PAIRING_MAX_BOX_CHARS + 1024;

const PUT_REFUSALS: Record<Exclude<PairingPutResult, "ok">, { status: 409 | 410 | 503; error: string }> = {
  exists: { status: 409, error: "Already sent" },
  "out-of-order": { status: 409, error: "Not expected yet" },
  gone: { status: 410, error: "This code has expired" },
  full: { status: 503, error: "Linking is busy - try again in a minute" },
};

function params(c: { req: { param: (k: string) => string | undefined } }) {
  const id = c.req.param("id") ?? "";
  const slot = c.req.param("slot");
  return PAIRING_ID_RE.test(id) && isPairingSlot(slot) ? { id, slot } : null;
}

pairing.get("/:id/:slot", (c) => {
  if (!READ_IP.allow(`ip:${clientIp(c)}`)) return c.json({ ok: false, error: "Rate limited" }, 429);
  const p = params(c);
  if (!p) return c.json({ ok: false, error: "Not found" }, 404);
  const box = getPairingSlot(p.id, p.slot);
  c.header("Cache-Control", "no-store");
  if (box === "gone") return c.json({ ok: false, error: PUT_REFUSALS.gone.error, code: "gone" }, 410);
  return c.json({ ok: true, data: { box } });
});

pairing.post("/:id/:slot", jsonBodyLimit(MAX_BODY_BYTES), async (c) => {
  const p = params(c);
  if (!p) return c.json({ ok: false, error: "Not found" }, 404);
  const limiter = p.slot === "offer" ? OFFER_IP : WRITE_IP;
  if (!limiter.allow(`ip:${clientIp(c)}`)) return c.json({ ok: false, error: "Rate limited" }, 429);
  const box = ((await c.req.json().catch(() => null)) as { box?: unknown } | null)?.box;
  if (typeof box !== "string" || box.length > PAIRING_MAX_BOX_CHARS || !PAIRING_BOX_RE.test(box)) {
    return c.json({ ok: false, error: "Malformed message" }, 400);
  }
  const result = putPairingSlot(p.id, p.slot, box);
  if (result === "ok") return c.json({ ok: true });
  const { status, error } = PUT_REFUSALS[result];
  return c.json({ ok: false, error, code: result }, status);
});
