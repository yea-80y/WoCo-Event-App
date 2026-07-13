/**
 * EAS delegated attestation (EIP-712) — the zero-gas EOA rail for referral
 * confirmation. The merchant signs the `Attest` typed data for free in the
 * browser; the server relays `attestByDelegation` and pays the gas. On-chain
 * the attester is still the merchant, so the trust properties match a direct
 * attest.
 *
 * Struct + domain verified against the deployed EAS 1.3.0 on Arb Sepolia
 * (getAttestTypeHash() matched 2026-07-12). EAS 1.3 verifies delegated
 * signatures with SignatureChecker, so plain EOAs always work; smart accounts
 * only if deployed (EIP-1271) — Kernel logins use the direct gasless rail
 * instead and never touch this path.
 */

import type { Hex0x } from "../types.js";
import { EAS_ADDRESS, EAS_CHAIN_ID } from "../likes/types.js";
import { EAS_REFERRAL_SCHEMA_UID } from "./types.js";

/** Semver of the deployed EAS contract — part of the EIP-712 domain. */
export const EAS_CONTRACT_VERSION = "1.3.0" as const;

export const EAS_DELEGATED_ATTEST_DOMAIN = {
  name: "EAS",
  version: EAS_CONTRACT_VERSION,
  chainId: EAS_CHAIN_ID,
  verifyingContract: EAS_ADDRESS,
} as const;

/** EIP-712 types for EAS 1.3.0 delegated attest (typehash-verified on-chain). */
export const EAS_DELEGATED_ATTEST_TYPES = {
  Attest: [
    { name: "attester", type: "address" },
    { name: "schema", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "expirationTime", type: "uint64" },
    { name: "revocable", type: "bool" },
    { name: "refUID", type: "bytes32" },
    { name: "data", type: "bytes" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/**
 * ABI-encode the referral schema data (`address referrer`): one 32-byte
 * left-padded address. Hand-rolled so @woco/shared stays dependency-free.
 */
export function encodeReferralData(referrer: Hex0x): Hex0x {
  const addr = referrer.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(addr)) throw new Error(`Invalid referrer address: ${referrer}`);
  return `0x${"0".repeat(24)}${addr}` as Hex0x;
}

/**
 * The exact `Attest` message both sides must agree on. Client signs it; the
 * server rebuilds it from its own chain-read nonce + its server-held referrer
 * and verifies the signature recovers to `attester` before relaying. Never
 * JSON-transported — each side constructs it independently.
 */
export function buildReferralAttestMessage(input: {
  attester: Hex0x;
  referrer: Hex0x;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    attester: input.attester,
    schema: EAS_REFERRAL_SCHEMA_UID,
    recipient: input.referrer,
    expirationTime: 0n,
    revocable: false,
    refUID: ZERO_BYTES32,
    data: encodeReferralData(input.referrer),
    value: 0n,
    nonce: input.nonce,
    deadline: input.deadline,
  };
}

/** Compact r/s/v signature as transported in the relay request body. */
export interface DelegatedSignature {
  v: number;
  r: Hex0x;
  s: Hex0x;
}

/** Client → server relay payload (attester + referrer come from server state). */
export interface ReferralRelayRequest {
  deadline: string; // uint64 as decimal string (JSON-safe)
  signature: DelegatedSignature;
}

/** Server → client referral state, drives the confirm banner. */
export interface ReferralStatus {
  /** Attribution captured, not yet attested on-chain. */
  pending?: { referrer: Hex0x; createdAt: string };
  /** On-chain confirmed referral (projection of the attestation). */
  confirmed?: { referrer: Hex0x; uid: Hex0x; time: number };
  /** Stripe onboarding complete — the relay gate. */
  stripeComplete: boolean;
  /** pending && stripeComplete — client should run the attest flow. */
  readyToAttest: boolean;
}
