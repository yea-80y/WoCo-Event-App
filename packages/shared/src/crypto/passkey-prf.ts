/**
 * Everything a passkey account derives from its WebAuthn PRF output, in one file,
 * so every label that must never move sits beside the others (#642).
 *
 * The PRF output is 32 bytes of HMAC-SHA-256 computed inside the authenticator over
 * SHA-256(`PASSKEY_PRF_SALT_INPUT`). Four things hang off it:
 *
 *   keccak256(prf)                                → the Kernel's ECDSA owner key
 *                                                   (passkey-account.ts; FROZEN, older
 *                                                   than this file and not moved by it)
 *   HKDF(prf, "", PASSKEY_SEED_INFO, 32)          → the account's identity SEED
 *   HKDF(prf, "", PORTABILITY_SOC_OWNER_INFO, 48) → the portability envelope's SOC owner
 *   HKDF(prf, "", PORTABILITY_HPKE_INFO, 32)      → the portability envelope's HPKE key
 *
 * A BACKUP passkey (a recovery guardian, never a login) has one more:
 *
 *   HKDF(prf, "", PASSKEY_GUARDIAN_ESCROW_INFO, 32) → the guardian's escrow master, from
 *                                                   which its escrow and SOC keys derive
 *                                                   exactly as a wallet guardian's do from
 *                                                   keccak256(its signature)
 *
 * WHY THE SEED IS NOT A SIGNATURE FOR PASSKEYS. Wallet and email accounts establish
 * the seed as keccak256 of a deterministic `DeriveAccountKeys` signature, because
 * there is no symmetric secret to start from. A passkey has one. Rooted on the
 * signature, the seed was reproducible by anyone who could recover the owner key from
 * its public key (which every owner signature reveals) — and every key the account
 * owns falls out of the seed. Rooted here, no step between the authenticator and the
 * seed passes through a secp256k1 key. The owner key and the seed are both one-way
 * images of the same PRF output, so neither reaches the other.
 *
 * The portability keys moved with it for the same reason: they carry the seed of a
 * RECOVERED account, and deriving them from the owner key would put that seed one
 * elliptic-curve break away again.
 *
 * SALT IS THE EMPTY BYTE STRING and nothing else is bound into the info — the output
 * must reproduce from the credential alone on any device, the credential is already
 * scoped to its RP, and an RP-ID policy change must not fork anyone's seed.
 *
 * EVERY LABEL HERE IS FROZEN. Change one and every passkey account's seed (or
 * portability envelope address) moves: sealed history stops opening, the issuer
 * address changes, every content chunk is stranded under an owner nothing looks at.
 * `apps/web/test/identity-vectors.test.ts` pins them byte for byte.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { deriveSecpFromSeed } from "./secp-hkdf.js";
import type { Hex0x } from "../types.js";

/** HKDF info for a passkey account's identity seed. FROZEN. */
export const PASSKEY_SEED_INFO = "woco/identity-seed/passkey-prf/v1";

/** HKDF info for the portability envelope's SOC owner key. FROZEN. v1 was a keccak
 *  of the owner KEY, not the PRF output, and is gone. */
export const PORTABILITY_SOC_OWNER_INFO = "woco/recovery/portability/soc-owner/v2";

/** HKDF info for the portability envelope's HPKE recipient seed. FROZEN. */
export const PORTABILITY_HPKE_INFO = "woco/recovery/portability/hpke/v2";

/** HKDF info for a backup passkey's guardian escrow master (#642). FROZEN: change it
 *  and every escrow sealed to a passkey guardian stops opening. */
export const PASSKEY_GUARDIAN_ESCROW_INFO = "woco/recovery/guardian-passkey/v1";

/**
 * HKDF info for the key that locks the identity seed ON A DEVICE (#746 fix 1). STICKY,
 * not identity-frozen: changing it strands every device's locked copy, so each fetches
 * its seed once more (derives it again, or opens the envelope / pairing for a carried
 * seed) - no identity moves. Its own label, never a reused one: `PASSKEY_SEED_INFO`
 * IS the seed, and `PORTABILITY_HPKE_INFO` is the envelope's KEM key. From the PRF,
 * never from the owner key, whose public half every session signature reveals.
 */
