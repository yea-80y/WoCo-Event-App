/**
 * The ISSUING key — a secp256k1 sibling derived from the POD seed (issuer-curve
 * migration, #443/#444; design record: HANDOVER-pod-curve-migration.md).
 *
 * HKDF(sha256, podSeed, info = "woco/issuing/v1/" + gen) → secp256k1 scalar.
 * A third sibling beside the ed25519 holder identity (`apps/web/src/lib/pod/keys.ts`,
 * seed used verbatim) and the X25519 encryption key (`keys.ts`, info
 * "woco/encryption/v1") — the distinct HKDF info keeps all three independent,
 * and HKDF one-wayness means a leaked issuing key cannot recover the seed.
 *
 * `gen` is what makes the key ROTATABLE without a new secret at rest: a
 * generation bump is a public issuer-registry statement (PR 5b), not a new
 * escrow slot. The escrowed seed re-derives every generation byte-identically
 * on recovery, which is what eliminates the recovered-account issuer fork
 * structurally rather than by guard.
 *
 * The issuer identity of record is the 20-byte ADDRESS (`IssuerAddress`), not
 * a pubkey: recovery yields an address natively, it is the secp identity unit
 * everywhere else, and 42 vs 64 chars keeps issuer fields shape-distinct from
 * every 64-hex key.
 *
 * SIGNING SCHEME shared by every v2 issuer signature: EIP-191 personal_sign
 * over an ASCII message `{domain}\n{0x + 64-hex digest}` — NEVER raw ECDSA
 * over a bare 32-byte digest. The feed signer personal-signs 32-byte SOC
 * digests (bee-js wraps them `\x19Ethereum Signed Message:\n32`), so an
 * unprefixed scheme would be cross-protocol forgeable; our messages are 79+
 * ASCII bytes and can never be 32 (pinned by test/crypto/cross-protocol.test.ts).
 * Verification RECOVERS the address and compares — nothing ever keys off
 * signature bytes (ECDSA signatures are malleable; high-s forms are refused).
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { asIssuerAddress, type IssuerAddress } from "./brands.js";
import type { Hex0x } from "../types.js";

/** HKDF info prefix — the generation number is appended in decimal. FROZEN:
 *  changing it re-derives every issuing key at every generation. */
export const ISSUING_INFO_PREFIX = "woco/issuing/v1/";

/** secp256k1 group order. */
const SECP256K1_N = secp256k1.Point.Fn.ORDER;

/** 65-byte r||s||v signature, 0x-prefixed lowercase hex (Ethereum wire form). */
const PERSONAL_SIG_RE = /^0x[0-9a-f]{130}$/;

/**
 * Map 48 bytes of HKDF output to a scalar in [1, n-1], deterministically.
 *
 * 48 bytes (384 bits) reduced mod (n-1) gives bias ~2^-128 — negligible — and
 * the +1 shift makes zero impossible by construction. No retry loop, no throw:
 * the ~2^-128 "invalid scalar" case of naive 32-byte derivation simply cannot
 * occur. Exported for the range tests; not part of the public derivation API.
 */
export function issuingScalarFromOkm(okm: Uint8Array): bigint {
  if (okm.length !== 48) {
    throw new Error(`issuing-key OKM must be 48 bytes, got ${okm.length}`);
  }
  let x = 0n;
  for (const b of okm) x = (x << 8n) | BigInt(b);
  return (x % (SECP256K1_N - 1n)) + 1n;
}

function scalarToPrivateKey(scalar: bigint): Uint8Array {
  return hexToBytes(scalar.toString(16).padStart(64, "0"));
}

function addressFromUncompressed(pub65: Uint8Array): IssuerAddress {
  // Ethereum address = last 20 bytes of keccak256 over the 64-byte public key
  // (uncompressed form minus its 0x04 tag byte).
  return asIssuerAddress("0x" + bytesToHex(keccak_256(pub65.subarray(1)).subarray(12)));
}

/** The issuing ADDRESS for a private key — the v2 issuer identity unit. */
export function issuingAddress(privateKey: Uint8Array): IssuerAddress {
  return addressFromUncompressed(secp256k1.getPublicKey(privateKey, false));
}

/**
 * Derive the generation-`gen` issuing key from the POD seed.
 *
 * Pure derivation — callers that may lack a seed (the web `ensureIssuingKey`
 * wrapper, PR 4) must FAIL LOUD before calling this, never fall through to
 * another signer. Throws on a malformed seed or generation; never on any
 * seed VALUE (see {@link issuingScalarFromOkm}).
 */
export function deriveIssuingKey(
  podSeedHex: string,
  gen = 0,
): { privateKey: Uint8Array; address: IssuerAddress } {
  if (!Number.isInteger(gen) || gen < 0) {
    throw new Error(`invalid issuing-key generation: ${gen}`);
  }
  const clean =
    podSeedHex.startsWith("0x") || podSeedHex.startsWith("0X") ? podSeedHex.slice(2) : podSeedHex;
  const seed = hexToBytes(clean);
  if (seed.length !== 32) {
    throw new Error(`invalid POD seed: expected 32 bytes, got ${seed.length}`);
  }
  // Salt pinned to the empty byte string, exactly as the X25519 sibling in
  // keys.ts — the info string alone separates the domains.
  const okm = hkdf(sha256, seed, new Uint8Array(0), utf8ToBytes(ISSUING_INFO_PREFIX + gen), 48);
  const privateKey = scalarToPrivateKey(issuingScalarFromOkm(okm));
  return { privateKey, address: issuingAddress(privateKey) };
}

