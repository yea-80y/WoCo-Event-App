/**
 * `/api/auth/device-grants` (#746 step 2): add and remove an account's passkeys.
 *
 * The signatures in the body are the authority, not the session: a grant must be
 * signed by the account's current owner, a removal by the owner or by the device
 * being removed (lib/auth/device-grants.ts). The session only ties the request to
 * an account for the rate limit, so these routes behave the same if the list
 * itself moves onchain.
 */

import { Hono, type Context } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { jsonBodyLimit } from "../lib/http/body-limit.js";
import { clientIp } from "../lib/http/client-ip.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { isKernelOwner } from "../lib/auth/kernel-owner.js";
import { takeOwnerReadBudget } from "../lib/auth/owner-read-budget.js";
import {
  listDeviceGrants,
  submitDeviceGrant,
  submitDeviceGrantRevoke,
  type DeviceGrantResult,
  type DeviceGrantRefusal,
  type OwnerCheck,
} from "../lib/auth/device-grants.js";

export const deviceGrants = new Hono<AppEnv>();

// Every write appends a nonce that is never pruned, so the per-account bound is
// also the store's growth bound. Adding a few devices in a sitting is a handful.
const WRITE_ACCOUNT = new SlidingWindowLimiter([
  { limit: 5, windowMs: 60_000 },
  { limit: 30, windowMs: 24 * 60 * 60_000 },
]);
const WRITE_IP = new SlidingWindowLimiter([{ limit: 30, windowMs: 60_000 }]);
// One statement and a 65-byte signature.
const MAX_BODY_BYTES = 4 * 1024;

const REFUSALS: Record<DeviceGrantRefusal, { status: 400 | 403 | 404 | 409 | 503; error: string }> = {
  malformed: { status: 400, error: "Malformed device grant" },
  "bad-signature": { status: 400, error: "Invalid signature" },
  "wrong-account": { status: 403, error: "This grant is for a different account" },
  "not-owner": { status: 403, error: "Only the account's main passkey can add a device" },
  "not-allowed": { status: 403, error: "Only the main passkey or the device itself can remove a device" },
  "nonce-used": { status: 409, error: "This statement was already submitted" },
  "cap-reached": { status: 409, error: "This account already has the maximum number of devices" },
  "not-found": { status: 404, error: "No such device on this account" },
  "store-unavailable": { status: 503, error: "Devices cannot be changed right now" },
};

function writeLimited(c: { req: { header: (n: string) => string | undefined } }, account: string): boolean {
  const ak = `a:${account}`;
  const ik = `ip:${clientIp(c)}`;
  if (!WRITE_ACCOUNT.peek(ak) || !WRITE_IP.peek(ik)) return true;
  WRITE_ACCOUNT.record(ak);
  WRITE_IP.record(ik);
  return false;
}

function ownerCheck(c: { req: { header: (n: string) => string | undefined } }): OwnerCheck {
  return (signer, parent) =>
    isKernelOwner(signer, parent, { chainReadAllowed: () => takeOwnerReadBudget(clientIp(c)) });
}

function answer(c: Context<AppEnv>, result: DeviceGrantResult) {
  if (result.ok) return c.json({ ok: true, data: result.record });
  const { status, error } = REFUSALS[result.refusal];
  return c.json({ ok: false, error, code: result.refusal }, status);
}

deviceGrants.get("/", requireAuth, (c) => {
  const records = listDeviceGrants(c.get("parentAddress"));
  if (!records) return c.json({ ok: false, error: REFUSALS["store-unavailable"].error }, 503);
  return c.json({ ok: true, data: { grants: records, sessionRank: c.get("sessionRank") } });
});

deviceGrants.post("/", jsonBodyLimit(MAX_BODY_BYTES), requireAuth, async (c) => {
  const account = c.get("parentAddress").toLowerCase();
  if (writeLimited(c, account)) return c.json({ ok: false, error: "Rate limited" }, 429);
  const body = c.get("body") as { grant?: unknown; grantSig?: unknown };
  return answer(c, await submitDeviceGrant(account, body, ownerCheck(c)));
});

deviceGrants.post("/revoke", jsonBodyLimit(MAX_BODY_BYTES), requireAuth, async (c) => {
  const account = c.get("parentAddress").toLowerCase();
  if (writeLimited(c, account)) return c.json({ ok: false, error: "Rate limited" }, 429);
  const body = c.get("body") as { revoke?: unknown; revokeSig?: unknown };
  return answer(c, await submitDeviceGrantRevoke(account, body, ownerCheck(c)));
});
