/**
 * What create-checkout answers when the sponsor cannot mint (#662).
 *
 * Split out of the route so the retry promise can be tested: a refusal from the
 * ledger's hourly cap is the one case where "try again later" is sometimes
 * true and sometimes a lie. When the owner has set the cap to 0 the window
 * reset lifts nothing, and an order larger than a whole window's cap never
 * fits — so neither names a time, and neither sends `Retry-After`.
 */

import type { SponsorMintVerdict } from "../chain/sponsor-wallet.js";

export interface SponsorGateRefusal {
  status: 503;
  /** Buyer-facing. */
  error: string;
  /** Seconds, for the `Retry-After` header. Only when waiting will help. */
  retryAfterSeconds?: number;
  /** Operator-facing, for the BLOCKED log line. */
  log: string;
}

const UNAVAILABLE_SHORTLY = "Ticketing is temporarily unavailable — please try again shortly.";

/**
 * `null` = let the checkout proceed. `"config-error"` is a misconfiguration the
 * caller already logged: it never heals, so it refuses like an unauthorised
 * sponsor does.
 */
export function sponsorGateRefusal(
  verdict: SponsorMintVerdict | "config-error",
  quantity: number,
  nowMs: number,
): SponsorGateRefusal | null {
  if (verdict === "config-error") {
    return { status: 503, error: UNAVAILABLE_SHORTLY, log: "event contract misconfigured" };
  }
  if (verdict.ok) return null;
  if (verdict.reason === "not-authorised") {
    return { status: 503, error: UNAVAILABLE_SHORTLY, log: "sponsor not authorised" };
  }
  if (verdict.perHour === 0) {
    return {
      status: 503,
      error: "Ticketing is temporarily unavailable.",
      log: "sponsor mint cap is 0 (stopped by the contract owner)",
    };
  }
  if (verdict.retryAt === null) {
    return {
      status: 503,
      error: "Ticketing can't take an order this size right now - please try fewer tickets.",
      log: `order of ${quantity} exceeds the sponsor's whole hourly cap (${verdict.perHour}/h)`,
    };
  }
  const seconds = Math.max(1, Math.ceil(verdict.retryAt - nowMs / 1000));
  const minutes = Math.ceil(seconds / 60);
  return {
    status: 503,
    error: `Ticketing is at capacity right now - please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    retryAfterSeconds: seconds,
    log:
      `sponsor hourly mint cap reached (${verdict.mintable}/${verdict.perHour} left, order ${quantity}; ` +
      `resets ${new Date(verdict.retryAt * 1000).toISOString()})`,
  };
}
