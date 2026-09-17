/**
 * What a holder signs to authorise `releaseWithSignature`: EIP-712 typed data.
 *
 * Registry v2.1 (WoCo-Contracts #21, audits 937 F3 / 938 M-2) replaced v2's
 * personal-sign digest with typed data, so the wallet shows the holder what
 * they are giving up instead of 32 opaque bytes:
 *
 *   domain  { name: "WoCo Names", version: "2", chainId, verifyingContract: registry }
 *   Release { name: "alice.woco.eth", node, recordVersion, expiration }
 *
 * v2's trap — `releaseDigest` was already EIP-191-wrapped, so personal-signing
 * it prefixed twice — is gone with it: `signTypedData` hashes the domain and
 * the struct itself, and the contract's `releaseDigest` is that same hash.
 *
 * Why each field: the domain pins the registry and the chain (the deploy gives
 * clones the same address on every chain); `node` pins the name, and `name`
 * shows it; `recordVersion` moves on every change of holder and on
 * `clearRecords`, so a signature releases at most once and dies with the
 * holding it was made for; `expiration` bounds it, and the contract refuses one
 * more than 48 hours ahead of the block.
 *
 * CHAIN STAYS THE REFERENCE. We build the typed data locally because that is
 * what the wallet must be handed, then assert that its hash equals the
 * `releaseDigest` the CONTRACT returns, and refuse to sign on any mismatch.
 */

import type { Hex0x } from "@woco/shared";

/** Minimal registry ABI for building and checking a release. */
export const RELEASE_DIGEST_ABI = [
  "function recordVersions(bytes32 node) view returns (uint64)",
  "function releaseDigest(bytes32 node, uint256 expiration) view returns (bytes32)",
] as const;

export const RELEASE_DOMAIN_NAME = "WoCo Names";
export const RELEASE_DOMAIN_VERSION = "2";

export const RELEASE_TYPES = {
  Release: [
    { name: "name", type: "string" },
    { name: "node", type: "bytes32" },
    { name: "recordVersion", type: "uint64" },
    { name: "expiration", type: "uint256" },
  ],
} as const;

export interface ReleaseTypedDataParts {
  registry: Hex0x;
  chainId: number;
  /** The whole name as the wallet should show it, e.g. "alice.woco.eth". */
  name: string;
  node: Hex0x;
  recordVersion: bigint;
  expiration: number;
}

export interface ReleaseTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Hex0x };
  types: { Release: { name: string; type: string }[] };
  message: { name: string; node: Hex0x; recordVersion: bigint; expiration: number };
}

/**
 * The typed data a wallet is asked to sign. Free of any provider, so the
 * encoding is testable against a vector pinned in the contract's own suite.
 */
export function buildReleaseTypedData(parts: ReleaseTypedDataParts): ReleaseTypedData {
  return {
    domain: {
      name: RELEASE_DOMAIN_NAME,
      version: RELEASE_DOMAIN_VERSION,
      chainId: parts.chainId,
      verifyingContract: parts.registry,
    },
    types: { Release: RELEASE_TYPES.Release.map((f) => ({ ...f })) },
    message: {
      name: parts.name,
      node: parts.node,
      recordVersion: parts.recordVersion,
      expiration: parts.expiration,
    },
  };
}

/**
 * How long a release signature should be valid for.
 *
 * Short on purpose: until it is mined or the record version moves, the
 * signature is a bearer token authorising an irreversible burn, and the holder
 * has no clean way to cancel one. Ten minutes covers a slow relay and a user
 * confirming in a wallet; the server independently refuses anything outside
 * 60s–15min, so a modified client cannot mint itself a long-lived one.
 */
export const RELEASE_TTL_SECS = 10 * 60;

export function releaseExpiration(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000) + RELEASE_TTL_SECS;
}