// ---------------------------------------------------------------------------
// EIP-191 personal_sign over ASCII messages — the v2 issuer signature wrapper
// ---------------------------------------------------------------------------

/** keccak256 of the EIP-191 personal-message envelope for a string message.
 *  The declared length is the UTF-8 BYTE length, per the spec. */
export function personalSignDigest(message: string): Uint8Array {
  const msgBytes = utf8ToBytes(message);
  return keccak_256(
    concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${msgBytes.length}`), msgBytes),
  );
}

/**
 * personal_sign a string message. Returns the Ethereum wire form
 * r(32)||s(32)||v(1), v ∈ {27, 28}, 0x-prefixed lowercase — byte-compatible
 * with ethers `signMessage` / `verifyMessage`, so third-party verifiers need
 * nothing WoCo-specific. Low-s by construction (noble's default).
 */
export function signPersonalMessage(message: string, privateKey: Uint8Array): Hex0x {
  const digest = personalSignDigest(message);
  // noble v2 'recovered' layout is [recovery, r, s] — reordered to Ethereum's
  // r||s||v here (the same reordering the embed's passkey signer pins).
  const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: "recovered" });
  const v = (sig[0]! + 27).toString(16).padStart(2, "0");
  return ("0x" + bytesToHex(sig.subarray(1)) + v) as Hex0x;
}

/**
 * Recover the signer ADDRESS of a personal-signed message, or null.
 *
 * Refuses rather than normalises: malformed hex, a v outside {27, 28} and a
 * high-s signature all return null. High-s refusal is the malleability guard —
 * without it every signature has a second valid byte encoding, and no
 * consumer may ever key off signature bytes. Never throws.
 */
export function recoverPersonalSigner(message: string, signature: unknown): IssuerAddress | null {
  try {
    if (typeof signature !== "string" || !PERSONAL_SIG_RE.test(signature)) return null;
    const raw = hexToBytes(signature.slice(2));
    const v = raw[64]!;
    if (v !== 27 && v !== 28) return null;
    const recovered = new Uint8Array(65);
    recovered[0] = v - 27;
    recovered.set(raw.subarray(0, 64), 1);
    const sig = secp256k1.Signature.fromBytes(recovered, "recovered");
    if (sig.hasHighS()) return null;
    const pub = sig.recoverPublicKey(personalSignDigest(message)).toBytes(false);
    return addressFromUncompressed(pub);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The issuer-binding proof of possession (PR 4) — carried by create payloads
// ---------------------------------------------------------------------------

/** The personal-sign domain line for issuer-binding proofs. */
export const ISSUER_BINDING_SIGNING_DOMAIN = "woco-issuer-binding-v1";

/** Canonical lowercase parent address — the exact form the server rebuilds the
 *  message from (its verified parentAddress, lowercased). REFUSED, never
 *  folded: a checksummed parent signed here would verify against nothing. */
const PARENT_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * The proof-of-possession statement an event/badge CREATE payload carries so
 * the server can pin `parent → issuerAddress` at creation (#345 class: never
 * accept a client-asserted issuer identity without PoP).
 *
 * Why the manifests in the same payload are NOT proof enough: a signed
 * manifest proves its key exists and signed THAT manifest — but manifests are
 * public, so anyone can replay someone else's into their own authenticated
 * create and have a foreign issuer address pinned to their parent. The binding
 * signature closes that: the issuing key signs the PARENT it belongs to, and a
 * replayer cannot produce it for a parent the key never named.
 *
 * `issuer` is deliberately redundant — ecrecover of `sig` already yields it —
 * so the verifier can distinguish "wrong key" from "garbled message" and say
 * so, instead of silently pinning whatever address a malformed signature
 * recovers to. The server (PR 5a) must check: recovered == issuer AND
 * issuer == every manifest's `issuer` in the payload.
 */
export interface IssuerBindingV1 {
  /** The issuing ADDRESS this payload's manifests are signed under. */
  issuer: IssuerAddress;
  /** Issuing-key generation (0 until the issuer registry ships, PR 5b). */
  gen: number;
  /** personal_sign by the issuing key over {@link buildIssuerBindingMessage}. */
  sig: Hex0x;
}

/**
 * The EXACT ASCII message the issuing key personal-signs to bind itself to a
 * parent account:
 *
 *   woco-issuer-binding-v1\n{0x + 40-hex lowercase parent}\n{gen decimal}
 *
 * Always ≥ 67 bytes — never 32, so it stays disjoint from the feed signer's
 * personal-signed SOC digests by length, and its domain line keeps it disjoint
 * from `woco-manifest-v2` / `woco-cert-v1`, which the SAME key signs (pinned
 * in test/crypto/cross-protocol.test.ts). Deterministic and replayable BY
 * DESIGN: it asserts a durable fact, and the server only accepts it inside a
 * session-authenticated create whose verified parent must equal `parent`.
 */
export function buildIssuerBindingMessage(parent: string, gen: number): string {
  if (typeof parent !== "string" || !PARENT_ADDRESS_RE.test(parent)) {
    throw new Error("issuer binding: parent must be a 0x-prefixed lowercase 20-byte address");
  }
  if (!Number.isInteger(gen) || gen < 0) {
    throw new Error(`invalid issuing-key generation: ${gen}`);
  }
  return `${ISSUER_BINDING_SIGNING_DOMAIN}\n${parent}\n${gen}`;
}
