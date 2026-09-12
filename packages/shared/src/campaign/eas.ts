/**
 * EAS chain constants for the onboarding campaign (referrals + cohort badges).
 *
 * These lived in `likes/types.ts` until the EAS likes/follows rail was deleted
 * (#475, 2026-09-12). Likes and follows are Swarm-native now; the referral
 * campaign is the last EAS user on the platform (#476), so the constants moved
 * to the one rail that still needs them rather than keeping a retired module
 * alive as their only home.
 *
 * RE-VERIFIED on-chain 2026-06-05: EAS.getSchemaRegistry() returns the
 * SchemaRegistry address below. Addresses are Arbitrum Sepolia (421614) — the
 * campaign has not moved off the testnet it was built on.
 */

import type { Hex0x } from "../types.js";

export const EAS_CHAIN_ID = 421614 as const;

export const EAS_ADDRESS: Hex0x = "0x2521021fc8BF070473E1e1801D3c7B4aB701E1dE";
export const SCHEMA_REGISTRY_ADDRESS: Hex0x = "0x45CB6Fa0870a8Af06796Ac15915619a0f22cd475";
