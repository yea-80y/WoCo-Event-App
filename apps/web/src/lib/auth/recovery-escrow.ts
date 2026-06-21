/**
 * Recovery-escrow crypto (PASSKEY_RECOVERY_PLAN §11.3 / §11.6).
 *
 * The funds-recovery primitive (`recoverAccount` in kernel-account.ts) rotates
 * the Kernel signer but CANNOT restore the POD ed25519 identity: that key is
 * derived deterministically from a now-dead secret, and you cannot re-derive a
 * secret from the surviving (public) Kernel address (§11.1). The original key
 * must therefore be ESCROWED to recover dashboard decryption (and, later, the
 * Swarm feed signer). This module is that escrow.
 *
 * Construction — KEM/DEM hybrid, every step a single vetted-library call
 * (crypto-lead rationale; the §11 invariant is "never hand-roll ECIES"):
 *  - DEK-WRAP = HPKE (RFC 9180) single-shot seal via `@hpke/core`, suite
 *    DHKEM(X25519,HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM. HPKE is the IETF
 *    standard for "encrypt to a recipient public key" (TLS ECH, MLS); we use
 *    its composed `seal`/`open`, not a self-assembled ECDH+KDF+AEAD. Each
 *    wrapped DEK is `enc(32B X25519) || ct` so an anonymous sender needs no key.
 *  - BUNDLE-AEAD = XChaCha20-Poly1305 (`@noble/ciphers`) under a random per-
 *    bundle DEK, with the Kernel address bound as additional-data so a stolen
 *    envelope cannot be replayed against another account.
 *  - GUARDIAN KEY is DERIVED, never stored: the guardian EOA signs a fixed
 *    EIP-712 message (the deterministic-signature trick `requestPodIdentity`
 *    relies on) → keccak → 32-byte seed → HPKE `deriveKeyPair`. Same EOA always
 *    reproduces the same X25519 key, on any device, with nothing at rest.
 *
 * v1 = 1-of-1 (single backup-EOA guardian). M-of-N via verifiable secret sharing
 * over the DEK is a later envelope version (§11.6 step 2) — the DEK indirection
 * here is exactly what makes that a content change, not a redesign. The bundle is
 * generic (`secrets: Record<name,secret>`) so the feed-signer slot is reserved at
 * zero cost (§11.6 step 3) — v1 ships `{ podSeed }` only.
 *
 * Confidentiality of the escrow equals the recovery-threshold strength, NOT
 * device-bound secrecy — inherent to all recovery (§11.4). A timelock guards
 * funds rotation, NOT this at-rest copy: once an attacker meets the unwrap
 * threshold the plaintext is theirs with no "cancel". Escrow the MINIMUM.
 */

import { keccak256, getBytes } from "ethers";
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm } from "@hpke/core";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { bytesToHex, hexToBytes } from "@noble/ciphers/utils";
import { randomBytes } from "@noble/ciphers/webcrypto";
import {
  RECOVERY_ENC_DOMAIN,
  RECOVERY_ENC_TYPES,
  RECOVERY_ENC_NONCE,
  RECOVERY_ENVELOPE_VERSION,
  type EIP712Signer,
  type RecoveryEnvelope,
} from "@woco/shared";

/**
 * Plaintext escrow bundle — CLIENT-ONLY. Never serialised to the server (the
 * server stores `RecoveryEnvelope` ciphertext only). v1 carries `{ podSeed }`;
 * `feedSignerPrivKey` etc. are added later as a content change in this same
 * format (no crypto/ceremony change — §11.6 step 3).
 */
export interface RecoveryBundle {
  version: number;
  secrets: Record<string, string>;
}

/** HPKE suite — stateless for our ops, so one shared instance is safe. */
const hpke = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

/** X25519 encapsulated-key length for this KEM (bytes) — the `enc` prefix. */
const ENC_LEN = 32;
/** XChaCha20-Poly1305 nonce length (bytes). */
const XNONCE_LEN = 24;

/**
 * The AEAD additional-data binding the envelope to one account. Namespaced (not
 * a bare address) so the tag is unambiguous, and lowercased so casing variation
 * cannot break the bind. MUST be byte-identical at seal and open.
 */
function aadBytes(kernelAddress: string): Uint8Array {
  return new TextEncoder().encode(`woco/recovery/v1:${kernelAddress.toLowerCase()}`);
}

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export interface GuardianEncryptionKeypair {
  /** Opaque HPKE recipient key handles (X25519). Used to wrap (public) and unwrap (private). */
  keyPair: CryptoKeyPair;
  publicKeyHex: string;
}

/**
 * Derive a guardian's X25519 escrow keypair from a deterministic EIP-712
 * signature by the guardian EOA. Same EOA → same signature → same key, on any
 * device, with nothing stored. `guardianAddress` is bound into the message so
 * the same wallet signing for a different role yields a distinct key.
 */
export async function deriveGuardianEncryptionKeypair(
  guardianAddress: string,
  signTypedData: EIP712Signer,
): Promise<GuardianEncryptionKeypair> {
  const signature = await signTypedData(
    { ...RECOVERY_ENC_DOMAIN },
    RECOVERY_ENC_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    {
      purpose: "Derive recovery-escrow encryption key",
      address: guardianAddress,
      nonce: RECOVERY_ENC_NONCE,
    },
  );

  // keccak the canonical 65-byte signature (getBytes, not the hex string) — the
  // same compression POD identity uses — into a uniform 32-byte curve25519 seed.
  const seed = getBytes(keccak256(getBytes(signature)));
  try {
    const keyPair = await hpke.kem.deriveKeyPair(toArrayBuffer(seed));
    const pub = new Uint8Array(await hpke.kem.serializePublicKey(keyPair.publicKey));
    return { keyPair, publicKeyHex: bytesToHex(pub) };
  } finally {
    seed.fill(0); // drop the curve25519 seed; the CryptoKey handles outlive it
  }
}

