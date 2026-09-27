/**
 * Sealed box v2 — "encrypt to someone's public key" for orders and contact lists
 * (#642). Replaces the hand-assembled X25519 ECIES in `ecies.ts`.
 *
 *   HPKE (RFC 9180) base mode, single shot:
 *     KEM  X-Wing (ML-KEM-768 + X25519, 0x647a)   xwing-hpke.ts
 *     KDF  HKDF-SHA256
 *     AEAD AES-256-GCM
 *
 * Box: `{ v: 2, enc, ct }`, hex. The suite is IMPLIED by `v` and never written into
 * the box — algorithm fields in a ciphertext are how downgrades arrive. `open`
 * refuses every `v` it does not know, including the retired X25519-only shape;
 * there is no read path for it (pre-launch, nothing to carry).
 *
 * Every box is bound to what it is FOR. `info` names the use and `aad` names the
 * thing: an order to its event and ticket type, a list to its owner. A box lifted
 * from one context fails its tag in any other. The recipient key needs no entry:
 * X-Wing's combiner binds the X25519 key and ML-KEM binds H(pk).
 *
 * Import by subpath (`@woco/shared/crypto/sealed-box`) and, in the browser, load it
 * lazily: it carries the lattice code and HPKE, ~25 KB gzipped together.
 */

import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { XWingKem } from "./xwing-hpke.js";
import { assertXWingPublicKey, XWING_CIPHERTEXT_BYTES, XWING_SEED_BYTES } from "./xwing.js";
import { compressionSupported, gunzip, gzip, isGzipped } from "./compress.js";

export const SEALED_BOX_VERSION = 2 as const;

export interface SealedBoxV2 {
  v: typeof SEALED_BOX_VERSION;
  /** HPKE encapsulated key = the X-Wing ciphertext (1120 bytes, hex). */
  enc: string;
  /** AES-256-GCM ciphertext with its 16-byte tag appended (hex). */
  ct: string;
}

/** What a box is FOR. Both strings are FROZEN per use: change one and every box
 *  already sealed under it stops opening. */
export interface SealContext {
  info: string;
  aad: string;
}

/** Thrown by `openBox` for anything that is not a v2 box — a typed error so a
 *  caller can say "this was sealed by a format we no longer read". */
export class UnsupportedSealedBoxError extends Error {
  constructor(detail: string) {
    super(`unsupported sealed box: ${detail}`);
    this.name = "UnsupportedSealedBoxError";
  }
}

