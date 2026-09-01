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
 *    bundle DEK, with role + envelope version + bound address as additional-
 *    data (recovery-aad.ts) so a stolen envelope cannot be replayed against
 *    another account or opened under the other role.
 *  - GUARDIAN KEY is DERIVED, never stored: the guardian EOA signs a fixed
 *    EIP-712 message (the deterministic-signature trick `requestPodIdentity`
 *    relies on) → keccak → 32-byte seed → HPKE `deriveKeyPair`. Same EOA always
 *    reproduces the same X25519 key, on any device, with nothing at rest.
 *
 * v1 = 1-of-1 (single backup-EOA guardian). M-of-N via verifiable secret sharing
 * over the DEK is a later envelope version (§11.6 step 2) — the DEK indirection
 * here is exactly what makes that a content change, not a redesign. The bundle is
 * generic (`secrets: Record<name,secret>`) so slots cost nothing to add (§11.6
 * step 3) — the bundle ships `{ podSeed, feedSignerPrivKey }` (gathered in
 * recovery-finalize.ts; an earlier version of this header said podSeed-only and
 * that stale claim derailed a design pass — issuer-curve handover, 2026-09-01).
 * The ISSUING key needs no slot ever: it re-derives from podSeed (crypto/issuing.ts).
 *
 * Confidentiality of the escrow equals the recovery-threshold strength, NOT
 * device-bound secrecy — inherent to all recovery (§11.4). A timelock guards
 * funds rotation, NOT this at-rest copy: once an attacker meets the unwrap
 * threshold the plaintext is theirs with no "cancel". Escrow the MINIMUM.
 */

import { keccak256, getBytes, Wallet } from "ethers";
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm } from "@hpke/core";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  RECOVERY_ENC_DOMAIN,
  RECOVERY_ENC_TYPES,
  RECOVERY_ENC_NONCE,
  RECOVERY_ENVELOPE_VERSION,
  type EIP712Signer,
  type RecoveryEnvelope,
} from "@woco/shared";
import { recoveryAadBytes, type RecoveryAadRole } from "./recovery-aad.js";

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

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export interface GuardianEncryptionKeypair {
  /** Opaque HPKE recipient key handles (X25519). Used to wrap (public) and unwrap (private). */
  keyPair: CryptoKeyPair;
  publicKeyHex: string;
}

/** secp256k1 signer that OWNS the guardian recovery-envelope SOC (§13). */
export interface GuardianSocSigner {
  /** 0x-prefixed private key — signs the SOC locally (never leaves the client). */
  privKey: string;
  /** Lowercased owner address = the SOC owner readers verify against. */
  address: string;
}

export interface GuardianKeys {
  /** X25519 keypair that wraps/unwraps the escrow DEK (HPKE). */
  encryption: GuardianEncryptionKeypair;
  /** secp256k1 key that owns + signs the guardian-owned recovery SOC. */
  socSigner: GuardianSocSigner;
}

/**
 * HKDF `info` labels — domain-separate the two keys derived from the SINGLE
 * guardian signature so neither reveals the other (§13, textbook KDF hygiene).
 */
const HKDF_INFO_HPKE = new TextEncoder().encode("woco/recovery/hpke/v1");
const HKDF_INFO_SOC = new TextEncoder().encode("woco/recovery/soc/v1");

/**
 * Derive BOTH guardian keys from ONE deterministic EIP-712 signature by the
 * guardian EOA (§13). Same EOA → same signature → same keys, on any device, with
 * nothing stored. `guardianAddress` is bound into the message so the same wallet
 * signing for a different role yields distinct keys.
 *
 * Construction: keccak the canonical 65-byte signature (getBytes, not the hex
 * string — the same compression POD identity uses) into a uniform 32-byte master
 * secret, then HKDF-SHA256-Expand into two independent 32-byte seeds under
 * distinct `info` labels:
 *  - `hpke/v1`  → X25519 escrow keypair (wraps the DEK).
 *  - `soc/v1`   → secp256k1 key that owns + signs the recovery SOC.
 * A single wallet prompt yields both, and compromising one seed does not expose
 * the other. Seeds are zeroed after use; the returned string keys are the
 * caller's to hold for the duration of the ceremony.
 */
