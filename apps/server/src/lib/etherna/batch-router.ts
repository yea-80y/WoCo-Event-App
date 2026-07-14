/**
 * Decide which postage batch + upload target a given deploy should use.
 *
 * Rules (locked 2026-05-18, see docs/REALIGNMENT_2026-05-18_v2.md):
 *   - WoCo gateway picked → always platform woco batch (testing escape hatch).
 *   - Etherna gateway + user has a LIVE batch → reuse it (covers websites AND events).
 *   - Etherna gateway + no live user batch + event deploy → fall back to shared
 *     ETHERNA_PLATFORM_BATCH (events never trigger a purchase).
 *   - Etherna gateway + no live user batch + website deploy → throw. UI must call
 *     POST /api/etherna/purchase-batch before retrying.
 *
 * EXPIRY (2026-07-14): an EXPIRED batch is treated as NO batch. Stamping onto a dead
 * batch is the worst failure mode we have — the upload returns 200 and Etherna's own
 * gateway keeps serving the content from local storage, so it looks deployed, while
 * the chunks never survive on the public net. Every deploy by that user is then a
 * silent no-op discoverable only by reading from an unrelated bee. Fail over (events)
 * or fail loudly (websites) instead.
 */

import { POSTAGE_BATCH_ID } from "../../config/swarm.js";
import { getUserBatch } from "./batches.js";

export type DeployType = "event" | "website";
export type UploadTarget = "wocoBee" | "etherna";

export interface BatchSelection {
  batchId: string;
  target: UploadTarget;
  /** Set when a WEBSITE deploy landed on the shared platform batch via the
   *  free-hosting promo — the caller must apply the per-owner byte quota. */
  freeHosted?: boolean;
}

const ETHERNA_URL = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";
const WOCO_URL = "https://gateway.woco-net.com";

export class BatchPurchaseRequired extends Error {
  constructor() {
    super("Etherna website deploy requires a user batch. Call POST /api/etherna/purchase-batch first.");
    this.name = "BatchPurchaseRequired";
  }
}

export class StripeVerificationRequired extends Error {
  constructor() {
    super("Free website hosting requires a verified Stripe account. Complete identity verification in Dashboard → Payments, then deploy again.");
    this.name = "StripeVerificationRequired";
  }
}

function isEthernaGateway(url: string): boolean {
  try {
    return new URL(url).host.endsWith(new URL(ETHERNA_URL).host);
  } catch {
    return url === ETHERNA_URL;
  }
}

/**
 * Minimum life a batch must have left to be worth stamping onto. A batch that
 * expires an hour from now would take the deploy down with it, so it is no more
 * useful than an already-dead one.
 */
const MIN_BATCH_REMAINING_MS = 60 * 60 * 1000;

/**
 * Launch promo: host user WEBSITES on the shared platform batch instead of making
 * them buy their own. Default ON — the Stripe purchase gate does not exist yet, so
 * without this a website deploy has no reachable path at all. Set FREE_HOSTING=false
 * once that gate ships; BatchPurchaseRequired then resumes and the UI sells a batch.
 *
 * The platform batch's TTL becomes the lifetime of every free-hosted site, so keeping
 * it topped up is what "free hosting" actually means operationally.
 */
const FREE_HOSTING = process.env.FREE_HOSTING !== "false";

/** True if the registry says this batch still has usable life left. */
function isLive(batch: { expiresAt: string }): boolean {
  const expiresAt = Date.parse(batch.expiresAt);
  // An unparseable expiry is not evidence of life — treat it as dead rather than
  // risk another silent stamp onto a dead batch.
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt - Date.now() > MIN_BATCH_REMAINING_MS;
}

function isWocoGateway(url: string): boolean {
  try {
    return new URL(url).host.endsWith(new URL(WOCO_URL).host);
  } catch {
    return url === WOCO_URL;
  }
}

interface RouterInput {
  ownerAddress: string;
  gatewayUrl: string;
  deployType: DeployType;
  /** Stripe-verified organiser (charges_enabled) — gates the FREE_HOSTING
   *  fallback for website deploys. Callers resolve it via isVerifiedOrganiser();
   *  irrelevant for events and for owners with their own live batch. */
  freeHostingEligible?: boolean;
}

export function batchForDeploy(input: RouterInput): BatchSelection {
  const { ownerAddress, gatewayUrl, deployType } = input;

  if (isWocoGateway(gatewayUrl) || !isEthernaGateway(gatewayUrl)) {
    if (!POSTAGE_BATCH_ID) {
      throw new Error("POSTAGE_BATCH_ID not configured — cannot deploy via WoCo gateway");
    }
    console.log(`[batch-router] ${deployType} deploy → wocoBee batch ${POSTAGE_BATCH_ID.slice(0, 12)}…`);
    return { batchId: POSTAGE_BATCH_ID, target: "wocoBee" };
  }

  const user = getUserBatch(ownerAddress);
  if (user && isLive(user)) {
    console.log(`[batch-router] ${deployType} deploy → etherna USER batch ${user.batchId.slice(0, 12)}… (owner ${ownerAddress.slice(0, 10)}…)`);
    return { batchId: user.batchId, target: "etherna" };
  }
  if (user) {
    console.warn(
      `[batch-router] user batch ${user.batchId.slice(0, 12)}… for ${ownerAddress.slice(0, 10)}… EXPIRED at ${user.expiresAt} — treating as absent`,
    );
  }

  // Websites fall back to the platform batch only while free hosting is on (the
  // launch promo). Flipping FREE_HOSTING off restores BatchPurchaseRequired, which
  // is what the Stripe purchase gate will hang off — the user then buys their own
  // batch. Events ALWAYS fall back: they never trigger a purchase.
  if (deployType === "event" || FREE_HOSTING) {
    // Free hosting is a shared-batch subsidy, so it is gated: only Stripe-verified
    // organisers (same charges_enabled check as paid-event publishing) get it.
    // Events are exempt — they never trigger a purchase or a gate.
    if (deployType === "website" && input.freeHostingEligible === false) {
      throw new StripeVerificationRequired();
    }
    const platform = process.env.ETHERNA_PLATFORM_BATCH;
    if (!platform) {
      throw new Error("ETHERNA_PLATFORM_BATCH not configured — cannot fall back for " + deployType + " deploy");
    }
    console.log(`[batch-router] ${deployType} deploy → etherna PLATFORM batch ${platform.slice(0, 12)}…${deployType === "website" ? " (FREE_HOSTING)" : ""} (no live user batch for ${ownerAddress.slice(0, 10)}…)`);
    return { batchId: platform, target: "etherna", ...(deployType === "website" ? { freeHosted: true } : {}) };
  }

  throw new BatchPurchaseRequired();
}
