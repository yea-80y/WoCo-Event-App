/**
 * Payouts API — the organiser's own held and released takings, plus the door to
 * their Stripe Express Dashboard.
 *
 * Every call here can fail in a way the organiser has to be told about, so
 * nothing throws past this boundary: loads return a result the screen can render
 * as either data or a reason, and the reason is always something a person can
 * act on (`classifyFailure`).
 */

import type { PayoutsResponse } from "@woco/shared";
import { authGet, authPost } from "./client.js";
import { cacheGet, cacheSet, cacheKey, TTL } from "../cache/cache.js";
import { classifyFailure, type PayoutsFailure } from "../creator/payouts/payouts-model.js";

export type PayoutsLoad =
  | { ok: true; data: PayoutsResponse }
  | { ok: false; error: PayoutsFailure };

/**
 * Stale-while-revalidate, same contract as creator-cache.ts: paint `cached`
 * immediately, then patch with `refresh()`.
 *
 * Unlike the creator lists, refresh reports WHY it failed rather than returning
 * null — a stale balance shown with no warning is worse than a stale balance
 * shown with one.
 */
export function getPayoutsSWR(address: string): {
  cached: PayoutsResponse | null;
  refresh: () => Promise<PayoutsLoad>;
} {
  const key = cacheKey.payouts(address);
  const cached = cacheGet<PayoutsResponse>(key);

  const refresh = async (): Promise<PayoutsLoad> => {
    try {
      const resp = await authGet<PayoutsResponse>("/api/stripe/payouts");
      if (!resp.ok || !resp.data) {
        return { ok: false, error: classifyFailure(resp.error ?? "Empty response") };
      }
      // An empty ledger is a real answer here (no sales yet), unlike the creator
      // lists where empty usually means a transient auth mismatch — so it is
      // cached like any other result.
      cacheSet(key, resp.data, TTL.PAYOUTS);
      return { ok: true, data: resp.data };
    } catch (err) {
      return { ok: false, error: classifyFailure(err) };
    }
  };

  return { cached, refresh };
}

/**
 * Mint a single-use Express Dashboard login link and return its URL.
 *
 * Stripe requires this to be used immediately and never shared out of band, so
 * the caller redirects straight away and we never persist it. Minted per click —
 * there is deliberately no caching here.
 */
export async function getStripeDashboardUrl(): Promise<
  { ok: true; url: string } | { ok: false; error: PayoutsFailure }
> {
  try {
    const resp = await authPost<never>("/api/stripe/dashboard-link", {});
    const data = resp as { ok: boolean; url?: string; error?: string };
    if (!data.ok || !data.url) {
      const failure = classifyFailure(data.error ?? "No dashboard link returned");
      return {
        ok: false,
        // The server's 400s here are actionable organiser-facing sentences
        // ("finish verification first") — pass them through rather than
        // flattening them into the generic load message.
        error: failure.kind === "server" && data.error
          ? { ...failure, message: data.error }
          : failure,
      };
    }
    return { ok: true, url: data.url };
  } catch (err) {
    return { ok: false, error: classifyFailure(err) };
  }
}
