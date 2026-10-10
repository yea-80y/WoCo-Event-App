/**
 * What a holder signs to point a name: EIP-712 `SetContenthash` under the
 * registrar's domain. Pure — no provider, no auth — so the encoding is tested
 * against the vector the contract's own suite pins. What each field is for,
 * and how it is signed and relayed, is in `pointer.ts`.
 */

import type { Hex0x } from "@woco/shared";

export const POINTER_DOMAIN_NAME = "WoCo Registrar";
export const POINTER_DOMAIN_VERSION = "1";

export const POINTER_TYPES = {
  SetContenthash: [
    { name: "name", type: "string" },
    { name: "node", type: "bytes32" },
    { name: "contenthash", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "expiration", type: "uint256" },
  ],
} as const;

/** EIP-1577 / ENSIP-7 Swarm contenthash: `e40101fa011b20` ‖ the 32-byte reference. */
const SWARM_CONTENTHASH_PREFIX = "0xe40101fa011b20";

export function swarmContenthash(swarmHash: string): Hex0x {
  const clean = swarmHash.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("Not a Swarm reference. Nothing was signed.");
  return `${SWARM_CONTENTHASH_PREFIX}${clean}` as Hex0x;
}

export interface PointerTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Hex0x };
  types: { SetContenthash: { name: string; type: string }[] };
  message: { name: string; node: Hex0x; contenthash: Hex0x; nonce: bigint; expiration: number };
}

/** Free of any provider, so the encoding is testable against the vector the
 *  contract's own suite pins (`WoCoRegistrarSignedPointer.t.sol`). */
export function buildPointerTypedData(parts: {
  registrar: Hex0x;
  chainId: number;
  name: string;
  node: Hex0x;
  contenthash: Hex0x;
  nonce: bigint;
  expiration: number;
}): PointerTypedData {
  return {
    domain: {
      name: POINTER_DOMAIN_NAME,
      version: POINTER_DOMAIN_VERSION,
      chainId: parts.chainId,
      verifyingContract: parts.registrar,
    },
    types: { SetContenthash: POINTER_TYPES.SetContenthash.map((f) => ({ ...f })) },
    message: {
      name: parts.name,
      node: parts.node,
      contenthash: parts.contenthash,
      nonce: parts.nonce,
      expiration: parts.expiration,
    },
  };
}

/**
 * Ten minutes from the names chain's latest block — never this device's clock,
 * which Arbitrum's `block.timestamp` may trail by a day (audit 950 Low 13).
 * The relay refuses anything outside 60 s – 15 min of the same clock.
 */
export const POINTER_TTL_SECS = 10 * 60;