/**
 * Derive an HPKE (X25519) escrow keypair DIRECTLY from a 32-byte seed, reusing
 * the same `hpke.kem.deriveKeyPair` construction as the guardian path. Used by
 * the cross-device portability envelope (CROSS_DEVICE_RECOVERY.md §3): the
 * recipient key is derived from the passkey PRF secret (domain-separated) rather
 * than from a guardian signature, so the passkey holder can re-derive it on any
 * device. The seed is the caller's responsibility to derive + zero; we copy it
 * into the KEM and do not retain it.
 */
export async function deriveEncryptionKeypairFromSeed(
  seed: Uint8Array,
): Promise<GuardianEncryptionKeypair> {
  if (seed.length !== 32) throw new Error("deriveEncryptionKeypairFromSeed: seed must be 32 bytes");
  const keyPair = await hpke.kem.deriveKeyPair(toArrayBuffer(seed));
  const pub = new Uint8Array(await hpke.kem.serializePublicKey(keyPair.publicKey));
  return { keyPair, publicKeyHex: bytesToHex(pub) };
}

/**
 * Seal a recovery bundle: fresh DEK → XChaCha20-Poly1305 over the bundle (AAD =
 * Kernel address) → HPKE-wrap the DEK to each guardian X25519 pubkey. The
 * returned envelope is safe to store on a public feed. The DEK is zeroed before
 * returning.
 */
export async function sealRecoveryBundle(args: {
  bundle: RecoveryBundle;
  kernelAddress: string;
  /** Guardian X25519 public keys (hex). v1 = exactly one (1-of-1 backup EOA). */
  guardianPublicKeysHex: string[];
}): Promise<RecoveryEnvelope> {
  if (args.guardianPublicKeysHex.length === 0) {
    throw new Error("sealRecoveryBundle: at least one guardian public key required.");
  }

  const dek = randomBytes(32);
  try {
    const nonce = randomBytes(XNONCE_LEN);
    const aad = aadBytes(args.kernelAddress);
    const plaintext = new TextEncoder().encode(JSON.stringify(args.bundle));
    const ciphertext = xchacha20poly1305(dek, nonce, aad).encrypt(plaintext);

    const wrappedDeks: string[] = [];
    for (const pkHex of args.guardianPublicKeysHex) {
      const recipientPublicKey = await hpke.kem.deserializePublicKey(toArrayBuffer(hexToBytes(pkHex)));
      const sender = await hpke.createSenderContext({ recipientPublicKey });
      const wrappedCt = new Uint8Array(await sender.seal(toArrayBuffer(dek), aad));
      const enc = new Uint8Array(sender.enc);
      // enc (32B X25519 encapsulation) || HPKE ciphertext of the DEK
      const combined = new Uint8Array(enc.length + wrappedCt.length);
      combined.set(enc, 0);
      combined.set(wrappedCt, enc.length);
      wrappedDeks.push(bytesToHex(combined));
    }

    return {
      v: RECOVERY_ENVELOPE_VERSION,
      kernelAddress: args.kernelAddress.toLowerCase(),
      nonce: bytesToHex(nonce),
      ciphertext: bytesToHex(ciphertext),
      wrappedDeks,
    };
  } finally {
    dek.fill(0);
  }
}

/**
 * Open a recovery bundle with a guardian's derived keypair. Verifies the bound
 * Kernel address, HPKE-unwraps the DEK (tries each wrapped entry — the matching
 * guardian's succeeds), then AEAD-decrypts the bundle. The recovered DEK is
 * zeroed before returning. Throws on any failure (wrong guardian, tampered
 * envelope, account mismatch).
 */
export async function openRecoveryBundle(args: {
  envelope: RecoveryEnvelope;
  kernelAddress: string;
  guardianKeypair: GuardianEncryptionKeypair;
}): Promise<RecoveryBundle> {
  const { envelope } = args;

  // Defence-in-depth: the AAD already cryptographically enforces this, but
  // reject a transplanted envelope before doing any unwrap work.
  if (envelope.kernelAddress.toLowerCase() !== args.kernelAddress.toLowerCase()) {
    throw new Error("openRecoveryBundle: envelope is bound to a different Kernel address.");
  }
  const aad = aadBytes(args.kernelAddress);

  let dek: Uint8Array | null = null;
  for (const wrappedHex of envelope.wrappedDeks) {
    const combined = hexToBytes(wrappedHex);
    if (combined.length <= ENC_LEN) continue; // malformed entry — skip
    const enc = combined.slice(0, ENC_LEN);
    const wrappedCt = combined.slice(ENC_LEN);
    try {
      const recipient = await hpke.createRecipientContext({
        recipientKey: args.guardianKeypair.keyPair.privateKey,
        enc: toArrayBuffer(enc),
      });
      dek = new Uint8Array(await recipient.open(toArrayBuffer(wrappedCt), aad));
      break;
    } catch {
      // Not this guardian's wrapped DEK — try the next.
    }
  }
  if (!dek) {
    throw new Error("openRecoveryBundle: no wrapped DEK opens with this guardian key.");
  }

  try {
    const plaintext = xchacha20poly1305(dek, hexToBytes(envelope.nonce), aad).decrypt(
      hexToBytes(envelope.ciphertext),
    );
    const bundle = JSON.parse(new TextDecoder().decode(plaintext)) as RecoveryBundle;
    if (typeof bundle?.version !== "number" || typeof bundle?.secrets !== "object" || bundle.secrets === null) {
      throw new Error("openRecoveryBundle: decrypted payload is not a RecoveryBundle.");
    }
    return bundle;
  } finally {
    dek.fill(0);
  }
}
