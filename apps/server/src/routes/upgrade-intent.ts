/**
 * `POST /api/auth/upgrade-intent` (#746): the signed-in account asks to upgrade to a
 * passkey, just before it sends the op. For a LOCKED account the sponsorship policy
 * pays that op only against an unspent intent (lib/zerodev/upgrade-intents.ts), and
 * this is the one place the person's IP is seen - ZeroDev's servers make the policy
 * call - so the per-network limit stands here.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { jsonBodyLimit } from "../lib/http/body-limit.js";
import { clientIp } from "../lib/http/client-ip.js";
import { upgradeIntents } from "../lib/zerodev/upgrade-intents.js";

export const UPGRADE_LIMIT_MESSAGE = "Too many upgrades from this network today - try again tomorrow.";

export const upgradeIntent = new Hono<AppEnv>();

upgradeIntent.post("/", jsonBodyLimit(1024), requireAuth, (c) => {
  const account = (c.get("parentAddress") as string).toLowerCase();
  const ip = clientIp(c);
  if (!upgradeIntents.grant(account, ip)) {
    // A shared egress turning real people away shows here first (and in /api/health).
    console.warn(`[upgrade-intent] network limit reached for ${ip}`);
    return c.json({ ok: false, error: UPGRADE_LIMIT_MESSAGE, code: "upgrade_limit" }, 429);
  }
  return c.json({ ok: true });
});
