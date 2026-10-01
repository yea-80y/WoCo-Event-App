/**
 * Device grants (#746 step 2): more than one passkey on one account.
 *
 * A Kernel account has ONE onchain owner key - the main passkey. A grant is that
 * owner saying "this other key may sign sessions for me". The server re-checks it
 * on every request (`verify-delegation.ts`), so removing a device is instant, and
 * every grant dies by itself the moment the owner rotates (recovery, make-main):
 * its signer is no longer the owner.
 *
 * EVERY ENTRY IS A SIGNED STATEMENT, so the list does not depend on the server
 * holding it. A grant is signed by the owner; a removal by the owner or by the
 * removed device itself. The server's registry applies rules a contract could
 * apply unchanged (owner check, one-use nonces, the cap), and the field types are
 * ones a contract stores as they are. A contract on the Kernel chain that computes
 * this exact domain (no verifyingContract - the salt scopes it) verifies these
 * signatures as signed; one that insists on verifyingContract needs each grant
 * signed once more at the move. The client can check its own copy either way.
 *
 * Depth 1: only the owner key mints a grant; a granted key never does. Signed RAW
 * by the owner EOA, exactly like `AuthorizeSession`, in its own domain so neither
 * signature can stand in for the other. Unlike `SESSION_DOMAIN` it carries the
 * Kernel chain id: a grant asserts "the owner of Kernel P", and the Kernel address
 * is the same on every chain while its owner need not be.
 *
 * Unchanged after launch: a change here invalidates every grant registered so far
 * (each added device is signed out until its owner adds it again).
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { KERNEL_CHAIN_ID } from "../kernel/chain.js";

export const DEVICE_GRANT_DOMAIN = {
  name: "WoCo Device Grant",
  version: "1",
  chainId: KERNEL_CHAIN_ID,
  salt: "0xfa35c64aca4cd4fae0d65d63f7c1b9960a481462284fd6cf298108ecaca85de1",
} as const;

export const DEVICE_GRANT_TYPES = {
  DeviceGrant: [
    { name: "parent", type: "address" },
    { name: "grantee", type: "address" },
    { name: "credentialTag", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const DEVICE_GRANT_REVOKE_TYPES = {
  RevokeDeviceGrant: [
    { name: "parent", type: "address" },
    { name: "grantee", type: "address" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface DeviceGrantMessage {
  /** The account (Kernel) the grantee may act as. Lowercase. */
  parent: string;
  /** The added passkey's own EOA - what its session delegations recover to. Lowercase. */
  grantee: string;
  /** `credentialTagOf(credentialId)`: ties the grant to one passkey without
   *  publishing the credentialId. Lowercase 0x hex. */
  credentialTag: string;
  /** Unix seconds, self-declared by the signing device. Display only. */
  issuedAt: number;
  /** 32 random bytes, lowercase 0x hex. One use per account, across grants AND
   *  removals: a captured statement cannot be submitted twice, so a removed
   *  device cannot be re-added by replaying the grant that first added it. */
  nonce: string;
}

export interface DeviceGrantRevokeMessage {
  parent: string;
  grantee: string;
  nonce: string;
}

/** Active grants per account. Enforced at registration. */
export const MAX_DEVICE_GRANTS = 10;

/** Who signed the session: the onchain owner, or a key it granted. */
export type SessionRank = "owner" | "device";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function credentialTagOf(credentialId: Uint8Array): string {
  let hex = "0x";
  for (const b of keccak_256(credentialId)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

type Untrusted<T> = Partial<Record<keyof T, unknown>> | null;

/** Lowercase parent + grantee, or null. Lowercase because ethers rejects a
 *  mixed-case address with a bad checksum, and case is not part of the signed
 *  bytes - an address encodes the same either way. */
function parsePair(parent: unknown, grantee: unknown): { parent: string; grantee: string } | null {
  if (typeof parent !== "string" || !ADDRESS.test(parent)) return null;
  if (typeof grantee !== "string" || !ADDRESS.test(grantee)) return null;
  const p = parent.toLowerCase();
  const x = grantee.toLowerCase();
  if (x === ZERO_ADDRESS || x === p) return null;
  return { parent: p, grantee: x };
}

function isObject(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Shape-check an untrusted grant and normalise its hex to lowercase. */
export function parseDeviceGrant(v: unknown): DeviceGrantMessage | null {
  if (!isObject(v)) return null;
  const g = v as Untrusted<DeviceGrantMessage>;
  const pair = parsePair(g!.parent, g!.grantee);
  const { credentialTag, issuedAt, nonce } = g!;
  if (!pair) return null;
  if (typeof credentialTag !== "string" || !BYTES32.test(credentialTag)) return null;
  if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
  if (typeof nonce !== "string" || !BYTES32.test(nonce)) return null;
  return { ...pair, credentialTag: credentialTag.toLowerCase(), issuedAt, nonce: nonce.toLowerCase() };
}

export function parseDeviceGrantRevoke(v: unknown): DeviceGrantRevokeMessage | null {
  if (!isObject(v)) return null;
  const r = v as Untrusted<DeviceGrantRevokeMessage>;
  const pair = parsePair(r!.parent, r!.grantee);
  if (!pair) return null;
  if (typeof r!.nonce !== "string" || !BYTES32.test(r!.nonce)) return null;
  return { ...pair, nonce: r!.nonce.toLowerCase() };
}