export const PASSKEY_SEED_KEK_INFO = "woco/device/seed-kek/v1";

/** The only PRF output length any derivation accepts. */
export const PASSKEY_PRF_OUTPUT_BYTES = 32;

/**
 * The PRF output as bytes, or a throw. Accepts the 0x-hex form auth-store carries or
 * raw bytes. Exactly 32 bytes: WebAuthn PRF is HMAC-SHA-256, and anything else is a
 * broken authenticator whose output must not become anybody's identity.
 */
export function passkeyPrfBytes(prfSecret: string | Uint8Array): Uint8Array {
  let bytes: Uint8Array;
  if (typeof prfSecret === "string") {
    const clean =
      prfSecret.startsWith("0x") || prfSecret.startsWith("0X") ? prfSecret.slice(2) : prfSecret;
    bytes = hexToBytes(clean);
  } else {
    bytes = prfSecret;
  }
  if (bytes.length !== PASSKEY_PRF_OUTPUT_BYTES) {
    throw new Error(
      `passkey PRF output must be ${PASSKEY_PRF_OUTPUT_BYTES} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

/**
 * The identity seed of a passkey account that has never been recovered.
 *
 * A RECOVERED account's seed is NOT this: recovery mints a new credential and carries
 * the original seed across verbatim (escrow / portability envelope), so the stored
 * seed always wins. Callers establish from here only when no stored seed exists and
 * no recovery binding says the credential was rotated in.
 */
export function passkeyIdentitySeed(prfSecret: string | Uint8Array): Hex0x {
  const okm = hkdf(sha256, passkeyPrfBytes(prfSecret), new Uint8Array(0), utf8ToBytes(PASSKEY_SEED_INFO), 32);
  return `0x${bytesToHex(okm)}` as Hex0x;
}

/** The 32 raw bytes of the device seed-lock key. The caller imports them as a
 *  non-extractable AES-GCM key and zeroes them. */
export function passkeySeedKek(prfSecret: string | Uint8Array): Uint8Array {
  return hkdf(sha256, passkeyPrfBytes(prfSecret), new Uint8Array(0), utf8ToBytes(PASSKEY_SEED_KEK_INFO), 32);
}

/** The secp256k1 key that owns this credential's portability envelope SOC. */
export function portabilitySocOwnerKey(prfSecret: string | Uint8Array): {
  privKey: Hex0x;
  address: string;
} {
  const prfHex = bytesToHex(passkeyPrfBytes(prfSecret));
  const { privateKey, address } = deriveSecpFromSeed(prfHex, PORTABILITY_SOC_OWNER_INFO, "passkey PRF output");
  return { privKey: `0x${bytesToHex(privateKey)}` as Hex0x, address: address.toLowerCase() };
}

/** The 32-byte seed the portability envelope's HPKE recipient key derives from
 *  (via the HPKE KEM's own `deriveKeyPair`). The caller zeroes it after use. */
export function portabilityHpkeSeed(prfSecret: string | Uint8Array): Uint8Array {
  return hkdf(sha256, passkeyPrfBytes(prfSecret), new Uint8Array(0), utf8ToBytes(PORTABILITY_HPKE_INFO), 32);
}

/**
 * A backup passkey's guardian escrow MASTER — the passkey counterpart of a wallet
 * guardian's `keccak256(signature)`. Rooted on the PRF output, so the escrowed seed
 * behind it is not one secp256k1 break away through the guardian's owner key. The
 * guardian's ON-CHAIN role (signing the recovery userOp) stays that key's job.
 */
export function passkeyGuardianEscrowMaster(prfSecret: string | Uint8Array): Uint8Array {
  return hkdf(
    sha256,
    passkeyPrfBytes(prfSecret),
    new Uint8Array(0),
    utf8ToBytes(PASSKEY_GUARDIAN_ESCROW_INFO),
    32,
  );
}
