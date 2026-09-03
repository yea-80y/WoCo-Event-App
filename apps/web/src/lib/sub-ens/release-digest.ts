/**
 * What a holder actually signs to authorise `releaseWithSignature`.
 *
 * THE TRAP THIS EXISTS TO AVOID. `L2Registry.releaseDigest(node, expiration)`
 * returns the digest ALREADY in EIP-191 personal-sign form — its last step is
 * `.toEthSignedMessageHash()`. So reading those 32 bytes and calling
 * `personal_sign` on them prefixes a SECOND time: the wallet signs
 * `keccak("\x19Ethereum Signed Message:\n32" ‖ releaseDigest)`, the contract
 * recovers a different address, and the release reverts `Unauthorized` for
 * every EOA. The contract's own Foundry tests do not catch it because `vm.sign`
 * signs the digest raw, with no prefix.
 *
 * What must be signed is the INNER struct hash, which `personal_sign` then
 * hashes INTO `releaseDigest`:
 *
 *   inner  = keccak256(abi.encode(RELEASE_TYPEHASH, registry, chainId, node,
 *                                 recordVersions[node], expiration))
 *   digest = keccak256("\x19Ethereum Signed Message:\n32" ‖ inner)   // == releaseDigest
 *
 * Every field earns its place: RELEASE_TYPEHASH stops a contenthash-CLEAR
 * signature (packed `(registry, node, "", expiration)`) doubling as a release;
 * registry + chainId stop replay onto the same clone on another chain (the
 * deploy script gives clones the same address on both); `recordVersions[node]`
 * is bumped by every release, which makes a signature single-use and dead
 * against a re-mint of the same label.
 *
 * CHAIN STAYS THE REFERENCE. We derive `inner` locally because it is what the
 * wallet must be handed, but we then assert that hashing it reproduces the
 * `releaseDigest` the CONTRACT returns, and refuse to sign on any mismatch.
 * That keeps a drift between this file and the deployed contract from
 * producing a signature aimed at something we did not intend.
 */

import type { Hex0x } from "@woco/shared";

/** Minimal registry ABI for building and checking a release digest. */
export const RELEASE_DIGEST_ABI = [
  "function RELEASE_TYPEHASH() view returns (bytes32)",
  "function recordVersions(bytes32 node) view returns (uint64)",
  "function releaseDigest(bytes32 node, uint256 expiration) view returns (bytes32)",
] as const;

export interface ReleaseDigestParts {
  typehash: Hex0x;
  registry: Hex0x;
  chainId: number;
  node: Hex0x;
  recordVersion: bigint;
  expiration: number;
}

/**
 * The inner struct hash — the bytes a wallet is asked to personal-sign.
 *
 * Kept free of any provider so the encoding is testable against a known vector
 * with no chain.
 */
export function buildReleaseInnerHash(
  parts: ReleaseDigestParts,
  abi: {
    encode: (types: string[], values: unknown[]) => string;
    keccak256: (data: string) => string;
  },
): Hex0x {
  return abi.keccak256(
    abi.encode(
      ["bytes32", "address", "uint256", "bytes32", "uint64", "uint256"],
      [parts.typehash, parts.registry, parts.chainId, parts.node, parts.recordVersion, parts.expiration],
    ),
  ) as Hex0x;
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
