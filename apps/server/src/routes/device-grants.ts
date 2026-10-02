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
import { getStripeAccount } from "../lib/stripe/accounts.js";
import { refuseUnlessVerifiedOrganiser } from "../lib/stripe/verification.js";
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
// It is charged ONLY for a write that landed: a device shares its account's
// bucket, and refused or no-op submissions charged there would let a device
// spend the owner's budget and block its own removal. Every attempt is charged
// per IP instead.
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
  const ik = `ip:${clientIp(c)}`;
  if (!WRITE_ACCOUNT.peek(`a:${account}`) || !WRITE_IP.peek(ik)) return true;
  WRITE_IP.record(ik);
  return false;
}

function chargeAccount(account: string, result: DeviceGrantResult): void {
  if (result.ok && result.changed) WRITE_ACCOUNT.record(`a:${account}`);
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

// More than one passkey is an organiser tool for now (owner 10-02): each added device
// stamps storage, and moving the main passkey spends sponsored gas. An account that
// has a device record already passed, so it keeps managing its devices - a Stripe
// account asked for more details mid-handover must not leave its devices signed out.
// Removal is never gated.
const ORGANISERS_ONLY = "Adding passkeys is for verified organisers for now. Verify your Stripe account in Payments, then try again.";

deviceGrants.get("/", requireAuth, (c) => {
  const parent = c.get("parentAddress").toLowerCase();
  const records = listDeviceGrants(parent);
  if (!records) return c.json({ ok: false, error: REFUSALS["store-unavailable"].error }, 503);
  // A hint for the screen, from the local record: the write below checks Stripe live.
  const canAddDevices = records.length > 0 || getStripeAccount(parent)?.onboardingComplete === true;
  return c.json({ ok: true, data: { grants: records, sessionRank: c.get("sessionRank"), canAddDevices } });
});

deviceGrants.post("/", jsonBodyLimit(MAX_BODY_BYTES), requireAuth, async (c) => {
  const account = c.get("parentAddress").toLowerCase();
  if (writeLimited(c, account)) return c.json({ ok: false, error: "Rate limited" }, 429);
  const records = listDeviceGrants(account);
  if (!records) return answer(c, { ok: false, refusal: "store-unavailable" });
  if (records.length === 0) {
    const refusal = await refuseUnlessVerifiedOrganiser(account, ORGANISERS_ONLY);
    if (refusal) return c.json(refusal, 403);
  }
  const body = c.get("body") as { grant?: unknown; grantSig?: unknown };
  const result = await submitDeviceGrant(account, body, ownerCheck(c));
  chargeAccount(account, result);
  return answer(c, result);
});

deviceGrants.post("/revoke", jsonBodyLimit(MAX_BODY_BYTES), requireAuth, async (c) => {
  const account = c.get("parentAddress").toLowerCase();
  if (writeLimited(c, account)) return c.json({ ok: false, error: "Rate limited" }, 429);
  const body = c.get("body") as { revoke?: unknown; revokeSig?: unknown };
  const result = await submitDeviceGrantRevoke(account, body, ownerCheck(c));
  chargeAccount(account, result);
  return answer(c, result);
});
