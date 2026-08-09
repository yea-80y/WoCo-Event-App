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
  // The MCP agent-commerce rail (/api/agent/quote + /buy): an agent draws USDC under a
  // spend permission the user signed on-chain. Was ON as a deliberate "opt-in, so the
  // blast radius is zero" call; turned OFF because the blast radius stopped being zero:
  // it minted through the v1 Swarm rail, which could charge the buyer and mint nothing.
  // That rail is now DELETED — settleAgentTicketPurchase refuses outright (see
  // lib/agent/spend-authority.ts). Turn on with a v2 on-chain mint path, not before.
  agentCommerceAllowed: false,
  // Organiser custom sending domains. OFF for launch, for two independent
  // reasons: the production Resend key is send-only, so the Domains API 401s and
  // the panel could only ever show an error; and PRICING_AND_EMAIL.md §6 forbids
  // onboarding organiser domains on Resend at all — 2 domains each against a Pro
  // cap of 10, and migrating to SES later would make every organiser redo their
  // DNS. Turn on with the SES provider work (§14 E10), not before.
  organiserSendingDomains: false,
} as const;

/** Minimum buyer-pays fee % (3% Stripe + 1.5% WoCo). UI snaps below this back up. */
export const BUYER_FEE_FLOOR_PCT = 4.5;

/** Default buyer-pays fee % when the toggle is first turned on. */
export const BUYER_FEE_DEFAULT_PCT = 10;