const ID_RE = /^[0-9a-z-]{1,64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** HPKE info for a sealed ORDER. FROZEN. */
export const ORDER_SEAL_INFO = "woco/order/v2";

/**
 * An order is bound to its event and ticket type. Ids are lowercase UUID-shaped
 * (`isValidSeriesId`, `crypto.randomUUID()`), so ":" cannot occur inside one and
 * the string is unambiguous; anything else throws rather than being sealed under
 * a context that could collide.
 */
export function orderSealContext(eventId: string, seriesId: string): SealContext {
  if (!ID_RE.test(eventId) || !ID_RE.test(seriesId)) {
    throw new Error("order seal context: event and series ids must be lowercase [0-9a-z-]");
  }
  return { info: ORDER_SEAL_INFO, aad: `${ORDER_SEAL_INFO}:${eventId}:${seriesId}` };
}

/** HPKE info for a sealed CONTACT LIST. FROZEN. */
export const LIST_SEAL_INFO = "woco/marketing-list/v2";

/** A contact list is bound to the account that owns it (the route keys by it). */
export function listSealContext(ownerAddress: string): SealContext {
  const owner = ownerAddress.toLowerCase();
  if (!ADDRESS_RE.test(owner)) throw new Error("list seal context: owner must be a 20-byte address");
  return { info: LIST_SEAL_INFO, aad: `${LIST_SEAL_INFO}:${owner}` };
}

const HEX_RE = /^[0-9a-f]*$/;
/** GCM tag length: the smallest `ct` any box can have (an empty plaintext). */
const TAG_BYTES = 16;

/**
 * A v2 box by SHAPE — for the code that must tell "sealed" from "plain" before it
 * has a key (a server refusing to store cleartext, a participant list). Shape only:
 * it proves nothing about who sealed it or whether it opens.
 */
export function isSealedBoxV2(x: unknown): x is SealedBoxV2 {
  if (typeof x !== "object" || x === null) return false;
  const b = x as Record<string, unknown>;
  return (
    b.v === SEALED_BOX_VERSION &&
    typeof b.enc === "string" &&
    b.enc.length === XWING_CIPHERTEXT_BYTES * 2 &&
    HEX_RE.test(b.enc) &&
    typeof b.ct === "string" &&
    b.ct.length >= TAG_BYTES * 2 &&
    b.ct.length % 2 === 0 &&
    HEX_RE.test(b.ct)
  );
}

const suite = new CipherSuite({ kem: new XWingKem(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });

function toBytes(key: Uint8Array | string): Uint8Array {
  if (typeof key !== "string") return key;
  return hexToBytes(key.startsWith("0x") ? key.slice(2) : key);
}

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/** Seal bytes to a recipient's X-Wing public key (1216 bytes, or its hex). */
export async function sealBox(
  recipientPublicKey: Uint8Array | string,
  plaintext: Uint8Array,
  ctx: SealContext,
): Promise<SealedBoxV2> {
  const pkBytes = toBytes(recipientPublicKey);
  assertXWingPublicKey(pkBytes);
  const recipientKey = await suite.kem.deserializePublicKey(pkBytes);
  const { enc, ct } = await suite.seal(
    { recipientPublicKey: recipientKey, info: buf(utf8ToBytes(ctx.info)) },
    buf(plaintext),
    buf(utf8ToBytes(ctx.aad)),
  );
  return {
    v: SEALED_BOX_VERSION,
    enc: bytesToHex(new Uint8Array(enc)),
    ct: bytesToHex(new Uint8Array(ct)),
  };
}

/**
 * Open a box with the recipient's X-Wing secret key (the 32-byte seed from
 * `deriveXWingKeypairFromSeed`). Throws `UnsupportedSealedBoxError` for anything
 * that is not a v2 box, and HPKE's `OpenError` for a wrong key, a wrong context or
 * tampered bytes — which, by design, it cannot tell apart.
 */
export async function openBox(
  recipientSecretKey: Uint8Array | string,
  box: unknown,
  ctx: SealContext,
): Promise<Uint8Array> {
  if (!isSealedBoxV2(box)) {
    const v = typeof box === "object" && box !== null ? (box as { v?: unknown }).v : undefined;
    throw new UnsupportedSealedBoxError(
      v === undefined ? "no version (the retired X25519-only format?)" : `version ${String(v)}`,
    );
  }
  const skBytes = toBytes(recipientSecretKey);
  if (skBytes.length !== XWING_SEED_BYTES) {
    throw new Error(`X-Wing secret key must be ${XWING_SEED_BYTES} bytes, got ${skBytes.length}`);
  }
  const recipientKey = await suite.kem.deserializePrivateKey(skBytes);
  const pt = await suite.open(
    { recipientKey, enc: buf(hexToBytes(box.enc)), info: buf(utf8ToBytes(ctx.info)) },
    buf(hexToBytes(box.ct)),
    buf(utf8ToBytes(ctx.aad)),
  );
  return new Uint8Array(pt);
}

// ---------------------------------------------------------------------------
// JSON helpers — same shapes as ecies.ts, so each rail's switch is a call swap
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sealBoxJson(
  recipientPublicKey: Uint8Array | string,
  data: unknown,
  ctx: SealContext,
): Promise<SealedBoxV2> {
  return sealBox(recipientPublicKey, encoder.encode(JSON.stringify(data)), ctx);
}

/**
 * Gzip first, for payloads that scale with a user's data (a contact list). The
 * size signal this leaks needs chosen content AND repeated observation to exploit
 * (see `sealJsonCompressed` in ecies.ts for the full argument); a list too large to
 * store is the certain failure. Falls back to uncompressed without CompressionStream.
 */
export async function sealBoxJsonCompressed(
  recipientPublicKey: Uint8Array | string,
  data: unknown,
  ctx: SealContext,
): Promise<SealedBoxV2> {
  const raw = encoder.encode(JSON.stringify(data));
  return sealBox(recipientPublicKey, compressionSupported() ? await gzip(raw) : raw, ctx);
}

/** Open a JSON box from either sealer — JSON never begins with the gzip magic. */
export async function openBoxJson<T = unknown>(
  recipientSecretKey: Uint8Array | string,
  box: unknown,
  ctx: SealContext,
): Promise<T> {
  const plaintext = await openBox(recipientSecretKey, box, ctx);
  const json = isGzipped(plaintext) ? await gunzip(plaintext) : plaintext;
  return JSON.parse(decoder.decode(json)) as T;
}
