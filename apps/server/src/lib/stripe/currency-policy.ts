/**
 * Which currency an organiser may price tickets in (#84).
 *
 * THE PROBLEM. Checkout offers usd/gbp/eur. Stripe converts a charge whose
 * currency the connected account has no bank account for into the account's
 * `default_currency`, and takes its conversion fee out of the organiser's
 * proceeds — silently, on every sale. Refunds after conversion convert back at a
 * different rate, so the organiser loses on the spread twice. The payout sweep
 * already handles the mechanics correctly (settlement-currency regrouping, so
 * nothing strands), but the organiser is paying a fee they never agreed to.
 *
 * THE DECISION (owner, 2026-07-29). Restrict rather than surface: an organiser
 * may only price in their own account's default currency. Right for a UK-only
 * launch, and it makes the silent fee impossible instead of merely disclosed.
 * Option (2) — allow it with a warning — is the revisit when non-UK organisers
 * arrive, and needs only this module to change.
 *
 * FAIL-OPEN, DELIBERATELY. An unknown default currency permits everything.
 * Stripe assigns `default_currency` during onboarding, so a brand-new organiser
 * legitimately has none yet, and an account created before this field existed
 * has none cached. Treating "unknown" as "reject" would block real organisers
 * from creating any paid event on the strength of a value we simply have not
 * fetched. The cost of the open direction is bounded and pre-existing: the
 * organiser pays Stripe's FX fee, exactly as they did before this module — no
 * money strands and nothing breaks.
 */

import type { FiatCurrency } from "@woco/shared";
import { getStripeAccount } from "./accounts.js";

export interface CurrencyVerdict {
  allowed: boolean;
  /** The account's default currency, lowercase, when known. */
  defaultCurrency?: string;
  /** Organiser-facing copy. Present only when `allowed` is false. */
  reason?: string;
}

/**
 * May this organiser price a series in `currency`?
 *
 * @param currency the requested pricing currency, any case.
 */
export function currencyAllowedFor(organiserAddress: string, currency: string): CurrencyVerdict {
  const requested = currency.toLowerCase();
  const defaultCurrency = getStripeAccount(organiserAddress)?.defaultCurrency;

  // Not yet known — see the fail-open note above.
  if (!defaultCurrency) return { allowed: true };

  if (requested === defaultCurrency) return { allowed: true, defaultCurrency };

  return {
    allowed: false,
    defaultCurrency,
    reason:
      `Your Stripe account pays out in ${defaultCurrency.toUpperCase()}, so tickets must be priced in ` +
      `${defaultCurrency.toUpperCase()}. Pricing in ${requested.toUpperCase()} would make Stripe convert ` +
      `every sale and charge you a conversion fee out of your own proceeds.`,
  };
}

/**
 * Currencies this organiser may choose from, for the UI picker.
 *
 * Returns every supported currency when the default is unknown, matching the
 * fail-open rule above — the picker must not present an empty list to an
 * organiser mid-onboarding.
 */
export function allowedCurrencies(
  organiserAddress: string,
  supported: readonly FiatCurrency[],
): FiatCurrency[] {
  const defaultCurrency = getStripeAccount(organiserAddress)?.defaultCurrency;
  if (!defaultCurrency) return [...supported];
  const match = supported.filter((c) => c.toLowerCase() === defaultCurrency);
  // A default outside our supported set (an organiser banking in, say, AUD) must
  // not produce an empty picker either. Fall back to the full list and let the
  // FX warning stand — restricting to nothing would lock them out entirely.
  return match.length > 0 ? match : [...supported];
}
