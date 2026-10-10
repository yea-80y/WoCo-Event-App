/**
 * The key-ring ANCHOR (#186): `WoCoKeyRing` on the Kernel chain, where every account
 * records the Swarm reference of its current key ring (`ring.ts`). The account writes
 * its own entry, in the same batch as its co-owner list (WoCo-Contracts
 * `src/WoCoKeyRing.sol`), so readers - the account's devices, a buyer's browser, the
 * server - all take the current ring from the chain and the blob from Swarm.
 *
 * A CREATE2 singleton through the canonical deterministic-deployment proxy: the same
 * address on every chain it is deployed to (`script/DeployKeyRing.s.sol`, pinned there
 * by `test_singletonAddress_isPinned`).
 *
 * An entry of zero means the account never had a ring: its keys are generation 0, the
 * identity seed's. The contract never lets an entry go back to zero.
 */

import { KERNEL_CHAIN_ID } from "../kernel/chain.js";
import { NO_RING } from "./ring.js";

export const KEY_RING_ANCHOR_ADDRESS = "0xf5dbe22c7c9f1a19ab39dc2770f246e0c4283aab" as const;
export const KEY_RING_ANCHOR_CHAIN_ID = KERNEL_CHAIN_ID;

export const KEY_RING_ANCHOR_ABI = [
  "function ringOf(address account) view returns (bytes32)",
  "function setRing(bytes32 expectedPrev, bytes32 ring)",
  "event RingSet(address indexed account, bytes32 indexed prev, bytes32 ring)",
  "error StaleRing(bytes32 current)",
  "error NoRing()",
] as const;

/** `setRing(bytes32,bytes32)` - what a sponsored batch may call on the anchor, and nothing else. */
export const SET_RING_SELECTOR = "0xa860c73a" as const;

const REF = /^[0-9a-f]{64}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

/** A Swarm reference (64 hex) as the anchor stores it. */
export function ringRefToAnchor(ref: string): string {
  if (!REF.test(ref)) throw new Error("key ring anchor: a ring reference is 64 lowercase hex characters");
  return `0x${ref}`;
}

/** The anchor's value as a Swarm reference, or null when the account has no ring. */
export function anchorToRingRef(value: string): string | null {
  const v = value.toLowerCase();
  if (!BYTES32.test(v)) throw new Error("key ring anchor: not a bytes32 value");
  return v === NO_RING ? null : v.slice(2);
}
