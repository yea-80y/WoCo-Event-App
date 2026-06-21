/**
 * Cross-device recovery portability envelope (CROSS_DEVICE_RECOVERY.md §3 /
 * CLIENT_FEED_SIGNER_HANDOVER.md step 4).
 *
 * A WoCo-guardian *recovery* rotates a passkey Kernel's on-chain owner while
 * PRESERVING the Kernel address, and restores the original POD seed from escrow.
 * Both facts get written to the recovery DEVICE's IndexedDB only, so the recovered
 * account is single-device (a second device shows a divergent counterfactual
 * address + a divergent POD identity). This module carries those preserved
 * secrets in a tiny record any device with the SAME passkey can fetch and open:
 *
 *  - The record is a Single-Owner-Chunk owned by a key DERIVED from the passkey's
 *    PRF secret (domain-separated). Only the passkey holder can produce that key,
 *    so only the user can write their own envelope. It is read by COMPUTED chunk
 *    address (Etherna-safe — never /feeds).
 *  - The payload is the SAME audited `RecoveryEnvelope` from `recovery-escrow.ts`,
 *    sealed to ONE extra HPKE recipient: a second PRF-derived (X25519) key. No new
 *    crypto — one extra recipient on the bundle the escrow already produces.
 *
 * Trust on read is NOT this blob: the caller MUST verify on-chain that the
 * preserved Kernel's current ECDSA owner == this device's PRF-EOA before applying
 * any override (see auth-store / kernel-account.readKernelEcdsaOwner). The seal
 * only provides confidentiality; the chain provides authenticity.
 *
 * Determinism / recovery-stability: the two keys derive from the passkey's
 * secp256k1 PRF key (`keccak256(prfOutput)`), which is reproduced on any device
 * holding the passkey. After a recovery the envelope is (re)written under the
 * NEW passkey's derived keys, so the recovered identity becomes portable to that
 * passkey's future devices.
 */

import { keccak256, getBytes, toUtf8Bytes, concat, Wallet } from "ethers";
import {
  PORTABILITY_SOC_OWNER_DOMAIN,
  PORTABILITY_HPKE_DOMAIN,
  PORTABILITY_ENVELOPE_VERSION,
  portabilitySocIdentifier,
  type PortabilityEnvelope,
} from "@woco/shared";
import {
  deriveEncryptionKeypairFromSeed,
  sealRecoveryBundle,
  openRecoveryBundle,
  type GuardianEncryptionKeypair,
} from "./recovery-escrow.js";
import { signAndUploadSoc, readSoc } from "../swarm/client-soc.js";

/** Domain-separated 32-byte seed = keccak256(utf8(domain) || prfPrivKeyBytes). */
function domainSeed(domain: string, prfPrivKeyBytes: Uint8Array): Uint8Array {
  return getBytes(keccak256(concat([toUtf8Bytes(domain), prfPrivKeyBytes])));
}

export interface PortabilityKeys {
  /** secp256k1 SOC-owner key (0x-prefixed) + lowercased address. */
  socOwnerPrivKey: string;
  socOwnerAddress: string;
  /** X25519 HPKE recipient keypair (wrap on write, unwrap on read). */
  hpke: GuardianEncryptionKeypair;
}

/**
 * Derive the two domain-separated keys from a passkey's PRF secp256k1 private key
 * (`_passkeyPrivateKey` in auth-store; == keccak256(PRF output)). Distinct domains
 * ⇒ the SOC-owner key and the HPKE recipient key don't reveal each other.
 */
export async function derivePortabilityKeys(passkeyPrivKey: string): Promise<PortabilityKeys> {
  const prfBytes = getBytes(passkeyPrivKey.startsWith("0x") ? passkeyPrivKey : `0x${passkeyPrivKey}`);

  const socSeed = domainSeed(PORTABILITY_SOC_OWNER_DOMAIN, prfBytes);
  const socOwnerPrivKey = keccak256(socSeed); // 0x + 32 bytes → valid secp256k1 key
  const wallet = new Wallet(socOwnerPrivKey);

  const hpkeSeed = domainSeed(PORTABILITY_HPKE_DOMAIN, prfBytes);
  let hpke: GuardianEncryptionKeypair;
  try {
    hpke = await deriveEncryptionKeypairFromSeed(hpkeSeed);
  } finally {
    hpkeSeed.fill(0);
    socSeed.fill(0);
  }

  return { socOwnerPrivKey, socOwnerAddress: wallet.address.toLowerCase(), hpke };
}

