/**
 * Platform-wide feature flags. Compile-time constants — flipping these
 * changes both client UI defaults and server validation in lock-step so
 * an old client can't bypass a closed feature via the API.
 */
export const FEATURES = {
  freeEventsAllowed: false,
  cryptoPaymentsAllowed: true,
} as const;

/** Minimum buyer-pays fee % (3% Stripe + 1.5% WoCo). UI snaps below this back up. */
export const BUYER_FEE_FLOOR_PCT = 4.5;

/** Default buyer-pays fee % when the toggle is first turned on. */
export const BUYER_FEE_DEFAULT_PCT = 10;