export async function deriveGuardianKeys(
  guardianAddress: string,
  signTypedData: EIP712Signer,
): Promise<GuardianKeys> {
  const signature = await signTypedData(
    { ...RECOVERY_ENC_DOMAIN },
    RECOVERY_ENC_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    {
      purpose: "Derive recovery-escrow encryption key",
      address: guardianAddress,
      nonce: RECOVERY_ENC_NONCE,
    },
  );

  const master = getBytes(keccak256(getBytes(signature)));
  let hpkeSeed: Uint8Array | null = null;
  let socSeed: Uint8Array | null = null;
  try {
    hpkeSeed = hkdf(sha256, master, undefined, HKDF_INFO_HPKE, 32);
    socSeed = hkdf(sha256, master, undefined, HKDF_INFO_SOC, 32);

    const keyPair = await hpke.kem.deriveKeyPair(toArrayBuffer(hpkeSeed));
    const pub = new Uint8Array(await hpke.kem.serializePublicKey(keyPair.publicKey));

    // A uniform 32-byte HKDF output is a valid secp256k1 scalar with overwhelming
    // probability (P[≥ n] ≈ 2^-128); ethers throws on the negligible miss, which
    // the setup determinism self-check would surface loudly rather than silently.
    const socPrivKey = `0x${bytesToHex(socSeed)}`;
    const socWallet = new Wallet(socPrivKey);

    return {
      encryption: { keyPair, publicKeyHex: bytesToHex(pub) },
      socSigner: { privKey: socPrivKey, address: socWallet.address.toLowerCase() },
    };
  } finally {
    master.fill(0);
    hpkeSeed?.fill(0);
    socSeed?.fill(0);
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
 * role + version + bound address, see recovery-aad.ts) → HPKE-wrap the DEK to
 * each guardian X25519 pubkey. Always seals at the CURRENT envelope version.
 * The returned envelope is safe to store on a public feed. The DEK is zeroed
 * before returning.
 */
export async function sealRecoveryBundle(args: {
  bundle: RecoveryBundle;
  kernelAddress: string;
  /** Which use of the escrow construction this is — baked into the AAD. */
  role: RecoveryAadRole;
  /** Guardian X25519 public keys (hex). v1 = exactly one (1-of-1 backup EOA). */
  guardianPublicKeysHex: string[];
}): Promise<RecoveryEnvelope> {
  if (args.guardianPublicKeysHex.length === 0) {
    throw new Error("sealRecoveryBundle: at least one guardian public key required.");
  }

  const dek = randomBytes(32);
  try {
    const nonce = randomBytes(XNONCE_LEN);
    const aad = recoveryAadBytes(args.role, RECOVERY_ENVELOPE_VERSION, args.kernelAddress);
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
 * guardian's succeeds), then AEAD-decrypts the bundle. The AAD is built from
 * the envelope's DECLARED version (downgrade-proof — a lied-about version
 * selects an AAD the tag cannot verify under; see recovery-aad.ts) and the
 * caller's role, so a v1 envelope stays openable while an unknown version
 * throws `UnknownRecoveryEnvelopeVersionError` — callers must surface that as
 * "update the app", never as corruption. The recovered DEK is zeroed before
 * returning. Throws on any other failure (wrong guardian, wrong role, tampered
 * envelope, account mismatch).
 */
export async function openRecoveryBundle(args: {
  envelope: RecoveryEnvelope;
  kernelAddress: string;
  /** Must match the role the envelope was sealed for (v2+; v1 predates roles). */
  role: RecoveryAadRole;
  guardianKeypair: GuardianEncryptionKeypair;
}): Promise<RecoveryBundle> {
  const { envelope } = args;

  // Defence-in-depth: the AAD already cryptographically enforces this, but
  // reject a transplanted envelope before doing any unwrap work.
  if (envelope.kernelAddress.toLowerCase() !== args.kernelAddress.toLowerCase()) {
    throw new Error("openRecoveryBundle: envelope is bound to a different Kernel address.");
  }
  const aad = recoveryAadBytes(args.role, envelope.v, args.kernelAddress);

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
