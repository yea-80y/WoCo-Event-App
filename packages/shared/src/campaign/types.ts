/**
 * Onboarding-campaign EAS schemas — referrals + cohort badges. Single source
 * of truth shared by the client write path and the server relay/issuer.
 *
 * Both are EAS attestations on Arbitrum Sepolia, alongside the likes schema
 * (see ../likes/types.ts, which owns the chain constants). NOT NFTs, NOT PODs:
 * these are participation facts, and the future token distribution reads them
 * as an on-chain ledger.
 *
 * REFERRAL — "merchant M was referred by R":
 *   attester  = the referred merchant's own account (via delegated attestation
 *               so the merchant pays no gas — the server relays and pays)
 *   recipient = the referrer (credit flows to the EAS recipient field)
 *   data      = `address referrer` (duplicated from recipient so the fact
 *               survives indexers that ignore recipient)
 *   revocable = FALSE — attribution is permanent; nobody, including the
 *               platform, can reassign who referred whom. Payout policy
 *               (percentages, duration, disputes) lives off-chain.
 *
 * BADGE — "the platform certifies this user joined in epoch N":
 *   attester  = the platform key (self-attested "I'm early" proves nothing;
 *               the badge's value is that the platform vouches)
 *   recipient = the user
 *   data      = `uint8 badgeType,uint32 epoch`
 *   revocable = TRUE — only the issuing platform key can revoke, kept as an
 *               abuse-pruning escape hatch for badges minted by bots. A token
 *               snapshot may still choose to honour revoked badges.
 */

import type { Hex0x } from "../types.js";

// ---------------------------------------------------------------------------
// Schemas — field order is load-bearing (calldata encode/decode depend on it)
// ---------------------------------------------------------------------------

export const REFERRAL_SCHEMA = "address referrer" as const;
export const REFERRAL_REVOCABLE = false as const;

export const BADGE_SCHEMA = "uint8 badgeType,uint32 epoch" as const;
export const BADGE_REVOCABLE = true as const;

/**
 * Schema UIDs, deterministic from {schema string, resolver=0x0, revocable}.
 * Registered + verified on Arb Sepolia 2026-07-12 via
 * apps/server/scripts/register-campaign-schemas.ts (referral tx 0x4cab40ea…
 * block 286735502, badge tx 0x31b5e6a5… block 286735525); the script asserts
 * the on-chain derivation matches these constants and is idempotent. Server
 * reads the env overrides EAS_REFERRAL_SCHEMA_UID / EAS_BADGE_SCHEMA_UID
 * first, falls back to these.
 */
export const EAS_REFERRAL_SCHEMA_UID: Hex0x =
  "0xbd332be5faf25729aaec42ee6d0583b3aec8cc7c752107eeb8d80fe1ba3ef783";
export const EAS_BADGE_SCHEMA_UID: Hex0x =
  "0x2bf3ae64e936075b79eb07149d9a1b55705d4fc2dad117fa7706bad4744ef412";

// ---------------------------------------------------------------------------
// Badge semantics
// ---------------------------------------------------------------------------

/** On-chain `uint8 badgeType` — do not renumber; attestations encode these. */
export enum BadgeType {
  /** Cohort membership: "joined the platform in epoch N". */
  Joined = 0,
}

/**
 * Epochs are platform-defined campaign windows, not clock math. Epoch 0 is the
 * early-adopter cohort; the platform advances the current epoch when a window
 * closes. Every user gets a Joined badge forever — early adopters are simply
 * the ones whose badge says epoch 0.
 */
export const EARLY_ADOPTER_EPOCH = 0 as const;

// ---------------------------------------------------------------------------
// Records — server projection shapes (cache, not truth; rebuildable from logs)
// ---------------------------------------------------------------------------

/** One indexed referral, as held in the server projection. */
export interface ReferralRecord {
  referrer: Hex0x; // lowercase — receives the revenue share
  referee: Hex0x; // lowercase — the referred merchant (on-chain attester)
  uid: Hex0x; // EAS attestation UID
  time: number; // attestation timestamp (unix seconds, from chain)
}

/** One indexed badge, as held in the server projection. */
export interface BadgeRecord {
  recipient: Hex0x; // lowercase user address
  badgeType: BadgeType;
  epoch: number;
  uid: Hex0x;
  time: number;
  revoked?: boolean;
}
