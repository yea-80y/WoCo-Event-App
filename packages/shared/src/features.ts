/**
 * Platform-wide feature flags. Compile-time constants — flipping these
 * changes both client UI defaults and server validation in lock-step so
 * an old client can't bypass a closed feature via the API.
 */
export const FEATURES = {
  freeEventsAllowed: false,
  // Deferred to #41, not deleted. The crypto rail is half-built: payment verifies
  // on-chain but the ticket mints Swarm-only (claims.ts has no on-chain branch),
  // so crypto buyers get a weaker "ledger" verdict at the door and stay platform-
  // signed. De-platforming it needs events to register with a real priceBaseUnits
  // (today 0n) + a client-side payAndClaimWithPermit flow. Off for launch so the
  // half-rail is unreachable; flip back on with that work. Gates UI + server
  // validation in lockstep — an old client can't offer crypto past the API.
  cryptoPaymentsAllowed: false,
} as const;

/** Minimum buyer-pays fee % (3% Stripe + 1.5% WoCo). UI snaps below this back up. */
export const BUYER_FEE_FLOOR_PCT = 4.5;

/** Default buyer-pays fee % when the toggle is first turned on. */
export const BUYER_FEE_DEFAULT_PCT = 10;
