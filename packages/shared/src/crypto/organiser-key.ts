/**
 * The ORGANISER KEY - the secp256k1 key that signs an event's terms on the ticket
 * ledger (ledger2) for its organiser: supply, sales cutoff, cancellation, consent to a
 * seat move. Anyone, in practice the platform's sponsor wallet, submits what it signed,
 * so a terms change needs no transaction from the organiser's smart account, and the
 * platform can submit only what the organiser signed.
 *
 * HKDF(sha256, S_g, salt = "", info = "woco/organiser-key/v1", 48) -> scalar -> key,
 * from the account's CURRENT secret (#186): a sibling of the feed signer and the order
 * key, so a passkey removal moves it with them (the account re-points every event's key
 * in the same operation that moves its key ring).
 *
 * NOT THE ISSUING KEY: that one stays on the identity seed, which a removed passkey
 * still holds, and the ledger verifies out of band - the case `account-secret.ts`
 * warns about. NOT THE FEED SIGNER: it is cached on the device, so a signature by it
 * proves no unlock. Callers derive this key only after the organiser's unlock and never
 * store it.
 *
 * THE INFO STRING IS FROZEN. Change it and every event's on-chain key becomes one
 * nobody can derive: terms frozen until the organiser's account re-points them.
 */

import { deriveSecpFromSeed } from "./secp-hkdf.js";
import { recoverPersonalSigner, signPersonalMessage } from "./issuing.js";
import type { Hex0x } from "../types.js";

/** HKDF info for the organiser key. FROZEN - see the file header. */
export const ORGANISER_KEY_INFO = "woco/organiser-key/v1";

/** Domain line of the binding message. Distinct from `woco-issuer-binding-v1`. */
export const ORGANISER_KEY_BINDING_DOMAIN = "woco-organiser-key-binding-v1";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** Derive the organiser key from an account secret (64 hex, the current generation's). */
export function deriveOrganiserKey(secretHex: string): { privateKey: Uint8Array; address: string } {
  const { privateKey, address } = deriveSecpFromSeed(secretHex, ORGANISER_KEY_INFO, "account secret");
  return { privateKey, address: address.toLowerCase() };
}

/**
 * Proof that the organiser key belongs to a parent account, sent with a registration
 * so the server never names a key on chain it has not seen sign for this account.
 * `gen` is the key ring generation the key was derived at; the server refuses one that
 * is not the account's current generation, so a device behind never registers under a
 * key the account has moved off.
 */
export interface OrganiserKeyBindingV1 {
  /** The organiser key's address, lowercase. Redundant with the recovered signer on purpose. */
  key: string;
  gen: number;
  /** personal_sign by the organiser key over {@link buildOrganiserKeyBindingMessage}. */
  sig: Hex0x;
}

/**
 * The exact ASCII message the organiser key personal-signs:
 *
 *   woco-organiser-key-binding-v1\n{0x + 40-hex lowercase parent}\n{gen decimal}
 *
 * At least 74 bytes, so never a 32-byte digest, and personal-signed, so disjoint from
 * the EIP-712 terms messages the same key signs for the ledger. Replayable by design,
 * like the issuer binding: it asserts a durable fact, and the server accepts it only in
 * a session-authenticated call whose verified parent must equal `parent`.
 */
export function buildOrganiserKeyBindingMessage(parent: string, gen: number): string {
  if (typeof parent !== "string" || !ADDRESS_RE.test(parent)) {
    throw new Error("organiser key binding: parent must be a 0x-prefixed lowercase 20-byte address");
  }
  if (!Number.isInteger(gen) || gen < 0) {
    throw new Error(`organiser key binding: invalid generation ${gen}`);
  }
  return `${ORGANISER_KEY_BINDING_DOMAIN}\n${parent}\n${gen}`;
}

export function signOrganiserKeyBinding(
  key: { privateKey: Uint8Array; address: string },
  parent: string,
  gen: number,
): OrganiserKeyBindingV1 {
  return { key: key.address, gen, sig: signPersonalMessage(buildOrganiserKeyBindingMessage(parent, gen), key.privateKey) };
}

/**
 * The key and generation a binding proves for `parent`, or null: a malformed binding, a
 * signature that does not recover to the key it names, or one made for another parent.
 * Never throws.
 */
export function verifyOrganiserKeyBinding(binding: unknown, parent: string): { key: string; gen: number } | null {
  if (typeof binding !== "object" || binding === null) return null;
  const { key, gen, sig } = binding as Record<string, unknown>;
  if (typeof key !== "string" || !ADDRESS_RE.test(key)) return null;
  if (typeof gen !== "number" || !Number.isInteger(gen) || gen < 0) return null;
  let message: string;
  try {
    message = buildOrganiserKeyBindingMessage(parent, gen);
  } catch {
    return null;
  }
  const recovered = recoverPersonalSigner(message, sig);
  return recovered !== null && recovered.toLowerCase() === key ? { key, gen } : null;
}