/**
 * Seal the preserved secrets to the passkey's PRF-derived HPKE key and write the
 * envelope as the fixed-identifier SOC (overwrite-in-place). `preservedKernelAddress`
 * is the recovered account's Kernel address; the bundle inside carries the POD
 * seed (and, in Phase B, the feed-signer key). Non-throwing failures are the
 * caller's to handle — this throws on any error.
 */
export async function writePortabilityEnvelope(args: {
  passkeyPrivKey: string;
  preservedKernelAddress: string;
  podSeed: string;
  /** Phase B: independent feed-signer key. Reserved slot — omit in Phase A. */
  feedSignerPrivKey?: string;
}): Promise<void> {
  const { passkeyPrivKey, preservedKernelAddress, podSeed, feedSignerPrivKey } = args;
  const keys = await derivePortabilityKeys(passkeyPrivKey);

  // The preserved Kernel goes INSIDE the sealed bundle (v2 privacy fix) — never
  // cleartext on the chunk, so a reader can't link socOwnerAddress → real Kernel.
  const secrets: Record<string, string> = {
    preservedKernelAddress: preservedKernelAddress.toLowerCase(),
    podSeed,
  };
  if (feedSignerPrivKey) secrets.feedSignerPrivKey = feedSignerPrivKey;

  // Bind the AAD + envelope.kernelAddress to the PRF-derived socOwnerAddress
  // pseudonym (already public — it IS the chunk owner), NOT the real Kernel. The
  // PRF-derived HPKE recipient key still binds the account, so anti-transplant
  // holds while nothing on the chunk reveals the preserved Kernel address.
  const envelope = await sealRecoveryBundle({
    bundle: { version: PORTABILITY_ENVELOPE_VERSION, secrets },
    kernelAddress: keys.socOwnerAddress,
    guardianPublicKeysHex: [keys.hpke.publicKeyHex],
  });

  const payloadObj: PortabilityEnvelope = {
    v: PORTABILITY_ENVELOPE_VERSION,
    envelope,
  };
  const payload = new TextEncoder().encode(JSON.stringify(payloadObj));

  await signAndUploadSoc({
    signerPrivKey: keys.socOwnerPrivKey,
    identifier: portabilitySocIdentifier(),
    payload,
  });
}

export interface OpenedPortability {
  preservedKernelAddress: string;
  podSeed: string;
  feedSignerPrivKey?: string;
}

/**
 * Read + open the portability envelope for the passkey holding `passkeyPrivKey`.
 * Returns the preserved secrets, or null if no envelope exists (non-recovered
 * account) or it can't be opened. Does NOT perform the on-chain owner check — the
 * caller MUST verify `Kernel(preservedKernelAddress).owner == PRF-EOA` before
 * trusting the result.
 */
export async function readPortabilityEnvelope(args: {
  passkeyPrivKey: string;
}): Promise<OpenedPortability | null> {
  const keys = await derivePortabilityKeys(args.passkeyPrivKey);

  const raw = await readSoc(keys.socOwnerAddress, portabilitySocIdentifier());
  if (!raw) return null;

  let parsed: PortabilityEnvelope;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as PortabilityEnvelope;
  } catch {
    return null;
  }
  // v1 (cleartext-Kernel) envelopes no longer match → null → back-fill rewrites.
  if (parsed?.v !== PORTABILITY_ENVELOPE_VERSION || !parsed.envelope) {
    return null;
  }

  try {
    // Sealed under the socOwnerAddress pseudonym (v2), not the real Kernel.
    const bundle = await openRecoveryBundle({
      envelope: parsed.envelope,
      kernelAddress: keys.socOwnerAddress,
      guardianKeypair: keys.hpke,
    });
    const preservedKernelAddress = bundle.secrets.preservedKernelAddress;
    const podSeed = bundle.secrets.podSeed;
    if (!preservedKernelAddress || !podSeed) return null;
    return {
      preservedKernelAddress: preservedKernelAddress.toLowerCase(),
      podSeed,
      feedSignerPrivKey: bundle.secrets.feedSignerPrivKey,
    };
  } catch {
    return null;
  }
}
